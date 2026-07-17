"""Secure access, serving, and lifecycle helpers for uploaded media artifacts."""

import mimetypes
import os
import logging
import threading
import time

from django.conf import settings
from django.db.models import Q
from django.http import FileResponse, HttpResponseNotFound
from django.utils.translation import gettext as _

from ..models import File


logger = logging.getLogger(__name__)


# The player-facing Infinity picker and the superuser route-debug picker both
# validate every candidate's on-disk artifact. Keep that filesystem/PIL work
# short-lived and process-local; the key includes both artifact fingerprints and
# the File's last-edited state, so editor writes naturally miss the cache.
_NAVGRAPH_CURRENCY_CACHE_TTL = 5.0
_navgraph_currency_cache = {}
_navgraph_currency_cache_lock = threading.Lock()


def safe_media_filename(filename):
    filename = (filename or "").strip()
    if not filename or "/" in filename or "\\" in filename:
        return None
    if filename != os.path.basename(filename):
        return None
    return filename


def user_can_access_map_file(request, filename, *, require_published=False):
    filename = safe_media_filename(filename)
    if not filename:
        return False

    qs = File.objects.filter(map_file=filename, deleted=False)
    if require_published:
        qs = qs.filter(published=True)

    if request.user.is_superuser:
        return qs.exists()

    try:
        active_team = request.user.profile.active_team
    except Exception:
        return False
    if not active_team:
        return False

    if active_team.shared_pool:
        qs = qs.filter(Q(team=active_team) | Q(team__shared_pool=True))
    else:
        qs = qs.filter(team=active_team)
    return qs.exists()


def user_can_access_file(request, file, *, require_published=False,
                         require_own_team=False):
    """Return whether ``request.user`` may access ``file``.

    Files owned by the active team are readable and writable. A shared-pool
    team may read/play files owned by another shared-pool team, but those files
    remain read-only to the non-owning team. Editor write endpoints must pass
    ``require_own_team=True`` so that policy is explicit and consistent.
    """
    if not file or file.deleted:
        return False
    if require_published and not file.published:
        return False
    if request.user.is_superuser:
        return True

    try:
        active_team = request.user.profile.active_team
    except Exception:
        return False
    if not active_team:
        return False

    own = file.team == active_team
    if require_own_team:
        return own
    shared = active_team.shared_pool and file.team and file.team.shared_pool
    return own or shared


def serve_map_file(filename):
    filename = safe_media_filename(filename)
    if not filename:
        return HttpResponseNotFound("Map not found.")

    filepath = os.path.join(settings.MEDIA_ROOT, "maps", filename)
    if not os.path.isfile(filepath):
        return HttpResponseNotFound(f"Map '{filename}' not found.")

    content_type, _ = mimetypes.guess_type(filepath)
    response = FileResponse(open(filepath, "rb"), content_type=content_type or "application/octet-stream")
    response["X-Content-Type-Options"] = "nosniff"
    return response


def serve_mask_file(file):
    filename = safe_media_filename(file.map_file)
    if not filename:
        return HttpResponseNotFound("Mask not found.")

    stem, _ = os.path.splitext(filename)
    filepath = os.path.join(settings.MEDIA_ROOT, "masks", f"mask_{stem}.png")
    if not os.path.isfile(filepath):
        return HttpResponseNotFound("Mask not found.")

    response = FileResponse(open(filepath, "rb"), content_type="image/png")
    response["X-Content-Type-Options"] = "nosniff"
    return response


def navgraph_artifact_paths(file):
    """Return ``(bin_path, mask_path)`` for a File's navgraph artifact, or
    ``(None, None)`` when the map filename is unsafe/missing."""
    filename = safe_media_filename(file.map_file)
    if not filename:
        return None, None
    stem, _ = os.path.splitext(filename)
    masks_dir = os.path.join(settings.MEDIA_ROOT, "masks")
    bin_path = os.path.join(masks_dir, f"mask_{stem}.navgraph.bin")
    mask_path = os.path.join(masks_dir, f"mask_{stem}.png")
    return bin_path, mask_path


def delete_navgraph_artifacts(file):
    """Delete every persisted navgraph derivative for ``file``'s mask.

    Mask, region, and passage edits all invalidate the complete build. Removing
    the binary as well as the diagnostic NPZ/debug image makes that invalidation
    fail closed even if a future serving call accidentally omits a revision
    check. Missing files are intentionally harmless.
    """
    bin_path, _mask_path = navgraph_artifact_paths(file)
    if not bin_path:
        return
    base = bin_path[:-len(".navgraph.bin")]
    for path in (
        bin_path,
        base + ".navgraph.npz",
        base + ".navgraph.debug.png",
    ):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError:
            # The database flag and serving gate still fail closed. Do not turn
            # an otherwise successful editor save into a 500 because a stale
            # diagnostic file is temporarily locked by another process.
            logger.warning("Could not delete stale navgraph artifact %s", path,
                           exc_info=True)


def _navgraph_artifact_is_current_uncached(file, bin_path, mask_path,
                                           mask_stat, bin_stat):
    """Perform the full artifact currency check without using the short cache."""
    from ..navgraph import (
        artifact_matches_passage_document, filter_level_passages_for_region,
        mask_dimensions, region_revision,
    )

    if not file.infinite_enabled:
        return False

    # A mask replacement must force a rebuild even when its dimensions and
    # passage document are unchanged. Application writes also delete the
    # artifact, while this timestamp check covers external/manual changes.
    if mask_stat.st_mtime_ns > bin_stat.st_mtime_ns:
        return False

    try:
        width, height = mask_dimensions(mask_path)
    except Exception:
        return False
    effective_passages, _ignored = filter_level_passages_for_region(
        file.level_passages, file.infinite_region, width, height)
    if not artifact_matches_passage_document(
            bin_path, effective_passages, width, height):
        return False

    # v5 is self-contained: the served binary carries the polygon identity, so
    # production does not need to retain the full debug NPZ merely to pass the
    # currency gate.
    region = file.infinite_region
    expected_region_revision = (
        region_revision(region, width, height)
        if isinstance(region, list) and len(region) >= 3 else "")
    try:
        from ..navgraph import read_bin_header
        header = read_bin_header(bin_path)
    except Exception:
        return False
    return bool(
        header is not None
        and (header.get("region_revision") or "") == expected_region_revision
    )


def navgraph_artifact_is_current(file):
    """True when the on-disk ``.navgraph.bin`` matches ``file``'s canonical
    passage document + mask dimensions (CR 8.4).

    A committed passage edit bakes a new ``passage_revision``; until the file is
    reactivated and rebuilt, the old artifact is stale and must not be served or
    listed even via a direct URL. Any missing file, unreadable mask, or
    corruption is treated as not-current so a stale/broken artifact never
    reaches a player."""
    if not file.infinite_enabled:
        return False
    bin_path, mask_path = navgraph_artifact_paths(file)
    if not bin_path:
        return False
    try:
        mask_stat = os.stat(mask_path)
        bin_stat = os.stat(bin_path)
    except OSError:
        return False

    last_edited = getattr(file, 'last_edited', None)
    cache_key = (
        file.pk,
        bin_path,
        (mask_stat.st_mtime_ns, mask_stat.st_size),
        (bin_stat.st_mtime_ns, bin_stat.st_size),
        bool(file.infinite_enabled),
        last_edited.isoformat() if last_edited else None,
    )
    now = time.monotonic()
    with _navgraph_currency_cache_lock:
        cached = _navgraph_currency_cache.get(cache_key)
        if cached and now - cached[0] < _NAVGRAPH_CURRENCY_CACHE_TTL:
            return cached[1]

    current = _navgraph_artifact_is_current_uncached(
        file, bin_path, mask_path, mask_stat, bin_stat)
    with _navgraph_currency_cache_lock:
        _navgraph_currency_cache[cache_key] = (now, current)
        if len(_navgraph_currency_cache) > 1024:
            cutoff = now - _NAVGRAPH_CURRENCY_CACHE_TTL
            for key, value in list(_navgraph_currency_cache.items()):
                if value[0] < cutoff:
                    _navgraph_currency_cache.pop(key, None)
    return current


def serve_navgraph_file(file):
    bin_path, _mask_path = navgraph_artifact_paths(file)
    if not bin_path or not os.path.isfile(bin_path):
        return HttpResponseNotFound("Navgraph not found.")
    if not navgraph_artifact_is_current(file):
        # The baked artifact is stale for the file's current passages/mask. The
        # coach must reactivate infinite play to rebuild the locked revision.
        return HttpResponseNotFound(_("Navgraph is stale; rebuild required."))

    response = FileResponse(open(bin_path, "rb"), content_type="application/octet-stream")
    response["X-Content-Type-Options"] = "nosniff"
    return response
