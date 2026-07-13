"""Debug overlay visualizer for navgraph artifacts (WP 1.3).

Renders, for each given mask, a PNG overlay next to its ``.navgraph.npz``
artifact (``<base>.navgraph.debug.png``) showing:

* the mask as a dimmed grayscale background,
* the artifact's stored endpoint hit zone: sampleable cells tinted normally,
  non-sampleable cells tinted red/yellow where an automatic footprint is known,
* graph edges as line segments, colour-ramped by weight-per-pixel
  (``weight / euclidean_length``) — cheap/fast terrain is green, expensive/
  slow terrain is red (see COLOUR RAMP below),
* graph nodes as small dots,
* optionally (``--pair y1,x1,y2,x2``) a shortest path between the two nearest
  graph nodes to the given points, drawn in bright cyan on top, with the
  total weight and node count printed.

Large masks (> ``MAX_OUTPUT_SIDE`` px on a side) are downscaled for the
*output image only* — node/edge coordinates are scaled accordingly so even
the 75 Mpx worst-case mask produces a small, viewable PNG.

Usage:
    python scripts/navgraph_debug.py media/masks/mask_X.png [more masks...]
    python scripts/navgraph_debug.py media/masks/mask_X.png --pair 100,200,900,1200

Requires only Pillow + numpy (matplotlib is not assumed to be installed).
If a mask has no ``.navgraph.npz`` artifact yet, it is built on the fly via
``project.navgraph.build_navgraph`` / ``save_navgraph``.
"""

import argparse
import heapq
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from project.navgraph import (  # noqa: E402
    _hitzone,
    _load_mask,
    build_navgraph,
    save_navgraph,
)

# --- Rendering constants -----------------------------------------------------
MAX_OUTPUT_SIDE = 2500       # px; downscale output image if mask exceeds this
BG_DIM_FACTOR = 0.35         # multiply mask grayscale by this so overlays pop
OFFMAP_COLOR = (200, 40, 40)   # outside the map footprint (nodes pruned)
BORING_COLOR = (235, 200, 45)  # in footprint but boring (crossable, no endpoints)
OVERLAY_ALPHA = 0.55         # tint strength for hit-zone overlays
NODE_COLOR = (20, 20, 20)
PASSAGE_NODE_COLOR = (155, 55, 220)
PASSAGE_EDGE_COLOR = (190, 70, 240)
TRANSITION_EDGE_COLOR = (0, 210, 255)
SHADOWED_COLOR = (255, 120, 20)
NODE_RADIUS = 2
PATH_COLOR = (0, 230, 255)   # bright cyan
PATH_WIDTH = 4
LEGEND_H = 70

# Colour ramp: cost-per-px in [ramp_min, ramp_max] -> green (cheap/fast) to
# red (expensive/slow). Edges are drawn on top of the dimmed mask.
RAMP_LOW = (40, 180, 60)     # cheap terrain (fast)
RAMP_HIGH = (220, 40, 40)    # expensive terrain (slow)


def _ramp_color(t):
    """t in [0,1] -> RGB tuple, green (0) to red (1)."""
    t = max(0.0, min(1.0, t))
    r = int(round(RAMP_LOW[0] + (RAMP_HIGH[0] - RAMP_LOW[0]) * t))
    g = int(round(RAMP_LOW[1] + (RAMP_HIGH[1] - RAMP_LOW[1]) * t))
    b = int(round(RAMP_LOW[2] + (RAMP_HIGH[2] - RAMP_LOW[2]) * t))
    return (r, g, b)


def _upscale_coarse(coarse, ds, H, W):
    """Nearest-upscale a coarse ÷ds bool grid to a full-res (H, W) bool array.

    Cells beyond the block-aligned area (trailing <ds pixels) default to False,
    which for the footprint means "off-map" — correct at the mask border.
    """
    up = np.repeat(np.repeat(np.asarray(coarse, dtype=bool), ds, axis=0), ds, axis=1)
    full = np.zeros((H, W), dtype=bool)
    uh, uw = min(up.shape[0], H), min(up.shape[1], W)
    full[:uh, :uw] = up[:uh, :uw]
    return full


def _tint(bg_rgb, mask_bool, color, alpha):
    """Alpha-blend ``color`` into ``bg_rgb`` (uint8 HxWx3) where ``mask_bool``."""
    if not mask_bool.any():
        return
    sel = bg_rgb[mask_bool].astype(np.float32)
    col = np.asarray(color, dtype=np.float32)
    bg_rgb[mask_bool] = (sel * (1.0 - alpha) + col * alpha).clip(0, 255).astype(np.uint8)


def _load_artifact(mask_path):
    """Load the .navgraph.npz next to mask_path, building it if missing."""
    base, _ = os.path.splitext(mask_path)
    npz_path = base + ".navgraph.npz"
    if not os.path.isfile(npz_path):
        print(f"[navgraph_debug] no artifact at {npz_path}; building...")
        artifact = build_navgraph(
            mask_path, verbose=True, collect_diagnostics=True)
        save_navgraph(artifact, mask_path)
        return artifact, npz_path
    data = np.load(npz_path, allow_pickle=True)
    artifact = {k: data[k] for k in data.files}
    return artifact, npz_path


def _stats_of(artifact):
    stats = artifact.get("stats")
    if stats is None:
        return {}
    if isinstance(stats, np.ndarray):
        stats = stats.item()
    if isinstance(stats, (bytes, str)):
        stats = json.loads(stats)
    return stats


def _scalar_int(value, default):
    try:
        return int(np.asarray(value).item())
    except Exception:
        return default


def _artifact_hitzone(mask, artifact):
    """Return full-res ``(footprint, sample, stats)`` for debug tinting.

    ``coarse_hitzone`` is the endpoint zone actually served to the client. For
    polygon-built artifacts the polygon is both footprint and sample. For
    automatic artifacts we recompute only the coarse footprint so the overlay can
    still distinguish off-map red from in-map-but-boring yellow.
    """
    H, W = mask.shape
    stats = _stats_of(artifact)
    hz_ds = _scalar_int(artifact.get("hitzone_scale"), stats.get("hitzone_scale", 16))
    coarse_sample = artifact.get("coarse_hitzone")

    if coarse_sample is None:
        fp_c, sample_c, hz_ds = _hitzone(mask)
    else:
        sample_c = np.asarray(coarse_sample, dtype=bool)
        if stats.get("hitzone_source") == "polygon":
            fp_c = sample_c
        else:
            fp_c, _, auto_ds = _hitzone(mask)
            if int(auto_ds) != int(hz_ds) or fp_c.shape != sample_c.shape:
                fp_c = sample_c

    fp_full = _upscale_coarse(fp_c, hz_ds, H, W)
    sample_full = _upscale_coarse(sample_c, hz_ds, H, W)
    return fp_full, sample_full, {
        "footprint_fraction": round(float(np.asarray(fp_c, dtype=bool).mean()), 4),
        "sample_fraction": round(float(np.asarray(sample_c, dtype=bool).mean()), 4),
        "scale": int(hz_ds),
        "source": stats.get("hitzone_source", "unknown"),
    }


# =============================================================================
# Shortest path (undirected Dijkstra over nodes/edges/weights)
# =============================================================================

def _build_adjacency(edges, weights):
    adj = {}
    for (u, v), w in zip(edges.tolist(), weights.tolist()):
        adj.setdefault(u, []).append((v, w))
        adj.setdefault(v, []).append((u, w))
    return adj


def _nearest_node(nodes_xy, x, y, limit=None):
    """Index of the node nearest to (x, y) (full-res px)."""
    candidates = nodes_xy if limit is None else nodes_xy[:limit]
    if not len(candidates):
        raise ValueError("artifact has no base node available for endpoint snapping")
    d2 = (candidates[:, 0].astype(np.float64) - x) ** 2 + \
         (candidates[:, 1].astype(np.float64) - y) ** 2
    return int(np.argmin(d2))


def _dijkstra(adj, src, dst, n_nodes):
    dist = [float("inf")] * n_nodes
    prev = [-1] * n_nodes
    dist[src] = 0.0
    heap = [(0.0, src)]
    visited = bytearray(n_nodes)
    while heap:
        d, u = heapq.heappop(heap)
        if visited[u]:
            continue
        visited[u] = 1
        if u == dst:
            break
        for v, w in adj.get(u, ()):
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))
    if dist[dst] == float("inf"):
        return None, None
    path = [dst]
    cur = dst
    while cur != src:
        cur = prev[cur]
        path.append(cur)
    path.reverse()
    return path, dist[dst]


# =============================================================================
# Rendering
# =============================================================================

def _render_overlay(mask_path, artifact, out_path, pair=None, show_shadowed=False):
    mask = _load_mask(mask_path)
    H, W = mask.shape

    nodes = np.asarray(artifact["nodes"]).reshape(-1, 2)   # (x, y) full-res
    edges = np.asarray(artifact["edges"]).reshape(-1, 2)
    weights = np.asarray(artifact["weights"]).reshape(-1)
    edge_kinds = np.asarray(
        artifact.get("edge_kinds", np.zeros(len(edges), dtype=np.uint8)),
        dtype=np.uint8).reshape(-1)
    base_node_count = _scalar_int(artifact.get("base_node_count"), len(nodes))

    # --- Hit zone: footprint (map body) + sample (endpoint zone), using the
    #     artifact's stored endpoint zone so polygon-built graphs visualize the
    #     same data served to the client.
    fp_full, sample_full, hitzone_stats = _artifact_hitzone(mask, artifact)

    # --- Output scale (downscale only, never upscale).
    scale = min(1.0, MAX_OUTPUT_SIDE / max(H, W))
    out_w, out_h = max(1, round(W * scale)), max(1, round(H * scale))
    print(f"[navgraph_debug] {os.path.basename(mask_path)}: "
          f"{W}x{H} ({W*H/1e6:.1f} Mpx) -> output {out_w}x{out_h} "
          f"(scale={scale:.4f})")

    # --- Background: dimmed grayscale mask, tinted by hit zone (red = off-map /
    #     pruned, yellow = in-map but boring) in the full-res buffer before
    #     downscaling so the zones survive a large downscale.
    bg = (mask.astype(np.float32) * BG_DIM_FACTOR).clip(0, 255).astype(np.uint8)
    bg_rgb = np.stack([bg, bg, bg], axis=-1)
    _tint(bg_rgb, ~fp_full, OFFMAP_COLOR, OVERLAY_ALPHA)
    _tint(bg_rgb, fp_full & ~sample_full, BORING_COLOR, OVERLAY_ALPHA * 0.7)
    bg_img = Image.fromarray(bg_rgb, mode="RGB")
    if scale != 1.0:
        bg_img = bg_img.resize((out_w, out_h), Image.BILINEAR)

    canvas = Image.new("RGB", (out_w, out_h + LEGEND_H), (255, 255, 255))
    canvas.paste(bg_img, (0, 0))
    draw = ImageDraw.Draw(canvas)

    # --- Edges, colour-ramped by weight-per-pixel.
    if len(edges):
        u = edges[:, 0]
        v = edges[:, 1]
        dx = (nodes[u, 0] - nodes[v, 0]).astype(np.float64)
        dy = (nodes[u, 1] - nodes[v, 1]).astype(np.float64)
        lengths = np.hypot(dx, dy)
        lengths_safe = np.where(lengths > 0, lengths, 1.0)
        cost_per_px = weights / lengths_safe

        finite = np.isfinite(cost_per_px) & (lengths > 0)
        if finite.any():
            ramp_min = float(np.percentile(cost_per_px[finite], 2))
            ramp_max = float(np.percentile(cost_per_px[finite], 98))
            if ramp_max <= ramp_min:
                ramp_max = ramp_min + 1e-6
        else:
            ramp_min, ramp_max = 0.0, 1.0

        for i in range(len(edges)):
            if lengths[i] == 0:
                continue
            xi, yi = nodes[u[i]]
            xj, yj = nodes[v[i]]
            kind = int(edge_kinds[i])
            if kind == 1:
                color = PASSAGE_EDGE_COLOR
            elif kind == 2:
                color = TRANSITION_EDGE_COLOR
            else:
                t = (cost_per_px[i] - ramp_min) / (ramp_max - ramp_min)
                color = _ramp_color(t)
            draw.line(
                [(xi * scale, yi * scale), (xj * scale, yj * scale)],
                fill=color, width=2 if kind else 1,
            )
        print(f"[navgraph_debug]   weight/px ramp: min={ramp_min:.3f} "
              f"max={ramp_max:.3f} (2nd/98th percentile of {len(edges)} edges)")
    else:
        ramp_min = ramp_max = 0.0
        print("[navgraph_debug]   no edges to draw")

    # --- Nodes.
    r = NODE_RADIUS
    for node_index, (x, y) in enumerate(nodes):
        cx, cy = x * scale, y * scale
        color = NODE_COLOR if node_index < base_node_count else PASSAGE_NODE_COLOR
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)

    # Removed projected base topology is diagnostic-only.  The default image
    # always shows exactly the effective serialized graph.
    if show_shadowed:
        shadow_edges = np.asarray(
            artifact.get("shadowed_base_edges", np.zeros((0, 2, 2), dtype=np.int32)),
            dtype=np.int32).reshape(-1, 2, 2)
        shadow_nodes = np.asarray(
            artifact.get("shadowed_base_nodes", np.zeros((0, 2), dtype=np.int32)),
            dtype=np.int32).reshape(-1, 2)
        for (x0, y0), (x1, y1) in shadow_edges:
            draw.line([(x0 * scale, y0 * scale), (x1 * scale, y1 * scale)],
                      fill=SHADOWED_COLOR, width=2)
        for x, y in shadow_nodes:
            cx, cy = x * scale, y * scale
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SHADOWED_COLOR)

    # --- Optional shortest path.
    path_info = None
    if pair is not None:
        y1, x1, y2, x2 = pair
        adj = _build_adjacency(edges, weights)
        src = _nearest_node(nodes, x1, y1, limit=base_node_count)
        dst = _nearest_node(nodes, x2, y2, limit=base_node_count)
        path, total = _dijkstra(adj, src, dst, len(nodes))
        if path is None:
            print(f"[navgraph_debug]   --pair: NO PATH between node {src} "
                  f"(snapped to {tuple(nodes[src])}) and node {dst} "
                  f"(snapped to {tuple(nodes[dst])})")
            path_info = {"found": False}
        else:
            print(f"[navgraph_debug]   --pair: path found, "
                  f"{len(path)} nodes, total weight={total:.1f} "
                  f"(src snapped {tuple(nodes[src])}, dst snapped {tuple(nodes[dst])})")
            pts = [(nodes[n][0] * scale, nodes[n][1] * scale) for n in path]
            draw.line(pts, fill=PATH_COLOR, width=PATH_WIDTH)
            for (px, py) in pts:
                draw.ellipse([px - 3, py - 3, px + 3, py + 3], fill=PATH_COLOR)
            # Mark the raw query points too, for reference.
            for (qx, qy), c in ((( x1, y1), (255, 165, 0)), ((x2, y2), (255, 165, 0))):
                qxs, qys = qx * scale, qy * scale
                draw.ellipse([qxs - 5, qys - 5, qxs + 5, qys + 5], outline=c, width=2)
            path_info = {"found": True, "n_nodes": len(path), "weight": float(total)}

    # --- Legend.
    legend_y0 = out_h
    draw.rectangle([0, legend_y0, out_w, out_h + LEGEND_H], fill=(255, 255, 255))
    bar_x0, bar_x1 = 10, min(210, out_w - 10)
    bar_y0, bar_y1 = legend_y0 + 12, legend_y0 + 28
    steps = max(2, bar_x1 - bar_x0)
    for i in range(steps):
        t = i / (steps - 1)
        color = _ramp_color(t)
        draw.line([(bar_x0 + i, bar_y0), (bar_x0 + i, bar_y1)], fill=color)
    draw.rectangle([bar_x0, bar_y0, bar_x1, bar_y1], outline=(0, 0, 0))
    _draw_text(draw, (bar_x0, bar_y1 + 4),
               f"cost/px: {ramp_min:.2f} (fast)  -  {ramp_max:.2f} (slow)")
    _draw_text(draw, (bar_x0, bar_y1 + 20),
               f"nodes={len(nodes)}  edges={len(edges)}  "
               f"footprint={hitzone_stats['footprint_fraction']*100:.0f}%  "
               f"sample={hitzone_stats['sample_fraction']*100:.0f}%  "
               f"hitzone={hitzone_stats['source']}  "
               f"(purple=passage, cyan=transition)")

    canvas.save(out_path)
    print(f"[navgraph_debug]   wrote {out_path}")
    return {
        "ramp_min": ramp_min, "ramp_max": ramp_max,
        "hitzone_stats": hitzone_stats, "n_nodes": len(nodes), "n_edges": len(edges),
        "path_info": path_info,
    }


def render_overlay_for_mask(mask_path, artifact=None, pair=None, out_path=None,
                            show_shadowed=False):
    """Render a ``.navgraph.debug.png`` overlay for ``mask_path``.

    ``artifact`` may be the in-memory dict returned by ``build_navgraph()`` or a
    loaded ``.navgraph.npz`` dict. If omitted, the artifact next to the mask is
    loaded, building it only as the standalone script's fallback behavior.
    """
    if artifact is None:
        artifact, _ = _load_artifact(mask_path)
    if out_path is None:
        base, _ = os.path.splitext(mask_path)
        out_path = base + ".navgraph.debug.png"
    stats = _stats_of(artifact)
    print(f"[navgraph_debug] {os.path.basename(mask_path)}: "
          f"{stats.get('mpx', '?')} Mpx, nodes={stats.get('n_nodes')}, "
          f"edges={stats.get('n_edges')}, "
          f"main_conn={stats.get('main_component_connectivity')}")
    return _render_overlay(
        mask_path, artifact, out_path, pair=pair,
        show_shadowed=show_shadowed)


def _draw_text(draw, xy, text):
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None
    draw.text(xy, text, fill=(0, 0, 0), font=font)


# =============================================================================
# CLI
# =============================================================================

def _parse_pair(s):
    parts = [p.strip() for p in s.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(
            "--pair expects 4 comma-separated values: y1,x1,y2,x2")
    y1, x1, y2, x2 = (float(p) for p in parts)
    return (y1, x1, y2, x2)


def main():
    parser = argparse.ArgumentParser(
        description="Render navgraph debug overlays (WP 1.3).")
    parser.add_argument("masks", nargs="+", help="mask PNG path(s)")
    parser.add_argument(
        "--pair", type=_parse_pair, default=None,
        help="y1,x1,y2,x2 — snap to nearest nodes and draw the shortest path "
             "(applied to every mask given)")
    parser.add_argument(
        "--show-shadowed", action="store_true",
        help="draw base nodes/edges removed beneath passage bodies in orange")
    args = parser.parse_args()

    for mask_path in args.masks:
        if not os.path.isfile(mask_path):
            print(f"[navgraph_debug] SKIP missing file: {mask_path}")
            continue
        render_overlay_for_mask(
            mask_path, pair=args.pair, show_shadowed=args.show_shadowed)


if __name__ == "__main__":
    main()
