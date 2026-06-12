from time import perf_counter

from django.core.cache import cache

from account.models import Team
from results.views import _cached_team_choice_stats, _cached_team_random_stats


team = Team.objects.get(name="Nationalkader")
cache.clear()

t0 = perf_counter()
cold = _cached_team_choice_stats(team, True)
t1 = perf_counter()
warm = _cached_team_choice_stats(team, True)
t2 = perf_counter()

print({
    "cold_total": cold["total"],
    "warm_total": warm["total"],
    "cold_s": round(t1 - t0, 4),
    "warm_s": round(t2 - t1, 4),
})

t3 = perf_counter()
random_cold = _cached_team_random_stats(team)
t4 = perf_counter()
random_warm = _cached_team_random_stats(team)
t5 = perf_counter()

print({
    "random_cold_total": random_cold["total"],
    "random_warm_total": random_warm["total"],
    "random_cold_s": round(t4 - t3, 4),
    "random_warm_s": round(t5 - t4, 4),
})
