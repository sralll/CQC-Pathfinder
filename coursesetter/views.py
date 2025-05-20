import os
import json
import boto3
from django.shortcuts import render
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse, FileResponse, Http404, HttpResponseNotAllowed
from django.views.decorators.http import require_GET, require_POST
from django.contrib.auth.decorators import login_required
from django.utils.timezone import now
from django.contrib.auth.decorators import user_passes_test
from .models import publishedFile
from django.core.files.storage import default_storage
from django.core.files.base import ContentFile
from botocore.exceptions import ClientError
from urllib.parse import unquote
from storages.backends.s3boto3 import S3Boto3Storage
from datetime import timezone

def group_required(group_name):
    def in_group(u):
        return u.is_authenticated and u.groups.filter(name=group_name).exists()
    return user_passes_test(in_group)


@group_required('Trainer')
@login_required
def index(request):
    return render(request, 'coursesetter.html')

@login_required
def get_map_file(request, filename):
    s3 = boto3.client(
        's3',
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
        region_name=settings.AWS_S3_REGION_NAME
    )

    bucket = settings.AWS_STORAGE_BUCKET_NAME
    key = f'maps/{filename}'  # 'maps/' is your upload prefix

    try:
        s3_object = s3.get_object(Bucket=bucket, Key=key)
        content_type = s3_object['ContentType']
        body = s3_object['Body'].read()
        return HttpResponse(body, content_type=content_type)
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchKey':
            return HttpResponseNotFound(f"Map file '{filename}' not found.")
        else:
            return HttpResponse(f"Error: {str(e)}", status=500)

@group_required('Trainer')
@require_GET
def get_files(request):
    prefix = 'jsonfiles/'
    files = []

    # Only works if the storage is actually S3-based
    if not isinstance(default_storage, S3Boto3Storage):
        return JsonResponse({'error': 'Storage backend is not S3'}, status=500)

    try:
        # List all files in the 'jsonfiles/' folder
        for file_info in default_storage.bucket.objects.filter(Prefix=prefix):
            key = file_info.key
            if not key.endswith('.json'):
                continue

            filename = key[len(prefix):]  # remove folder prefix

            # Read and parse file to count control points
            try:
                with default_storage.open(key, 'r') as f:
                    data = json.load(f)
                    cp_count = len(data.get('cP', []))
            except Exception:
                cp_count = 0

            # Get modified timestamp (convert to milliseconds for frontend)
            last_modified = file_info.last_modified
            if last_modified and last_modified.tzinfo is None:
                last_modified = last_modified.replace(tzinfo=timezone.utc)
            modified = int(last_modified.timestamp() * 1000) if last_modified else 0

            # Check if published in DB
            try:
                gamefile = publishedFile.objects.get(filename=filename)
                published = gamefile.published
            except publishedFile.DoesNotExist:
                published = False

            files.append({
                'filename': filename,
                'modified': modified,
                'cPCount': cp_count,
                'published': published,
            })

        return JsonResponse(files, safe=False)

    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

@group_required('Trainer')
def load_file(request, filename):
    key = f'jsonfiles/{filename}'

    if not default_storage.exists(key):
        return HttpResponseNotFound(f"File {filename} not found in storage.")

    try:
        with default_storage.open(key, 'r') as f:
            file_data = json.load(f)
        return JsonResponse(file_data)
    except Exception as e:
        return JsonResponse({'message': 'Error loading file', 'error': str(e)}, status=500)

@group_required('Trainer')
@login_required
def check_file_exists(request, filename):
    filename = unquote(filename)
    file_path = f'jsonfiles/{filename}'
    exists = default_storage.exists(file_path)
    return JsonResponse({'exists': exists})

@group_required('Trainer')
@login_required
def save_file(request):
    if request.method != 'POST':
        return HttpResponseBadRequest('Only POST requests are allowed.')

    try:
        payload = json.loads(request.body)
        filename = payload.get('filename')
        data = payload.get('data')

        if not filename or not filename.endswith('.json'):
            return HttpResponseBadRequest('Invalid or missing file name.')

        # Convert JSON data to formatted string
        json_content = json.dumps(data, ensure_ascii=False, indent=2)

        # Compose the S3 key path (folder + filename)
        file_path = f"jsonfiles/{filename}"

        # Save file content to S3 bucket via default_storage
        content_file = ContentFile(json_content.encode('utf-8'))
        saved_path = default_storage.save(file_path, content_file)

        return JsonResponse({'message': 'File saved successfully to S3', 'path': saved_path})

    except Exception as e:
        print("Save error:", e)
        return JsonResponse({'message': 'Error saving file', 'error': str(e)}, status=500)

@group_required('Trainer')
@login_required
def delete_file(request, filename):
    if request.method != 'DELETE':
        return JsonResponse({'message': 'Method not allowed'}, status=405)

    filename = unquote(filename)
    json_path = f'jsonfiles/{filename}'

    if not default_storage.exists(json_path):
        return JsonResponse({'message': 'File not found'}, status=404)

    try:
        # Try reading the JSON to get the optional mapFile path
        map_file_path = None
        try:
            with default_storage.open(json_path, 'r') as f:
                content = json.load(f)
                map_file_path = content.get('mapFile')

                if map_file_path:
                    if map_file_path.startswith('/coursesetter/get_map/'):
                        map_file_path = map_file_path.replace('/coursesetter/get_map/', 'maps/')
                    elif map_file_path.startswith('http'):
                        # fallback: extract S3 key from full URL if still using some old ones
                        map_file_path = map_file_path.split('.COM/')[-1]
        except Exception as e:
            print(f"Warning: Could not parse mapFile from JSON: {e}")

        # Delete the main JSON file
        default_storage.delete(json_path)

        # Try to delete the map file if it exists
        if map_file_path and default_storage.exists(map_file_path):
            try:
                default_storage.delete(map_file_path)
                print(f"Deleted associated map file: {map_file_path}")
            except Exception as e:
                print(f"Warning: Could not delete map file {map_file_path}: {e}")

        # Delete the database entry
        try:
            publishedFile.objects.filter(filename=filename).delete()
        except Exception as e:
            print(f"Error deleting DB entry for {filename}: {e}")

        return JsonResponse({'message': 'File deleted successfully!'})

    except Exception as e:
        print(f"Error deleting the file: {str(e)}")
        return JsonResponse({'message': 'Error deleting the file'}, status=500)


@group_required('Trainer')
@login_required
def upload_map(request):
    if request.method == 'POST' and request.FILES.get('file'):
        file = request.FILES['file']
        allowed_types = ['image/png', 'image/jpeg']

        if file.content_type not in allowed_types:
            return JsonResponse({'success': False, 'message': 'Unsupported file type'}, status=400)

        # Generate timestamped filename
        timestamp = now().strftime('%Y%m%d_%H%M%S')
        ext = os.path.splitext(file.name)[1]
        filename = f"maps/{timestamp}{ext}"  # Prefix with 'maps/' if you want to keep folder structure on S3

        # Save the file using Django's default storage (S3 in your case)
        file_path = default_storage.save(filename, file)
        # Get the URL to access the file (will be S3 URL if configured)
        map_url = default_storage.url(file_path)
        return JsonResponse({
            'success': True,
            'mapFile': map_url,
            'filename': os.path.basename(file_path),  # This line is key
            'scaled': False
        })

    return JsonResponse({'success': False, 'message': 'Invalid request'}, status=400)

@require_POST
@group_required('Trainer')
@login_required
def toggle_publish(request, filename):
    if not filename.endswith('.json'):
        filename += '.json'

    file_path = f'jsonfiles/{filename}'

    # Check if the file exists in S3
    if not default_storage.exists(file_path):
        return JsonResponse({'error': 'File not found'}, status=404)

    # Toggle the published state in the database
    gamefile, _ = publishedFile.objects.get_or_create(filename=filename)
    gamefile.published = not gamefile.published
    gamefile.save()

    return JsonResponse({'success': True, 'published': gamefile.published})