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
    prefix = 'jsonfiles/'
    metadata = []

    if not isinstance(default_storage, S3Boto3Storage):
        return JsonResponse({'error': 'Storage backend is not S3'}, status=500)

    try:
        for file_info in default_storage.bucket.objects.filter(Prefix=prefix):
            key = file_info.key
            if not key.endswith('.json'):
                continue

            filename = key[len(prefix):]

            try:
                pub = publishedFile.objects.get(filename=filename)
            except publishedFile.DoesNotExist:
                continue  # skip files not in DB

            if not pub.published:
                continue

            cp_count = pub.ncP or 0
            file_base = filename.replace('.json', '')

            # Find missing control point indices
            existing_entries = UserResult.objects.filter(
                user=user, filename=file_base
            ).values_list('control_pair_index', flat=True)

            modified_time = ''
            try:
                head = default_storage.connection.meta.client.head_object(
                    Bucket=settings.AWS_STORAGE_BUCKET_NAME,
                    Key=key
                )
                modified_dt = head.get('LastModified')
                if modified_dt:
                    # Convert to ISO string for frontend
                    modified_time = modified_dt.isoformat()
            except Exception:
                modified_time = ''

            metadata.append({
                'filename': filename,
                'modified': modified_time,
                'cPCount': cp_count,
                'userEntryCount': existing_entries,
                'published': True,
            })

        return JsonResponse(metadata, safe=False)

    except Exception as e:
        return JsonResponse({'error': f'Error in get_files(): {str(e)}'}, status=500)

@login_required
def load_file(request, filename):
    file_path = f"jsonfiles/{filename}"

    if not default_storage.exists(file_path):
        return HttpResponseNotFound(f"File {filename} not found")

    try:
        with default_storage.open(file_path, 'r') as file:
            data = json.load(file)

        # Extract base name for DB comparison (filename without .json)
        file_base = filename.replace('.json', '')

        # Get control point count from the loaded file
        cp_count = len(data.get('cP', []))

        # Query existing entries for this user and file
        existing_entries = list(
            UserResult.objects.filter(user=request.user, filename=file_base)
            .values_list('control_pair_index', flat=True)  # assumes you store cpIndex
        )

        # Determine missing control points
        missing_cps = [i for i in range(cp_count) if i not in existing_entries]

        return JsonResponse({
            'data': data,
            'missingCPs': missing_cps
        })

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