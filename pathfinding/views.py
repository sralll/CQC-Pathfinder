from django.http import JsonResponse, HttpResponseNotFound, HttpResponseBadRequest, HttpResponse, FileResponse, StreamingHttpResponse
from django.contrib.auth.decorators import user_passes_test
from PIL import Image, UnidentifiedImageError
from types import SimpleNamespace

from django.conf import settings
import math
import os
import gc
import json
import time
import numpy as np
from io import BytesIO
import onnxruntime as ort
import asyncio
import threading
from django.db import connection

from .communication import extract_pathfinding_inputs
from .preprocess import load_mask, apply_blocked_terrain
from project.runtime import calc_route_noA
# The visibility-graph / navgraph pathfinding (navgraph.py, query.py) was
# removed; the editor uses the client-side θ* worker exclusively now.

try:
    from debug.timing import record_pathfinding
except Exception:  # pragma: no cover — debug app may be absent in stripped builds
    def record_pathfinding(*args, **kwargs):
        pass

RUN_SPEED = 4.75  # m/s
TRAIN_SCALE = 0.710

def group_required(group_name):
    def in_group(u):
        return u.is_authenticated and u.groups.filter(name=group_name).exists()
    return user_passes_test(in_group)


def _blocked_to_grid(blocked: dict) -> dict:
    """Convert blocked terrain from map-pixel coords (frontend) to mask-pixel
    coords (matches the train_scale division applied to start/ziel)."""
    if not blocked:
        return {}
    out: dict = {"lines": [], "areas": []}
    for ln in blocked.get('lines') or []:
        s, e = ln.get('start'), ln.get('end')
        if not s or not e:
            continue
        out['lines'].append({
            'start': {'x': int(s['x'] / TRAIN_SCALE), 'y': int(s['y'] / TRAIN_SCALE)},
            'end': {'x': int(e['x'] / TRAIN_SCALE), 'y': int(e['y'] / TRAIN_SCALE)},
        })
    for a in blocked.get('areas') or []:
        pts = a.get('points') or []
        if len(pts) < 3:
            continue
        out['areas'].append({
            'points': [
                {'x': int(p['x'] / TRAIN_SCALE), 'y': int(p['y'] / TRAIN_SCALE)}
                for p in pts
            ],
        })
    return out


def _routes_to_response(routes, start_xy, ziel_xy):
    """Scale graph-space routes back to map units for the frontend; replace
    the first/last point with the originally requested start/ziel so the
    polyline starts/ends exactly where the user clicked."""
    out = []
    for r in routes:
        if not r:
            continue
        pts = [(float(start_xy[0]), float(start_xy[1]))]
        for (x, y) in r[1:-1]:
            pts.append((float(x) * TRAIN_SCALE, float(y) * TRAIN_SCALE))
        pts.append((float(ziel_xy[0]), float(ziel_xy[1])))
        out.append(pts)
    return out


# The visibility-graph `find` and `rebuild_navgraph` views were removed when
# the navgraph pathfinding approach was retired. The editor uses the
# client-side Web Worker θ* pipeline exclusively for auto-fire on CP creation.

@group_required('Trainer')
def upload_mask(request):
    if request.method == 'POST' and 'mask' in request.FILES:
        uploaded_file = request.FILES['mask']
        dest_path = os.path.join(settings.MEDIA_ROOT, 'masks', uploaded_file.name)

        with open(dest_path, 'wb') as f:
            for chunk in uploaded_file.chunks():
                f.write(chunk)

        return JsonResponse({'status': 'success', 'path': f'masks/{uploaded_file.name}'})

    return HttpResponseBadRequest('No mask file received')

@group_required('Trainer')
def get_mask(request, filename):
    filepath = os.path.join(settings.MEDIA_ROOT, 'masks', filename)
    if not os.path.exists(filepath):
        return HttpResponseNotFound("Mask not found.")
    response = FileResponse(open(filepath, 'rb'), content_type='image/png')
    response['Content-Disposition'] = f'inline; filename="{filename}"'
    return response

@group_required('Trainer')
def run_UNet_stream(request):
    filename = request.GET.get('filename')
    cqc_scale = request.GET.get('scale')

    basename, _ = os.path.splitext(filename)
    mask_filename = f"mask_{basename}.png"

    if not filename or not cqc_scale:
        return HttpResponse("Missing map or scaling parameter", status=400)

    try:
        scale = float(cqc_scale)
        if scale <= 0:
            raise ValueError()
    except ValueError:
        return HttpResponse("Invalid 'scale' parameter", status=400)

    Image.MAX_IMAGE_PIXELS = None

    train_scale = 0.710
    train_omap_scale = 4000
    omap_scale = 4000
    SCALE_FACTOR = scale / train_scale * omap_scale / train_omap_scale

    map_path = os.path.join(settings.MEDIA_ROOT, 'maps', filename)
    if not os.path.exists(map_path):
        return HttpResponseNotFound(f"Karte '{filename}' nicht verfügbar.")

    try:
        with open(map_path, 'rb') as f:
            img = Image.open(f)
            img.load()
            img = img.convert("RGB")
            new_size = (int(img.width * SCALE_FACTOR), int(img.height * SCALE_FACTOR))

            if new_size[0] > 16000 or new_size[1] > 16000:
                return HttpResponse("Karte zu gross für neurales Netzwerk. Skalierung überprüfen", status=400)

            img = img.resize(new_size, resample=Image.BICUBIC)

        ort_session = ort.InferenceSession("best_model_300dpi.onnx")

        img_w, img_h = img.size
        output_img = np.zeros((img_h, img_w), dtype=np.float32)

        TILE_SIZE = 2048
        OVERLAP_RATIO = 0.2
        overlap = int(TILE_SIZE * OVERLAP_RATIO)
        step = TILE_SIZE - overlap
        tiles_y = max(1, math.ceil(img_h / step))
        tiles_x = max(1, math.ceil(img_w / step))
        total_tiles = max(1, tiles_y * tiles_x)
        processed_tiles = 0

        def model_predict_fn(input_data):
            outputs = ort_session.run(None, {"input": input_data})
            out = outputs[0]
            if out.ndim == 4:
                out = out[0]
            if out.shape[0] > 1:
                out = out.argmax(axis=0)
            return out.astype(np.float32)

        async def tile_generator():
            nonlocal processed_tiles
            yield "data: {}\n\n"

            loop = asyncio.get_running_loop()
            try:
                for y0 in range(0, img_h, step):
                    for x0 in range(0, img_w, step):
                        y1 = min(y0 + TILE_SIZE, img_h)
                        x1 = min(x0 + TILE_SIZE, img_w)

                        tile = img.crop((x0, y0, x1, y1))
                        tile_np = np.array(tile) / 255.0
                        tile_np = np.transpose(tile_np, (2, 0, 1))[np.newaxis, :, :, :].astype(np.float32)

                        tile_pred = await loop.run_in_executor(None, model_predict_fn, tile_np)

                        out_y0 = y0 if y0 == 0 else y0 + overlap // 2
                        out_x0 = x0 if x0 == 0 else x0 + overlap // 2
                        out_y1 = y1 if y1 == img_h else y1 - overlap // 2
                        out_x1 = x1 if x1 == img_w else x1 - overlap // 2

                        tile_y0 = out_y0 - y0
                        tile_x0 = out_x0 - x0
                        tile_y1 = tile_y0 + (out_y1 - out_y0)
                        tile_x1 = tile_x0 + (out_x1 - out_x0)

                        h_t, w_t = tile_pred.shape
                        tile_y1 = min(tile_y1, h_t)
                        tile_x1 = min(tile_x1, w_t)
                        out_y1 = out_y0 + (tile_y1 - tile_y0)
                        out_x1 = out_x0 + (tile_x1 - tile_x0)

                        output_img[out_y0:out_y1, out_x0:out_x1] = tile_pred[tile_y0:tile_y1, tile_x0:tile_x1]

                        processed_tiles += 1
                        yield f"data: {json.dumps({'current': processed_tiles, 'total': total_tiles})}\n\n"
                        await asyncio.sleep(0.01)

            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

            visual = 255 * np.ones((img_h, img_w, 1), dtype=np.uint8)
            map_object = SimpleNamespace(
                impassable=0,
                very_slow=255-120,
                slow=255-24,
                cross=255-14,
                fast=255-12,
            )

            visual[output_img < 10] = map_object.impassable
            visual[(output_img >= 10) & (output_img < 22)] = map_object.very_slow
            visual[(output_img >= 22) & (output_img < 26)] = map_object.slow
            visual[(output_img >= 26) & (output_img < 28)] = map_object.cross
            visual[(output_img >= 28) & (output_img < 32)] = map_object.fast
            visual[output_img == 32] = map_object.cross
            visual[output_img == 33] = map_object.fast
            visual[output_img == 34] = map_object.impassable

            expansion_value = map_object.slow
            impassable = (visual[:, :, 0] == map_object.impassable)
            expanded = np.zeros_like(impassable, dtype=bool)
            expanded[:-1, :] |= impassable[1:, :]
            expanded[1:, :] |= impassable[:-1, :]
            expanded[:, :-1] |= impassable[:, 1:]
            expanded[:, 1:] |= impassable[:, :-1]
            expanded[:-1, :-1] |= impassable[1:, 1:]
            expanded[:-1, 1:] |= impassable[1:, :-1]
            expanded[1:, :-1] |= impassable[:-1, 1:]
            expanded[1:, 1:] |= impassable[:-1, :-1]
            darken = expanded & ~impassable & (visual[:, :, 0] > expansion_value)
            visual[darken] = expansion_value

            visual_img = np.repeat(visual, 3, axis=2)
            final_img = Image.fromarray(visual_img.astype(np.uint8))
            final_img_bytes = BytesIO()
            final_img.save(final_img_bytes, format="PNG")
            final_img_bytes.seek(0)

            mask_path = os.path.join(settings.MEDIA_ROOT, 'masks', mask_filename)
            with open(mask_path, 'wb') as f:
                f.write(final_img_bytes.read())

            # Mask PNG is on disk; frontend can load the preview, flip
            # File.has_mask and decode the greyscale into the client-side
            # worker. (The legacy navgraph build phase was removed.)
            yield f"data: {json.dumps({'done': True, 'final_path': f'masks/{mask_filename}'})}\n\n"
            gc.collect()

        # Pass the async generator directly to StreamingHttpResponse so the
        # ASGI host (uvicorn) drives it on its own running loop. The old sync
        # wrapper used `loop.run_until_complete(__anext__())` chunk-by-chunk,
        # which under ASGI's sync_to_async wrap creates a fresh local loop per
        # chunk — so the generator's `await` boundaries never resumed and
        # everything past the first phase 1 yield was silently dropped.
        response = StreamingHttpResponse(
            tile_generator(),
            content_type="text/event-stream"
        )
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        return response

    except FileNotFoundError:
        return HttpResponseNotFound("Image file not found.")
    except UnidentifiedImageError:
        return JsonResponse({'message': 'Could not identify or open image file.'}, status=500)
    except Exception as e:
        return JsonResponse({'message': 'Server error', 'error': str(e)}, status=500)

def calc_length(rP):
    length = 0
    for i in range(1, len(rP)):
        dx = rP[i]["x"] - rP[i-1]["x"]
        dy = rP[i]["y"] - rP[i-1]["y"]
        length += math.sqrt(dx*dx + dy*dy) * 0.48
    return round(length)

def calc_no_angles(rP, scale=None):
    return calc_route_noA(rP, scale)

def calc_pos(rP, start, ziel):
    dx = ziel["x"] - start["x"]
    dy = ziel["y"] - start["y"]
    total = sum(dx * (p["y"] - start["y"]) - dy * (p["x"] - start["x"]) for p in rP)
    return total / len(rP) if rP else 0

from coursesetter.models import publishedFile

def pathfinding_loop(cp_data, map_basename, blockedTerrain=None):
    """Stub — the navgraph-backed batch pathfinder was retired together with
    the navgraph module. Until an alternative batch path is wired up,
    pathfinding_loop returns None so callers gracefully fall back / skip."""
    return None

def run_batch_async(data, map_basename, filename, user_kader, author):
    try:
        blockedTerrain = data.get("blockedTerrain", {})

        mask, error = load_mask({"filename": map_basename})
        if error:
            print(f"Batch failed: Mask load error for {map_basename}")
            return

        grid = apply_blocked_terrain(mask, blockedTerrain)

        orig_unique_filename = f"{filename}_{user_kader.name}"
        total = len(data["cP"])

        # Update batch_progress on original file without touching last_edited
        publishedFile.objects.filter(unique_filename=orig_unique_filename).update(
            batch_progress={"done": 0, "total": total}
        )

        for i, cp in enumerate(data["cP"]):
            print(f"Processing CP {i + 1}/{total}")
            while len(cp["route"]) < 2:
                result = pathfinding_loop(cp, grid, blockedTerrain)
                if result is None:
                    print(f"CP {i + 1}: pathfinding failed, stopping at {len(cp['route'])} route(s)")
                    break
                rP = [{"x": x, "y": y} for x, y in result]
                length = calc_length(rP)
                cp["route"].append({
                    "rP": rP,
                    "elevation": 0,
                    "length": length,
                    "noA": calc_no_angles(rP, data.get("scale")),
                    "pos": calc_pos(rP, cp["start"], cp["ziel"]),
                    "runTime": round(length / RUN_SPEED),
                })

            # Update batch_progress on original file without touching last_edited
            publishedFile.objects.filter(unique_filename=orig_unique_filename).update(
                batch_progress={"done": i + 1, "total": total}
            )

        # All CPs done — write the final batchGen file once
        unique_filename_out = f"{filename}_batch_{user_kader.name}"
        publishedFile.objects.update_or_create(
            unique_filename=unique_filename_out,
            defaults={
                "filename": filename + "_batch",
                "author": author,
                "ncP": total,
                "data": data,
                "kader": user_kader,
            }
        )

        # Clear progress indicator on original file
        publishedFile.objects.filter(unique_filename=orig_unique_filename).update(
            batch_progress=None
        )

        print(f"Batch complete: {unique_filename_out}")

    except Exception as e:
        print(f"Batch failed: {e}")
        # Optionally mark failure in progress field
        publishedFile.objects.filter(
            unique_filename=f"{filename}_{user_kader.name}"
        ).update(batch_progress=None)
    finally:
        connection.close()

        #cleanup
        if 'grid' in locals(): del grid
        if 'mask' in locals(): del mask
        if 'data' in locals(): del data

        gc.collect()

@group_required('Trainer')
def batch_pathfinding(request):
    if request.method != "POST":
        return JsonResponse({'error': 'POST required'}, status=400)
    try:
        payload = json.loads(request.body)
        filename = payload.get("filename")
        if not filename:
            return JsonResponse({"error": "Filename required"}, status=400)
        user_kader = request.user.userprofile.kader
        if not user_kader:
            return JsonResponse({"error": "User has no kader assigned"}, status=400)
        orig_unique_filename = f"{filename}_{user_kader.name}"
        try:
            pf = publishedFile.objects.get(unique_filename=orig_unique_filename)
        except publishedFile.DoesNotExist:
            return JsonResponse({"error": f"Original file not found: {orig_unique_filename}"}, status=404)
        data = pf.data
        if not data or "cP" not in data or "mapFile" not in data:
            return JsonResponse({"error": "Invalid file data: missing cP or mapFile"}, status=400)
        map_basename = os.path.splitext(os.path.basename(data["mapFile"]))[0]

        author = request.user.first_name or request.user.username
        mask_path = os.path.join(settings.MEDIA_ROOT, 'masks', f'mask_{map_basename}.png')
        if not os.path.exists(mask_path):
            return JsonResponse({"error": "Keine Maske gefunden"}, status=400)

        thread = threading.Thread(
            target=run_batch_async,
            args=(data, map_basename, filename, user_kader, author),
            daemon=True
        )
        thread.start()
        return JsonResponse({
            "message": "Batch pathfinding started in background",
            "filename": f"{filename}_batchGen_{user_kader.name}"
        })
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)
