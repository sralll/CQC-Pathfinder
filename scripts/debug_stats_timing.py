from time import perf_counter

from django.db.models import Min, Q

from account.models import Team
from project.models import Route
from results.models import Choice


TEAM = "Nationalkader"
MODE = "competition"

team = Team.objects.get(name=TEAM)
competition_flag = MODE == "competition"

t0 = perf_counter()
choices_qs = (
    Choice.objects
    .filter(competition=competition_flag)
    .filter(Q(team=team) | Q(team__isnull=True, user__profile__active_team=team))
    .order_by("timestamp")
    .values(
        "id",
        "user_id",
        "control_pair_id",
        "selected_route_id",
        "selected_route__run_time",
        "choice_time",
        "timestamp",
    )
)
choices = list(choices_qs)
t1 = perf_counter()

cp_ids = {c["control_pair_id"] for c in choices if c["control_pair_id"]}
min_time_per_cp = {
    row["control_pair_id"]: row["min_time"]
    for row in (
        Route.objects
        .filter(control_pair_id__in=cp_ids, run_time__isnull=False)
        .values("control_pair_id")
        .annotate(min_time=Min("run_time"))
    )
}
t2 = perf_counter()

t3 = perf_counter()

classifiable = 0
for c in choices:
    cp_min = min_time_per_cp.get(c["control_pair_id"])
    if cp_min and c["selected_route__run_time"]:
        classifiable += 1
t4 = perf_counter()

print({
    "choices": len(choices),
    "cp_ids": len(cp_ids),
    "cps_loaded": len(min_time_per_cp),
    "classifiable": classifiable,
    "fetch_choices_s": round(t1 - t0, 4),
    "fetch_min_times_s": round(t2 - t1, 4),
    "build_min_times_s": round(t3 - t2, 4),
    "classify_loop_s": round(t4 - t3, 4),
    "total_s": round(t4 - t0, 4),
})
