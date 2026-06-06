from django.shortcuts import render, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse, FileResponse, HttpResponseNotFound
from django.views.decorators.http import require_GET
from django.db.models import Count, Q, Prefetch
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

        return JsonResponse({
            'id':              file.id,
            'name':            file.name,
            'scale':           file.scale,
            'scaled':          file.scaled,
            'map_file':        file.map_file,
            'blocked_terrain': file.blocked_terrain,
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
                for cp in file.control_pairs.all()
            ],
        })

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@login_required
@require_GET
def get_map(request, filename):
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

    files = []
    for f in qs:
        files.append({
            'id': f.id,
            'name': f.name,
            'author': f.author or '',
            'team_name': f.team.name if f.team else '',
            'cp_count': f.cp_count,
            'last_edited': f.last_edited.isoformat() if f.last_edited else '',
            'label': (
                {'id': f.label.id, 'name': f.label.name, 'color': f.label.color}
                if f.label else None
            ),
        })

    return JsonResponse({
        'files': files,
        'shared_pool': active_team.shared_pool,
        'multi_team': profile.teams.count() > 1,
        'active_team_name': active_team.name,
    })
