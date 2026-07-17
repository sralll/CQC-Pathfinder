"""Navgraph builder — free-space skeleton graph over a terrain mask.

This module turns a terrain-class mask PNG (as produced by ``project/UNet.py``)
into a compact weighted navigation graph plus endpoint-sampling metadata.
Production play uses graph A* to propose route alternatives, then runs the
full-resolution corridor and Theta* stages on the true mask for the selected
two routes. Pixel-grid A* remains the benchmark oracle, not a production stage.

Terrain / cost model
--------------------
Masks are 8-bit terrain-class grids. ``0`` is impassable; every other value is
passable with a per-distance cost of ``255 - value``. Edge fallback paths use
the symmetric pixel-centre integral supplied by ``MCP_Geometric``; the browser
uses the same terrain costs and the final full-resolution Theta* remains the
legality/geometry authority. Both the current class scheme
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
zone where automatic mode may place route endpoints). For a coach polygon, the
full-resolution raster also prunes topology and makes the exterior impassable to
every edge-building path. Automatic/legacy builds retain the global topology.


Artifact contents
-----------------
``build_navgraph()`` returns a dict. ``save_navgraph()`` always writes the
served binary and can optionally write the full debug artifact next to the
mask:

* ``<mask>.navgraph.npz`` — optional full arrays for Python/debug tooling.
* ``<mask>.navgraph.bin`` — compact little-endian binary for the JS worker.

Compact served graph and sampling metadata (v6)
-----------------------------------------------
The served ``.bin`` and optional debug ``.npz`` contain a *typed* graph. Nodes
``[0, base_node_count)`` are ordinary base
nodes; nodes ``[base_node_count, N)`` are protected passage-chain nodes, grouped
by passage in canonical passage-id order (``passage_node_start`` / ``_count``).
Every edge carries a ``kind`` — ``0`` base, ``1`` passage (a centreline-chain
segment), ``2`` transition (an endpoint↔base connector) — and, for passage and
transition edges, the owning passage ordinal (``-1`` for base edges). A
``passage_revision`` string (canonical over the normalized passage document plus
mask dimensions) lets a reader reject an artifact whose passages no longer match
the served ``File.level_passages``. A base-only
build has ``base_node_count == N`` and zero passages.

The binary stores compact node/edge topology, the exact preclassified endpoint
cell set, and the polygon hitzone. Coordinates and node indices use uint16 when
possible; endpoint and hitzone grids are bit-packed. Debug-only coarse rasters
and component labels remain exclusive to the optional ``.npz``.

Array keys (npz):
    nodes         (N,2) int32   full-res (x, y) per node (base then passage)
    edges         (E,2) int32   node index pairs (base edges have u < v)
    weights       (E,)  float32 A* terrain-weighted cost of the edge
    components    (N,)  int32   free-space component id (unfiltered labels)
    edge_kinds    (E,)  uint8   0 base, 1 passage, 2 transition
    edge_passage  (E,)  int32   owning passage ordinal (passage/transition) or -1
    passage_node_start (P,) int32  first node index of each passage (>= base_node_count)
    passage_node_count (P,) int32  node count of each passage (>= 1)
    passage_node_points (N-base_node_count,2) float64  original centreline points
                                      (NPZ/debug metadata; not duplicated in .bin)
    base_node_count     int32   count of base nodes; passage nodes follow
    passage_revision    str     canonical passage/mask revision (see passage_revision)
    region_revision     str     canonical polygon/mask revision (empty without polygon)
    min_cost_per_px    float32  cheapest per-pixel step cost = 255 - max value
    mask_shape    (2,)  int32   (height, width) of the full-res mask
    version             int32   NAVGRAPH_VERSION
    coarse_scale        int32   sampling grid downsample factor (== SAMPLE_DS)
    coarse_origin (2,)  int32   full-res (x,y) origin of cropped coarse grids
    coarse_minval (h,w) uint8   ÷SAMPLE_DS block-min terrain value (passability)
    coarse_maxval (h,w) uint8   ÷SAMPLE_DS block-max terrain value
    coarse_clear  (h,w) uint8   ÷SAMPLE_DS block-max clearance (px, capped 255)
    coarse_labels (h,w) uint8   dominant-component eligibility (1 = eligible)
    hitzone_scale       int32   hit-zone grid downsample factor (== HITZONE_DS)
    coarse_hitzone(hh,hw)uint8  ÷HITZONE_DS endpoint hit zone (1 = sampleable)
    stats               object  per-map dict (json-serializable)

``.navgraph.bin`` byte layout (all little-endian, tightly packed, no padding):

    offset  type            field
    0       char[4]         magic "NVG1"
    4       uint32          version  (== 6)
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
    52      uint32          base_node_count
    56      uint32          P  (passage count)
    60      uint32          passage_rev_len (UTF-8 byte length)
    64      int32           coarse_origin_x (full-res px)
    68      int32           coarse_origin_y (full-res px)
    72      uint32          region_rev_len
    76      uint32          flags (bit0 coord32, bit1 index32)
    80      char[passage_rev_len] passage_revision (ASCII)
    ...     char[region_rev_len]  region_revision (ASCII; empty without polygon)
    ...     uint16/uint32[N*2] nodes
    ...     uint16/uint32[E*2] edges
    ...     float32[E] weights
    ...     uint8[E] edge kinds
    ...     int32[E] edge passage ordinals
    ...     uint16/uint32[P] passage node starts
    ...     uint16/uint32[P] passage node counts
    ...     uint8[ceil(ch*cw/8)] endpoint-sampleable cell bitset
    ...     uint8[ceil(hh*hw/8)] polygon hitzone bitset

The header counts, dimensions, and flags determine the exact payload length, so
every reader rejects truncated or overlong artifacts.

Legacy v2-v5 artifacts remain readable for diagnostics and migration, but only
v6 passes the production serving gate.
"""

import heapq
import hashlib
import json
import math
import os
import struct
import time

import numpy as np
import scipy.ndimage as ndi

try:
    from skimage.graph import MCP_Geometric as _sk_mcp_geometric
    from skimage.morphology import skeletonize as _sk_skeletonize
    from skimage.measure import (
        approximate_polygon as _sk_approximate_polygon,
        find_contours as _sk_find_contours,
    )
    _HAVE_SKIMAGE = True
except Exception:  # pragma: no cover - dependency guard
    _HAVE_SKIMAGE = False


# v6: compact served graph + endpoint/polygon bitsets. Older artifact versions
# are not read; they fail the currency gate and trigger a rebuild.
NAVGRAPH_VERSION = 6
NAVGRAPH_MAGIC = b"NVG1"

# Cap on the serialized passage-revision string (bounds check for every reader).
NAVGRAPH_REVISION_MAX_LEN = 256


class NavgraphBuildCancelled(RuntimeError):
    """Raised when the owner reports that this build token was superseded."""


class PassageConnectorError(ValueError):
    """A numbered passage endpoint could not reach the nearby base graph.

    ``passage_id`` remains available for stable machine lookup, while the
    exception text uses the same one-based order shown in the editor sidebar.
    """

    def __init__(self, passage_id, endpoint, passage_number=None):
        self.passage_id = str(passage_id)
        self.endpoint = str(endpoint)
        self.passage_number = (
            int(passage_number) if passage_number is not None else None)
        passage_label = (
            f"Passage {self.passage_number}"
            if self.passage_number is not None
            else "A passage"
        )
        super().__init__(
            f"{passage_label} {self.endpoint} endpoint has no legal base connector")

# Typed edge kinds (mirror navgraph_router.js EDGE_KIND_*).
EDGE_KIND_BASE = 0
EDGE_KIND_PASSAGE = 1
EDGE_KIND_TRANSITION = 2

# --- Passage topology (CR 8.2) ----------------------------------------------
# Passage bodies remove their projected longitudinal base topology.  Retained
# or newly-created base crossings must be clearly transverse to the *local*
# centreline tangent; ambiguous angles are rejected conservatively.
PASSAGE_PORTAL_DEPTH = 3.0
PASSAGE_FAST_VALUE = 241
PASSAGE_MAX_RASTER_CELLS = 1_048_576
PASSAGE_MAX_TOTAL_RASTER_CELLS = 2_097_152
PASSAGE_MAX_RASTER_WORK = 16_777_216
PASSAGE_MAX_TOTAL_RASTER_WORK = 33_554_432
PASSAGE_BYPASS_RADIUS_PX = 350
PASSAGE_TRANSVERSE_MAX_DOT = 0.50
PASSAGE_LONGITUDINAL_MIN_DOT = math.cos(math.radians(45.0))
PASSAGE_BYPASS_MAX_PER_PASSAGE = 64
PASSAGE_BYPASS_NEIGHBORS_PER_NODE = 12
PASSAGE_CONNECTOR_RADIUS_PX = 192
PASSAGE_CONNECTOR_MAX_PER_ENDPOINT = 10
PASSAGE_CONNECTOR_GRID_MARGIN_MIN_PX = 48
PASSAGE_CONNECTOR_GRID_MARGIN_MAX_PX = 160
PASSAGE_GEOMETRY_EPSILON = 1e-9

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
RESAMPLE_SPACING_PX = 36     # denser skeleton sampling for closer pixel-oracle parity
# Obstacle-biased sampling.  The skeleton guarantees broad connectivity, while
# these nodes give the graph enough local choices around walls/buildings and in
# narrow gates.  Open space stays deliberately sparse; otherwise most of the
# artifact budget is spent where a straight crossing already works well.
OBSTACLE_CLEARANCE_PX = 16   # dense sampling at/below this distance from a wall
BOTTLENECK_SPACING_PX = 12   # extra low-clearance skeleton anchors
CONTOUR_SIMPLIFY_PX = 8      # ignore smaller boundary wiggles/noise
CONTOUR_MIN_LENGTH_PX = 32   # ignore tiny isolated obstacle specks
CONTOUR_CORNER_ANGLE_DEG = 45  # minimum direction change worth a feature node
CONTOUR_NODE_OFFSET_PX = 2   # stay close to the same obstacle side
CONTOUR_SAMPLE_SPACING_PX = 18  # arc-length samples, never a global XY grid
CONTOUR_SEGMENT_ANCHOR_MIN_PX = 16  # shorter simplified runs are noise/covered by ends
CONTOUR_AREA_SPACING_PX = 24  # LOS-aware thinning radius along one contour run
CONTOUR_TINY_AREA_PX = 256  # compact isolated obstacles need no local roadmap
CONTOUR_TINY_SPAN_PX = 20   # long/thin walls are never classified as tiny
CONTOUR_TARGET_PX = 20_000_000  # ds=1 normally; at most a light ds=2 on huge maps
CONTOUR_MAX_DS = 2
NARROW_CENTERLINE_MERGE_PX = 12  # conservative: connectivity beats extra nodes
NARROW_CENTERLINE_SAMPLE_PX = 6  # sample between sparse skeleton endpoints
# NARROW_ALLEY_REDUCTION: set this single flag to False to restore the previous
# contour/bottleneck retention and ordinary k-NN behaviour in narrow alleys.
NARROW_ALLEY_REDUCTION_ENABLED = True
NARROW_BACKBONE_CLEARANCE_PX = 8  # only the tightest alleys become backbone-only
NODE_DEDUPE_PX = 4           # retain the denser local roadmap while merging near duplicates
NODE_DEDUPE_TERRAIN_DELTA = 16  # never merge a path node into nearby slow terrain
NEAR_OBSTACLE_CLEARANCE_PX = 80  # denser lattice up to this clearance from obstacles
LATTICE_SPACING_NEAR_PX = 24  # transition band between boundary and open space
LATTICE_SPACING_FAR_PX = 48   # plaza/interior open-space lattice spacing

# --- Edges -------------------------------------------------------------------
EDGE_NEIGHBOR_SCAN_K = 32    # all of these bounded geometric neighbours are evaluated
EDGE_MAX_DIST = 192          # full-res px; covers sparse openings without global all-pairs
# A blocked straight segment can still represent a useful local graph edge: the
# browser legalises every blocked graph segment with full-res A* before Theta*.
# Admit only tiny interruptions and only a couple per node, then require the
# builder's bounded A* to prove a short detour. This recovers links around a
# one-pixel wall/building tip without creating abstract edges around whole blocks.
EDGE_LOCAL_DETOUR_KNN = 2
EDGE_LOCAL_BLOCKED_SAMPLES_MAX = 8
EDGE_LOCAL_DETOUR_MARGIN = 24
EDGE_LOCAL_DETOUR_RATIO = 1.35
EDGE_LOCAL_DETOUR_MAX_EXTRA_PX = 24
# NARROW_ALLEY_REDUCTION: narrow skeleton nodes used to receive no generic
# candidates at all. A small reversible budget preserves the clean centerline
# while preventing a missed skeleton link from forcing a large detour.
EDGE_NARROW_KNN = 3
EDGE_NARROW_DETOUR_KNN = 1
EDGE_NARROW_MAX_DIST = 96
# Final typed-graph sparsifier. An edge is removed only when an active two-edge
# witness is already within 1% of its terrain-weighted cost. Processing longer
# edges first and mutating the active graph prevents two removed edges from
# serving as each other's witness.
EDGE_SPANNER_STRETCH = 1.01
EDGE_MARGIN = 12             # px; subgrid margin around a k-NN edge bbox for A*
EDGE_DETOUR_RATIO = 3.0      # drop a k-NN edge whose A* path is > this * straight
# Skeleton backbone edges are known corridor connections: give their A* fallback
# a larger search box and looser detour tolerance so genuine thin/winding
# corridors (produced by the block-downsampled skeleton) are not dropped —
# dropping them would fragment the graph.
EDGE_SKELETON_MARGIN = 40    # px; subgrid margin for skeleton backbone A*
EDGE_SKELETON_DETOUR = 6.0   # detour tolerance for skeleton backbone A*

# --- Redundancy pruning ------------------------------------------------------
# Only non-topological open-lattice nodes are considered. A node is removable
# when every route through it already has a short local witness path that avoids
# it. No shortcut edge is invented, so client geometry remains honest.
PRUNE_WITNESS_STRETCH = 1.01
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
ENDPOINT_CLEARANCE_MIN_PX = 12
ENDPOINT_TERRAIN_MIN_VALUE = 200


# =============================================================================
# Passage document normalization + canonical revision
# =============================================================================
#
# The revision string is the durable identity of the passage topology baked into
# an artifact. It MUST be byte-for-byte reproducible on the client, so this code
# mirrors ``canonicalPassageJson`` / ``passageRevision`` in
# ``project/static/project/js/pathing/navgraph_passage_overlay.js`` exactly:
# the same field order, the same ECMAScript number formatting, a codepoint sort
# by passage id (deterministic across engines, unlike ``localeCompare``), and the
# same two 32-bit FNV-1a passes. Change the two together or readiness breaks.


def _passage_items(level_passages):
    """Return the passage item list from a document, list, or ``None``.

    Mirrors the JS ``itemsFrom``: a ``{version: 1, items: [...]}`` document or a
    bare list yields its items; anything else (``None``, unknown version) is no
    passages.
    """
    if isinstance(level_passages, list):
        return level_passages
    if (isinstance(level_passages, dict)
            and level_passages.get("version") == 1
            and isinstance(level_passages.get("items"), list)):
        return level_passages["items"]
    return []


def _ecma_number(value):
    """Format a finite number the way ECMAScript ``Number`` -> ``String`` does.

    Integers print without a fractional part (``24.0`` -> ``"24"``); other finite
    values use Python's shortest round-trip ``repr``, which matches V8 for the
    decimal mask-pixel coordinates and widths this contract carries. Non-finite
    input serializes as JSON ``null`` (matching ``JSON.stringify(NaN)``).
    """
    try:
        f = float(value)
    except (TypeError, ValueError):
        return "null"
    if not math.isfinite(f):
        return "null"
    if f == int(f) and abs(f) < 1e21:
        return str(int(f))
    return repr(f)


def _canonical_passage_json(level_passages, map_width, map_height):
    """Canonical JSON string for a passage document + mask dimensions.

    Byte-identical to the JS ``canonicalPassageJson`` so the revision matches on
    both sides. Items are normalized to ``{id, points, width}`` and sorted by
    ``id`` codepoint order.
    """
    items = []
    for item in _passage_items(level_passages):
        item = item if isinstance(item, dict) else {}
        pid = item.get("id")
        pid = pid if isinstance(pid, str) else ""
        raw_points = item.get("points")
        points = []
        if isinstance(raw_points, list):
            for point in raw_points:
                px = point[0] if isinstance(point, (list, tuple)) and len(point) > 0 else None
                py = point[1] if isinstance(point, (list, tuple)) and len(point) > 1 else None
                points.append((_ecma_number(px), _ecma_number(py)))
        items.append((pid, points, _ecma_number(item.get("width"))))
    items.sort(key=lambda it: [ord(c) for c in it[0]])

    parts = [
        '{"version":1,"mapWidth":', _ecma_number(map_width),
        ',"mapHeight":', _ecma_number(map_height), ',"items":[',
    ]
    for i, (pid, points, width) in enumerate(items):
        if i:
            parts.append(",")
        parts.append('{"id":')
        parts.append(json.dumps(pid))
        parts.append(',"points":[')
        for j, (px, py) in enumerate(points):
            if j:
                parts.append(",")
            parts.append("[")
            parts.append(px)
            parts.append(",")
            parts.append(py)
            parts.append("]")
        parts.append('],"width":')
        parts.append(width)
        parts.append("}")
    parts.append("]}")
    return "".join(parts)


def _fnv1a32(text, seed):
    """32-bit FNV-1a over the (ASCII) canonical string, matching the JS hash32."""
    h = seed & 0xFFFFFFFF
    for ch in text:
        h ^= ord(ch) & 0xFFFFFFFF
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")


def passage_revision(level_passages, map_width, map_height):
    """Deterministic revision string for a passage document + mask dimensions.

    Reproduces ``passageRevision`` in ``navgraph_passage_overlay.js`` exactly, so
    a client can compare the artifact's baked revision against the revision of the
    ``File.level_passages`` it fetched and reject a stale build.
    """
    canonical = _canonical_passage_json(level_passages, map_width, map_height)
    return f"p1-{_fnv1a32(canonical, 0x811c9dc5)}{_fnv1a32(canonical, 0x9e3779b9)}"


def region_revision(region_polygon, map_width, map_height):
    """Return a deterministic identity for a coach polygon + mask dimensions.

    The revision is stored beside the human-readable polygon in artifact stats;
    orchestration uses it for cheap stale-artifact checks and build-race guards.
    Empty/legacy builds intentionally return ``None``.
    """
    if not isinstance(region_polygon, (list, tuple)) or len(region_polygon) < 3:
        return None
    try:
        points = clip_region_polygon(region_polygon, map_width, map_height)
    except (TypeError, ValueError, OverflowError):
        return None
    canonical = json.dumps(
        {"version": 1, "width": int(map_width), "height": int(map_height),
         "points": points},
        separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")
    return "r1-" + hashlib.sha256(canonical).hexdigest()[:32]


def clip_region_polygon(polygon, map_width, map_height):
    """Clamp coach-region vertices to the inclusive mask-pixel bounds.

    The editor works in scaled display coordinates and can produce a small
    overshoot when a vertex is dragged onto the image edge.  A polygon whose
    vertices are just outside the raster is still an otherwise valid region,
    so keep it usable by clamping each coordinate instead of rejecting the
    whole build.  Structural checks (distinct points and non-zero area) remain
    in ``_rasterize_region_full``.
    """
    if not isinstance(polygon, (list, tuple)) or len(polygon) < 3:
        raise ValueError("A coach region polygon needs at least 3 points")

    max_x = max(0, int(map_width) - 1)
    max_y = max(0, int(map_height) - 1)
    clipped = []
    for point in polygon:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise ValueError("Invalid coach region point")
        try:
            x, y = float(point[0]), float(point[1])
        except (TypeError, ValueError) as exc:
            raise ValueError("Invalid coach region point") from exc
        if not (math.isfinite(x) and math.isfinite(y)):
            raise ValueError("Coach region coordinates must be finite")
        clipped.append([
            int(round(min(max(0.0, x), float(max_x)))),
            int(round(min(max(0.0, y), float(max_y)))),
        ])
    return clipped


def mask_dimensions(mask_path):
    """Return ``(width, height)`` of a mask PNG without decoding its pixels."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    with Image.open(mask_path) as img:
        return int(img.width), int(img.height)


def read_bin_header(bin_path):
    """Cheaply read a v6 ``.navgraph.bin`` header without loading its arrays.

    Returns version, dimensions, passage revision, and the polygon-region
    revision, or ``None`` when the file is missing, truncated, has a bad magic,
    an unsupported (legacy) version, or an out-of-range revision length.
    Reading only the fixed header keeps the request/serving path off numpy.
    """
    try:
        with open(bin_path, "rb") as f:
            head = f.read(80)
            if len(head) < 80 or head[:4] != NAVGRAPH_MAGIC:
                return None
            (version,) = struct.unpack_from("<I", head, 4)
            if version != NAVGRAPH_VERSION:
                return None
            height, width = struct.unpack_from("<ii", head, 8)
            (passage_rev_len,) = struct.unpack_from("<I", head, 60)
            (region_rev_len,) = struct.unpack_from("<I", head, 72)
            if (passage_rev_len > NAVGRAPH_REVISION_MAX_LEN
                    or region_rev_len > NAVGRAPH_REVISION_MAX_LEN):
                return None
            passage_rev_bytes = f.read(passage_rev_len)
            region_rev_bytes = f.read(region_rev_len)
        if (len(passage_rev_bytes) != passage_rev_len
                or len(region_rev_bytes) != region_rev_len):
            return None
        return {"version": version, "height": height, "width": width,
                "passage_revision": passage_rev_bytes.decode("ascii"),
                "region_revision": region_rev_bytes.decode("ascii")}
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def artifact_matches_passage_document(bin_path, level_passages,
                                      map_width, map_height):
    """True when the on-disk artifact is current for a passage document.

    A current artifact must carry the exact baked ``passage_revision`` for the
    normalized document + mask dimensions.  Any corruption, legacy version, or
    invalid document is treated as a non-match so a stale/broken artifact is
    never served.
    """
    header = read_bin_header(bin_path)
    if header is None:
        return False
    try:
        from .services.passage_validation import normalize_level_passages
        document = normalize_level_passages(level_passages)
    except Exception:
        return False
    return header["passage_revision"] == passage_revision(
        document, map_width, map_height)


def _point_segment_projection(px, py, ax, ay, bx, by):
    """Return ``(distance_squared, t, nearest_x, nearest_y)`` for a segment."""
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 <= PASSAGE_GEOMETRY_EPSILON:
        return (px - ax) ** 2 + (py - ay) ** 2, 0.0, ax, ay
    t = ((px - ax) * dx + (py - ay) * dy) / length2
    t = min(1.0, max(0.0, t))
    nx, ny = ax + t * dx, ay + t * dy
    return (px - nx) ** 2 + (py - ny) ** 2, t, nx, ny


def _orientation(a, b, c):
    return ((b[0] - a[0]) * (c[1] - a[1])
            - (b[1] - a[1]) * (c[0] - a[0]))


def _on_segment(a, b, p):
    eps = PASSAGE_GEOMETRY_EPSILON
    return (min(a[0], b[0]) - eps <= p[0] <= max(a[0], b[0]) + eps
            and min(a[1], b[1]) - eps <= p[1] <= max(a[1], b[1]) + eps)


def _segments_intersect(a, b, c, d):
    eps = PASSAGE_GEOMETRY_EPSILON
    ab_c, ab_d = _orientation(a, b, c), _orientation(a, b, d)
    cd_a, cd_b = _orientation(c, d, a), _orientation(c, d, b)
    if (((ab_c > eps and ab_d < -eps) or (ab_c < -eps and ab_d > eps))
            and ((cd_a > eps and cd_b < -eps) or (cd_a < -eps and cd_b > eps))):
        return True
    return ((abs(ab_c) <= eps and _on_segment(a, b, c))
            or (abs(ab_d) <= eps and _on_segment(a, b, d))
            or (abs(cd_a) <= eps and _on_segment(c, d, a))
            or (abs(cd_b) <= eps and _on_segment(c, d, b)))


def _segment_distance_squared(a, b, c, d):
    if _segments_intersect(a, b, c, d):
        return 0.0
    return min(
        _point_segment_projection(a[0], a[1], c[0], c[1], d[0], d[1])[0],
        _point_segment_projection(b[0], b[1], c[0], c[1], d[0], d[1])[0],
        _point_segment_projection(c[0], c[1], a[0], a[1], b[0], b[1])[0],
        _point_segment_projection(d[0], d[1], a[0], a[1], b[0], b[1])[0],
    )


def _has_self_overlapping_corridor(points, width):
    """Python parity for ``passage_geometry.js`` self-overlap rejection."""
    cumulative = [0.0]
    for a, b in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    threshold2 = width * width + PASSAGE_GEOMETRY_EPSILON
    for first in range(1, len(points)):
        for second in range(first + 2, len(points)):
            if cumulative[second - 1] - cumulative[first] <= width + PASSAGE_GEOMETRY_EPSILON:
                continue
            if _segment_distance_squared(
                    points[first - 1], points[first],
                    points[second - 1], points[second]) <= threshold2:
                return True
    return False


def _passage_terminal_frames(points):
    start, end = points[0], points[-1]
    sdx, sdy = points[1][0] - start[0], points[1][1] - start[1]
    edx, edy = points[-2][0] - end[0], points[-2][1] - end[1]
    sl, el = math.hypot(sdx, sdy), math.hypot(edx, edy)
    if sl <= PASSAGE_GEOMETRY_EPSILON or el <= PASSAGE_GEOMETRY_EPSILON:
        raise ValueError("passage has a zero-length terminal segment")
    start_inward = (sdx / sl, sdy / sl)
    end_inward = (edx / el, edy / el)
    return {
        "start": start,
        "end": end,
        "start_inward": start_inward,
        "end_inward": end_inward,
        "start_outer": (start[0] - start_inward[0] * PASSAGE_PORTAL_DEPTH,
                        start[1] - start_inward[1] * PASSAGE_PORTAL_DEPTH),
        "end_outer": (end[0] - end_inward[0] * PASSAGE_PORTAL_DEPTH,
                      end[1] - end_inward[1] * PASSAGE_PORTAL_DEPTH),
    }


def _normalize_passages_for_build(level_passages, map_width, map_height):
    """Validate the whole document and derive the small analytic build geometry.

    Structural validation is owned by ``services.passage_validation``. This second
    layer intentionally mirrors only runtime geometry needed by the builder:
    consecutive-point normalization, flat terminal caps, round interior joins,
    self-overlap and the existing raster complexity budgets.
    """
    from .services.passage_validation import normalize_level_passages

    document = normalize_level_passages(level_passages)
    passages = []
    total_cells = total_work = 0
    for item in sorted(document["items"], key=lambda value: value["id"]):
        points = []
        for raw in item["points"]:
            point = (float(raw[0]), float(raw[1]))
            if not points or point != points[-1]:
                points.append(point)
        if len(points) < 2:
            raise ValueError(f"passage {item['id']} has fewer than two distinct consecutive points")
        for point_index, (x, y) in enumerate(points):
            if not (math.isfinite(x) and math.isfinite(y)
                    and 0 <= x < map_width and 0 <= y < map_height):
                raise ValueError(
                    f"passage {item['id']} point {point_index} is outside "
                    f"the {map_width}x{map_height} mask")
        width = float(item["width"])
        if _has_self_overlapping_corridor(points, width):
            raise ValueError(f"passage {item['id']} has a self-overlapping corridor")
        frames = _passage_terminal_frames(points)
        radius = width / 2.0
        extent_points = points + [frames["start_outer"], frames["end_outer"]]
        min_x = max(0, math.floor(min(p[0] for p in extent_points) - radius) - 1)
        min_y = max(0, math.floor(min(p[1] for p in extent_points) - radius) - 1)
        max_x = min(map_width - 1, math.ceil(max(p[0] for p in extent_points) + radius) + 1)
        max_y = min(map_height - 1, math.ceil(max(p[1] for p in extent_points) + radius) + 1)
        cells = max(0, max_x - min_x + 1) * max(0, max_y - min_y + 1)
        work = 0
        last = len(points) - 1
        for segment in range(1, len(points)):
            a = frames["start_outer"] if segment == 1 else points[segment - 1]
            b = frames["end_outer"] if segment == last else points[segment]
            from_x = max(min_x, math.floor(min(a[0], b[0]) - radius))
            from_y = max(min_y, math.floor(min(a[1], b[1]) - radius))
            to_x = min(max_x, math.ceil(max(a[0], b[0]) + radius))
            to_y = min(max_y, math.ceil(max(a[1], b[1]) + radius))
            work += max(0, to_x - from_x + 1) * max(0, to_y - from_y + 1)
        if cells > PASSAGE_MAX_RASTER_CELLS:
            raise ValueError(f"passage {item['id']} exceeds the raster cell budget")
        if work > PASSAGE_MAX_RASTER_WORK:
            raise ValueError(f"passage {item['id']} exceeds the raster work budget")
        total_cells += cells
        total_work += work
        passages.append({
            "id": item["id"], "points": points, "width": width,
            "radius": radius, "frames": frames,
            "bounds": (min_x, min_y, max_x, max_y),
            "body_bounds": (
                min(p[0] for p in points) - radius,
                min(p[1] for p in points) - radius,
                max(p[0] for p in points) + radius,
                max(p[1] for p in points) + radius,
            ),
            "raster_cells": cells, "raster_work": work,
        })
    if total_cells > PASSAGE_MAX_TOTAL_RASTER_CELLS:
        raise ValueError("passage document exceeds the aggregate raster cell budget")
    if total_work > PASSAGE_MAX_TOTAL_RASTER_WORK:
        raise ValueError("passage document exceeds the aggregate raster work budget")
    return document, passages


def _nearest_passage_segment(passage, x, y):
    best = None
    for index, (a, b) in enumerate(zip(passage["points"], passage["points"][1:])):
        distance2, t, nx, ny = _point_segment_projection(x, y, *a, *b)
        if best is None or distance2 < best[0]:
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            best = (distance2, index, t, nx, ny,
                    (b[0] - a[0]) / length, (b[1] - a[1]) / length)
    return best


def _passage_body_hits(passage, x, y):
    """Return centreline segments whose flat-capped stroke contains a point.

    Only the outward end of the first/last segment is flat-clipped.  Applying
    terminal half-planes to the complete polyline would incorrectly erase a
    later arm of a bent passage that happens to curl behind an endpoint plane.
    Interior segment ends remain round and therefore form rounded joins.
    """
    min_x, min_y, max_x, max_y = passage["body_bounds"]
    if x < min_x or x > max_x or y < min_y or y > max_y:
        return []
    hits = []
    segments = list(zip(passage["points"], passage["points"][1:]))
    for index, (a, b) in enumerate(segments):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length2 = dx * dx + dy * dy
        raw_t = ((x - a[0]) * dx + (y - a[1]) * dy) / length2
        if index == 0 and raw_t < -PASSAGE_GEOMETRY_EPSILON:
            continue
        if index == len(segments) - 1 and raw_t > 1 + PASSAGE_GEOMETRY_EPSILON:
            continue
        distance2, t, nx, ny = _point_segment_projection(x, y, *a, *b)
        if distance2 <= passage["radius"] ** 2 + PASSAGE_GEOMETRY_EPSILON:
            length = math.sqrt(length2)
            hits.append((distance2, index, t, nx, ny, dx / length, dy / length))
    return hits


def _point_in_passage_body(passage, x, y):
    return bool(_passage_body_hits(passage, x, y))


def _point_in_passage_entrance(passage, x, y):
    """True only inside one of the two terminal entrance caps.

    Separate passages may overlap at an entrance while remaining distinct
    surfaces. Their transition connectors may share that initial cap contact,
    then must leave the other passage body without re-entering it.
    """
    if not _point_in_passage_body(passage, x, y):
        return False
    radius2 = passage["radius"] ** 2 + PASSAGE_GEOMETRY_EPSILON
    return any(
        (x - endpoint[0]) ** 2 + (y - endpoint[1]) ** 2 <= radius2
        for endpoint in (
            passage["frames"]["start"],
            passage["frames"]["end"],
        )
    )


def _point_in_polygon(x, y, polygon):
    """Boundary-inclusive even/odd point-in-polygon test."""
    if polygon is None:
        return True
    point = (float(x), float(y))
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        a, b = polygon[j], polygon[i]
        if abs(_orientation(a, b, point)) <= PASSAGE_GEOMETRY_EPSILON and _on_segment(a, b, point):
            return True
        if ((a[1] > y) != (b[1] > y)):
            cross_x = (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]
            if x < cross_x:
                inside = not inside
        j = i
    return inside


def _segment_in_polygon(a, b, polygon):
    if polygon is None:
        return True
    if not (_point_in_polygon(a[0], a[1], polygon)
            and _point_in_polygon(b[0], b[1], polygon)):
        return False
    # Split the segment at every proper polygon-boundary intersection, then
    # test one midpoint per interval.  This catches arbitrarily small concave
    # excursions without relying on a pixel-size sampling interval.
    dx, dy = b[0] - a[0], b[1] - a[1]
    cuts = [0.0, 1.0]
    vertices = list(polygon)
    for c, d in zip(vertices, vertices[1:] + vertices[:1]):
        ex, ey = d[0] - c[0], d[1] - c[1]
        denominator = dx * ey - dy * ex
        if abs(denominator) <= PASSAGE_GEOMETRY_EPSILON:
            continue
        acx, acy = c[0] - a[0], c[1] - a[1]
        t = (acx * ey - acy * ex) / denominator
        u = (acx * dy - acy * dx) / denominator
        if (-PASSAGE_GEOMETRY_EPSILON <= t <= 1 + PASSAGE_GEOMETRY_EPSILON
                and -PASSAGE_GEOMETRY_EPSILON <= u <= 1 + PASSAGE_GEOMETRY_EPSILON):
            cuts.append(min(1.0, max(0.0, t)))
    cuts = sorted(set(round(value, 14) for value in cuts))
    return all(_point_in_polygon(
        a[0] + dx * ((left + right) / 2),
        a[1] + dy * ((left + right) / 2), polygon)
        for left, right in zip(cuts, cuts[1:]) if right - left > 1e-13)


def _edge_passage_relation(a, b, passage):
    """Classify an edge against one footprint using its local crossing tangent.

    Returns ``None`` when disjoint, otherwise ``(is_transverse, is_longitudinal,
    dot, side_a, side_b)``.  The nearest centreline segment is selected where
    the edge meets the footprint, which is important for bent passages.
    """
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    if length <= PASSAGE_GEOMETRY_EPSILON:
        return None
    min_x, min_y, max_x, max_y = passage["body_bounds"]
    if (max(a[0], b[0]) < min_x or min(a[0], b[0]) > max_x
            or max(a[1], b[1]) < min_y or min(a[1], b[1]) > max_y):
        return None
    samples = max(1, int(math.ceil(length)))
    hits_by_segment = {}
    for k in range(samples + 1):
        t = k / samples
        x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
        for hit in _passage_body_hits(passage, x, y):
            previous = hits_by_segment.get(hit[1])
            if previous is None or hit[0] < previous[0]:
                hits_by_segment[hit[1]] = hit
    if not hits_by_segment:
        return None
    ex, ey = (b[0] - a[0]) / length, (b[1] - a[1]) / length
    relations = []
    for hit in hits_by_segment.values():
        tx, ty = hit[5], hit[6]
        dot = abs(ex * tx + ey * ty)
        cx, cy = hit[3], hit[4]
        side_a = tx * (a[1] - cy) - ty * (a[0] - cx)
        side_b = tx * (b[1] - cy) - ty * (b[0] - cx)
        opposite = side_a * side_b < -PASSAGE_GEOMETRY_EPSILON
        relations.append((opposite and dot <= PASSAGE_TRANSVERSE_MAX_DOT,
                          dot >= PASSAGE_LONGITUDINAL_MIN_DOT, dot, side_a, side_b))
    return (all(value[0] for value in relations),
            any(value[1] for value in relations),
            max(value[2] for value in relations),
            relations[0][3], relations[0][4])


def _segment_enters_passage_body(a, b, passage, allow_start_contact=False):
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    steps = max(1, int(math.ceil(length)))
    left_initial_contact = not allow_start_contact
    for k in range(steps + 1):
        inside = _point_in_passage_body(
            passage,
            a[0] + (b[0] - a[0]) * k / steps,
            a[1] + (b[1] - a[1]) * k / steps,
        )
        if not left_initial_contact:
            if inside:
                continue
            left_initial_contact = True
            continue
        if inside:
            return True
    return False


def _round_graph_coordinate(value):
    """Round non-negative mask coordinates like ECMAScript ``Math.round``."""
    return int(math.floor(float(value) + 0.5))


def _passage_endpoint_graph_coordinate(mask, passage, endpoint,
                                       region_polygon=None):
    """Choose a deterministic legal raster representative for an endpoint.

    Persisted passage coordinates are continuous, but graph nodes are integer
    mask pixels. Normal rounding can select an impassable pixel even when the
    endpoint's existing outward portal band reaches legal base terrain. Search
    only that bounded cap (portal depth longitudinally, passage radius
    laterally), and only accept a fallback inside the inclusion polygon. This
    resolves raster-boundary ambiguity without moving persisted geometry or
    snapping an entrance across a genuine obstacle.
    """
    height, width = mask.shape
    rounded = (_round_graph_coordinate(endpoint[0]),
               _round_graph_coordinate(endpoint[1]))
    rx = min(width - 1, max(0, rounded[0]))
    ry = min(height - 1, max(0, rounded[1]))
    rounded = (rx, ry)
    if mask[ry, rx] != IMPASSABLE:
        return rounded

    search_radius = passage["radius"]
    xs = range(
        max(0, math.floor(endpoint[0] - search_radius)),
        min(width - 1, math.ceil(endpoint[0] + search_radius)) + 1,
    )
    ys = range(
        max(0, math.floor(endpoint[1] - search_radius)),
        min(height - 1, math.ceil(endpoint[1] + search_radius)) + 1,
    )
    inward = (passage["frames"]["start_inward"]
              if endpoint == passage["frames"]["start"]
              else passage["frames"]["end_inward"])
    candidates = []
    for x in xs:
        for y in ys:
            x, y = int(x), int(y)
            if mask[y, x] == IMPASSABLE:
                continue
            if not _point_in_polygon(x, y, region_polygon):
                continue
            displacement2 = ((x - endpoint[0]) ** 2
                             + (y - endpoint[1]) ** 2)
            if displacement2 > passage["radius"] ** 2 + PASSAGE_GEOMETRY_EPSILON:
                continue
            longitudinal = ((x - endpoint[0]) * inward[0]
                            + (y - endpoint[1]) * inward[1])
            if (longitudinal > PASSAGE_GEOMETRY_EPSILON
                    or longitudinal < -PASSAGE_PORTAL_DEPTH - PASSAGE_GEOMETRY_EPSILON):
                continue
            candidates.append((displacement2, y, x))
    if not candidates:
        return rounded
    _, y, x = min(candidates)
    return (x, y)


def filter_level_passages_for_region(level_passages, region_polygon,
                                     map_width, map_height):
    """Return the canonical passages wholly usable by one Infinity region.

    Passage documents belong to the map and may legitimately contain corridors
    for other game modes outside a smaller Infinity inclusion polygon. Such a
    corridor is omitted as one object; it must not abort the navgraph build or
    contribute shadow nodes/connectors. The same helper is used by building,
    serving, and the worker payload so artifact ordinals/revisions stay aligned.

    Containment mirrors the serialized topology checks: original and rounded
    centreline points and every consecutive segment must remain in the polygon.
    The persisted document itself is never modified.
    """
    from .services.passage_validation import normalize_level_passages

    document = normalize_level_passages(level_passages)
    if not isinstance(region_polygon, (list, tuple)) or len(region_polygon) < 3:
        return document, []
    region_polygon = clip_region_polygon(region_polygon, map_width, map_height)

    included = []
    ignored_ids = []
    for item in document["items"]:
        points = [(float(point[0]), float(point[1])) for point in item["points"]]
        rounded = [
            (min(map_width - 1, _round_graph_coordinate(x)),
             min(map_height - 1, _round_graph_coordinate(y)))
            for x, y in points
        ]
        contained = (
            all(_point_in_polygon(x, y, region_polygon) for x, y in points)
            and all(_point_in_polygon(x, y, region_polygon) for x, y in rounded)
            and all(_segment_in_polygon(a, b, region_polygon)
                    for a, b in zip(points, points[1:]))
            and all(_segment_in_polygon(a, b, region_polygon)
                    for a, b in zip(rounded, rounded[1:]))
        )
        if contained:
            included.append(item)
        else:
            ignored_ids.append(item["id"])
    return {"version": document["version"], "items": included}, ignored_ids


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


def _rasterize_region_full(polygon, H, W):
    """Validate and rasterize the authoritative coach region at mask resolution.

    This boolean array is the single source of truth for node pruning and
    terrain/edge legality, including at concave polygon boundaries.
    """
    from PIL import Image, ImageDraw

    if polygon is None or len(polygon) < 3:
        raise ValueError("A coach region polygon needs at least 3 points")

    points = [tuple(point) for point in clip_region_polygon(polygon, W, H)]

    if len(set(points)) < 3:
        raise ValueError("Coach region polygon needs 3 distinct points")
    twice_area = abs(sum(
        x0 * y1 - x1 * y0
        for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1])
    ))
    if twice_area <= 1e-6:
        raise ValueError("Coach region polygon must have non-zero area")

    image = Image.new("L", (W, H), 0)
    ImageDraw.Draw(image).polygon(points, fill=1)
    raster = np.asarray(image, dtype=bool)
    if not raster.any():
        raise ValueError("Coach region polygon produced an empty raster")
    return raster


def _rasterize_region(polygon, H, W, ds=HITZONE_DS, full_raster=None):
    """Rasterize a coach-drawn map-region polygon to a coarse ÷ds bool grid.

    ``polygon`` is a sequence of full-res ``(x, y)`` vertices (same coordinate
    space as ``nodes``). Returns an ``(hh, hw)`` bool grid, True inside the
    polygon, matching the hit-zone grid resolution. This is the *authoritative*
    map region when a coach has drawn one; the automatic ``_hitzone`` is only a
    fallback / initial suggestion (see the module note). Vertices are bounded
    to the mask before structural validation by ``_rasterize_region_full``.
    """
    full = (full_raster if full_raster is not None
            else _rasterize_region_full(polygon, H, W))
    hh, hw = max(1, H // ds), max(1, W // ds)
    # A coarse endpoint cell is eligible only when every full-res pixel in the
    # cell is inside the authoritative raster. This conservative reduction is
    # what lets client/Python endpoint stubs use the stored grid as a legality
    # mask without crossing a concave exterior between two legal nodes.
    out = np.zeros((hh, hw), dtype=bool)
    for cy in range(hh):
        y0, y1 = cy * ds, min(H, (cy + 1) * ds)
        for cx in range(hw):
            x0, x1 = cx * ds, min(W, (cx + 1) * ds)
            out[cy, cx] = bool(full[y0:y1, x0:x1].all())
    return out


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
# Full-resolution weighted path search on bounded subgrids
# =============================================================================

def _weighted_subgrid_path(sub, start, goal):
    """Return exact weighted cost and geometric length on a bounded subgrid.

    ``MCP_Geometric`` is the compiled implementation already supplied by the
    required scikit-image dependency. It stops when ``goal`` is settled and
    works directly on the cost raster. The previous implementation rebuilt an
    eight-neighbour sparse graph for every candidate edge and then ran
    Dijkstra over the whole subgrid, although only one target was needed.
    """
    costs = (255 - sub).astype(np.float64)
    costs[sub == IMPASSABLE] = np.inf
    solver = _sk_mcp_geometric(costs, fully_connected=True)
    cumulative, _ = solver.find_costs([start], [goal])
    cost = float(cumulative[goal])
    if not math.isfinite(cost):
        return None
    path = solver.traceback(goal)
    geom = sum(
        math.hypot(y1 - y0, x1 - x0)
        for (y0, x0), (y1, x1) in zip(path, path[1:])
    )
    return cost, geom


def _line_cost(mask, x0, y0, x1, y1):
    """Terrain-weighted cost of the straight segment, or ``None`` if it crosses
    an impassable pixel.

    Samples ~1 px steps and accumulates ``substep_len * (255 - value)`` matching
    the graph's terrain cost model. Because candidate edges are short and
    mostly clear, this is the fast path; selected blocked segments fall back to
    the bounded weighted raster solver.
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


def _line_cost_batch(mask, x0_arr, y0_arr, x1_arr, y1_arr, chunk=4096,
                     return_blocked_counts=False):
    """Vectorized batch version of _line_cost for many segments at once.

    Identical math: steps = max(|dx|, |dy|), sample at round(k * substep)
    for k = 1..steps, accumulate seg_len * (255 - val), blocked if any
    sample == IMPASSABLE. Processes ``chunk`` segments per numpy pass to
    bound peak memory. Returns ``(costs, blocked)`` arrays of shape (N,);
    ``costs[i]`` is 0.0 when ``blocked[i]`` is True. With
    ``return_blocked_counts=True`` a third array reports how many sampled
    impassable pixels each segment crossed, allowing cheap rejection of edges
    through a whole obstacle before bounded A* is attempted.
    """
    N = len(x0_arr)
    if N == 0:
        empty = (np.empty(0, dtype=np.float64), np.empty(0, dtype=bool))
        if return_blocked_counts:
            return empty + (np.empty(0, dtype=np.int32),)
        return empty
    H, W = mask.shape
    x0 = np.asarray(x0_arr, dtype=np.float64)
    y0 = np.asarray(y0_arr, dtype=np.float64)
    x1 = np.asarray(x1_arr, dtype=np.float64)
    y1 = np.asarray(y1_arr, dtype=np.float64)
    costs = np.empty(N, dtype=np.float64)
    blocked = np.empty(N, dtype=bool)
    blocked_counts = np.empty(N, dtype=np.int32) if return_blocked_counts else None

    for start in range(0, N, chunk):
        end = min(start + chunk, N)
        bx0 = x0[start:end]
        by0 = y0[start:end]
        dx = x1[start:end] - bx0
        dy = y1[start:end] - by0
        steps = np.maximum(np.abs(dx), np.abs(dy)).astype(np.int32)
        max_s = int(steps.max()) if steps.size else 0
        if max_s == 0:
            costs[start:end] = 0.0
            blocked[start:end] = False
            if blocked_counts is not None:
                blocked_counts[start:end] = 0
            continue
        safe_s = np.where(steps > 0, steps, 1).astype(np.float64)
        seg_len = np.hypot(dx, dy) / safe_s   # geometric length per substep
        sx = dx / safe_s
        sy = dy / safe_s
        k = np.arange(1, max_s + 1, dtype=np.float64)[None, :]     # (1, max_s)
        valid = k <= steps[:, None].astype(np.float64)               # (n, max_s)
        xi = np.round(bx0[:, None] + sx[:, None] * k).astype(np.int32)
        yi = np.round(by0[:, None] + sy[:, None] * k).astype(np.int32)
        xi = np.clip(xi, 0, W - 1)
        yi = np.clip(yi, 0, H - 1)
        vals = mask[yi, xi].astype(np.int32)
        is_impass = valid & (vals == 0)
        chunk_blocked = is_impass.any(axis=1)
        contrib = np.where(valid & ~is_impass, seg_len[:, None] * (255 - vals), 0.0)
        costs[start:end] = np.where(chunk_blocked, 0.0, contrib.sum(axis=1))
        blocked[start:end] = chunk_blocked
        if blocked_counts is not None:
            blocked_counts[start:end] = is_impass.sum(axis=1, dtype=np.int32)

    if blocked_counts is not None:
        return costs, blocked, blocked_counts
    return costs, blocked


def _filter_contours_near_centerline(
        mask, corners, regular, pairs, centerline_xy,
        radius=NARROW_CENTERLINE_MERGE_PX):
    """Drop boundary samples already represented by a visible narrow spine.

    A contour sample is removed only when a snapped skeleton/bottleneck node is
    close and directly visible on the authoritative mask. The centerline must
    also be at least as fast (mask value >= candidate value): slow outline pixels
    (value 200) may collapse into a fast alley spine, but a fast mapped-path node
    can never be replaced by a slower off-path/vegetation node.
    This cheaply collapses the two redundant wall-side chains in narrow alleys
    to their centerline without doing another A* or affecting wider borders.

    NARROW_ALLEY_REDUCTION: this includes corner/segment anchors deliberately;
    the nearby authoritative skeleton already encodes bends and junctions.
    """
    if (not NARROW_ALLEY_REDUCTION_ENABLED or radius <= 0 or
            not (corners or regular) or not centerline_xy):
        return list(corners), list(regular), list(pairs), 0

    cell = max(1, int(radius))
    radius2 = radius * radius
    buckets = {}
    for x, y in centerline_xy:
        buckets.setdefault((int(x) // cell, int(y) // cell), []).append(
            (int(x), int(y)))

    # Collect every (point, anchor) pair that passes the distance + terrain
    # guard, then evaluate all LOS checks in one vectorized batch.
    all_points = list(corners) + list(regular)
    candidate_pairs = []   # [(point_idx, px, py, ax, ay)]
    for pi, (x, y) in enumerate(all_points):
        bx, by = int(x) // cell, int(y) // cell
        value = int(mask[int(y), int(x)])
        for gx in (bx - 1, bx, bx + 1):
            for gy in (by - 1, by, by + 1):
                for xx, yy in buckets.get((gx, gy), ()):
                    if (x - xx) ** 2 + (y - yy) ** 2 > radius2:
                        continue
                    if int(mask[yy, xx]) < value:
                        continue
                    candidate_pairs.append((pi, int(x), int(y), xx, yy))

    represented: set = set()
    if candidate_pairs:
        x0b = np.array([p[1] for p in candidate_pairs], dtype=np.int32)
        y0b = np.array([p[2] for p in candidate_pairs], dtype=np.int32)
        x1b = np.array([p[3] for p in candidate_pairs], dtype=np.int32)
        y1b = np.array([p[4] for p in candidate_pairs], dtype=np.int32)
        _, los_blocked = _line_cost_batch(mask, x0b, y0b, x1b, y1b)
        for k, (pi, _, _, _, _) in enumerate(candidate_pairs):
            if not los_blocked[k]:
                represented.add(pi)

    nc = len(corners)
    keep_corner_flags = [i not in represented for i in range(nc)]
    keep_regular_flags = [(nc + i) not in represented for i in range(len(regular))]
    kept_corners = [
        xy for xy, keep in zip(corners, keep_corner_flags) if keep]
    kept_regular = [
        xy for xy, keep in zip(regular, keep_regular_flags) if keep]
    removed = (
        len(corners) + len(regular) - len(kept_corners) - len(kept_regular))

    old_to_new = {}
    for old, keep in enumerate(keep_corner_flags):
        if keep:
            old_to_new[old] = len(old_to_new)
    regular_base = len(corners)
    regular_new_base = len(kept_corners)
    regular_kept = 0
    for offset, keep in enumerate(keep_regular_flags):
        if keep:
            old_to_new[regular_base + offset] = regular_new_base + regular_kept
            regular_kept += 1

    kept_pairs = [
        (old_to_new[a], old_to_new[b]) for a, b in pairs
        if a in old_to_new and b in old_to_new and old_to_new[a] != old_to_new[b]
    ]
    return kept_corners, kept_regular, kept_pairs, removed


def _filter_points_near_visible_nodes(mask, points, anchors,
                                      radius=NARROW_CENTERLINE_MERGE_PX):
    """NARROW_ALLEY_REDUCTION: remove duplicate auxiliary centerline points."""
    if (not NARROW_ALLEY_REDUCTION_ENABLED or radius <= 0 or
            not points or not anchors):
        return list(points), 0
    cell = max(1, int(radius))
    radius2 = radius * radius
    buckets = {}
    for x, y in anchors:
        buckets.setdefault((int(x) // cell, int(y) // cell), []).append(
            (int(x), int(y)))

    # Collect all (point, anchor) candidate pairs that pass distance + terrain,
    # then batch-check LOS in one vectorized call.
    candidate_pairs = []   # [(point_idx, px, py, ax, ay)]
    for pi, (x, y) in enumerate(points):
        bx, by = int(x) // cell, int(y) // cell
        value = int(mask[int(y), int(x)])
        for gx in (bx - 1, bx, bx + 1):
            for gy in (by - 1, by, by + 1):
                for xx, yy in buckets.get((gx, gy), ()):
                    if (x - xx) ** 2 + (y - yy) ** 2 > radius2:
                        continue
                    if int(mask[yy, xx]) < value:
                        continue
                    candidate_pairs.append((pi, int(x), int(y), xx, yy))

    if candidate_pairs:
        x0b = np.array([p[1] for p in candidate_pairs], dtype=np.int32)
        y0b = np.array([p[2] for p in candidate_pairs], dtype=np.int32)
        x1b = np.array([p[3] for p in candidate_pairs], dtype=np.int32)
        y1b = np.array([p[4] for p in candidate_pairs], dtype=np.int32)
        _, los_blocked = _line_cost_batch(mask, x0b, y0b, x1b, y1b)
        duplicate_pis = {pi for k, (pi, _, _, _, _) in enumerate(candidate_pairs)
                         if not los_blocked[k]}
    else:
        duplicate_pis: set = set()

    kept = [p for pi, p in enumerate(points) if pi not in duplicate_pis]
    return kept, len(points) - len(kept)


def _visible_backbone_samples(mask, skeleton_xy, skeleton_edges,
                              spacing=NARROW_CENTERLINE_SAMPLE_PX):
    """NARROW_ALLEY_REDUCTION: densify legal straight skeleton segments.

    Skeleton graph nodes are roughly 48 px apart, so endpoint-only proximity
    misses wall samples halfway along an alley.  This produces cheap comparison
    anchors every few pixels. A curved/A*-backed segment may have a chord that
    clips a stair-step wall, so validity is checked per interpolated anchor
    rather than rejecting the whole segment. The later candidate-to-anchor LOS
    check remains authoritative for every node removal.
    """
    out = list(skeleton_xy)
    if not NARROW_ALLEY_REDUCTION_ENABLED or spacing <= 0:
        return out
    for a, b, _ in skeleton_edges:
        if a == b or a >= len(skeleton_xy) or b >= len(skeleton_xy):
            continue
        x0, y0 = skeleton_xy[a]
        x1, y1 = skeleton_xy[b]
        length = float(np.hypot(x1 - x0, y1 - y0))
        pieces = max(1, int(np.ceil(length / spacing)))
        for k in range(1, pieces):
            t = k / pieces
            x = int(round(x0 + (x1 - x0) * t))
            y = int(round(y0 + (y1 - y0) * t))
            if mask[y, x] != IMPASSABLE:
                out.append((x, y))
    return out


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


def _weighted_edge_path(mask, xi, yi, xj, yj, straight, margin=EDGE_MARGIN,
                        detour_ratio=EDGE_DETOUR_RATIO):
    """Solve an edge on its bounded raster; reject absent/excessive detours."""
    H, W = mask.shape
    y0 = max(0, min(yi, yj) - margin)
    y1 = min(H, max(yi, yj) + margin + 1)
    x0 = max(0, min(xi, xj) - margin)
    x1 = min(W, max(xi, xj) + margin + 1)
    sub = mask[y0:y1, x0:x1]
    res = _weighted_subgrid_path(
        sub, (yi - y0, xi - x0), (yj - y0, xj - x0))
    if res is None:
        return None
    cost, geom = res
    if geom > detour_ratio * straight:
        return None
    return cost


def _passage_connector_cost(mask, a, b, margin=None):
    """Return the terrain cost of a passage endpoint-to-base connection.

    A clear chord keeps the cheap straight-line result. If that chord clips an
    impassable pixel, use the same bounded 8-connected weighted raster search
    that legalizes ordinary graph edges. Passage placement therefore depends
    on actual pixel-grid connectivity rather than exact line of sight.

    Unlike ordinary candidate edges, no detour-ratio rejection is applied:
    these are topology anchors, and any connection inside the bounded local
    grid is preferable to making the passage unusable because of a wall tip or
    a slightly offset doorway.
    """
    ax, ay = map(int, a)
    bx, by = map(int, b)
    direct = _line_cost(mask, ax, ay, bx, by)
    if direct is not None:
        return float(direct), False

    if margin is None:
        span = math.hypot(bx - ax, by - ay)
        margin = min(
            PASSAGE_CONNECTOR_GRID_MARGIN_MAX_PX,
            max(PASSAGE_CONNECTOR_GRID_MARGIN_MIN_PX, round(0.75 * span)),
        )
    H, W = mask.shape
    y0 = max(0, min(ay, by) - margin)
    y1 = min(H, max(ay, by) + margin + 1)
    x0 = max(0, min(ax, bx) - margin)
    x1 = min(W, max(ax, bx) + margin + 1)
    result = _weighted_subgrid_path(
        mask[y0:y1, x0:x1],
        (ay - y0, ax - x0),
        (by - y0, bx - x0),
    )
    if result is None:
        return None
    cost, _geom = result
    return float(cost), True


def _weight_edges(mask, nodes_xy, candidate_edges, astar_pairs,
                  local_detour_pairs=None, precomputed_line_results=None,
                  progress_callback=None):
    """Measure each candidate edge's terrain-weighted cost + legality.

    ``candidate_edges`` is an iterable of (i, j) node-index pairs (i < j).
    Fast path: reuse straight-line integrals from candidate discovery and batch
    only the remaining backbone segments. Backbone edges (``astar_pairs``)
    retain their broad weighted-raster fallback. A small, pre-screened set of
    ordinary neighbour pairs may use a much tighter fallback
    (``local_detour_pairs``); all other blocked shortcuts are dropped. Returns
    parallel lists ``(edges, weights)``.
    """
    import math
    cand_list = list(candidate_edges)
    if not cand_list:
        if progress_callback:
            progress_callback(0, 0)
        return [], []
    local_detour_pairs = set(local_detour_pairs or ())

    pts = np.asarray(nodes_xy, dtype=np.float64)
    i_arr = np.array([i for i, _ in cand_list], dtype=np.int32)
    j_arr = np.array([j for _, j in cand_list], dtype=np.int32)
    x0_arr = pts[i_arr, 0].astype(np.int32)
    y0_arr = pts[i_arr, 1].astype(np.int32)
    x1_arr = pts[j_arr, 0].astype(np.int32)
    y1_arr = pts[j_arr, 1].astype(np.int32)

    # Candidate discovery already had to test LOS to enforce per-node budgets.
    # Reuse those exact results instead of rasterizing every accepted segment a
    # second time. Backbone pairs outside the bounded neighbour pool are the
    # only normal misses and are still checked here.
    precomputed_line_results = precomputed_line_results or {}
    batch_costs = np.zeros(len(cand_list), dtype=np.float64)
    batch_blocked = np.ones(len(cand_list), dtype=bool)
    missing = []
    for k, pair in enumerate(cand_list):
        if pair not in precomputed_line_results:
            missing.append(k)
            continue
        result = precomputed_line_results[pair]
        if result is not None:
            batch_costs[k] = float(result)
            batch_blocked[k] = False
    if missing:
        missing = np.asarray(missing, dtype=np.int32)
        missing_costs, missing_blocked = _line_cost_batch(
            mask,
            x0_arr[missing], y0_arr[missing],
            x1_arr[missing], y1_arr[missing])
        batch_costs[missing] = missing_costs
        batch_blocked[missing] = missing_blocked

    edges_out = []
    weights_out = []
    progress_step = max(1, len(cand_list) // 100)
    for k, (i, j) in enumerate(cand_list):
        xi, yi = int(x0_arr[k]), int(y0_arr[k])
        xj, yj = int(x1_arr[k]), int(y1_arr[k])
        straight = math.hypot(xj - xi, yj - yi)
        if straight == 0:
            continue
        if not batch_blocked[k]:
            edges_out.append((i, j))
            weights_out.append(float(batch_costs[k]))
        else:
            pair = (i, j)
            if pair in astar_pairs:
                margin = EDGE_SKELETON_MARGIN
                detour_ratio = EDGE_SKELETON_DETOUR
            elif pair in local_detour_pairs:
                margin = EDGE_LOCAL_DETOUR_MARGIN
                detour_ratio = min(
                    EDGE_LOCAL_DETOUR_RATIO,
                    1.0 + EDGE_LOCAL_DETOUR_MAX_EXTRA_PX / straight)
            else:
                continue
            cost = _weighted_edge_path(
                mask, xi, yi, xj, yj, straight,
                margin=margin, detour_ratio=detour_ratio)
            if cost is not None:
                edges_out.append((i, j))
                weights_out.append(cost)
        processed = k + 1
        if (progress_callback and
                (processed == len(cand_list) or processed % progress_step == 0)):
            progress_callback(processed, len(cand_list))
    return edges_out, weights_out


def _candidate_edges(nodes_xy, skeleton_edges, feature_nodes=None, mask=None,
                     backbone_only_nodes=None, return_local_detours=False,
                     return_line_results=False, progress_callback=None):
    """Union backbone edges with bounded, type-independent local candidates.

    The previous feature-sector rule and the later feature-only LOS-kNN rule
    both created blind spots: the former discarded a useful node when another
    node occupied its angular bin, while the latter grew the graph but still
    discarded every locally repairable blocked segment. The current policy is
    deliberately uniform:

    * inspect at most ``EDGE_NEIGHBOR_SCAN_K`` geometric neighbours within
      ``EDGE_MAX_DIST`` for every node, independent of feature type or sector;
    * retain every direct-LOS pair in that bounded pool, then sparsify the
      completed typed graph with a strict cost witness;
    * nominate at most ``EDGE_LOCAL_DETOUR_KNN`` additional pairs that cross
      only a few black samples for tightly bounded A* validation;
    * give narrow-backbone nodes a smaller budget instead of suppressing all
      generic candidates.

    With ``return_local_detours=True`` return ``(candidates, detour_pairs)``.
    When ``return_line_results`` is also true, append a mapping from every
    evaluated retained pair to its straight cost (or ``None`` when blocked), so
    edge weighting does not repeat the same full-resolution raster checks. The
    default remains the historical candidate-set API used by unit tests.
    """
    cand = set()
    for a, b, _ in skeleton_edges:
        if a != b:
            cand.add((min(a, b), max(a, b)))
    # Kept in the signature for callers/tests and for future diagnostics. The
    # selection policy intentionally no longer changes by node source family.
    _ = feature_nodes
    backbone_only_nodes = set(backbone_only_nodes or ())
    pts = np.asarray(nodes_xy, dtype=np.float64)
    n = len(pts)
    if progress_callback:
        progress_callback(0, n)
    if n == 0:
        if return_line_results:
            return (cand, set(), {}) if return_local_detours else (cand, {})
        return (cand, set()) if return_local_detours else cand

    from scipy.spatial import cKDTree
    scan_k = min(n, EDGE_NEIGHBOR_SCAN_K + 1)
    distances, neighbours = cKDTree(pts).query(
        pts, k=scan_k, distance_upper_bound=EDGE_MAX_DIST)
    if scan_k == 1:
        distances = distances[:, None]
        neighbours = neighbours[:, None]

    sources = np.repeat(np.arange(n, dtype=np.int32), scan_k)
    targets = np.asarray(neighbours, dtype=np.int64).reshape(-1)
    flat_distances = np.asarray(distances, dtype=np.float64).reshape(-1)
    valid = (
        np.isfinite(flat_distances) &
        (targets >= 0) & (targets < n) &
        (targets != sources)
    )
    sources = sources[valid].astype(np.int32, copy=False)
    targets = targets[valid].astype(np.int32, copy=False)
    if not len(sources):
        if progress_callback:
            progress_callback(n, n)
        if return_line_results:
            return (cand, set(), {}) if return_local_detours else (cand, {})
        return (cand, set()) if return_local_detours else cand

    pairs = np.column_stack((np.minimum(sources, targets),
                             np.maximum(sources, targets))).astype(np.int32)
    pairs = np.unique(pairs, axis=0)
    delta = pts[pairs[:, 0]] - pts[pairs[:, 1]]
    pair_d2 = np.einsum("ij,ij->i", delta, delta)

    if mask is None:
        line_costs = np.zeros(len(pairs), dtype=np.float64)
        blocked = np.zeros(len(pairs), dtype=bool)
        blocked_counts = np.zeros(len(pairs), dtype=np.int32)
    else:
        line_costs, blocked, blocked_counts = _line_cost_batch(
            mask,
            pts[pairs[:, 0], 0].astype(np.int32),
            pts[pairs[:, 0], 1].astype(np.int32),
            pts[pairs[:, 1], 0].astype(np.int32),
            pts[pairs[:, 1], 1].astype(np.int32),
            return_blocked_counts=True)

    incident = [[] for _ in range(n)]
    for pair_index, (u, v) in enumerate(pairs):
        incident[int(u)].append(pair_index)
        incident[int(v)].append(pair_index)

    local_detours = set()
    progress_step = max(1, n // 100)
    for node_index, pair_indices in enumerate(incident):
        if pair_indices:
            is_narrow = (
                NARROW_ALLEY_REDUCTION_ENABLED and
                node_index in backbone_only_nodes)
            direct_budget = (
                EDGE_NARROW_KNN if is_narrow
                else EDGE_NEIGHBOR_SCAN_K)
            detour_budget = (
                EDGE_NARROW_DETOUR_KNN if is_narrow
                else EDGE_LOCAL_DETOUR_KNN)
            max_d2 = float((EDGE_NARROW_MAX_DIST if is_narrow
                            else EDGE_MAX_DIST) ** 2)
            direct_taken = detour_taken = 0
            pair_indices.sort(key=lambda p: (pair_d2[p], int(pairs[p, 0]),
                                             int(pairs[p, 1])))
            for pair_index in pair_indices:
                if pair_d2[pair_index] > max_d2:
                    break
                u, v = map(int, pairs[pair_index])
                pair = (u, v)
                if blocked[pair_index]:
                    if (detour_taken >= detour_budget or
                            blocked_counts[pair_index] > EDGE_LOCAL_BLOCKED_SAMPLES_MAX):
                        continue
                    cand.add(pair)
                    local_detours.add(pair)
                    detour_taken += 1
                elif direct_taken < direct_budget:
                    cand.add(pair)
                    direct_taken += 1
                if direct_taken >= direct_budget and detour_taken >= detour_budget:
                    break
        processed = node_index + 1
        if (progress_callback and
                (processed == n or processed % progress_step == 0)):
            progress_callback(processed, n)

    if return_line_results:
        line_results = {
            (int(u), int(v)): (
                None if blocked[pair_index]
                else float(line_costs[pair_index]))
            for pair_index, (u, v) in enumerate(pairs)
            if (int(u), int(v)) in cand
        }
        if return_local_detours:
            return cand, local_detours, line_results
        return cand, line_results
    if return_local_detours:
        return cand, local_detours
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
                cost = _weighted_edge_path(
                    mask, ux, uy, vx, vy, d, margin=margin,
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


def _sparsify_redundant_edges(edges, weights, protected_mask=None,
                              stretch=EDGE_SPANNER_STRETCH):
    """Remove only edges with an active near-equal two-edge cost witness.

    This runs on the final typed graph, after passage-body shadowing, so a
    witness can never disappear in a later topology stage. Passage and
    transition edges are protected by the caller. Longer/more expensive edges
    are considered first; every removal immediately mutates the adjacency, so
    subsequent decisions can rely only on edges that still exist.

    Returns ``(edges, weights, kept_indices, removed_count)`` as numpy arrays.
    ``kept_indices`` lets the caller filter parallel edge metadata without
    weakening the binary-format invariants.
    """
    edges_arr = np.asarray(edges, dtype=np.int32).reshape(-1, 2)
    weights_arr = np.asarray(weights, dtype=np.float32).reshape(-1)
    count = len(edges_arr)
    if count == 0:
        return (edges_arr, weights_arr, np.zeros(0, dtype=np.int64), 0)

    if protected_mask is None:
        protected = np.zeros(count, dtype=bool)
    else:
        protected = np.asarray(protected_mask, dtype=bool).reshape(-1)
        if len(protected) != count:
            raise ValueError("protected edge mask length mismatch")

    node_count = int(edges_arr.max()) + 1
    adjacency = [dict() for _ in range(node_count)]
    for edge_index, ((u, v), weight) in enumerate(zip(edges_arr, weights_arr)):
        # Protected typed edges must not remove a base edge by acting as its
        # witness: that would silently force a formerly base-only route through
        # a passage surface. They remain serialized, but outside this base
        # sparsifier's adjacency.
        if protected[edge_index]:
            continue
        u, v, weight = int(u), int(v), float(weight)
        previous = adjacency[u].get(v)
        if previous is None or weight < previous:
            adjacency[u][v] = weight
            adjacency[v][u] = weight

    active = np.ones(count, dtype=bool)
    order = sorted(
        range(count),
        key=lambda idx: (-float(weights_arr[idx]),
                         int(edges_arr[idx, 0]), int(edges_arr[idx, 1])))
    removed = 0
    for edge_index in order:
        if protected[edge_index]:
            continue
        u, v = map(int, edges_arr[edge_index])
        weight = float(weights_arr[edge_index])
        if v not in adjacency[u]:
            active[edge_index] = False
            removed += 1
            continue
        left, right = ((adjacency[u], adjacency[v])
                       if len(adjacency[u]) <= len(adjacency[v])
                       else (adjacency[v], adjacency[u]))
        limit = stretch * weight
        has_witness = any(
            middle in right and first_weight + right[middle] <= limit
            for middle, first_weight in left.items())
        if not has_witness:
            continue
        del adjacency[u][v]
        del adjacency[v][u]
        active[edge_index] = False
        removed += 1

    kept = np.flatnonzero(active)
    return edges_arr[kept], weights_arr[kept], kept, removed


# =============================================================================
# Sampling metadata
# =============================================================================

def _sampling_grids(mask, dist_full, labels_full):
    """Build the ÷SAMPLE_DS coarse sampling grids.

    * ``coarse_minval`` — block-min terrain value (0 if any impassable in block).
    * ``coarse_maxval`` — block-max terrain value (endpoint eligibility).
    * ``coarse_clear``  — block-max clearance (px, capped 255).
    * ``coarse_labels`` — free-space component id at the block's freest pixel.
    """
    ds = SAMPLE_DS
    H, W = mask.shape
    hh, ww = (H // ds) * ds, (W // ds) * ds
    ch, cw = hh // ds, ww // ds

    mv = mask[:hh, :ww].reshape(ch, ds, cw, ds)
    coarse_minval = mv.min(axis=(1, 3)).astype(np.uint8)
    coarse_maxval = mv.max(axis=(1, 3)).astype(np.uint8)

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
    return coarse_minval, coarse_maxval, coarse_clear, coarse_labels.astype(np.int32)


def _apply_passage_topology(artifact, mask, passages, level_passages,
                            region_polygon=None, graph_labels=None):
    """Isolate projected base topology, then append protected passage chains.

    This is deliberately a final build stage.  All generic base-node creation,
    k-NN, witness pruning and repair have already finished, and the result is
    compacted and filtered here.  Passage nodes are appended afterwards, so no
    generic pass can ever deduplicate them or invent an intermediate connector.
    """
    t_start = time.time()
    old_nodes = np.asarray(artifact["nodes"], dtype=np.int32).reshape(-1, 2)
    old_edges = np.asarray(artifact["edges"], dtype=np.int32).reshape(-1, 2)
    old_weights = np.asarray(artifact["weights"], dtype=np.float32).reshape(-1)
    old_components = np.asarray(artifact["components"], dtype=np.int32).reshape(-1)

    shadowed_per_passage = []
    shadowed = set()
    outside_region = set()
    for node_index, (x, y) in enumerate(old_nodes):
        if region_polygon is not None and not _point_in_polygon(x, y, region_polygon):
            outside_region.add(node_index)
        for passage_index, passage in enumerate(passages):
            if _point_in_passage_body(passage, float(x), float(y)):
                while len(shadowed_per_passage) <= passage_index:
                    shadowed_per_passage.append(0)
                shadowed_per_passage[passage_index] += 1
                shadowed.add(node_index)
    while len(shadowed_per_passage) < len(passages):
        shadowed_per_passage.append(0)

    removed = shadowed | outside_region
    kept = [idx for idx in range(len(old_nodes)) if idx not in removed]
    remap = np.full(len(old_nodes), -1, dtype=np.int32)
    remap[kept] = np.arange(len(kept), dtype=np.int32)
    base_nodes = old_nodes[kept].copy()
    base_components = old_components[kept].copy()

    base_edges = []
    base_weights = []
    rejected_longitudinal = 0
    rejected_ambiguous = 0
    retained_transverse = 0
    rejected_base_edge_geometry = []
    seen_edges = set()
    for (old_u, old_v), weight in zip(old_edges, old_weights):
        if old_u in removed or old_v in removed:
            continue
        u, v = int(remap[old_u]), int(remap[old_v])
        a, b = tuple(base_nodes[u]), tuple(base_nodes[v])
        if region_polygon is not None and not _segment_in_polygon(a, b, region_polygon):
            continue
        relations = [relation for passage in passages
                     if (relation := _edge_passage_relation(a, b, passage)) is not None]
        if relations and not all(relation[0] for relation in relations):
            if any(relation[1] for relation in relations):
                rejected_longitudinal += 1
            else:
                rejected_ambiguous += 1
            rejected_base_edge_geometry.append((a, b))
            continue
        if relations:
            retained_transverse += 1
        edge = (min(u, v), max(u, v))
        if edge not in seen_edges:
            seen_edges.add(edge)
            base_edges.append(edge)
            base_weights.append(float(weight))

    # Recover genuine underpasses after body-node compaction.  Candidates are
    # local to one passage bbox, directly visible on the authoritative mask,
    # and accepted only when every crossed passage sees a transverse crossing.
    bypasses_added = 0
    bypasses_per_passage = []
    for passage in passages:
        min_x = min(p[0] for p in passage["points"]) - PASSAGE_BYPASS_RADIUS_PX
        max_x = max(p[0] for p in passage["points"]) + PASSAGE_BYPASS_RADIUS_PX
        min_y = min(p[1] for p in passage["points"]) - PASSAGE_BYPASS_RADIUS_PX
        max_y = max(p[1] for p in passage["points"]) + PASSAGE_BYPASS_RADIUS_PX
        nearby = [idx for idx, (x, y) in enumerate(base_nodes)
                  if min_x <= x <= max_x and min_y <= y <= max_y]
        candidates = []
        if len(nearby) >= 2:
            from scipy.spatial import cKDTree
            points = base_nodes[nearby].astype(np.float64)
            tree = cKDTree(points)
            neighbour_count = min(
                len(nearby), PASSAGE_BYPASS_NEIGHBORS_PER_NODE + 1)
            distances, neighbours = tree.query(
                points, k=neighbour_count,
                distance_upper_bound=PASSAGE_BYPASS_RADIUS_PX)
            bounded_pairs = set()
            if neighbour_count == 1:
                distances = distances[:, None]
                neighbours = neighbours[:, None]
            for local_u, (row_distances, row_neighbours) in enumerate(
                    zip(distances, neighbours)):
                for distance, local_v in zip(row_distances[1:], row_neighbours[1:]):
                    if not math.isfinite(float(distance)) or int(local_v) >= len(nearby):
                        continue
                    bounded_pairs.add((min(local_u, int(local_v)),
                                       max(local_u, int(local_v))))
            for local_u, local_v in sorted(bounded_pairs):
                u, v = nearby[local_u], nearby[local_v]
                edge = (min(u, v), max(u, v))
                if edge in seen_edges:
                    continue
                a, b = tuple(base_nodes[u]), tuple(base_nodes[v])
                relation = _edge_passage_relation(a, b, passage)
                if relation is None or not relation[0]:
                    continue
                if any((other_relation := _edge_passage_relation(a, b, other)) is not None
                       and not other_relation[0] for other in passages):
                    continue
                if region_polygon is not None and not _segment_in_polygon(a, b, region_polygon):
                    continue
                cost = _line_cost(mask, *a, *b)
                if cost is None:
                    continue
                distance2 = float(np.sum((base_nodes[u].astype(np.float64)
                                          - base_nodes[v]) ** 2))
                candidates.append((distance2, edge, float(cost)))
        added_here = 0
        for _, edge, cost in sorted(candidates, key=lambda value: (value[0], value[1])):
            if added_here >= PASSAGE_BYPASS_MAX_PER_PASSAGE:
                break
            if edge in seen_edges:
                continue
            seen_edges.add(edge)
            base_edges.append(edge)
            base_weights.append(cost)
            added_here += 1
            bypasses_added += 1
        bypasses_per_passage.append(added_here)

    base_node_count = len(base_nodes)
    all_nodes = [tuple(map(int, node)) for node in base_nodes]
    all_components = [int(value) for value in base_components]
    all_edges = list(base_edges)
    all_weights = list(base_weights)
    edge_kinds = [EDGE_KIND_BASE] * len(all_edges)
    edge_passage = [-1] * len(all_edges)
    passage_starts = []
    passage_counts = []
    original_passage_points = []
    connector_base_nodes = []
    unusable_endpoints = []
    passage_edge_count = 0
    connector_count = 0
    grid_connector_count = 0
    endpoint_graph_adjustments = []

    for ordinal, passage in enumerate(passages):
        start_index = len(all_nodes)
        passage_starts.append(start_index)
        passage_counts.append(len(passage["points"]))
        rounded = []
        last_point_index = len(passage["points"]) - 1
        for point_index, point in enumerate(passage["points"]):
            if point_index in (0, last_point_index):
                graph_point = _passage_endpoint_graph_coordinate(
                    mask, passage, point, region_polygon)
                normal_round = (
                    min(mask.shape[1] - 1, _round_graph_coordinate(point[0])),
                    min(mask.shape[0] - 1, _round_graph_coordinate(point[1])),
                )
                if graph_point != normal_round:
                    endpoint_graph_adjustments.append({
                        "id": passage["id"],
                        "endpoint": "start" if point_index == 0 else "end",
                        "from": normal_round,
                        "to": graph_point,
                    })
            else:
                graph_point = (
                    min(mask.shape[1] - 1, _round_graph_coordinate(point[0])),
                    min(mask.shape[0] - 1, _round_graph_coordinate(point[1])),
                )
            rounded.append(graph_point)
        for point, graph_point in zip(passage["points"], rounded):
            if not _point_in_polygon(point[0], point[1], region_polygon):
                raise ValueError(f"passage {passage['id']} has a point outside the inclusion polygon")
            if not _point_in_polygon(graph_point[0], graph_point[1], region_polygon):
                raise ValueError(
                    f"passage {passage['id']} rounds to a graph node outside the inclusion polygon")
            all_nodes.append(graph_point)
            all_components.append(0)  # filled after endpoint-component union
            original_passage_points.append(point)
        for offset, (a, b) in enumerate(zip(passage["points"], passage["points"][1:])):
            if not _segment_in_polygon(a, b, region_polygon):
                raise ValueError(f"passage {passage['id']} leaves the inclusion polygon")
            u, v = start_index + offset, start_index + offset + 1
            if not _segment_in_polygon(all_nodes[u], all_nodes[v], region_polygon):
                raise ValueError(
                    f"passage {passage['id']} rounded chain leaves the inclusion polygon")
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            all_edges.append((u, v))
            all_weights.append(length * (255 - PASSAGE_FAST_VALUE))
            edge_kinds.append(EDGE_KIND_PASSAGE)
            edge_passage.append(ordinal)
            passage_edge_count += 1

        passage_connectors = []
        endpoint_specs = (
            ("start", start_index, passage["frames"]["start"]),
            ("end", start_index + len(passage["points"]) - 1,
             passage["frames"]["end"]),
        )
        for endpoint_name, passage_node, endpoint in endpoint_specs:
            graph_endpoint = all_nodes[passage_node]
            endpoint_component = 0
            if graph_labels is not None:
                endpoint_component = int(
                    graph_labels[graph_endpoint[1], graph_endpoint[0]])
            # Base nodes inside the corridor were shadowed above. Wide passages
            # therefore need a search radius that reaches beyond their own
            # footprint before applying the ordinary graph-neighbour span.
            connector_radius = (
                PASSAGE_CONNECTOR_RADIUS_PX + passage["radius"])
            nearby_candidates = []
            for base_index, base_point_array in enumerate(base_nodes):
                base_point = tuple(map(int, base_point_array))
                dx, dy = base_point[0] - endpoint[0], base_point[1] - endpoint[1]
                distance = math.hypot(dx, dy)
                if distance > connector_radius:
                    continue
                if (endpoint_component > 0
                        and int(base_components[base_index]) != endpoint_component):
                    continue
                nearby_candidates.append((distance, base_index, base_point))

            # Keep the ten nearest *connectable* neighbours. A blocked chord is
            # not a rejection: ordinary navgraph edges already use bounded
            # pixel-grid search for this case, and passage endpoints follow the
            # same rule. Surface transitions still occur only at the serialized
            # endpoint; a base connector may cross a projected passage footprint
            # because it remains on the base surface throughout.
            selected = []
            for distance, base_index, base_point in sorted(nearby_candidates):
                result = _passage_connector_cost(mask, graph_endpoint, base_point)
                if result is None:
                    continue
                cost, used_grid_path = result
                selected.append((distance, base_index, cost, used_grid_path))
                if len(selected) >= PASSAGE_CONNECTOR_MAX_PER_ENDPOINT:
                    break
            if not selected:
                unusable_endpoints.append({"id": passage["id"], "endpoint": endpoint_name})
                raise PassageConnectorError(
                    passage["id"], endpoint_name, passage_number=ordinal + 1)
            endpoint_bases = []
            for _, base_index, cost, used_grid_path in selected:
                all_edges.append((base_index, passage_node))
                all_weights.append(cost)
                edge_kinds.append(EDGE_KIND_TRANSITION)
                edge_passage.append(ordinal)
                endpoint_bases.append(base_index)
                connector_count += 1
                if used_grid_path:
                    grid_connector_count += 1
            passage_connectors.extend(endpoint_bases)
        connector_base_nodes.append(passage_connectors)

    # A complete passage chain unions the base-mask components reachable at its
    # endpoints.  Remap both node and coarse sampling labels so Infinity's
    # component prefilter sees bridge-only connectivity.
    max_component = max(
        int(np.max(base_components)) if len(base_components) else 0,
        int(np.max(artifact["coarse_labels"])) if np.size(artifact["coarse_labels"]) else 0)
    component_uf = _UnionFind(max_component + 1)
    for base_indices in connector_base_nodes:
        labels = sorted({int(base_components[index]) for index in base_indices
                         if int(base_components[index]) > 0})
        for label in labels[1:]:
            component_uf.union(labels[0], label)
    component_map = np.arange(max_component + 1, dtype=np.int32)
    for label in range(1, max_component + 1):
        component_map[label] = component_uf.find(label)
    for index in range(base_node_count):
        value = all_components[index]
        all_components[index] = int(component_map[value]) if value > 0 else 0
    for ordinal, base_indices in enumerate(connector_base_nodes):
        labels = [all_components[index] for index in base_indices if all_components[index] > 0]
        component = min(labels) if labels else 0
        start, count = passage_starts[ordinal], passage_counts[ordinal]
        all_components[start:start + count] = [component] * count
    coarse_labels = np.asarray(artifact["coarse_labels"], dtype=np.int32)
    artifact["coarse_labels"] = component_map[coarse_labels]

    artifact["nodes"] = np.asarray(all_nodes, dtype=np.int32).reshape(-1, 2)
    artifact["edges"] = np.asarray(all_edges, dtype=np.int32).reshape(-1, 2)
    artifact["weights"] = np.asarray(all_weights, dtype=np.float32)
    artifact["components"] = np.asarray(all_components, dtype=np.int32)
    artifact["base_node_count"] = np.int32(base_node_count)
    artifact["edge_kinds"] = np.asarray(edge_kinds, dtype=np.uint8)
    artifact["edge_passage"] = np.asarray(edge_passage, dtype=np.int32)
    artifact["passage_node_start"] = np.asarray(passage_starts, dtype=np.int32)
    artifact["passage_node_count"] = np.asarray(passage_counts, dtype=np.int32)
    # NPZ/debug-only high precision geometry; the served worker already owns the
    # canonical passage document and maps ordinals using the same id sort.
    artifact["passage_node_points"] = np.asarray(
        original_passage_points, dtype=np.float64).reshape(-1, 2)
    artifact["shadowed_base_nodes"] = old_nodes[sorted(shadowed)].copy()
    artifact["shadowed_base_edges"] = np.asarray([
        (old_nodes[int(u)], old_nodes[int(v)]) for u, v in old_edges
        if int(u) in shadowed or int(v) in shadowed
    ] + rejected_base_edge_geometry, dtype=np.int32).reshape(-1, 2, 2)
    artifact["min_cost_per_px"] = np.float32(min(
        float(artifact["min_cost_per_px"]), 255 - PASSAGE_FAST_VALUE))
    _attach_passage_topology(
        artifact, level_passages=level_passages,
        map_width=mask.shape[1], map_height=mask.shape[0])
    return {
        "n_passages": len(passages),
        "passage_node_count": len(original_passage_points),
        "passage_edge_count": passage_edge_count,
        "passage_connector_count": connector_count,
        "passage_grid_connector_count": grid_connector_count,
        "passage_endpoint_graph_adjustments": endpoint_graph_adjustments,
        "base_nodes_shadowed_by_passages": shadowed_per_passage,
        "base_nodes_outside_region_removed": len(outside_region - shadowed),
        "retained_transverse_bypasses": retained_transverse + bypasses_added,
        "retained_existing_transverse_edges": retained_transverse,
        "added_transverse_bypasses": bypasses_added,
        "transverse_bypasses_per_passage": bypasses_per_passage,
        "rejected_longitudinal_edges": rejected_longitudinal,
        "rejected_ambiguous_passage_edges": rejected_ambiguous,
        "unusable_endpoints": unusable_endpoints,
        "passage_revision": artifact["passage_revision"],
        "topology_seconds": round(time.time() - t_start, 3),
    }


# =============================================================================
# Build
# =============================================================================

def build_navgraph(mask_path, region_polygon=None, level_passages=None,
                   verbose=False, prune_region=True,
                   collect_diagnostics=False, progress_callback=None):
    """Build the navgraph artifact dict for one mask PNG.

    ``region_polygon`` (optional) is a coach-drawn map-region polygon: a sequence
    of full-res ``(x, y)`` vertices. When given it is the *authoritative* hit zone
    (rasterized into ``coarse_hitzone`` and used to confine the open-area lattice);
    the automatic ``_hitzone`` detection is used only as a fallback / suggestion
    when no polygon is supplied. See the module "Off-map hit zone" note.

    ``prune_region=False`` is a benchmark-only switch: it keeps the polygon as
    the endpoint/hitzone authority while retaining the pre-WP-6.1 topology.
    Production builds must leave it enabled.

    ``collect_diagnostics=True`` enables graph-wide measurements used by debug
    overlays. They never alter the artifact topology and are skipped in normal
    production builds.

    ``progress_callback`` (optional) receives JSON-friendly dictionaries with
    a monotonic estimated ``percent`` and an internal ``phase``. During
    candidate connection it also receives the exact processed ``current`` and
    ``total`` node counts. The overall percentage is phase-weighted because
    loading, raster analysis, edge weighting and serialization are not
    node-based work.

    Returns a dict with all arrays + stats (see module docstring). Pure
    computation; use ``save_navgraph()`` to persist.
    """
    if not _HAVE_SKIMAGE:
        raise RuntimeError(
            "scikit-image is required for navgraph skeletonization; add it to "
            "requirements.txt."
        )
    t_start = time.time()
    timings = {}

    def _log(msg):
        if verbose:
            print(f"[navgraph] {msg}", flush=True)

    def _progress(percent, phase, current=None, total=None):
        if progress_callback is None:
            return
        payload = {
            "percent": max(0, min(99, int(round(percent)))),
            "phase": phase,
        }
        if current is not None:
            payload["current"] = int(current)
        if total is not None:
            payload["total"] = int(total)
        try:
            keep_building = progress_callback(payload)
            if keep_building is False:
                raise NavgraphBuildCancelled()
        except NavgraphBuildCancelled:
            raise
        except Exception as exc:  # progress reporting must never break a build
            _log(f"progress callback failed: {exc!r}")

    _progress(0, "starting")

    # 1. Load mask.
    t = time.time()
    mask = _load_mask(mask_path)
    H, W = mask.shape
    timings["load"] = time.time() - t
    _log(f"loaded {W}x{H} ({H*W/1e6:.1f} Mpx)")
    _progress(4, "loading")

    # Editor coordinates can overshoot the raster edge by a few pixels due to
    # display scaling/rounding. Normalize before passages, revisions, hit-zone
    # rasterization, and topology all consume the polygon so every stage uses
    # the same bounded region.
    if isinstance(region_polygon, (list, tuple)) and len(region_polygon) >= 3:
        region_polygon = clip_region_polygon(region_polygon, W, H)

    # Normalize the complete canonical document before skeletonization or any
    # other expensive build stage. Structurally invalid geometry aborts the
    # whole build. Valid passages outside this Infinity region are deliberately
    # omitted as whole objects: they may belong to another game mode.
    t = time.time()
    effective_passages, ignored_passage_ids = filter_level_passages_for_region(
        level_passages, region_polygon, W, H)
    canonical_passages, build_passages = _normalize_passages_for_build(
        effective_passages, W, H)
    timings["passage_normalization"] = time.time() - t
    _log(f"passages: {len(build_passages)} included, "
         f"{len(ignored_passage_ids)} outside region")
    _progress(7, "preparing")

    min_cost_per_px = _min_cost_per_px(mask)

    # 2. Unfiltered free-space labels (for node component ids + coarse labels).
    t = time.time()
    struct8 = np.ones((3, 3), dtype=np.uint8)
    labels_full, ncomp = ndi.label(mask != IMPASSABLE, structure=struct8)
    comp_sizes = np.bincount(labels_full.ravel())
    main_comp = int(comp_sizes[1:].argmax()) + 1 if ncomp > 0 else 0
    timings["label"] = time.time() - t
    _log(f"labelled {ncomp} free components; main={main_comp}")
    _progress(13, "analysing")

    # 3. Hit zone: the coach-drawn region polygon is authoritative if supplied;
    #    otherwise fall back to automatic class-structure detection. Footprint
    #    confines the lattice; sample mask is the stored endpoint zone.
    t = time.time()
    has_polygon = region_polygon is not None and len(region_polygon) > 0
    region_full = None
    if has_polygon:
        hz_ds = HITZONE_DS
        region_full = _rasterize_region_full(region_polygon, H, W)
        region = _rasterize_region(
            region_polygon, H, W, hz_ds, full_raster=region_full)
        hz_footprint = hz_sample = region
        hz_source = "polygon"
    else:
        hz_footprint, hz_sample, hz_ds = _hitzone(mask)
        hz_source = "auto"
    timings["hitzone"] = time.time() - t
    _log(f"hitzone[{hz_source}]: footprint {hz_footprint.mean()*100:.0f}% "
         f"sample {hz_sample.mean()*100:.0f}% (ds={hz_ds})")
    _progress(19, "analysing")

    # Full-image EDT and skeletonization intentionally remain global.  From the
    # topology stage onward, polygon-exterior pixels are terrain-impassable, so
    # straight rays, skeleton A* and connectivity-repair A* share one legality
    # definition and cannot cut across a concavity or repair through the margin.
    topology_mask = mask
    if region_full is not None and prune_region:
        topology_mask = mask.copy()
        topology_mask[~region_full] = IMPASSABLE

    # The polygon can split one globally connected terrain label when its old
    # connection ran through the surrounding margin.  Use polygon-masked labels
    # for node components, repair and connectivity metrics.
    graph_labels = labels_full
    graph_ncomp = ncomp
    graph_comp_sizes = comp_sizes
    if region_full is not None and prune_region:
        t = time.time()
        graph_labels, graph_ncomp = ndi.label(
            topology_mask != IMPASSABLE, structure=struct8)
        graph_comp_sizes = np.bincount(graph_labels.ravel())
        main_comp = (
            int(graph_comp_sizes[1:].argmax()) + 1 if graph_ncomp > 0 else 0)
        timings["region_components"] = time.time() - t

    # 4. Full-res distance transform (clearance) on the true free space.
    t = time.time()
    topo_passable = mask != IMPASSABLE
    dist_full = ndi.distance_transform_edt(topo_passable).astype(np.float32)
    timings["edt"] = time.time() - t
    _progress(31, "clearance")

    # 5. Adaptive downsample + skeletonize.
    ds = _downsample_factor(H, W)
    t = time.time()
    coarse_passable = _block_reduce(topo_passable, ds, "max") if ds > 1 else topo_passable
    skel = _sk_skeletonize(coarse_passable)
    skel = _prune_spurs(skel, SPUR_MIN_LEN)
    timings["skeleton"] = time.time() - t
    _log(f"ds={ds} skeleton px={int(skel.sum())} ({timings['skeleton']:.1f}s)")
    _progress(43, "skeleton")

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
    #    Polygon pruning follows after all node families have been assembled and
    #    deduplicated. Automatic/legacy builds still retain the global skeleton.
    skeleton_xy = _snap_nodes(mask, node_yx, ds)
    bottleneck_xy = _snap_bottleneck_nodes(mask, dist_full, bottleneck_yx, ds)
    dense_skeleton_xy = _visible_backbone_samples(
        mask, skeleton_xy, skeleton_edges)
    # NARROW_ALLEY_REDUCTION: proximity to a skeleton is not enough. Wide roads
    # also have a skeleton and still need wall-side alternatives. Only samples
    # whose own centerline clearance proves a genuinely narrow corridor may
    # absorb contour/bottleneck nodes.
    narrow_dense_skeleton_xy = [
        (x, y) for x, y in dense_skeleton_xy
        if dist_full[y, x] <= NARROW_BACKBONE_CLEARANCE_PX
    ]
    # NARROW_ALLEY_REDUCTION: bottleneck minima are useful only when they fill a
    # gap between skeleton samples. Remove ones already represented by a nearby
    # visible skeleton node. Flip NARROW_ALLEY_REDUCTION_ENABLED to undo.
    bottleneck_xy, bottleneck_skeleton_merged = _filter_points_near_visible_nodes(
        mask, bottleneck_xy, narrow_dense_skeleton_xy)
    open_xy = _snap_nodes(mask, open_yx, ds)
    centerline_xy = narrow_dense_skeleton_xy + bottleneck_xy
    (black_corners_xy, black_regular_xy, black_pairs,
     black_centerline_removed) = _filter_contours_near_centerline(
        mask, black_corners_xy, black_regular_xy, black_pairs, centerline_xy)
    (slow_corners_xy, slow_regular_xy, slow_pairs,
     slow_centerline_removed) = _filter_contours_near_centerline(
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
    if contour_pairs:
        _cp_list = list(contour_pairs)
        _cp_x0 = np.array([nodes_xy[u][0] for u, _ in _cp_list], dtype=np.int32)
        _cp_y0 = np.array([nodes_xy[u][1] for u, _ in _cp_list], dtype=np.int32)
        _cp_x1 = np.array([nodes_xy[v][0] for _, v in _cp_list], dtype=np.int32)
        _cp_y1 = np.array([nodes_xy[v][1] for _, v in _cp_list], dtype=np.int32)
        _, _cp_blocked = _line_cost_batch(topology_mask, _cp_x0, _cp_y0, _cp_x1, _cp_y1)
        contour_pairs = {pair for pair, blk in zip(_cp_list, _cp_blocked) if not blk}
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

    # Polygon pruning happens after every source family has been snapped and
    # deduplicated, but before candidate generation/weighting/repair.  Filtering
    # in original-index order preserves the skeleton-prefix invariant while the
    # explicit remap keeps every topology-bearing index collection correct.
    nodes_before_region_prune = len(nodes_xy)
    region_prune_started = time.time()
    if region_full is not None and prune_region:
        kept_old = [
            old for old, (x, y) in enumerate(nodes_xy)
            if region_full[int(y), int(x)]
        ]
        remap = np.full(len(nodes_xy), -1, dtype=np.int32)
        remap[kept_old] = np.arange(len(kept_old), dtype=np.int32)

        def remap_index_set(values):
            return {
                int(remap[old]) for old in values
                if 0 <= old < len(remap) and remap[old] >= 0
            }

        nodes_xy = [nodes_xy[old] for old in kept_old]
        node_source_indices = [node_source_indices[old] for old in kept_old]
        skeleton_edges = [
            (int(remap[a]), int(remap[b]), length)
            for a, b, length in skeleton_edges
            if remap[a] >= 0 and remap[b] >= 0 and remap[a] != remap[b]
        ]
        contour_pairs = {
            (min(int(remap[a]), int(remap[b])),
             max(int(remap[a]), int(remap[b])))
            for a, b in contour_pairs
            if remap[a] >= 0 and remap[b] >= 0 and remap[a] != remap[b]
        }
        feature_nodes = remap_index_set(feature_nodes)
        obstacle_edge_nodes = remap_index_set(obstacle_edge_nodes)
        protected_nodes = remap_index_set(protected_nodes)
        n_skeleton_nodes = sum(old < n_skeleton_nodes for old in kept_old)
        n_lattice_nodes = len(nodes_xy) - n_skeleton_nodes
    nodes_after_region_prune = len(nodes_xy)
    timings["region_prune"] = time.time() - region_prune_started
    region_pruned_fraction = (
        (nodes_before_region_prune - nodes_after_region_prune)
        / nodes_before_region_prune
        if nodes_before_region_prune else 0.0
    )

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
        "bottleneck_skeleton_merged": bottleneck_skeleton_merged,
        "dense_centerline_samples": len(dense_skeleton_xy),
        "narrow_dense_centerline_samples": len(narrow_dense_skeleton_xy),
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
    _progress(60, "nodes", len(nodes_xy), len(nodes_xy))

    # 8. Component id per node (from unfiltered labels) — needed for repair.
    nodes_arr = np.asarray(nodes_xy, dtype=np.int32).reshape(-1, 2)
    if len(nodes_arr):
        components = graph_labels[
            nodes_arr[:, 1], nodes_arr[:, 0]].astype(np.int32)
    else:
        components = np.zeros(0, dtype=np.int32)

    # 9. Candidate edges -> weighting. Skeleton edges retain the broad A*
    # fallback; a bounded set of local neighbour pairs may use the strict
    # small-interruption fallback described by EDGE_LOCAL_DETOUR_*.
    t = time.time()
    # NARROW_ALLEY_REDUCTION: low-clearance skeleton nodes receive the smaller
    # EDGE_NARROW_* candidate budget. This remains easy to reverse, but unlike
    # the former all-or-nothing suppression it cannot erase every useful local
    # connection when the downsampled backbone misses one.
    narrow_backbone_nodes = {
        idx for idx, (x, y) in enumerate(nodes_xy[:n_skeleton_nodes])
        if dist_full[y, x] <= NARROW_BACKBONE_CLEARANCE_PX
    } if NARROW_ALLEY_REDUCTION_ENABLED else set()
    obstacle_sampling["narrow_backbone_only_nodes"] = len(narrow_backbone_nodes)
    backbone_edges = list(skeleton_edges) + [
        (u, v, 0.0) for u, v in contour_pairs]
    skeleton_pairs = {
        (min(a, b), max(a, b)) for a, b, _ in backbone_edges if a != b}
    cand, local_detour_pairs, candidate_line_results = _candidate_edges(
        nodes_xy, backbone_edges, obstacle_edge_nodes, mask=topology_mask,
        backbone_only_nodes=narrow_backbone_nodes,
        return_local_detours=True, return_line_results=True,
        progress_callback=lambda current, total: _progress(
            60 + (14 * current / total if total else 14),
            "connect_nodes", current, total))
    edges, weights = _weight_edges(
        topology_mask, nodes_xy, cand, skeleton_pairs, local_detour_pairs,
        candidate_line_results,
        progress_callback=lambda current, total: _progress(
            74 + (8 * current / total if total else 8),
            "weight_edges", current, total))
    obstacle_sampling["local_detour_candidates"] = len(local_detour_pairs)
    obstacle_sampling["local_detour_edges_kept"] = len(
        set(edges) & local_detour_pairs)
    n_before = len(edges)
    edges, weights = _repair_connectivity(
        topology_mask, nodes_xy, edges, weights, components, main_comp)
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
    _progress(84, "repairing")

    # 10. Sampling metadata.
    t = time.time()
    coarse_minval, coarse_maxval, coarse_clear, coarse_labels = _sampling_grids(
        mask, dist_full, labels_full)
    coarse_origin = np.asarray([0, 0], dtype=np.int32)
    if has_polygon and prune_region and region_full is not None and region_full.any():
        region_y, region_x = np.where(region_full)
        gy0 = max(0, int(region_y.min()) // SAMPLE_DS)
        gx0 = max(0, int(region_x.min()) // SAMPLE_DS)
        gy1 = min(coarse_minval.shape[0], int(region_y.max()) // SAMPLE_DS + 1)
        gx1 = min(coarse_minval.shape[1], int(region_x.max()) // SAMPLE_DS + 1)
        coarse_minval = coarse_minval[gy0:gy1, gx0:gx1].copy()
        coarse_maxval = coarse_maxval[gy0:gy1, gx0:gx1].copy()
        coarse_clear = coarse_clear[gy0:gy1, gx0:gx1].copy()
        coarse_labels = coarse_labels[gy0:gy1, gx0:gx1].copy()
        coarse_origin = np.asarray(
            [gx0 * SAMPLE_DS, gy0 * SAMPLE_DS], dtype=np.int32)
    timings["sampling"] = time.time() - t
    _progress(88, "sampling")

    edges_arr = np.asarray(edges, dtype=np.int32).reshape(-1, 2)
    weights_arr = np.asarray(weights, dtype=np.float32).reshape(-1)

    # This graph-wide BFS is diagnostic only. On large graphs it can consume a
    # few hundred milliseconds and its result never changes the artifact.
    main_conn = (
        _main_component_connectivity(
            nodes_arr, edges_arr, components, main_comp)
        if collect_diagnostics else None
    )

    free_total = int((mask != IMPASSABLE).sum())
    graph_free_total = int((topology_mask != IMPASSABLE).sum())
    stats = {
        "mask_shape": [int(H), int(W)],
        "mpx": round(H * W / 1e6, 2),
        "downsample": int(ds),
        "n_nodes": int(len(nodes_arr)),
        "n_skeleton_nodes": int(n_skeleton_nodes),
        "n_lattice_nodes": int(n_lattice_nodes),
        "n_feature_nodes": int(len(feature_nodes)),
        "n_edges": int(len(edges_arr)),
        "nodes_before_region_prune": int(nodes_before_region_prune),
        "nodes_after_region_prune": int(nodes_after_region_prune),
        "edges_after_region_prune": int(len(edges_arr)),
        "region_pruned_fraction": round(float(region_pruned_fraction), 4),
        "region_prune_enabled": bool(prune_region),
        "n_components": int(graph_ncomp),
        "main_component_fraction": round(
            float(graph_comp_sizes[main_comp]) / graph_free_total, 4)
            if graph_free_total and main_comp else 0.0,
        "free_fraction": round(free_total / (H * W), 4),
        "main_component_connectivity": (
            round(main_conn, 4) if main_conn is not None else None),
        "region_component_connectivity": (
            round(main_conn, 4) if main_conn is not None else None),
        "hitzone_source": hz_source,
        "hitzone_footprint_fraction": round(float(hz_footprint.mean()), 4),
        "hitzone_sample_fraction": round(float(hz_sample.mean()), 4),
        "hitzone_scale": int(hz_ds),
        "region_polygon": (
            [[int(x), int(y)] for (x, y) in region_polygon] if has_polygon else None),
        "region_revision": region_revision(region_polygon, W, H) if has_polygon else None,
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
        "coarse_origin": coarse_origin,
        "coarse_minval": coarse_minval,
        "coarse_maxval": coarse_maxval,
        "coarse_clear": coarse_clear,
        "coarse_labels": coarse_labels,
        "hitzone_scale": np.int32(hz_ds),
        "coarse_hitzone": hz_sample.astype(np.uint8),
        "region_revision": stats["region_revision"] or "",
        "stats": stats,
    }
    if build_passages:
        passage_stats = _apply_passage_topology(
            artifact, topology_mask, build_passages, canonical_passages,
            region_polygon=region_polygon if has_polygon else None,
            graph_labels=graph_labels)
        stats.update(passage_stats)
        stats["n_nodes"] = int(len(artifact["nodes"]))
        stats["n_edges"] = int(len(artifact["edges"]))
        stats["base_node_count"] = int(artifact["base_node_count"])
        timings["passage_topology"] = passage_stats["topology_seconds"]
    else:
        # Empty passage data preserves the established base graph exactly.
        _attach_passage_topology(
            artifact, level_passages=canonical_passages,
            map_width=W, map_height=H)
        stats["passage_revision"] = artifact["passage_revision"]
        stats["base_node_count"] = int(artifact["base_node_count"])
        stats["n_passages"] = 0
        stats["passage_node_count"] = 0
        stats["passage_edge_count"] = 0
        stats["passage_connector_count"] = 0
        stats["passage_grid_connector_count"] = 0
        stats["base_nodes_shadowed_by_passages"] = []
        stats["retained_transverse_bypasses"] = 0
        stats["rejected_longitudinal_edges"] = 0
        stats["unusable_endpoints"] = []
    _progress(94, "passages")

    # Final edge spanner: passage shadowing/compaction is complete, so every
    # accepted witness is guaranteed to remain in the serialized topology.
    # Typed passage/transition edges encode surface semantics and are never
    # candidates for geometric redundancy pruning.
    t = time.time()
    edge_kinds = np.asarray(
        artifact.get("edge_kinds", np.zeros(len(artifact["edges"]), np.uint8)),
        dtype=np.uint8).reshape(-1)
    (artifact["edges"], artifact["weights"], kept_edge_indices,
     spanner_removed) = _sparsify_redundant_edges(
        artifact["edges"], artifact["weights"],
        protected_mask=edge_kinds != EDGE_KIND_BASE)
    for metadata_key in ("edge_kinds", "edge_passage"):
        if metadata_key in artifact:
            artifact[metadata_key] = np.asarray(
                artifact[metadata_key]).reshape(-1)[kept_edge_indices]
    timings["edge_sparsify"] = time.time() - t
    stats["edge_spanner_stretch"] = EDGE_SPANNER_STRETCH
    stats["edge_spanner_removed"] = int(spanner_removed)
    stats["n_edges"] = int(len(artifact["edges"]))
    _progress(97, "sparsifying")

    stats["ignored_passages_outside_region"] = len(ignored_passage_ids)
    stats["ignored_passage_ids_outside_region"] = ignored_passage_ids

    # Compact the only coarse-label fact needed to derive the served endpoint
    # bitset: whether a cell belongs to the dominant sample component. The full
    # debug NPZ also benefits from replacing the former int32 label grid.
    labels = np.asarray(artifact["coarse_labels"])
    nonzero = labels[labels > 0]
    if nonzero.size:
        dominant = int(np.bincount(nonzero.astype(np.int64)).argmax())
        artifact["coarse_labels"] = (labels == dominant).astype(np.uint8)
    else:
        artifact["coarse_labels"] = np.zeros(labels.shape, dtype=np.uint8)
    stats["coarse_labels_compacted"] = True

    # 11. Suitability estimate removed. The UI no longer surfaces suitability
    #     stats and the fixed 8 s budget was ~20-25 % of median build time. Keep
    #     the key as None for compatibility with readers that inspect the .npz.
    stats["suitability"] = None
    stats["timings"] = {k: round(v, 2) for k, v in timings.items()}
    stats["build_seconds"] = round(time.time() - t_start, 2)
    diagnostic_suffix = (
        f"; main-comp connectivity {main_conn:.3f}"
        if main_conn is not None else "")
    _log(f"done in {stats['build_seconds']}s{diagnostic_suffix}")
    _progress(99, "finalizing")

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

def _attach_passage_topology(artifact, level_passages, map_width, map_height):
    """Fill legacy typed-passage fields on ``artifact`` in place.

    A base-only artifact gets the degenerate topology (all edges ``base``, no passages,
    ``base_node_count == N``). Fields already present (e.g. from a future passage
    builder) are validated and kept. Always computes ``passage_revision`` from the
    canonical document + mask dimensions.

    Validates the invariants every reader also enforces, so a malformed in-memory
    artifact is rejected here rather than producing an unreadable ``.bin``.
    """
    N = int(np.asarray(artifact["nodes"], dtype=np.int64).reshape(-1, 2).shape[0])
    E = int(np.asarray(artifact["edges"], dtype=np.int64).reshape(-1, 2).shape[0])

    base_node_count = int(artifact.get("base_node_count", N))
    edge_kinds = artifact.get("edge_kinds")
    edge_passage = artifact.get("edge_passage")
    p_start = artifact.get("passage_node_start")
    p_count = artifact.get("passage_node_count")

    if edge_kinds is None:
        edge_kinds = np.zeros(E, dtype=np.uint8)
    else:
        edge_kinds = np.ascontiguousarray(edge_kinds, dtype=np.uint8).reshape(-1)
    if edge_passage is None:
        edge_passage = np.full(E, -1, dtype=np.int32)
    else:
        edge_passage = np.ascontiguousarray(edge_passage, dtype=np.int32).reshape(-1)
    p_start = (np.zeros(0, dtype=np.int32) if p_start is None
               else np.ascontiguousarray(p_start, dtype=np.int32).reshape(-1))
    p_count = (np.zeros(0, dtype=np.int32) if p_count is None
               else np.ascontiguousarray(p_count, dtype=np.int32).reshape(-1))

    P = int(p_start.shape[0])
    if p_count.shape[0] != P:
        raise ValueError("passage_node_start and passage_node_count length mismatch")
    if edge_kinds.shape[0] != E or edge_passage.shape[0] != E:
        raise ValueError("edge_kinds/edge_passage length must equal edge count")
    if not (0 <= base_node_count <= N):
        raise ValueError(f"base_node_count {base_node_count} out of range [0,{N}]")

    # Passage node ranges are contiguous, ordered, and cover exactly the tail.
    expected = base_node_count
    for p in range(P):
        s, c = int(p_start[p]), int(p_count[p])
        if c < 1:
            raise ValueError(f"passage {p} has non-positive node count {c}")
        if s != expected:
            raise ValueError(f"passage {p} start {s} not contiguous (expected {expected})")
        expected += c
    if P and expected != N:
        raise ValueError(f"passage node ranges end at {expected}, expected N={N}")
    if P == 0 and base_node_count != N:
        raise ValueError("no passages but base_node_count != N")

    edges = np.asarray(artifact["edges"], dtype=np.int64).reshape(-1, 2)
    if E and (int(edges.min()) < 0 or int(edges.max()) >= N):
        raise ValueError("edge endpoint out of node range")

    # Edge kind / owning-ordinal and endpoint-topology consistency.
    for e in range(E):
        kind = int(edge_kinds[e])
        owner = int(edge_passage[e])
        u, v = map(int, edges[e])
        if kind == EDGE_KIND_BASE:
            if owner != -1:
                raise ValueError(f"base edge {e} must have passage ordinal -1")
            if u >= base_node_count or v >= base_node_count:
                raise ValueError(f"base edge {e} touches a passage node")
        elif kind in (EDGE_KIND_PASSAGE, EDGE_KIND_TRANSITION):
            if not (0 <= owner < P):
                raise ValueError(f"typed edge {e} owner {owner} out of range [0,{P})")
            else:
                start, count = int(p_start[owner]), int(p_count[owner])
                end = start + count - 1
                u_in = start <= u <= end
                v_in = start <= v <= end
                if kind == EDGE_KIND_PASSAGE:
                    if not (u_in and v_in and abs(u - v) == 1):
                        raise ValueError(
                            f"passage edge {e} must join consecutive nodes of owner {owner}")
                elif not ((u < base_node_count and v in (start, end))
                          or (v < base_node_count and u in (start, end))):
                    raise ValueError(
                        f"transition edge {e} must join base to an endpoint of owner {owner}")
        else:
            raise ValueError(f"edge {e} has unknown kind {kind}")

    artifact["base_node_count"] = np.int32(base_node_count)
    artifact["edge_kinds"] = edge_kinds
    artifact["edge_passage"] = edge_passage
    artifact["passage_node_start"] = p_start
    artifact["passage_node_count"] = p_count
    artifact["passage_revision"] = passage_revision(level_passages, map_width, map_height)
    return artifact


def save_navgraph(artifact, mask_path, *, include_npz=True):
    """Write the served ``.bin`` and optionally the debug ``.npz``.

    Both files are written to temporary siblings first and then atomically
    ``os.replace``-d into place, so a crashed/interrupted build never leaves a
    half-written binary that a reader or the serving path could pick up.

    ``include_npz=False`` is the production path: the full graph is debug/build
    data and is removed after the authoritative served binary is installed.
    Returns ``(npz_path_or_none, bin_path)``.
    """
    import tempfile

    base, _ = os.path.splitext(mask_path)
    npz_path = base + ".navgraph.npz"
    bin_path = base + ".navgraph.bin"

    if "passage_revision" not in artifact:
        H, W = int(artifact["mask_shape"][0]), int(artifact["mask_shape"][1])
        _attach_passage_topology(artifact, level_passages=None, map_width=W, map_height=H)

    out_dir = os.path.dirname(npz_path) or "."
    tmp_npz = tmp_bin = None
    try:
        # Pass an open handle (not a path) to ``savez_compressed`` so it writes
        # exactly where we point it — a bare path lacking ``.npz`` would get the
        # suffix appended, defeating the atomic rename.
        if include_npz:
            fd, tmp_npz = tempfile.mkstemp(
                prefix=".navgraph-", suffix=".npztmp", dir=out_dir)
            with os.fdopen(fd, "wb") as handle:
                _save_npz(handle, artifact)

        fd, tmp_bin = tempfile.mkstemp(prefix=".navgraph-", suffix=".bintmp", dir=out_dir)
        os.close(fd)
        _write_bin(tmp_bin, artifact)

        if include_npz:
            os.replace(tmp_npz, npz_path)
            tmp_npz = None
        os.replace(tmp_bin, bin_path)
        tmp_bin = None
        if not include_npz:
            try:
                os.remove(npz_path)
            except FileNotFoundError:
                pass
    finally:
        for leftover in (tmp_npz, tmp_bin):
            if leftover and os.path.exists(leftover):
                try:
                    os.remove(leftover)
                except OSError:
                    pass
    return (npz_path if include_npz else None), bin_path


def _save_npz(npz_file, artifact):
    np.savez_compressed(
        npz_file,
        version=np.int32(artifact["version"]),
        nodes=artifact["nodes"],
        edges=artifact["edges"],
        weights=artifact["weights"],
        components=artifact["components"],
        edge_kinds=artifact["edge_kinds"],
        edge_passage=artifact["edge_passage"],
        passage_node_start=artifact["passage_node_start"],
        passage_node_count=artifact["passage_node_count"],
        passage_node_points=artifact.get(
            "passage_node_points", np.zeros((0, 2), dtype=np.float64)),
        shadowed_base_nodes=artifact.get(
            "shadowed_base_nodes", np.zeros((0, 2), dtype=np.int32)),
        shadowed_base_edges=artifact.get(
            "shadowed_base_edges", np.zeros((0, 2, 2), dtype=np.int32)),
        base_node_count=np.int32(artifact["base_node_count"]),
        passage_revision=artifact["passage_revision"],
        region_revision=artifact.get(
            "region_revision", artifact.get("stats", {}).get("region_revision") or ""),
        min_cost_per_px=artifact["min_cost_per_px"],
        mask_shape=artifact["mask_shape"],
        coarse_scale=artifact["coarse_scale"],
        coarse_origin=artifact.get("coarse_origin", np.zeros(2, dtype=np.int32)),
        coarse_minval=artifact["coarse_minval"],
        coarse_maxval=artifact.get("coarse_maxval", artifact["coarse_minval"]),
        coarse_clear=artifact["coarse_clear"],
        coarse_labels=artifact["coarse_labels"],
        hitzone_scale=artifact["hitzone_scale"],
        coarse_hitzone=artifact["coarse_hitzone"],
        stats=json.dumps(artifact["stats"]),
    )


def _write_bin(bin_path, artifact):
    """Serialize the compact graph-backed little-endian v6 served binary.

    Production play needs the graph itself.  Coordinates and edge endpoints use
    16-bit integers whenever the map/node counts permit it; endpoint eligibility
    and the polygon hitzone remain packed bitsets.  Debug-only coarse rasters and
    component labels are not served.
    """
    if "passage_revision" not in artifact:
        H0, W0 = int(artifact["mask_shape"][0]), int(artifact["mask_shape"][1])
        _attach_passage_topology(artifact, level_passages=None, map_width=W0, map_height=H0)

    nodes_source = np.asarray(artifact["nodes"])
    edges_source = np.asarray(artifact["edges"])
    weights = np.ascontiguousarray(artifact["weights"], dtype="<f4")
    edge_kinds = np.ascontiguousarray(artifact["edge_kinds"], dtype="<u1")
    edge_passage = np.ascontiguousarray(artifact["edge_passage"], dtype="<i4")
    passage_node_start_source = np.asarray(artifact["passage_node_start"])
    passage_node_count_source = np.asarray(artifact["passage_node_count"])
    coarse_minval = np.ascontiguousarray(artifact["coarse_minval"], dtype="<u1")
    coarse_maxval = np.ascontiguousarray(
        artifact.get("coarse_maxval", artifact["coarse_minval"]), dtype="<u1")
    coarse_clear = np.ascontiguousarray(artifact["coarse_clear"], dtype="<u1")
    coarse_labels = np.ascontiguousarray(artifact["coarse_labels"], dtype="<u1")
    coarse_hitzone = np.ascontiguousarray(artifact["coarse_hitzone"], dtype="<u1")

    H, W = int(artifact["mask_shape"][0]), int(artifact["mask_shape"][1])
    N = int(nodes_source.shape[0])
    E = int(edges_source.shape[0])
    base_node_count = int(artifact["base_node_count"])
    P = int(passage_node_start_source.shape[0])
    node32 = W > 65535 or H > 65535
    index32 = N > 65535
    nodes = np.ascontiguousarray(nodes_source, dtype="<u4" if node32 else "<u2")
    edges = np.ascontiguousarray(edges_source, dtype="<u4" if index32 else "<u2")
    passage_node_start = np.ascontiguousarray(
        passage_node_start_source, dtype="<u4" if index32 else "<u2")
    passage_node_count = np.ascontiguousarray(
        passage_node_count_source, dtype="<u4" if index32 else "<u2")
    ch, cw = coarse_minval.shape
    hh_, hw_ = coarse_hitzone.shape
    rev_bytes = str(artifact["passage_revision"]).encode("ascii")
    region_rev_bytes = str(artifact.get(
        "region_revision", artifact.get("stats", {}).get("region_revision") or ""
    )).encode("ascii")
    coarse_origin = np.asarray(
        artifact.get("coarse_origin", (0, 0)), dtype="<i4").reshape(2)
    if len(rev_bytes) > NAVGRAPH_REVISION_MAX_LEN:
        raise ValueError(
            f"passage_revision too long ({len(rev_bytes)} > {NAVGRAPH_REVISION_MAX_LEN})")
    if len(region_rev_bytes) > NAVGRAPH_REVISION_MAX_LEN:
        raise ValueError(
            f"region_revision too long ({len(region_rev_bytes)} > {NAVGRAPH_REVISION_MAX_LEN})")

    if int(artifact["version"]) != NAVGRAPH_VERSION:
        raise ValueError(f"cannot write served navgraph version {artifact['version']}")

    sampleable = (
        (coarse_labels != 0)
        & (coarse_clear >= ENDPOINT_CLEARANCE_MIN_PX)
        & (coarse_maxval >= ENDPOINT_TERRAIN_MIN_VALUE)
    )
    coarse_scale = int(artifact["coarse_scale"])
    hitzone_scale = int(artifact["hitzone_scale"])
    xs = (int(coarse_origin[0]) + np.arange(cw) * coarse_scale) // hitzone_scale
    ys = (int(coarse_origin[1]) + np.arange(ch) * coarse_scale) // hitzone_scale
    valid_x = (xs >= 0) & (xs < hw_)
    valid_y = (ys >= 0) & (ys < hh_)
    hitzone_for_cells = np.zeros((ch, cw), dtype=bool)
    if valid_x.any() and valid_y.any():
        hitzone_for_cells[np.ix_(valid_y, valid_x)] = (
            coarse_hitzone[np.ix_(ys[valid_y], xs[valid_x])] != 0)
    sampleable &= hitzone_for_cells
    sampleable_bits = np.packbits(
        sampleable.reshape(-1), bitorder="little").astype("<u1", copy=False)
    hitzone_bits = np.packbits(
        (coarse_hitzone != 0).reshape(-1), bitorder="little").astype("<u1", copy=False)

    # v6 flags: bit 0 = uint32 coordinates, bit 1 = uint32 node indices.
    flags = (1 if node32 else 0) | (2 if index32 else 0)
    with open(bin_path, "wb") as f:
        f.write(NAVGRAPH_MAGIC)
        f.write(np.array([artifact["version"]], dtype="<u4").tobytes())
        f.write(np.array([H, W], dtype="<i4").tobytes())
        f.write(np.array([float(artifact["min_cost_per_px"])], dtype="<f4").tobytes())
        f.write(np.array([N, E], dtype="<u4").tobytes())
        f.write(np.array([coarse_scale, ch, cw], dtype="<i4").tobytes())
        f.write(np.array([hitzone_scale, hh_, hw_], dtype="<i4").tobytes())
        f.write(np.array(
            [base_node_count, P, len(rev_bytes)], dtype="<u4").tobytes())
        f.write(coarse_origin.tobytes())
        f.write(np.array([len(region_rev_bytes), flags], dtype="<u4").tobytes())
        f.write(rev_bytes)
        f.write(region_rev_bytes)
        f.write(nodes.tobytes())
        f.write(edges.tobytes())
        f.write(weights.tobytes())
        f.write(edge_kinds.tobytes())
        f.write(edge_passage.tobytes())
        f.write(passage_node_start.tobytes())
        f.write(passage_node_count.tobytes())
        f.write(sampleable_bits.tobytes())
        f.write(hitzone_bits.tobytes())


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
