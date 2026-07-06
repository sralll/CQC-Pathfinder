import mimetypes
import os

from django.conf import settings
from django.db.models import Q
from django.http import FileResponse, HttpResponseNotFound

from .models import File


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


def serve_navgraph_file(file):
    filename = safe_media_filename(file.map_file)
    if not filename:
        return HttpResponseNotFound("Navgraph not found.")

    stem, _ = os.path.splitext(filename)
    filepath = os.path.join(settings.MEDIA_ROOT, "masks", f"mask_{stem}.navgraph.bin")
    if not os.path.isfile(filepath):
        return HttpResponseNotFound("Navgraph not found.")

    response = FileResponse(open(filepath, "rb"), content_type="application/octet-stream")
    response["X-Content-Type-Options"] = "nosniff"
    return response
