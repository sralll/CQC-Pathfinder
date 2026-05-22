import os
import json
import mimetypes
import posixpath

from django.shortcuts import render
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, FileResponse, HttpResponse
from django.views.decorators.http import require_GET, require_POST
from django.contrib.auth.decorators import login_required
from django.utils.timezone import now
from django.contrib.auth.decorators import user_passes_test
from .models import publishedFile
from urllib.parse import unquote
from accounts.models import UserProfile

import os
import mimetypes
from django.conf import settings
from django.contrib.admin.views.decorators import staff_member_required
from django.http import FileResponse, HttpResponseNotFound, JsonResponse

@staff_member_required
def debug_file(request, filename):
    import os
    media_root = settings.MEDIA_ROOT
    maps_dir = os.path.join(media_root, 'maps')
    exists_dir = os.path.exists(maps_dir)
    exists_file = os.path.exists(os.path.join(maps_dir, filename))
    files = os.listdir(maps_dir) if exists_dir else []
    return JsonResponse({
        'media_root': media_root,
        'maps_dir_exists': exists_dir,
        'file_exists': exists_file,
        'files_in_maps': files[:10],  # first 10
    })


@staff_member_required
def list_media_json(request):
    media_root = settings.MEDIA_ROOT
    files = []
    for root, dirs, filenames in os.walk(media_root):
        for filename in sorted(filenames):
            filepath = os.path.join(root, filename)
            rel = os.path.relpath(filepath, media_root)
            size = os.path.getsize(filepath)
            files.append({'path': rel, 'size': size})
    return JsonResponse({'files': files})


def get_gamefile_by_public_name(request, filename):
    from .models import publishedFile
    from accounts.models import UserProfile

    try:
        user_kader = request.user.userprofile.kader
    except UserProfile.DoesNotExist:
        raise publishedFile.DoesNotExist("User has no kader")

    # Try own kader first
    try:
        return publishedFile.objects.get(filename=filename, kader=user_kader)
    except publishedFile.DoesNotExist:
        # If not found, check shared_pool kaders
        return publishedFile.objects.get(
            filename=filename,
            kader__shared_pool=True
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
    filepath = os.path.join(settings.MEDIA_ROOT, 'maps', filename)
    if not os.path.exists(filepath):
        return HttpResponseNotFound(f"Map file '{filename}' not found. Looked at: {filepath}")
    content_type, _ = mimetypes.guess_type(filepath)
    content_type = content_type or 'application/octet-stream'
    return FileResponse(open(filepath, 'rb'), content_type=content_type)

@group_required('Trainer')
@require_GET
def get_files(request):
    try:
        user = request.user

        # --- Get user's kader ---
        try:
            user_kader = user.userprofile.kader
            user_shared_pool = user_kader.shared_pool
        except UserProfile.DoesNotExist:
            user_kader = None
            user_shared_pool = False

        # Start with all published files
        qs = publishedFile.objects.order_by('-last_edited')

        if not user.is_superuser:
            if user_kader:
                # Own kader files
                own_qs = qs.filter(kader=user_kader)

                # Shared pool files from other kaders if allowed
                if user_shared_pool:
                    shared_qs = qs.filter(
                        kader__shared_pool=True
                    ).exclude(kader=user_kader)
                    qs = own_qs | shared_qs
                else:
                    qs = own_qs
            else:
                qs = publishedFile.objects.none()  # no kader → no files

        files = []
        for obj in qs.distinct():  # distinct in case of union
            editable = obj.kader == user_kader
            files.append({
                'filename': obj.filename,
                'unique_filename': obj.unique_filename, # <--- ADD THIS
                'modified': obj.last_edited.isoformat() if obj.last_edited else '',
                'cPCount': obj.ncP or 0,
                'published': obj.published,
                'author': obj.author or '',
                'shared_pool': obj.kader.shared_pool if obj.kader else False,
                'editable': editable,
                'kader': obj.kader.name if obj.kader else '',
                'batch_progress': obj.batch_progress,
                'batch_output_filename': f"{obj.filename}_batchGen_{obj.kader.name}" if obj.kader else None,
            })

        return JsonResponse({
            'files': files,
            'user_shared_pool': user_shared_pool,  # top-level info
            'user_kader': user_kader.name if user_kader else '',
        }, safe=False)

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
        file_name = gamefile.filename or "unknown"
        map_path = file_data.get("mapFile", "")
        if map_path:
            basename = os.path.splitext(os.path.basename(map_path))[0]
            mask_path = os.path.join(settings.MEDIA_ROOT, 'masks', f'mask_{basename}.png')
            file_data["has_mask"] = os.path.exists(mask_path)
        return JsonResponse({
            "metadata": {"filename": file_name},
            "content": file_data
        })
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
        from django.db.models import Q

        # Get user's kader
        try:
            user_kader = request.user.userprofile.kader
        except UserProfile.DoesNotExist:
            user_kader = None

        if not user_kader:
            return JsonResponse({'message': 'User has no kader assigned'}, status=400)

        # --- Check for name collisions across shared pool ---
        if user_kader.shared_pool:
            collision_qs = publishedFile.objects.filter(
                filename=filename,
                kader__shared_pool=True
            ).exclude(kader=user_kader)  # exclude own kader
            if collision_qs.exists():
                return JsonResponse(
                    {'message': 'Projektname bereits in Verwendung'},
                    status=400
                )

        # Build unique filename for storage
        unique_filename = f"{filename}_{user_kader.name}"

        # Update or create entry
        obj, created = publishedFile.objects.update_or_create(
            unique_filename=unique_filename,
            defaults={
                'filename': filename,
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

    try:
        file_instance = publishedFile.objects.get(unique_filename=unique_filename)
    except publishedFile.DoesNotExist:
        return JsonResponse({'error': 'File not found'}, status=404)

    file_data = file_instance.data or {}
    map_url_path = file_data.get('mapFile')

    if map_url_path:
        actual_map_name = posixpath.basename(map_url_path)

        if actual_map_name:
            map_file_path = os.path.join(settings.MEDIA_ROOT, 'maps', actual_map_name)

            try:
                if os.path.exists(map_file_path):
                    os.remove(map_file_path)
            except OSError as e:
                pass

    file_instance.delete()

    return JsonResponse({'message': 'File and associated map deleted successfully!'})

@group_required('Trainer')
def upload_map(request):
    if request.method == 'POST' and request.FILES.get('file'):
        uploaded_file = request.FILES['file']
        allowed_types = ['image/png', 'image/jpeg']
        if uploaded_file.content_type not in allowed_types:
            return JsonResponse({'success': False, 'message': 'Unsupported file type'}, status=400)

        timestamp = now().strftime('%Y%m%d_%H%M%S')
        ext = os.path.splitext(uploaded_file.name)[1]
        filename = f"{timestamp}{ext}"
        dest_path = os.path.join(settings.MEDIA_ROOT, 'maps', filename)

        try:
            with open(dest_path, 'wb') as f:
                for chunk in uploaded_file.chunks():
                    f.write(chunk)

            return JsonResponse({
                'success': True,
                'mapFile': f'/coursesetter/get_map/{filename}',
                'filename': filename,
                'scaled': False
            })
        except Exception as e:
            return JsonResponse({'success': False, 'message': str(e)}, status=500)

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