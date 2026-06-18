from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.core.cache import cache
from django.db.models import Count, Min, Q
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET

from project.models import ControlPair, File, Route


def _is_trainer(user):
    return user.groups.filter(name='Trainer').exists()


@login_required
def stats_view(request):
    return render(request, 'results/stats.html', {'is_trainer': _is_trainer(request.user)})


CHOICE_BUCKETS = ('fastest', 'less_5', 'between_5_10', 'more_10')
STATS_TEAM_CACHE_TIMEOUT = getattr(settings, 'STATS_TEAM_CACHE_TIMEOUT', 600)


def _team_choice_cache_key(team_id, competition_flag):
    return f"stats:team-choice:v1:{team_id}:{int(competition_flag)}"


def _team_random_cache_key(team_id):
    return f"stats:team-random:v1:{team_id}"


def _stats_table_cache_key(team_id, mode):
    return f"stats:table:v1:{team_id}:{mode}"


def _team_progress_cache_key(team_id):
    return f"stats:progress:v1:{team_id}"


def _clear_stats_cache_for_team(team):
    if not team:
        return
    cache.delete(_team_choice_cache_key(team.id, True))
    cache.delete(_team_choice_cache_key(team.id, False))
    cache.delete(_team_random_cache_key(team.id))
    cache.delete(_team_progress_cache_key(team.id))
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
        'selected_route_id',
        'selected_route__run_time',
        'choice_time',
        'timestamp',
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
        Choice.objects
        .filter(competition=competition_flag)
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
        list(InfiniteChoice.objects.filter(user__profile__active_team=active_team))
    )
    cache.set(cache_key, stats, STATS_TEAM_CACHE_TIMEOUT)
    return stats


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
    from django.contrib.auth.models import User

    mode = (request.GET.get('mode') or '').lower()
    # Backwards-compat: ?competition=true|false was the old flag
    if not mode:
        mode = 'competition' if request.GET.get('competition', 'true').lower() != 'false' else 'training'

    target_user = request.user
    if _is_trainer(request.user):
        uid = request.GET.get('user_id')
        if uid:
            try:
                target_user = User.objects.get(id=int(uid))
            except (User.DoesNotExist, ValueError):
                pass

    # ── Infinity mode: aggregate InfiniteChoice rows independent of team / file ──
    if mode == 'random':
        target_rcs = list(
            InfiniteChoice.objects.filter(user=target_user).order_by('timestamp')
        )
        team_rcs = target_rcs   # No team aggregation for random plays for now
        try:
            profile     = request.user.profile
            active_team = profile.active_team
        except Exception:
            active_team = None

        user_stats = _aggregate_random(target_rcs)
        team_stats = _cached_team_random_stats(active_team) if active_team else _aggregate_random(team_rcs)

        # Send raw timestamps; the client bins them dynamically (~50 bars)
        activity = [rc.timestamp.isoformat() for rc in target_rcs if rc.timestamp]

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

    user_choices = list(
        _choice_row_queryset(Choice.objects
        .filter(competition=competition_flag)
        .filter(team_filter)
        .filter(user_id=target_user.id)
        .order_by('timestamp')
        )
    )

    cp_ids = {c['control_pair_id'] for c in user_choices if c['control_pair_id']}
    min_time_per_cp = _min_time_per_cp(cp_ids)

    team_stats = (
        _cached_team_choice_stats(active_team, competition_flag)
        if active_team
        else _aggregate_choices(user_choices, min_time_per_cp)
    )
    user_stats = _aggregate_choices(user_choices, min_time_per_cp)

    # Activity: raw ISO timestamps; the client picks a bin width that targets ~50 bars
    activity = [c['timestamp'].isoformat() for c in user_choices if c['timestamp']]

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
        .filter(control_pair__file_id__in=file_ids,
                user__profile__active_team=active_team)
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

    Returns a JSON array starting with a 'Kaderdurchschnitt' summary row,
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

    team_users = list(
        User.objects
            .filter(profile__active_team=active_team)
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
        rcs = list(InfiniteChoice.objects.filter(user_id__in=team_user_ids))
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
    else:
        competition_flag = (mode == 'competition')
        choices = list(
            _choice_row_queryset(Choice.objects
                  .filter(competition=competition_flag, user_id__in=team_user_ids)
                  .filter(
                      Q(team=active_team) |
                      Q(team__isnull=True, user__profile__active_team=active_team)
                  )
            )
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
        athlete_rows.append({
            'athlete':      u.get_full_name() or u.username,
            'user_id':      u.id,
            'sensitivity':  '-',
            'roi_slope':    '- (-)',
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
        data.append({
            'athlete':      'Kaderdurchschnitt',
            'user_id':      None,
            'sensitivity':  '-',
            'roi_slope':    '- (-)',
            'progress':     summary_progress,
            **summary,
        })

    data.extend(athlete_rows)

    cache.set(table_cache_key, data, STATS_TEAM_CACHE_TIMEOUT)
    return JsonResponse(data, safe=False)


@login_required
@require_GET
def get_team_athletes(request):
    """List athletes (non-trainers) sharing the requesting trainer's active team."""
    from django.contrib.auth.models import User

    if not _is_trainer(request.user):
        return JsonResponse({'error': 'Not authorized'}, status=403)

    profile     = request.user.profile
    active_team = profile.active_team
    if not active_team:
        return JsonResponse({'athletes': []})

    users = (
        User.objects
        .filter(profile__active_team=active_team)
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
