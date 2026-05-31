from django.shortcuts import get_object_or_404, render
from django.http import JsonResponse, FileResponse, HttpResponseNotFound, HttpResponse, StreamingHttpResponse
from django.views.decorators.http import require_GET, require_POST
from django.db.models import Count, Q
from .models import File, Label, ControlPair, Route
from account.decorators import role_required
from django.db.models import Prefetch
import traceback
from django.conf import settings
import os
import mimetypes

# open editor
def editor(request):
    return render(request, 'project/editor.html')

# load files
@role_required('Trainer')
@require_GET
def get_files(request):
    try:
        profile = request.user.profile
        active_team = profile.active_team

        qs = File.objects.filter(deleted=False).order_by('-last_edited')

        if not request.user.is_superuser:
            if active_team:
                if active_team.shared_pool:
                    qs = qs.filter(
                        Q(team=active_team) | Q(team__shared_pool=True)
                    ).distinct()
                else:
                    qs = qs.filter(team=active_team)
            else:
                qs = File.objects.none()

        qs = qs.annotate(cp_count=Count('control_pairs'))
        labels = Label.objects.filter(team=active_team)

        team_qs = File.objects.filter(deleted=False)

        if not request.user.is_superuser:
            if active_team:
                if active_team.shared_pool:
                    team_qs = team_qs.filter(
                        Q(team=active_team) | Q(team__shared_pool=True)
                    )
                else:
                    team_qs = team_qs.filter(team=active_team)
            else:
                team_qs = File.objects.none()

        available_teams = (
            team_qs
            .values_list("team__name", flat=True)
            .distinct()
        )

        files = []
        for obj in qs:
            files.append({
                'id': obj.id,
                'name': obj.name,
                'last_edited': obj.last_edited.isoformat() if obj.last_edited else '',
                'cp_count': obj.cp_count,
                'published': obj.published,
                'author': obj.author or '',
                'team': obj.team.name if obj.team else '',
                'editable': obj.team == active_team,
                'label': {'id': obj.label.id, 'name': obj.label.name} if obj.label else None,
                'batch_progress': obj.batch_progress,
                "can_edit": obj.team == request.user.profile.active_team,
                'team_name': obj.team.name if obj.team else '',
                'team_shared_pool': obj.team.shared_pool if obj.team else False,
            })

        return JsonResponse({
            'files': files,
            'active_team': active_team.name if active_team else '',
            'shared_pool': active_team.shared_pool if active_team else False,
            'labels': [{'id': l.id, 'name': l.name} for l in labels],
            'teams': list(filter(None, available_teams)),
        })

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)

@role_required('Trainer')
@require_GET
def open_file(request, file_id):
    try:
        profile = request.user.profile
        active_team = profile.active_team

        file = get_object_or_404(
            File.objects
            .select_related('team', 'label')
            .prefetch_related(
                Prefetch(
                    'control_pairs',
                    queryset=ControlPair.objects.prefetch_related(
                        Prefetch('routes', queryset=Route.objects.order_by('order'))
                    ).order_by('order')
                )
            ),
            id=file_id,
            deleted=False
        )

        if not request.user.is_superuser:
            if not active_team:
                return JsonResponse({'error': 'No active team'}, status=403)

            own = file.team == active_team
            shared = active_team.shared_pool and file.team and file.team.shared_pool

            if not (own or shared):
                return JsonResponse({'error': 'Permission denied'}, status=403)

        return JsonResponse({
            'project': {
                'id': file.id,
                'name':        file.name,
                'last_edited': file.last_edited.isoformat() if file.last_edited else None,
                'scale': file.scale,
                'scaled': file.scaled,
                'map_file': file.map_file,
                'has_mask': file.has_mask,
                'blocked_terrain': file.blocked_terrain,
                'control_pairs': [
                    {
                        'id': cp.id,
                        'order': cp.order,
                        'ziel': cp.ziel,
                        'start': cp.start,
                        'complex': cp.complex,
                        'routes': [
                            {
                                'id': r.id,
                                'order': r.order,
                                'rP': r.rP,
                                'noA': r.noA,
                                'pos': r.pos,
                                'length': r.length,
                                'run_time': r.run_time,
                                'elevation': r.elevation,
                            }
                            for r in cp.routes.all()
                        ]
                    }
                    for cp in file.control_pairs.all()
                ]
            }
        })

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)

@role_required('Trainer')
@require_GET
def get_map(request, filename):
    filepath = os.path.join(settings.MEDIA_ROOT, 'maps', filename)
    if not os.path.exists(filepath):
        return HttpResponseNotFound(f"Map '{filename}' not found.")
    content_type, _ = mimetypes.guess_type(filepath)
    content_type = content_type or 'application/octet-stream'
    return FileResponse(open(filepath, 'rb'), content_type=content_type)


@role_required('Trainer')
@require_POST
def toggle_publish(request, file_id):
    try:
        file = get_object_or_404(
            File,
            id=file_id,
            team=request.user.profile.active_team
        )

        file.published = not file.published
        file.save()

        return JsonResponse({
            'published': file.published
        })

    except Exception as e:
        traceback.print_exc()

        return JsonResponse({
            'error': str(e)
        }, status=500)


@require_GET
def sync_has_mask(request):
    """Debug view: checks media/masks/ for each File and corrects has_mask."""
    from django.conf import settings as django_settings
    if not django_settings.DEBUG and not request.user.is_superuser:
        from django.http import HttpResponseForbidden
        return HttpResponseForbidden("Only available in DEBUG mode or for superusers.")

    results = []
    updated = 0

    for f in File.objects.filter(deleted=False):
        if not f.map_file:
            results.append({'id': f.id, 'name': f.name, 'status': 'skipped — no map_file'})
            continue

        stem = os.path.splitext(f.map_file)[0]
        mask_path = os.path.join(settings.MEDIA_ROOT, 'masks', f'mask_{stem}.png')
        exists = os.path.exists(mask_path)

        if exists != f.has_mask:
            f.has_mask = exists
            f.save(update_fields=['has_mask'])
            updated += 1
            status = f'updated → has_mask={exists}'
        else:
            status = f'ok (has_mask={exists})'

        results.append({
            'id':       f.id,
            'name':     f.name,
            'map_file': f.map_file,
            'mask':     f'mask_{stem}.png',
            'exists':   exists,
            'status':   status,
        })

    return JsonResponse({'updated': updated, 'total': len(results), 'files': results}, json_dumps_params={'indent': 2})


@role_required('Trainer')
@require_GET
def get_snapshots(request, file_id):
    from .models import FileSnapshot
    try:
        file = get_object_or_404(File, id=file_id, deleted=False)
        qs         = FileSnapshot.objects.filter(file=file).order_by('-created_at')
        total      = qs.count()
        show_all   = request.GET.get('all')
        if not show_all:
            qs = qs[:10]
        snaps = qs.values(
            'id', 'trigger', 'n_control_pairs', 'n_routes',
            'created_at', 'created_by__first_name',
            'map_file', 'scale',
        )
        return JsonResponse({'snapshots': list(snaps), 'has_more': not show_all and total > 10})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_GET
def load_snapshot(request, snapshot_id):
    """Return a FileSnapshot's data in the same shape as open_file."""
    from .models import FileSnapshot
    try:
        snap = get_object_or_404(FileSnapshot, id=snapshot_id)
        file = snap.file

        if not request.user.is_superuser:
            active_team = request.user.profile.active_team
            if not active_team:
                return JsonResponse({'error': 'No active team'}, status=403)
            own    = file.team == active_team
            shared = active_team.shared_pool and file.team and file.team.shared_pool
            if not (own or shared):
                return JsonResponse({'error': 'Permission denied'}, status=403)

        return JsonResponse({
            'project': {
                'id':              file.id,
                'name':            file.name,
                'scale':           snap.scale,
                'scaled':          file.scaled,
                'map_file':        snap.map_file,
                'has_mask':        snap.has_mask,
                'blocked_terrain': snap.blocked_terrain,
                'control_pairs':   snap.control_pairs,
            }
        })
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def save_file(request):
    """Save the current project state to the File + relational records."""
    import json as _json
    from django.utils import timezone as tz
    try:
        data        = _json.loads(request.body)
        profile     = request.user.profile
        active_team = profile.active_team
        file_id     = data.get('id')

        # Decide: update existing or create new
        client_last_edited = data.get('last_edited')
        file = None
        if file_id:
            try:
                existing = File.objects.get(id=file_id, deleted=False)
                if existing.team == active_team:
                    # Optimistic locking: reject if file was modified since client opened it
                    if client_last_edited and existing.last_edited:
                        if existing.last_edited.isoformat() != client_last_edited:
                            return JsonResponse({
                                'error': 'conflict',
                                'message': 'Diese Datei wurde von jemand anderem geändert. Bitte lade sie neu.',
                            }, status=409)
                    file = existing          # same team → overwrite
                # else: different team → fall through and create new
            except File.DoesNotExist:
                pass

        if file is None:
            file = File(team=active_team,
                        author=request.user.first_name or request.user.username)

        file.name           = data.get('name', 'Neues Projekt')
        file.scale          = data.get('scale')
        file.scaled         = data.get('scaled', False)
        file.map_file       = data.get('map_file', '')
        file.has_mask       = data.get('has_mask', False)
        file.blocked_terrain = data.get('blocked_terrain')
        file.last_edited    = tz.now()
        file.save()

        # Rebuild control pairs (delete → recreate)
        ControlPair.objects.filter(file=file).delete()
        id_map = []   # [{order, id, routes: [{order, id}]}]
        for cp_d in data.get('control_pairs', []):
            cp = ControlPair.objects.create(
                file    = file,
                order   = cp_d['order'],
                start   = cp_d.get('start'),
                ziel    = cp_d.get('ziel'),
                complex = cp_d.get('complex', False),
            )
            route_ids = []
            for r_d in cp_d.get('routes', []):
                r = Route.objects.create(
                    control_pair = cp,
                    order        = r_d['order'],
                    rP           = r_d.get('rP'),
                    noA          = r_d.get('noA'),
                    pos          = r_d.get('pos'),
                    length       = r_d.get('length'),
                    run_time     = r_d.get('run_time'),
                    elevation    = r_d.get('elevation'),
                )
                route_ids.append({'order': r.order, 'id': r.id})
            id_map.append({'order': cp.order, 'id': cp.id, 'routes': route_ids})

        return JsonResponse({
            'status': 'ok',
            'id': file.id,
            'last_edited': file.last_edited.isoformat() if file.last_edited else None,
            'id_map': id_map,
        })

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def delete_element(request):
    """Delete a control_pair or route by db id."""
    import json as _json
    from django.utils import timezone as tz
    try:
        data         = _json.loads(request.body)
        element_type = data.get('type')
        file_id      = data.get('file_id')
        active_team  = request.user.profile.active_team

        file = get_object_or_404(File, id=file_id, deleted=False)
        if file.team != active_team:
            return JsonResponse({'error': 'Permission denied'}, status=403)

        def _touch_file():
            file.author = request.user.first_name or request.user.username
            file.last_edited = tz.now()
            file.save(update_fields=['author', 'last_edited'])
            return file.last_edited.isoformat()

        if element_type == 'control_pair':
            db_id = data.get('db_id')
            ControlPair.objects.filter(id=db_id, file=file).delete()
            return JsonResponse({'status': 'ok', 'last_edited': _touch_file()})

        elif element_type == 'route':
            db_id    = data.get('db_id')
            cp_db_id = data.get('cp_db_id')
            cp = get_object_or_404(ControlPair, id=cp_db_id, file=file)
            Route.objects.filter(id=db_id, control_pair=cp).delete()
            return JsonResponse({'status': 'ok', 'last_edited': _touch_file()})

        return JsonResponse({'error': f'Unknown type: {element_type}'}, status=400)

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def save_cp_order(request):
    """Atomically update order of all CPs for a file to avoid unique-constraint conflicts."""
    import json as _json
    from django.db import transaction
    try:
        data    = _json.loads(request.body)
        file_id = data.get('file_id')
        pairs   = data.get('order', [])   # [{db_id, order}, ...]

        file = get_object_or_404(File, id=file_id, deleted=False)
        if file.team != request.user.profile.active_team:
            return JsonResponse({'error': 'Permission denied'}, status=403)

        with transaction.atomic():
            # Shift all to high temporary values to free constraint space
            offset = ControlPair.objects.filter(file=file).count() + 1000
            for p in pairs:
                ControlPair.objects.filter(id=p['db_id'], file=file).update(order=p['order'] + offset)
            # Set real values
            for p in pairs:
                ControlPair.objects.filter(id=p['db_id'], file=file).update(order=p['order'])

        return JsonResponse({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def save_element(request):
    """Granular save: control_pair | route | blocked_terrain."""
    import json as _json
    from django.utils import timezone as tz
    try:
        data         = _json.loads(request.body)
        element_type = data.get('type')
        file_id      = data.get('file_id')
        active_team  = request.user.profile.active_team

        file = get_object_or_404(File, id=file_id, deleted=False)
        if file.team != active_team:
            return JsonResponse({'error': 'Permission denied'}, status=403)

        # ── Control pair ──────────────────────────────────────────────────
        if element_type == 'control_pair':
            cp_data = data.get('control_pair', {})
            cp_db_id = cp_data.get('db_id')   # separate from frontend order-based id

            if cp_db_id:
                cp = get_object_or_404(ControlPair, id=cp_db_id, file=file)
            else:
                cp = ControlPair(file=file)

            cp.order   = cp_data.get('order', 0)
            cp.start   = cp_data.get('start')
            cp.ziel    = cp_data.get('ziel')
            cp.complex = cp_data.get('complex', False)
            cp.save()
            file.author = request.user.first_name or request.user.username
            file.last_edited = tz.now()
            file.save(update_fields=['author', 'last_edited'])
            return JsonResponse({'db_id': cp.id, 'last_edited': file.last_edited.isoformat()})

        # ── Route ─────────────────────────────────────────────────────────
        elif element_type == 'route':
            cp_db_id    = data.get('cp_db_id')
            route_data  = data.get('route', {})
            route_db_id = route_data.get('db_id')

            cp = get_object_or_404(ControlPair, id=cp_db_id, file=file)

            if route_db_id:
                route = get_object_or_404(Route, id=route_db_id, control_pair=cp)
            else:
                route = Route(control_pair=cp)

            route.order     = route_data.get('order', 0)
            route.rP        = route_data.get('rP')
            route.noA       = route_data.get('noA')
            route.pos       = route_data.get('pos')
            route.length    = route_data.get('length')
            route.run_time  = route_data.get('run_time')
            route.elevation = route_data.get('elevation')
            route.save()
            file.author = request.user.first_name or request.user.username
            file.last_edited = tz.now()
            file.save(update_fields=['author', 'last_edited'])
            return JsonResponse({'db_id': route.id, 'last_edited': file.last_edited.isoformat()})

        # ── Blocked terrain ───────────────────────────────────────────────
        elif element_type == 'blocked_terrain':
            file.blocked_terrain = data.get('blocked_terrain')
            file.author      = request.user.first_name or request.user.username
            file.last_edited = tz.now()
            file.save(update_fields=['author', 'blocked_terrain', 'last_edited'])
            return JsonResponse({'status': 'ok', 'last_edited': file.last_edited.isoformat()})

        return JsonResponse({'error': f'Unknown type: {element_type}'}, status=400)

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def save_snapshot(request):
    """Save a FileSnapshot of the current project state."""
    import json as _json
    try:
        data    = _json.loads(request.body)
        file_id = data.get('id')
        trigger = data.get('trigger', 'autosave')
        cps     = data.get('control_pairs', [])

        file = get_object_or_404(File, id=file_id, team=request.user.profile.active_team)

        n_control_pairs = data.get('n_control_pairs', len(cps))
        n_routes        = data.get('n_routes', sum(len(cp.get('routes', [])) for cp in cps))

        from .models import FileSnapshot
        FileSnapshot.objects.create(
            file            = file,
            created_by      = request.user,
            trigger         = trigger,
            scale           = data.get('scale'),
            map_file        = data.get('map_file', ''),
            has_mask        = data.get('has_mask', False),
            blocked_terrain = data.get('blocked_terrain'),
            control_pairs   = cps,
            n_control_pairs = n_control_pairs,
            n_routes        = n_routes,
        )
        return JsonResponse({'status': 'ok', 'n_control_pairs': n_control_pairs, 'n_routes': n_routes})

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def save_mask(request):
    """Receive a PNG blob and save it as the mask for the given map file."""
    filename = request.POST.get('filename')
    file     = request.FILES.get('file')
    if not filename or not file:
        return JsonResponse({'error': 'Missing filename or file'}, status=400)
    basename, _ = os.path.splitext(filename)
    mask_path   = os.path.join(settings.MEDIA_ROOT, 'masks', f'mask_{basename}.png')
    os.makedirs(os.path.dirname(mask_path), exist_ok=True)
    with open(mask_path, 'wb') as f:
        for chunk in file.chunks():
            f.write(chunk)
    return JsonResponse({'status': 'ok'})


@role_required('Trainer')
@require_POST
def generate_mask(request):
    """Stream UNet mask generation progress. Copied from pathfinding.run_UNet_stream."""
    import asyncio, gc, math, json as _json
    import numpy as np
    from PIL import Image
    from io import BytesIO
    from types import SimpleNamespace
    try:
        import onnxruntime as ort
    except ImportError:
        return HttpResponse("onnxruntime not installed", status=500)

    try:
        body = _json.loads(request.body)
    except Exception:
        return HttpResponse("Invalid JSON body", status=400)

    filename  = body.get('filename')
    cqc_scale = body.get('scale')

    if not filename or not cqc_scale:
        return HttpResponse("Missing filename or scale", status=400)

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

    Image.MAX_IMAGE_PIXELS = None
    train_scale      = 0.710
    train_omap_scale = 4000
    omap_scale       = 4000
    SCALE_FACTOR     = scale / train_scale * omap_scale / train_omap_scale

    import json

    try:
        with open(map_path, 'rb') as f:
            img = Image.open(f)
            img.load()
            img = img.convert("RGB")
            new_size = (int(img.width * SCALE_FACTOR), int(img.height * SCALE_FACTOR))
            if new_size[0] > 16000 or new_size[1] > 16000:
                return HttpResponse("Map too large for neural network. Check scale.", status=400)
            img = img.resize(new_size, resample=Image.BICUBIC)

        ort_session = ort.InferenceSession("best_model_300dpi.onnx")
        img_w, img_h = img.size
        output_img = np.zeros((img_h, img_w), dtype=np.float32)

        TILE_SIZE    = 2048
        OVERLAP_RATIO = 0.2
        overlap      = int(TILE_SIZE * OVERLAP_RATIO)
        step         = TILE_SIZE - overlap
        tiles_y      = math.ceil((img_h - overlap) / step)
        tiles_x      = math.ceil((img_w - overlap) / step)
        total_tiles  = max(1, tiles_y * tiles_x)
        processed_tiles = 0

        def model_predict_fn(input_data):
            out = ort_session.run(None, {"input": input_data})[0]
            if out.ndim == 4: out = out[0]
            if out.shape[0] > 1: out = out.argmax(axis=0)
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
                        tile_np = np.transpose(tile_np, (2, 0, 1))[np.newaxis].astype(np.float32)
                        tile_pred = await loop.run_in_executor(None, model_predict_fn, tile_np)
                        out_y0 = y0 if y0 == 0 else y0 + overlap // 2
                        out_x0 = x0 if x0 == 0 else x0 + overlap // 2
                        out_y1 = y1 if y1 == img_h else y1 - overlap // 2
                        out_x1 = x1 if x1 == img_w else x1 - overlap // 2
                        ty0, tx0 = out_y0 - y0, out_x0 - x0
                        ty1 = min(ty0 + (out_y1 - out_y0), tile_pred.shape[0])
                        tx1 = min(tx0 + (out_x1 - out_x0), tile_pred.shape[1])
                        out_y1 = out_y0 + (ty1 - ty0)
                        out_x1 = out_x0 + (tx1 - tx0)
                        output_img[out_y0:out_y1, out_x0:out_x1] = tile_pred[ty0:ty1, tx0:tx1]
                        processed_tiles += 1
                        yield f"data: {json.dumps({'current': processed_tiles, 'total': total_tiles})}\n\n"
                        await asyncio.sleep(0.01)
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
                return

            mo = SimpleNamespace(impassable=0, very_slow=135, slow=231, cross=241, fast=243)
            visual = 255 * np.ones((img_h, img_w, 1), dtype=np.uint8)
            visual[output_img < 10] = mo.impassable
            visual[(output_img >= 10) & (output_img < 22)] = mo.very_slow
            visual[(output_img >= 22) & (output_img < 26)] = mo.slow
            visual[(output_img >= 26) & (output_img < 28)] = mo.cross
            visual[(output_img >= 28) & (output_img < 32)] = mo.fast
            visual[output_img == 32] = mo.cross
            visual[output_img == 33] = mo.fast
            visual[output_img == 34] = mo.impassable
            final_img = Image.fromarray(np.repeat(visual, 3, axis=2).astype(np.uint8))
            buf = BytesIO()
            final_img.save(buf, format="PNG")
            buf.seek(0)
            mask_path = os.path.join(settings.MEDIA_ROOT, 'masks', mask_filename)
            with open(mask_path, 'wb') as f:
                f.write(buf.read())
            yield f"data: {json.dumps({'done': True, 'mask_file': mask_filename})}\n\n"
            gc.collect()

        def sync_gen():
            loop = asyncio.new_event_loop()
            gen = tile_generator()
            chunk_count = 0
            try:
                while True:
                    try:
                        chunk = loop.run_until_complete(gen.__anext__())
                        chunk_count += 1
                        yield chunk
                    except StopAsyncIteration:
                        break
            finally:
                loop.close()
                print(f"[generate_mask] streamed {chunk_count} chunks for '{filename}' ({total_tiles} tiles)")

        resp = StreamingHttpResponse(sync_gen(), content_type="text/event-stream")
        resp["Cache-Control"] = "no-cache"
        resp["X-Accel-Buffering"] = "no"
        return resp

    except Exception as e:
        traceback.print_exc()
        return HttpResponse(str(e), status=500)