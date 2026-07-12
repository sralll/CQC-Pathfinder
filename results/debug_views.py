from django.contrib.auth.decorators import user_passes_test
from django.http import HttpResponseForbidden, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.urls import reverse
from django.views.decorators.http import require_GET, require_http_methods

from project.media_access import (
    navgraph_artifact_is_current,
    serve_map_file,
    serve_mask_file,
    serve_navgraph_file,
)
from project.models import File
from project.passage_validation import normalize_level_passages

from .models import ReportedInfinity


def _is_superuser(user):
    return user.is_authenticated and user.is_superuser


def superuser_required(view_func):
    protected = user_passes_test(_is_superuser)(view_func)

    def wrapper(request, *args, **kwargs):
        if request.user.is_authenticated and not request.user.is_superuser:
            return HttpResponseForbidden("Superuser access required.")
        return protected(request, *args, **kwargs)

    return wrapper


def _user_label(user):
    if not user:
        return "deleted"
    return user.get_full_name() or user.get_username()


def _report_summary(report):
    return {
        "id": report.id,
        "user": _user_label(report.user),
        "team": report.team.name if report.team else "",
        "timestamp": report.timestamp.isoformat() if report.timestamp else "",
        "seed": report.seed,
        "pair_index": report.pair_index,
    }


def _segments_intersect(a, b, c, d, epsilon=1e-9):
    """Boundary-inclusive segment intersection for legacy report inference."""
    def orientation(p, q, r):
        return ((q[0] - p[0]) * (r[1] - p[1])
                - (q[1] - p[1]) * (r[0] - p[0]))

    def on_segment(p, q, r):
        return (min(p[0], q[0]) - epsilon <= r[0] <= max(p[0], q[0]) + epsilon
                and min(p[1], q[1]) - epsilon <= r[1] <= max(p[1], q[1]) + epsilon)

    values = (orientation(a, b, c), orientation(a, b, d),
              orientation(c, d, a), orientation(c, d, b))
    if ((values[0] > epsilon and values[1] < -epsilon
         or values[0] < -epsilon and values[1] > epsilon)
            and (values[2] > epsilon and values[3] < -epsilon
                 or values[2] < -epsilon and values[3] > epsilon)):
        return True
    return ((abs(values[0]) <= epsilon and on_segment(a, b, c))
            or (abs(values[1]) <= epsilon and on_segment(a, b, d))
            or (abs(values[2]) <= epsilon and on_segment(c, d, a))
            or (abs(values[3]) <= epsilon and on_segment(c, d, b)))


def _route_crosses_barrier(route, barrier):
    points = route.get("points") if isinstance(route, dict) else None
    try:
        line = ((float(barrier["ax"]), float(barrier["ay"])),
                (float(barrier["bx"]), float(barrier["by"])))
        points = [(float(point["x"]), float(point["y"])) for point in points or []]
    except (KeyError, TypeError, ValueError):
        return False
    return any(_segments_intersect(a, b, *line) for a, b in zip(points, points[1:]))


def _infer_legacy_route_indexes(routes, skipped_barriers):
    """Recover mask route-attempt indexes lost by the old scene wrapper.

    A generated route sequence is contiguous.  Legacy ``skipped_barriers`` has
    one barrier for every unselected attempt below the higher selected route;
    therefore the sole missing lower attempt plus ``max(attemptIndex)+1`` are
    the selected indexes.  A crossing of a later barrier identifies which
    side-ordered displayed route is the lower attempt (the higher route avoided
    every one).  Return no inference when that evidence is ambiguous.
    """
    if len(routes) != 2:
        return []
    attempts = sorted({
        int(barrier.get("attemptIndex")) for barrier in skipped_barriers
        if isinstance(barrier, dict)
        and isinstance(barrier.get("attemptIndex"), (int, float))
        and float(barrier["attemptIndex"]).is_integer()
        and int(barrier["attemptIndex"]) > 0
    })
    if not attempts:
        return []
    highest = attempts[-1] + 1
    missing = [index for index in range(1, highest) if index not in attempts]
    if len(missing) != 1:
        return []
    lower = missing[0]
    later = [barrier for barrier in skipped_barriers
             if isinstance(barrier, dict)
             and isinstance(barrier.get("attemptIndex"), (int, float))
             and int(barrier["attemptIndex"]) > lower]
    crossing = [any(_route_crosses_barrier(route, barrier) for barrier in later)
                for route in routes]
    if crossing == [True, False]:
        return [lower, highest]
    if crossing == [False, True]:
        return [highest, lower]
    return []


def _report_detail(report):
    infinity_file = File.objects.filter(
        id=report.seed,
        deleted=False,
    ).exclude(map_file="").first()
    routes = [dict(route) if isinstance(route, dict) else route
              for route in (report.routes or [])]
    route_result = dict(report.route_result or {})
    route_indexes = list(report.route_indexes or route_result.get("routeIndexes") or [])
    route_index_source = "stored"
    if not route_indexes:
        route_indexes = _infer_legacy_route_indexes(routes, report.skipped_barriers or [])
        route_index_source = "inferred_from_skipped_barriers" if route_indexes else "unavailable"
    if len(route_indexes) == len(routes):
        for route, route_index in zip(routes, route_indexes):
            if isinstance(route, dict):
                route["routeIndex"] = route_index
        route_result["routeIndexes"] = route_indexes
    return {
        **_report_summary(report),
        "start": {"x": report.start_x, "y": report.start_y},
        "goal": {"x": report.goal_x, "y": report.goal_y},
        "map_metres_per_unit": report.map_metres_per_unit,
        "settings": report.settings or {},
        "route_indexes": route_indexes,
        "route_index_source": route_index_source,
        "routes": routes,
        "skipped_barriers": report.skipped_barriers or [],
        "route_result": route_result,
        "client_state": report.client_state or {},
        "user_agent": report.user_agent,
        "infinity_file": ({
            "id": infinity_file.id,
            "name": infinity_file.name,
            "editor_scale": infinity_file.scale or 1,
            "map_scale": infinity_file.map_scale,
            "map_url": reverse("debug_infinity_file_map", args=[infinity_file.id]),
            "mask_url": reverse("debug_infinity_file_mask", args=[infinity_file.id]),
        } if infinity_file else None),
    }


@superuser_required
@require_GET
def debug_infinity(request):
    return render(request, "results/debug_infinity.html")


@superuser_required
@require_GET
def debug_user_routes(request):
    return render(request, "results/debug_user_routes.html")


@superuser_required
@require_GET
def debug_user_route_files(request):
    files = (
        File.objects
        .filter(deleted=False, has_mask=True)
        .exclude(map_file="")
        .select_related("team")
        .order_by("-last_edited")
    )
    payload = []
    for file in files:
        passages = normalize_level_passages(file.level_passages)
        route_ready = navgraph_artifact_is_current(file)
        payload.append({
            "id": file.id,
            "name": file.name,
            "team": file.team.name if file.team else "",
            "map_scale": file.map_scale,
            "editor_scale": file.scale or 1,
            "passage_count": len(passages["items"]),
            "route_ready": route_ready,
            "map_url": reverse("debug_user_route_file_map", args=[file.id]),
            "mask_url": reverse("debug_user_route_file_mask", args=[file.id]),
            "navgraph_url": (
                reverse("debug_user_route_file_navgraph", args=[file.id])
                if route_ready else None
            ),
            "passages_url": reverse("debug_user_route_file_passages", args=[file.id]),
        })
    return JsonResponse({"files": payload})


@superuser_required
@require_GET
def debug_user_route_file_map(request, file_id):
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not file.map_file:
        return JsonResponse({"error": "Map not found."}, status=404)
    return serve_map_file(file.map_file)


@superuser_required
@require_GET
def debug_user_route_file_mask(request, file_id):
    file = get_object_or_404(File, id=file_id, deleted=False)
    return serve_mask_file(file)


@superuser_required
@require_GET
def debug_user_route_file_navgraph(request, file_id):
    file = get_object_or_404(File, id=file_id, deleted=False)
    return serve_navgraph_file(file)


@superuser_required
@require_GET
def debug_user_route_file_passages(request, file_id):
    file = get_object_or_404(File, id=file_id, deleted=False)
    from project.navgraph import filter_level_passages_for_region, mask_dimensions
    from project.media_access import navgraph_artifact_paths

    document = normalize_level_passages(file.level_passages)
    _bin_path, mask_path = navgraph_artifact_paths(file)
    if (mask_path and isinstance(file.infinite_region, list)
            and len(file.infinite_region) >= 3):
        width, height = mask_dimensions(mask_path)
        document, _ignored = filter_level_passages_for_region(
            document, file.infinite_region, width, height)
    return JsonResponse(document)


@superuser_required
@require_GET
def debug_infinity_reports(request):
    try:
        limit = int(request.GET.get("limit", 50))
    except (TypeError, ValueError):
        limit = 50
    limit = max(1, min(limit, 200))
    reports = (
        ReportedInfinity.objects
        .select_related("user", "team")
        .order_by("-timestamp")[:limit]
    )
    return JsonResponse({"reports": [_report_summary(report) for report in reports]})


@superuser_required
@require_http_methods(["GET", "DELETE"])
def debug_infinity_report_detail(request, report_id):
    report = get_object_or_404(
        ReportedInfinity.objects.select_related("user", "team"),
        id=report_id,
    )
    if request.method == "DELETE":
        report.delete()
        return JsonResponse({"deleted": True, "id": report_id})
    return JsonResponse({"report": _report_detail(report)})


@superuser_required
@require_GET
def debug_infinity_file_map(request, file_id):
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not file.map_file:
        return JsonResponse({"error": "Map not found."}, status=404)
    return serve_map_file(file.map_file)


@superuser_required
@require_GET
def debug_infinity_file_mask(request, file_id):
    file = get_object_or_404(File, id=file_id, deleted=False)
    return serve_mask_file(file)
