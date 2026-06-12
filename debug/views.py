import os
import json
from django.conf import settings
from django.contrib.admin.views.decorators import staff_member_required
from django.http import FileResponse, HttpResponseNotFound, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.db import transaction
from project.models import File, ControlPair, Route

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

@csrf_exempt
@staff_member_required
def upload_editor_json(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    # We expect the 'cqc' object from the editor
    cqc = data.get('cqc') or data # Support both {cqc: {...}} and the cqc object itself

    file_name = cqc.get('mapFile') # This is often a URL or path in the JS
    # If mapFile is a URL, we try to extract the filename or use a provided name
    if file_name:
        file_name = file_name.split('/')[-1].split('.')[0]

    if not file_name:
        return JsonResponse({'error': 'Could not determine file name from JSON'}, status=400)

    try:
        with transaction.atomic():
            # 1. Find or create the File
            file_obj, created = File.objects.get_or_create(name=file_name)

            # 2. Update File metadata from cqc
            file_obj.scale = cqc.get('scale')
            file_obj.map_file = cqc.get('mapFile')
            file_obj.has_mask = cqc.get('has_mask', False)
            file_obj.blocked_terrain = cqc.get('blockedTerrain')
            file_obj.published = cqc.get('published', False)
            file_obj.save()

            # 3. Clear old Control Pairs (cascades to Routes)
            file_obj.control_pairs.all().delete()

            # 4. Create new Control Pairs and Routes
            cps_data = cqc.get('cP', [])
            for i, cp_item in enumerate(cps_data):
                cp = ControlPair.objects.create(
                    file=file_obj,
                    order=i, # use index as order
                    start=cp_item.get('start'),
                    ziel=cp_item.get('ziel'),
                    complex=cp_item.get('complex', False)
                )

                routes_data = cp_item.get('route', []) # in JS it is .route, in model it is .routes
                for j, route_item in enumerate(routes_data):
                    Route.objects.create(
                        control_pair=cp,
                        order=j,
                        rP=route_item.get('rP'),
                        noA=route_item.get('noA'),
                        pos=route_item.get('pos'),
                        length=route_item.get('length'),
                        run_time=route_item.get('runTime'), # in JS it is .runTime
                        elevation=route_item.get('elevation')
                    )

        return JsonResponse({'ok': True, 'file': file_obj.name, 'created': created})
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)