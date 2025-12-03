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
from botocore.exceptions import ClientError
from urllib.parse import unquote
import gc
from accounts.models import UserProfile

def get_gamefile_by_public_name(request, filename):
    from .models import publishedFile
    from accounts.models import UserProfile

    try:
        kader = request.user.userprofile.kader
    except UserProfile.DoesNotExist:
        raise publishedFile.DoesNotExist("User has no kader")

    return publishedFile.objects.get(
        filename=filename,
        kader=kader,
    )

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
    key = f'maps/{filename}'

    try:
        s3_object = s3.get_object(Bucket=bucket, Key=key)
        content_type = s3_object['ContentType']
        body = s3_object['Body'].read()

        # Return the file response
        response = HttpResponse(body, content_type=content_type)

        # Cleanup
        del s3_object
        del body
        gc.collect()

        return response

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

        # start with all publishedFile objects
        qs = publishedFile.objects.order_by('-last_edited')
        if not request.user.is_superuser:
            try:
                user_kader = request.user.userprofile.kader
                qs = qs.filter(kader=user_kader)
            except UserProfile.DoesNotExist:
                qs = qs.none()

        files = []
        for obj in qs:
            files.append({
                'filename': obj.filename,  # display name
                'modified': obj.last_edited.isoformat() if obj.last_edited else '',
                'cPCount': obj.ncP or 0,
                'published': obj.published,
                'author': obj.author or '',
            })

        return JsonResponse(files, safe=False)


    except Exception as e:
        return JsonResponse({'error': f'Error in get_files(): {str(e)}'}, status=500)

@group_required('Trainer')
def load_file(request, filename):
    try:
        gamefile = get_gamefile_by_public_name(request, filename)
    except publishedFile.DoesNotExist:
        return HttpResponseNotFound("File not found")

    try:
        file_data = gamefile.data or {}

        map_path = file_data.get("mapFile", "")
        if map_path:
            basename = os.path.splitext(os.path.basename(map_path))[0]
            mask_filename = f"masks/mask_{basename}.png"
            file_data["has_mask"] = default_storage.exists(mask_filename)

        return JsonResponse(file_data)

    except Exception as e:
        return JsonResponse(
            {"message": "Error loading file", "error": str(e)},
            status=500
        )

@group_required('Trainer')
def check_file_exists(request, filename):
    from accounts.models import UserProfile
    from .models import publishedFile

    filename = unquote(filename)

    # Resolve user's kader
    try:
        user_kader = request.user.userprofile.kader
    except UserProfile.DoesNotExist:
        return JsonResponse({'exists': False})

    unique_filename = f"{filename}_{user_kader.name}"

    exists = publishedFile.objects.filter(
        unique_filename=unique_filename
    ).exists()

    return JsonResponse({'exists': exists})


@group_required('Trainer')
def save_file(request):
    if request.method != 'POST':
        return HttpResponseBadRequest('Only POST requests are allowed.')

    try:
        payload = json.loads(request.body)
        filename = payload.get('filename')
        data = payload.get('data')

        # Count control points
        cp_list = data.get("cP", [])
        cp_count = len(cp_list) if isinstance(cp_list, list) else 0

        author_name = request.user.first_name or request.user.username

        from .models import publishedFile
        from accounts.models import UserProfile

        # Get user's kader
        try:
            user_kader = request.user.userprofile.kader
        except UserProfile.DoesNotExist:
            user_kader = None

        unique_filename = f"{filename}_{user_kader.name if user_kader else 'unknown'}"

        # Update or create entry by unique_filename
        obj, created = publishedFile.objects.update_or_create(
            unique_filename=unique_filename,
            defaults={
                'filename': filename,  # display name stays clean
                'author': author_name,
                'ncP': cp_count,
                'data': data,
                'kader': user_kader,
            }
        )

        return JsonResponse({'message': 'File saved', 'updated': not created})

    except Exception as e:
        print("Save error:", e)
        return JsonResponse({'message': 'Error saving file', 'error': str(e)}, status=500)

@group_required('Trainer')
def delete_file(request, filename):
    filename = unquote(filename)

    try:
        kader = request.user.userprofile.kader
        kader_slug = kader.name if kader else "unknown"
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'No kader assigned'}, status=403)

    unique_filename = f"{filename}_{kader_slug}"

    deleted_count, _ = publishedFile.objects.filter(
        unique_filename=unique_filename
    ).delete()

    if deleted_count == 0:
        return JsonResponse({'error': 'File not found'}, status=404)

    return JsonResponse({'message': 'File deleted successfully!'})


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
        del file
        gc.collect()
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
def toggle_publish(request, filename):  # 'filename' = base/display name
    try:
        # get the user's kader
        try:
            user_kader = request.user.userprofile.kader
            kader_slug = user_kader.name if user_kader else 'unknown'
        except UserProfile.DoesNotExist:
            kader_slug = 'unknown'

        # build the unique filename
        unique_filename = f"{filename}_{kader_slug}"

        # query by unique_filename
        gamefile = publishedFile.objects.get(unique_filename=unique_filename)
    except publishedFile.DoesNotExist:
        return JsonResponse({'error': 'File not found in database'}, status=404)

    gamefile.published = not gamefile.published
    gamefile.save()

    return JsonResponse({'success': True, 'published': gamefile.published})