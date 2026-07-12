"""Navgraph builder — free-space skeleton graph over a terrain mask.

This module turns a terrain-class mask PNG (as produced by ``project/UNet.py``)
into a compact, weighted navigation graph plus coarse sampling metadata. The
graph replaces exactly one stage of the client theta* pipeline: the slow
margin-growth full-map A*. Downstream stages (corridor + guided theta*) still
run on the *true* full-resolution mask, so nothing the graph approximates can
produce an illegal route — the graph only proposes waypoint chains.

See ``plan.md`` (repo root) "Infinity mode on real masks" for the design.


Terrain / cost model
--------------------
Masks are 8-bit terrain-class grids. ``0`` is impassable; every other value is
passable with an A* step cost of ``dist * (255 - value)`` — identical to
``project/static/project/js/pathing/astar.js``. Both the current class scheme
(135 very_slow / 200 outline / 231 slow / 241 cross / 242 stairs / 243 fast) and
the legacy scheme (100 / 150 / 200 / 230) work directly under this formula; the
only thing we special-case is ``value == 0`` == impassable.


Why a skeleton, not obstacle polygonization
-------------------------------------------
Polygonizing black pixels gives a visibility graph with a uniform-cost
assumption — fine for the (uniform) generated cities, wrong for real masks whose
terrain weights drive route choice. Instead we skeletonize the *free* space
(medial axis) so nodes sit in corridor centres, sample along corridors, and add
a sparse lattice across large open plazas. Simplified contour features and
clearance-minimum skeleton anchors preserve obstacle choices and narrow gates
without a global boundary grid. Terrain is respected both when nearby nodes are
deduplicated and in every measured edge weight.


Adaptive resolution
--------------------
Full-resolution skeletonization is far too slow on large masks (~224 s and
~94 k junctions on the 75 Mpx worst case) and would blow the <1 MB client
artifact budget. So the *skeleton stage only* runs on a block-downsampled
passability grid (factor chosen so the working grid is <= ``SKELETON_TARGET_PX``);
everything that affects legality or weights — the mask itself, the distance
transform, connected-component labels, edge A* and the sampling grids — stays at
full resolution. Node coordinates are snapped back to a genuinely passable
full-resolution pixel. On the median ~8.6 Mpx mask this still gives a fine graph;
the 75 Mpx outliers get a coarser but valid one (they are opt-in gated anyway).


Off-map hit zone
----------------
A mask is a full rectangle but the actual map fills only part of it; the margin
(white paper, title banner, sponsor logos, scale text) is classified as ordinary
open/fast terrain and can't be told apart from real open ground by pixel value.

The *authoritative* map region is a **coach-drawn polygon** passed as
``region_polygon`` (rasterized by ``_rasterize_region``); automatic detection is
too fragile to trust across the full map variety. When no polygon is supplied we
fall back to ``_hitzone()``, which also serves as the editor's initial
suggestion: it separates map from margin *structurally* — a real map changes
terrain class frequently over short distances, while a margin (or a solid logo,
or a big featureless field) is one class over a large area. It measures the
coarse density of class boundaries and yields a *footprint* (the map body, used
for the debug
overlay and stats) and a *sample* mask (structured cells only; the stored hit
zone where automatic mode may place route endpoints). The hit zone gates route
*endpoints*, not graph topology: every free-space node is kept, because the
off-map open area often links map regions that have no in-map connection and
pruning it would fragment the graph. Boring uniform fields therefore stay
crossable but are never chosen as endpoints. This replaces the earlier blob
prefilter, which did little and modified topology; the graph now builds on the
true free space.


Artifact contents
-----------------
``build_navgraph()`` returns a dict; ``save_navgraph()`` writes two files next to
the mask:

* ``<mask>.navgraph.npz`` — full arrays for Python/debug tooling.
* ``<mask>.navgraph.bin`` — compact little-endian binary for the JS worker.

Array keys (npz):
    nodes         (N,2) int32   full-res (x, y) per node
    edges         (E,2) int32   undirected, node index pairs (u < v)
    weights       (E,)  float32 A* terrain-weighted cost of the edge
    components    (N,)  int32   free-space component id (unfiltered labels)
    min_cost_per_px    float32  cheapest per-pixel step cost = 255 - max value
    mask_shape    (2,)  int32   (height, width) of the full-res mask
    version             int32   NAVGRAPH_VERSION
    coarse_scale        int32   sampling grid downsample factor (== SAMPLE_DS)
    coarse_minval (h,w) uint8   ÷SAMPLE_DS block-min terrain value (passability)
    coarse_clear  (h,w) uint8   ÷SAMPLE_DS block-max clearance (px, capped 255)
    coarse_labels (h,w) int32   ÷SAMPLE_DS free-space component id (0 = none)
    hitzone_scale       int32   hit-zone grid downsample factor (== HITZONE_DS)
    coarse_hitzone(hh,hw)uint8  ÷HITZONE_DS endpoint hit zone (1 = sampleable)
    stats               object  per-map dict (json-serializable)

``.navgraph.bin`` byte layout (all little-endian, tightly packed, no padding):

    offset  type            field
    0       char[4]         magic "NVG1"
    4       uint32          version  (== 2)
    8       int32           mask height H
    12      int32           mask width  W
    16      float32         min_cost_per_px
    20      uint32          N  (node count)
    24      uint32          E  (edge count)
    28      int32           coarse_scale  (SAMPLE_DS)
    32      int32           coarse height  ch
    36      int32           coarse width   cw
    40      int32           hitzone_scale  (HITZONE_DS)
    44      int32           hitzone height hh
    48      int32           hitzone width  hw
    52      int32[N*2]      nodes, row-major (x0,y0, x1,y1, ...)
    ...     int32[E*2]      edges (u0,v0, u1,v1, ...)
    ...     float32[E]      weights
    ...     int32[N]        components
    ...     uint8[ch*cw]    coarse_minval  (row-major)
    ...     uint8[ch*cw]    coarse_clear   (row-major)
    ...     int32[ch*cw]    coarse_labels  (row-major)
    ...     uint8[hh*hw]    coarse_hitzone (row-major)

Everything after the fixed 52-byte header is derivable from N, E, ch, cw, hh, hw.
"""

import heapq
import json
import os
import time

import numpy as np
import scipy.ndimage as ndi

try:
    from skimage.morphology import skeletonize as _sk_skeletonize
    from skimage.measure import (
        approximate_polygon as _sk_approximate_polygon,
        find_contours as _sk_find_contours,
    )
    _HAVE_SKIMAGE = True
except Exception:  # pragma: no cover - dependency guard
    _HAVE_SKIMAGE = False


NAVGRAPH_VERSION = 2  # v2: added coarse_hitzone + hitzone_scale (see .bin layout)
NAVGRAPH_MAGIC = b"NVG1"

# --- Terrain -----------------------------------------------------------------
IMPASSABLE = 0  # mask value that means "cannot enter" (both class schemes)
VERY_SLOW = 135  # strongly avoided terrain; appears as rgb(47) in the dim debug overlay

# --- Off-map hit zone --------------------------------------------------------
# The mask is a full rectangle, but the actual map occupies only part of it; the
# surrounding margin (white paper, title banner, sponsor logos, scale text) is
# classified as ordinary "open/fast" terrain and is indistinguishable from real
# open ground by pixel value alone. We separate map from margin *structurally*:
# a real orienteering map changes terrain class frequently over short distances
# (buildings, contours, paths, vegetation), whereas a margin — or a solid logo,
# or a big featureless field — is one class over a large area. We measure the
# local density of class boundaries on a coarse grid and derive two masks:
#   * footprint — the map body (largest structured component, closed to a
#     map-scale radius and hole-filled so interior open fields belong to it).
#     Nodes outside it are pruned so routes can't shortcut through off-map white.
#   * sample    — structured cells only (footprint minus large boring uniform
#     areas). This is the stored hit zone: where automatic mode may place route
#     endpoints. Boring fields stay crossable (they keep footprint nodes) but are
#     never chosen as start/end points.
HITZONE_DS = 16              # coarse block size (full-res px) for the hit-zone grid
HITZONE_BOUNDARY_THR = 0.06  # min fraction of class-boundary px in a block to be "structured"
HITZONE_CLOSE_R = 6          # coarse-cell radius to close the footprint across open fields
HITZONE_SMALL_HOLE = 64      # coarse cells; interior holes <= this are filled into the sample mask

# --- Adaptive skeleton resolution --------------------------------------------
# The skeleton stage runs on a block-downsampled passability grid so it stays
# fast and the node count stays bounded. The factor is the smallest integer that
# brings the working grid at or below this many pixels.
SKELETON_TARGET_PX = 3_000_000
SKELETON_MAX_DS = 8

# --- Node extraction ----------------------------------------------------------
# Spacings are given in FULL-RES px; the skeleton runs on the downsampled grid so
# they are converted to coarse px (value/ds) at build time. This keeps node
# density roughly constant in map units regardless of the adaptive factor.
SPUR_MIN_LEN = 4             # prune skeleton branches shorter than this (coarse px)
RESAMPLE_SPACING_PX = 48     # add a node every ~this many full-res px along a segment
# Obstacle-biased sampling.  The skeleton guarantees broad connectivity, while
# these nodes give the graph enough local choices around walls/buildings and in
# narrow gates.  Open space stays deliberately sparse; otherwise most of the
# artifact budget is spent where a straight crossing already works well.
OBSTACLE_CLEARANCE_PX = 16   # dense sampling at/below this distance from a wall
BOTTLENECK_SPACING_PX = 16   # extra low-clearance skeleton anchors
CONTOUR_SIMPLIFY_PX = 8      # ignore smaller boundary wiggles/noise
CONTOUR_MIN_LENGTH_PX = 32   # ignore tiny isolated obstacle specks
CONTOUR_CORNER_ANGLE_DEG = 45  # minimum direction change worth a feature node
CONTOUR_NODE_OFFSET_PX = 2   # stay close to the same obstacle side
CONTOUR_SAMPLE_SPACING_PX = 24  # arc-length samples, never a global XY grid
CONTOUR_SEGMENT_ANCHOR_MIN_PX = 16  # shorter simplified runs are noise/covered by ends
CONTOUR_AREA_SPACING_PX = 32  # LOS-aware thinning radius along one contour run
CONTOUR_TINY_AREA_PX = 256  # compact isolated obstacles need no local roadmap
CONTOUR_TINY_SPAN_PX = 20   # long/thin walls are never classified as tiny
CONTOUR_TARGET_PX = 20_000_000  # ds=1 normally; at most a light ds=2 on huge maps
CONTOUR_MAX_DS = 2
NARROW_CENTERLINE_MERGE_PX = 16  # discard regular wall samples near visible spine
NODE_DEDUPE_PX = 6           # merge only nearly coincident, mutually visible nodes
NODE_DEDUPE_TERRAIN_DELTA = 16  # never merge a path node into nearby slow terrain
NEAR_OBSTACLE_CLEARANCE_PX = 80  # denser lattice up to this clearance from obstacles
LATTICE_SPACING_NEAR_PX = 32  # transition band between boundary and open space
LATTICE_SPACING_FAR_PX = 64   # plaza/interior open-space lattice spacing

# --- Edges -------------------------------------------------------------------
EDGE_KNN = 10                # local alternatives for barrier/distinct-route search
EDGE_FEATURE_SECTORS = 8     # nearest visible neighbour in each angular sector
EDGE_MAX_DIST = 120          # px; candidate edge endpoints must be within this (full-res)
EDGE_MARGIN = 12             # px; subgrid margin around a k-NN edge bbox for A*
EDGE_DETOUR_RATIO = 3.0      # drop a k-NN edge whose A* path is > this * straight
# Skeleton backbone edges are known corridor connections: give their A* fallback
# a larger search box and looser detour tolerance so genuine thin/winding
# corridors (produced by the block-downsampled skeleton) are not dropped —
# dropping them would fragment the graph.
EDGE_SKELETON_MARGIN = 40    # px; subgrid margin for skeleton backbone A*
EDGE_SKELETON_DETOUR = 6.0   # detour tolerance for skeleton backbone A*
ASTAR_MAX_EXPANSIONS = 200_000  # per-edge safety cap on A* node expansions

# --- Redundancy pruning ------------------------------------------------------
# Only non-topological open-lattice nodes are considered. A node is removable
# when every route through it already has a short local witness path that avoids
# it. No shortcut edge is invented, so client geometry remains honest.
PRUNE_WITNESS_STRETCH = 1.03
PRUNE_WITNESS_RADIUS_PX = 180
PRUNE_MAX_DEGREE = 8

# --- Connectivity repair -----------------------------------------------------
# After weighting, graph fragments that belong to the same free-space component
# (a corridor the downsampled skeleton missed) are bridged back to the main
# graph component so the served graph is usable and passes the >=95% acceptance.
BRIDGE_MAX_DIST = 350        # px; longest bridge we attempt between fragments
BRIDGE_MARGIN = 24           # px; minimum subgrid margin for bridge A*
BRIDGE_MAX_MARGIN = 96       # px; cap so a bridge A* box can't explode
BRIDGE_TRIES = 4             # candidate main-node targets to try per fragment

# --- Sampling metadata -------------------------------------------------------
SAMPLE_DS = 4                # ÷4 sampling grids, matching the plan


# =============================================================================
# Mask loading + terrain
# =============================================================================

def _load_mask(mask_path):
    """Load a mask PNG as a full-resolution ``uint8`` grayscale array."""
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    with open(mask_path, "rb") as f:
        img = Image.open(f)
        img.load()
        if img.mode != "L":
            img = img.convert("L")
        return np.asarray(img, dtype=np.uint8)


def _min_cost_per_px(mask):
    """Cheapest per-pixel step cost = ``255 - max passable value``."""
    max_val = int(mask.max())
    if max_val <= IMPASSABLE:
        return float(255 - IMPASSABLE)
    return float(255 - max_val)


# =============================================================================
# Off-map hit zone (class-boundary density)
# =============================================================================

def _hitzone(mask):
    """Derive the map footprint and endpoint-sample mask from class structure.

    Returns ``(footprint, sample, ds)`` where ``footprint`` and ``sample`` are
    coarse (``ds == HITZONE_DS``) bool grids:

    * ``footprint`` — the map body: the largest structured component, closed to
      a map-scale radius and hole-filled, so interior open fields belong to the
      map but the off-map margin (and detached banners/logos) do not. Used for
      the debug overlay and stats (the graph itself is not pruned to it).
    * ``sample`` — structured cells within the footprint, with only *small*
      interior holes (building courtyards, etc.) filled back in. Large boring
      uniform areas stay excluded. This is where route endpoints may be placed.

    See the module "Off-map hit zone" note for the rationale.
    """
    ds = HITZONE_DS
    H, W = mask.shape
    # Class-boundary pixels: value differs from the right / down neighbour.
    boundary = np.zeros((H, W), dtype=bool)
    boundary[:, :-1] |= mask[:, :-1] != mask[:, 1:]
    boundary[:-1, :] |= mask[:-1, :] != mask[1:, :]

    hh, ww = (H // ds) * ds, (W // ds) * ds
    ch, cw = hh // ds, ww // ds
    if ch == 0 or cw == 0:  # mask smaller than a block — treat all as map
        full = np.ones((max(ch, 1), max(cw, 1)), dtype=bool)
        return full, full, ds
    density = boundary[:hh, :ww].reshape(ch, ds, cw, ds).mean(axis=(1, 3))
    structured = density > HITZONE_BOUNDARY_THR

    # Largest structured component (a 1-cell dilation joins adjacent structure).
    lab, n = ndi.label(ndi.binary_dilation(structured, iterations=1))
    if n == 0:
        full = np.ones((ch, cw), dtype=bool)
        return full, full, ds
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    main = lab == int(sizes.argmax())

    # Sample mask: structured cells of the main component + small interior holes.
    sample = structured & main
    holes = ndi.binary_fill_holes(main) & ~sample
    hl, hn = ndi.label(holes)
    if hn > 0:
        hsz = np.bincount(hl.ravel())
        keep = np.zeros(hn + 1, dtype=bool)
        keep[1:] = hsz[1:] <= HITZONE_SMALL_HOLE
        sample |= keep[hl]

    # Footprint: close structure to a map-scale radius, take the largest CC and
    # fill all its holes so interior open fields are part of the map body.
    r = HITZONE_CLOSE_R
    st = np.ones((2 * r + 1, 2 * r + 1), dtype=bool)
    fp = ndi.binary_closing(structured, structure=st)
    fl, fn = ndi.label(fp)
    if fn > 0:
        fsz = np.bincount(fl.ravel())
        fsz[0] = 0
        fp = fl == int(fsz.argmax())
    fp = ndi.binary_fill_holes(fp)
    # The sample mask must sit inside the footprint.
    sample &= fp
    return fp, sample, ds


def _rasterize_region(polygon, H, W, ds=HITZONE_DS):
    """Rasterize a coach-drawn map-region polygon to a coarse ÷ds bool grid.

    ``polygon`` is a sequence of full-res ``(x, y)`` vertices (same coordinate
    space as ``nodes``). Returns an ``(hh, hw)`` bool grid, True inside the
    polygon, matching the hit-zone grid resolution. This is the *authoritative*
    map region when a coach has drawn one; the automatic ``_hitzone`` is only a
    fallback / initial suggestion (see the module note). Fewer than 3 vertices
    yields an all-False grid (caller should fall back to ``_hitzone``).
    """
    from PIL import Image, ImageDraw
    hh, hw = max(1, H // ds), max(1, W // ds)
    img = Image.new("L", (hw, hh), 0)
    if polygon is not None and len(polygon) >= 3:
        pts = [(float(x) / ds, float(y) / ds) for (x, y) in polygon]
        ImageDraw.Draw(img).polygon(pts, fill=1)
    return np.asarray(img, dtype=bool)


# =============================================================================
# Adaptive downsample
# =============================================================================

def _downsample_factor(h, w):
    """Smallest ds in [1, SKELETON_MAX_DS] with ``(h*w)/ds**2 <= target``."""
    total = h * w
    ds = 1
    while ds < SKELETON_MAX_DS and total / (ds * ds) > SKELETON_TARGET_PX:
        ds += 1
    return ds


def _block_reduce(arr, ds, op):
    """Reduce ``arr`` by ``ds``-sized blocks using ``op`` ('max'|'min').

    Trailing pixels that don't fill a block are dropped (skeleton topology is
    unaffected by a <ds-pixel border). Returns a (h//ds, w//ds) array.
    """
    h, w = arr.shape
    hh, ww = (h // ds) * ds, (w // ds) * ds
    view = arr[:hh, :ww].reshape(hh // ds, ds, ww // ds, ds)
    if op == "max":
        return view.max(axis=(1, 3))
    if op == "min":
        return view.min(axis=(1, 3))
    raise ValueError(op)


# =============================================================================
# Skeleton graph -> nodes
# =============================================================================

def _neighbor_count(skel):
    """8-neighbour count of set pixels for each skeleton pixel (0 elsewhere)."""
    k = np.ones((3, 3), dtype=np.uint8)
    cnt = ndi.convolve(skel.astype(np.uint8), k, mode="constant") - skel.astype(np.uint8)
    cnt[~skel] = 0
    return cnt.astype(np.uint8)


def _prune_spurs(skel, min_len):
    """Iteratively remove short skeleton branches (endpoint spurs)."""
    skel = skel.copy()
    for _ in range(min_len):
        cnt = _neighbor_count(skel)
        endpoints = skel & (cnt == 1)
        if not endpoints.any():
            break
        skel[endpoints] = False
    return skel


# 8-neighbour offsets used for tracing.
_N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _node_neighbors(node_id_at, y, x, h, w):
    """Distinct (node_id, (y, x)) node pixels 8-adjacent to (y, x)."""
    out = []
    seen = set()
    for dy, dx in _N8:
        yy, xx = y + dy, x + dx
        if 0 <= yy < h and 0 <= xx < w:
            nid = int(node_id_at[yy, xx])
            if nid != -1 and nid not in seen:
                seen.add(nid)
                out.append((nid, (yy, xx)))
    return out


def _trace_chain(node_id_at, pix, h, w):
    """Linearly trace one branch-free chain into a ``(a, b, length, path)`` edge.

    ``pix`` are the (y, x) pixels of a single connected chain (skeleton minus
    node pixels). A chain is degree<=2 everywhere, so tracing is unambiguous.
    Returns ``None`` for loops / chains not bordering two distinct nodes.
    """
    pixset = set(pix)

    def chain_nbrs(y, x):
        return [(y + dy, x + dx) for dy, dx in _N8 if (y + dy, x + dx) in pixset]

    ends = [p for p in pix if len(chain_nbrs(*p)) <= 1]
    if not ends:
        return None  # closed loop with no endpoint — nothing to connect
    start = ends[0]
    ordered = [start]
    prev = None
    cur = start
    guard = len(pix) + 2
    while guard > 0:
        guard -= 1
        nxt = [p for p in chain_nbrs(*cur) if p != prev]
        if not nxt:
            break
        prev, cur = cur, nxt[0]
        ordered.append(cur)
    end = ordered[-1]

    sa = _node_neighbors(node_id_at, start[0], start[1], h, w)
    sb = _node_neighbors(node_id_at, end[0], end[1], h, w)
    if not sa or not sb:
        return None
    a_id, a_px = sa[0]
    b = next(((nid, px) for nid, px in sb if nid != a_id), None)
    if b is None:
        # Single-pixel chain: both ends are the same pixel; use its two nodes.
        b = next(((nid, px) for nid, px in sa if nid != a_id), None)
    if b is None:
        return None
    b_id, b_px = b

    path = [a_px] + ordered + [b_px]
    length = 0.0
    for i in range(1, len(path)):
        y0, x0 = path[i - 1]
        y1, x1 = path[i]
        length += 1.4142135623730951 if (y0 != y1 and x0 != x1) else 1.0
    return (a_id, b_id, length, path)


def _skeleton_nodes_and_segments(skel, resample_spacing):
    """Extract node pixels and the skeleton segments joining them.

    Nodes are junction clusters (>=3 neighbours, merged) and endpoints (1
    neighbour). Edges are recovered robustly by removing node pixels and
    labelling the remaining chains: each labelled chain is branch-free, so a
    single linear trace connects its two end nodes without the ambiguity that
    plagues a global node-to-node walk. Returns:

        node_yx   list of (y, x) coarse-pixel node coordinates
        segments  list of (node_i, node_j, length, path)
    """
    cnt = _neighbor_count(skel)
    h, w = skel.shape
    struct8 = np.ones((3, 3), dtype=np.uint8)
    junction_px = skel & (cnt >= 3)
    endpoint_px = skel & (cnt == 1)
    jlabels, jn = ndi.label(junction_px, structure=struct8)

    node_yx = []
    node_id_at = np.full(skel.shape, -1, dtype=np.int32)
    if jn > 0:
        jys, jxs = np.where(junction_px)
        jlab = jlabels[jys, jxs] - 1  # 0..jn-1
        node_id_at[jys, jxs] = jlab
        _, first_idx = np.unique(jlab, return_index=True)
        for fi in first_idx.tolist():
            node_yx.append((int(jys[fi]), int(jxs[fi])))
    ey, ex = np.where(endpoint_px)
    for y, x in zip(ey.tolist(), ex.tolist()):
        if node_id_at[y, x] != -1:
            continue
        node_id_at[y, x] = len(node_yx)
        node_yx.append((int(y), int(x)))

    node_px = node_id_at != -1
    segments = []

    # (a) Direct node-to-node adjacency (two node pixels touching, no chain).
    nys, nxs = np.where(node_px)
    seen_pairs = set()
    for y, x in zip(nys.tolist(), nxs.tolist()):
        a = int(node_id_at[y, x])
        for dy, dx in _N8:
            yy, xx = y + dy, x + dx
            if yy < 0 or yy >= h or xx < 0 or xx >= w:
                continue
            b = int(node_id_at[yy, xx])
            if b == -1 or b == a:
                continue
            key = (a, b) if a < b else (b, a)
            if key in seen_pairs:
                continue
            seen_pairs.add(key)
            step = 1.4142135623730951 if (dy and dx) else 1.0
            segments.append((key[0], key[1], step, [(y, x), (yy, xx)]))

    # (b) Chains = skeleton minus node pixels; label + linearly trace each.
    chains = skel & ~node_px
    clabels, cn = ndi.label(chains, structure=struct8)
    if cn > 0:
        cys, cxs = np.where(chains)
        clab = clabels[cys, cxs]
        order = np.argsort(clab, kind="stable")
        clab = clab[order]
        cys = cys[order]
        cxs = cxs[order]
        bounds = np.searchsorted(clab, np.arange(1, cn + 2))
        for c in range(cn):
            s, e = int(bounds[c]), int(bounds[c + 1])
            pix = list(zip(cys[s:e].tolist(), cxs[s:e].tolist()))
            seg = _trace_chain(node_id_at, pix, h, w)
            if seg is not None:
                segments.append(seg)

    return node_yx, segments


def _resample_segments(node_yx, segments, spacing):
    """Split long segments by inserting nodes every ``spacing`` coarse px.

    Returns updated ``node_yx`` and a list of ``(i, j, length)`` graph edges
    (in coarse px) that will still be re-weighted by full-res A*.
    """
    edges = []
    for a, b, length, path in segments:
        if length <= spacing * 1.5 or len(path) <= 2:
            edges.append((a, b, length))
            continue
        # Walk path accumulating length; drop a node at each spacing step.
        prev_nid = a
        acc = 0.0
        last_idx = 0
        for idx in range(1, len(path)):
            y0, x0 = path[idx - 1]
            y1, x1 = path[idx]
            acc += 1.4142135623730951 if (y0 != y1 and x0 != x1) else 1.0
            is_last = idx == len(path) - 1
            if (acc >= spacing and not is_last) or is_last:
                nid = b if is_last else len(node_yx)
                if not is_last:
                    node_yx.append((int(y1), int(x1)))
                edges.append((prev_nid, nid, acc))
                prev_nid = nid
                acc = 0.0
                last_idx = idx
    return node_yx, edges


def _lattice_candidates(open_mask, spacing):
    """Return regular-grid candidates whose cells belong to ``open_mask``."""
    h, w = open_mask.shape
    candidates = []
    half = max(1, spacing // 2)
    for y in range(half, h, spacing):
        for x in range(half, w, spacing):
            if open_mask[y, x]:
                candidates.append((y, x))
    return candidates


def _bottleneck_candidates(skel, coarse_clearance, max_clearance, spacing):
    """Sample low-clearance skeleton pixels, prioritising narrow throats.

    Junction/end-point extraction alone does not guarantee a node in a wall
    opening: a long skeleton segment may cross the opening between its normal
    48 px resample points.  These anchors fill only that low-clearance part of
    the skeleton.  A small Poisson-like suppression keeps flat, narrow streets
    from receiving a node at every skeleton pixel.
    """
    low = (
        skel & (coarse_clearance > 0) &
        (coarse_clearance <= max_clearance)
    )
    if not low.any():
        return []

    # Find minima *along the skeleton*. Using the raw clearance image would let
    # adjacent obstacle zeros suppress every passable throat candidate.
    work = np.where(skel, coarse_clearance, np.inf)
    window = max(3, 2 * int(spacing) + 1)
    local_min = ndi.minimum_filter(work, size=window, mode="constant", cval=np.inf)
    minima = low & (coarse_clearance <= local_min + 0.5)
    labels, _ = ndi.label(minima, structure=np.ones((3, 3), dtype=np.uint8))
    out = []
    for label_id, slices in enumerate(ndi.find_objects(labels), start=1):
        if slices is None:
            continue
        local_y, local_x = np.where(labels[slices] == label_id)
        ys = local_y + slices[0].start
        xs = local_x + slices[1].start
        if not len(ys):
            continue
        values = coarse_clearance[ys, xs]
        minimum = values.min()
        best = np.where(values == minimum)[0]
        # Pick the minimum pixel nearest the plateau centroid so long, flat
        # narrow corridors contribute one stable anchor rather than an endpoint.
        cy, cx = float(ys.mean()), float(xs.mean())
        choice = min(
            best.tolist(),
            key=lambda i: ((ys[i] - cy) ** 2 + (xs[i] - cx) ** 2,
                           int(ys[i]), int(xs[i])),
        )
        out.append((int(ys[choice]), int(xs[choice])))
    if len(out) <= 1:
        return out

    # Separate minima labels can sit only a few pixels apart where the coarse
    # skeleton is fragmented around a junction. Keep the narrowest anchor in a
    # wider neighbourhood; this suppression is independent of any global grid.
    min_spacing = max(1, 2 * int(spacing))
    cell = min_spacing
    radius2 = min_spacing * min_spacing
    ordered = sorted(
        out,
        key=lambda p: (float(coarse_clearance[p[0], p[1]]), p[0], p[1]),
    )
    kept = []
    buckets = {}
    for y, x in ordered:
        by, bx = y // cell, x // cell
        if any(
            (y - yy) ** 2 + (x - xx) ** 2 <= radius2
            for gy in (by - 1, by, by + 1)
            for gx in (bx - 1, bx, bx + 1)
            for yy, xx in buckets.get((gy, gx), ())
        ):
            continue
        kept.append((y, x))
        buckets.setdefault((by, bx), []).append((y, x))
    return kept


def _contour_downsample_factor(h, w):
    ds = 1
    while ds < CONTOUR_MAX_DS and (h * w) / (ds * ds) > CONTOUR_TARGET_PX:
        ds += 1
    return ds


def _obstacle_offset_nodes(mask, dist_full, simplify_px=CONTOUR_SIMPLIFY_PX,
                           min_length_px=CONTOUR_MIN_LENGTH_PX,
                           min_turn_degrees=CONTOUR_CORNER_ANGLE_DEG,
                           offset_px=CONTOUR_NODE_OFFSET_PX,
                           sample_spacing_px=CONTOUR_SAMPLE_SPACING_PX,
                           boundary_value=IMPASSABLE,
                           placement_allowed=None):
    """Return ``(protected_xy, regular_xy, contour_pairs, stats)``.

    Contour points are mapped back to full-resolution coordinates. Their local
    normal is tested in both directions; the direction whose first pixels are
    passable is the free-space side. The chosen node has true-mask clearance
    closest to ``offset_px`` and is never selected by a maximum-clearance rule.

    The raw pixel contour is noisy, so regular normals use a wider tangent
    window while corners/segments come from an 8 px simplified guide. Every
    simplified segment receives a protected midpoint anchor. Sharp corners try
    the raw tangent and both incident-edge tangents, which covers concave U
    corners where a single averaged normal is ambiguous. ``contour_pairs`` are
    indices into ``protected_xy + regular_xy`` and preserve along-contour
    adjacency for explicit graph edges.
    """
    H, W = mask.shape
    ds = _contour_downsample_factor(H, W)
    inside_full = mask == boundary_value
    if placement_allowed is None:
        placement_allowed = mask != IMPASSABLE
    allowed_full = np.asarray(placement_allowed, dtype=bool)
    contour_outside = ~inside_full
    contour_passable = (
        _block_reduce(contour_outside, ds, "min") if ds > 1 else contour_outside)
    contours = _sk_find_contours(
        contour_passable.astype(np.uint8), 0.5, fully_connected="high")
    records = []  # {xy, protected, contour, raw_index}
    record_pairs = set()
    min_turn_radians = np.deg2rad(min_turn_degrees)
    simplify = max(1.0, simplify_px / ds)
    min_length = max(4, round(min_length_px / ds))
    stride = max(1, round(sample_spacing_px / ds))

    def offset_candidate(contour, index, tangent=None):
        n = len(contour)
        if tangent is None:
            # Smooth pixel-scale stair steps without blurring real simplified
            # corners (those pass their incident segment tangent explicitly).
            step = min(max(2, round(6 / ds)), max(1, n // 4))
            before = contour[(index - step) % n]
            after = contour[(index + step) % n]
            ty, tx = after - before
        else:
            ty, tx = tangent
        norm = float(np.hypot(tx, ty))
        if norm == 0:
            return None
        # (ny, nx), both possible normal directions.
        normals = [(-tx / norm, ty / norm), (tx / norm, -ty / norm)]
        qy, qx = float(contour[index][0] * ds), float(contour[index][1] * ds)
        best = None
        for ny, nx in normals:
            probes = (max(0.75, ds * 0.75), max(1.25, ds * 1.25), max(2.0, ds * 2.0))
            ahead_free = 0
            behind_black = 0
            for probe in probes:
                fy, fx = int(round(qy + ny * probe)), int(round(qx + nx * probe))
                by, bx = int(round(qy - ny * probe)), int(round(qx - nx * probe))
                if 0 <= fy < H and 0 <= fx < W and allowed_full[fy, fx]:
                    ahead_free += 1
                if 0 <= by < H and 0 <= bx < W and inside_full[by, bx]:
                    behind_black += 1
            if ahead_free == 0 or behind_black == 0:
                continue
            for distance in (float(offset_px), 1.0, 1.5, 2.5, 3.0):
                y = int(round(qy + ny * distance))
                x = int(round(qx + nx * distance))
                if not (0 <= y < H and 0 <= x < W and allowed_full[y, x]):
                    continue
                clearance = float(dist_full[y, x])
                if clearance > max(4.0, offset_px + 2.0):
                    continue
                score = (
                    -ahead_free, -behind_black,
                    abs(clearance - offset_px), abs(distance - offset_px), y, x)
                if best is None or score < best[0]:
                    best = (score, (x, y))
        return None if best is None else best[1]

    def add_record(contour_id, raw_index, xy, protected, importance):
        if xy is None:
            return None
        # Avoid duplicate emissions at one raw vertex/tangent while keeping
        # genuinely distinct incident-side offsets at concave corners.
        for record_id in range(len(records) - 1, -1, -1):
            rec = records[record_id]
            if rec["contour"] != contour_id:
                break
            if rec["raw_index"] == raw_index and rec["xy"] == xy:
                rec["protected"] = rec["protected"] or protected
                rec["importance"] = max(rec["importance"], int(importance))
                return record_id
        records.append({
            "xy": xy, "protected": bool(protected),
            "importance": int(importance),
            "contour": contour_id, "raw_index": int(raw_index),
        })
        return len(records) - 1

    def has_narrow_free_wedge(contour, index):
        """True for concave/ambiguous corners using the authoritative pixels."""
        qy = float(contour[index][0] * ds)
        qx = float(contour[index][1] * ds)
        radius = max(3.0, 2.0 * ds)
        free = 0
        samples = 16
        for k in range(samples):
            angle = 2.0 * np.pi * k / samples
            y = int(round(qy + np.sin(angle) * radius))
            x = int(round(qx + np.cos(angle) * radius))
            if 0 <= y < H and 0 <= x < W and allowed_full[y, x]:
                free += 1
        return free <= samples // 2

    segment_anchor_count = 0
    corner_offset_count = 0
    tiny_contours_skipped = 0
    for contour_id, contour in enumerate(contours):
        if len(contour) < min_length:
            continue
        full_y = contour[:, 0] * ds
        full_x = contour[:, 1] * ds
        span_x = float(full_x.max() - full_x.min())
        span_y = float(full_y.max() - full_y.min())
        area = 0.5 * abs(float(
            np.dot(full_x, np.roll(full_y, 1)) -
            np.dot(full_y, np.roll(full_x, 1))))
        # A tiny compact tree/rock is already handled by full-resolution
        # any-angle refinement and by ordinary graph visibility.  Building a
        # miniature contour roadmap around every such speck dominates plazas.
        # Requiring both small area and small span keeps long thin walls/gates.
        if (area <= CONTOUR_TINY_AREA_PX and
                max(span_x, span_y) <= CONTOUR_TINY_SPAN_PX):
            tiny_contours_skipped += 1
            continue
        poly = _sk_approximate_polygon(contour, tolerance=simplify)
        closed = len(poly) >= 3 and np.linalg.norm(poly[0] - poly[-1]) <= 1.5
        stop = len(poly) - 1 if closed else len(poly)
        if stop < 2:
            continue
        vertex_indices = []
        for i in range(stop):
            delta = contour - poly[i]
            vertex_indices.append(int(np.argmin((delta * delta).sum(axis=1))))

        contour_record_ids = []
        for i in range(stop):
            keep = not closed and (i == 0 or i == stop - 1)
            if not keep and stop >= 3:
                prev, cur, nxt = poly[(i - 1) % stop], poly[i], poly[(i + 1) % stop]
                va, vb = prev - cur, nxt - cur
                na, nb = np.linalg.norm(va), np.linalg.norm(vb)
                if na and nb:
                    interior = np.arccos(np.clip(np.dot(va, vb) / (na * nb), -1.0, 1.0))
                    keep = (np.pi - interior) >= min_turn_radians
            if keep:
                index = vertex_indices[i]
                tangents = [None]
                # Only a narrow true-mask free wedge needs separate incident
                # normals. Convex corners are covered by the raw/bisector normal
                # plus their segment anchors, avoiding three protected clones.
                narrow_wedge = has_narrow_free_wedge(contour, index)
                if narrow_wedge:
                    if closed or i > 0:
                        tangents.append(poly[i] - poly[(i - 1) % stop])
                    if closed or i + 1 < stop:
                        tangents.append(poly[(i + 1) % stop] - poly[i])
                for tangent in tangents:
                    rid = add_record(
                        contour_id, index,
                        offset_candidate(contour, index, tangent=tangent), True,
                        40 if narrow_wedge else 30)
                    if rid is not None:
                        contour_record_ids.append(rid)
                        corner_offset_count += 1

        # Guarantee at least one protected anchor on every simplified segment.
        segment_count = stop if closed else stop - 1
        n = len(contour)
        for i in range(segment_count):
            j = (i + 1) % stop
            segment_length = float(np.linalg.norm(poly[j] - poly[i]) * ds)
            if segment_length < CONTOUR_SEGMENT_ANCHOR_MIN_PX:
                continue
            start, end = vertex_indices[i], vertex_indices[j]
            if closed and end <= start:
                end += n
            elif not closed and end < start:
                start, end = end, start
            mid = ((start + end) // 2) % n
            tangent = poly[j] - poly[i]
            rid = add_record(
                contour_id, mid,
                offset_candidate(contour, mid, tangent=tangent), True, 20)
            if rid is not None:
                contour_record_ids.append(rid)
                segment_anchor_count += 1

        for index in range(stride // 2, len(contour), stride):
            rid = add_record(
                contour_id, index, offset_candidate(contour, index), False, 10)
            if rid is not None:
                contour_record_ids.append(rid)

        # Preserve contour order as explicit candidate edges. Multiple offsets
        # at one corner are linked locally; adjacent raw positions link their
        # closest compatible nodes. Full-mask weighting validates every pair.
        by_index = {}
        for rid in set(contour_record_ids):
            by_index.setdefault(records[rid]["raw_index"], []).append(rid)
        ordered_groups = sorted(by_index.items())
        for _, group in ordered_groups:
            for a in range(len(group)):
                for b in range(a + 1, len(group)):
                    record_pairs.add((min(group[a], group[b]), max(group[a], group[b])))
        group_pairs = list(zip(ordered_groups, ordered_groups[1:]))
        if closed and len(ordered_groups) > 1:
            group_pairs.append((ordered_groups[-1], ordered_groups[0]))
        for (_, left), (_, right) in group_pairs:
            a, b = min(
                ((u, v) for u in left for v in right),
                key=lambda pair: (
                    (records[pair[0]]["xy"][0] - records[pair[1]]["xy"][0]) ** 2 +
                    (records[pair[0]]["xy"][1] - records[pair[1]]["xy"][1]) ** 2,
                    pair,
                ),
            )
            record_pairs.add((min(a, b), max(a, b)))

    raw_candidate_count = len(records)

    def line_is_allowed(a, b):
        x0, y0 = records[a]["xy"]
        x1, y1 = records[b]["xy"]
        steps = max(abs(x1 - x0), abs(y1 - y0))
        for k in range(steps + 1):
            t = k / max(1, steps)
            x = int(round(x0 + (x1 - x0) * t))
            y = int(round(y0 + (y1 - y0) * t))
            if not allowed_full[y, x]:
                return False
        return True

    # Early, importance-aware spatial suppression. This is deliberately before
    # k-NN/edge weighting: it removes overlapping candidates cheaply while
    # corners/bottlenecks beat segment anchors, which beat ordinary samples.
    #
    # Spatial proximity and LOS are not sufficient by themselves: the two sides
    # of a narrow U-shaped cavity can see each other.  Only merge samples that
    # are also near each other in contour arc length.  Different obstacle blobs
    # and distant/facing runs of the same contour therefore retain both sides.
    spacing = CONTOUR_AREA_SPACING_PX
    spacing2 = spacing * spacing
    buckets = {}
    representative = {}
    kept_ids = []
    priority_order = sorted(
        range(len(records)),
        key=lambda rid: (
            -records[rid]["importance"],
            records[rid]["contour"], records[rid]["raw_index"],
            records[rid]["xy"][1], records[rid]["xy"][0], rid,
        ),
    )
    for rid in priority_order:
        x, y = records[rid]["xy"]
        bx, by = x // spacing, y // spacing
        winner = None
        winner_d2 = None
        for gx in (bx - 1, bx, bx + 1):
            for gy in (by - 1, by, by + 1):
                for kept in buckets.get((gx, gy), ()):
                    xx, yy = records[kept]["xy"]
                    d2 = (x - xx) ** 2 + (y - yy) ** 2
                    if d2 > spacing2:
                        continue
                    # Distinct simplified corners encode shape decisions.  In
                    # particular, facing U-cavity corners can be both close and
                    # mutually visible, so never merge two corner-class records.
                    # Segment midpoints and regular coverage samples can still
                    # collapse into a nearby, more important corner/run anchor.
                    if (records[rid]["importance"] >= 30 and
                            records[kept]["importance"] >= 30):
                        continue
                    if records[rid]["contour"] != records[kept]["contour"]:
                        continue
                    contour_size = len(contours[records[rid]["contour"]])
                    arc_delta = abs(
                        records[rid]["raw_index"] - records[kept]["raw_index"])
                    # find_contours normally closes obstacle blobs.  Use the
                    # cyclic distance so candidates around index 0 still merge.
                    if contour_size > 1:
                        arc_delta = min(arc_delta, contour_size - arc_delta)
                    if arc_delta > max(spacing, sample_spacing_px):
                        continue
                    if abs(int(mask[y, x]) - int(mask[yy, xx])) > NODE_DEDUPE_TERRAIN_DELTA:
                        continue
                    if not line_is_allowed(rid, kept):
                        continue
                    if winner is None or (d2, kept) < (winner_d2, winner):
                        winner, winner_d2 = kept, d2
        if winner is not None:
            representative[rid] = winner
            continue
        representative[rid] = rid
        kept_ids.append(rid)
        buckets.setdefault((bx, by), []).append(rid)

    record_pairs = {
        (min(representative[a], representative[b]),
         max(representative[a], representative[b]))
        for a, b in record_pairs
        if representative[a] != representative[b]
    }
    protected_ids = [i for i in kept_ids if records[i]["protected"]]
    regular_ids = [i for i in kept_ids if not records[i]["protected"]]
    order = protected_ids + regular_ids
    remap = {old: new for new, old in enumerate(order)}
    contour_pairs = sorted({
        (min(remap[a], remap[b]), max(remap[a], remap[b]))
        for a, b in record_pairs if a in remap and b in remap and remap[a] != remap[b]
    })
    protected = [records[i]["xy"] for i in protected_ids]
    regular = [records[i]["xy"] for i in regular_ids]
    return protected, regular, contour_pairs, {
        "contour_downsample": ds,
        "boundary_value": int(boundary_value),
        "contours": len(contours),
        "tiny_contours_skipped": tiny_contours_skipped,
        "corner_candidates": len(protected),
        "regular_candidates": len(regular),
        "corner_offsets": corner_offset_count,
        "segment_anchors": segment_anchor_count,
        "contour_adjacency_pairs": len(contour_pairs),
        "raw_candidates": raw_candidate_count,
        "area_spacing_px": CONTOUR_AREA_SPACING_PX,
        "area_suppressed_candidates": raw_candidate_count - len(kept_ids),
    }


def _very_slow_offset_nodes(mask):
    """Contour nodes just outside ``VERY_SLOW`` while treating black as blocked."""
    inside = mask == VERY_SLOW
    if not inside.any():
        return [], [], [], {
            "contour_downsample": _contour_downsample_factor(*mask.shape),
            "boundary_value": VERY_SLOW,
            "contours": 0,
            "corner_candidates": 0,
            "regular_candidates": 0,
            "corner_offsets": 0,
            "segment_anchors": 0,
            "contour_adjacency_pairs": 0,
            "raw_candidates": 0,
            "area_spacing_px": CONTOUR_AREA_SPACING_PX,
            "area_suppressed_candidates": 0,
        }
    boundary_clearance = ndi.distance_transform_edt(~inside).astype(np.float32)
    allowed = (mask != IMPASSABLE) & ~inside
    return _obstacle_offset_nodes(
        mask, boundary_clearance,
        boundary_value=VERY_SLOW,
        placement_allowed=allowed,
    )


def _adaptive_lattice_nodes(coarse_clearance, skel,
                            bottleneck_spacing, near_spacing, far_spacing,
                            obstacle_clearance, near_clearance_max):
    """Return obstacle-biased candidates, then progressively sparser lattices.

    The returned order is significant: bottleneck anchors and simplified
    contour features come first, followed by transition/open-area candidates.
    Full-resolution, visibility-safe deduplication happens after node snapping,
    where thin walls cannot disappear because of skeleton downsampling.
    """
    bottlenecks = _bottleneck_candidates(
        skel, coarse_clearance, obstacle_clearance, bottleneck_spacing)
    near_open = (
        (coarse_clearance > obstacle_clearance) &
        (coarse_clearance <= near_clearance_max)
    )
    far_open = coarse_clearance > near_clearance_max

    near = _lattice_candidates(near_open, near_spacing)
    far = _lattice_candidates(far_open, far_spacing)
    return bottlenecks, near + far, {
        "bottleneck_candidates": len(bottlenecks),
        "near_candidates": len(near),
        "far_candidates": len(far),
        "protected_candidate_count": len(bottlenecks),
    }


# =============================================================================
# Full-resolution weighted A* (subgrid) — parity with astar.js
# =============================================================================

def _astar_subgrid(sub, start, goal, max_expansions=ASTAR_MAX_EXPANSIONS):
    """Weighted 8-connected A* on a small ``uint8`` subgrid.

    Cost model identical to astar.js: ``move = hypot(dx,dy) * (255 - value)``,
    ``value == 0`` blocked, heuristic = euclidean distance. Returns
    ``(cost, geom_length)`` or ``None``, where ``geom_length`` is the unweighted
    pixel length of the min-cost path (tracked inline, so no reconstruction).
    ``start``/``goal`` are (y, x) in subgrid coordinates.

    Pure-Python hot loop over ``bytes`` indexing + ``math.hypot`` — roughly an
    order of magnitude faster than numpy-scalar indexing for these small grids.
    """
    import math
    h, w = sub.shape
    sy, sx = start
    gy, gx = goal
    data = sub.tobytes()  # row-major uint8; data[i] is a fast C int
    n = h * w
    start_i = sy * w + sx
    goal_i = gy * w + gx
    if data[start_i] == IMPASSABLE or data[goal_i] == IMPASSABLE:
        return None

    INF = float("inf")
    g = [INF] * n
    geom = [0.0] * n
    closed = bytearray(n)
    g[start_i] = 0.0
    hypot = math.hypot
    push = heapq.heappush
    pop = heapq.heappop
    heap = [(hypot(gx - sx, gy - sy), start_i)]
    SQRT2 = 1.4142135623730951
    w1 = w - 1
    h1 = h - 1
    expansions = 0
    while heap:
        _, cur = pop(heap)
        if closed[cur]:
            continue
        closed[cur] = 1
        if cur == goal_i:
            return g[cur], geom[cur]
        expansions += 1
        if expansions > max_expansions:
            return None
        cx = cur % w
        cy = cur // w
        gc = g[cur]
        gm = geom[cur]
        left = cx > 0
        right = cx < w1
        up = cy > 0
        down = cy < h1
        # 8 neighbours, unrolled with border guards.
        for dy, dx, diag in (
            (-1, 0, False), (1, 0, False), (0, -1, False), (0, 1, False),
            (-1, -1, True), (-1, 1, True), (1, -1, True), (1, 1, True),
        ):
            if dx < 0 and not left:
                continue
            if dx > 0 and not right:
                continue
            if dy < 0 and not up:
                continue
            if dy > 0 and not down:
                continue
            ni = cur + dy * w + dx
            if closed[ni]:
                continue
            val = data[ni]
            if val == IMPASSABLE:
                continue
            step = SQRT2 if diag else 1.0
            tentative = gc + step * (255 - val)
            if tentative < g[ni]:
                g[ni] = tentative
                geom[ni] = gm + step
                nx = ni % w
                ny = ni // w
                push(heap, (tentative + hypot(gx - nx, gy - ny), ni))
    return None


def _line_cost(mask, x0, y0, x1, y1):
    """Terrain-weighted cost of the straight segment, or ``None`` if it crosses
    an impassable pixel.

    Samples ~1 px steps and accumulates ``substep_len * (255 - value)`` matching
    the A* cost model. Because candidate edges are short and mostly clear, this
    is the fast path; blocked segments fall back to full A*.
    """
    import math
    dx = x1 - x0
    dy = y1 - y0
    steps = int(max(abs(dx), abs(dy)))
    if steps == 0:
        return 0.0
    seg = math.hypot(dx, dy) / steps  # length of one sampling substep
    sx = dx / steps
    sy = dy / steps
    cost = 0.0
    for k in range(1, steps + 1):
        xi = int(round(x0 + sx * k))
        yi = int(round(y0 + sy * k))
        val = mask[yi, xi]
        if val == IMPASSABLE:
            return None
        cost += seg * (255 - int(val))
    return cost


def _filter_regular_contours_near_centerline(
        mask, corners, regular, pairs, centerline_xy,
        radius=NARROW_CENTERLINE_MERGE_PX):
    """Drop ordinary boundary samples already represented by a visible spine.

    Corners and simplified-segment anchors are retained.  A regular contour
    sample is removed only when a snapped skeleton/bottleneck node is close,
    terrain-compatible, and directly visible on the authoritative mask.  This
    cheaply collapses the two redundant wall-side chains in narrow alleys to
    their centerline without doing another A* or affecting wider open borders.
    """
    if radius <= 0 or not regular or not centerline_xy:
        return list(corners), list(regular), list(pairs), 0

    cell = max(1, int(radius))
    radius2 = radius * radius
    buckets = {}
    for x, y in centerline_xy:
        buckets.setdefault((int(x) // cell, int(y) // cell), []).append(
            (int(x), int(y)))

    keep_regular = []
    removed = 0
    old_to_new = {i: i for i in range(len(corners))}
    for offset, (x, y) in enumerate(regular):
        bx, by = int(x) // cell, int(y) // cell
        value = int(mask[int(y), int(x)])
        represented = False
        for gx in (bx - 1, bx, bx + 1):
            for gy in (by - 1, by, by + 1):
                for xx, yy in buckets.get((gx, gy), ()):
                    if (x - xx) ** 2 + (y - yy) ** 2 > radius2:
                        continue
                    if abs(value - int(mask[yy, xx])) > NODE_DEDUPE_TERRAIN_DELTA:
                        continue
                    if _line_cost(mask, int(x), int(y), xx, yy) is not None:
                        represented = True
                        break
                if represented:
                    break
            if represented:
                break
        old = len(corners) + offset
        if represented:
            removed += 1
            continue
        old_to_new[old] = len(corners) + len(keep_regular)
        keep_regular.append((x, y))

    kept_pairs = [
        (old_to_new[a], old_to_new[b]) for a, b in pairs
        if a in old_to_new and b in old_to_new and old_to_new[a] != old_to_new[b]
    ]
    return list(corners), keep_regular, kept_pairs, removed


def _dedupe_appended_nodes(mask, nodes_xy, fixed_count, min_distance,
                           terrain_delta=NODE_DEDUPE_TERRAIN_DELTA,
                           protected_source_end=None):
    """Deduplicate newly appended nodes without crossing walls or terrain bands.

    Skeleton nodes ``[:fixed_count]`` are topology-bearing and are never
    removed. Protected appended nodes are merged only at the exact same pixel;
    later ordinary contour/lattice nodes are discarded only when a retained
    node is almost coincident, the straight segment between them is passable,
    and their terrain values are similar.  The visibility requirement is what
    preserves two close nodes on opposite sides of a thin wall; the terrain
    requirement preserves a fast-path anchor beside slow vegetation.

    Returns ``(deduped_nodes, source_indices, source_to_output)`` where
    ``source_indices[new_i]`` is the corresponding retained source and
    ``source_to_output[old_i]`` also maps discarded duplicates to their witness.
    """
    if min_distance <= 0 or len(nodes_xy) <= fixed_count:
        identity = list(range(len(nodes_xy)))
        return list(nodes_xy), identity, identity

    cell = max(1, int(min_distance))
    radius2 = float(min_distance * min_distance)
    buckets = {}
    out = []
    source_indices = []
    source_to_output = [-1] * len(nodes_xy)

    def retain(source_idx):
        x, y = nodes_xy[source_idx]
        out_idx = len(out)
        out.append((int(x), int(y)))
        source_indices.append(source_idx)
        source_to_output[source_idx] = out_idx
        buckets.setdefault((int(x) // cell, int(y) // cell), []).append(out_idx)

    for idx in range(min(fixed_count, len(nodes_xy))):
        retain(idx)

    for source_idx in range(fixed_count, len(nodes_xy)):
        x, y = nodes_xy[source_idx]
        protected = (
            protected_source_end is not None and
            source_idx < protected_source_end)
        source_radius2 = 0.0 if protected else radius2
        bx, by = int(x) // cell, int(y) // cell
        duplicate = False
        duplicate_output = -1
        value = int(mask[int(y), int(x)])
        for gx in (bx - 1, bx, bx + 1):
            for gy in (by - 1, by, by + 1):
                for kept_idx in buckets.get((gx, gy), ()):
                    xx, yy = out[kept_idx]
                    if (x - xx) ** 2 + (y - yy) ** 2 > source_radius2:
                        continue
                    if abs(value - int(mask[yy, xx])) > terrain_delta:
                        continue
                    if _line_cost(mask, int(x), int(y), xx, yy) is not None:
                        duplicate = True
                        duplicate_output = kept_idx
                        break
                if duplicate:
                    break
            if duplicate:
                break
        if not duplicate:
            retain(source_idx)
        else:
            source_to_output[source_idx] = duplicate_output

    return out, source_indices, source_to_output


def _astar_edge(mask, xi, yi, xj, yj, straight, margin=EDGE_MARGIN,
                detour_ratio=EDGE_DETOUR_RATIO):
    """A* an edge on the bounding subgrid; return cost or ``None`` if no path /
    detour exceeds ``detour_ratio``. Helper shared by weighting and repair."""
    H, W = mask.shape
    y0 = max(0, min(yi, yj) - margin)
    y1 = min(H, max(yi, yj) + margin + 1)
    x0 = max(0, min(xi, xj) - margin)
    x1 = min(W, max(xi, xj) + margin + 1)
    sub = mask[y0:y1, x0:x1]
    res = _astar_subgrid(sub, (yi - y0, xi - x0), (yj - y0, xj - x0))
    if res is None:
        return None
    cost, geom = res
    if geom > detour_ratio * straight:
        return None
    return cost


def _weight_edges(mask, nodes_xy, candidate_edges, astar_pairs):
    """Measure each candidate edge's terrain-weighted cost + legality.

    ``candidate_edges`` is an iterable of (i, j) node-index pairs (i < j).
    Fast path: integrate the cost along the straight segment (legal iff no
    impassable pixel on it). If the straight line is blocked, only skeleton
    backbone edges (those in ``astar_pairs``) fall back to full-res weighted A*
    to route around a thin obstacle; blocked k-NN shortcuts are simply dropped
    (they are optional and the backbone keeps the graph connected). This keeps
    the number of (slow) A* calls bounded on dense masks. Returns parallel lists
    ``(edges, weights)``.
    """
    import math
    edges_out = []
    weights_out = []
    for i, j in candidate_edges:
        xi, yi = nodes_xy[i]
        xj, yj = nodes_xy[j]
        straight = math.hypot(xj - xi, yj - yi)
        if straight == 0:
            continue
        cost = _line_cost(mask, xi, yi, xj, yj)
        if cost is None:
            if (i, j) not in astar_pairs:
                continue  # blocked shortcut -> drop, no A*
            cost = _astar_edge(mask, xi, yi, xj, yj, straight,
                               margin=EDGE_SKELETON_MARGIN,
                               detour_ratio=EDGE_SKELETON_DETOUR)
            if cost is None:
                continue
        edges_out.append((i, j))
        weights_out.append(cost)
    return edges_out, weights_out


def _candidate_edges(nodes_xy, skeleton_edges, feature_nodes=None, mask=None):
    """Union of skeleton edges and local neighbour candidates.

    Feature/gate nodes select the nearest *visible* neighbour in angular sectors.
    This covers both sides of an opening without spending twelve candidates on
    a same-side cluster or on nodes hidden behind the wall.
    """
    cand = set()
    for a, b, _ in skeleton_edges:
        if a != b:
            cand.add((min(a, b), max(a, b)))
    feature_nodes = set(feature_nodes or ())
    pts = np.asarray(nodes_xy, dtype=np.float64)
    n = len(pts)
    if n == 0:
        return cand
    # Bucketed k-NN: cell grid of EDGE_MAX_DIST so we only test near pairs.
    cell = EDGE_MAX_DIST
    buckets = {}
    for idx, (x, y) in enumerate(nodes_xy):
        buckets.setdefault((int(x // cell), int(y // cell)), []).append(idx)
    for idx, (x, y) in enumerate(nodes_xy):
        cx, cy = int(x // cell), int(y // cell)
        near = []
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                near.extend(buckets.get((gx, gy), ()))
        if len(near) <= 1:
            continue
        near_arr = np.array([n2 for n2 in near if n2 != idx], dtype=np.int64)
        d2 = (pts[near_arr, 0] - x) ** 2 + (pts[near_arr, 1] - y) ** 2
        order = np.argsort(d2)
        taken = 0
        sectors = set()
        is_feature = idx in feature_nodes
        wanted = EDGE_FEATURE_SECTORS if is_feature else EDGE_KNN
        for oi in order:
            if taken >= wanted:
                break
            j = int(near_arr[oi])
            if d2[oi] > EDGE_MAX_DIST * EDGE_MAX_DIST:
                break
            if is_feature:
                angle = np.arctan2(pts[j, 1] - y, pts[j, 0] - x)
                sector = int(((angle + np.pi) / (2 * np.pi)) * EDGE_FEATURE_SECTORS)
                sector = min(EDGE_FEATURE_SECTORS - 1, max(0, sector))
                if sector in sectors:
                    continue
                if mask is not None and _line_cost(
                        mask, int(x), int(y),
                        int(pts[j, 0]), int(pts[j, 1])) is None:
                    continue
                sectors.add(sector)
            cand.add((min(idx, j), max(idx, j)))
            taken += 1
    return cand


class _UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, a):
        p = self.parent
        while p[a] != a:
            p[a] = p[p[a]]
            a = p[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb
            return True
        return False


def _repair_connectivity(mask, nodes_xy, edges, weights, components, main_comp):
    """Bridge graph fragments that share the main free-space component.

    Fragments arise when the downsampled skeleton misses a genuine (usually
    narrow) connection. For each disconnected fragment whose nodes lie on the
    main free component, find its closest node to the main graph component and
    try to connect them with a straight line, then A*. Adds bridge edges
    in-place (returns extended ``edges, weights``).
    """
    import math
    n = len(nodes_xy)
    if n == 0 or main_comp == 0:
        return edges, weights
    uf = _UnionFind(n)
    for i, j in edges:
        uf.union(int(i), int(j))

    from collections import defaultdict
    groups = defaultdict(list)
    for idx in range(n):
        if components[idx] == main_comp:
            groups[uf.find(idx)].append(idx)
    if len(groups) <= 1:
        return edges, weights

    main_root = max(groups, key=lambda r: len(groups[r]))
    main_nodes = groups[main_root]

    # Bucket the main-component nodes for nearest-node lookup.
    cell = BRIDGE_MAX_DIST
    buckets = defaultdict(list)
    for idx in main_nodes:
        x, y = nodes_xy[idx]
        buckets[(int(x // cell), int(y // cell))].append(idx)

    edges = list(edges)
    weights = list(weights)
    bridged = 0
    # Bridge larger fragments first — they recover the most nodes.
    ordered = sorted((r for r in groups if r != main_root),
                     key=lambda r: -len(groups[r]))
    for root in ordered:
        members = groups[root]
        # Gather candidate (distance, fragment node, main node) pairs in range.
        cands = []
        for u in members:
            ux, uy = nodes_xy[u]
            bx, by = int(ux // cell), int(uy // cell)
            for gx in (bx - 1, bx, bx + 1):
                for gy in (by - 1, by, by + 1):
                    for v in buckets.get((gx, gy), ()):
                        vx, vy = nodes_xy[v]
                        d = math.hypot(vx - ux, vy - uy)
                        if d <= BRIDGE_MAX_DIST:
                            cands.append((d, u, v))
        if not cands:
            continue
        cands.sort(key=lambda c: c[0])
        # Try the nearest few pairs; a slightly farther pair may have a clear
        # path where the very nearest is walled off. A* margin grows with the
        # gap so a bridge can route around an obstacle.
        for d, u, v in cands[:BRIDGE_TRIES]:
            ux, uy = nodes_xy[u]
            vx, vy = nodes_xy[v]
            cost = _line_cost(mask, ux, uy, vx, vy)
            if cost is None:
                margin = min(BRIDGE_MAX_MARGIN, max(BRIDGE_MARGIN, int(0.75 * d)))
                cost = _astar_edge(mask, ux, uy, vx, vy, d, margin=margin,
                                   detour_ratio=EDGE_SKELETON_DETOUR)
            if cost is None:
                continue
            a, b = (u, v) if u < v else (v, u)
            edges.append((a, b))
            weights.append(cost)
            uf.union(u, v)
            bridged += 1
            break
    return edges, weights


def _witness_path_exists(adjacency, active, nodes_xy, source, target, avoid,
                         max_cost, center, radius):
    """Bounded local Dijkstra used by redundancy pruning."""
    cx, cy = center
    radius2 = radius * radius
    dist = {source: 0.0}
    heap = [(0.0, source)]
    while heap:
        cost, node = heapq.heappop(heap)
        if cost != dist.get(node) or cost > max_cost:
            continue
        if node == target:
            return True
        for nxt, weight in adjacency[node].items():
            if nxt == avoid or not active[nxt]:
                continue
            if nxt not in (source, target):
                x, y = nodes_xy[nxt]
                if (x - cx) ** 2 + (y - cy) ** 2 > radius2:
                    continue
            tentative = cost + weight
            if tentative <= max_cost and tentative < dist.get(nxt, float("inf")):
                dist[nxt] = tentative
                heapq.heappush(heap, (tentative, nxt))
    return False


def _prune_redundant_nodes(nodes_xy, edges, weights, components,
                           protected_nodes, stretch=PRUNE_WITNESS_STRETCH,
                           radius=PRUNE_WITNESS_RADIUS_PX,
                           max_degree=PRUNE_MAX_DEGREE):
    """Remove open-lattice nodes whose incident routes have local witnesses.

    A node is removed only when every neighbour pair can already reach each
    other without it for at most ``stretch`` times the through-node cost. The
    check is sequential: later removals see earlier changes, so a witness cannot
    silently depend on a node that has already gone. No shortcut edges are
    created, which keeps the serialized endpoint-only edge geometry truthful.
    """
    n = len(nodes_xy)
    if not n or not edges:
        return list(nodes_xy), list(edges), list(weights), components, 0

    adjacency = [dict() for _ in range(n)]
    for (u, v), weight in zip(edges, weights):
        u, v, weight = int(u), int(v), float(weight)
        previous = adjacency[u].get(v)
        if previous is None or weight < previous:
            adjacency[u][v] = weight
            adjacency[v][u] = weight

    protected = set(int(v) for v in protected_nodes)
    active = [True] * n
    removed = 0
    # Open nodes with the fewest choices are cheapest to prove redundant; hubs
    # and all topology/feature nodes are deliberately left intact.
    candidates = sorted(
        (v for v in range(n) if v not in protected),
        key=lambda v: (len(adjacency[v]), v),
    )
    for v in candidates:
        neighbours = [(u, w) for u, w in adjacency[v].items() if active[u]]
        degree = len(neighbours)
        if degree == 0:
            active[v] = False
            removed += 1
            continue
        if degree < 2 or degree > max_degree:
            continue
        center = nodes_xy[v]
        redundant = True
        for i in range(degree):
            source, source_w = neighbours[i]
            for j in range(i + 1, degree):
                target, target_w = neighbours[j]
                limit = stretch * (source_w + target_w)
                if not _witness_path_exists(
                        adjacency, active, nodes_xy, source, target, v,
                        limit, center, radius):
                    redundant = False
                    break
            if not redundant:
                break
        if not redundant:
            continue
        active[v] = False
        for neighbour, _ in neighbours:
            adjacency[neighbour].pop(v, None)
        adjacency[v].clear()
        removed += 1

    if not removed:
        return list(nodes_xy), list(edges), list(weights), components, 0

    kept = [idx for idx, is_active in enumerate(active) if is_active]
    remap = np.full(n, -1, dtype=np.int32)
    remap[kept] = np.arange(len(kept), dtype=np.int32)
    new_nodes = [nodes_xy[idx] for idx in kept]
    new_components = np.asarray(components, dtype=np.int32)[kept]
    new_edges = []
    new_weights = []
    for u in kept:
        for v, weight in adjacency[u].items():
            if active[v] and u < v:
                new_edges.append((int(remap[u]), int(remap[v])))
                new_weights.append(float(weight))
    return new_nodes, new_edges, new_weights, new_components, removed


# =============================================================================
# Sampling metadata
# =============================================================================

def _sampling_grids(mask, dist_full, labels_full):
    """Build the ÷SAMPLE_DS coarse sampling grids.

    * ``coarse_minval`` — block-min terrain value (0 if any impassable in block).
    * ``coarse_clear``  — block-max clearance (px, capped 255).
    * ``coarse_labels`` — free-space component id at the block's freest pixel.
    """
    ds = SAMPLE_DS
    H, W = mask.shape
    hh, ww = (H // ds) * ds, (W // ds) * ds
    ch, cw = hh // ds, ww // ds

    mv = mask[:hh, :ww].reshape(ch, ds, cw, ds)
    coarse_minval = mv.min(axis=(1, 3)).astype(np.uint8)

    dv = dist_full[:hh, :ww].reshape(ch, ds, cw, ds)
    coarse_clear = np.clip(dv.max(axis=(1, 3)), 0, 255).astype(np.uint8)

    # Label at the freest (max-value) pixel of each block.
    val_blocks = mv  # (ch, ds, cw, ds)
    val_flat = val_blocks.transpose(0, 2, 1, 3).reshape(ch, cw, ds * ds)
    lbl_blocks = labels_full[:hh, :ww].reshape(ch, ds, cw, ds)
    lbl_flat = lbl_blocks.transpose(0, 2, 1, 3).reshape(ch, cw, ds * ds)
    argmax = val_flat.argmax(axis=2)
    coarse_labels = np.take_along_axis(lbl_flat, argmax[:, :, None], axis=2)[:, :, 0]
    # Blocks with no passable pixel get label 0 (== "not free space").
    coarse_labels[val_flat.max(axis=2) == IMPASSABLE] = 0
    return coarse_minval, coarse_clear, coarse_labels.astype(np.int32)


# =============================================================================
# Build
# =============================================================================

def build_navgraph(mask_path, region_polygon=None, verbose=False):
    """Build the navgraph artifact dict for one mask PNG.

    ``region_polygon`` (optional) is a coach-drawn map-region polygon: a sequence
    of full-res ``(x, y)`` vertices. When given it is the *authoritative* hit zone
    (rasterized into ``coarse_hitzone`` and used to confine the open-area lattice);
    the automatic ``_hitzone`` detection is used only as a fallback / suggestion
    when no polygon is supplied. See the module "Off-map hit zone" note.

    Returns a dict with all arrays + stats (see module docstring). Pure
    computation; use ``save_navgraph()`` to persist.
    """
    if not _HAVE_SKIMAGE:
        raise RuntimeError(
            "scikit-image is required for navgraph skeletonization; add it to "
            "requirements.txt (see WP 1.1)."
        )
    t_start = time.time()
    timings = {}

    def _log(msg):
        if verbose:
            print(f"[navgraph] {msg}", flush=True)

    # 1. Load mask.
    t = time.time()
    mask = _load_mask(mask_path)
    H, W = mask.shape
    timings["load"] = time.time() - t
    _log(f"loaded {W}x{H} ({H*W/1e6:.1f} Mpx)")

    min_cost_per_px = _min_cost_per_px(mask)

    # 2. Unfiltered free-space labels (for node component ids + coarse labels).
    t = time.time()
    struct8 = np.ones((3, 3), dtype=np.uint8)
    labels_full, ncomp = ndi.label(mask != IMPASSABLE, structure=struct8)
    comp_sizes = np.bincount(labels_full.ravel())
    main_comp = int(comp_sizes[1:].argmax()) + 1 if ncomp > 0 else 0
    timings["label"] = time.time() - t
    _log(f"labelled {ncomp} free components; main={main_comp}")

    # 3. Hit zone: the coach-drawn region polygon is authoritative if supplied;
    #    otherwise fall back to automatic class-structure detection. Footprint
    #    confines the lattice; sample mask is the stored endpoint zone.
    t = time.time()
    has_polygon = region_polygon is not None and len(region_polygon) >= 3
    if has_polygon:
        hz_ds = HITZONE_DS
        region = _rasterize_region(region_polygon, H, W, hz_ds)
        hz_footprint = hz_sample = region
        hz_source = "polygon"
    else:
        hz_footprint, hz_sample, hz_ds = _hitzone(mask)
        hz_source = "auto"
    timings["hitzone"] = time.time() - t
    _log(f"hitzone[{hz_source}]: footprint {hz_footprint.mean()*100:.0f}% "
         f"sample {hz_sample.mean()*100:.0f}% (ds={hz_ds})")

    # 4. Full-res distance transform (clearance) on the true free space.
    t = time.time()
    topo_passable = mask != IMPASSABLE
    dist_full = ndi.distance_transform_edt(topo_passable).astype(np.float32)
    timings["edt"] = time.time() - t

    # 5. Adaptive downsample + skeletonize.
    ds = _downsample_factor(H, W)
    t = time.time()
    coarse_passable = _block_reduce(topo_passable, ds, "max") if ds > 1 else topo_passable
    skel = _sk_skeletonize(coarse_passable)
    skel = _prune_spurs(skel, SPUR_MIN_LEN)
    timings["skeleton"] = time.time() - t
    _log(f"ds={ds} skeleton px={int(skel.sum())} ({timings['skeleton']:.1f}s)")

    # 6. Nodes from skeleton (coarse coords) + resample + lattice. Spacings are
    #    specified in full-res px and converted to coarse px for this stage.
    t = time.time()
    resample_coarse = max(3, round(RESAMPLE_SPACING_PX / ds))
    bottleneck_spacing_coarse = max(2, round(BOTTLENECK_SPACING_PX / ds))
    lattice_near_coarse = max(3, round(LATTICE_SPACING_NEAR_PX / ds))
    lattice_far_coarse = max(4, round(LATTICE_SPACING_FAR_PX / ds))
    node_yx, segments = _skeleton_nodes_and_segments(skel, resample_coarse)
    node_yx, skeleton_edges = _resample_segments(node_yx, segments, resample_coarse)

    n_skeleton_nodes = len(node_yx)
    # Bottleneck anchors and sparse open candidates remain in skeleton-grid
    # coordinates. Obstacle contour nodes are generated separately in full-res
    # coordinates so their 2 px side-preserving offset is not destroyed by snap.
    coarse_dist = _block_reduce(dist_full, ds, "max") if ds > 1 else dist_full
    raw_bottleneck_yx, raw_open_yx, obstacle_sampling = _adaptive_lattice_nodes(
        coarse_dist, skel,
        bottleneck_spacing_coarse,
        lattice_near_coarse, lattice_far_coarse,
        OBSTACLE_CLEARANCE_PX, NEAR_OBSTACLE_CLEARANCE_PX,
    )

    def inside_footprint_xy(x, y):
        return bool(hz_footprint[
            min(y // hz_ds, hz_footprint.shape[0] - 1),
            min(x // hz_ds, hz_footprint.shape[1] - 1),
        ])

    bottleneck_yx = [
        (y, x) for y, x in raw_bottleneck_yx
        if inside_footprint_xy(x * ds, y * ds)
    ]
    open_yx = [
        (y, x) for y, x in raw_open_yx
        if inside_footprint_xy(x * ds, y * ds)
    ]
    (black_corners_xy, black_regular_xy,
     black_pairs, black_contour_stats) = _obstacle_offset_nodes(mask, dist_full)
    (slow_corners_xy, slow_regular_xy,
     slow_pairs, slow_contour_stats) = _very_slow_offset_nodes(mask)

    def filter_contour_to_footprint(corners, regular, pairs):
        """Filter contour nodes without invalidating pair indices."""
        old_to_new = {}
        kept_corners = []
        kept_regular = []
        for old, (x, y) in enumerate(corners):
            if inside_footprint_xy(x, y):
                old_to_new[old] = len(kept_corners)
                kept_corners.append((x, y))
        regular_base_old = len(corners)
        for offset, (x, y) in enumerate(regular):
            old = regular_base_old + offset
            if inside_footprint_xy(x, y):
                old_to_new[old] = len(kept_corners) + len(kept_regular)
                kept_regular.append((x, y))
        kept_pairs = [
            (old_to_new[a], old_to_new[b]) for a, b in pairs
            if a in old_to_new and b in old_to_new and old_to_new[a] != old_to_new[b]
        ]
        return kept_corners, kept_regular, kept_pairs

    black_corners_xy, black_regular_xy, black_pairs = filter_contour_to_footprint(
        black_corners_xy, black_regular_xy, black_pairs)
    slow_corners_xy, slow_regular_xy, slow_pairs = filter_contour_to_footprint(
        slow_corners_xy, slow_regular_xy, slow_pairs)

    # 7. Snap coarse node coords to a genuinely passable full-res pixel (x, y).
    #    Nodes are NOT pruned to the hit zone: the off-map open area often links
    #    map regions that have no in-map connection, so removing it fragments the
    #    graph below the connectivity bar. The hit zone gates route *endpoints*
    #    (stored below), not graph topology; the skeleton backbone is kept
    #    everywhere so the graph stays connected and open fields stay crossable.
    skeleton_xy = _snap_nodes(mask, node_yx, ds)
    bottleneck_xy = _snap_bottleneck_nodes(mask, dist_full, bottleneck_yx, ds)
    open_xy = _snap_nodes(mask, open_yx, ds)
    centerline_xy = skeleton_xy + bottleneck_xy
    (black_corners_xy, black_regular_xy, black_pairs,
     black_centerline_removed) = _filter_regular_contours_near_centerline(
        mask, black_corners_xy, black_regular_xy, black_pairs, centerline_xy)
    (slow_corners_xy, slow_regular_xy, slow_pairs,
     slow_centerline_removed) = _filter_regular_contours_near_centerline(
        mask, slow_corners_xy, slow_regular_xy, slow_pairs, centerline_xy)
    snapped_xy = (
        skeleton_xy + bottleneck_xy +
        black_corners_xy + slow_corners_xy +
        black_regular_xy + slow_regular_xy + open_xy)
    black_corner_start = n_skeleton_nodes + len(bottleneck_xy)
    slow_corner_start = black_corner_start + len(black_corners_xy)
    black_regular_start = slow_corner_start + len(slow_corners_xy)
    slow_regular_start = black_regular_start + len(black_regular_xy)
    boundary_source_end = slow_regular_start + len(slow_regular_xy)
    # Every contour candidate that survived the contour-local 10 px thinning is
    # a geometric coverage anchor, not an ordinary open-area sample.  Letting
    # the global deduper replace one with a nearby skeleton node (or letting
    # witness pruning remove it later) can leave a 24-48 px hole along one side
    # of a wall.  The graph can remain topologically connected while losing the
    # close-to-border route that these nodes exist to represent, so protect the
    # complete thinned boundary set through both later reduction stages.
    protected_source_end = boundary_source_end
    nodes_xy, node_source_indices, source_to_output = _dedupe_appended_nodes(
        mask, snapped_xy, n_skeleton_nodes, NODE_DEDUPE_PX,
        protected_source_end=protected_source_end)

    def map_contour_pairs(pairs, corner_count, corner_start, regular_start):
        mapped = set()
        for a, b in pairs:
            source_a = corner_start + a if a < corner_count else regular_start + a - corner_count
            source_b = corner_start + b if b < corner_count else regular_start + b - corner_count
            u, v = source_to_output[source_a], source_to_output[source_b]
            if u >= 0 and v >= 0 and u != v:
                mapped.add((min(u, v), max(u, v)))
        return mapped

    contour_pairs = set()
    contour_pairs.update(map_contour_pairs(
        black_pairs, len(black_corners_xy), black_corner_start, black_regular_start))
    contour_pairs.update(map_contour_pairs(
        slow_pairs, len(slow_corners_xy), slow_corner_start, slow_regular_start))
    # Explicit contour adjacency is a geometry guarantee, not permission for a
    # costly/ambiguous detour around the obstacle. Keep only true-mask straight
    # same-side links; blocked pairs remain represented through their protected
    # nodes and ordinary graph candidates.
    contour_pairs = {
        (u, v) for u, v in contour_pairs
        if _line_cost(
            mask, nodes_xy[u][0], nodes_xy[u][1],
            nodes_xy[v][0], nodes_xy[v][1]) is not None
    }
    feature_nodes = {
        new_idx for new_idx, source_idx in enumerate(node_source_indices)
        if n_skeleton_nodes <= source_idx < protected_source_end
    }
    obstacle_edge_nodes = {
        new_idx for new_idx, source_idx in enumerate(node_source_indices)
        if n_skeleton_nodes <= source_idx < boundary_source_end
    }
    protected_nodes = set(range(n_skeleton_nodes)) | feature_nodes
    n_lattice_nodes = len(nodes_xy) - n_skeleton_nodes
    obstacle_sampling.update({
        "black_contours": black_contour_stats,
        "very_slow_contours": slow_contour_stats,
        "footprint_bottlenecks": len(bottleneck_yx),
        "footprint_black_corners": len(black_corners_xy),
        "footprint_black_regular": len(black_regular_xy),
        "footprint_very_slow_corners": len(slow_corners_xy),
        "footprint_very_slow_regular": len(slow_regular_xy),
        "black_centerline_merged": black_centerline_removed,
        "very_slow_centerline_merged": slow_centerline_removed,
        "footprint_open_candidates": len(open_yx),
        "deduplicated_count": len(snapped_xy) - len(nodes_xy),
        "n_feature_nodes": len(feature_nodes),
        "n_open_nodes": n_lattice_nodes - len(feature_nodes),
        "deduped_contour_pairs": len(contour_pairs),
    })
    timings["nodes"] = time.time() - t
    _log(f"nodes: {len(nodes_xy)} ({n_skeleton_nodes} skeleton, "
         f"{len(feature_nodes)} protected contour/gate, "
         f"{n_lattice_nodes - len(feature_nodes)} open lattice, "
         f"{obstacle_sampling['deduplicated_count']} deduplicated)")

    # 8. Component id per node (from unfiltered labels) — needed for repair.
    nodes_arr = np.asarray(nodes_xy, dtype=np.int32).reshape(-1, 2)
    if len(nodes_arr):
        components = labels_full[nodes_arr[:, 1], nodes_arr[:, 0]].astype(np.int32)
    else:
        components = np.zeros(0, dtype=np.int32)

    # 9. Candidate edges -> weighting (A* fallback for skeleton backbone only).
    t = time.time()
    backbone_edges = list(skeleton_edges) + [
        (u, v, 0.0) for u, v in contour_pairs]
    skeleton_pairs = {
        (min(a, b), max(a, b)) for a, b, _ in backbone_edges if a != b}
    cand = _candidate_edges(
        nodes_xy, backbone_edges, obstacle_edge_nodes, mask=mask)
    edges, weights = _weight_edges(mask, nodes_xy, cand, skeleton_pairs)
    n_before = len(edges)
    edges, weights = _repair_connectivity(
        mask, nodes_xy, edges, weights, components, main_comp)
    nodes_xy, edges, weights, components, pruned_nodes = _prune_redundant_nodes(
        nodes_xy, edges, weights, components, protected_nodes)
    if pruned_nodes:
        n_lattice_nodes -= pruned_nodes
        obstacle_sampling["n_open_nodes"] -= pruned_nodes
    obstacle_sampling["witness_pruned_nodes"] = pruned_nodes
    nodes_arr = np.asarray(nodes_xy, dtype=np.int32).reshape(-1, 2)
    timings["edges"] = time.time() - t
    _log(f"edges: {len(edges)} kept of {len(cand)} candidates "
         f"(+{len(edges) - n_before} net after bridges/pruning, "
         f"{pruned_nodes} nodes pruned) ({timings['edges']:.1f}s)")

    # 10. Sampling metadata.
    t = time.time()
    coarse_minval, coarse_clear, coarse_labels = _sampling_grids(mask, dist_full, labels_full)
    timings["sampling"] = time.time() - t

    edges_arr = np.asarray(edges, dtype=np.int32).reshape(-1, 2)
    weights_arr = np.asarray(weights, dtype=np.float32).reshape(-1)

    # Graph connectivity of nodes on the main free-space component.
    main_conn = _main_component_connectivity(nodes_arr, edges_arr, components, main_comp)

    free_total = int((mask != IMPASSABLE).sum())
    stats = {
        "mask_shape": [int(H), int(W)],
        "mpx": round(H * W / 1e6, 2),
        "downsample": int(ds),
        "n_nodes": int(len(nodes_arr)),
        "n_skeleton_nodes": int(n_skeleton_nodes),
        "n_lattice_nodes": int(n_lattice_nodes),
        "n_feature_nodes": int(len(feature_nodes)),
        "n_edges": int(len(edges_arr)),
        "n_components": int(ncomp),
        "main_component_fraction": round(
            float(comp_sizes[main_comp]) / free_total, 4) if free_total and main_comp else 0.0,
        "free_fraction": round(free_total / (H * W), 4),
        "main_component_connectivity": round(main_conn, 4),
        "hitzone_source": hz_source,
        "hitzone_footprint_fraction": round(float(hz_footprint.mean()), 4),
        "hitzone_sample_fraction": round(float(hz_sample.mean()), 4),
        "hitzone_scale": int(hz_ds),
        "region_polygon": (
            [[int(x), int(y)] for (x, y) in region_polygon] if has_polygon else None),
        "min_cost_per_px": min_cost_per_px,
        "lattice": {
            "obstacle_clearance_px": int(OBSTACLE_CLEARANCE_PX),
            "bottleneck_spacing_px": int(BOTTLENECK_SPACING_PX),
            "contour_simplify_px": int(CONTOUR_SIMPLIFY_PX),
            "contour_min_length_px": int(CONTOUR_MIN_LENGTH_PX),
            "contour_corner_angle_deg": int(CONTOUR_CORNER_ANGLE_DEG),
            "contour_node_offset_px": int(CONTOUR_NODE_OFFSET_PX),
            "contour_sample_spacing_px": int(CONTOUR_SAMPLE_SPACING_PX),
            "contour_segment_anchor_min_px": int(CONTOUR_SEGMENT_ANCHOR_MIN_PX),
            "dedupe_px": int(NODE_DEDUPE_PX),
            "near_obstacle_clearance_px": int(NEAR_OBSTACLE_CLEARANCE_PX),
            "near_spacing_px": int(LATTICE_SPACING_NEAR_PX),
            "far_spacing_px": int(LATTICE_SPACING_FAR_PX),
        },
        "obstacle_sampling": obstacle_sampling,
        "build_seconds": round(time.time() - t_start, 2),
        "timings": {k: round(v, 2) for k, v in timings.items()},
    }
    artifact = {
        "version": NAVGRAPH_VERSION,
        "nodes": nodes_arr,
        "edges": edges_arr,
        "weights": weights_arr,
        "components": components,
        "min_cost_per_px": np.float32(min_cost_per_px),
        "mask_shape": np.asarray([H, W], dtype=np.int32),
        "coarse_scale": np.int32(SAMPLE_DS),
        "coarse_minval": coarse_minval,
        "coarse_clear": coarse_clear,
        "coarse_labels": coarse_labels,
        "hitzone_scale": np.int32(hz_ds),
        "coarse_hitzone": hz_sample.astype(np.uint8),
        "stats": stats,
    }

    # 11. Suitability estimate (WP 4.3) — lightweight pair-generation
    #     simulation mirroring the client pipeline (scripts/navgraph_harness.mjs
    #     / project/navgraph_suitability.py). Never allowed to break a build.
    t = time.time()
    try:
        from .navgraph_suitability import simulate_suitability
        suitability = simulate_suitability(artifact, mask)
    except Exception as exc:  # pragma: no cover - defensive; must never break a build
        _log(f"suitability simulation failed: {exc!r}")
        suitability = None
    timings["suitability"] = time.time() - t
    stats["suitability"] = suitability
    stats["timings"] = {k: round(v, 2) for k, v in timings.items()}
    stats["build_seconds"] = round(time.time() - t_start, 2)
    if suitability:
        _log(f"suitability: valid_rate={suitability['valid_rate']} "
             f"mean_retries={suitability['mean_retries']} mean_ms={suitability['mean_ms']} "
             f"warn={suitability['warn']}")
    _log(f"done in {stats['build_seconds']}s; main-comp connectivity {main_conn:.3f}")

    return artifact


def _nearest_passable(mask, cy, cx, max_r):
    """Nearest passable ``(x, y)`` pixel to (cy, cx) via expanding rings, or
    ``None`` if none within ``max_r``."""
    H, W = mask.shape
    if mask[cy, cx] != IMPASSABLE:
        return (int(cx), int(cy))
    for r in range(1, max_r + 1):
        y0, y1 = max(0, cy - r), min(H, cy + r + 1)
        x0, x1 = max(0, cx - r), min(W, cx + r + 1)
        win = mask[y0:y1, x0:x1]
        if int(win.max()) > IMPASSABLE:
            ys, xs = np.where(win > IMPASSABLE)
            d = (ys - (cy - y0)) ** 2 + (xs - (cx - x0)) ** 2
            k = int(d.argmin())
            return (int(x0 + xs[k]), int(y0 + ys[k]))
    return None


def _snap_nodes(mask, node_yx, ds):
    """Map coarse (y, x) nodes to a genuinely passable full-res pixel.

    Picks the freest (max terrain value) pixel in the node's ds x ds block; if
    the whole block is impassable in the *true* mask (e.g. a node placed over a
    blob-removed tree in the topology mask), searches outward for the nearest
    passable pixel. Guarantees each node sits on a passable pixel and returns
    ``(x, y)`` full-res integer coordinates.
    """
    H, W = mask.shape
    out = []
    for (cy, cx) in node_yx:
        y0 = min(cy * ds, H - 1)
        x0 = min(cx * ds, W - 1)
        y1 = min(y0 + ds, H)
        x1 = min(x0 + ds, W)
        block = mask[y0:y1, x0:x1]
        if block.size and int(block.max()) > IMPASSABLE:
            k = int(block.argmax())
            by, bx = divmod(k, block.shape[1])
            out.append((int(x0 + bx), int(y0 + by)))
            continue
        # Whole block impassable in the true mask -> find nearest passable pixel.
        ccy = min((y0 + y1) // 2, H - 1)
        ccx = min((x0 + x1) // 2, W - 1)
        found = _nearest_passable(mask, ccy, ccx, max_r=max(4 * ds, 32))
        out.append(found if found is not None else (int(x0), int(y0)))
    return out


def _snap_bottleneck_nodes(mask, dist_full, node_yx, ds):
    """Map coarse bottlenecks to the centre of their full-resolution throat.

    Unlike generic node snapping, clearance is the primary criterion. Terrain
    value and distance break ties, keeping a centreline anchor on a mapped path
    when several equally central pixels exist.
    """
    H, W = mask.shape
    out = []
    radius = max(2, ds)
    for cy, cx in node_yx:
        center_y = min(int(round((cy + 0.5) * ds)), H - 1)
        center_x = min(int(round((cx + 0.5) * ds)), W - 1)
        y0, y1 = max(0, center_y - radius), min(H, center_y + radius + 1)
        x0, x1 = max(0, center_x - radius), min(W, center_x + radius + 1)
        py, px = np.where(mask[y0:y1, x0:x1] != IMPASSABLE)
        if not len(py):
            found = _nearest_passable(mask, center_y, center_x, max_r=max(4 * ds, 32))
            out.append(found if found is not None else (center_x, center_y))
            continue
        py = py + y0
        px = px + x0
        choices = sorted(
            range(len(py)),
            key=lambda i: (
                -float(dist_full[py[i], px[i]]),
                -int(mask[py[i], px[i]]),
                (py[i] - center_y) ** 2 + (px[i] - center_x) ** 2,
                int(py[i]), int(px[i]),
            ),
        )
        best = choices[0]
        out.append((int(px[best]), int(py[best])))
    return out


def _main_component_connectivity(nodes_arr, edges_arr, components, main_comp):
    """Fraction of main-free-component nodes that lie in the graph's largest
    connected sub-component (of those main-component nodes)."""
    if main_comp == 0 or len(nodes_arr) == 0:
        return 0.0
    on_main = np.where(components == main_comp)[0]
    if len(on_main) == 0:
        return 0.0
    idx_set = set(on_main.tolist())
    # Build adjacency restricted to main-component nodes.
    adj = {i: [] for i in idx_set}
    for u, v in edges_arr:
        u = int(u); v = int(v)
        if u in idx_set and v in idx_set:
            adj[u].append(v)
            adj[v].append(u)
    # Largest connected component via BFS.
    seen = set()
    best = 0
    for src in idx_set:
        if src in seen:
            continue
        stack = [src]
        seen.add(src)
        size = 0
        while stack:
            cur = stack.pop()
            size += 1
            for nb in adj[cur]:
                if nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        best = max(best, size)
    return best / len(on_main)


# =============================================================================
# Serialization
# =============================================================================

def save_navgraph(artifact, mask_path):
    """Write ``.navgraph.npz`` and ``.navgraph.bin`` next to ``mask_path``.

    Returns ``(npz_path, bin_path)``.
    """
    base, _ = os.path.splitext(mask_path)
    npz_path = base + ".navgraph.npz"
    bin_path = base + ".navgraph.bin"

    np.savez_compressed(
        npz_path,
        version=np.int32(artifact["version"]),
        nodes=artifact["nodes"],
        edges=artifact["edges"],
        weights=artifact["weights"],
        components=artifact["components"],
        min_cost_per_px=artifact["min_cost_per_px"],
        mask_shape=artifact["mask_shape"],
        coarse_scale=artifact["coarse_scale"],
        coarse_minval=artifact["coarse_minval"],
        coarse_clear=artifact["coarse_clear"],
        coarse_labels=artifact["coarse_labels"],
        hitzone_scale=artifact["hitzone_scale"],
        coarse_hitzone=artifact["coarse_hitzone"],
        stats=json.dumps(artifact["stats"]),
    )
    _write_bin(bin_path, artifact)
    return npz_path, bin_path


def _write_bin(bin_path, artifact):
    """Serialize the compact little-endian binary (see module docstring)."""
    nodes = np.ascontiguousarray(artifact["nodes"], dtype="<i4")
    edges = np.ascontiguousarray(artifact["edges"], dtype="<i4")
    weights = np.ascontiguousarray(artifact["weights"], dtype="<f4")
    components = np.ascontiguousarray(artifact["components"], dtype="<i4")
    coarse_minval = np.ascontiguousarray(artifact["coarse_minval"], dtype="<u1")
    coarse_clear = np.ascontiguousarray(artifact["coarse_clear"], dtype="<u1")
    coarse_labels = np.ascontiguousarray(artifact["coarse_labels"], dtype="<i4")
    coarse_hitzone = np.ascontiguousarray(artifact["coarse_hitzone"], dtype="<u1")

    H, W = int(artifact["mask_shape"][0]), int(artifact["mask_shape"][1])
    N = nodes.shape[0]
    E = edges.shape[0]
    ch, cw = coarse_minval.shape
    hh_, hw_ = coarse_hitzone.shape

    # Fixed 52-byte header (magic + scalars), then tightly packed arrays.
    with open(bin_path, "wb") as f:
        f.write(NAVGRAPH_MAGIC)
        f.write(np.array([artifact["version"]], dtype="<u4").tobytes())
        f.write(np.array([H, W], dtype="<i4").tobytes())
        f.write(np.array([float(artifact["min_cost_per_px"])], dtype="<f4").tobytes())
        f.write(np.array([N, E], dtype="<u4").tobytes())
        f.write(np.array([int(artifact["coarse_scale"]), ch, cw], dtype="<i4").tobytes())
        f.write(np.array([int(artifact["hitzone_scale"]), hh_, hw_], dtype="<i4").tobytes())
        f.write(nodes.tobytes())
        f.write(edges.tobytes())
        f.write(weights.tobytes())
        f.write(components.tobytes())
        f.write(coarse_minval.tobytes())
        f.write(coarse_clear.tobytes())
        f.write(coarse_labels.tobytes())
        f.write(coarse_hitzone.tobytes())


if __name__ == "__main__":  # pragma: no cover - manual smoke test
    import sys
    if len(sys.argv) < 2:
        print("usage: python -m project.navgraph <mask.png> [<mask.png> ...]")
        raise SystemExit(1)
    for mp in sys.argv[1:]:
        art = build_navgraph(mp, verbose=True)
        npz, binp = save_navgraph(art, mp)
        print(json.dumps(art["stats"], indent=2))
        print(f"wrote {npz} and {binp}")
