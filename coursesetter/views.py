from django.shortcuts import render

import os
import json
import boto3
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

def test_view(request):
    return HttpResponse("Test works!")

def group_required(group_name):
    def in_group(u):
        return u.is_authenticated and u.groups.filter(name=group_name).exists()
    return user_passes_test(in_group)


@group_required('Trainer')
@login_required
def index(request):
    return render(request, 'coursesetter.html')

@group_required('Trainer')
@require_GET
def get_files(request):
    s3_client = boto3.client(
        's3',
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
        region_name=settings.AWS_S3_REGION_NAME
    )
    
    bucket = settings.AWS_STORAGE_BUCKET_NAME
    prefix = 'jsonfiles/'  # folder inside your bucket

    # List all objects inside the jsonfiles/ folder with .json extension
    response = s3_client.list_objects_v2(
        Bucket=bucket,
        Prefix=prefix
    )

    files = []

    # If no contents, return empty list
    if 'Contents' not in response:
        return JsonResponse(files, safe=False)

    for obj in response['Contents']:
        key = obj['Key']
        if not key.endswith('.json'):
            continue
        
        # Remove prefix to get just filename
        filename = key[len(prefix):]

        # Get last modified timestamp in milliseconds
        modified = int(obj['LastModified'].timestamp() * 1000)

        # Download the file content to count control points
        try:
            file_obj = s3_client.get_object(Bucket=bucket, Key=key)
            file_content = file_obj['Body'].read().decode('utf-8')
            data = json.loads(file_content)
            cp_count = len(data.get('cP', []))
        except Exception:
            cp_count = 0

        # Get DB publish state (default False)
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

@group_required('Trainer')
def load_file(request, filename):
    s3 = boto3.client('s3',
                      aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
                      aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
                      region_name=settings.AWS_S3_REGION_NAME)

    bucket = settings.AWS_STORAGE_BUCKET_NAME
    key = f'jsonfiles/{filename}'
    print("S3 key to fetch:", key)

    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        file_content = obj['Body'].read().decode('utf-8')
        file_data = json.loads(file_content)
        return JsonResponse(file_data)
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchKey':
            return HttpResponseNotFound(f"File {filename} not found in S3 bucket.")
        else:
            return JsonResponse({'message': 'Error loading file', 'error': str(e)}, status=500)
    except Exception as e:
        return JsonResponse({'message': 'Error loading file', 'error': str(e)}, status=500)
'''
@group_required('Trainer')
@login_required
def serve_map_image(request, filename):
    image_path = os.path.join(settings.BASE_DIR, 'maps', filename)
    if os.path.exists(image_path):
        return FileResponse(open(image_path, 'rb'), content_type='image/jpeg')  # or image/png
    else:
        raise Http404("Image not found")
'''

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
    file_path = f'jsonfiles/{filename}'

    if not default_storage.exists(file_path):
        return JsonResponse({'message': 'File not found'}, status=404)

    try:
        default_storage.delete(file_path)

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
        print(f"File saved to: {file_path}")
        # Get the URL to access the file (will be S3 URL if configured)
        map_url = default_storage.url(file_path)
        print(f"File URL: {map_url}")
        return JsonResponse({
            'success': True,
            'mapFile': map_url,
            'scaled': False
        })

    return JsonResponse({'success': False, 'message': 'Invalid request'}, status=400)

@require_POST
@group_required('Trainer')
@login_required
def toggle_publish(request, filename):
    if not filename.endswith('.json'):
        filename += '.json'

    json_path = os.path.join(settings.BASE_DIR, 'jsonfiles', filename)
    if not os.path.exists(json_path):
        return JsonResponse({'error': 'File not found'}, status=404)

    # Toggle the published state in the database
    gamefile, created = publishedFile.objects.get_or_create(filename=filename)
    gamefile.published = not gamefile.published
    gamefile.save()

    return JsonResponse({'success': True, 'published': gamefile.published})