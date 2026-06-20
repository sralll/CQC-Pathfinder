"""Canonical Python implementation of route NoA + runtime calculations.

The same algorithm is implemented in JavaScript in
`project/static/project/js/editor.js` (functions `calcRouteNoA` and
`calcRouteRunTime`). Whenever you change one, change the other to match.

Used from:
    * `project/migrations/0002_migrate_data_from_publishedfile.py`
    * `results/management/commands/recalc_route_runtimes.py`
"""

import math


# Constants shared with the editor
PX_TO_M                       = 0.48       # pixel → metre
REFERENCE_MAP_SCALE           = 4000
RUN_SPEED                     = 4.75       # m/s on flat ground
NOA_CLUSTER_WINDOW_M          = 20         # route-direction cluster window
NOA_COUNTER_TURN_WINDOW_M     = 10         # rapid left-right/right-left window
NOA_ARTIFACT_WINDOW_M         = 5          # suppress tiny local zigzags
NOA_MIN_SEGMENT_M             = 1.5        # filter short route-point artefacts
NOA_CORNER_DEG                = 90         # 90 degrees ~= 1 noA / 1 second
NOA_EPSILON_DEG               = 2          # ignore micro-changes smaller than this
NOA_MIN_EFFECT_DEG            = 45
NOA_COUNTER_MIN_DEG           = 45
NOA_PENALTY_SECONDS_PER       = 1.0        # 1 s added per corner to the runtime estimate
ALT_FLAT_EQUIV_M              = 4.0        # 1 m of elevation ≈ this many metres of flat running
                                           # (sprint/urban rule of thumb; ≈ 0.84 s per metre at
                                           # RUN_SPEED). Routes start and end at the same height,
                                           # so `elevation` is the extra climb done in between.


def _normalize_turn_rad(angle):
    while angle > math.pi:
        angle -= 2 * math.pi
    while angle < -math.pi:
        angle += 2 * math.pi
    return angle


def _round_noA(value):
    return math.floor(value * 10 + 0.5) / 10


def _scale_factor(scale):
    try:
        scale = float(scale)
    except (TypeError, ValueError):
        return 1.0
    return scale if scale > 0 else 1.0


def _map_scale_factor(map_scale=None):
    try:
        map_scale = float(map_scale)
    except (TypeError, ValueError):
        return 1.0
    return map_scale / REFERENCE_MAP_SCALE if map_scale > 0 else 1.0


def noa_distance_window(scale=None):
    return NOA_CLUSTER_WINDOW_M / (PX_TO_M * _scale_factor(scale))


def _scaled_noA_points(points, scale=None, map_scale=None):
    factor = _scale_factor(scale) * _map_scale_factor(map_scale)
    out = []
    for point in points or []:
        x = point.get("x")
        y = point.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        out.append({"x": x * factor, "y": y * factor})
    return out


def _simplified_noA_points(points):
    out = []
    min_step_px = NOA_MIN_SEGMENT_M / PX_TO_M
    for point in points or []:
        x = point.get("x")
        y = point.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        current = {"x": x, "y": y}
        if not out or math.hypot(current["x"] - out[-1]["x"], current["y"] - out[-1]["y"]) >= min_step_px:
            out.append(current)

    if out and points:
        last = points[-1]
        x = last.get("x")
        y = last.get("y")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            out[-1] = {"x": x, "y": y}
    return out


def calc_route_noA_old_windowed(rP, scale=None, map_scale=None):
    """Count corners along a polyline using a windowed cumulative-turn rule.

    Walks the polyline segment-by-segment. At each junction the absolute
    turn angle is computed (in radians, [0, π]).

    * If a single junction turn is ≥ ``NOA_CORNER_DEG`` it counts as one
      corner on its own — adjacent sharp turns are counted individually
      (no skip-ahead suppression).
    * Smaller turns accumulate into a sliding window of length
      ``noa_distance_window(scale)`` pixels. When the sum of turns in
      the window reaches the corner threshold, a corner is counted and
      the window is cleared.
    * Turns outside the window (more than ``window`` pixels behind the
      current position) drop off, so isolated small bends along long
      straight stretches never sum to a corner.

    `rP` is a list of dicts with `x`/`y` keys (the editor's storage format).
    """
    if not rP or len(rP) < 3:
        return 0

    window     = noa_distance_window(scale) / _map_scale_factor(map_scale)
    corner_rad = math.radians(NOA_CORNER_DEG)
    eps_rad    = math.radians(NOA_EPSILON_DEG)

    # Cumulative pixel-distance and per-segment heading
    cum      = [0.0]
    headings = []
    for i in range(1, len(rP)):
        dx = rP[i]['x'] - rP[i - 1]['x']
        dy = rP[i]['y'] - rP[i - 1]['y']
        cum.append(cum[-1] + math.hypot(dx, dy))
        headings.append(None if dx == 0 and dy == 0 else math.atan2(dy, dx))

    # Collect non-trivial turns (position along polyline, magnitude in rad)
    turns = []
    for i in range(1, len(headings)):
        h1, h2 = headings[i - 1], headings[i]
        if h1 is None or h2 is None:
            continue
        t = abs(h2 - h1)
        if t > math.pi:
            t = 2 * math.pi - t
        if t < eps_rad:
            continue
        # `cum[i]` is the cumulative distance to the START of segment i,
        # which IS the junction point between segment i-1 and segment i.
        turns.append((cum[i], t))

    noA = 0
    window_turns = []   # list of (position, magnitude) inside the window

    for pos, t in turns:
        # Drop turns that have fallen out of the window behind us
        while window_turns and pos - window_turns[0][0] > window:
            window_turns.pop(0)

        if t >= corner_rad:
            # Sharp single-junction corner — count immediately,
            # clear the window so it doesn't contribute again.
            noA += 1
            window_turns = []
            continue

        window_turns.append((pos, t))
        if sum(item[1] for item in window_turns) >= corner_rad:
            noA += 1
            window_turns = []

    return noA


def calc_route_noA(rP, scale=None, map_scale=None):
    """Return the fractional turn penalty for a route polyline."""
    rP = _simplified_noA_points(_scaled_noA_points(rP, scale, map_scale))
    if not rP or len(rP) < 3:
        return 0

    eps_rad = math.radians(NOA_EPSILON_DEG)

    cum = [0.0]
    headings = []
    seg_len = []
    for i in range(1, len(rP)):
        dx = rP[i]["x"] - rP[i - 1]["x"]
        dy = rP[i]["y"] - rP[i - 1]["y"]
        length = math.hypot(dx, dy) * PX_TO_M
        cum.append(cum[-1] + length)
        seg_len.append(length)
        headings.append(None if dx == 0 and dy == 0 else math.atan2(dy, dx))

    turns = []
    for i in range(1, len(headings)):
        h1, h2 = headings[i - 1], headings[i]
        if h1 is None or h2 is None:
            continue
        signed = _normalize_turn_rad(h2 - h1)
        abs_turn = abs(signed)
        if abs_turn < eps_rad:
            continue
        if min(seg_len[i - 1], seg_len[i]) < NOA_MIN_SEGMENT_M:
            continue
        turns.append({
            "pos": cum[i],
            "signed_deg": math.degrees(signed),
            "abs_deg": math.degrees(abs_turn),
        })

    noA = 0.0
    i = 0
    while i < len(turns):
        cluster = [turns[i]]
        i += 1
        while i < len(turns) and turns[i]["pos"] - cluster[0]["pos"] <= NOA_CLUSTER_WINDOW_M:
            cluster.append(turns[i])
            i += 1

        span = cluster[-1]["pos"] - cluster[0]["pos"]
        total_abs = sum(turn["abs_deg"] for turn in cluster)
        net = abs(sum(turn["signed_deg"] for turn in cluster))
        max_turn = max(turn["abs_deg"] for turn in cluster)
        if span <= NOA_ARTIFACT_WINDOW_M and net < NOA_MIN_EFFECT_DEG and total_abs >= NOA_CORNER_DEG:
            continue

        direction_deg = max(max_turn, net)
        if direction_deg >= NOA_MIN_EFFECT_DEG or total_abs >= NOA_CORNER_DEG:
            noA += direction_deg / NOA_CORNER_DEG

        counter_deg = 0.0
        for j in range(len(cluster)):
            local_abs = 0.0
            local_net = 0.0
            for k in range(j, len(cluster)):
                if cluster[k]["pos"] - cluster[j]["pos"] > NOA_COUNTER_TURN_WINDOW_M:
                    break
                local_abs += cluster[k]["abs_deg"]
                local_net += cluster[k]["signed_deg"]
            counter_deg = max(counter_deg, local_abs - abs(local_net))
        if counter_deg >= NOA_COUNTER_MIN_DEG:
            noA += counter_deg / (2 * NOA_CORNER_DEG)

    return _round_noA(noA)


def calc_route_runtime(length_m, noA, elevation_m, obstacle_s=0):
    """Predict the running time (seconds) for a route.

        run_time = (length + ALT_FLAT_EQUIV_M × elevation) / RUN_SPEED
                   + 1 s × noA + obstacle_s

    Every metre of climb is charged as `ALT_FLAT_EQUIV_M` metres of flat
    running, so elevation just lengthens the effective distance. This keeps
    the model linear and easy to explain (each metre of elevation costs a
    fixed number of seconds), and it can never make a hillier route faster.
    """
    if not length_m:
        return None
    noA_penalty = (noA or 0) * NOA_PENALTY_SECONDS_PER
    try:
        obstacle_penalty = float(obstacle_s or 0)
    except (TypeError, ValueError):
        obstacle_penalty = 0
    flat_equiv = length_m + ALT_FLAT_EQUIV_M * (elevation_m or 0)
    return flat_equiv / RUN_SPEED + noA_penalty + obstacle_penalty


def calc_route_length(rP, scale=None, map_scale=None):
    """Polyline length in METRES (matches the editor's `calcRouteLength`)."""
    if not rP or len(rP) < 2:
        return 0
    factor = _scale_factor(scale) * _map_scale_factor(map_scale)
    total = 0.0
    for i in range(1, len(rP)):
        dx = (rP[i]['x'] - rP[i - 1]['x']) * factor
        dy = (rP[i]['y'] - rP[i - 1]['y']) * factor
        total += math.hypot(dx, dy) * PX_TO_M
    return round(total)
