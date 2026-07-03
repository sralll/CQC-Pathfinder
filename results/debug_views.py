from django.contrib.auth.decorators import user_passes_test
from django.http import HttpResponseForbidden, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_GET, require_http_methods

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


def _report_detail(report):
    return {
        **_report_summary(report),
        "start": {"x": report.start_x, "y": report.start_y},
        "goal": {"x": report.goal_x, "y": report.goal_y},
        "map_metres_per_unit": report.map_metres_per_unit,
        "settings": report.settings or {},
        "route_indexes": report.route_indexes or [],
        "routes": report.routes or [],
        "skipped_barriers": report.skipped_barriers or [],
        "route_result": report.route_result or {},
        "client_state": report.client_state or {},
        "user_agent": report.user_agent,
    }


@superuser_required
@require_GET
def debug_infinity(request):
    return render(request, "results/debug_infinity.html")


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
