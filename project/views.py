from math import isfinite

from django.shortcuts import get_object_or_404, render
from django.http import JsonResponse, HttpResponseNotFound
from django.views.decorators.http import require_GET, require_POST
from django.db import transaction
from django.db.models import Count, Q
from .models import File, Label, ControlPair, Route
from .passage_validation import (
    LevelPassagesValidationError,
    normalize_level_passages,
)
from account.decorators import role_required
from django.db.models import Prefetch
import traceback
import logging
from django.conf import settings
from django.utils import timezone
from django.utils.translation import gettext as _
import os
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor

from .media_access import (
    safe_media_filename,
    serve_map_file,
    serve_mask_file,
    serve_navgraph_file,
    user_can_access_file,
    user_can_access_map_file,
)

logger = logging.getLogger(__name__)

_OCAD_CONVERSION_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_OCAD_CONVERSION_STALE_MINUTES = 15


def _invalid_level_passages_response(exc):
    """Return a stable client error while retaining a developer diagnostic."""
    return JsonResponse({
        'error': 'invalid_level_passages',
        'message': _('This file is not a valid project.'),
        'detail': str(exc),
    }, status=400)


class InvalidPassageRouteUpdate(Exception):
    """Developer-facing validation failure for a coalesced passage save."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _invalid_passage_route_update_response(exc, status=400):
    return JsonResponse({
        'error': 'invalid_route_updates',
        'detail': str(exc),
    }, status=status)


def _validate_passage_route_updates(data, file):
    """Validate and lock derived route metrics in a passage save batch."""
    route_updates = data.get('route_updates', [])
    if not isinstance(route_updates, list):
        raise InvalidPassageRouteUpdate('route_updates must be a list')

    validated = []
    seen_route_ids = set()
    allowed_fields = {'db_id', 'obstacle', 'run_time'}
    metric_fields = ('obstacle', 'run_time')
    for index, update in enumerate(route_updates):
        if not isinstance(update, dict):
            raise InvalidPassageRouteUpdate(f'route_updates[{index}] must be an object')

        cp_db_id = update.get('cp_db_id')
        route_data = update.get('route')
        if (isinstance(cp_db_id, bool) or not isinstance(cp_db_id, int) or cp_db_id <= 0
                or not isinstance(route_data, dict)):
            raise InvalidPassageRouteUpdate(f'route_updates[{index}] has invalid ownership data')

        unknown_fields = set(route_data) - allowed_fields
        if unknown_fields or not all(field in route_data for field in metric_fields):
            raise InvalidPassageRouteUpdate(
                f'route_updates[{index}] must contain only db_id, obstacle, and run_time'
            )

        route_db_id = route_data.get('db_id')
        if (isinstance(route_db_id, bool) or not isinstance(route_db_id, int)
                or route_db_id <= 0):
            raise InvalidPassageRouteUpdate(f'route_updates[{index}] has an invalid route id')
        if route_db_id in seen_route_ids:
            raise InvalidPassageRouteUpdate(f'route_updates[{index}] duplicates route {route_db_id}')

        metrics = {}
        for field in metric_fields:
            value = route_data[field]
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not isfinite(value)
                or value < 0
            ):
                raise InvalidPassageRouteUpdate(
                    f'route_updates[{index}].route.{field} must be a non-negative number or null'
                )
            metrics[field] = value

        route = (
            Route.objects
            .select_for_update()
            .filter(id=route_db_id, control_pair_id=cp_db_id, control_pair__file=file)
            .first()
        )
        if route is None:
            raise InvalidPassageRouteUpdate(
                f'Route {route_db_id} does not belong to control pair {cp_db_id} in this file',
                status=404,
            )

        seen_route_ids.add(route_db_id)
        validated.append((route, metrics))

    return validated


def _normalize_order_payload(control_pairs):
    """Keep relative order but make CP and route orders contiguous from zero."""
    if not isinstance(control_pairs, list):
        return []
    control_pairs.sort(key=lambda cp: cp.get('order', 0) if isinstance(cp, dict) else 0)
    for cp_order, cp in enumerate(control_pairs):
        if not isinstance(cp, dict):
            continue
        cp['order'] = cp_order
        routes = cp.get('routes')
        if not isinstance(routes, list):
            cp['routes'] = []
            continue
        routes.sort(key=lambda route: route.get('order', 0) if isinstance(route, dict) else 0)
        for route_order, route in enumerate(routes):
            if isinstance(route, dict):
                route['order'] = route_order
    return control_pairs


def _map_scale_value(raw, default=4000):
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _map_file_is_claimable(request, filename):
    filename = safe_media_filename(filename)
    if not filename:
        return False
    existing_files = File.objects.filter(map_file=filename, deleted=False).select_related('team')
    return all(user_can_access_file(request, existing) for existing in existing_files)


MAX_MAP_IMAGE_PIXELS = 100_000_000


def _validate_uploaded_map_image(uploaded):
    """Return (error_message, normalized_ext) for raster map uploads."""
    try:
        from PIL import Image, UnidentifiedImageError
        import warnings
        uploaded.seek(0)
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(uploaded) as img:
                image_format = img.format
                width, height = img.size
                img.verify()
    except (UnidentifiedImageError, OSError, ValueError):
        try:
            uploaded.seek(0)
        except Exception:
            pass
        return _('Only PNG, JPEG or OCAD allowed'), None
    except Image.DecompressionBombWarning:
        try:
            uploaded.seek(0)
        except Exception:
            pass
        return _('Image dimensions are too large'), None
    finally:
        try:
            uploaded.seek(0)
        except Exception:
            pass

    if image_format not in ("PNG", "JPEG"):
        return _('Only PNG, JPEG or OCAD allowed'), None
    if width <= 0 or height <= 0 or width * height > MAX_MAP_IMAGE_PIXELS:
        return _('Image dimensions are too large'), None
    return None, ".jpg" if image_format == "JPEG" else ".png"


def _create_db_snapshot(file, user, trigger):
    """Create a FileSnapshot from the current DB state of a File."""
    from .models import FileSnapshot
    cps_qs   = file.control_pairs.prefetch_related(
        Prefetch('routes', queryset=Route.objects.order_by('order'))
    ).order_by('order')
    cp_data  = []
    n_routes = 0
    for cp in cps_qs:
        routes = list(cp.routes.all())
        n_routes += len(routes)
        cp_data.append({
            'id': cp.id, 'order': cp.order,
            'start': cp.start, 'ziel': cp.ziel, 'complex': cp.complex,
            'routes': [{'id': r.id, 'order': r.order, 'rP': r.rP,
                         'noA': r.noA, 'pos': r.pos, 'length': r.length,
                         'run_time': r.run_time, 'elevation': r.elevation,
                         'obstacle': r.obstacle}
                        for r in routes],
        })
    FileSnapshot.objects.create(
        file=file, created_by=user, trigger=trigger,
        name=file.name, label=file.label, author=file.author or '',
        scale=file.scale, map_file=file.map_file, has_mask=file.has_mask,
        map_scale=file.map_scale,
        blocked_terrain=file.blocked_terrain,
        level_passages=normalize_level_passages(file.level_passages),
        control_pairs=cp_data,
        n_control_pairs=len(cp_data), n_routes=n_routes,
    )

# open editor
@role_required('Trainer')
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

        qs = (
            qs
            .select_related('locked_by', 'team', 'label')
            .defer('blocked_terrain')
            .annotate(cp_count=Count('control_pairs'))
        )
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

        from django.utils import timezone as tz
        from datetime import timedelta
        LOCK_TIMEOUT = timedelta(minutes=15)

        files = []
        for obj in qs:
            is_locked = bool(
                obj.locked_by and
                obj.locked_by != request.user and
                obj.locked_at and
                (tz.now() - obj.locked_at) < LOCK_TIMEOUT
            )
            files.append({
                'id': obj.id,
                'name': obj.name,
                'last_edited': obj.last_edited.isoformat() if obj.last_edited else '',
                'cp_count': obj.cp_count,
                'published': obj.published,
                'infinite_enabled': obj.infinite_enabled,
                'has_mask': obj.has_mask,
                'infinite_region_set': bool(
                    isinstance(obj.infinite_region, list) and len(obj.infinite_region) >= 3
                ),
                'author': obj.author or '',
                'team': obj.team.name if obj.team else '',
                'editable': obj.team == active_team,
                'label': {'id': obj.label.id, 'name': obj.label.name, 'color': obj.label.color} if obj.label else None,
                'batch_progress': obj.batch_progress,
                'is_locked': is_locked,
                'locked_by_name': (obj.locked_by.first_name or obj.locked_by.username) if is_locked else None,
                "can_edit": obj.team == request.user.profile.active_team,
                'team_name': obj.team.name if obj.team else '',
                'team_shared_pool': obj.team.shared_pool if obj.team else False,
            })

        return JsonResponse({
            'files': files,
            'active_team': active_team.name if active_team else '',
            'shared_pool': active_team.shared_pool if active_team else False,
            'labels': [{'id': l.id, 'name': l.name, 'color': l.color} for l in labels],
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
            .select_related('team', 'label', 'locked_by')
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

        # Validate before acquiring an editor lock. Unsupported future versions
        # remain untouched and cannot accidentally enter an editable v1 session.
        level_passages = normalize_level_passages(file.level_passages)

        # ``has_mask`` is a cache of the filesystem state, not the source of
        # truth.  A volume restore or an interrupted mask write can leave the
        # database flag stale.  The editor uses this value to choose between
        # loading and generating, so reconcile it whenever a file is opened.
        mask_path = _mask_path_for_file(file)
        has_mask = bool(mask_path and os.path.isfile(mask_path))
        if file.has_mask != has_mask:
            file.has_mask = has_mask
            file.save(update_fields=['has_mask'])

        # Determine read-only state: published takes priority, then active lock
        from django.utils import timezone as tz
        from datetime import timedelta
        LOCK_TIMEOUT = timedelta(minutes=15)
        locked_by_other = (
            file.locked_by and
            file.locked_by != request.user and
            file.locked_at and
            (tz.now() - file.locked_at) < LOCK_TIMEOUT
        )
        if file.published:
            read_only      = True
            locked_by_name = None
            read_only_reason = 'published'
        elif locked_by_other:
            read_only      = True
            locked_by_name = file.locked_by.first_name or file.locked_by.username
            read_only_reason = 'locked'
        else:
            read_only      = False
            locked_by_name = None
            read_only_reason = None
            file.locked_by = request.user
            file.locked_at = tz.now()
            file.save(update_fields=['locked_by', 'locked_at'])

        return JsonResponse({
            'project': {
                'id': file.id,
                'name':        file.name,
                'last_edited': file.last_edited.isoformat() if file.last_edited else None,
                'read_only':       read_only,
                'locked_by_name':  locked_by_name,
                'read_only_reason': read_only_reason,
                'published': file.published,
                'label': {'id': file.label.id, 'name': file.label.name, 'color': file.label.color} if file.label else None,
                'scale': file.scale,
                'map_scale': file.map_scale,
                'scaled': file.scaled,
                'map_file': file.map_file,
                'has_mask': has_mask,
                'infinite_enabled': file.infinite_enabled,
                'infinite_region_set': bool(
                    isinstance(file.infinite_region, list) and len(file.infinite_region) >= 3
                ),
                'blocked_terrain': file.blocked_terrain,
                'level_passages': level_passages,
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
                                'obstacle': r.obstacle,
                            }
                            for r in cp.routes.all()
                        ]
                    }
                    for cp in file.control_pairs.all()
                ]
            }
        })

    except LevelPassagesValidationError as exc:
        return _invalid_level_passages_response(exc)
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)

@role_required('Trainer')
@require_GET
def get_map(request, filename):
    if not user_can_access_map_file(request, filename):
        return HttpResponseNotFound("Map not found.")
    return serve_map_file(filename)


@role_required('Trainer')
@require_GET
def get_mask(request, file_id):
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not user_can_access_file(request, file):
        return HttpResponseNotFound("Mask not found.")
    return serve_mask_file(file)


@role_required('Trainer')
@require_GET
def get_navgraph(request, file_id):
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not user_can_access_file(request, file):
        return HttpResponseNotFound("Navgraph not found.")
    return serve_navgraph_file(file)


@role_required('Trainer')
@require_GET
def get_level_passages(request, file_id):
    """Return canonical passage data without acquiring an editor lock."""
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not user_can_access_file(request, file):
        return HttpResponseNotFound()
    try:
        return JsonResponse(normalize_level_passages(file.level_passages))
    except LevelPassagesValidationError as exc:
        return _invalid_level_passages_response(exc)


def _mask_path_for_file(file):
    """Resolve a File's full-res mask path (mirrors serve_mask_file)."""
    filename = safe_media_filename(file.map_file)
    if not filename:
        return None
    stem, _ext = os.path.splitext(filename)
    return os.path.join(settings.MEDIA_ROOT, 'masks', f'mask_{stem}.png')


def _mask_dimensions(mask_path):
    """Return (W, H) of the full-res mask in pixels without decoding it fully."""
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(mask_path) as img:
        return int(img.width), int(img.height)


def _region_is_full_frame(region, W, H, eps=2):
    """True when ``region`` is still exactly the whole-map frame corners.

    Enabling infinite play on the untouched frame is refused (routes could run
    around the map edge), so the toggle uses this to warn the coach to tighten
    the region first. A region whose corners have been dragged inward — even by
    a couple of pixels — is no longer the frame and passes."""
    if not isinstance(region, list) or len(region) != 4:
        return False
    corners = {(0, 0), (W, 0), (W, H), (0, H)}
    matched = set()
    for pt in region:
        if not isinstance(pt, (list, tuple)) or len(pt) != 2:
            return False
        best = min(corners, key=lambda c: abs(c[0] - pt[0]) + abs(c[1] - pt[1]))
        if abs(best[0] - pt[0]) > eps or abs(best[1] - pt[1]) > eps:
            return False
        matched.add(best)
    return matched == corners


def _validate_region_polygon(polygon):
    """Return (cleaned, error). Polygon must be a list of >=3 numeric [x, y]
    pairs; an empty list / None clears the region (returns [])."""
    if polygon in (None, []):
        return [], None
    if not isinstance(polygon, list) or len(polygon) < 3:
        return None, _('A region needs at least 3 points.')
    cleaned = []
    for pt in polygon:
        if (not isinstance(pt, (list, tuple)) or len(pt) != 2):
            return None, _('Invalid region point.')
        try:
            x = float(pt[0])
            y = float(pt[1])
        except (TypeError, ValueError):
            return None, _('Invalid region point.')
        cleaned.append([int(round(x)), int(round(y))])
    return cleaned, None


@role_required('Trainer')
@require_GET
def region_suggest(request, file_id):
    """Return the coach-drawn region if set, else an empty draft.

    JSON: ``{polygon: [[x,y],...], source: 'saved'|'empty'}`` in full-res
    mask-pixel coords (same space as the navgraph ``nodes``). Fresh maps start
    empty so the coach draws the polygon from scratch."""
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not user_can_access_file(request, file):
        return HttpResponseNotFound("Not found.")

    if isinstance(file.infinite_region, list) and len(file.infinite_region) >= 3:
        return JsonResponse({'polygon': file.infinite_region, 'source': 'saved'})

    mask_path = _mask_path_for_file(file)
    if not mask_path or not os.path.isfile(mask_path):
        return JsonResponse({'error': _('This map has no mask yet.')}, status=404)

    return JsonResponse({'polygon': [], 'source': 'empty'})


def _rebuild_navgraph_for_file(file_id, enable_on_success=False, build_token=None):
    """Background rebuild of a File's navgraph honouring its saved region.

    Surfaces state in ``File.batch_progress`` (type ``navgraph_build``) so the
    editor can poll ``navgraph_build_status``. When ``enable_on_success`` is set
    (the coach activated infinite play), ``File.infinite_enabled`` is flipped on
    only *after* the graph is built — never before — so a half-built map can
    never be served to players."""
    from django.db import close_old_connections
    close_old_connections()
    try:
        file = File.objects.filter(id=file_id, deleted=False).first()
        if not file:
            return
        if build_token:
            progress = file.batch_progress
            if not (
                isinstance(progress, dict)
                and progress.get('type') == 'navgraph_build'
                and progress.get('status') == 'building'
                and progress.get('build_token') == build_token
            ):
                return
        mask_path = _mask_path_for_file(file)
        if not mask_path or not os.path.isfile(mask_path):
            File.objects.filter(id=file_id).update(batch_progress={
                'type': 'navgraph_build', 'status': 'failed',
                'error': str(_('This map has no mask yet.')),
                'updated_at': timezone.now().isoformat(),
            })
            return
        File.objects.filter(id=file_id).update(batch_progress={
            'type': 'navgraph_build', 'status': 'building',
            'build_token': build_token,
            'updated_at': timezone.now().isoformat(),
        })
        from .navgraph import build_navgraph, save_navgraph
        region = file.infinite_region if isinstance(file.infinite_region, list) else None
        artifact = build_navgraph(mask_path, region_polygon=region)
        save_navgraph(artifact, mask_path)
        with transaction.atomic():
            file = File.objects.select_for_update().get(id=file_id)
            progress = file.batch_progress
            build_is_current = (
                not build_token
                or (
                    isinstance(progress, dict)
                    and progress.get('type') == 'navgraph_build'
                    and progress.get('status') == 'building'
                    and progress.get('build_token') == build_token
                )
            )
            if not build_is_current:
                # A mask/region edit invalidated this build while it was running.
                # The artifact may have been written, but it must never make the
                # file playable until a later, current build succeeds.
                file.infinite_enabled = False
                file.save(update_fields=['infinite_enabled'])
                return
            file.infinite_enabled = bool(enable_on_success)
            file.batch_progress = {
                'type': 'navgraph_build', 'status': 'done',
                'build_token': build_token,
                'infinite_enabled': bool(enable_on_success),
                'hitzone_source': artifact['stats'].get('hitzone_source'),
                'n_nodes': artifact['stats'].get('n_nodes'),
                'n_edges': artifact['stats'].get('n_edges'),
                'updated_at': timezone.now().isoformat(),
            }
            file.save(update_fields=['infinite_enabled', 'batch_progress'])
    except Exception as exc:
        logger.exception("navgraph rebuild failed for file %s", file_id)
        failure = {
            'type': 'navgraph_build', 'status': 'failed',
            'build_token': build_token,
            'error': str(exc), 'updated_at': timezone.now().isoformat(),
        }
        if build_token:
            File.objects.filter(
                id=file_id,
                batch_progress__build_token=build_token,
                batch_progress__status='building',
            ).update(infinite_enabled=False, batch_progress=failure)
        else:
            File.objects.filter(id=file_id).update(
                infinite_enabled=False,
                batch_progress=failure,
            )
    finally:
        close_old_connections()


@role_required('Trainer')
@require_POST
def save_region(request, file_id):
    """Persist the coach-drawn map-region polygon (autosave).

    Body JSON: ``{polygon: [[x,y],...]}`` in full-res mask-pixel coords. An empty
    list clears the region. This is a cheap persist only — the expensive navgraph
    rebuild is deferred until the coach activates infinite play (see
    ``toggle_infinite``), so dragging vertices never triggers a build."""
    import json as _json
    from django.utils import timezone as tz
    try:
        data = _json.loads(request.body or '{}')
        polygon, error = _validate_region_polygon(data.get('polygon'))
        if error:
            return JsonResponse({'error': error}, status=400)

        file = get_object_or_404(File, id=file_id, deleted=False)
        if not request.user.is_superuser and file.team != request.user.profile.active_team:
            return JsonResponse({'error': 'Permission denied'}, status=403)

        file.infinite_region = polygon or None
        file.infinite_enabled = False
        file.last_edited = tz.now()
        progress = file.batch_progress
        update_fields = ['infinite_region', 'infinite_enabled', 'last_edited']
        if isinstance(progress, dict) and progress.get('type') == 'navgraph_build' and progress.get('status') == 'building':
            file.batch_progress = {
                **progress,
                'status': 'invalidated',
                'infinite_enabled': False,
                'updated_at': file.last_edited.isoformat(),
            }
            update_fields.append('batch_progress')
        file.save(update_fields=update_fields)

        return JsonResponse({
            'status': 'ok',
            'polygon': file.infinite_region or [],
            'infinite_enabled': False,
        })
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_GET
def navgraph_build_status(request, file_id):
    """Poll the navgraph rebuild state set by save_region."""
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not user_can_access_file(request, file):
        return JsonResponse({'error': 'File not found'}, status=404)
    progress = file.batch_progress
    if not isinstance(progress, dict) or progress.get('type') != 'navgraph_build':
        return JsonResponse({'status': 'idle'})
    return JsonResponse({'progress': progress})


@role_required('Trainer')
@require_GET
def region_suitability(request, file_id):
    """Return the build-time infinite-play suitability estimate (WP 4.3).

    Reads the ``suitability`` block navgraph builds stash in
    ``stats`` inside the ``.navgraph.npz`` (see ``navgraph.build_navgraph`` /
    ``navgraph_suitability.simulate_suitability``) — a lightweight pair-
    generation simulation run at build time, not computed on request.

    JSON: ``{suitability: {valid_rate, mean_retries, mean_ms, n_attempts,
    n_valid, reasons, warn} | null}``. ``null`` when the map has no mask, no
    navgraph has been built yet, or the build's simulation failed."""
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not user_can_access_file(request, file):
        return HttpResponseNotFound("Not found.")

    mask_path = _mask_path_for_file(file)
    if not mask_path:
        return JsonResponse({'suitability': None})
    base, _ext = os.path.splitext(mask_path)
    npz_path = base + '.navgraph.npz'
    if not os.path.isfile(npz_path):
        return JsonResponse({'suitability': None})

    try:
        import json as _json
        import numpy as _np
        data = _np.load(npz_path, allow_pickle=True)
        stats = _json.loads(str(data['stats'])) if 'stats' in data else {}
        suitability = stats.get('suitability')
    except Exception:
        traceback.print_exc()
        return JsonResponse({'suitability': None})
    return JsonResponse({'suitability': suitability})


@role_required('Trainer')
@require_POST
def toggle_infinite(request, file_id):
    """Activate / deactivate infinite play for a map.

    Body JSON: ``{enabled: bool}``.

    * **Enable** — validates the coach-drawn region (must exist and must be
      tightened in from the whole-map frame, else routes could run around the
      edge), then kicks off the navgraph build in the background. The
      ``infinite_enabled`` flag is *not* flipped here — the build thread flips it
      only on success (see ``_rebuild_navgraph_for_file``). Returns
      ``{status:'building'}``; the editor polls ``navgraph_build_status``.
    * **Disable** — clears the flag immediately, no build."""
    import json as _json
    from django.utils import timezone as tz
    try:
        data = _json.loads(request.body or '{}')
        enabled = bool(data.get('enabled'))

        file = get_object_or_404(File, id=file_id, deleted=False)
        if not request.user.is_superuser and file.team != request.user.profile.active_team:
            return JsonResponse({'error': 'Permission denied'}, status=403)

        if not enabled:
            file.infinite_enabled = False
            file.save(update_fields=['infinite_enabled'])
            return JsonResponse({'status': 'ok', 'infinite_enabled': False})

        # --- Enabling: validate the region before building --------------------
        region = file.infinite_region
        has_region = isinstance(region, list) and len(region) >= 3
        mask_path = _mask_path_for_file(file)
        if not mask_path or not os.path.isfile(mask_path):
            return JsonResponse({'error': _('This map has no mask yet.')}, status=400)
        if not has_region:
            return JsonResponse({
                'error': _('Draw a map region before enabling infinite play.'),
            }, status=400)
        try:
            W, H = _mask_dimensions(mask_path)
            full_frame = _region_is_full_frame(region, W, H)
        except Exception:
            full_frame = False
        if full_frame:
            return JsonResponse({
                'error': _('The region still covers the whole map. Tighten it inward so routes cannot go around the map.'),
            }, status=400)

        # Build the navgraph in the background; the flag flips on success only.
        import threading
        build_token = uuid.uuid4().hex
        File.objects.filter(id=file.id).update(batch_progress={
            'type': 'navgraph_build', 'status': 'building',
            'build_token': build_token,
            'updated_at': tz.now().isoformat(),
        }, infinite_enabled=False)
        threading.Thread(
            target=_rebuild_navgraph_for_file, args=(file.id,),
            kwargs={'enable_on_success': True, 'build_token': build_token}, daemon=True,
        ).start()

        return JsonResponse({'status': 'building', 'infinite_enabled': False})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def toggle_publish(request, file_id):
    try:
        file = get_object_or_404(
            File,
            id=file_id,
            team=request.user.profile.active_team
        )

        # Only validate when publishing (not when unpublishing)
        if not file.published:
            from django.db.models import Count as _Count
            has_unrouted = (
                ControlPair.objects
                .filter(file=file)
                .annotate(_n=_Count('routes'))
                .filter(_n=0)
                .exists()
            )
            if has_unrouted:
                return JsonResponse(
                    {'error': 'unrouted', 'message': _('Controls without routes')},
                    status=400,
                )

        file.published = not file.published
        file.save(update_fields=['published'])

        # Return immediately — snapshot is expensive, run it in a background thread
        trigger   = 'Published' if file.published else 'Unpublished'
        file_id_  = file.id
        user_id_  = request.user.id

        import threading
        from django.db import connection as _db_conn

        def _snapshot_thread():
            from django.db import close_old_connections
            close_old_connections()
            try:
                from django.contrib.auth import get_user_model
                _file = File.objects.select_related('label').get(id=file_id_)
                _user = get_user_model().objects.get(id=user_id_)
                _create_db_snapshot(_file, _user, trigger)
            except Exception:
                traceback.print_exc()

        threading.Thread(target=_snapshot_thread, daemon=True).start()

        return JsonResponse({
            'published': file.published
        })

    except Exception as e:
        traceback.print_exc()

        return JsonResponse({
            'error': str(e)
        }, status=500)


@role_required('Trainer')
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
        if not user_can_access_file(request, file):
            return JsonResponse({'error': 'File not found'}, status=404)
        qs         = FileSnapshot.objects.filter(file=file).order_by('-created_at')
        total      = qs.count()
        show_all   = request.GET.get('all')
        if not show_all:
            qs = qs[:10]
        snaps = qs.values(
            'id', 'trigger', 'n_control_pairs', 'n_routes',
            'created_at', 'created_by__first_name',
            'map_file', 'scale', 'map_scale',
            'name', 'author',
            'label__name', 'label__color',
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

        level_passages = normalize_level_passages(snap.level_passages)

        return JsonResponse({
            'project': {
                'id':              file.id,
                'name':            file.name,
                'scale':           snap.scale,
                'map_scale':       snap.map_scale,
                'scaled':          file.scaled,
                'map_file':        snap.map_file,
                'has_mask':        snap.has_mask,
                'blocked_terrain': snap.blocked_terrain,
                'level_passages':  level_passages,
                'control_pairs':   snap.control_pairs,
            }
        })
    except LevelPassagesValidationError as exc:
        return _invalid_level_passages_response(exc)
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
        level_passages = normalize_level_passages(data.get('level_passages'))
        profile     = request.user.profile
        active_team = profile.active_team
        file_id     = data.get('id')
        client_trigger = data.get('_trigger', '')

        # Decide: update existing or create new
        file = None
        if file_id:
            try:
                existing = File.objects.select_related('locked_by').get(id=file_id, deleted=False)
                if existing.team == active_team:
                    # Lock-based conflict: reject if someone else holds a fresh lock
                    from datetime import timedelta
                    LOCK_TIMEOUT = timedelta(minutes=15)
                    if (existing.locked_by and existing.locked_by != request.user
                            and existing.locked_at
                            and (tz.now() - existing.locked_at) < LOCK_TIMEOUT):
                        locker = existing.locked_by.first_name or existing.locked_by.username
                        return JsonResponse({
                            'error': 'conflict',
                            'message': _('%(name)s is currently editing this file.') % {'name': locker},
                        }, status=409)
                    file = existing          # same team → overwrite
                # else: different team → fall through and create new
            except File.DoesNotExist:
                pass

        if file is None:
            file = File(team=active_team,
                        author=request.user.first_name or request.user.username)

        incoming_map_file = data.get('map_file', '')
        if incoming_map_file:
            incoming_map_file = safe_media_filename(incoming_map_file)
            if not incoming_map_file:
                return JsonResponse({'error': 'Invalid map filename'}, status=400)
            if not _map_file_is_claimable(request, incoming_map_file):
                return JsonResponse({'error': 'Permission denied for map file'}, status=403)

        file.name            = data.get('name', _('New project'))
        file.scale           = data.get('scale')
        file.map_scale       = _map_scale_value(data.get('map_scale'))
        file.scaled          = data.get('scaled', False)
        file.map_file        = incoming_map_file
        file.has_mask        = data.get('has_mask', False)
        file.blocked_terrain = data.get('blocked_terrain')
        file.level_passages  = level_passages
        file.last_edited     = tz.now()
        file.locked_by       = request.user   # refresh lock
        file.locked_at       = tz.now()
        file.save()

        # Rebuild control pairs atomically using bulk_create (2 INSERTs vs N×M)
        from django.db import transaction as _tx
        cp_data_list = _normalize_order_payload(data.get('control_pairs', []))
        with _tx.atomic():
            ControlPair.objects.filter(file=file).delete()   # cascades to routes

            created_cps = ControlPair.objects.bulk_create([
                ControlPair(
                    file    = file,
                    order   = cp_d['order'],
                    start   = cp_d.get('start'),
                    ziel    = cp_d.get('ziel'),
                    complex = cp_d.get('complex', False),
                )
                for cp_d in cp_data_list
            ])

            route_objects = []
            for cp_d, cp in zip(cp_data_list, created_cps):
                for r_d in cp_d.get('routes', []):
                    route_objects.append(Route(
                        control_pair = cp,
                        order        = r_d['order'],
                        rP           = r_d.get('rP'),
                        noA          = r_d.get('noA'),
                        pos          = r_d.get('pos'),
                        length       = r_d.get('length'),
                        run_time     = r_d.get('run_time'),
                        elevation    = r_d.get('elevation'),
                        obstacle     = r_d.get('obstacle'),
                    ))
            created_routes = Route.objects.bulk_create(route_objects)

        # Build id_map from the bulk-created objects
        id_map  = []
        r_index = 0
        for cp_d, cp in zip(cp_data_list, created_cps):
            route_ids = []
            for _route_payload in cp_d.get('routes', []):
                r = created_routes[r_index]; r_index += 1
                route_ids.append({'order': r.order, 'id': r.id})
            id_map.append({'order': cp.order, 'id': cp.id, 'routes': route_ids})

        if client_trigger == 'rename':
            _create_db_snapshot(file, request.user, 'Name changed')

        return JsonResponse({
            'status': 'ok',
            'id': file.id,
            'last_edited': file.last_edited.isoformat() if file.last_edited else None,
            'id_map': id_map,
        })

    except LevelPassagesValidationError as exc:
        return _invalid_level_passages_response(exc)
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
            file.author      = request.user.first_name or request.user.username
            file.last_edited = tz.now()
            file.locked_by   = request.user
            file.locked_at   = tz.now()
            file.save(update_fields=['author', 'last_edited', 'locked_by', 'locked_at'])
            return file.last_edited.isoformat()

        if element_type == 'control_pair':
            db_id = data.get('db_id')
            cp = get_object_or_404(ControlPair, id=db_id, file=file)
            cp.delete()
            return JsonResponse({'status': 'ok', 'last_edited': _touch_file()})

        elif element_type == 'route':
            db_id    = data.get('db_id')
            cp_db_id = data.get('cp_db_id')
            cp = get_object_or_404(ControlPair, id=cp_db_id, file=file)
            route = get_object_or_404(Route, id=db_id, control_pair=cp)
            route.delete()
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
    try:
        data    = _json.loads(request.body)
        file_id = data.get('file_id')
        pairs   = data.get('order', [])   # [{db_id, order}, ...]

        file = get_object_or_404(File, id=file_id, deleted=False)
        if file.team != request.user.profile.active_team:
            return JsonResponse({'error': 'Permission denied'}, status=403)

        from django.utils import timezone as tz
        with transaction.atomic():
            # Shift all to high temporary values to free constraint space
            offset = ControlPair.objects.filter(file=file).count() + 1000
            for p in pairs:
                ControlPair.objects.filter(id=p['db_id'], file=file).update(order=p['order'] + offset)
            # Set real values
            for p in pairs:
                ControlPair.objects.filter(id=p['db_id'], file=file).update(order=p['order'])

        file.last_edited = tz.now()
        file.save(update_fields=['last_edited'])
        return JsonResponse({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def save_element(request):
    """Granular save: control_pair | route | blocked_terrain | level_passages."""
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
                cp = ControlPair.objects.filter(id=cp_db_id, file=file).first()
                if not cp:
                    return JsonResponse({'error': 'Control pair does not belong to this file'}, status=404)
            else:
                cp = ControlPair(file=file)

            cp.order   = cp_data.get('order', 0)
            cp.start   = cp_data.get('start')
            cp.ziel    = cp_data.get('ziel')
            cp.complex = cp_data.get('complex', False)
            cp.save()
            file.author      = request.user.first_name or request.user.username
            file.last_edited = tz.now()
            file.locked_by   = request.user
            file.locked_at   = tz.now()
            file.save(update_fields=['author', 'last_edited', 'locked_by', 'locked_at'])
            return JsonResponse({'db_id': cp.id, 'last_edited': file.last_edited.isoformat()})

        # ── Route ─────────────────────────────────────────────────────────
        elif element_type == 'route':
            cp_db_id    = data.get('cp_db_id')
            route_data  = data.get('route', {})
            route_db_id = route_data.get('db_id')

            cp = ControlPair.objects.filter(id=cp_db_id, file=file).first()
            if not cp:
                return JsonResponse({'error': 'Control pair does not belong to this file'}, status=404)

            if route_db_id:
                route = Route.objects.filter(id=route_db_id, control_pair=cp).first()
                if not route:
                    return JsonResponse({'error': 'Route does not belong to this control pair'}, status=404)
            else:
                route = Route(control_pair=cp)

            route.order     = route_data.get('order', 0)
            route.rP        = route_data.get('rP')
            route.noA       = route_data.get('noA')
            route.pos       = route_data.get('pos')
            route.length    = route_data.get('length')
            route.run_time  = route_data.get('run_time')
            route.elevation = route_data.get('elevation')
            route.obstacle  = route_data.get('obstacle')
            route.save()
            if not cp.complex and cp.routes.count() > 2:
                cp.complex = True
                cp.save(update_fields=['complex'])
            file.author      = request.user.first_name or request.user.username
            file.last_edited = tz.now()
            file.locked_by   = request.user
            file.locked_at   = tz.now()
            file.save(update_fields=['author', 'last_edited', 'locked_by', 'locked_at'])
            return JsonResponse({'db_id': route.id, 'last_edited': file.last_edited.isoformat()})

        # ── Blocked terrain ───────────────────────────────────────────────
        elif element_type == 'blocked_terrain':
            file.blocked_terrain = data.get('blocked_terrain')
            file.author      = request.user.first_name or request.user.username
            file.last_edited = tz.now()
            file.locked_by   = request.user
            file.locked_at   = tz.now()
            file.save(update_fields=['author', 'blocked_terrain', 'last_edited', 'locked_by', 'locked_at'])
            return JsonResponse({'status': 'ok', 'last_edited': file.last_edited.isoformat()})

        # ── Additional level passages ─────────────────────────────────────────────────
        elif element_type == 'level_passages':
            level_passages = normalize_level_passages(data.get('level_passages'))
            with transaction.atomic():
                # Serialize the document and its derived route metrics together.
                file = File.objects.select_for_update().get(id=file.id)
                route_updates = _validate_passage_route_updates(data, file)
                for route, metrics in route_updates:
                    route.obstacle = metrics['obstacle']
                    route.run_time = metrics['run_time']
                    route.save(update_fields=['obstacle', 'run_time'])

                file.level_passages = level_passages
                file.author      = request.user.first_name or request.user.username
                file.last_edited = tz.now()
                file.locked_by   = request.user
                file.locked_at   = tz.now()
                file.save(update_fields=[
                    'author', 'level_passages', 'last_edited', 'locked_by', 'locked_at',
                ])

            return JsonResponse({
                'status': 'ok',
                'level_passages': file.level_passages,
                'route_updates': [
                    {
                        'cp_db_id': route.control_pair_id,
                        'route_id': route.id,
                        'obstacle': route.obstacle,
                        'run_time': route.run_time,
                    }
                    for route, _metrics in route_updates
                ],
                'last_edited': file.last_edited.isoformat(),
            })

        return JsonResponse({'error': f'Unknown type: {element_type}'}, status=400)

    except LevelPassagesValidationError as exc:
        return _invalid_level_passages_response(exc)
    except InvalidPassageRouteUpdate as exc:
        return _invalid_passage_route_update_response(exc, status=exc.status)
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
        level_passages = normalize_level_passages(data.get('level_passages'))

        if not file_id:
            return JsonResponse({'error': 'Missing file id'}, status=400)

        file = File.objects.filter(id=file_id, team=request.user.profile.active_team).first()
        if not file:
            return JsonResponse({'error': 'File not found'}, status=404)

        n_control_pairs = data.get('n_control_pairs', len(cps))
        n_routes        = data.get('n_routes', sum(len(cp.get('routes', [])) for cp in cps))

        from .models import FileSnapshot
        FileSnapshot.objects.create(
            file            = file,
            created_by      = request.user,
            trigger         = trigger,
            name            = file.name,
            label           = file.label,
            author          = file.author or '',
            scale           = data.get('scale'),
            map_scale       = _map_scale_value(data.get('map_scale')),
            map_file        = data.get('map_file', ''),
            has_mask        = data.get('has_mask', False),
            blocked_terrain = data.get('blocked_terrain'),
            level_passages  = level_passages,
            control_pairs   = cps,
            n_control_pairs = n_control_pairs,
            n_routes        = n_routes,
        )
        return JsonResponse({'status': 'ok', 'n_control_pairs': n_control_pairs, 'n_routes': n_routes})

    except LevelPassagesValidationError as exc:
        return _invalid_level_passages_response(exc)
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def mark_has_mask(request):
    """Set has_mask=True on a file. Works even for published/locked files
    so that mask generation doesn't repeat on every open."""
    import json as _json
    try:
        data    = _json.loads(request.body)
        file_id = data.get('file_id')
        file = get_object_or_404(File, id=file_id, deleted=False)
        # Only require team membership — no lock/publish check needed for this field
        if not request.user.is_superuser:
            active_team = request.user.profile.active_team
            own    = file.team == active_team
            shared = active_team and active_team.shared_pool and file.team and file.team.shared_pool
            if not (own or shared):
                return JsonResponse({'error': 'Permission denied'}, status=403)
        from django.utils import timezone as tz
        file.has_mask    = True
        file.last_edited = tz.now()
        file.save(update_fields=['has_mask', 'last_edited'])
        return JsonResponse({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def save_mask(request):
    """Receive a PNG blob and save it as the mask for the given map file."""
    from django.utils import timezone as tz
    filename = request.POST.get('filename')
    file_id = request.POST.get('file_id')
    file_obj = request.FILES.get('file')
    if not filename or not file_id or not file_obj:
        return JsonResponse({'error': 'Missing filename, file_id, or file'}, status=400)
    filename = safe_media_filename(filename)
    if not filename:
        return JsonResponse({'error': 'Invalid filename'}, status=400)
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not request.user.is_superuser and file.team != request.user.profile.active_team:
        return JsonResponse({'error': 'Permission denied'}, status=403)
    if file.map_file != filename:
        return JsonResponse({'error': 'file_id does not match filename'}, status=409)
    basename, _ = os.path.splitext(file.map_file)
    mask_path   = os.path.join(settings.MEDIA_ROOT, 'masks', f'mask_{basename}.png')
    os.makedirs(os.path.dirname(mask_path), exist_ok=True)
    # A navgraph is derived from the mask. Any successful mask write therefore
    # revokes infinite-play eligibility until the coach explicitly rebuilds it.
    # Keep the row locked until an atomic filesystem replacement completes, so
    # a concurrent enable cannot start a build against the previous mask.
    temp_path = None
    try:
        with transaction.atomic():
            file = File.objects.select_for_update().get(id=file.id, deleted=False)
            file.infinite_enabled = False
            file.last_edited = tz.now()
            progress = file.batch_progress
            update_fields = ['infinite_enabled', 'last_edited']
            if isinstance(progress, dict) and progress.get('type') == 'navgraph_build' and progress.get('status') == 'building':
                file.batch_progress = {
                    **progress,
                    'status': 'invalidated',
                    'infinite_enabled': False,
                    'updated_at': file.last_edited.isoformat(),
                }
                update_fields.append('batch_progress')
            file.save(update_fields=update_fields)

            fd, temp_path = tempfile.mkstemp(prefix='.mask-upload-', dir=os.path.dirname(mask_path))
            with os.fdopen(fd, 'wb') as temp_file:
                for chunk in file_obj.chunks():
                    temp_file.write(chunk)
            os.replace(temp_path, mask_path)
            temp_path = None
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
    return JsonResponse({'status': 'ok', 'infinite_enabled': False})


@role_required('Trainer')
@require_POST
def assign_label(request, file_id):
    import json as _json
    try:
        data        = _json.loads(request.body)
        label_id    = data.get('label_id')
        active_team = request.user.profile.active_team
        file = get_object_or_404(File, id=file_id, deleted=False)
        if file.team != active_team:
            return JsonResponse({'error': 'Permission denied'}, status=403)
        if label_id:
            label      = get_object_or_404(Label, id=label_id, team=active_team)
            file.label = label
            file.save(update_fields=['label'])
            _create_db_snapshot(file, request.user, 'Label')
        else:
            file.label = None
            file.save(update_fields=['label'])
            _create_db_snapshot(file, request.user, 'Label')
        return JsonResponse({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def create_label(request):
    import json as _json
    try:
        data        = _json.loads(request.body)
        name        = data.get('name', '').strip()[:25]
        active_team = request.user.profile.active_team
        if not name:
            return JsonResponse({'error': _('Name is required')}, status=400)
        if not active_team:
            return JsonResponse({'error': _('No active team')}, status=403)
        label, created = Label.objects.get_or_create(name=name, team=active_team,
                                                     defaults={'color': '#5b8db8'})
        if not created:
            return JsonResponse({'error': _('Label already exists')}, status=400)
        return JsonResponse({'id': label.id, 'name': label.name, 'color': label.color})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def delete_label(request, label_id):
    try:
        active_team = request.user.profile.active_team
        label = get_object_or_404(Label, id=label_id, team=active_team)
        label.delete()
        return JsonResponse({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def update_label_color(request, label_id):
    import json as _json
    ALLOWED = {'#5b8db8','#5baa7a','#c2824a','#8a5bc2','#c2a24a',
               '#4abac2','#c24a7a','#6b82c2','#7ac24a','#c24ab8'}
    try:
        data        = _json.loads(request.body)
        color       = data.get('color', '')
        active_team = request.user.profile.active_team
        if color not in ALLOWED:
            return JsonResponse({'error': _('Invalid color')}, status=400)
        label = get_object_or_404(Label, id=label_id, team=active_team)
        label.color = color
        label.save(update_fields=['color'])
        return JsonResponse({'status': 'ok', 'color': label.color})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def delete_project_file(request, file_id):
    try:
        file = get_object_or_404(File, id=file_id, deleted=False)
        if file.team != request.user.profile.active_team:
            return JsonResponse({'error': 'Permission denied'}, status=403)
        # Rename so the (name, team) unique constraint doesn't block reuse of the name
        from django.utils import timezone as tz
        suffix = f"_deleted_{file.id}"
        if not file.name.endswith(suffix):
            file.name = f"{file.name}{suffix}"[:255]
        file.deleted     = True
        file.last_edited = tz.now()
        file.save(update_fields=['name', 'deleted', 'last_edited'])
        return JsonResponse({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


def _ocad_conversion_payload(conversion, map_filename):
    mask_filename = f"mask_{os.path.splitext(map_filename)[0]}.png"
    return {
        'status': 'ok',
        'map_file': map_filename,
        'mask_file': mask_filename,
        'has_mask': False,
        'auto_generate_mask': True,
        'scale': conversion.get('scale'),
        'map_scale': conversion.get('ocad_map_scale') or 4000,
        'scaled': conversion.get('scaled', True),
        'control_pairs': conversion.get('control_pairs', []),
        'ocad': {
            'courses': conversion.get('courses', 0),
            'controls': conversion.get('controls', 0),
            'mask_symbols': conversion.get('mask_symbols', 0),
            'width': conversion.get('width'),
            'height': conversion.get('height'),
            'map_scale': conversion.get('ocad_map_scale'),
            'scale_calibration_factor': conversion.get('scale_calibration_factor'),
            'meters_per_raster_pixel': conversion.get('meters_per_raster_pixel'),
        },
    }


def _ocad_progress(status, **extra):
    now_iso = timezone.now().isoformat()
    payload = {
        'type': 'ocad_conversion',
        'status': status,
        'updated_at': now_iso,
    }
    payload.update(extra)
    return payload


def _unique_file_name_for_team(team, requested_name, exclude_id=None):
    base = (requested_name or _('New project')).strip() or _('New project')
    base = base[:240]
    name = base
    suffix = 1
    qs = File.objects.filter(team=team, deleted=False)
    if exclude_id:
        qs = qs.exclude(id=exclude_id)
    while qs.filter(name=name).exists():
        suffix += 1
        tail = f" ({suffix})"
        name = f"{base[:255 - len(tail)]}{tail}"
    return name


def _set_ocad_progress(file_id, status, **extra):
    progress = _ocad_progress(status, **extra)
    File.objects.filter(id=file_id, deleted=False).update(batch_progress=progress)
    return progress


def _run_ocad_conversion(file_id, source_path, map_filename, uploaded_name):
    from django.db import close_old_connections

    close_old_connections()
    try:
        _set_ocad_progress(file_id, 'converting', source_name=uploaded_name)
        from .ocad_tools.ocad import OcadConversionError, convert_ocad_map_to_editor_assets

        try:
            conversion = convert_ocad_map_to_editor_assets(source_path, map_filename)
        except OcadConversionError as exc:
            logger.warning("OCAD map upload conversion failed for %s: %s", uploaded_name, exc)
            _set_ocad_progress(
                file_id,
                'failed',
                source_name=uploaded_name,
                error=str(_('OCAD conversion failed: %(error)s') % {'error': exc}),
            )
            return

        result = _ocad_conversion_payload(conversion, map_filename)
        File.objects.filter(id=file_id, deleted=False).update(
            map_file=map_filename,
            has_mask=False,
            scale=result.get('scale'),
            map_scale=_map_scale_value(result.get('map_scale')),
            scaled=bool(result.get('scaled') and result.get('scale')),
            batch_progress=_ocad_progress('done', source_name=uploaded_name, result=result),
            last_edited=timezone.now(),
        )
    except Exception as exc:
        logger.exception("Unexpected OCAD conversion failure for %s", uploaded_name)
        _set_ocad_progress(file_id, 'failed', source_name=uploaded_name, error=str(exc))
    finally:
        try:
            os.unlink(source_path)
        except OSError:
            pass
        close_old_connections()


def _mark_stale_ocad_conversion_failed(file):
    progress = file.batch_progress
    if not isinstance(progress, dict) or progress.get('type') != 'ocad_conversion':
        return progress
    if progress.get('status') not in ('pending', 'converting'):
        return progress

    from datetime import timedelta
    from django.utils.dateparse import parse_datetime

    updated_at = parse_datetime(progress.get('updated_at') or '')
    if updated_at and timezone.is_naive(updated_at):
        updated_at = timezone.make_aware(updated_at, timezone.get_current_timezone())
    if updated_at and timezone.now() - updated_at <= timedelta(minutes=_OCAD_CONVERSION_STALE_MINUTES):
        return progress

    # If the dyno restarts while the in-process worker is busy, the thread is gone.
    # Mark the job terminal so the editor can offer a retry instead of polling forever.
    progress = _ocad_progress(
        'failed',
        source_name=progress.get('source_name'),
        error=str(_('OCAD conversion stopped before it finished. Please upload the file again.')),
    )
    File.objects.filter(id=file.id, deleted=False).update(batch_progress=progress)
    return progress


@role_required('Trainer')
@require_GET
def ocad_conversion_status(request, file_id):
    file = get_object_or_404(File, id=file_id, deleted=False)
    if not user_can_access_file(request, file):
        return JsonResponse({'error': 'File not found'}, status=404)
    progress = _mark_stale_ocad_conversion_failed(file)
    if not isinstance(progress, dict) or progress.get('type') != 'ocad_conversion':
        return JsonResponse({'error': 'No OCAD conversion is active for this file'}, status=404)
    return JsonResponse({'progress': progress})


@role_required('Trainer')
@require_POST
def upload_map(request):
    uploaded = request.FILES.get('file')
    if not uploaded:
        return JsonResponse({'error': 'No file'}, status=400)
    ext = os.path.splitext(uploaded.name)[1].lower()
    is_ocad = ext in ('.ocd', '.ocad')
    if is_ocad:
        if uploaded.size > 50 * 1024 * 1024:
            return JsonResponse({'error': _('File too large (max. 50 MB)')}, status=400)
    else:
        if uploaded.size > 15 * 1024 * 1024:
            return JsonResponse({'error': _('File too large (max. 15 MB)')}, status=400)
        error, image_ext = _validate_uploaded_map_image(uploaded)
        if error:
            return JsonResponse({'error': error}, status=400)
    try:
        from django.utils.timezone import now
        import uuid
        stamp = now().strftime('%Y%m%d_%H%M%S')
        token = f"{stamp}_{uuid.uuid4().hex[:12]}"

        if is_ocad:
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext or '.ocd')
            source_path = tmp.name
            with tmp as f:
                for chunk in uploaded.chunks():
                    f.write(chunk)

            map_filename = f"{token}.png"
            active_team = request.user.profile.active_team
            if not active_team:
                try:
                    os.unlink(source_path)
                except OSError:
                    pass
                return JsonResponse({'error': _('No active team')}, status=403)

            file = None
            file_id = request.POST.get('file_id')
            if file_id:
                file = File.objects.filter(id=file_id, team=active_team, deleted=False).first()
            if file is None:
                requested_name = request.POST.get('name') or os.path.splitext(uploaded.name)[0]
                file = File.objects.create(
                    name=_unique_file_name_for_team(active_team, requested_name),
                    team=active_team,
                    author=request.user.first_name or request.user.username,
                    locked_by=request.user,
                    locked_at=timezone.now(),
                )

            progress = _ocad_progress('pending', source_name=uploaded.name)
            file.batch_progress = progress
            file.locked_by = request.user
            file.locked_at = timezone.now()
            file.save(update_fields=['batch_progress', 'locked_by', 'locked_at'])
            _OCAD_CONVERSION_EXECUTOR.submit(_run_ocad_conversion, file.id, source_path, map_filename, uploaded.name)
            return JsonResponse({
                'status': 'pending',
                'async': True,
                'file_id': file.id,
                'name': file.name,
                'progress': progress,
            }, status=202)

        ext      = ext or image_ext or '.png'
        filename = f"{token}{ext}"
        dest     = os.path.join(settings.MEDIA_ROOT, 'maps', filename)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as f:
            for chunk in uploaded.chunks():
                f.write(chunk)
        return JsonResponse({'status': 'ok', 'map_file': filename})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def analyze_ocad(request):
    uploaded = request.FILES.get('file')
    if not uploaded:
        return JsonResponse({'error': 'No file'}, status=400)

    ext = os.path.splitext(uploaded.name)[1].lower()
    if ext not in ('.ocd', '.ocad'):
        return JsonResponse({'error': _('Only OCAD allowed')}, status=400)
    if uploaded.size > 50 * 1024 * 1024:
        return JsonResponse({'error': _('File too large (max. 50 MB)')}, status=400)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext or '.ocd')
    source_path = tmp.name
    try:
        with tmp as f:
            for chunk in uploaded.chunks():
                f.write(chunk)

        from .ocad_tools.ocad import OcadConversionError, extract_ocad_courses
        try:
            conversion = extract_ocad_courses(source_path)
        except OcadConversionError as exc:
            return JsonResponse({'error': _('OCAD analysis failed: %(error)s') % {'error': exc}}, status=400)

        control_pairs = conversion.get('control_pairs') or []
        n_routes = sum(len(cp.get('routes', [])) for cp in control_pairs if isinstance(cp, dict))
        return JsonResponse({
            'status': 'ok',
            'has_controls': len(control_pairs) > 0,
            'has_routes': n_routes > 0,
            'n_control_pairs': len(control_pairs),
            'n_routes': n_routes,
            'ocad': {
                'courses': conversion.get('courses', 0),
                'controls': conversion.get('controls', 0),
                'actual_route_segments': conversion.get('actual_route_segments', 0),
                'width': conversion.get('width'),
                'height': conversion.get('height'),
                'map_scale': conversion.get('ocad_map_scale'),
            },
        })
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)
    finally:
        try:
            os.unlink(source_path)
        except OSError:
            pass


@role_required('Trainer')
@require_POST
def import_courses(request):
    uploaded = request.FILES.get('file')
    if not uploaded:
        return JsonResponse({'error': 'No file'}, status=400)

    ext = os.path.splitext(uploaded.name)[1].lower()
    if ext != '.ocd':
        return JsonResponse({'error': _('Only OCD allowed')}, status=400)
    if uploaded.size > 50 * 1024 * 1024:
        return JsonResponse({'error': _('File too large (max. 50 MB)')}, status=400)

    def _positive_float(raw):
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None
        return value if value > 0 else None

    target_width = _positive_float(request.POST.get('target_width'))
    target_height = _positive_float(request.POST.get('target_height'))
    map_scale = _map_scale_value(request.POST.get('map_scale'))

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext or '.ocd')
    source_path = tmp.name
    try:
        with tmp as f:
            for chunk in uploaded.chunks():
                f.write(chunk)

        from .ocad_tools.course_import import scale_ocad_import_to_target
        from .ocad_tools.ocad import OcadConversionError, extract_ocad_courses
        try:
            conversion = extract_ocad_courses(source_path)
        except OcadConversionError as exc:
            return JsonResponse({'error': _('OCAD course import failed: %(error)s') % {'error': exc}}, status=400)
        control_pairs = scale_ocad_import_to_target(
            conversion, target_width, target_height, map_scale=map_scale,
        )
        meta = {
            'format': 'ocad',
            'courses': conversion.get('courses', 0),
            'controls': conversion.get('controls', 0),
            'routes': sum(len(cp.get('routes', [])) for cp in control_pairs),
            'width': conversion.get('width'),
            'height': conversion.get('height'),
            'scale': conversion.get('scale'),
            'map_scale': map_scale,
            'source_map_scale': conversion.get('ocad_map_scale'),
        }

        control_pairs = _normalize_order_payload(control_pairs)
        return JsonResponse({
            'status': 'ok',
            'control_pairs': control_pairs,
            'n_control_pairs': len(control_pairs),
            'n_routes': sum(len(cp.get('routes', [])) for cp in control_pairs),
            'meta': meta,
        })
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)
    finally:
        try:
            os.unlink(source_path)
        except OSError:
            pass


@role_required('Trainer')
@require_GET
def get_editor_settings(request):
    s = request.user.profile.editor_settings
    return JsonResponse({
        'auto_pathfind': s.auto_pathfind,
        'auto_jump':     s.auto_jump,
        'auto_obstacle': s.auto_obstacle,
    })


@role_required('Trainer')
@require_POST
def toggle_editor_setting(request):
    import json as _json
    try:
        data    = _json.loads(request.body)
        setting = data.get('setting')
        s = request.user.profile.editor_settings
        if setting == 'auto_pathfind':
            try:
                value = int(data.get('value'))
            except (TypeError, ValueError):
                return JsonResponse({'error': 'invalid value'}, status=400)
            s.auto_pathfind = max(0, min(4, value))
            s.save(update_fields=['auto_pathfind'])
            return JsonResponse({'auto_pathfind': s.auto_pathfind})
        elif setting == 'auto_jump':
            s.auto_jump = not s.auto_jump
            s.save(update_fields=['auto_jump'])
            return JsonResponse({'auto_jump': s.auto_jump})
        elif setting == 'auto_obstacle':
            s.auto_obstacle = not s.auto_obstacle
            s.save(update_fields=['auto_obstacle'])
            return JsonResponse({'auto_obstacle': s.auto_obstacle})
        return JsonResponse({'error': 'unknown setting'}, status=400)
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


@role_required('Trainer')
@require_POST
def checkin(request):
    """Release the file lock held by the current user.
    Accepts either JSON body or multipart form data (for sendBeacon compatibility)."""
    from django.utils import timezone as tz
    try:
        # sendBeacon sends FormData; normal fetch sends JSON
        if request.content_type and 'application/json' in request.content_type:
            import json as _json
            data = _json.loads(request.body or '{}')
            file_id = data.get('file_id')
        else:
            file_id = request.POST.get('file_id')

        if not file_id:
            return JsonResponse({'status': 'ok', 'note': 'no file_id'})

        File.objects.filter(id=file_id, locked_by=request.user).update(
            locked_by=None, locked_at=None
        )
        return JsonResponse({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)
