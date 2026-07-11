"""Suitability estimate for infinite-mode pair generation (WP 4.3).

Runs a lightweight, in-process pair-generation simulation at navgraph build
time and returns ``{valid_rate, mean_retries, mean_ms, ...}`` for display next
to the region editor's opt-in toggle (a soft warning, not a hard block).

This mirrors the *client* pipeline implemented and tested in
``scripts/navgraph_harness.mjs`` (Node): sample an endpoint pair inside the
region hit zone with the same cell prefilters -> snap both endpoints to <=3
graph nodes via local full-res A* stubs -> run a binary-heap graph A* (virtual
start/goal nodes) -> repeat with perpendicular "barriers" removing crossed
edges to get up to ``routeAttempts`` distinct routes -> pick the pair of
routes ``selectRuntimeRouteOptions`` would serve. See the harness module
docstring for the full pipeline rationale; function names below match it
1:1 (``samplePair`` -> ``_sample_pair``, ``snapEndpoint`` -> ``_snap_endpoint``,
``graphAstar`` -> ``_graph_astar``, ``computeRouteOptions`` ->
``_compute_route_options``, ``selectRuntimeRouteOptions`` ->
``_select_runtime_route_options``).

This is an *estimate*, not the served pipeline: it does not do full-res theta*
refinement or a final legality assertion (those matter only when a route is
actually about to be shown to a player). Sampling + graph A* + selection is
enough to gauge whether a region will comfortably produce valid pairs.

Simplification vs. the harness: barriers ARE modelled (so >=2 distinct routes
are available for selection, matching ``selectRuntimeRouteOptions``'s need for
a route pair) but with straight-line-only barrier probing (no slide-window
search refinement) — cheap and representative for an estimate; see
``_find_barrier``.

Never allowed to break a build: the caller wraps this in try/except and
stores ``None`` on any failure.
"""

import heapq
import math
import random

import numpy as np

IMPASSABLE = 0

# --- Module constants (suitability sample size + warning thresholds) --------
SUITABILITY_N = 50            # target valid pairs per suitability estimate
SUITABILITY_SEED = 1          # deterministic sampling (reports are stable across rebuilds)
SUITABILITY_MAX_ATTEMPTS_PER_PAIR = 40  # bound: total attempts <= N * this
SUITABILITY_TIME_BUDGET_S = 8.0  # hard wall-clock cap regardless of attempts left

# Same tuning knobs as DEFAULT_CONFIG in scripts/navgraph_harness.mjs — kept in
# sync manually (see module docstring); Phase 5 may retune both together.
CONFIG = {
    "clearanceMinPx": 12,
    "terrainMinValue": 140,
    "distMinPx": 500,
    "distMaxPx": 1500,
    "goalSampleTries": 40,
    "obstacleMinRunPx": 8,
    "snapMaxDistPx": 200,
    "snapMaxTargets": 3,
    "snapAstarMargin": 16,
    "barrierMaxHalfPx": 60,
    "barrierStepPx": 4,          # coarser than the harness (perf; estimate only)
    "barrierMarginPx": 3,
    "sideGapMinPx": 40,
    "maxRelativeGap": 0.5,
    "routeAttempts": 4,
}

# Soft-warning thresholds shown in the editor (no hard block). A region is
# flagged when the estimate falls below/above these.
WARN_VALID_RATE_MIN = 0.15    # below this fraction of attempts yielding a served pair
WARN_MEAN_RETRIES_MAX = 6.0   # above this many rejected attempts per valid pair


def _line_cost(mask, W, x0, y0, x1, y1):
    """Full-res straight-line terrain cost, or ``None`` if it crosses an
    impassable pixel. Same model as ``navgraph._line_cost`` but takes a flat
    ``mask`` + width so it can be called against the raw 2-D array directly."""
    dx = x1 - x0
    dy = y1 - y0
    steps = int(max(abs(dx), abs(dy)))
    if steps == 0:
        return 0.0
    seg = math.hypot(dx, dy) / steps
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


def _crosses_obstacle(mask, ax, ay, bx, by, min_run_px):
    """True if the straight segment a->b crosses a contiguous impassable run
    of at least ``min_run_px`` (mirrors harness ``crossesObstacle``)."""
    dx = bx - ax
    dy = by - ay
    steps = int(max(abs(dx), abs(dy)))
    if steps == 0:
        return False
    sx = dx / steps
    sy = dy / steps
    run = 0
    max_run = 0
    for k in range(1, steps + 1):
        xi = int(round(ax + sx * k))
        yi = int(round(ay + sy * k))
        if mask[yi, xi] == IMPASSABLE:
            run += 1
            if run > max_run:
                max_run = run
        else:
            run = 0
    return max_run >= min_run_px


def _astar_subgrid_xy(mask, W, H, x0, y0, x1, y1, sx, sy, gx, gy, max_expansions=200_000):
    """Weighted 8-connected A* on ``mask[y0:y1, x0:x1]`` between full-res
    points (sx,sy)->(gx,gy). Returns cost or ``None``. Reimplemented (rather
    than reusing ``navgraph._astar_subgrid``) to take full-res coordinates
    directly, matching harness ``astarSubgrid``'s calling convention."""
    sub = mask[y0:y1, x0:x1]
    h, w = sub.shape
    lsx, lsy, lgx, lgy = sx - x0, sy - y0, gx - x0, gy - y0
    if lsx < 0 or lsy < 0 or lgx < 0 or lgy < 0 or lsx >= w or lsy >= h or lgx >= w or lgy >= h:
        return None
    data = sub.tobytes()
    if data[lsy * w + lsx] == IMPASSABLE or data[lgy * w + lgx] == IMPASSABLE:
        return None
    n = w * h
    INF = float("inf")
    g = [INF] * n
    closed = bytearray(n)
    start_i = lsy * w + lsx
    goal_i = lgy * w + lgx
    g[start_i] = 0.0
    heap = [(math.hypot(lgx - lsx, lgy - lsy), start_i)]
    push, pop = heapq.heappush, heapq.heappop
    SQRT2 = 1.4142135623730951
    w1, h1 = w - 1, h - 1
    expansions = 0
    while heap:
        _, cur = pop(heap)
        if closed[cur]:
            continue
        closed[cur] = 1
        if cur == goal_i:
            return g[cur]
        expansions += 1
        if expansions > max_expansions:
            return None
        cx = cur % w
        cy = cur // w
        gc = g[cur]
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                nx, ny = cx + dx, cy + dy
                if nx < 0 or ny < 0 or nx > w1 or ny > h1:
                    continue
                ni = ny * w + nx
                if closed[ni]:
                    continue
                val = data[ni]
                if val == IMPASSABLE:
                    continue
                step = SQRT2 if (dx != 0 and dy != 0) else 1.0
                tentative = gc + step * (255 - val)
                if tentative < g[ni]:
                    g[ni] = tentative
                    push(heap, (tentative + math.hypot(gx - (x0 + nx), gy - (y0 + ny)), ni))
    return None


class _State:
    """Precomputed reusable state for one suitability run (mirrors harness
    ``buildState``): main free component, sampleable coarse cells inside the
    hit zone, a node bucket grid for snapping, and CSR adjacency."""

    __slots__ = (
        "mask", "W", "H", "min_cost_per_px", "sample_cells", "coarse_scale",
        "buckets", "bucket_cell", "nodes", "node_in_region", "adj_start",
        "adj_to", "adj_w", "adj_edge", "edge_ux", "edge_uy", "edge_vx",
        "edge_vy",
    )


def _build_state(nodes, edges, weights, coarse_minval, coarse_clear, coarse_labels,
                  coarse_hitzone, coarse_scale, hitzone_scale, mask, min_cost_per_px):
    st = _State()
    st.mask = mask
    st.H, st.W = mask.shape
    st.min_cost_per_px = float(min_cost_per_px)
    st.nodes = nodes
    st.coarse_scale = int(coarse_scale)

    ch, cw = coarse_minval.shape
    hh, hw = coarse_hitzone.shape
    hz_ratio = hitzone_scale / coarse_scale  # unused directly; kept for parity/debug

    clear_ok = coarse_clear >= CONFIG["clearanceMinPx"]
    val_ok = coarse_minval >= CONFIG["terrainMinValue"]

    # Main free component = most frequent nonzero label in coarse_labels.
    labels_flat = coarse_labels.ravel()
    nz = labels_flat[labels_flat > 0]
    if nz.size:
        counts = np.bincount(nz)
        main_comp = int(counts.argmax())
    else:
        main_comp = 0
    comp_ok = coarse_labels == main_comp

    cy_idx, cx_idx = np.nonzero(clear_ok & val_ok & comp_ok)
    sample_cells = []
    if cy_idx.size:
        hy = np.minimum((cy_idx * coarse_scale) // hitzone_scale, hh - 1)
        hx = np.minimum((cx_idx * coarse_scale) // hitzone_scale, hw - 1)
        in_hz = coarse_hitzone[hy, hx] != 0
        sample_cells = list(zip(cy_idx[in_hz].tolist(), cx_idx[in_hz].tolist()))
    st.sample_cells = sample_cells

    # Region gate (mirrors the client router): the stored hit zone is
    # authoritative for the whole route, so nodes outside it are never
    # snapped to or expanded.
    N = len(nodes)
    if N:
        nodes_arr = np.asarray(nodes, dtype=np.int64)
        nhy = np.minimum(nodes_arr[:, 1] // hitzone_scale, hh - 1)
        nhx = np.minimum(nodes_arr[:, 0] // hitzone_scale, hw - 1)
        st.node_in_region = coarse_hitzone[nhy, nhx] != 0
    else:
        st.node_in_region = np.zeros(0, dtype=bool)

    # Node bucket grid for snapping.
    cell = max(1, CONFIG["snapMaxDistPx"])
    st.bucket_cell = cell
    buckets = {}
    for i in range(N):
        nx, ny = nodes[i]
        bx, by = int(nx // cell), int(ny // cell)
        buckets.setdefault((bx, by), []).append(i)
    st.buckets = buckets

    # CSR adjacency (undirected).
    deg = np.zeros(N, dtype=np.int64)
    if len(edges):
        np.add.at(deg, edges[:, 0], 1)
        np.add.at(deg, edges[:, 1], 1)
    adj_start = np.zeros(N + 1, dtype=np.int64)
    np.cumsum(deg, out=adj_start[1:])
    adj_to = np.zeros(int(adj_start[-1]), dtype=np.int64)
    adj_w = np.zeros(int(adj_start[-1]), dtype=np.float64)
    adj_edge = np.zeros(int(adj_start[-1]), dtype=np.int64)
    fill = adj_start[:N].copy()
    for e in range(len(edges)):
        u, v = int(edges[e, 0]), int(edges[e, 1])
        w = float(weights[e])
        adj_to[fill[u]] = v; adj_w[fill[u]] = w; adj_edge[fill[u]] = e; fill[u] += 1
        adj_to[fill[v]] = u; adj_w[fill[v]] = w; adj_edge[fill[v]] = e; fill[v] += 1
    st.adj_start, st.adj_to, st.adj_w, st.adj_edge = adj_start, adj_to, adj_w, adj_edge

    # Edge endpoint coordinate arrays for vectorized barrier intersection
    # tests (see _blocked_by_barriers).
    if len(edges):
        nodes_arr = np.asarray(nodes, dtype=np.float64)
        u_idx = edges[:, 0].astype(np.int64)
        v_idx = edges[:, 1].astype(np.int64)
        st.edge_ux = nodes_arr[u_idx, 0]
        st.edge_uy = nodes_arr[u_idx, 1]
        st.edge_vx = nodes_arr[v_idx, 0]
        st.edge_vy = nodes_arr[v_idx, 1]
    else:
        st.edge_ux = np.zeros(0)
        st.edge_uy = np.zeros(0)
        st.edge_vx = np.zeros(0)
        st.edge_vy = np.zeros(0)
    return st


def _pixel_in_cell(st, cy, cx, rng):
    """Random passable full-res pixel inside coarse cell (cy, cx), or None."""
    ds = st.coarse_scale
    x0, y0 = cx * ds, cy * ds
    W, H = st.W, st.H
    for _ in range(6):
        px = min(W - 1, x0 + rng.randrange(ds))
        py = min(H - 1, y0 + rng.randrange(ds))
        if st.mask[py, px] != IMPASSABLE:
            return px, py
    y1, x1 = min(y0 + ds, H), min(x0 + ds, W)
    block = st.mask[y0:y1, x0:x1]
    if block.size and int(block.max()) > IMPASSABLE:
        ys, xs = np.nonzero(block > IMPASSABLE)
        return int(x0 + xs[0]), int(y0 + ys[0])
    return None


def _sample_pair(st, rng):
    """Sample one endpoint pair. Returns ``(start, goal, dist)`` or
    ``(None, None, reason)`` on a prefilter reject — mirrors harness
    ``samplePair``."""
    cells = st.sample_cells
    if len(cells) < 2:
        return None, None, "empty"
    scy, scx = cells[rng.randrange(len(cells))]
    start = _pixel_in_cell(st, scy, scx, rng)
    if not start:
        return None, None, "empty"
    goal = None
    dist = 0.0
    for _ in range(CONFIG["goalSampleTries"]):
        gcy, gcx = cells[rng.randrange(len(cells))]
        g = _pixel_in_cell(st, gcy, gcx, rng)
        if not g:
            continue
        d = math.hypot(g[0] - start[0], g[1] - start[1])
        if CONFIG["distMinPx"] <= d <= CONFIG["distMaxPx"]:
            goal, dist = g, d
            break
    if not goal:
        return None, None, "distance"
    if not _crosses_obstacle(st.mask, start[0], start[1], goal[0], goal[1], CONFIG["obstacleMinRunPx"]):
        return None, None, "obstacle"
    return (start, goal, dist), None, None


def _snap_endpoint(st, pt):
    """Connect a full-res endpoint to <=snapMaxTargets nearest graph nodes via
    local full-res A* stubs. Returns ``[(node, w), ...]`` (mirrors harness
    ``snapEndpoint``)."""
    px, py = pt
    cell = st.bucket_cell
    bx, by = int(px // cell), int(py // cell)
    cand = []
    for gx in (bx - 1, bx, bx + 1):
        for gy in (by - 1, by, by + 1):
            for ni in st.buckets.get((gx, gy), ()):
                # Routes must never touch a node outside the stored region.
                if not st.node_in_region[ni]:
                    continue
                nx, ny = st.nodes[ni]
                d = math.hypot(nx - px, ny - py)
                if d <= CONFIG["snapMaxDistPx"]:
                    cand.append((d, ni))
    cand.sort(key=lambda c: c[0])
    out = []
    W, H = st.W, st.H
    for d, ni in cand:
        if len(out) >= CONFIG["snapMaxTargets"]:
            break
        nx, ny = st.nodes[ni]
        cost = _line_cost(st.mask, W, px, py, nx, ny)
        if cost is None:
            m = CONFIG["snapAstarMargin"]
            x0 = max(0, min(px, nx) - m)
            y0 = max(0, min(py, ny) - m)
            x1 = min(W, max(px, nx) + m + 1)
            y1 = min(H, max(py, ny) + m + 1)
            cost = _astar_subgrid_xy(st.mask, W, H, x0, y0, x1, y1, px, py, nx, ny)
            if cost is None:
                continue
        out.append((ni, cost))
    return out


def _graph_astar(st, goal_pt, start_snap, goal_snap, blocked_edges=None):
    """A* over the navgraph with virtual start/goal nodes (mirrors harness
    ``graphAstar``). Returns ``(node_path, cost)`` or ``None``. Node ids
    N and N+1 denote the virtual start/goal. ``blocked_edges`` (optional) is a
    boolean array (E,) — edge ``e`` is skipped when ``blocked_edges[e]``."""
    N = len(st.nodes)
    START, GOAL, TOTAL = N, N + 1, N + 2
    goal_x, goal_y = goal_pt
    INF = float("inf")
    g = [INF] * TOTAL
    parent = [-1] * TOTAL
    closed = bytearray(TOTAL)
    goal_from = dict(goal_snap)
    g[START] = 0.0
    heap = [(0.0, START)]
    push, pop = heapq.heappush, heapq.heappop
    mcpp = st.min_cost_per_px
    hypot = math.hypot
    nodes = st.nodes
    adj_start, adj_to, adj_w, adj_edge = st.adj_start, st.adj_to, st.adj_w, st.adj_edge
    blocked = blocked_edges

    def h_euclid(nx, ny):
        return hypot(goal_x - nx, goal_y - ny) * mcpp

    while heap:
        _, cur = pop(heap)
        if closed[cur]:
            continue
        closed[cur] = 1
        if cur == GOAL:
            path = []
            p = cur
            while p != -1:
                path.append(p)
                p = parent[p]
            path.reverse()
            return path, g[GOAL]
        gc = g[cur]
        if cur == START:
            for ni, w in start_snap:
                tentative = gc + w
                if tentative < g[ni]:
                    g[ni] = tentative
                    parent[ni] = cur
                    nx, ny = nodes[ni]
                    push(heap, (tentative + h_euclid(nx, ny), ni))
        else:
            s0, s1 = adj_start[cur], adj_start[cur + 1]
            in_region = st.node_in_region
            for e in range(s0, s1):
                if blocked is not None and blocked[adj_edge[e]]:
                    continue
                to = adj_to[e]
                # A node outside the stored region may never appear on a path.
                if not in_region[to]:
                    continue
                tentative = gc + adj_w[e]
                if tentative < g[to]:
                    g[to] = tentative
                    parent[to] = cur
                    nx, ny = nodes[to]
                    push(heap, (tentative + h_euclid(nx, ny), to))
            if cur in goal_from:
                tentative = gc + goal_from[cur]
                if tentative < g[GOAL]:
                    g[GOAL] = tentative
                    parent[GOAL] = cur
                    push(heap, (tentative, GOAL))
    return None


def _node_path_to_coords(st, node_path, start, goal):
    N = len(st.nodes)
    pts = []
    for nid in node_path:
        if nid == N:
            pts.append(start)
        elif nid == N + 1:
            pts.append(goal)
        else:
            pts.append(tuple(st.nodes[nid]))
    return pts


def _path_length(path):
    total = 0.0
    for i in range(1, len(path)):
        total += math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
    return total


def _in_obstacle(mask, W, H, x, y):
    xi, yi = int(round(x)), int(round(y))
    if xi < 0 or yi < 0 or xi >= W or yi >= H:
        return True
    return mask[yi, xi] == IMPASSABLE


def _find_barrier(st, path):
    """Perpendicular barrier near the route midpoint anchored in obstacles on
    both sides (simplified port of harness ``findBarrier``: single probe at
    the midpoint rather than a slide-window search — cheap and good enough to
    force a distinct alternate route for the estimate). Returns
    ``(ax, ay, bx, by)`` or ``None``."""
    total = _path_length(path)
    if total < 1e-6:
        return None
    mask, W, H = st.mask, st.W, st.H
    MAX_HALF = CONFIG["barrierMaxHalfPx"]
    STEP = CONFIG["barrierStepPx"]
    MARGIN = CONFIG["barrierMarginPx"]
    target = total * 0.5
    accum = 0.0
    for i in range(1, len(path)):
        ax, ay = path[i - 1]
        bx, by = path[i]
        seg_len = math.hypot(bx - ax, by - ay)
        if accum + seg_len >= target:
            t = (target - accum) / (seg_len or 1)
            mx = ax + (bx - ax) * t
            my = ay + (by - ay) * t
            norm = seg_len or 1
            px = -(by - ay) / norm
            py = (bx - ax) / norm
            left_dist, right_dist = MAX_HALF, MAX_HALF
            left_hit = right_hit = False
            d = STEP
            while d <= MAX_HALF:
                if _in_obstacle(mask, W, H, mx + px * d, my + py * d):
                    left_dist, left_hit = d, True
                    break
                d += STEP
            d = STEP
            while d <= MAX_HALF:
                if _in_obstacle(mask, W, H, mx - px * d, my - py * d):
                    right_dist, right_hit = d, True
                    break
                d += STEP
            if not (left_hit and right_hit):
                return None
            return (
                mx + px * (left_dist + MARGIN), my + py * (left_dist + MARGIN),
                mx - px * (right_dist + MARGIN), my - py * (right_dist + MARGIN),
            )
        accum += seg_len
    return None


def _seg_intersect(ax, ay, bx, by, cx, cy, dx, dy):
    """Scalar reference implementation (kept for clarity/tests); the hot path
    used by ``_blocked_by_barriers`` is the vectorized ``_seg_intersect_np``."""
    def o(px, py, qx, qy, rx, ry):
        val = (qy - py) * (rx - qx) - (qx - px) * (ry - qy)
        return 1 if val > 1e-9 else (-1 if val < -1e-9 else 0)
    o1, o2 = o(ax, ay, bx, by, cx, cy), o(ax, ay, bx, by, dx, dy)
    o3, o4 = o(cx, cy, dx, dy, ax, ay), o(cx, cy, dx, dy, bx, by)
    return o1 != o2 and o3 != o4


def _orient_np(px, py, qx, qy, rx, ry):
    """Vectorized sign of the cross product (qy-py)*(rx-qx)-(qx-px)*(ry-qy)."""
    val = (qy - py) * (rx - qx) - (qx - px) * (ry - qy)
    return np.sign(np.where(np.abs(val) > 1e-9, val, 0.0))


def _seg_intersect_np(ux, uy, vx, vy, ax, ay, bx, by):
    """All-edges-vs-one-barrier segment intersection test, vectorized over the
    edge arrays ``ux, uy, vx, vy`` (each shape (E,)). Barrier endpoints
    ``ax, ay, bx, by`` are scalars. Returns a boolean array (E,)."""
    o1 = _orient_np(ux, uy, vx, vy, ax, ay)
    o2 = _orient_np(ux, uy, vx, vy, bx, by)
    o3 = _orient_np(ax, ay, bx, by, ux, uy)
    o4 = _orient_np(ax, ay, bx, by, vx, vy)
    return (o1 != o2) & (o3 != o4)


def _blocked_by_barriers(st, edges, barriers):
    """Edge indices whose node-node segment crosses any active barrier.
    Vectorized over all edges per barrier (edge count can be in the tens of
    thousands; a pure-Python double loop over edges x barriers dominated
    runtime in profiling)."""
    if not barriers:
        return None
    blocked = np.zeros(len(edges), dtype=bool)
    ux, uy = st.edge_ux, st.edge_uy
    vx, vy = st.edge_vx, st.edge_vy
    for (ax, ay, bx, by) in barriers:
        blocked |= _seg_intersect_np(ux, uy, vx, vy, ax, ay, bx, by)
    return blocked


def _compute_route_options(st, edges, start, goal, start_snap, goal_snap):
    """Up to ``routeAttempts`` distinct routes for a snapped pair, forcing a
    perpendicular barrier between attempts (mirrors harness
    ``computeRouteOptions``). Returns ``(paths, reason)`` where each path is
    ``{"path": [...], "len": float, "cost": float}``."""
    barriers = []
    paths = []
    seen = set()
    for attempt in range(CONFIG["routeAttempts"]):
        blocked = _blocked_by_barriers(st, edges, barriers)
        res = _graph_astar(st, goal, start_snap, goal_snap, blocked)
        if not res or len(res[0]) < 2:
            break
        node_path, cost = res
        sig = tuple(node_path)
        if sig in seen:
            break
        seen.add(sig)
        coords = _node_path_to_coords(st, node_path, start, goal)
        paths.append({"path": coords, "len": _path_length(coords), "cost": cost})
        if attempt >= CONFIG["routeAttempts"] - 1:
            break
        barrier = _find_barrier(st, coords)
        if not barrier:
            break
        barriers.append(barrier)
    if not paths:
        reason = "unreachable"
    elif len(paths) == 1:
        reason = "distinct"
    else:
        reason = "ok"
    return paths, reason


def _select_runtime_route_options(start, goal, paths, reason):
    """Select the two routes to serve (port of ``infinite_play.selectRuntime
    RouteOptions`` / harness ``selectRuntimeRouteOptions``). Graph cost is
    used directly as runtime (no NoA model in this estimate)."""
    if not paths:
        return False, reason or "unreachable"
    if len(paths) == 1:
        return False, "distinct"

    sx, sy = start
    gx, gy = goal
    sg_dx, sg_dy = gx - sx, gy - sy
    sg_len = math.hypot(sg_dx, sg_dy) or 1.0

    enriched = []
    for p in paths:
        s = 0.0
        for (px, py) in p["path"]:
            s += sg_dx * (py - sy) - sg_dy * (px - sx)
        side = (s / len(p["path"])) / sg_len
        enriched.append({**p, "run_time": p["cost"], "side": side})
    enriched.sort(key=lambda p: p["run_time"])

    best = None
    for i in range(len(enriched)):
        for j in range(i + 1, len(enriched)):
            a, b = enriched[i], enriched[j]
            faster, slower = min(a["run_time"], b["run_time"]), max(a["run_time"], b["run_time"])
            rel_gap = (slower - faster) / faster if faster > 0 else float("inf")
            abs_gap = slower - faster
            total = a["run_time"] + b["run_time"]
            side_gap = abs(a["side"] - b["side"])
            same_side = a["side"] * b["side"] >= 0
            cand = (rel_gap, abs_gap, total, side_gap, same_side, a, b)
            if side_gap < CONFIG["sideGapMinPx"] or same_side:
                continue
            if best is None or (cand[0], cand[1], cand[2]) < (best[0], best[1], best[2]):
                best = cand
    if best is None:
        return False, "side"
    rel_gap, abs_gap, total, side_gap, _same, a, b = best
    route_side_min = side_gap / 4
    if abs(a["side"]) < route_side_min or abs(b["side"]) < route_side_min:
        return False, "routeside"
    if rel_gap > CONFIG["maxRelativeGap"]:
        return False, "runtime"
    return True, "ok"


def simulate_suitability(artifact, mask, n=SUITABILITY_N, seed=SUITABILITY_SEED,
                          max_attempts=None, time_budget_s=SUITABILITY_TIME_BUDGET_S):
    """Run the pair-generation estimate over an in-memory navgraph artifact.

    ``artifact`` is the dict ``build_navgraph()`` returns (before saving);
    ``mask`` is the full-res mask array already loaded by the caller. Returns
    a JSON-serializable dict:

        {valid_rate, mean_retries, mean_ms, n_attempts, n_valid, reasons,
         warn}

    or raises on internal failure — callers must wrap this in try/except
    (see ``build_navgraph``) since a simulation bug must never break a build.
    """
    import time as _time

    if max_attempts is None:
        max_attempts = n * SUITABILITY_MAX_ATTEMPTS_PER_PAIR

    nodes = artifact["nodes"]
    edges = artifact["edges"]
    weights = artifact["weights"]
    coarse_minval = artifact["coarse_minval"]
    coarse_clear = artifact["coarse_clear"]
    coarse_labels = artifact["coarse_labels"]
    coarse_hitzone = artifact["coarse_hitzone"]
    coarse_scale = int(artifact["coarse_scale"])
    hitzone_scale = int(artifact["hitzone_scale"])
    min_cost_per_px = float(artifact["min_cost_per_px"])

    st = _build_state(nodes, edges, weights, coarse_minval, coarse_clear,
                       coarse_labels, coarse_hitzone, coarse_scale, hitzone_scale,
                       mask, min_cost_per_px)

    rng = random.Random(seed)
    t_deadline = _time.time() + time_budget_s

    reasons = {}
    n_valid = 0
    n_attempts = 0
    total_retries = 0
    total_ms_valid = 0.0
    since_valid = 0

    def bump(reason):
        reasons[reason] = reasons.get(reason, 0) + 1

    while n_attempts < max_attempts and n_valid < n and _time.time() < t_deadline:
        n_attempts += 1
        t0 = _time.time()
        sample, _none, reason = _sample_pair(st, rng)
        if sample is None:
            bump(reason)
            since_valid += 1
            continue
        start, goal, _dist = sample
        start_snap = _snap_endpoint(st, start)
        goal_snap = _snap_endpoint(st, goal)
        if not start_snap or not goal_snap:
            bump("snap")
            since_valid += 1
            continue
        paths, route_reason = _compute_route_options(st, edges, start, goal, start_snap, goal_snap)
        ok, sel_reason = _select_runtime_route_options(start, goal, paths, route_reason)
        bump(sel_reason)
        if ok:
            n_valid += 1
            total_retries += since_valid
            total_ms_valid += (_time.time() - t0) * 1000.0
            since_valid = 0
        else:
            since_valid += 1

    valid_rate = round(n_valid / n_attempts, 4) if n_attempts else 0.0
    mean_retries = round(total_retries / n_valid, 2) if n_valid else None
    mean_ms = round(total_ms_valid / n_valid, 2) if n_valid else None

    warn = (valid_rate < WARN_VALID_RATE_MIN) or (mean_retries is not None and mean_retries > WARN_MEAN_RETRIES_MAX) \
        or n_valid == 0

    return {
        "valid_rate": valid_rate,
        "mean_retries": mean_retries,
        "mean_ms": mean_ms,
        "n_attempts": n_attempts,
        "n_valid": n_valid,
        "reasons": reasons,
        "warn": bool(warn),
    }
