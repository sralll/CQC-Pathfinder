from collections import defaultdict

from account.models import Team
from coursesetter.models import publishedFile
from play.models import UserResult
from project.models import ControlPair, Route
from results.models import Choice


TEAM = "Nationalkader"
team = Team.objects.get(name=TEAM)

cp_by_key = {}
for cp_id, file_name, team_name, cp_order in (
    ControlPair.objects
    .values_list("id", "file__name", "file__team__name", "order")
    .order_by("id")
):
    cp_by_key.setdefault((file_name, cp_order, team_name), cp_id)

route_times = defaultdict(list)
for route_id, cp_id, route_order, run_time in (
    Route.objects.values_list("id", "control_pair_id", "order", "run_time")
):
    route_times[cp_id].append((route_id, route_order, run_time))

print({
    "old_userresult_comp_user_team": UserResult.objects.filter(
        user__profile__active_team=team,
        competition=True,
    ).count(),
    "old_userresult_comp_kader": UserResult.objects.filter(
        kader__name=TEAM,
        competition=True,
    ).count(),
    "choice_comp_team": Choice.objects.filter(
        team=team,
        competition=True,
    ).count(),
    "choice_comp_team_classifiable": Choice.objects.filter(
        team=team,
        competition=True,
        selected_route__isnull=False,
        selected_route__run_time__isnull=False,
    ).count(),
})

qs = UserResult.objects.filter(
    kader__name=TEAM,
    competition=True,
    selected_route__isnull=True,
)

old_files = {
    (pf.filename, pf.kader.name if pf.kader_id else None): pf
    for pf in publishedFile.objects.select_related("kader").filter(kader__name=TEAM)
}

json_exact = 0
json_close = 0
json_ambiguous = 0
json_no_file = 0
json_no_routes = 0
json_sample = []
json_exact_tolerance = 0.02
json_close_tolerance = 0.5

for old in qs.iterator():
    if old.selected_route_runtime is None:
        continue

    pf = old_files.get((old.filename, TEAM))
    if not pf:
        json_no_file += 1
        continue

    cps = (pf.data or {}).get("cP", [])
    if old.control_pair_index >= len(cps):
        json_no_routes += 1
        continue

    routes = cps[old.control_pair_index].get("route", [])
    if not routes:
        json_no_routes += 1
        continue

    route_runtimes = []
    for idx, route in enumerate(routes):
        value = route.get("runTime")
        try:
            route_runtimes.append((idx, float(value)))
        except (TypeError, ValueError):
            pass

    matches = [
        item for item in route_runtimes
        if abs(item[1] - old.selected_route_runtime) <= json_exact_tolerance
    ]
    if len(matches) == 1:
        json_exact += 1
    elif len(matches) > 1:
        json_ambiguous += 1
    elif route_runtimes:
        best_diff, best = min(
            (abs(runtime - old.selected_route_runtime), (idx, runtime))
            for idx, runtime in route_runtimes
        )
        if best_diff <= json_close_tolerance:
            json_close += 1
        elif len(json_sample) < 5:
            json_sample.append({
                "file": old.filename,
                "cp": old.control_pair_index,
                "old_selected_runtime": old.selected_route_runtime,
                "best_diff": best_diff,
                "routes": route_runtimes[:6],
            })

print({
    "json_recover_exact": json_exact,
    "json_recover_ambiguous": json_ambiguous,
    "json_recover_close": json_close,
    "json_no_file": json_no_file,
    "json_no_routes": json_no_routes,
    "json_sample_unmatched": json_sample,
})

total = qs.count()
has_runtime = 0
exact = 0
ambiguous = 0
close = 0
no_cp = 0
no_routes = 0
sample = []
exact_tolerance = 0.02
close_tolerance = 0.5

for old in qs.iterator():
    if old.selected_route_runtime is None:
        continue
    has_runtime += 1

    cp_id = cp_by_key.get((old.filename, old.control_pair_index, TEAM))
    if not cp_id:
        no_cp += 1
        continue

    routes = [r for r in route_times.get(cp_id, []) if r[2] is not None]
    if not routes:
        no_routes += 1
        continue

    matches = [
        r for r in routes
        if abs(r[2] - old.selected_route_runtime) <= exact_tolerance
    ]
    if len(matches) == 1:
        exact += 1
    elif len(matches) > 1:
        ambiguous += 1
    else:
        best_diff, best_route = min(
            (abs(r[2] - old.selected_route_runtime), r)
            for r in routes
        )
        if best_diff <= close_tolerance:
            close += 1
        elif len(sample) < 5:
            sample.append({
                "file": old.filename,
                "cp": old.control_pair_index,
                "old_selected_runtime": old.selected_route_runtime,
                "best_diff": best_diff,
                "routes": [(order, rt) for _, order, rt in routes[:6]],
            })

print({
    "old_null_selected_route": total,
    "old_null_selected_route_with_runtime": has_runtime,
    "recover_exact": exact,
    "recover_ambiguous": ambiguous,
    "recover_close": close,
    "no_cp": no_cp,
    "no_routes": no_routes,
    "sample_unmatched": sample,
})
