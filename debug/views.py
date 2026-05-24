import os
from django.conf import settings
from django.contrib.admin.views.decorators import staff_member_required
from django.http import FileResponse, HttpResponseNotFound, JsonResponse
from django.views.decorators.csrf import csrf_exempt

@staff_member_required  
def debug_file(request, filename):
    maps_dir = os.path.join(settings.MEDIA_ROOT, 'maps')
    return JsonResponse({
        'pid': os.getpid(),
        'maps_dir_exists': os.path.exists(maps_dir),
        'files': os.listdir(maps_dir) if os.path.exists(maps_dir) else []
    })

@staff_member_required
def list_media_json(request):
    import os
    media_root = settings.MEDIA_ROOT
    files = []
    for root, dirs, filenames in os.walk(media_root):
        for filename in sorted(filenames):
            filepath = os.path.join(root, filename)
            rel = os.path.relpath(filepath, media_root)
            size = os.path.getsize(filepath)
            files.append({'path': rel, 'size': size})
    return JsonResponse({'pid': os.getpid(), 'files': files})

@csrf_exempt
@staff_member_required
def upload_media_file(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    
    file = request.FILES.get('file')
    filepath = request.POST.get('path')
    
    if not file or not filepath:
        return JsonResponse({'error': 'Missing file or path'}, status=400)
    
    # Normalize Windows backslashes to forward slashes
    filepath = filepath.replace('\\', '/')
    
    full_path = os.path.join(settings.MEDIA_ROOT, filepath)
    
    # Prevent path traversal
    if not os.path.abspath(full_path).startswith(os.path.abspath(settings.MEDIA_ROOT)):
        return JsonResponse({'error': 'Invalid path'}, status=400)
    
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    
    with open(full_path, 'wb') as f:
        for chunk in file.chunks():
            f.write(chunk)
    
    return JsonResponse({'ok': True, 'path': filepath})