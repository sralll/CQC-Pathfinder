from django.shortcuts import render
import json
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound
from django.views.decorators.http import require_GET
from django.contrib.auth.decorators import login_required
from .models import UserResult
from coursesetter.models import publishedFile
from django.core.files.storage import default_storage
from storages.backends.s3boto3 import S3Boto3Storage

@login_required
def index(request):
    return render(request, 'play.html')

@require_GET
@login_required
def get_files(request):
    user = request.user
    metadata = []

    try:
        # Only load published files
        files = publishedFile.objects.filter(published=True)

        for pub in files:
            filename = pub.filename
            cp_count = pub.ncP or 0
            file_base = filename.replace('.json', '')

            # Count how many control pairs the user has already entered
            existing_entries = UserResult.objects.filter(
                user=user,
                filename=file_base
            ).values_list('control_pair_index', flat=True)

            metadata.append({
                'filename': filename,
                'modified': pub.last_edited.isoformat() if pub.last_edited else '',
                'cPCount': cp_count,
                'userEntryCount': existing_entries.count(),
                'published': True,
            })

        return JsonResponse(metadata, safe=False)

    except Exception as e:
        return JsonResponse({'error': f'Error in get_files(): {str(e)}'}, status=500)

@login_required
def load_file(request, filename):
    if not filename.endswith('.json'):
        filename += '.json'

    try:
        # Load JSON data from DB
        gamefile = publishedFile.objects.get(filename=filename)
        data = gamefile.data or {}  # already a dict, no need for json.loads

        # Extract base name for UserResult lookup
        file_base = filename.replace('.json', '')

        # Get control point count from JSON data
        cp_count = len(data.get('cP', []))

        # Get existing control point indices for this user
        existing_entries = list(
            UserResult.objects.filter(user=request.user, filename=file_base)
            .values_list('control_pair_index', flat=True)
        )

        # Determine missing CP indices
        missing_cps = [i for i in range(cp_count) if i not in existing_entries]

        return JsonResponse({
            'data': data,
            'missingCPs': missing_cps
        })

    except publishedFile.DoesNotExist:
        return HttpResponseNotFound(f"File {filename} not found in database.")
    except Exception as e:
        return JsonResponse({'message': 'Error loading file', 'error': str(e)}, status=500)
    
@login_required
def submit_result(request):
    if request.method == 'POST':
        data = json.loads(request.body)

        # Check if an entry with same user, filename, and control_pair_index already exists
        exists = UserResult.objects.filter(
            user=request.user,
            filename=data['filename'],
            control_pair_index=data['control_pair_index']
        ).exists()

        if exists:
            return JsonResponse({'status': 'duplicate', 'message': 'Result already exists'}, status=200)

        # Create the new result
        result = UserResult.objects.create(
            user=request.user,
            filename=data['filename'],
            control_pair_index=data['control_pair_index'],
            choice_time=data['choice_time'],
            selected_route_runtime=data['selected_route_runtime'],
            shortest_route_runtime=data['shortest_route_runtime']
        )

        return JsonResponse({'status': 'success', 'result_id': result.id})

    return JsonResponse({'error': 'Invalid request'}, status=400)