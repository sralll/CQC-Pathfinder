from django.shortcuts import render

import os
import json
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse, FileResponse, Http404, HttpResponseNotAllowed
from django.views.decorators.http import require_GET
from django.contrib.auth.decorators import login_required
import datetime
from django.utils.timezone import now

@login_required
def index(request):
    return render(request, 'coursesetter.html')

@require_GET
def get_files(request):
    FILES_DIR = os.path.join(settings.BASE_DIR, 'jsonfiles')

    try:
        files = os.listdir(FILES_DIR)
        print("Files found:", files)
    except Exception as e:
        print("Error reading directory:", e)
        return JsonResponse({'message': 'Error reading files', 'error': str(e)}, status=500)

    metadata = []
    for filename in files:
        if not filename.endswith('.json'):
            continue
        file_path = os.path.join(FILES_DIR, filename)
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                cp_count = len(data.get('cP', []))
            modified_time = datetime.datetime.fromtimestamp(os.path.getmtime(file_path)).isoformat()
            metadata.append({
                'filename': filename,
                'modified': modified_time,
                'cPCount': cp_count,
                'published': data.get('published', False)  # Assuming 'published' is a key in your JSON
            })
        except Exception as e:
            print(f"Error reading {filename}:", e)

    return JsonResponse(metadata, safe=False)


def load_file(request, filename):
    # Define the directory where the files are stored
    files_dir = os.path.join(settings.BASE_DIR, 'jsonfiles')  # Ensure 'jsonfiles' is the correct folder

    # Build the full file path
    file_path = os.path.join(files_dir, filename)

    # Check if the file exists
    if not os.path.exists(file_path):
        return HttpResponseNotFound(f"File {filename} not found")

    # Try to open and read the file
    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            file_data = json.load(file)  # Assuming the file content is JSON
            return JsonResponse(file_data)  # Return the JSON data
    except Exception as e:
        return JsonResponse({'message': 'Error loading file', 'error': str(e)}, status=500)
    
def serve_map_image(request, filename):
    image_path = os.path.join(settings.BASE_DIR, 'maps', filename)
    if os.path.exists(image_path):
        return FileResponse(open(image_path, 'rb'), content_type='image/jpeg')  # or image/png
    else:
        raise Http404("Image not found")
    
def check_file_exists(request, filename):
    file_path = os.path.join(settings.FILES_DIR, filename)
    return JsonResponse({'exists': os.path.exists(file_path)})

def save_file(request):
    if request.method == 'POST':
        try:
            payload = json.loads(request.body)
            filename = payload['filename']
            data = payload['data']

            if not filename.endswith('.json'):
                return HttpResponseBadRequest('Invalid file extension.')

            file_path = os.path.join(settings.FILES_DIR, filename)

            # Ensure directory exists
            os.makedirs(settings.FILES_DIR, exist_ok=True)

            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

            return JsonResponse({'message': 'File saved successfully'})
        except Exception as e:
            # Print to console for debugging
            print("Save error:", e)
            return JsonResponse({'message': 'Error saving file', 'error': str(e)}, status=500)

    return HttpResponseBadRequest('Only POST requests are allowed.')

def delete_file(request, filename):
    if request.method != 'DELETE':
        return JsonResponse({'message': 'Method not allowed'}, status=405)

    file_path = os.path.join(settings.FILES_DIR, filename)

    if not os.path.exists(file_path):
        return JsonResponse({'message': 'File not found'}, status=404)

    try:
        os.remove(file_path)
        return JsonResponse({'message': 'File deleted successfully!'})
    except Exception as e:
        print({'message': f'Error deleting the file: {str(e)}'}, status=500)

def upload_map(request):
    if request.method == 'POST' and request.FILES.get('file'):
        file = request.FILES['file']
        allowed_types = ['image/png', 'image/jpeg']

        if file.content_type not in allowed_types:
            print({'success': False, 'message': 'Unsupported file type'}, status=400)

        # Generate timestamped filename
        timestamp = now().strftime('%Y%m%d_%H%M%S')
        ext = os.path.splitext(file.name)[1]
        filename = f"{timestamp}{ext}"

        # Save the file
        maps_dir = os.path.join(settings.BASE_DIR, 'maps')
        os.makedirs(maps_dir, exist_ok=True)
        file_path = os.path.join(maps_dir, filename)

        with open(file_path, 'wb+') as destination:
            for chunk in file.chunks():
                destination.write(chunk)

        map_url = f"/maps/{filename}"
        return JsonResponse({
            'success': True,
            'mapFile': map_url,
            'scaled': False
        })

    return JsonResponse({'success': False, 'message': 'Invalid request'}, status=400)

def toggle_publish(request, filename):
    if request.method == 'POST':
        filepath = os.path.join(settings.FILES_DIR, filename)
        
        if not os.path.exists(filepath):
            return JsonResponse({'error': 'File not found'}, status=404)

        with open(filepath, 'r+') as f:
            data = json.load(f)
            data['published'] = not data.get('published', False)
            f.seek(0)
            f.truncate()
            json.dump(data, f, indent=4)

        return JsonResponse({'success': True, 'published': data['published']})
    
    return JsonResponse({'error': 'Invalid request'}, status=400)