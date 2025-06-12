from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse, FileResponse, StreamingHttpResponse
from django.contrib.auth.decorators import user_passes_test
from django.core.files.storage import default_storage
from django.core.files.base import ContentFile
from PIL import Image, UnidentifiedImageError
from types import SimpleNamespace

import os
import json
import numpy as np
from io import BytesIO
import onnxruntime as ort

from .communication import extract_pathfinding_inputs
from .preprocess import load_mask, inflate_obstacles, find_path_with_margin_growth
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
        cached_los = make_los_cached(inflated_subgrid)

        # Step 5: Yield updates from guided_theta_star generator
        final_path = None
        for update in guided_theta_star(inflated_subgrid, start_cP, ziel_cP, a_star_wps,
                                        switch_radius=10, cached_los=cached_los):
            
            if update.get("done"):
                final_path = update["path"]
            # Each update should be a dict you convert to JSON
            yield f"data: {json.dumps(update)}\n\n"

        theta_star_path = simplify_theta_path(final_path)

        theta_star_path = [((x + offset[0]) * 0.71, (y + offset[1]) * 0.71) for (x, y) in theta_star_path]
        # Step 6: Final done message (optional)
        yield f"data: {json.dumps({'final_path': theta_star_path})}\n\n"
        yield f"data: {json.dumps({'status': 'done'})}\n\n"

    return StreamingHttpResponse(event_stream(), content_type='text/event-stream')


'''
@group_required('Trainer')
async def find(request):
    # Your existing input parsing and setup...
    data, status = extract_pathfinding_inputs(request)
    if status != 200:
        yield f"data: {json.dumps({'error': data.get('error', 'Invalid request')})}\n\n"
        return

    mask = load_mask(data)
    grid = np.array(mask)
    a_star_path, subgrid, offset, start_cP, ziel_cP = find_path_with_margin_growth(grid, data["start"], data["ziel"], data["routes"])
    if a_star_path is None:
        yield f"data: {json.dumps({'error': 'Exploratory A* aborted with no path found. Check mask.'})}\n\n"
        return
    
    a_star_wps = get_a_star_turns(a_star_path)
    a_star_wps = simplify_wps(a_star_wps, subgrid)
    inflated_subgrid = inflate_obstacles(subgrid, radius=1, dilation_block=150)
    cached_los = make_los_cached(inflated_subgrid)

    async def event_stream():
        # This generator yields SSE strings
        for update in guided_theta_star(inflated_subgrid, start_cP, ziel_cP, a_star_wps, switch_radius=10, cached_los=cached_los):
            # Convert the dict to JSON and format as SSE data chunk
            yield f"data: {json.dumps(update)}\n\n"

    return StreamingHttpResponse(event_stream(), content_type='text/event-stream')
'''

'''
@group_required('Trainer')
def find(request):
    # Step 1: Parse and validate input
    data, status = extract_pathfinding_inputs(request)
    if status != 200:
        return JsonResponse({"success": False, "message": data.get("error", "Invalid request")}, status=status)

    mask = load_mask(data)

    grid = np.array(mask)

    a_star_path, subgrid, offset, start_cP, ziel_cP = find_path_with_margin_growth(grid, data["start"], data["ziel"], data["routes"])
    if a_star_path is None:
        return JsonResponse({
            "success": False,
            "message": "Exploratory A* aborted with no path found. Check mask."
        }, status=400)
    
    a_star_wps = get_a_star_turns(a_star_path)
    a_star_wps = simplify_wps(a_star_wps, subgrid)

    #inflate grid for character size simulation
    inflated_subgrid = inflate_obstacles(subgrid, radius=1, dilation_block=150) #tune

    cached_los = make_los_cached(inflated_subgrid)
    #cached_terrain_los = make_terrain_los_cached(inflated_subgrid)

    tt_0 = time.time()
    theta_star_path = guided_theta_star(inflated_subgrid, start_cP, ziel_cP, a_star_wps, switch_radius=10, cached_los=cached_los)
    tt_1 = time.time()
    print(f"\nθ* completed in {int(tt_1-tt_0)}s")

    theta_star_path = simplify_theta_path(theta_star_path)

    def draw_path_lines_on_grid(grid: np.ndarray, path: list[tuple[int, int]], color: int = 50) -> np.ndarray:
        grid_with_lines = grid.copy()
        h, w = grid.shape

        for (x0, y0), (x1, y1) in zip(path[:-1], path[1:]):
            for x, y in bresenham_line(x0, y0, x1, y1):
                if 0 <= y < h and 0 <= x < w:
                    grid_with_lines[y, x] = color  # Note: (y, x) indexing

        return grid_with_lines
    
    
    debug_grid = draw_path_lines_on_grid(inflated_subgrid, theta_star_path, color=50)

    Image.fromarray(debug_grid.astype(np.uint8)).save("debug_subgrid.png")
    # Step 3: Continue with your own pathfinding or logic
    return JsonResponse({
        "message": "success",
    })
'''
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
    train_scale = 0.710
    train_omap_scale = 4000
    omap_scale = 4000
    SCALE_FACTOR = scale/train_scale * omap_scale/train_omap_scale #To do: retrain model for 300dpi

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

            map_object = SimpleNamespace( #tune
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
