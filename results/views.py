from django.shortcuts import render, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse, FileResponse, HttpResponseNotFound
from django.views.decorators.http import require_GET, require_POST
from django.db.models import Count, Min, Q, Prefetch
from django.conf import settings
from project.models import File, ControlPair, Route
import traceback
import os
import mimetypes


@login_required
def index(request):
    return render(request, 'results/results.html')


@login_required
def play(request, file_id, mode):
    if mode not in ('competition', 'training'):
        mode = 'competition'
    return render(request, 'results/play.html', {'file_id': file_id, 'mode': mode})


@login_required
def random_play(request):
    """Procedurally-generated single-obstacle scenarios."""
    return render(request, 'results/random_play.html')


@login_required
@require_POST
def submit_random_choice(request):
    import json
    try:
        data         = json.loads(request.body)
        correct      = bool(data['correct'])
        choice_time  = float(data['choice_time'])
        shorter_time = float(data['shorter_time'])
        longer_time  = float(data['longer_time'])

        from .models import RandomChoice
        RandomChoice.objects.create(
            user         = request.user,
            correct      = correct,
            choice_time  = choice_time,
            shorter_time = shorter_time,
            longer_time  = longer_time,
        )
        return JsonResponse({'status': 'saved'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@login_required
@require_GET
def get_file(request, file_id):
    try:
        profile     = request.user.profile
        active_team = profile.active_team

        file = get_object_or_404(
            File.objects
            .select_related('team', 'label')
            .prefetch_related(
                Prefetch('control_pairs',
                    queryset=ControlPair.objects.prefetch_related(
                        Prefetch('routes', queryset=Route.objects.order_by('order'))
                    ).order_by('order'))
            ),
            id=file_id,
            deleted=False,
            published=True,
        )

        if not request.user.is_superuser:
            if not active_team:
                return JsonResponse({'error': 'No active team'}, status=403)
            own    = file.team == active_team
            shared = active_team.shared_pool and file.team and file.team.shared_pool
            if not (own or shared):
                return JsonResponse({'error': 'Permission denied'}, status=403)

        # ── First-attempt / replay logic ─────────────────────────
        # The Choice model has a unique constraint on (user, control_pair),
        # so a CP is "done" for the user if any Choice exists for it
        # (irrespective of competition vs. training mode).
        from .models import Choice
        all_cps     = list(file.control_pairs.all())
        done_cp_ids = set(
            Choice.objects
                  .filter(user=request.user, control_pair__file_id=file_id)
                  .values_list('control_pair_id', flat=True)
        )
        remaining = [cp for cp in all_cps if cp.id not in done_cp_ids]

        if not remaining:
            # Everything's been answered before — play full file again, no save
            cps_to_play = all_cps
            replay      = True
        else:
            # First attempt (neu) or resuming a partial run (begonnen)
            cps_to_play = remaining
            replay      = False

        return JsonResponse({
            'id':              file.id,
            'name':            file.name,
            'scale':           file.scale,
            'scaled':          file.scaled,
            'map_file':        file.map_file,
            'blocked_terrain': file.blocked_terrain,
            'replay':          replay,
            'total_cp_count':  len(all_cps),
            'done_cp_count':   len(all_cps) - len(remaining),
            'control_pairs': [
                {
                    'id':      cp.id,
                    'order':   cp.order,
                    'ziel':    cp.ziel,
                    'start':   cp.start,
                    'complex': cp.complex,
                    'routes': [
                        {
                            'id':        r.id,
                            'order':     r.order,
                            'rP':        r.rP,
                            'noA':       r.noA,
                            'pos':       r.pos,
                            'length':    r.length,
                            'run_time':  r.run_time,
                            'elevation': r.elevation,
                        }
                        for r in cp.routes.all()
                    ],
                }
                for cp in cps_to_play
            ],
        })

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@login_required
@require_GET
def get_map(request, filename):  # noqa — kept before submit_result for logical grouping
    filepath = os.path.join(settings.MEDIA_ROOT, 'maps', filename)
    if not os.path.exists(filepath):
        return HttpResponseNotFound(f"Map '{filename}' not found.")
    content_type, _ = mimetypes.guess_type(filepath)
    content_type = content_type or 'application/octet-stream'
    return FileResponse(open(filepath, 'rb'), content_type=content_type)


@login_required
def get_files(request):
    profile = request.user.profile
    active_team = profile.active_team

    if not active_team:
        return JsonResponse({'files': [], 'shared_pool': False})

    qs = File.objects.filter(deleted=False, published=True)

    if not request.user.is_superuser:
        if active_team.shared_pool:
            qs = qs.filter(
                Q(team=active_team) | Q(team__shared_pool=True)
            ).distinct()
        else:
            qs = qs.filter(team=active_team)

    qs = (qs
          .annotate(cp_count=Count('control_pairs'))
          .select_related('team', 'label')
          .order_by('-last_edited'))

    file_list = list(qs)
    file_ids  = [f.id for f in file_list]

    # Count how many CPs the requesting user has already made a choice for, per file
    from .models import Choice
    user_done = (
        Choice.objects
        .filter(user=request.user, control_pair__file_id__in=file_ids)
        .values('control_pair__file_id')
        .annotate(n=Count('id', distinct=True))
    )
    user_done_map = {entry['control_pair__file_id']: entry['n'] for entry in user_done}

    files = []
    for f in file_list:
        files.append({
            'id':          f.id,
            'name':        f.name,
            'author':      f.author or '',
            'team_name':   f.team.name if f.team else '',
            'cp_count':    f.cp_count,
            'last_edited': f.last_edited.isoformat() if f.last_edited else '',
            'label': (
                {'id': f.label.id, 'name': f.label.name, 'color': f.label.color}
                if f.label else None
            ),
            'user_cp_done': user_done_map.get(f.id, 0),
        })

    return JsonResponse({
        'files':            files,
        'shared_pool':      active_team.shared_pool,
        'multi_team':       profile.teams.count() > 1,
        'active_team_name': active_team.name,
    })


@login_required
@require_POST
def submit_result(request):
    import json
    try:
        data        = json.loads(request.body)
        cp_id       = data['control_pair_id']
        route_id    = data.get('selected_route_id')
        choice_time = float(data['choice_time'])
        competition = bool(data.get('competition', False))

        from .models import Choice
        cp    = get_object_or_404(ControlPair, id=cp_id)
        route = get_object_or_404(Route, id=route_id) if route_id else None

        # First attempt only — never overwrite an existing Choice (replay mode)
        _, created = Choice.objects.get_or_create(
            user=request.user,
            control_pair=cp,
            defaults={
                'team':           getattr(request.user.profile, 'active_team', None),
                'selected_route': route,
                'choice_time':    choice_time,
                'competition':    competition,
            },
        )
        return JsonResponse({'status': 'saved' if created else 'skipped'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


# ── Results overview ────────────────────────────────────────────────────────

@login_required
def results_overview(request):
    return render(request, 'results/overview.html')


@login_required
@require_GET
def get_files_overview(request):
    """Like get_files but adds results_count: number of users who have
    submitted a choice for every control pair in the file."""
    from .models import Choice

    profile     = request.user.profile
    active_team = profile.active_team

    if not active_team:
        return JsonResponse({'files': [], 'shared_pool': False})

    qs = File.objects.filter(deleted=False, published=True)
    if not request.user.is_superuser:
        if active_team.shared_pool:
            qs = qs.filter(
                Q(team=active_team) | Q(team__shared_pool=True)
            ).distinct()
        else:
            qs = qs.filter(team=active_team)

    qs = (qs
          .annotate(cp_count=Count('control_pairs', distinct=True))
          .select_related('team', 'label')
          .order_by('-last_edited'))

    file_list    = list(qs)
    file_ids     = [f.id for f in file_list]
    cp_count_map = {f.id: f.cp_count for f in file_list}

    # Count users who have completed every CP in each file
    user_cp_counts = (
        Choice.objects
        .filter(control_pair__file_id__in=file_ids)
        .values('control_pair__file_id', 'user_id')
        .annotate(n=Count('id', distinct=True))
    )
    results_count_map = {}
    for entry in user_cp_counts:
        fid = entry['control_pair__file_id']
        if cp_count_map.get(fid, 0) > 0 and entry['n'] >= cp_count_map[fid]:
            results_count_map[fid] = results_count_map.get(fid, 0) + 1

    files = []
    for f in file_list:
        files.append({
            'id':             f.id,
            'name':           f.name,
            'author':         f.author or '',
            'team_name':      f.team.name if f.team else '',
            'cp_count':       f.cp_count,
            'last_edited':    f.last_edited.isoformat() if f.last_edited else '',
            'label':          (
                {'id': f.label.id, 'name': f.label.name, 'color': f.label.color}
                if f.label else None
            ),
            'results_count':  results_count_map.get(f.id, 0),
        })

    return JsonResponse({
        'files':            files,
        'shared_pool':      active_team.shared_pool,
        'multi_team':       profile.teams.count() > 1,
        'active_team_name': active_team.name,
    })


# ── Per-file results ─────────────────────────────────────────────────────────

@login_required
def file_results(request, file_id):
    return render(request, 'results/file_results.html', {'file_id': file_id})


@login_required
@require_GET
def get_file_results(request, file_id):
    from .models import Choice
    from collections import defaultdict

    file = get_object_or_404(File, id=file_id, deleted=False, published=True)

    # Permission check
    if not request.user.is_superuser:
        profile     = request.user.profile
        active_team = profile.active_team
        if not active_team:
            return JsonResponse({'error': 'No active team'}, status=403)
        own    = file.team == active_team
        shared = active_team.shared_pool and file.team and file.team.shared_pool
        if not (own or shared):
            return JsonResponse({'error': 'Permission denied'}, status=403)

    # Load all CPs and their routes (min run_time per CP)
    cps = list(
        ControlPair.objects
        .filter(file=file)
        .prefetch_related(Prefetch('routes', queryset=Route.objects.all()))
        .order_by('order')
    )
    cp_ids   = [cp.id for cp in cps]
    cp_count = len(cp_ids)

    min_time_per_cp = {}
    for cp in cps:
        times = [r.run_time for r in cp.routes.all() if r.run_time]
        min_time_per_cp[cp.id] = min(times) if times else None

    # Load all choices for these CPs
    choices = (
        Choice.objects
        .filter(control_pair_id__in=cp_ids)
        .select_related('user', 'selected_route')
    )

    # Group by user
    user_choices = defaultdict(list)
    for c in choices:
        user_choices[c.user_id].append(c)

    # Build cp_id → order lookup for sorting per_cp
    cp_order_map = {cp.id: cp.order for cp in cps}

    results = []
    for user_id, clist in user_choices.items():
        if len(clist) < cp_count:
            continue  # hasn't completed every CP

        user         = clist[0].user
        has_training = any(not c.competition for c in clist)

        # Per-CP breakdown, sorted by CP order
        per_cp = []
        for c in sorted(clist, key=lambda x: cp_order_map.get(x.control_pair_id, 0)):
            cp_min    = min_time_per_cp.get(c.control_pair_id)
            route_diff = 0.0
            if c.selected_route and c.selected_route.run_time and cp_min:
                route_diff = max(0.0, c.selected_route.run_time - cp_min)
            per_cp.append({
                'choice_time': round(c.choice_time or 0, 2),
                'route_diff':  round(route_diff, 2),
                'route_id':    c.selected_route_id,
                'competition': c.competition,
            })

        choice_time_sum = sum(p['choice_time'] for p in per_cp)
        time_diff_sum   = sum(p['route_diff']  for p in per_cp)

        results.append({
            'user_id':      user_id,
            'name':         (user.get_full_name() or user.username) if user else '—',
            'choice_time':  round(choice_time_sum, 2),
            'time_diff':    round(time_diff_sum,   2),
            'total':        round(choice_time_sum + time_diff_sum, 2),
            'has_training': has_training,
            'per_cp':       per_cp,
        })

    results.sort(key=lambda x: x['total'])

    is_trainer       = request.user.is_superuser or request.user.groups.filter(name='Trainer').exists()
    user_has_results = request.user.id in {r['user_id'] for r in results}

    # Per-CP baseline: average of the 3 fastest athletes (choice_time + route_diff)
    cp_avgs = []
    for i in range(cp_count):
        vals = sorted(
            r['per_cp'][i]['choice_time'] + r['per_cp'][i]['route_diff']
            for r in results if i < len(r['per_cp'])
        )
        top3 = vals[:3]
        cp_avgs.append(round(sum(top3) / len(top3), 2) if top3 else 0)

    return JsonResponse({
        'file_name':        file.name,
        'cp_count':         cp_count,
        'cp_avgs':          cp_avgs,
        'results':          results,
        'is_trainer':       is_trainer,
        'user_has_results': user_has_results,
    })


# ── Personal stats ───────────────────────────────────────────────────────────

@login_required
def stats_view(request):
    is_trainer = request.user.is_superuser or request.user.groups.filter(name='Trainer').exists()
    return render(request, 'results/stats.html', {'is_trainer': is_trainer})


CHOICE_BUCKETS = ('fastest', 'less_5', 'between_5_10', 'more_10')


def _bucket_choice(choice, min_time_per_cp):
    """Classify a competition Choice by how much slower than the fastest
    route the selected route was. Returns (bucket, time_lost) or None if
    the choice can't be evaluated (no route data)."""
    cp_min = min_time_per_cp.get(choice.control_pair_id)
    if not cp_min or not choice.selected_route or not choice.selected_route.run_time:
        return None
    diff = choice.selected_route.run_time - cp_min
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
        sum_choice_time += c.choice_time or 0
        sum_route_diff  += time_lost
        n += 1
    return {
        'total':           n,
        'counts':          counts,
        'avg_choice_time': round(sum_choice_time / n, 2) if n else 0,
        'avg_route_diff':  round(sum_route_diff  / n, 2) if n else 0,
    }


def _bucket_random(rc):
    """Classify a RandomChoice the same way the donut buckets Choices."""
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
    from .models import Choice, RandomChoice
    from collections import defaultdict
    from django.contrib.auth.models import User

    is_trainer = request.user.is_superuser or request.user.groups.filter(name='Trainer').exists()
    mode = (request.GET.get('mode') or '').lower()
    # Backwards-compat: ?competition=true|false was the old flag
    if not mode:
        mode = 'competition' if request.GET.get('competition', 'true').lower() != 'false' else 'training'

    target_user = request.user
    if is_trainer:
        uid = request.GET.get('user_id')
        if uid:
            try:
                target_user = User.objects.get(id=int(uid))
            except (User.DoesNotExist, ValueError):
                pass

    # ── Random mode: aggregate RandomChoice rows independent of team / file ──
    if mode == 'random':
        target_rcs = list(
            RandomChoice.objects.filter(user=target_user).order_by('timestamp')
        )
        team_rcs = target_rcs   # No team aggregation for random plays for now
        try:
            profile     = request.user.profile
            active_team = profile.active_team
        except Exception:
            active_team = None
        if active_team:
            team_rcs = list(
                RandomChoice.objects
                .filter(user__profile__active_team=active_team)
                .order_by('timestamp')
            )

        user_stats = _aggregate_random(target_rcs)
        team_stats = _aggregate_random(team_rcs)

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
        team_filter = (
            Q(team=active_team) |
            Q(team__isnull=True, user__profile__active_team=active_team)
        )
    else:
        team_filter = Q(user=target_user)

    choices = list(
        Choice.objects
        .filter(competition=competition_flag)
        .filter(team_filter)
        .select_related('selected_route')
        .order_by('timestamp')
    )

    cp_ids = {c.control_pair_id for c in choices if c.control_pair_id}
    cps = (
        ControlPair.objects
        .filter(id__in=cp_ids)
        .prefetch_related(Prefetch('routes', queryset=Route.objects.all()))
    )
    min_time_per_cp = {}
    for cp in cps:
        times = [r.run_time for r in cp.routes.all() if r.run_time]
        min_time_per_cp[cp.id] = min(times) if times else None

    user_choices = [c for c in choices if c.user_id == target_user.id]

    team_stats = _aggregate_choices(choices,      min_time_per_cp)
    user_stats = _aggregate_choices(user_choices, min_time_per_cp)

    # Activity: raw ISO timestamps; the client picks a bin width that targets ~50 bars
    activity = [c.timestamp.isoformat() for c in user_choices if c.timestamp]

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


@login_required
@require_GET
def get_stats_table(request):
    """Per-athlete trainer table — competition / training / random.

    Returns a JSON array starting with a 'Kaderdurchschnitt' summary row,
    followed by one row per athlete in the requester's active team who has
    data in the chosen mode. Each row has the same keys regardless of mode
    so the existing renderer doesn't need to branch.
    """
    from .models import Choice, RandomChoice
    from django.contrib.auth.models import User

    mode = (request.GET.get('mode') or 'competition').lower()
    is_trainer = request.user.is_superuser or request.user.groups.filter(name='Trainer').exists()
    if not is_trainer:
        return JsonResponse({'error': 'Not authorized'}, status=403)

    profile     = request.user.profile
    active_team = profile.active_team
    if not active_team:
        return JsonResponse([], safe=False)

    team_users = list(
        User.objects
            .filter(profile__active_team=active_team)
            .exclude(groups__name='Trainer')
            .order_by('last_name', 'first_name')
    )
    team_user_ids = {u.id for u in team_users}

    def aggregate_rows(rows, classify):
        """`rows` are raw items (Choice or RandomChoice). `classify(row)` →
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
        rcs = list(RandomChoice.objects.filter(user_id__in=team_user_ids))
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
            Choice.objects
                  .filter(competition=competition_flag, user_id__in=team_user_ids)
                  .filter(
                      Q(team=active_team) |
                      Q(team__isnull=True, user__profile__active_team=active_team)
                  )
                  .select_related('selected_route')
        )
        per_user = {}
        for c in choices:
            per_user.setdefault(c.user_id, []).append(c)

        cp_ids = {c.control_pair_id for c in choices if c.control_pair_id}
        cps = (
            ControlPair.objects
                       .filter(id__in=cp_ids)
                       .prefetch_related(Prefetch('routes', queryset=Route.objects.all()))
        )
        min_time_per_cp = {}
        for cp in cps:
            times = [r.run_time for r in cp.routes.all() if r.run_time]
            min_time_per_cp[cp.id] = min(times) if times else None

        def classify(c):
            cp_min = min_time_per_cp.get(c.control_pair_id)
            if not cp_min or not c.selected_route or not c.selected_route.run_time:
                return None
            diff = c.selected_route.run_time - cp_min
            pct  = diff / cp_min
            if   diff <= 0:  bucket = 'fastest'
            elif pct < 0.05: bucket = 'less_5'
            elif pct < 0.10: bucket = 'between_5_10'
            else:            bucket = 'more_10'
            return (bucket, max(0.0, diff), c.choice_time)

        all_rows  = choices
        get_rows  = lambda uid: per_user.get(uid, [])

    # ── Build rows ────────────────────────────────────────────────────
    data = []

    summary = aggregate_rows(all_rows, classify)
    if summary:
        data.append({
            'athlete':      'Kaderdurchschnitt',
            'sensitivity':  '-',
            'roi_slope':    '- (-)',
            **summary,
        })

    for u in team_users:
        s = aggregate_rows(get_rows(u.id), classify)
        if s is None:
            continue
        data.append({
            'athlete':      u.get_full_name() or u.username,
            'sensitivity':  '-',
            'roi_slope':    '- (-)',
            **s,
        })

    return JsonResponse(data, safe=False)


@login_required
@require_GET
def get_team_athletes(request):
    """List athletes (non-trainers) sharing the requesting trainer's active team."""
    from django.contrib.auth.models import User

    is_trainer = request.user.is_superuser or request.user.groups.filter(name='Trainer').exists()
    if not is_trainer:
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
