import os
import json
import boto3
from django.shortcuts import render
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse, FileResponse
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
from PIL import Image
from io import BytesIO
import onnxruntime as ort
import numpy as np
from types import SimpleNamespace
from PIL import UnidentifiedImageError

def group_required(group_name):
    def in_group(u):
        return u.is_authenticated and u.groups.filter(name=group_name).exists()
    return user_passes_test(in_group)

@group_required('Trainer')
def index(request):
    return render(request, 'coursesetter.html')

@group_required('Trainer')
def upload_mask(request):
    if request.method == 'POST' and 'mask' in request.FILES:
        uploaded_file = request.FILES['mask']
        filename = f"masks/{uploaded_file.name}"  # Save in 'masks/' directory in S3

        path = default_storage.save(filename, ContentFile(uploaded_file.read()))
        return JsonResponse({'status': 'success', 'path': path})
    return HttpResponseBadRequest('No mask file received')


@group_required('Trainer')
def get_mask(request, filename):
    key = f"masks/{filename}"

    if not default_storage.exists(key):
        return HttpResponseNotFound("Mask not found.")

    file = default_storage.open(key, 'rb')
    response = FileResponse(file, content_type='image/png')
    response['Content-Disposition'] = f'inline; filename="{filename}"'
    return response

@group_required('Trainer')
def run_UNet(request):
    filename = request.GET.get('filename')
    cqc_scale = request.GET.get('scale')

    if not filename or not cqc_scale:
        return HttpResponse("Missing map or scaling parameter", status=400)

    try:
        scale = float(cqc_scale)
        if scale <= 0:
            raise ValueError()
    except ValueError:
        return HttpResponse("Invalid 'scale' parameter", status=400)

    # Disable max pixel limit
    Image.MAX_IMAGE_PIXELS = None

    # Constants
    train_omap_scale = 4000
    omap_scale = 4000
    SCALE_FACTOR = scale * omap_scale/train_omap_scale #To do: retrain model for 300dpi

    #NN later
    ort_session = ort.InferenceSession("best_model_300dpi.onnx")

    # S3 image loading
    map_key = f'maps/{filename}'

    if not default_storage.exists(map_key):
        return HttpResponseNotFound(f"Karte '{filename}' nicht verfügbar.")

    try:
        with default_storage.open(map_key, 'rb') as f:
            img = Image.open(f)
            img.load()  # Force loading
            img = img.convert("RGB")
            new_size = (int(img.width * SCALE_FACTOR), int(img.height * SCALE_FACTOR))

            if new_size[0] > 8000 or new_size[1] > 8000:
                return HttpResponse("Karte zu gross für neurales Netzwerk. Skalierung überprüfen", status=400)
            img = img.resize(new_size, resample=Image.BICUBIC)
            
            # NN later
            img_np = np.array(img) / 255.0
            img_np = np.transpose(img_np, (2, 0, 1)).astype(np.float32)  # HWC to CHW
            input_data = img_np[np.newaxis, :, :, :]

            def model_predict_fn(input_data):
                outputs = ort_session.run(None, {"input": input_data})
                output_array = outputs[0]
                if output_array.ndim == 4:
                    output_array = output_array[0]
                if output_array.shape[0] > 1:
                    output_array = output_array.argmax(axis=0)
                return output_array.astype(np.float32)

            output_img = model_predict_fn(input_data)

            h, w = output_img.shape
            visual = 255 * np.ones((h, w, 1), dtype=np.uint8)

            map_object = SimpleNamespace(
                impassable=0,
                very_slow=100,
                slow=150,
                cross=200,
                fast=230,
            )

            visual[output_img < 10] = map_object.impassable
            visual[(output_img >= 10) & (output_img < 22)] = map_object.very_slow
            visual[(output_img >= 22) & (output_img < 26)] = map_object.slow
            visual[(output_img >= 26) & (output_img < 28)] = map_object.cross
            visual[(output_img >= 28) & (output_img < 32)] = map_object.fast
            visual[output_img == 32] = map_object.cross
            visual[output_img == 33] = map_object.fast
            visual[output_img == 34] = map_object.impassable

            visual_img = np.repeat(visual, 3, axis=2)  # grayscale to img
            final_img = Image.fromarray(visual_img.astype(np.uint8))

            basename, _ = os.path.splitext(filename)
            mask_filename = f"masks/mask_{basename}.png"
            final_img_bytes = BytesIO()
            final_img.save(final_img_bytes, format="PNG")
            final_img_bytes.seek(0)

            default_storage.save(mask_filename, final_img_bytes)

            return JsonResponse({"message": "Kartenmaske generiert"})
        
    except FileNotFoundError:
        return HttpResponseNotFound("Image file not found.")
    except UnidentifiedImageError:
        return JsonResponse({'message': 'Could not identify or open image file.'}, status=500)
    except Exception as e:
        return JsonResponse({'message': 'Server error', 'error': str(e)}, status=500)

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

        # Try to delete the map file if it exists
        #if map_file_path and default_storage.exists(map_file_path):
        #    try:
        #        default_storage.delete(map_file_path)
        #        print(f"Deleted associated map file: {map_file_path}")
        #    except Exception as e:
        #        print(f"Warning: Could not delete map file {map_file_path}: {e}")

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