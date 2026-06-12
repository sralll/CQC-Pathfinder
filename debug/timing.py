"""Tiny wrappers that write timing rows without ever raising on failure.

The pathfinding flow runs on hot paths (one of them inside a background
thread spawned from the UNet view), so the writes here are best-effort: any
DB error is swallowed and printed, never bubbled up.
"""

import logging
import os
import threading

log = logging.getLogger(__name__)


def _safe_create(model_cls, **fields):
    try:
        model_cls.objects.create(**fields)
    except Exception as exc:  # pragma: no cover — purely defensive
        log.warning("debug timing write failed: %s", exc)
    finally:
        # When called from a background thread, Django won't tidy the
        # connection on our behalf. Close it so the pool stays healthy.
        if threading.current_thread() is not threading.main_thread():
            try:
                from django.db import connection
                connection.close()
            except Exception:
                pass


# record_navgraph_build was removed together with the navgraph pipeline.
# The NavGraphBuildTime model in debug/models.py is retained so the
# accumulated historical rows in the staging DB stay queryable.


def record_pathfinding(
    mask_basename: str,
    start_xy,
    ziel_xy,
    query_seconds: float,
    *,
    n_routes_requested: int,
    n_routes_returned: int,
    n_existing_routes: int = 0,
    n_blocked_features: int = 0,
    success: bool = True,
    cold: bool = False,
    source: str = "unknown",
    error: str = "",
):
    from .models import PathfindingTime

    _safe_create(
        PathfindingTime,
        mask_basename=mask_basename,
        start_x=int(start_xy[0]),
        start_y=int(start_xy[1]),
        ziel_x=int(ziel_xy[0]),
        ziel_y=int(ziel_xy[1]),
        n_routes_requested=int(n_routes_requested),
        n_routes_returned=int(n_routes_returned),
        n_existing_routes=int(n_existing_routes),
        n_blocked_features=int(n_blocked_features),
        query_seconds=float(query_seconds),
        success=bool(success),
        cold=bool(cold),
        source=source,
        error=error[:2000] if error else "",
    )
