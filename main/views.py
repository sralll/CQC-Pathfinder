from django.shortcuts import render
from django.contrib.auth.decorators import login_required
import os
import json
from django.http import JsonResponse
from django.conf import settings
from pathlib import Path
from django.contrib.auth.models import User
from django.db.models import Count, Q
from play.models import UserResult
from django.views.decorators.http import require_GET

@login_required
def home_view(request):
    # Check if the user is in the 'Trainer' group
    is_trainer = request.user.groups.filter(name='Trainer').exists()

    return render(request, 'home.html', {'is_trainer': is_trainer})

@login_required
def account_view(request):
    return render(request, 'registration/account.html')  # Adjust path if necessary

@login_required
def results_view(request):
    return render(request, 'results.html')  # Adjust path if necessary

@login_required
def get_published_json_filenames(request):
    json_dir = Path(settings.BASE_DIR) / 'jsonfiles'
    result = []

    for file in json_dir.glob('*.json'):
        try:
            with open(file, 'r', encoding='utf-8') as f:
                content = json.load(f)
                if content.get('published') is True:
                    result.append({
                        'filename': file.name,
                        'modified': file.stat().st_mtime  # modification timestamp
                    })
        except Exception as e:
            print(f"Error reading {file.name}: {e}")
            continue

    # Sort by modified time (descending)
    result.sort(key=lambda x: x['modified'], reverse=True)

    # Return just the filenames (sorted)
    return JsonResponse([r['filename'] for r in result], safe=False)

from django.db.models import Sum, F, ExpressionWrapper, FloatField, Count

from django.http import JsonResponse
from play.models import UserResult
from django.contrib.auth.models import User

def get_user_summary(request):
    filename = request.GET.get('filename')
    shortfilename = filename.replace('.json', '')
    print(filename, shortfilename)
    if not filename:
        return JsonResponse({'error': 'Filename not provided'}, status=400)

    import os, json
    from django.conf import settings
    file_path = os.path.join(settings.BASE_DIR, 'jsonfiles', filename)

    try:
        with open(file_path, 'r') as f:
            cqc = json.load(f)
        total_cp = len(cqc.get('cP', []))

    except Exception as e:
        return JsonResponse({'error': f'Error reading file: {str(e)}'}, status=500)
    
    # Get users who completed all control pairs for this file
    from django.db.models import Sum, Count, F

    user_data = (
        UserResult.objects
        .filter(filename=shortfilename)
        .values('user__first_name', 'user__last_name', 'user__id')
        .annotate(
            unique_cp=Count('control_pair_index', distinct=True),
            choice_time=Sum('choice_time'),
            route_diff=Sum(F('selected_route_runtime') - F('shortest_route_runtime'))
        )
        .filter(unique_cp=total_cp)
    )

    # Add total score and sort
    users = sorted(
        [{
            'name': f"{user['user__first_name']} {user['user__last_name']}" if user['user__first_name'] else f"User_{user['user__id']}",
            'choice_time': round(user['choice_time'], 1) if user['choice_time'] else 0,
            'route_diff': round(user['route_diff'], 1) if user['route_diff'] else 0,
            'total': round((user['choice_time'] or 0) + (user['route_diff'] or 0), 1)
        } for user in user_data],
        key=lambda x: x['total']
    )

    return JsonResponse({'users': users})