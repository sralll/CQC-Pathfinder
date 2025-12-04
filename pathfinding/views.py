from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse, FileResponse, StreamingHttpResponse
from django.contrib.auth.decorators import user_passes_test
from django.core.files.storage import default_storage
from django.core.files.base import ContentFile
from PIL import Image, UnidentifiedImageError
from types import SimpleNamespace

import math
import os
import gc
import json
import numpy as np
from io import BytesIO
import onnxruntime as ort

from .communication import extract_pathfinding_inputs
from .preprocess import load_mask, inflate_obstacles, find_path_with_margin_growth, generate_corridor_mask_numpy
from .a_star import get_a_star_turns, simplify_wps
from .theta_star import make_los_cached, make_terrain_los_cached, guided_theta_star, bresenham_line, simplify_theta_path

# Create your views here.
def group_required(group_name):
    def in_group(u):
        return u.is_authenticated and u.groups.filter(name=group_name).exists()
    return user_passes_test(in_group)

def find(request):

    async def event_stream():
        # Step 1: Extract inputs
        data, status = extract_pathfinding_inputs(request)
        if status != 200:
            yield f"data: {json.dumps({'error': data.get('error', 'Invalid request')})}\n\n"
            return

        # Step 2: Load mask and convert to numpy grid
        mask, error = load_mask(data)
        if error:
            yield f"data: {json.dumps({'error': error})}\n\n"
            return
        
        grid = np.array(mask)

        # Step 3: Find path with margin growth
        a_star_path, subgrid, offset, start_cP, ziel_cP = find_path_with_margin_growth(
            grid, data["start"], data["ziel"], data["routes"]
        )
        if a_star_path is None:
            yield f"data: {json.dumps({'error': 'Exploratory A* exited with no path found. Recheck mask.'})}\n\n"
            return

        # Step 4: Simplify waypoints and prepare LOS cache
        a_star_wps = get_a_star_turns(a_star_path)
        a_star_wps = simplify_wps(a_star_wps, subgrid)
        inflated_subgrid = inflate_obstacles(subgrid, radius=1, dilation_block=150)

        corridor_mask = generate_corridor_mask_numpy(a_star_wps, subgrid.shape, radius=40)
        constrained_grid = np.where(corridor_mask == 1, inflated_subgrid, 0)

        #DEBUG
        #Image.fromarray((corridor_mask * 255).astype(np.uint8)).save("corridor_mask.png")
        #Image.fromarray(constrained_grid.astype(np.uint8)).save("constrained_grid.png")
        cached_los = make_los_cached(constrained_grid)

        # Step 5: Yield updates from guided_theta_star generator
        final_path = None
        for update in guided_theta_star(constrained_grid, start_cP, ziel_cP, a_star_wps,
                                        switch_radius=10, cached_los=cached_los):
            
            if update.get("done"):
                final_path = update["path"]
            # Each update should be a dict you convert to JSON
            yield f"data: {json.dumps(update)}\n\n"

        if final_path is None:
            yield f"data: {json.dumps({'error': 'Guided θ* exited with no path found'})}\n\n"
            return
        theta_star_path = simplify_theta_path(final_path)

        theta_star_path = [((x + offset[0]) * 0.71, (y + offset[1]) * 0.71) for (x, y) in theta_star_path]
        # Step 6: Final done message (optional)
        yield f"data: {json.dumps({'final_path': theta_star_path})}\n\n"
        yield f"data: {json.dumps({'status': 'done'})}\n\n"
        
    return StreamingHttpResponse(event_stream(), content_type='text/event-stream')

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
def run_UNet_stream(request):
    filename = request.GET.get('filename')
    cqc_scale = request.GET.get('scale')

    basename, _ = os.path.splitext(filename)
    mask_filename = f"masks/mask_{basename}.png"

    if not filename or not cqc_scale:
        return HttpResponse("Missing map or scaling parameter", status=400)

    try:
        scale = float(cqc_scale)
        if scale <= 0:
            raise ValueError()
    except ValueError:
        return HttpResponse("Invalid 'scale' parameter", status=400)

    Image.MAX_IMAGE_PIXELS = None  # disable PIL max pixel limit

    # Constants for scaling
    train_scale = 0.710
    train_omap_scale = 4000
    omap_scale = 4000
    SCALE_FACTOR = scale / train_scale * omap_scale / train_omap_scale

    map_key = f'maps/{filename}'
    if not default_storage.exists(map_key):
        return HttpResponseNotFound(f"Karte '{filename}' nicht verfügbar.")

    try:
        # Load image
        with default_storage.open(map_key, 'rb') as f:
            img = Image.open(f)
            img.load()
            img = img.convert("RGB")
            new_size = (int(img.width * SCALE_FACTOR), int(img.height * SCALE_FACTOR))

            if new_size[0] > 16000 or new_size[1] > 16000:
                return HttpResponse("Karte zu gross für neurales Netzwerk. Skalierung überprüfen", status=400)

            img = img.resize(new_size, resample=Image.BICUBIC)

        # Load ONNX model
        ort_session = ort.InferenceSession("best_model_300dpi.onnx")

        # Prepare output array
        img_w, img_h = img.size
        output_img = np.zeros((img_h, img_w), dtype=np.float32)

        TILE_SIZE = 2048
        OVERLAP_RATIO = 0.2
        overlap = int(TILE_SIZE * OVERLAP_RATIO)
        step = TILE_SIZE - overlap
        tiles_y = math.ceil((img_h - overlap) / step)
        tiles_x = math.ceil((img_w - overlap) / step)
        total_tiles = tiles_y * tiles_x
        processed_tiles = 0

        def model_predict_fn(input_data):
            outputs = ort_session.run(None, {"input": input_data})
            out = outputs[0]
            if out.ndim == 4:
                out = out[0]
            if out.shape[0] > 1:
                out = out.argmax(axis=0)
            return out.astype(np.float32)

        # Generator for streaming progress
        async def tile_generator():
            nonlocal processed_tiles
            try:
                for y0 in range(0, img_h, step):
                    for x0 in range(0, img_w, step):
                        y1 = min(y0 + TILE_SIZE, img_h)
                        x1 = min(x0 + TILE_SIZE, img_w)

                        tile = img.crop((x0, y0, x1, y1))
                        tile_np = np.array(tile) / 255.0
                        tile_np = np.transpose(tile_np, (2,0,1))[np.newaxis,:,:,:].astype(np.float32)

                        tile_pred = model_predict_fn(tile_np)

                        # Decide crop bounds in output image
                        out_y0 = y0 if y0 == 0 else y0 + overlap // 2
                        out_x0 = x0 if x0 == 0 else x0 + overlap // 2
                        out_y1 = y1 if y1 == img_h else y1 - overlap // 2
                        out_x1 = x1 if x1 == img_w else x1 - overlap // 2

                        # Corresponding tile indices
                        tile_y0 = out_y0 - y0
                        tile_x0 = out_x0 - x0
                        tile_y1 = tile_y0 + (out_y1 - out_y0)
                        tile_x1 = tile_x0 + (out_x1 - out_x0)

                        # 🔒 Safety clamp (CRUCIAL)
                        h_t, w_t = tile_pred.shape
                        tile_y1 = min(tile_y1, h_t)
                        tile_x1 = min(tile_x1, w_t)
                        out_y1 = out_y0 + (tile_y1 - tile_y0)
                        out_x1 = out_x0 + (tile_x1 - tile_x0)

                        # ✅ Guaranteed matching shapes
                        output_img[out_y0:out_y1, out_x0:out_x1] = \
                            tile_pred[tile_y0:tile_y1, tile_x0:tile_x1]


                        # Send progress
                        processed_tiles += 1
                        yield f"data: {json.dumps({'current': processed_tiles, 'total': total_tiles})}\n\n"
                                
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

            # After all tiles processed, create visual image
            visual = 255 * np.ones((img_h, img_w, 1), dtype=np.uint8)
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

            visual_img = np.repeat(visual, 3, axis=2)
            final_img = Image.fromarray(visual_img.astype(np.uint8))
            final_img_bytes = BytesIO()
            final_img.save(final_img_bytes, format="PNG")
            final_img_bytes.seek(0)
            default_storage.save(mask_filename, final_img_bytes)

            # Send final message
            yield f"data: {json.dumps({'done': True, 'final_path': mask_filename})}\n\n"

            gc.collect()

        return StreamingHttpResponse(tile_generator(), content_type="text/event-stream")

    except FileNotFoundError:
        return HttpResponseNotFound("Image file not found.")
    except UnidentifiedImageError:
        return JsonResponse({'message': 'Could not identify or open image file.'}, status=500)
    except Exception as e:
        return JsonResponse({'message': 'Server error', 'error': str(e)}, status=500)