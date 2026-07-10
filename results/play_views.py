import traceback
from math import isfinite

from django.contrib.auth.decorators import login_required
from django.db.models import Count, Q, Prefetch
from django.http import HttpResponseNotFound, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_GET, require_POST

from project.models import ControlPair, File, Route
from project.media_access import serve_map_file, user_can_access_file, user_can_access_map_file

from .stats_views import _clear_stats_cache_for_team

@login_required
def index(request):
    return render(request, 'results/results.html')


def _first_play_flags(request):
    """Both first-play tutorial flags for the current user. Device type
    (desktop vs mobile) is decided client-side in play.js, so we hand both
    flags to the template and let the JS pick the matching one."""
    try:
        profile = request.user.profile
        return bool(profile.first_play_desktop), bool(profile.first_play_mobile)
    except Exception:
        return False, False


@login_required
def play(request, file_id, mode):
    if mode not in ('competition', 'training'):
        mode = 'competition'
    fp_desktop, fp_mobile = _first_play_flags(request)
    return render(request, 'results/play.html', {
        'file_id':            file_id,
        'mode':               mode,
        'tutorial':           False,
        'first_play_desktop': fp_desktop,
        'first_play_mobile':  fp_mobile,
    })


@login_required
def play_tutorial(request):
    """Render the play screen in tutorial mode. play.js detects the
    `tutorial` flag, loads the static tutorial map/JSON instead of fetching
    get_file, and drives the step-by-step overlay modals."""
    fp_desktop, fp_mobile = _first_play_flags(request)
    return render(request, 'results/play.html', {
        'file_id':            0,
        'mode':               'training',
        'tutorial':           True,
        'first_play_desktop': fp_desktop,
        'first_play_mobile':  fp_mobile,
    })


@login_required
@require_POST
def tutorial_complete(request):
    """Mark the first-play tutorial as done for the requesting device type.
    Body: {"device": "desktop"|"mobile"}.

    Sets first_play_<device> = False so the tutorial only auto-triggers once
    per device type. The matching client-side call lives in
    results/static/results/js/tutorial.js → finishTutorial → markComplete."""
    import json
    try:
        data   = json.loads(request.body or '{}')
        device = data.get('device')
        if device not in ('desktop', 'mobile'):
            return JsonResponse({'error': 'bad device'}, status=400)

        profile = request.user.profile
        if device == 'desktop':
            profile.first_play_desktop = False
        else:
            profile.first_play_mobile = False
        profile.save(update_fields=['first_play_desktop', 'first_play_mobile'])

        return JsonResponse({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@login_required
def infinite_play(request, file_id=None):
    """Procedurally-generated single-obstacle scenarios (city mode), or —
    when ``file_id`` is present — infinite play on a real uploaded map mask
    via the server-built navgraph (WP 3.x)."""
    file = None
    if file_id is not None:
        file = get_object_or_404(File, id=file_id, deleted=False)
        if not user_can_access_file(request, file):
            return HttpResponseNotFound()
    return render(request, 'results/infinite_play.html', {'infinity_file': file})


@login_required
@require_GET
def infinite_mask_maps(request):
    """List maps opted in to infinite play (`File.infinite_enabled=True`)
    that also have a navgraph artifact on disk (the opt-in toggle triggers a
    rebuild, but this existence check keeps the picker from ever offering a
    map whose build hasn't finished/failed). Team-scoped exactly like the
    existing map-serving endpoints."""
    import os
    from django.conf import settings

    try:
        active_team = request.user.profile.active_team
    except Exception:
        active_team = None

    qs = File.objects.filter(deleted=False, infinite_enabled=True).exclude(map_file='')
    if not request.user.is_superuser:
        if not active_team:
            return JsonResponse({'maps': []})
        if active_team.shared_pool:
            qs = qs.filter(Q(team=active_team) | Q(team__shared_pool=True)).distinct()
        else:
            qs = qs.filter(team=active_team)
    qs = qs.select_related('team').order_by('-last_edited')

    masks_dir = os.path.join(settings.MEDIA_ROOT, 'masks')
    maps = []
    for f in qs:
        stem, _ext = os.path.splitext(f.map_file)
        bin_path = os.path.join(masks_dir, f'mask_{stem}.navgraph.bin')
        if not os.path.isfile(bin_path):
            continue
        maps.append({
            'id': f.id,
            'filename': f.map_file,
            'name': f.name or f.map_file,
            'map_scale': f.map_scale,
        })
    return JsonResponse({'maps': maps})


def _infinite_choice_count_for_user(user):
    from .models import InfiniteChoice
    return InfiniteChoice.objects.filter(user=user).count()


@login_required
@require_GET
def infinite_user_stats(request):
    return JsonResponse({
        'choice_count': _infinite_choice_count_for_user(request.user),
    })


@login_required
@require_POST
def submit_infinite_choice(request):
    import json
    try:
        data         = json.loads(request.body)
        correct      = bool(data['correct'])
        choice_time  = float(data['choice_time'])
        shorter_time = float(data['shorter_time'])
        longer_time  = float(data['longer_time'])
        file_id      = data.get('file_id')

        file = None
        if file_id not in (None, ''):
            try:
                file_id = int(file_id)
            except (TypeError, ValueError):
                return JsonResponse({'error': 'bad file'}, status=400)
            file = File.objects.filter(
                id=file_id,
                deleted=False,
                infinite_enabled=True,
            ).first()
            if not file or not user_can_access_file(request, file):
                return JsonResponse({'error': 'file not found'}, status=404)

        from .models import InfiniteChoice
        InfiniteChoice.objects.create(
            user         = request.user,
            team         = getattr(request.user.profile, 'active_team', None),
            file         = file,
            correct      = correct,
            choice_time  = choice_time,
            shorter_time = shorter_time,
            longer_time  = longer_time,
        )
        try:
            _clear_stats_cache_for_team(request.user.profile.active_team)
        except Exception:
            pass
        return JsonResponse({
            'status': 'saved',
            'choice_count': _infinite_choice_count_for_user(request.user),
        })
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


def _json_obj(value):
    return value if isinstance(value, dict) else {}


def _json_list(value):
    return value if isinstance(value, list) else []


def _point_coord(point, key):
    if not isinstance(point, dict):
        raise ValueError('Invalid point payload')
    return float(point[key])


def _float_close(a, b, tolerance=1e-6):
    try:
        a = float(a)
        b = float(b)
    except (TypeError, ValueError):
        return False
    return isfinite(a) and isfinite(b) and abs(a - b) <= tolerance


def _reported_route_runtime_pair(routes):
    runtimes = []
    for route in _json_list(routes):
        try:
            runtime = float(route.get('run_time'))
        except (AttributeError, TypeError, ValueError):
            continue
        if isfinite(runtime):
            runtimes.append(runtime)

    if len(runtimes) != 2:
        return None
    return min(runtimes), max(runtimes)


def _delete_latest_infinite_choice_for_user(user, reported_routes):
    reported_pair = _reported_route_runtime_pair(reported_routes)
    if reported_pair is None:
        return False

    from .models import InfiniteChoice

    latest_choice = (
        InfiniteChoice.objects
        .filter(user=user)
        .order_by('-timestamp', '-id')
        .first()
    )
    if not latest_choice:
        return False

    reported_shorter, reported_longer = reported_pair
    if (
        not _float_close(latest_choice.shorter_time, reported_shorter)
        or not _float_close(latest_choice.longer_time, reported_longer)
    ):
        return False

    latest_choice.delete()
    return True


@login_required
@require_POST
def report_infinite_route(request):
    import json
    try:
        data = json.loads(request.body)
        start = data.get('start')
        goal = data.get('goal')

        try:
            active_team = getattr(request.user.profile, 'active_team', None)
        except Exception:
            active_team = None

        from .models import ReportedInfinity
        report = ReportedInfinity.objects.create(
            user=request.user,
            team=active_team,
            seed=int(data['seed']),
            pair_index=int(data['pair_index']) if data.get('pair_index') is not None else None,
            start_x=_point_coord(start, 'x'),
            start_y=_point_coord(start, 'y'),
            goal_x=_point_coord(goal, 'x'),
            goal_y=_point_coord(goal, 'y'),
            map_metres_per_unit=(
                float(data['map_metres_per_unit'])
                if data.get('map_metres_per_unit') is not None
                else None
            ),
            settings=_json_obj(data.get('settings')),
            route_indexes=_json_list(data.get('route_indexes')),
            routes=_json_list(data.get('routes')),
            skipped_barriers=_json_list(data.get('skipped_barriers')),
            route_result=_json_obj(data.get('route_result')),
            client_state=_json_obj(data.get('client_state')),
            user_agent=(request.META.get('HTTP_USER_AGENT') or '')[:512],
        )
        deleted_latest_choice = _delete_latest_infinite_choice_for_user(request.user, data.get('routes'))
        if deleted_latest_choice:
            try:
                _clear_stats_cache_for_team(active_team)
            except Exception:
                pass
        return JsonResponse({
            'status': 'reported',
            'id': report.id,
            'choice_count': _infinite_choice_count_for_user(request.user),
        })
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
            File.objects.select_related('team'),
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
        all_cps     = list(
            ControlPair.objects
            .filter(file=file)
            .order_by('order')
        )
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

        cp_ids_to_play = [cp.id for cp in cps_to_play]
        cps_to_play = list(
            ControlPair.objects
            .filter(id__in=cp_ids_to_play)
            .prefetch_related(Prefetch('routes', queryset=Route.objects.order_by('order')))
            .order_by('order')
        )

        return JsonResponse({
            'id':              file.id,
            'name':            file.name,
            'scale':           file.scale,
            'map_scale':       file.map_scale,
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
                            'obstacle':  r.obstacle,
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
    if not user_can_access_map_file(request, filename, require_published=True):
        return HttpResponseNotFound("Map not found.")
    return serve_map_file(filename)


@login_required
def get_files(request):
    profile = request.user.profile
    active_team = profile.active_team

    from .models import InfiniteChoice
    infinity_done = (
        InfiniteChoice.objects
        .filter(user=request.user)
        .values('file_id')
        .annotate(n=Count('id'))
    )
    infinity_done_map = {entry['file_id']: entry['n'] for entry in infinity_done}

    if not active_team:
        return JsonResponse({
            'files': [],
            'shared_pool': False,
            'generated_infinite_done': infinity_done_map.get(None, 0),
        })

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
          .defer('blocked_terrain')
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
            'id':               f.id,
            'name':             f.name,
            'author':           f.author or '',
            'team_name':        f.team.name if f.team else '',
            'cp_count':         f.cp_count,
            'map_file':         f.map_file,
            'infinite_enabled': bool(f.infinite_enabled),
            'last_edited':      f.last_edited.isoformat() if f.last_edited else '',
            'label': (
                {'id': f.label.id, 'name': f.label.name, 'color': f.label.color}
                if f.label else None
            ),
            'user_cp_done': user_done_map.get(f.id, 0),
            'infinite_done': infinity_done_map.get(f.id, 0),
        })

    return JsonResponse({
        'files':            files,
        'shared_pool':      active_team.shared_pool,
        'multi_team':       profile.teams.count() > 1,
        'active_team_name': active_team.name,
        'generated_infinite_done': infinity_done_map.get(None, 0),
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
        penalty     = float(data.get('penalty', 0))
        competition = bool(data.get('competition', False))

        # Cap stored choice_time so one slow control — amplified 5× by the reveal
        # penalty — can't ruin an athlete's stats. The client caps too; this is
        # the authoritative ceiling on the DB write.
        MAX_CHOICE_TIME = 30.0
        if choice_time > MAX_CHOICE_TIME:
            real        = max(0.0, choice_time - penalty)
            choice_time = MAX_CHOICE_TIME
            penalty     = max(0.0, choice_time - real)

        from .models import Choice
        cp = (
            ControlPair.objects
            .select_related('file', 'file__team')
            .filter(id=cp_id, file__deleted=False, file__published=True)
            .first()
        )
        if not cp:
            return JsonResponse({'error': 'Control pair not found'}, status=404)
        if not user_can_access_file(request, cp.file, require_published=True):
            return JsonResponse({'error': 'Permission denied'}, status=403)

        route = None
        if route_id:
            route = Route.objects.filter(id=route_id, control_pair=cp).first()
            if not route:
                return JsonResponse({'error': 'Route not found'}, status=404)

        # First attempt only — never overwrite an existing Choice (replay mode)
        _, created = Choice.objects.get_or_create(
            user=request.user,
            control_pair=cp,
            defaults={
                'team':           getattr(request.user.profile, 'active_team', None),
                'selected_route': route,
                'choice_time':    choice_time,
                'penalty':        penalty,
                'competition':    competition,
            },
        )
        if created:
            _clear_stats_cache_for_team(getattr(request.user.profile, 'active_team', None))
        return JsonResponse({'status': 'saved' if created else 'skipped'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


# ── Results overview ────────────────────────────────────────────────────────
