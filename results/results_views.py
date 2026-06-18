from django.contrib.auth.decorators import login_required
from django.db.models import Count, Q, Prefetch
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_GET

from project.models import ControlPair, File, Route

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

    is_trainer       = request.user.groups.filter(name='Trainer').exists()
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
