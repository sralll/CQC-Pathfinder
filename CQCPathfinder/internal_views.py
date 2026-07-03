"""Internal endpoints triggered by Railway sidecar services.

Currently exposes a single webhook used by the volume-sync CRON service to kick
off sync commands on this (the main Django) service, which is the only one with
the Railway media volume mounted.
"""
import hmac
import logging
import os
import threading
from io import StringIO

from django.contrib.auth.decorators import login_not_required
from django.core.management import call_command
from django.http import HttpResponse, HttpResponseBadRequest, HttpResponseForbidden
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

logger = logging.getLogger(__name__)


def _db_backup_enabled() -> bool:
    value = os.environ.get("DB_BACKUP_ENABLED", "false").lower()
    return value in ("1", "true", "yes", "on")


def _run_sync(direction: str) -> None:
    buf = StringIO()
    try:
        call_command("sync_volume_to_r2", direction=direction, stdout=buf, stderr=buf)
        logger.info("[volume-sync %s] succeeded:\n%s", direction, buf.getvalue())
    except Exception:
        logger.exception(
            "[volume-sync %s] failed; output so far:\n%s", direction, buf.getvalue()
        )
        return

    if direction != "push" or not _db_backup_enabled():
        return

    buf = StringIO()
    try:
        call_command("backup_database_to_r2", stdout=buf, stderr=buf)
        logger.info("[db-backup] succeeded:\n%s", buf.getvalue())
    except Exception:
        logger.exception("[db-backup] failed; output so far:\n%s", buf.getvalue())


@login_not_required
@csrf_exempt
@require_POST
def trigger_volume_sync(request):
    expected = os.environ.get("VOLUME_SYNC_TOKEN", "")
    presented = request.headers.get("X-Sync-Token", "")
    if not expected or not hmac.compare_digest(expected, presented):
        return HttpResponseForbidden("forbidden\n")

    direction = request.GET.get("direction", "")
    if direction not in ("push", "pull"):
        return HttpResponseBadRequest("direction must be 'push' or 'pull'\n")

    threading.Thread(target=_run_sync, args=(direction,), daemon=True).start()
    return HttpResponse(f"triggered {direction}\n", status=202)
