from django.shortcuts import get_object_or_404, render
from django.http import JsonResponse, FileResponse, HttpResponseNotFound
from django.views.decorators.http import require_GET, require_POST
from django.db.models import Count, Q
from .models import File, Label, ControlPair, Route
from account.decorators import role_required
from django.db.models import Prefetch
import traceback
from django.conf import settings
import os
import mimetypes

# open editor
def editor(request):
    return render(request, 'project/editor.html')

# load files
@role_required('Trainer')
@require_GET
def get_files(request):
    try:
        profile = request.user.profile
        active_team = profile.active_team

        qs = File.objects.filter(deleted=False).order_by('-last_edited')

        if not request.user.is_superuser:
            if active_team:
                if active_team.shared_pool:
                    qs = qs.filter(
                        Q(team=active_team) | Q(team__shared_pool=True)
                    ).distinct()
                else:
                    qs = qs.filter(team=active_team)
            else:
                qs = File.objects.none()

        qs = qs.annotate(cp_count=Count('control_pairs'))
        labels = Label.objects.filter(team=active_team)

        team_qs = File.objects.filter(deleted=False)

        if not request.user.is_superuser:
            if active_team:
                if active_team.shared_pool:
                    team_qs = team_qs.filter(
                        Q(team=active_team) | Q(team__shared_pool=True)
                    )
                else:
                    team_qs = team_qs.filter(team=active_team)
            else:
                team_qs = File.objects.none()

        available_teams = (
            team_qs
            .values_list("team__name", flat=True)
            .distinct()
        )

        files = []
        for obj in qs:
            files.append({
                'id': obj.id,
                'name': obj.name,
                'last_edited': obj.last_edited.isoformat() if obj.last_edited else '',
                'cp_count': obj.cp_count,
                'published': obj.published,
                'author': obj.author or '',
                'team': obj.team.name if obj.team else '',
                'editable': obj.team == active_team,
                'label': {'id': obj.label.id, 'name': obj.label.name} if obj.label else None,
                'batch_progress': obj.batch_progress,
                "can_edit": obj.team == request.user.profile.active_team,
                'team_name': obj.team.name if obj.team else '',
                'team_shared_pool': obj.team.shared_pool if obj.team else False,
            })

        return JsonResponse({
            'files': files,
            'active_team': active_team.name if active_team else '',
            'shared_pool': active_team.shared_pool if active_team else False,
            'labels': [{'id': l.id, 'name': l.name} for l in labels],
            'teams': list(filter(None, available_teams)),
        })

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)

@role_required('Trainer')
@require_GET
def open_file(request, file_id):
    try:
        profile = request.user.profile
        active_team = profile.active_team

        file = get_object_or_404(
            File.objects
            .select_related('team', 'label')
            .prefetch_related(
                Prefetch(
                    'control_pairs',
                    queryset=ControlPair.objects.prefetch_related(
                        Prefetch('routes', queryset=Route.objects.order_by('order'))
                    ).order_by('order')
                )
            ),
            id=file_id,
            deleted=False
        )

        if not request.user.is_superuser:
            if not active_team:
                return JsonResponse({'error': 'No active team'}, status=403)

            own = file.team == active_team
            shared = active_team.shared_pool and file.team and file.team.shared_pool

            if not (own or shared):
                return JsonResponse({'error': 'Permission denied'}, status=403)

        return JsonResponse({
            'project': {
                'id': file.id,
                'name': file.name,
                'scale': file.scale,
                'scaled': file.scaled,
                'map_file': file.map_file,
                'has_mask': file.has_mask,
                'blocked_terrain': file.blocked_terrain,
                'control_pairs': [
                    {
                        'id': cp.id,
                        'order': cp.order,
                        'ziel': cp.ziel,
                        'start': cp.start,
                        'complex': cp.complex,
                        'routes': [
                            {
                                'id': r.id,
                                'order': r.order,
                                'rP': r.rP,
                                'noA': r.noA,
                                'pos': r.pos,
                                'length': r.length,
                                'run_time': r.run_time,
                                'elevation': r.elevation,
                            }
                            for r in cp.routes.all()
                        ]
                    }
                    for cp in file.control_pairs.all()
                ]
            }
        })

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)

@role_required('Trainer')
@require_GET
def get_map(request, filename):
    filepath = os.path.join(settings.MEDIA_ROOT, 'maps', filename)
    if not os.path.exists(filepath):
        return HttpResponseNotFound(f"Map '{filename}' not found.")
    content_type, _ = mimetypes.guess_type(filepath)
    content_type = content_type or 'application/octet-stream'
    return FileResponse(open(filepath, 'rb'), content_type=content_type)


@role_required('Trainer')
@require_POST
def toggle_publish(request, file_id):
    try:
        file = get_object_or_404(
            File,
            id=file_id,
            team=request.user.profile.active_team
        )

        file.published = not file.published
        file.save()

        return JsonResponse({
            'published': file.published
        })

    except Exception as e:
        traceback.print_exc()

        return JsonResponse({
            'error': str(e)
        }, status=500)