from django.shortcuts import render

import os
import json
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse, FileResponse, Http404, HttpResponseNotAllowed
from django.views.decorators.http import require_GET
from django.contrib.auth.decorators import login_required
from django.utils.decorators import method_decorator
import datetime
from django.utils.timezone import now
from .models import UserResult
from coursesetter.models import publishedFile
from django.core.files.storage import default_storage
from django.core.files.base import ContentFile

@login_required
def index(request):
    return render(request, 'play.html')

@require_GET
@login_required
def get_files(request):
    user = request.user

    published_files = publishedFile.objects.filter(published=True)

    metadata = []

    for pub in published_files:
        filename = pub.filename
        if not filename.endswith('.json'):
            continue

        file_path = f"jsonfiles/{filename}"
        print("Checking file in S3:", file_path)
        print("Exists?", default_storage.exists(file_path))
        # Check if file exists in S3
        if not default_storage.exists(file_path):
            continue

        try:
            with default_storage.open(file_path, 'r') as f:
                # f is a file-like object from S3
                data = json.load(f)
                cp_count = len(data.get('cP', []))
                file_base = filename.replace('.json', '')

                user_entry_count = UserResult.objects.filter(
                    user=user,
                    filename=file_base
                ).count()

                # Get last modified time from S3 metadata
                modified_time = None
                try:
                    modified_dt = default_storage.connection.meta.client.head_object(
                        Bucket=settings.AWS_STORAGE_BUCKET_NAME,
                        Key=file_path
                    )['LastModified']
                    # convert to ISO format string
                    modified_time = modified_dt.isoformat()
                except Exception:
                    # fallback: no modified time available
                    modified_time = ''

                metadata.append({
                    'filename': filename,
                    'modified': modified_time,
                    'cPCount': cp_count,
                    'userEntryCount': user_entry_count,
                    'published': True  # Always true, filtered before
                })

        except Exception as e:
            print(f"Error reading {filename} from S3:", e)

    return JsonResponse(metadata, safe=False)

@login_required
def load_file(request, filename):
    file_path = f"jsonfiles/{filename}"  # S3 key path inside the bucket

    if not default_storage.exists(file_path):
        return HttpResponseNotFound(f"File {filename} not found")

    try:
        with default_storage.open(file_path, 'r') as file:
            file_data = json.load(file)  # Read JSON content from S3
            return JsonResponse(file_data)
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