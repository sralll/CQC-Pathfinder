import os
import threading
import traceback

from asgiref.sync import sync_to_async
from django.conf import settings
from django.http import HttpResponse, HttpResponseNotFound, JsonResponse, StreamingHttpResponse
from django.utils import translation
from django.utils.translation import gettext as _
from django.views.decorators.http import require_POST

from account.decorators import role_required
from .media_access import safe_media_filename, user_can_access_file
from .models import File


_mask_generation_jobs = {}
_mask_generation_jobs_lock = threading.Lock()


class _MaskGenerationJob:
    """Pub/sub progress relay for one background mask-generation run."""

    def __init__(self, key, event_base, loop):
        self.key = key
        self.event_base = event_base
        self.loop = loop
        self._lock = threading.Lock()
        self.history = []
        self.subscribers = set()
        self.done = False

    def _format(self, event):
        import json as _json
        return f"data: {_json.dumps(event)}\n\n"

    def publish(self, payload):
        event = {**self.event_base, **payload}
        with self._lock:
            self.history.append(event)
            if payload.get('done') or payload.get('error'):
                self.done = True
            subscribers = list(self.subscribers)
        for q in subscribers:
            try:
                self.loop.call_soon_threadsafe(q.put_nowait, event)
            except RuntimeError:
                pass
        return event

    async def stream(self):
        import asyncio
        q = asyncio.Queue()
        with self._lock:
            history = list(self.history)
            if not self.done:
                self.subscribers.add(q)
        try:
            for event in history:
                yield self._format(event)
                if event.get('done') or event.get('error'):
                    return
            while True:
                event = await q.get()
                yield self._format(event)
                if event.get('done') or event.get('error'):
                    return
        finally:
            with self._lock:
                self.subscribers.discard(q)


def _run_mask_generation(*, job, job_key, map_path, scale, mask_filename,
                         filename, file_id, language=None):
    """Heavy UNet mask generation, run in a non-daemon background thread."""
    import gc
    import math
    import time
    from io import BytesIO
    from types import SimpleNamespace

    import numpy as np
    from django.db import close_old_connections, connection
    from PIL import Image

    t0 = time.time()
    img = output_img = ort_session = None
    close_old_connections()
    if language:
        translation.activate(language)
    try:
        import onnxruntime as ort

        Image.MAX_IMAGE_PIXELS = None
        scale_factor = scale / 0.710
        with open(map_path, 'rb') as f:
            img = Image.open(f)
            img.load()
            img = img.convert("RGB")
        new_size = (int(img.width * scale_factor), int(img.height * scale_factor))
        if new_size[0] > 16000 or new_size[1] > 16000:
            raise ValueError(_("Map too large for the neural network. Check the scale."))
        img = img.resize(new_size, resample=Image.BICUBIC)
        # arena off so freed inference buffers return to the OS (long-lived web workers); 2 threads for the shared Railway vCPU
        so = ort.SessionOptions()
        so.enable_cpu_mem_arena = False
        so.intra_op_num_threads = 2
        ort_session = ort.InferenceSession("best_model_300dpi.onnx", sess_options=so)

        img_w, img_h = img.size
        output_img = np.zeros((img_h, img_w), dtype=np.uint8)
        tile_size = 2048
        overlap = int(tile_size * 0.2)
        step = tile_size - overlap
        total_tiles = max(1, max(1, math.ceil(img_h / step)) * max(1, math.ceil(img_w / step)))
        job.publish({'current': 0, 'total': total_tiles})
        print(f"[MASK] START file={filename} tiles={total_tiles}", flush=True)

        processed = 0
        for y0 in range(0, img_h, step):
            for x0 in range(0, img_w, step):
                y1 = min(y0 + tile_size, img_h)
                x1 = min(x0 + tile_size, img_w)
                tile = img.crop((x0, y0, x1, y1))
                tile_np = np.transpose(np.array(tile) / 255.0, (2, 0, 1))[np.newaxis].astype(np.float32)

                out = ort_session.run(None, {"input": tile_np})[0]
                if out.ndim == 4:
                    out = out[0]
                if out.shape[0] > 1:
                    out = out.argmax(axis=0)
                    tile_pred = out.astype(np.uint8)
                else:
                    tile_pred = np.clip(np.floor(out), 0, 255).astype(np.uint8)

                oy0 = y0 if y0 == 0 else y0 + overlap // 2
                oy1 = y1 if y1 == img_h else y1 - overlap // 2
                ox0 = x0 if x0 == 0 else x0 + overlap // 2
                ox1 = x1 if x1 == img_w else x1 - overlap // 2
                ty0, tx0 = oy0 - y0, ox0 - x0
                ty1 = min(ty0 + (oy1 - oy0), tile_pred.shape[0])
                tx1 = min(tx0 + (ox1 - ox0), tile_pred.shape[1])
                output_img[oy0:oy0 + (ty1 - ty0), ox0:ox0 + (tx1 - tx0)] = tile_pred[ty0:ty1, tx0:tx1]

                processed += 1
                print(f"[MASK] tile {processed}/{total_tiles} ({time.time() - t0:.1f}s)", flush=True)
                job.publish({'current': processed, 'total': total_tiles})

        img = None
        mo = SimpleNamespace(impassable=0, outline=200, very_slow=135, slow=231, cross=241, stairs=242, fast=243)
        vis = 255 * np.ones((img_h, img_w), dtype=np.uint8)
        vis[output_img < 10] = mo.impassable
        vis[(output_img >= 10) & (output_img < 22)] = mo.very_slow
        vis[(output_img >= 22) & (output_img < 26)] = mo.slow
        vis[(output_img >= 26) & (output_img < 28)] = mo.cross
        vis[output_img == 28] = mo.stairs
        vis[(output_img >= 29) & (output_img < 32)] = mo.fast
        vis[output_img == 32] = mo.cross
        vis[output_img == 33] = mo.fast
        vis[output_img == 34] = mo.impassable

        impassable_mask = vis == mo.impassable
        padded = np.pad(impassable_mask, 1, mode="constant", constant_values=False)
        dilated = (
            padded[:-2, :-2] | padded[:-2, 1:-1] | padded[:-2, 2:] |
            padded[1:-1, :-2] | padded[1:-1, 1:-1] | padded[1:-1, 2:] |
            padded[2:, :-2] | padded[2:, 1:-1] | padded[2:, 2:]
        )
        vis[dilated & ~impassable_mask] = mo.outline
        final = Image.fromarray(vis, mode="L").convert("RGB")
        buf = BytesIO()
        final.save(buf, format="PNG")
        buf.seek(0)
        mask_path = os.path.join(settings.MEDIA_ROOT, 'masks', mask_filename)
        os.makedirs(os.path.dirname(mask_path), exist_ok=True)
        with open(mask_path, 'wb') as f:
            f.write(buf.read())
        del vis, padded, dilated, impassable_mask, final, buf

        if file_id is not None:
            File.objects.filter(id=file_id, deleted=False, map_file=filename).update(has_mask=True)
        else:
            File.objects.filter(map_file=filename, deleted=False).update(has_mask=True)

        print(f"[MASK] DONE {time.time() - t0:.1f}s", flush=True)
        job.publish({'done': True})

    except Exception as e:
        traceback.print_exc()
        job.publish({'error': str(e)})
    finally:
        with _mask_generation_jobs_lock:
            if _mask_generation_jobs.get(job_key) is job:
                _mask_generation_jobs.pop(job_key, None)
        img = None
        output_img = None
        ort_session = None
        if language:
            translation.deactivate()
        gc.collect()
        connection.close()


@role_required('Trainer')
@require_POST
async def generate_mask(request):
    """Stream UNet mask generation progress via an async SSE response."""
    import asyncio
    import json as _json

    if request.method != "POST":
        return HttpResponse(status=405)

    def _check_auth():
        return request.user.is_authenticated and request.user.groups.filter(name='Trainer').exists()

    if not await sync_to_async(_check_auth)():
        return JsonResponse({'error': 'Permission denied'}, status=403)

    try:
        body = _json.loads(request.body)
    except Exception:
        return HttpResponse("Invalid JSON body", status=400)

    filename = body.get('filename')
    cqc_scale = body.get('scale')
    file_id = body.get('file_id')
    if not filename or not cqc_scale or file_id is None:
        return HttpResponse("Missing filename, file_id, or scale", status=400)
    filename = safe_media_filename(filename)
    if not filename:
        return HttpResponse("Invalid filename", status=400)
    try:
        scale = float(cqc_scale)
        if scale <= 0:
            raise ValueError()
    except ValueError:
        return HttpResponse("Invalid scale parameter", status=400)

    basename, _ = os.path.splitext(filename)
    mask_filename = f"mask_{basename}.png"
    map_path = os.path.join(settings.MEDIA_ROOT, 'maps', filename)
    if not os.path.exists(map_path):
        return HttpResponseNotFound(f"Map '{filename}' not found.")

    try:
        file_id = int(file_id)
    except (TypeError, ValueError):
        return HttpResponse("Invalid file_id", status=400)

    def _get_accessible_file():
        file = File.objects.select_related('team').filter(
            id=file_id,
            deleted=False,
            map_file=filename,
        ).first()
        if not user_can_access_file(request, file):
            return None
        return file

    file = await sync_to_async(_get_accessible_file)()
    if not file:
        return HttpResponse("file_id does not match the requested map file", status=409)

    owner_team_id = file.team_id
    language = translation.get_language()
    event_base = {
        'file_id': file_id,
        'filename': filename,
        'map_file': filename,
        'mask_file': mask_filename,
    }
    job_key = (owner_team_id, file_id if file_id is not None else filename)
    with _mask_generation_jobs_lock:
        existing_job = _mask_generation_jobs.get(job_key)
        if existing_job and existing_job.done:
            _mask_generation_jobs.pop(job_key, None)
            existing_job = None
        if existing_job:
            print(f"[MASK] ATTACH file={filename}", flush=True)
            resp = StreamingHttpResponse(existing_job.stream(), content_type="text/event-stream")
            resp["Cache-Control"] = "no-cache"
            resp["X-Accel-Buffering"] = "no"
            return resp

    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return HttpResponse("onnxruntime not installed", status=500)

    loop = asyncio.get_running_loop()
    job = _MaskGenerationJob(job_key, event_base, loop)
    with _mask_generation_jobs_lock:
        _mask_generation_jobs[job_key] = job

    threading.Thread(
        target=_run_mask_generation,
        kwargs=dict(
            job=job, job_key=job_key, map_path=map_path, scale=scale,
            mask_filename=mask_filename, filename=filename, file_id=file_id,
            language=language,
        ),
        daemon=False,
    ).start()

    print(f"[MASK] SPAWN file={filename}", flush=True)
    resp = StreamingHttpResponse(job.stream(), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"
    return resp
