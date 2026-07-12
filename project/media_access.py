import mimetypes
import os
import logging

from django.conf import settings
from django.db.models import Q
from django.http import FileResponse, HttpResponseNotFound
from django.utils.translation import gettext as _

from .models import File


logger = logging.getLogger(__name__)


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


def user_can_access_file(request, file, *, require_published=False):
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


def navgraph_artifact_is_current(file):
    """True when the on-disk ``.navgraph.bin`` matches ``file``'s canonical
    passage document + mask dimensions (CR 8.4).

    A committed passage edit bakes a new ``passage_revision``; until the file is
    reactivated and rebuilt, the old artifact is stale and must not be served or
    listed even via a direct URL. Any missing file, unreadable mask, or
    corruption is treated as not-current so a stale/broken artifact never
    reaches a player."""
    from .navgraph import (
        artifact_matches_passage_document, filter_level_passages_for_region,
        mask_dimensions, region_revision,
    )

    if not file.infinite_enabled:
        return False
    bin_path, mask_path = navgraph_artifact_paths(file)
    if not bin_path or not os.path.isfile(bin_path) or not os.path.isfile(mask_path):
        return False
    try:
        # A mask replacement must force a rebuild even when its dimensions and
        # passage document are unchanged. Application writes also delete the
        # artifact, while this timestamp check covers external/manual changes.
        if os.path.getmtime(mask_path) > os.path.getmtime(bin_path):
            return False
    except OSError:
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

    # Polygon revisions live in the companion NPZ. A coach-enabled artifact is current only
    # when its baked polygon identity matches the saved File revision.
    region = file.infinite_region
    if isinstance(region, list) and len(region) >= 3:
        npz_path = bin_path[:-len(".navgraph.bin")] + ".navgraph.npz"
        if not os.path.isfile(npz_path):
            return False
        try:
            import json
            import numpy as np

            with np.load(npz_path, allow_pickle=True) as data:
                stats = json.loads(str(data["stats"]))
            baked = stats.get("region_revision")
            expected = region_revision(region, width, height)
            if baked != expected:
                return False
        except Exception:
            return False
    return True


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
