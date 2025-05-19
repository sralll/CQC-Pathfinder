from django.shortcuts import render

import os
import json
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse, FileResponse, Http404, HttpResponseNotAllowed
from django.views.decorators.http import require_GET, require_POST
from django.contrib.auth.decorators import login_required
import datetime
from django.utils.timezone import now
from django.contrib.auth.decorators import user_passes_test
from .models import publishedFile
from django.core.files.storage import default_storage
from django.core.files.base import ContentFile

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
    json_dir = os.path.join(settings.BASE_DIR, 'jsonfiles')
    files = []

    for filename in os.listdir(json_dir):
        if filename.endswith('.json'):
            file_path = os.path.join(json_dir, filename)
            modified = os.path.getmtime(file_path) * 1000  # Convert to milliseconds
            # Load file content to count control points (cP)
            try:
                with open(file_path, 'r') as f:
                    data = json.load(f)
                cp_count = len(data.get('cP', []))
            except:
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

@group_required('Trainer')
@login_required
def serve_map_image(request, filename):
    image_path = os.path.join(settings.BASE_DIR, 'maps', filename)
    if os.path.exists(image_path):
        return FileResponse(open(image_path, 'rb'), content_type='image/jpeg')  # or image/png
    else:
        raise Http404("Image not found")

@group_required('Trainer')
@login_required    
def check_file_exists(request, filename):
    file_path = os.path.join(settings.FILES_DIR, filename)
    return JsonResponse({'exists': os.path.exists(file_path)})

@group_required('Trainer')
@login_required
def save_file(request):
    if request.method == 'POST':
        try:
            payload = json.loads(request.body)
            filename = payload['filename']
            data = payload['data']

            if not filename.endswith('.json'):
                return HttpResponseBadRequest('Invalid file extension.')

            # Convert JSON data to string
            json_content = json.dumps(data, ensure_ascii=False, indent=2)

            # Save to S3 using default_storage
            file_path = f"jsonfiles/{filename}"  # folder prefix inside your S3 bucket
            content_file = ContentFile(json_content.encode('utf-8'))
            default_storage.save(file_path, content_file)

            return JsonResponse({'message': 'File saved successfully to S3'})
        except Exception as e:
            print("Save error:", e)
            return JsonResponse({'message': 'Error saving file', 'error': str(e)}, status=500)

    return HttpResponseBadRequest('Only POST requests are allowed.')

@group_required('Trainer')
@login_required
def delete_file(request, filename):
    if request.method != 'DELETE':
        return JsonResponse({'message': 'Method not allowed'}, status=405)

    file_path = os.path.join(settings.FILES_DIR, filename)

    if not os.path.exists(file_path):
        return JsonResponse({'message': 'File not found'}, status=404)

    try:
        os.remove(file_path)

        try:
            publishedFile.objects.filter(filename=filename).delete()
        except Exception as e:
            print(f"Error deleting DB entry for {filename}: {e}")

        return JsonResponse({'message': 'File deleted successfully!'})
    except Exception as e:
        print({'message': f'Error deleting the file: {str(e)}'})
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