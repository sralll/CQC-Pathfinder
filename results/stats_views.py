from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.core.cache import cache
from django.db.models import Avg, Count, F, FloatField, IntegerField, Min, OuterRef, Q, Subquery, Sum
from django.db.models import ExpressionWrapper
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET

from project.models import ControlPair, File, Route


def _is_trainer(user):
    return user.groups.filter(name='Trainer').exists()


def _active_team_for(user):
    try:
        return user.profile.active_team
    except Exception:
        return None


def _stats_target_user(request):
    target_user = request.user
    if not _is_trainer(request.user):
        return target_user, None

    uid = request.GET.get('user_id')
    if not uid:
        return target_user, None

    active_team = _active_team_for(request.user)
    if not active_team:
        return None, JsonResponse({'error': 'No active team'}, status=403)

    try:
        target_id = int(uid)
    except (TypeError, ValueError):
        return None, JsonResponse({'error': 'Not authorized'}, status=403)

    from django.contrib.auth.models import User
    target_user = (
        User.objects
        .filter(id=target_id)
        .filter(
            Q(profile__teams=active_team) |
            Q(profile__active_team=active_team) |
            Q(choices__team=active_team) |
            Q(infinite_choices__team=active_team)
        )
        .distinct()
        .first()
    )
    if not target_user:
        return None, JsonResponse({'error': 'Not authorized'}, status=403)
    return target_user, None


@login_required
def stats_view(request):
    return render(request, 'results/stats.html', {'is_trainer': _is_trainer(request.user)})


CHOICE_BUCKETS = ('fastest', 'less_5', 'between_5_10', 'more_10')
STATS_TEAM_CACHE_TIMEOUT = getattr(settings, 'STATS_TEAM_CACHE_TIMEOUT', 600)


def _team_choice_cache_key(team_id, competition_flag):
    return f"stats:team-choice:v2:{team_id}:{int(competition_flag)}"


def _team_random_cache_key(team_id):
    return f"stats:team-random:v1:{team_id}"


def _stats_table_cache_key(team_id, mode):
    return f"stats:table:v5:{team_id}:{mode}"


def _team_progress_cache_key(team_id):
    return f"stats:progress:v2:{team_id}"


def _team_error_fit_cache_key(team_id, competition_flag):
    return f"stats:team-error-fit:v1:{team_id}:{int(competition_flag)}"


def _clear_stats_cache_for_team(team):
    if not team:
        return
    cache.delete(_team_choice_cache_key(team.id, True))
    cache.delete(_team_choice_cache_key(team.id, False))
    cache.delete(_team_random_cache_key(team.id))
    cache.delete(_team_progress_cache_key(team.id))
    cache.delete(_team_error_fit_cache_key(team.id, True))
    cache.delete(_team_error_fit_cache_key(team.id, False))
    for mode in ('competition', 'training', 'random'):
        cache.delete(_stats_table_cache_key(team.id, mode))


def _bucket_choice(choice, min_time_per_cp):
    """Classify a competition Choice by how much slower than the fastest
    route the selected route was. Returns (bucket, time_lost) or None if
    the choice can't be evaluated (no route data)."""
    if isinstance(choice, dict):
        control_pair_id = choice.get('control_pair_id')
        selected_runtime = choice.get('selected_route__run_time')
    else:
        control_pair_id = choice.control_pair_id
        selected_runtime = choice.selected_route.run_time if choice.selected_route else None

    cp_min = min_time_per_cp.get(control_pair_id)
    if not cp_min or not selected_runtime:
        return None
    diff = selected_runtime - cp_min
    pct  = diff / cp_min
    if diff <= 0:
        bucket = 'fastest'
    elif pct < 0.05:
        bucket = 'less_5'
    elif pct < 0.10:
        bucket = 'between_5_10'
    else:
        bucket = 'more_10'
    return bucket, max(0.0, diff)


def _choice_row_queryset(qs):
    return qs.values(
        'id',
        'user_id',
        'control_pair_id',
        'control_pair__order',
        'control_pair__file_id',
        'selected_route_id',
        'selected_route__run_time',
        'choice_time',
        'timestamp',
    )


def _choice_stats_queryset(qs, competition_flag):
    return (
        qs
        .filter(competition=competition_flag)
        .filter(control_pair__file__deleted=False)
    )


def _min_time_per_cp(cp_ids):
    if not cp_ids:
        return {}
    return {
        row['control_pair_id']: row['min_time']
        for row in (
            Route.objects
            .filter(control_pair_id__in=cp_ids, run_time__isnull=False)
            .values('control_pair_id')
            .annotate(min_time=Min('run_time'))
        )
    }


def _median(values):
    values = sorted(values)
    n = len(values)
    if n == 0:
        return None
    mid = n // 2
    if n % 2:
        return values[mid]
    return (values[mid - 1] + values[mid]) / 2


def _route_runtime_stats_for_cp(cp_ids):
    """Return per-CP runtime stats used by the decision/error scatter plot.

    For two-route legs the error potential is the direct slower-fastest gap.
    For legs with three or more routes, use the median positive loss behind the
    fastest route. That keeps a single obviously bad route from dominating the
    analysis while still increasing the potential when several alternatives are
    meaningfully slower.
    """
    if not cp_ids:
        return {}

    runtimes_by_cp = {}
    for cp_id, run_time in (
        Route.objects
        .filter(control_pair_id__in=cp_ids, run_time__isnull=False)
        .order_by('control_pair_id', 'run_time')
        .values_list('control_pair_id', 'run_time')
    ):
        if run_time is None or run_time <= 0:
            continue
        runtimes_by_cp.setdefault(cp_id, []).append(float(run_time))

    stats = {}
    for cp_id, runtimes in runtimes_by_cp.items():
        runtimes = sorted(runtimes)
        if len(runtimes) < 2:
            continue
        fastest = runtimes[0]
        max_gap = max(0.0, runtimes[-1] - fastest)
        if len(runtimes) == 2:
            potential = max_gap
        else:
            positive_losses = [rt - fastest for rt in runtimes[1:] if rt > fastest]
            potential = _median(positive_losses) if positive_losses else 0.0
        stats[cp_id] = {
            'route_count': len(runtimes),
            'fastest': fastest,
            'error_potential': max(0.0, potential),
            'max_error_potential': max_gap,
        }
    return stats


def _choice_error_potential_points(choices, runtime_stats):
    points = []
    for c in choices:
        cp_id = c.get('control_pair_id')
        stat = runtime_stats.get(cp_id)
        choice_time = c.get('choice_time')
        if (
            not stat
            or stat['route_count'] <= 1
            or choice_time is None
        ):
            continue
        points.append({
            'x': round(stat['max_error_potential'], 2),
            'y': round(max(0.0, float(choice_time)), 2),
            'route_count': stat['route_count'],
            'max_error': round(stat['max_error_potential'], 2),
        })
    return points


def _linear_fit(points):
    if len(points) < 2:
        return None
    xs = [float(p['x']) for p in points]
    ys = [float(p['y']) for p in points]
    n = len(points)
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    if sxx <= 1e-9:
        return None
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / sxx
    intercept = mean_y - slope * mean_x
    return {
        'slope': round(slope, 6),
        'intercept': round(intercept, 6),
        'n': n,
        'sensitivity_ms': round(slope * 1000),
    }


def _linear_fit_from_sums(row):
    n = int(row.get('n') or 0)
    if n < 2:
        return None
    sx = float(row.get('sx') or 0)
    sy = float(row.get('sy') or 0)
    sx2 = float(row.get('sx2') or 0)
    sxy = float(row.get('sxy') or 0)
    mean_x = sx / n
    mean_y = sy / n
    sxx = sx2 - (sx * sx / n)
    if sxx <= 1e-9:
        return None
    slope = (sxy - (sx * sy / n)) / sxx
    intercept = mean_y - slope * mean_x
    return {
        'slope': round(slope, 6),
        'intercept': round(intercept, 6),
        'n': n,
        'sensitivity_ms': round(slope * 1000),
    }


def _fit_sums_from_points(points):
    """Component sums (n, Σx, Σy, Σx², Σxy) of a least-squares line fit, computed
    from in-memory points. Feeds `_linear_fit_from_sums`."""
    n = len(points)
    sx = sy = sx2 = sxy = 0.0
    for p in points:
        x = float(p['x'])
        y = float(p['y'])
        sx  += x
        sy  += y
        sx2 += x * x
        sxy += x * y
    return {'n': n, 'sx': sx, 'sy': sy, 'sx2': sx2, 'sxy': sxy}


def _combine_fit_sums(rows):
    """Element-wise sum of fit-sum rows. A line fit's component sums are additive,
    so the combined fit over several groups is the fit of their summed components."""
    total = {'n': 0, 'sx': 0.0, 'sy': 0.0, 'sx2': 0.0, 'sxy': 0.0}
    for r in rows:
        for k in total:
            total[k] += r[k]
    return total


def _linear_fit_sums(qs, group_by=None):
    qs = qs.annotate(
        fit_x2=ExpressionWrapper(F('fit_x') * F('fit_x'), output_field=FloatField()),
        fit_xy=ExpressionWrapper(F('fit_x') * F('fit_y'), output_field=FloatField()),
    )
    aggregates = {
        'n': Count('id'),
        'sx': Sum('fit_x'),
        'sy': Sum('fit_y'),
        'sx2': Sum('fit_x2'),
        'sxy': Sum('fit_xy'),
    }
    if group_by:
        return qs.values(group_by).annotate(**aggregates)
    return qs.aggregate(**aggregates)


def _valid_route_stats_subqueries():
    routes = (
        Route.objects
        .filter(control_pair_id=OuterRef('control_pair_id'), run_time__isnull=False, run_time__gt=0)
        .order_by()
    )
    by_cp = routes.values('control_pair_id')
    return {
        'min_route_time': Subquery(
            routes.order_by('run_time').values('run_time')[:1],
            output_field=FloatField(),
        ),
        'max_route_time': Subquery(
            routes.order_by('-run_time').values('run_time')[:1],
            output_field=FloatField(),
        ),
        'route_count': Subquery(
            by_cp.annotate(n=Count('id')).values('n')[:1],
            output_field=IntegerField(),
        ),
    }


def _min_route_time_subquery():
    return Subquery(
        Route.objects
        .filter(control_pair_id=OuterRef('control_pair_id'), run_time__isnull=False, run_time__gt=0)
        .order_by('run_time')
        .values('run_time')[:1],
        output_field=FloatField(),
    )


def _error_potential_fit_queryset(qs):
    route_stats = _valid_route_stats_subqueries()
    return (
        qs
        .filter(control_pair_id__isnull=False, choice_time__isnull=False)
        .annotate(**route_stats)
        .filter(route_count__gt=1, min_route_time__isnull=False, max_route_time__isnull=False)
        .annotate(
            fit_x=ExpressionWrapper(F('max_route_time') - F('min_route_time'), output_field=FloatField()),
            fit_y=ExpressionWrapper(F('choice_time'), output_field=FloatField()),
        )
        .filter(fit_x__gte=0)
    )


def _choice_error_potential_fit(qs):
    return _linear_fit_from_sums(_linear_fit_sums(_error_potential_fit_queryset(qs)))


def _time_benchmark_subqueries(benchmark_qs):
    benchmark = (
        benchmark_qs
        .filter(control_pair_id=OuterRef('control_pair_id'))
        .order_by()
        .values('control_pair_id')
    )
    return {
        'avg_choice_time': Subquery(
            benchmark.annotate(avg_choice_time=Avg('choice_time')).values('avg_choice_time')[:1],
            output_field=FloatField(),
        ),
        'benchmark_count': Subquery(
            benchmark.annotate(result_count=Count('id')).values('result_count')[:1],
            output_field=IntegerField(),
        ),
    }


def _time_sensitivity_fit_queryset(rows_qs, benchmark_qs):
    return (
        rows_qs
        .filter(
            control_pair_id__isnull=False,
            selected_route__run_time__isnull=False,
            choice_time__isnull=False,
        )
        .annotate(min_route_time=_min_route_time_subquery(), **_time_benchmark_subqueries(benchmark_qs))
        .filter(
            benchmark_count__gte=5,
            min_route_time__isnull=False,
            avg_choice_time__isnull=False,
        )
        .annotate(
            fit_x=ExpressionWrapper(F('choice_time') - F('avg_choice_time'), output_field=FloatField()),
            fit_y=ExpressionWrapper(F('selected_route__run_time') - F('min_route_time'), output_field=FloatField()),
        )
        .filter(fit_y__gte=0)
    )


def _choice_time_sensitivity_fit(rows_qs, benchmark_qs):
    return _linear_fit_from_sums(_linear_fit_sums(_time_sensitivity_fit_queryset(rows_qs, benchmark_qs)))


def _fit_sensitivity_ms(points):
    fit = _linear_fit(points)
    return fit['sensitivity_ms'] if fit else None


def _random_error_potential_points(rcs):
    points = []
    for rc in rcs:
        if rc.choice_time is None or rc.shorter_time is None or rc.longer_time is None:
            continue
        points.append({
            'x': round(max(0.0, rc.longer_time - rc.shorter_time), 2),
            'y': round(max(0.0, rc.choice_time), 2),
            'route_count': 2,
            'max_error': round(max(0.0, rc.longer_time - rc.shorter_time), 2),
        })
    return points


def _choice_activity_quality_events(choices, min_time_per_cp):
    events = []
    for c in choices:
        classified = _bucket_choice(c, min_time_per_cp)
        timestamp = c.get('timestamp')
        if not classified or not timestamp:
            continue
        events.append({
            'timestamp': timestamp.isoformat(),
            'bucket': classified[0],
        })
    return events


def _random_activity_quality_events(rcs):
    return [
        {'timestamp': rc.timestamp.isoformat(), 'bucket': _bucket_random(rc)[0]}
        for rc in rcs
        if rc.timestamp
    ]


def _choice_time_benchmarks_per_cp(qs, cp_ids):
    if not cp_ids:
        return {}
    return {
        row['control_pair_id']: {
            'avg_choice_time': float(row['avg_choice_time'] or 0),
            'result_count': row['result_count'],
        }
        for row in (
            qs
            .filter(control_pair_id__in=cp_ids)
            .values('control_pair_id')
            .annotate(
                avg_choice_time=Avg('choice_time'),
                result_count=Count('id'),
            )
        )
    }


def _choice_time_sensitivity_points(choices, min_time_per_cp, benchmarks):
    points = []
    for c in choices:
        cp_id = c.get('control_pair_id')
        cp_min = min_time_per_cp.get(cp_id)
        benchmark = benchmarks.get(cp_id)
        selected_runtime = c.get('selected_route__run_time')
        choice_time = c.get('choice_time')
        if (
            not cp_min
            or not benchmark
            or benchmark['result_count'] < 5
            or selected_runtime is None
            or choice_time is None
        ):
            continue
        relative_choice_time = float(choice_time) - benchmark['avg_choice_time']
        route_loss = max(0.0, float(selected_runtime) - float(cp_min))
        points.append({
            'x': round(relative_choice_time, 2),
            'y': round(route_loss, 2),
            'choice_time': round(max(0.0, float(choice_time)), 2),
            'avg_choice_time': round(benchmark['avg_choice_time'], 2),
            'result_count': benchmark['result_count'],
        })
    return points


def _aggregate_choices(choices, min_time_per_cp):
    counts = {b: 0 for b in CHOICE_BUCKETS}
    sum_choice_time = 0.0
    sum_route_diff  = 0.0
    n = 0
    for c in choices:
        classified = _bucket_choice(c, min_time_per_cp)
        if classified is None:
            continue
        bucket, time_lost = classified
        counts[bucket]  += 1
        choice_time = c.get('choice_time') if isinstance(c, dict) else c.choice_time
        sum_choice_time += choice_time or 0
        sum_route_diff  += time_lost
        n += 1
    return {
        'total':           n,
        'counts':          counts,
        'avg_choice_time': round(sum_choice_time / n, 2) if n else 0,
        'avg_route_diff':  round(sum_route_diff  / n, 2) if n else 0,
    }


def _team_choice_filter(active_team):
    return (
        Q(team=active_team) |
        Q(team__isnull=True, user__profile__active_team=active_team)
    )


def _aggregate_choice_queryset(qs):
    choices = list(_choice_row_queryset(qs))
    cp_ids = {c['control_pair_id'] for c in choices if c['control_pair_id']}
    return _aggregate_choices(choices, _min_time_per_cp(cp_ids))


def _cached_team_choice_stats(active_team, competition_flag):
    cache_key = _team_choice_cache_key(active_team.id, competition_flag)
    stats = cache.get(cache_key)
    if stats is not None:
        return stats

    from .models import Choice
    stats = _aggregate_choice_queryset(
        _choice_stats_queryset(Choice.objects, competition_flag)
        .filter(_team_choice_filter(active_team))
    )
    cache.set(cache_key, stats, STATS_TEAM_CACHE_TIMEOUT)
    return stats


def _cached_team_random_stats(active_team):
    cache_key = _team_random_cache_key(active_team.id)
    stats = cache.get(cache_key)
    if stats is not None:
        return stats

    from .models import InfiniteChoice
    stats = _aggregate_random(
        list(InfiniteChoice.objects.filter(_team_choice_filter(active_team)))
    )
    cache.set(cache_key, stats, STATS_TEAM_CACHE_TIMEOUT)
    return stats


def _cached_team_error_potential_fit(active_team, competition_flag):
    cache_key = _team_error_fit_cache_key(active_team.id, competition_flag)
    fit = cache.get(cache_key)
    if fit is not None:
        return fit

    from .models import Choice
    from django.contrib.auth.models import User

    member_user_ids = list(
        User.objects
        .filter(profile__teams=active_team)
        .exclude(groups__name='Trainer')
        .distinct()
        .values_list('id', flat=True)
    )
    fit = _choice_error_potential_fit(
        _choice_stats_queryset(Choice.objects, competition_flag)
        .filter(user_id__in=member_user_ids)
    )
    cache.set(cache_key, fit, STATS_TEAM_CACHE_TIMEOUT)
    return fit


def _bucket_random(rc):
    """Classify an InfiniteChoice the same way the donut buckets Choices."""
    if rc.correct:
        return 'fastest', 0.0
    diff = rc.longer_time - rc.shorter_time
    pct  = diff / rc.shorter_time if rc.shorter_time else 0
    if   pct < 0.05: bucket = 'less_5'
    elif pct < 0.10: bucket = 'between_5_10'
    else:            bucket = 'more_10'
    return bucket, max(0.0, diff)


def _aggregate_random(rcs):
    counts = {b: 0 for b in CHOICE_BUCKETS}
    sum_choice_time = 0.0
    sum_route_diff  = 0.0
    n = 0
    for rc in rcs:
        bucket, lost = _bucket_random(rc)
        counts[bucket]  += 1
        sum_choice_time += rc.choice_time or 0
        sum_route_diff  += lost
        n += 1
    return {
        'total':           n,
        'counts':          counts,
        'avg_choice_time': round(sum_choice_time / n, 2) if n else 0,
        'avg_route_diff':  round(sum_route_diff  / n, 2) if n else 0,
    }


@login_required
@require_GET
def get_user_stats(request):
    from .models import Choice, InfiniteChoice

    mode = (request.GET.get('mode') or '').lower()
    # Backwards-compat: ?competition=true|false was the old flag
    if not mode:
        mode = 'competition' if request.GET.get('competition', 'true').lower() != 'false' else 'training'

    target_user, error_response = _stats_target_user(request)
    if error_response:
        return error_response
    active_team = _active_team_for(request.user)

    # ── Infinity mode: aggregate InfiniteChoice rows independent of team / file ──
    if mode == 'random':
        target_rcs_qs = InfiniteChoice.objects.filter(user=target_user)
        if target_user != request.user and _is_trainer(request.user) and active_team:
            target_rcs_qs = target_rcs_qs.filter(_team_choice_filter(active_team))
        target_rcs = list(target_rcs_qs.order_by('timestamp'))
        team_rcs = target_rcs   # No team aggregation for random plays for now

        user_stats = _aggregate_random(target_rcs)
        team_stats = _cached_team_random_stats(active_team) if active_team else _aggregate_random(team_rcs)

        # Send raw timestamps; the client bins them dynamically (~50 bars)
        activity = [rc.timestamp.isoformat() for rc in target_rcs if rc.timestamp]
        activity_quality = _random_activity_quality_events(target_rcs)
        error_potential = {'points': _random_error_potential_points(target_rcs)}

        longest_streak = 0
        current_run    = 0
        for rc in target_rcs:
            if rc.correct:
                current_run += 1
                longest_streak = max(longest_streak, current_run)
            else:
                current_run = 0

        fastest_pct = round(user_stats['counts']['fastest'] / user_stats['total'] * 100, 1) if user_stats['total'] else 0
        return JsonResponse({
            'user':        user_stats,
            'team':        team_stats,
            'activity':    activity,
            'activity_quality': activity_quality,
            'error_potential': {**error_potential, 'user_fit': None, 'team_fit': None},
            'time_sensitivity': {'points': [], 'fit': None},
            'facts': {
                'total_cp':       user_stats['total'],
                'fastest_pct':    fastest_pct,
                'longest_streak': longest_streak,
                'current_streak': current_run,
            },
            'target_name': target_user.get_full_name() or target_user.username,
            'mode':        'random',
        })

    # ── Choice mode (competition or training) ──
    competition_flag = (mode == 'competition')

    profile     = request.user.profile
    active_team = profile.active_team

    # Compare against everyone sharing the requester's active team
    # (falls back to "just the target user" if there's no active team)
    if active_team:
        team_filter = _team_choice_filter(active_team)
    else:
        team_filter = Q(user=target_user)

    comparable_choices_qs = (
        _choice_stats_queryset(Choice.objects, competition_flag)
        .filter(team_filter)
    )

    user_choices = list(
        _choice_row_queryset(comparable_choices_qs
        .filter(user_id=target_user.id)
        .order_by('timestamp')
        )
    )

    cp_ids = {c['control_pair_id'] for c in user_choices if c['control_pair_id']}
    min_time_per_cp = _min_time_per_cp(cp_ids)
    runtime_stats = _route_runtime_stats_for_cp(cp_ids)
    error_points = _choice_error_potential_points(user_choices, runtime_stats)
    time_sensitivity_points = _choice_time_sensitivity_points(
        user_choices,
        min_time_per_cp,
        _choice_time_benchmarks_per_cp(comparable_choices_qs, cp_ids),
    )

    team_error_fit = _cached_team_error_potential_fit(active_team, competition_flag) if active_team else None

    team_stats = (
        _cached_team_choice_stats(active_team, competition_flag)
        if active_team
        else _aggregate_choices(user_choices, min_time_per_cp)
    )
    user_stats = _aggregate_choices(user_choices, min_time_per_cp)

    # Activity: raw ISO timestamps; the client picks a bin width that targets ~50 bars
    activity = [c['timestamp'].isoformat() for c in user_choices if c['timestamp']]
    activity_quality = _choice_activity_quality_events(user_choices, min_time_per_cp)

    # Streaks: longest & current run of consecutive "fastest route chosen" choices
    longest_streak = 0
    current_run    = 0
    for c in user_choices:
        classified = _bucket_choice(c, min_time_per_cp)
        if classified and classified[0] == 'fastest':
            current_run   += 1
            longest_streak = max(longest_streak, current_run)
        else:
            current_run = 0

    fastest_pct = round(user_stats['counts']['fastest'] / user_stats['total'] * 100, 1) if user_stats['total'] else 0

    return JsonResponse({
        'user':        user_stats,
        'team':        team_stats,
        'activity':    activity,
        'activity_quality': activity_quality,
        'error_potential': {
            'points': error_points,
            'user_fit': _linear_fit(error_points),
            'team_fit': team_error_fit,
        },
        'time_sensitivity': {
            'points': time_sensitivity_points,
            'fit': _linear_fit(time_sensitivity_points),
        },
        'facts': {
            'total_cp':       user_stats['total'],
            'fastest_pct':    fastest_pct,
            'longest_streak': longest_streak,
            'current_streak': current_run,
        },
        'target_name': target_user.get_full_name() or target_user.username,
        'mode':        mode,
    })


def _cached_team_progress(active_team):
    """File-completion progress for everyone on `active_team`, independent of the
    selected stats mode.

    Returns ``{'total': <available CP count>, 'per_user': {uid: {'training': n,
    'competition': n}}}``. The Choice model has a unique (user, control_pair)
    constraint, so a CP is completed in exactly one of training/competition —
    the two counts never overlap. Cached because counting the team's total
    available control pairs means scanning every accessible file."""
    cache_key = _team_progress_cache_key(active_team.id)
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    from .models import Choice

    # Files this team may play — mirrors the permission logic in get_files().
    files = File.objects.filter(deleted=False, published=True)
    if active_team.shared_pool:
        files = files.filter(Q(team=active_team) | Q(team__shared_pool=True)).distinct()
    else:
        files = files.filter(team=active_team)
    file_ids = list(files.values_list('id', flat=True))

    total_cp = ControlPair.objects.filter(file_id__in=file_ids).count()

    per_user = {}
    rows = (
        Choice.objects
        .filter(control_pair__file_id__in=file_ids)
        .filter(_team_choice_filter(active_team))
        .values('user_id', 'competition')
        .annotate(n=Count('id', distinct=True))
    )
    for r in rows:
        d = per_user.setdefault(r['user_id'], {'training': 0, 'competition': 0})
        if r['competition']:
            d['competition'] = r['n']
        else:
            d['training'] = r['n']

    result = {'total': total_cp, 'per_user': per_user}
    cache.set(cache_key, result, STATS_TEAM_CACHE_TIMEOUT)
    return result


@login_required
@require_GET
def get_stats_table(request):
    """Per-athlete trainer table — competition / training / random.

    Returns a JSON array starting with a team-average summary row,
    followed by one row per athlete in the requester's active team who has
    data in the chosen mode. Each row has the same keys regardless of mode
    so the existing renderer doesn't need to branch.
    """
    from .models import Choice, InfiniteChoice
    from django.contrib.auth.models import User

    mode = (request.GET.get('mode') or 'competition').lower()
    if not _is_trainer(request.user):
        return JsonResponse({'error': 'Not authorized'}, status=403)

    profile     = request.user.profile
    active_team = profile.active_team
    if not active_team:
        return JsonResponse([], safe=False)

    table_cache_key = _stats_table_cache_key(active_team.id, mode)
    cached_table = cache.get(table_cache_key)
    if cached_table is not None:
        return JsonResponse(cached_table, safe=False)

    # Roster = everyone with results stamped with this team (current OR former
    # members), not just the current roster — so historical results stay visible
    # after a user switches/leaves the team.
    if mode == 'random':
        roster_ids = (InfiniteChoice.objects
                      .filter(_team_choice_filter(active_team))
                      .values_list('user_id', flat=True).distinct())
    else:
        roster_ids = (_choice_stats_queryset(Choice.objects, mode == 'competition')
                      .filter(_team_choice_filter(active_team))
                      .values_list('user_id', flat=True).distinct())

    team_users = list(
        User.objects
            .filter(id__in=roster_ids)
            .exclude(groups__name='Trainer')
            .order_by('last_name', 'first_name')
    )
    team_user_ids = {u.id for u in team_users}

    def aggregate_rows(rows, classify):
        """`rows` are raw items (Choice or InfiniteChoice). `classify(row)` →
        (bucket_name, time_lost_seconds, choice_time_seconds) or None when
        the row can't be evaluated."""
        counts = {'fastest': 0, 'less_5': 0, 'between_5_10': 0, 'more_10': 0}
        sum_choice = 0.0
        sum_error  = 0.0
        total      = 0
        for r in rows:
            c = classify(r)
            if c is None:
                continue
            bucket, lost, choice_t = c
            counts[bucket]  += 1
            sum_error       += lost
            sum_choice      += choice_t or 0
            total           += 1
        if total == 0:
            return None
        return {
            'posten':          total,
            'avg_choice_time': round(sum_choice / total, 2),
            'avg_error':       round(sum_error  / total, 2),
            'schnellste':      round(counts['fastest']       / total * 100, 1),
            'lt5':             round(counts['less_5']        / total * 100, 1),
            'lt10':            round(counts['between_5_10']  / total * 100, 1),
            'gt10':            round(counts['more_10']       / total * 100, 1),
        }

    # ── Mode-specific data + classifier ────────────────────────────────
    if mode == 'random':
        rcs = list(
            InfiniteChoice.objects
            .filter(user_id__in=team_user_ids)
            .filter(_team_choice_filter(active_team))
        )
        per_user = {}
        for rc in rcs:
            per_user.setdefault(rc.user_id, []).append(rc)

        def classify(rc):
            if rc.correct:
                return ('fastest', 0.0, rc.choice_time)
            diff = rc.longer_time - rc.shorter_time
            pct  = diff / rc.shorter_time if rc.shorter_time else 0
            if   pct < 0.05: bucket = 'less_5'
            elif pct < 0.10: bucket = 'between_5_10'
            else:            bucket = 'more_10'
            return (bucket, max(0.0, diff), rc.choice_time)

        all_rows  = rcs
        get_rows  = lambda uid: per_user.get(uid, [])
        sensitivity_by_user = {}
        time_sensitivity_by_user = {}
        summary_error_sensitivity = None
        summary_time_sensitivity = None
    else:
        competition_flag = (mode == 'competition')
        choices_qs = (
            _choice_stats_queryset(Choice.objects, competition_flag)
            .filter(user_id__in=team_user_ids)
            .filter(
                Q(team=active_team) |
                Q(team__isnull=True, user__profile__active_team=active_team)
            )
        )
        choices = list(
            _choice_row_queryset(choices_qs)
        )
        per_user = {}
        for c in choices:
            per_user.setdefault(c['user_id'], []).append(c)

        cp_ids = {c['control_pair_id'] for c in choices if c['control_pair_id']}
        min_time_per_cp = _min_time_per_cp(cp_ids)

        def classify(c):
            cp_min = min_time_per_cp.get(c['control_pair_id'])
            selected_runtime = c['selected_route__run_time']
            if not cp_min or not selected_runtime:
                return None
            diff = selected_runtime - cp_min
            pct  = diff / cp_min
            if   diff <= 0:  bucket = 'fastest'
            elif pct < 0.05: bucket = 'less_5'
            elif pct < 0.10: bucket = 'between_5_10'
            else:            bucket = 'more_10'
            return (bucket, max(0.0, diff), c['choice_time'])

        all_rows  = choices
        get_rows  = lambda uid: per_user.get(uid, [])

        # Sensitivity fits (Fehlerpotential-Erkennung & Zeitsensitivität) are
        # computed in Python from the choice rows already fetched above, reusing
        # the same point helpers as the per-athlete graph view. This replaces four
        # correlated-subquery aggregates (per-user + summary, ×2 metrics) with two
        # plain GROUP BY queries. Because a least-squares line's component sums are
        # additive, the team-average fit is just the element-wise sum of the
        # per-athlete sums — no separate query needed.
        runtime_stats   = _route_runtime_stats_for_cp(cp_ids)
        time_benchmarks = _choice_time_benchmarks_per_cp(choices_qs, cp_ids)

        error_sums_by_user = {
            uid: _fit_sums_from_points(_choice_error_potential_points(rows, runtime_stats))
            for uid, rows in per_user.items()
        }
        time_sums_by_user = {
            uid: _fit_sums_from_points(
                _choice_time_sensitivity_points(rows, min_time_per_cp, time_benchmarks)
            )
            for uid, rows in per_user.items()
        }

        def _sensitivity_ms(sums):
            fit = _linear_fit_from_sums(sums)
            return fit['sensitivity_ms'] if fit else None

        sensitivity_by_user      = {uid: _sensitivity_ms(s) for uid, s in error_sums_by_user.items()}
        time_sensitivity_by_user = {uid: _sensitivity_ms(s) for uid, s in time_sums_by_user.items()}
        summary_error_sensitivity = _sensitivity_ms(_combine_fit_sums(error_sums_by_user.values()))
        summary_time_sensitivity  = _sensitivity_ms(_combine_fit_sums(time_sums_by_user.values()))

    # ── File-completion progress (Fortschritt) — mode-independent ──────
    progress = _cached_team_progress(active_team)
    total_cp = progress['total']

    def progress_payload(uid):
        p = progress['per_user'].get(uid, {'training': 0, 'competition': 0})
        t, c = p['training'], p['competition']
        done = t + c
        return {
            'total':           total_cp,
            'done':            done,
            'training':        t,
            'competition':     c,
            'training_pct':    round(t / total_cp * 100, 1) if total_cp else 0,
            'competition_pct': round(c / total_cp * 100, 1) if total_cp else 0,
            'pct':             round(done / total_cp * 100, 1) if total_cp else 0,
        }

    # ── Build rows ────────────────────────────────────────────────────
    athlete_rows = []
    for u in team_users:
        s = aggregate_rows(get_rows(u.id), classify)
        if s is None:
            continue
        show_sensitivity = s['posten'] > 100
        error_sensitivity = sensitivity_by_user.get(u.id) if show_sensitivity else None
        time_sensitivity = time_sensitivity_by_user.get(u.id) if show_sensitivity else None
        athlete_rows.append({
            'athlete':      u.get_full_name() or u.username,
            'user_id':      u.id,
            'error_potential_sensitivity': error_sensitivity,
            'time_sensitivity':            time_sensitivity,
            'sensitivity':  error_sensitivity,
            'roi_slope':    time_sensitivity,
            'progress':     progress_payload(u.id),
            **s,
        })

    data = []
    summary = aggregate_rows(all_rows, classify)
    if summary:
        # Summary progress = average completion across the athletes shown.
        shown = [r['progress'] for r in athlete_rows]
        if shown:
            avg = lambda k: round(sum(p[k] for p in shown) / len(shown), 1)
            summary_progress = {
                'total': total_cp, 'done': 0, 'training': 0, 'competition': 0,
                'training_pct':    avg('training_pct'),
                'competition_pct': avg('competition_pct'),
                'pct':             avg('pct'),
            }
        else:
            summary_progress = {
                'total': total_cp, 'done': 0, 'training': 0, 'competition': 0,
                'training_pct': 0, 'competition_pct': 0, 'pct': 0,
            }
        show_summary_sensitivity = summary['posten'] > 100
        data.append({
            'athlete':      'Team average',
            'is_summary':   True,
            'user_id':      None,
            'error_potential_sensitivity': summary_error_sensitivity if show_summary_sensitivity else None,
            'time_sensitivity':            summary_time_sensitivity if show_summary_sensitivity else None,
            'sensitivity':  summary_error_sensitivity if show_summary_sensitivity else None,
            'roi_slope':    summary_time_sensitivity if show_summary_sensitivity else None,
            'progress':     summary_progress,
            **summary,
        })

    data.extend(athlete_rows)

    cache.set(table_cache_key, data, STATS_TEAM_CACHE_TIMEOUT)
    return JsonResponse(data, safe=False)


@login_required
@require_GET
def get_team_athletes(request):
    """List athletes (non-trainers) with results stamped with the requesting
    trainer's active team — current or former members, mirroring the search
    semantics used by the stats table."""
    from .models import Choice, InfiniteChoice
    from django.contrib.auth.models import User

    if not _is_trainer(request.user):
        return JsonResponse({'error': 'Not authorized'}, status=403)

    profile     = request.user.profile
    active_team = profile.active_team
    if not active_team:
        return JsonResponse({'athletes': []})

    team_filter = _team_choice_filter(active_team)
    roster_ids = (
        set(Choice.objects.filter(team_filter, control_pair__file__deleted=False).values_list('user_id', flat=True))
        | set(InfiniteChoice.objects.filter(team_filter).values_list('user_id', flat=True))
    )
    users = (
        User.objects
        .filter(id__in=roster_ids)
        .exclude(groups__name='Trainer')
        .exclude(id=request.user.id)
        .order_by('first_name', 'last_name', 'username')
    )
    return JsonResponse({
        'athletes': [
            {'id': u.id, 'name': u.get_full_name() or u.username}
            for u in users
        ]
    })
