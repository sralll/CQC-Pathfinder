import os
import json
import boto3
from django.shortcuts import render
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse
from django.views.decorators.http import require_GET, require_POST
from django.contrib.auth.decorators import login_required
from django.utils.timezone import now
from django.contrib.auth.decorators import user_passes_test
from .models import publishedFile
from django.core.files.storage import default_storage
from django.core.files.base import ContentFile
from botocore.exceptions import ClientError
from urllib.parse import unquote

def group_required(group_name):
    def in_group(u):
        return u.is_authenticated and u.groups.filter(name=group_name).exists()
    return user_passes_test(in_group)

@group_required('Trainer')
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
    try:
        files = []
        for obj in publishedFile.objects.order_by('-last_edited'):
            files.append({
                'filename': obj.filename,
                'modified': obj.last_edited.isoformat() if obj.last_edited else '',
                'cPCount': obj.ncP or 0,
                'published': obj.published,
                'author': obj.author or '',
            })

        return JsonResponse(files, safe=False)

    except Exception as e:
        return JsonResponse({'error': f'Error in get_files(): {str(e)}'}, status=500)

import traceback

@group_required('Trainer')
def load_file(request, filename):
    if not filename.endswith('.json'):
        filename += '.json'

    try:
        gamefile = publishedFile.objects.get(filename=filename)
    except publishedFile.DoesNotExist:
        return HttpResponseNotFound(f"File {filename} not found in database.")

    try:
        # Parse the stored JSON data (assumed to be a dict in .data)
        file_data = gamefile.data if gamefile.data else {}
        
        # Extract mapFile path from JSON
        map_path = file_data.get("mapFile", "")
        if map_path:
            basename = os.path.splitext(os.path.basename(map_path))[0]
            mask_filename = f"masks/mask_{basename}.png"
            
            # Check if mask image exists in volume
            if default_storage.exists(mask_filename):
                file_data["has_mask"] = True
            else:
                file_data["has_mask"] = False
        
        return JsonResponse(file_data)

    except Exception as e:
        print("Exception in load_file:", e)
        print(traceback.format_exc())
        return JsonResponse({'message': 'Error loading file', 'error': str(e)}, status=500)

@group_required('Trainer')
def check_file_exists(request, filename):
    filename = unquote(filename)
    file_path = f'jsonfiles/{filename}.json'
    exists = default_storage.exists(file_path)
    return JsonResponse({'exists': exists})

@group_required('Trainer')
def save_file(request):
    if request.method != 'POST':
        return HttpResponseBadRequest('Only POST requests are allowed.')

    try:
        payload = json.loads(request.body)
        filename = payload.get('filename')
        data = payload.get('data')

        if not filename or not filename.endswith('.json'):
            return HttpResponseBadRequest('Invalid or missing file name.')

        # Count control points
        cp_list = data.get("cP", [])
        cp_count = len(cp_list) if isinstance(cp_list, list) else 0

        # Get author's name
        author_name = request.user.first_name or request.user.username

        from .models import publishedFile

        # Update or create entry
        obj, created = publishedFile.objects.update_or_create(
            filename=filename,
            defaults={
                'author': author_name,
                'ncP': cp_count,
                'data': data,
            }
        )

        return JsonResponse({'message': 'File saved to database', 'updated': not created})

    except Exception as e:
        print("Save error:", e)
        return JsonResponse({'message': 'Error saving file', 'error': str(e)}, status=500)


@group_required('Trainer')
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

        with default_storage.open(json_path, 'rb') as f:
            file_content = f.read()

        archive_path = json_path.replace('jsonfiles/', 'archive/', 1)

        default_storage.save(archive_path, ContentFile(file_content))
        # Delete the main JSON file
        default_storage.delete(json_path)

        # Delete the database entry
        try:
            publishedFile.objects.filter(filename=filename+".json").delete()
        except Exception as e:
            print(f"Error deleting DB entry for {filename}: {e}")

        return JsonResponse({'message': 'File deleted successfully!'})

    except Exception as e:
        print(f"Error deleting the file: {str(e)}")
        return JsonResponse({'message': 'Error deleting the file'}, status=500)


@group_required('Trainer')
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
def toggle_publish(request, filename):
    if not filename.endswith('.json'):
        filename += '.json'

    try:
        gamefile = publishedFile.objects.get(filename=filename)
    except publishedFile.DoesNotExist:
        return JsonResponse({'error': 'File not found in database'}, status=404)

    gamefile.published = not gamefile.published
    gamefile.save()

    return JsonResponse({'success': True, 'published': gamefile.published})