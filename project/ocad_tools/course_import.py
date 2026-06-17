import math
import re
import xml.etree.ElementTree as ET

from ..runtime import calc_route_length, calc_route_noA, calc_route_runtime


SVG_NS = "{http://www.w3.org/2000/svg}"
PURPLE_RE = re.compile(r"(?:rgb\(\s*166\s*,\s*38\s*,\s*255\s*\)|#a626ff)", re.I)
SYM_RE = re.compile(r"Sym_(\d+)", re.I)
ROUTE_GROUP_RE = re.compile(r"Sym_(106\d+(?:\.\d+)?)", re.I)
PATH_TOKEN_RE = re.compile(
    r"[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
)


def _local_name(tag):
    return tag[len(SVG_NS):] if tag.startswith(SVG_NS) else tag


def _to_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _round_point(point):
    return {"x": round(point["x"], 2), "y": round(point["y"], 2)}


def _append_route_points(target, points, min_distance=2):
    for point in points:
        if not (math.isfinite(point["x"]) and math.isfinite(point["y"])):
            continue
        prev = target[-1] if target else None
        if prev and math.hypot(prev["x"] - point["x"], prev["y"] - point["y"]) < min_distance:
            continue
        target.append(_round_point(point))


def _calc_route_side(cp, route):
    rP = route.get("rP") or []
    start = cp.get("start")
    ziel = cp.get("ziel")
    if not rP or not start or not ziel:
        return None
    dx = ziel["x"] - start["x"]
    dy = ziel["y"] - start["y"]
    return sum(dx * (p["y"] - start["y"]) - dy * (p["x"] - start["x"]) for p in rP) / len(rP)


def _make_route(rP, cp, order, source=None):
    route = {
        "id": None,
        "order": order,
        "rP": rP,
        "noA": None,
        "pos": None,
        "length": None,
        "run_time": None,
        "elevation": 0,
    }
    route["length"] = calc_route_length(rP)
    route["noA"] = calc_route_noA(rP)
    route["run_time"] = calc_route_runtime(route["length"], route["noA"], route["elevation"])
    route["pos"] = _calc_route_side(cp, route)
    if source:
        route["source"] = source
    return route


def _identity():
    return (1, 0, 0, 1, 0, 0)


def _mat_mul(left, right):
    a1, b1, c1, d1, e1, f1 = left
    a2, b2, c2, d2, e2, f2 = right
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def _apply_mat(matrix, point):
    a, b, c, d, e, f = matrix
    x, y = point
    return {"x": a * x + c * y + e, "y": b * x + d * y + f}


def _parse_transform(value):
    matrix = _identity()
    if not value:
        return matrix
    for name, raw_args in re.findall(r"([a-zA-Z]+)\(([^)]*)\)", value):
        args = [_to_float(v, 0) for v in re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", raw_args)]
        name = name.lower()
        if name == "matrix" and len(args) >= 6:
            local = tuple(args[:6])
        elif name == "translate":
            local = (1, 0, 0, 1, args[0] if args else 0, args[1] if len(args) > 1 else 0)
        elif name == "scale":
            sx = args[0] if args else 1
            sy = args[1] if len(args) > 1 else sx
            local = (sx, 0, 0, sy, 0, 0)
        elif name == "rotate" and args:
            angle = math.radians(args[0])
            cos_a = math.cos(angle)
            sin_a = math.sin(angle)
            rot = (cos_a, sin_a, -sin_a, cos_a, 0, 0)
            if len(args) >= 3:
                cx, cy = args[1], args[2]
                local = _mat_mul(_mat_mul((1, 0, 0, 1, cx, cy), rot), (1, 0, 0, 1, -cx, -cy))
            else:
                local = rot
        else:
            continue
        matrix = _mat_mul(matrix, local)
    return matrix


def _numbers_from_path(d):
    return [_to_float(v, 0) for v in re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", d or "")]


def _path_bbox(d, transform):
    nums = _numbers_from_path(d)
    points = []
    for i in range(0, len(nums) - 1, 2):
        points.append(_apply_mat(transform, (nums[i], nums[i + 1])))
    if not points:
        return None
    return {
        "min_x": min(p["x"] for p in points),
        "max_x": max(p["x"] for p in points),
        "min_y": min(p["y"] for p in points),
        "max_y": max(p["y"] for p in points),
    }


def _parse_path_points(d, transform):
    tokens = PATH_TOKEN_RE.findall(d or "")
    points = []
    i = 0
    cmd = None
    current = (0.0, 0.0)
    start = None

    def is_cmd(index):
        return index < len(tokens) and re.match(r"^[A-Za-z]$", tokens[index])

    def read_num():
        nonlocal i
        value = _to_float(tokens[i], 0)
        i += 1
        return value

    while i < len(tokens):
        if is_cmd(i):
            cmd = tokens[i]
            i += 1
        if not cmd:
            break
        upper = cmd.upper()
        rel = cmd.islower()

        def absolutize(x, y):
            return (current[0] + x, current[1] + y) if rel else (x, y)

        if upper == "M":
            first = True
            while i + 1 < len(tokens) and not is_cmd(i):
                current = absolutize(read_num(), read_num())
                if first:
                    start = current
                    first = False
                points.append(_apply_mat(transform, current))
            cmd = "l" if rel else "L"
        elif upper == "L":
            while i + 1 < len(tokens) and not is_cmd(i):
                current = absolutize(read_num(), read_num())
                points.append(_apply_mat(transform, current))
        elif upper == "H":
            while i < len(tokens) and not is_cmd(i):
                x = read_num()
                current = (current[0] + x, current[1]) if rel else (x, current[1])
                points.append(_apply_mat(transform, current))
        elif upper == "V":
            while i < len(tokens) and not is_cmd(i):
                y = read_num()
                current = (current[0], current[1] + y) if rel else (current[0], y)
                points.append(_apply_mat(transform, current))
        elif upper == "C":
            while i + 5 < len(tokens) and not is_cmd(i):
                read_num(); read_num()
                read_num(); read_num()
                current = absolutize(read_num(), read_num())
                points.append(_apply_mat(transform, current))
        elif upper == "S" or upper == "Q":
            step = 4
            while i + step - 1 < len(tokens) and not is_cmd(i):
                for _ in range(step - 2):
                    read_num()
                current = absolutize(read_num(), read_num())
                points.append(_apply_mat(transform, current))
        elif upper == "T":
            while i + 1 < len(tokens) and not is_cmd(i):
                current = absolutize(read_num(), read_num())
                points.append(_apply_mat(transform, current))
        elif upper == "A":
            while i + 6 < len(tokens) and not is_cmd(i):
                for _ in range(5):
                    read_num()
                current = absolutize(read_num(), read_num())
                points.append(_apply_mat(transform, current))
        elif upper == "Z":
            if start:
                current = start
                points.append(_apply_mat(transform, current))
        else:
            break
    return points


def _path_length(points):
    return sum(
        math.hypot(points[i]["x"] - points[i - 1]["x"], points[i]["y"] - points[i - 1]["y"])
        for i in range(1, len(points))
    )


def _is_purple(value):
    return bool(value and PURPLE_RE.search(value))


def _svg_paths(root):
    paths = []

    def walk(node, context):
        attrs = node.attrib
        ids = context["ids"][:]
        node_id = attrs.get("id")
        if node_id:
            ids.append(node_id)
        stroke = attrs.get("stroke", context.get("stroke"))
        fill = attrs.get("fill", context.get("fill"))
        stroke_width = attrs.get("stroke-width", context.get("stroke_width"))
        style = attrs.get("style", "")
        if "stroke:" in style:
            m = re.search(r"stroke\s*:\s*([^;]+)", style)
            if m:
                stroke = m.group(1).strip()
        if "fill:" in style:
            m = re.search(r"fill\s*:\s*([^;]+)", style)
            if m:
                fill = m.group(1).strip()
        if "stroke-width:" in style:
            m = re.search(r"stroke-width\s*:\s*([^;]+)", style)
            if m:
                stroke_width = m.group(1).strip()
        transform = _mat_mul(context["transform"], _parse_transform(attrs.get("transform")))

        next_context = {
            "ids": ids,
            "stroke": stroke,
            "fill": fill,
            "stroke_width": stroke_width,
            "transform": transform,
        }

        route_group = None
        for value in reversed(ids):
            match = ROUTE_GROUP_RE.search(value)
            if match:
                route_group = value
                break

        tag_name = _local_name(node.tag)
        if tag_name == "path":
            d = attrs.get("d", "")
            sym = None
            for value in reversed(ids):
                match = SYM_RE.search(value)
                if match:
                    sym = match.group(1)
                    break
            points = _parse_path_points(d, transform)
            paths.append({
                "tag": "path",
                "ids": ids,
                "sym": sym,
                "route_group": route_group,
                "stroke": stroke,
                "fill": fill,
                "stroke_width": _to_float(stroke_width),
                "points": points,
                "bbox": _path_bbox(d, transform),
                "length": _path_length(points),
            })
        elif tag_name == "circle":
            cx = _to_float(attrs.get("cx"))
            cy = _to_float(attrs.get("cy"))
            radius = _to_float(attrs.get("r"), 0) or 0
            if cx is not None and cy is not None:
                center = _apply_mat(transform, (cx, cy))
                sym = None
                for value in reversed(ids):
                    match = SYM_RE.search(value)
                    if match:
                        sym = match.group(1)
                        break
                paths.append({
                    "tag": "circle",
                    "ids": ids,
                    "sym": sym,
                    "route_group": route_group,
                    "stroke": stroke,
                    "fill": fill,
                    "stroke_width": _to_float(stroke_width),
                    "points": [center],
                    "bbox": {
                        "min_x": center["x"] - radius,
                        "max_x": center["x"] + radius,
                        "min_y": center["y"] - radius,
                        "max_y": center["y"] + radius,
                    },
                    "length": 0,
                })

        for child in list(node):
            walk(child, next_context)

    walk(root, {"ids": [], "stroke": None, "fill": None, "stroke_width": None, "transform": _identity()})
    return paths


def _parse_view_box(root):
    raw = root.attrib.get("viewBox")
    if raw:
        parts = [_to_float(v) for v in re.split(r"[\s,]+", raw.strip()) if v]
        if len(parts) == 4 and all(v is not None for v in parts) and parts[2] > 0 and parts[3] > 0:
            return tuple(parts)
    width = _to_float(re.sub(r"[^\d.+-].*$", "", root.attrib.get("width", "")))
    height = _to_float(re.sub(r"[^\d.+-].*$", "", root.attrib.get("height", "")))
    return (0, 0, width or 1, height or 1)


def _dedupe_markers(markers, tolerance):
    out = []
    for marker in markers:
        if any(math.hypot(marker["point"]["x"] - m["point"]["x"], marker["point"]["y"] - m["point"]["y"]) <= tolerance for m in out):
            continue
        out.append(marker)
    return out


def _nearest_marker(point, markers, max_distance):
    best = None
    best_dist = max_distance
    for marker in markers:
        dist = math.hypot(point["x"] - marker["point"]["x"], point["y"] - marker["point"]["y"])
        if dist <= best_dist:
            best = marker
            best_dist = dist
    return best


def _route_style_key(shape):
    group = shape.get("route_group")
    if group:
        return group
    return "|".join([
        shape.get("sym") or "",
        shape.get("tag") or "",
        str(shape.get("stroke") or ""),
        str(shape.get("fill") or ""),
        str(shape.get("stroke_width") or ""),
    ])


def _append_chain_points(target, points, join_distance):
    if not points:
        return
    pts = points[:]
    if target and len(pts) > 1:
        first_gap = math.hypot(target[-1]["x"] - pts[0]["x"], target[-1]["y"] - pts[0]["y"])
        last_gap = math.hypot(target[-1]["x"] - pts[-1]["x"], target[-1]["y"] - pts[-1]["y"])
        if last_gap < first_gap:
            pts = list(reversed(pts))
    for point in pts:
        prev = target[-1] if target else None
        if prev and math.hypot(prev["x"] - point["x"], prev["y"] - point["y"]) < 0.2:
            continue
        target.append(point)


def _route_style_chains(shapes, diag):
    grouped = {}
    for shape in shapes:
        sym = shape.get("sym") or ""
        if not sym.startswith("106") and not shape.get("route_group"):
            continue
        points = shape.get("points") or []
        if not points:
            continue
        grouped.setdefault(_route_style_key(shape), []).append(shape)

    chains = []
    join_distance = max(3.0, diag * 0.015)
    split_distance = max(9.0, diag * 0.035)
    for key, items in grouped.items():
        current = []
        for shape in items:
            points = shape.get("points") or []
            if not points:
                continue
            if current:
                gap = min(
                    math.hypot(current[-1]["x"] - points[0]["x"], current[-1]["y"] - points[0]["y"]),
                    math.hypot(current[-1]["x"] - points[-1]["x"], current[-1]["y"] - points[-1]["y"]) if len(points) > 1 else float("inf"),
                )
                if gap > split_distance:
                    if len(current) >= 2:
                        chains.append({"key": key, "points": current})
                    current = []
            _append_chain_points(current, points, join_distance)
        if len(current) >= 2:
            chains.append({"key": key, "points": current})
    return chains


def _nearest_point_index(points, target, max_distance):
    best_index = None
    best_dist = max_distance
    for index, point in enumerate(points):
        dist = math.hypot(point["x"] - target["x"], point["y"] - target["y"])
        if dist <= best_dist:
            best_index = index
            best_dist = dist
    return best_index


def _slice_chain_between(chain_points, start, end, max_distance):
    i1 = _nearest_point_index(chain_points, start, max_distance)
    i2 = _nearest_point_index(chain_points, end, max_distance)
    if i1 is None or i2 is None or i1 == i2:
        return None
    if i1 < i2:
        points = chain_points[i1:i2 + 1]
    else:
        points = list(reversed(chain_points[i2:i1 + 1]))
    if len(points) < 2:
        return None
    return points


def _route_segments_from_chain(chain, markers, endpoint_distance):
    segments = []
    current_marker = None
    current_points = []

    for point in chain.get("points") or []:
        marker = _nearest_marker(point, markers, endpoint_distance)
        if current_marker is None:
            if marker:
                current_marker = marker
                current_points = [marker["point"]]
            continue

        current_points.append(point)
        if marker and marker is not current_marker:
            current_points[-1] = marker["point"]
            if len(current_points) >= 2:
                segments.append({
                    "style": chain["key"],
                    "start_marker": current_marker,
                    "end_marker": marker,
                    "points": current_points[:],
                })
            current_marker = marker
            current_points = [marker["point"]]
        elif marker is current_marker and len(current_points) <= 3:
            current_points = [marker["point"]]

    return segments


def _add_svg_route(cp, raw_points, view_box, target_width, target_height, source):
    style = source.get("style") if isinstance(source, dict) else None
    if style:
        route_styles = cp.setdefault("_route_styles", set())
        if style in route_styles:
            return False
    rP = []
    _append_route_points(rP, [cp["start"]])
    editor_points = [_transform_to_editor(p, view_box, target_width, target_height) for p in raw_points]
    _append_route_points(rP, editor_points)
    _append_route_points(rP, [cp["ziel"]])
    if len(rP) < 3:
        return False
    key = _geometry_key(rP)
    if key in cp["_route_keys"]:
        return False
    cp["_route_keys"].add(key)
    if style:
        cp["_route_styles"].add(style)
    cp["routes"].append(_make_route(rP, cp, len(cp["routes"]), source))
    return True


def _geometry_key(points):
    return "|".join(f"{round(p['x'], 1)},{round(p['y'], 1)}" for p in points)


def _transform_to_editor(point, view_box, target_width, target_height):
    min_x, min_y, width, height = view_box
    return {
        "x": (point["x"] - min_x) * target_width / width,
        "y": (point["y"] - min_y) * target_height / height,
    }


def _scale_control_pairs(control_pairs, scale_x, scale_y):
    if abs(scale_x - 1) < 0.0001 and abs(scale_y - 1) < 0.0001:
        return control_pairs
    for cp in control_pairs:
        for key in ("start", "ziel"):
            point = cp.get(key)
            if point:
                point["x"] = round(point["x"] * scale_x, 2)
                point["y"] = round(point["y"] * scale_y, 2)
        for route in cp.get("routes", []):
            for point in route.get("rP", []):
                point["x"] = round(point["x"] * scale_x, 2)
                point["y"] = round(point["y"] * scale_y, 2)
            route["length"] = calc_route_length(route.get("rP"))
            route["noA"] = calc_route_noA(route.get("rP"))
            route["run_time"] = calc_route_runtime(route["length"], route["noA"], route.get("elevation") or 0)
            route["pos"] = _calc_route_side(cp, route)
    return control_pairs


def scale_ocad_import_to_target(conversion, target_width=None, target_height=None):
    control_pairs = conversion.get("control_pairs") or []
    expected_width = (conversion.get("width") or 0) * (conversion.get("scale") or 1)
    expected_height = (conversion.get("height") or 0) * (conversion.get("scale") or 1)
    if target_width and target_height and expected_width > 0 and expected_height > 0:
        _scale_control_pairs(control_pairs, target_width / expected_width, target_height / expected_height)
    return control_pairs


def import_svg_courses(source_path, target_width=None, target_height=None):
    root = ET.parse(source_path).getroot()
    view_box = _parse_view_box(root)
    target_width = float(target_width or view_box[2])
    target_height = float(target_height or view_box[3])
    paths = _svg_paths(root)
    diag = math.hypot(view_box[2], view_box[3])
    snap_threshold = max(8.0, diag * 0.025)

    markers = []
    for path in paths:
        sym = path.get("sym") or ""
        bbox = path.get("bbox")
        if not bbox:
            continue
        if sym.startswith("701"):
            kind = "start"
        elif sym.startswith("703"):
            kind = "control"
        elif sym.startswith("706"):
            kind = "finish"
        else:
            continue
        markers.append({
            "kind": kind,
            "point": {
                "x": (bbox["min_x"] + bbox["max_x"]) / 2,
                "y": (bbox["min_y"] + bbox["max_y"]) / 2,
            },
        })
    markers = _dedupe_markers(markers, tolerance=max(1.5, diag * 0.003))

    connection_lines = []
    fallback_route_candidates = []
    course_syms = ("701", "702", "703", "704", "705", "706", "708")
    for path in paths:
        points = path.get("points") or []
        sym = path.get("sym") or ""
        is_purple = _is_purple(path.get("stroke")) or _is_purple(path.get("fill"))
        if sym.startswith("705") and len(points) >= 2:
            connection_lines.append(path)
        elif not sym.startswith("106") and is_purple and not sym.startswith(course_syms) and len(points) >= 3 and path["length"] > snap_threshold:
            fallback_route_candidates.append(path)

    by_pair = {}
    control_pairs = []
    for path in connection_lines:
        points = path["points"]
        start_marker = _nearest_marker(points[0], markers, snap_threshold)
        end_marker = _nearest_marker(points[-1], markers, snap_threshold)
        if not start_marker or not end_marker or start_marker is end_marker:
            continue
        key = (id(start_marker), id(end_marker))
        if key in by_pair:
            continue
        cp = {
            "id": None,
            "order": len(control_pairs),
            "start": _round_point(_transform_to_editor(start_marker["point"], view_box, target_width, target_height)),
            "ziel": _round_point(_transform_to_editor(end_marker["point"], view_box, target_width, target_height)),
            "complex": False,
            "routes": [],
            "_start_marker": start_marker,
            "_end_marker": end_marker,
            "_route_keys": set(),
            "_route_styles": set(),
        }
        by_pair[key] = cp
        control_pairs.append(cp)

    if not control_pairs and len(markers) >= 2:
        ordered = markers[:]
        ordered.sort(key=lambda m: 0 if m["kind"] == "start" else 2 if m["kind"] == "finish" else 1)
        for i in range(1, len(ordered)):
            cp = {
                "id": None,
                "order": len(control_pairs),
                "start": _round_point(_transform_to_editor(ordered[i - 1]["point"], view_box, target_width, target_height)),
                "ziel": _round_point(_transform_to_editor(ordered[i]["point"], view_box, target_width, target_height)),
                "complex": False,
                "routes": [],
                "_start_marker": ordered[i - 1],
                "_end_marker": ordered[i],
                "_route_keys": set(),
                "_route_styles": set(),
            }
            control_pairs.append(cp)

    marker_to_cp = {
        (id(cp["_start_marker"]), id(cp["_end_marker"])): cp
        for cp in control_pairs
    }
    route_chains = _route_style_chains(paths, diag)
    styled_routes = 0
    endpoint_threshold = max(3.5, diag * 0.012)
    for chain in route_chains:
        # A styled SVG route is only trusted when its extracted segment starts
        # and ends on the exact ordered control-pair markers.
        for segment in _route_segments_from_chain(chain, markers, endpoint_threshold):
            cp = marker_to_cp.get((id(segment["start_marker"]), id(segment["end_marker"])))
            raw_points = segment["points"]
            if not cp:
                cp = marker_to_cp.get((id(segment["end_marker"]), id(segment["start_marker"])))
                if cp:
                    raw_points = list(reversed(raw_points))
            if not cp:
                continue
            if _add_svg_route(cp, raw_points, view_box, target_width, target_height, {
                "source": "svg",
                "style": segment["style"],
                "endpoint_match": True,
            }):
                styled_routes += 1

    if styled_routes == 0:
        for path in fallback_route_candidates:
            points = path["points"]
            start_marker = _nearest_marker(points[0], markers, snap_threshold)
            end_marker = _nearest_marker(points[-1], markers, snap_threshold)
            if not start_marker or not end_marker or start_marker is end_marker:
                continue
            cp = marker_to_cp.get((id(start_marker), id(end_marker)))
            reverse = False
            if not cp:
                cp = marker_to_cp.get((id(end_marker), id(start_marker)))
                reverse = bool(cp)
            if not cp:
                continue
            raw_points = list(reversed(points)) if reverse else points
            _add_svg_route(cp, raw_points, view_box, target_width, target_height, {
                "source": "svg",
                "endpoint_match": True,
            })

    for cp in control_pairs:
        cp["complex"] = len(cp["routes"]) > 1
        cp.pop("_start_marker", None)
        cp.pop("_end_marker", None)
        cp.pop("_route_keys", None)
        cp.pop("_route_styles", None)

    return {
        "control_pairs": control_pairs,
        "controls": len(markers),
        "routes": sum(len(cp["routes"]) for cp in control_pairs),
        "view_box": {
            "x": view_box[0],
            "y": view_box[1],
            "width": view_box[2],
            "height": view_box[3],
        },
    }
