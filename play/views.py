from django.shortcuts import render

import os
import json
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse, FileResponse, Http404, HttpResponseNotAllowed
from django.views.decorators.http import require_GET
from django.views.decorators.csrf import csrf_exempt
from django.contrib.auth.decorators import login_required
from django.utils.decorators import method_decorator
import datetime
from django.utils.timezone import now
from .models import UserResult

@login_required
def index(request):
    return render(request, 'play.html')

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