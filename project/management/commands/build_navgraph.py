"""Build (or backfill) ``.navgraph`` artifacts for uploaded map masks.

Wraps ``project.navgraph.build_navgraph`` / ``save_navgraph`` (see WP 1.1,
``plan.md`` repo root) with a management command so artifacts can be built
one-off (``--file``) or backfilled for every mask (``--all``).

Usage:
    python manage.py build_navgraph --file media/masks/mask_X.png
    python manage.py build_navgraph --file 7            # File id -> its mask
    python manage.py build_navgraph --all
    python manage.py build_navgraph --all --debug
    python manage.py build_navgraph --all --random --limit 10 --force --debug
    python manage.py build_navgraph --all --limit 5
    python manage.py build_navgraph --all --force
"""

import json
import os
import random
import time

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db.utils import DatabaseError

from project.navgraph import build_navgraph, save_navgraph

# Marker used by any derived artifact (npz/bin/debug overlay/...) so --all
# never mistakes one for a mask, regardless of where the marker falls.
NAVGRAPH_INFIX = ".navgraph."
_REGION_LOOKUP_DISABLED = False


def _masks_dir():
    return os.path.join(settings.MEDIA_ROOT, "masks")


def _mask_path_for_file_id(file_id):
    """Resolve a ``File`` id to its mask path (mirrors ``serve_mask_file()``
    in ``project/media_access.py``)."""
    from project.models import File

    try:
        file_obj = File.objects.only("map_file").get(pk=file_id)
    except File.DoesNotExist:
        raise CommandError(f"No File with id={file_id}.")

    stem, _ = os.path.splitext(file_obj.map_file or "")
    if not stem:
        raise CommandError(f"File id={file_id} has no map_file set.")

    mask_path = os.path.join(_masks_dir(), f"mask_{stem}.png")
    if not os.path.isfile(mask_path):
        raise CommandError(
            f"File id={file_id} (map_file={file_obj.map_file!r}) has no mask "
            f"at {mask_path}."
        )
    return mask_path


def _resolve_file_arg(arg):
    """``--file`` accepts either a filesystem path or a numeric ``File`` id."""
    if arg.isdigit():
        return _mask_path_for_file_id(int(arg))
    if not os.path.isfile(arg):
        raise CommandError(f"Mask file not found: {arg}")
    return arg


def _npz_path(mask_path):
    base, _ = os.path.splitext(mask_path)
    return base + ".navgraph.npz"


def _region_for_mask_path(mask_path):
    """The coach-drawn ``infinite_region`` polygon for this mask, or ``None``.

    Region lookup is deliberately best-effort. Local/staging databases that have
    not run the ``infinite_region`` migration should still be able to backfill
    navgraphs; in that case ``None`` means build with the automatic/full-map
    fallback instead of a hand-drawn polygon.
    """
    global _REGION_LOOKUP_DISABLED
    if _REGION_LOOKUP_DISABLED:
        return None

    from project.models import File

    name = os.path.basename(mask_path)
    if not (name.startswith("mask_") and name.lower().endswith(".png")):
        return None
    stem = name[len("mask_"):-len(".png")]

    try:
        region = (
            File.objects.filter(map_file__startswith=stem, deleted=False)
            .order_by("-last_edited")
            .values_list("infinite_region", flat=True)
            .first()
        )
    except DatabaseError:
        _REGION_LOOKUP_DISABLED = True
        return None

    if isinstance(region, list) and len(region) >= 3:
        return [[int(x), int(y)] for (x, y) in region]
    return None


def _artifact_region(npz_path):
    """Read the ``region_polygon`` recorded in a prior artifact's stats.

    Returns the stored polygon (list) or ``None`` (auto/none) — used to detect a
    region change as a rebuild reason."""
    if not os.path.isfile(npz_path):
        return None
    try:
        import numpy as np

        with np.load(npz_path, allow_pickle=True) as data:
            stats = json.loads(str(data["stats"]))
        region = stats.get("region_polygon")
        if isinstance(region, list) and len(region) >= 3:
            return [[int(x), int(y)] for (x, y) in region]
    except Exception:
        return None
    return None


def _is_up_to_date(mask_path):
    """Fresh iff the artifact is newer than the mask AND its stored region
    matches the File's current ``infinite_region`` (a region edit is a rebuild
    reason)."""
    npz_path = _npz_path(mask_path)
    if not os.path.isfile(npz_path):
        return False
    if os.path.getmtime(npz_path) < os.path.getmtime(mask_path):
        return False
    return _artifact_region(npz_path) == _region_for_mask_path(mask_path)


def _iter_all_masks(limit=None, randomize=False, seed=None):
    """Yield mask paths under ``media/masks``, skipping navgraph artifacts."""
    masks_dir = _masks_dir()
    if not os.path.isdir(masks_dir):
        return
    names = sorted(
        f for f in os.listdir(masks_dir)
        if f.startswith("mask_") and f.lower().endswith(".png")
        and NAVGRAPH_INFIX not in f
    )
    if randomize:
        random.Random(seed).shuffle(names)
    if limit is not None:
        names = names[:limit]
    for name in names:
        yield os.path.join(masks_dir, name)


class Command(BaseCommand):
    help = (
        "Build .navgraph.npz / .navgraph.bin artifacts for mask PNGs "
        "(project/navgraph.py). Use --file for a single mask (path or File "
        "id) or --all to backfill every mask in media/masks/."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--file', default=None,
            help="Build a single mask: a filesystem path to the mask PNG, "
                 "or a File model id (integer).",
        )
        parser.add_argument(
            '--all', action='store_true',
            help="Build every mask under media/masks/.",
        )
        parser.add_argument(
            '--force', action='store_true',
            help="Rebuild even if an up-to-date artifact already exists.",
        )
        parser.add_argument(
            '--limit', type=int, default=None,
            help="Process at most N masks (applies to --all).",
        )
        parser.add_argument(
            '--random', action='store_true',
            help="Randomize mask order before applying --limit.",
        )
        parser.add_argument(
            '--seed', type=int, default=None,
            help="Optional seed for --random, useful for repeatable samples.",
        )
        parser.add_argument(
            '--debug', action='store_true',
            help="Also write <mask>.navgraph.debug.png overlays showing the "
                 "connected nodes/edges for each processed mask.",
        )

    def handle(self, *args, **opts):
        file_arg = opts['file']
        # --limit only makes sense against the --all backfill, so treat it as
        # implying --all (lets `--limit N` be used standalone for testing).
        all_flag = opts['all'] or opts['limit'] is not None or opts['random']
        force = opts['force']
        limit = opts['limit']
        randomize = opts['random']
        seed = opts['seed']
        debug = opts['debug']

        if bool(file_arg) == bool(all_flag):
            raise CommandError("Specify exactly one of --file or --all.")

        if file_arg:
            mask_paths = [_resolve_file_arg(file_arg)]
        else:
            mask_paths = list(_iter_all_masks(
                limit=limit, randomize=randomize, seed=seed))
            if not mask_paths:
                self.stdout.write(self.style.WARNING(
                    f"No masks found under {_masks_dir()}."
                ))
                return

        built = 0
        skipped = 0
        failed = 0
        debug_written = 0

        for mask_path in mask_paths:
            name = os.path.basename(mask_path)
            artifact = None

            if not force and _is_up_to_date(mask_path):
                self.stdout.write(f"SKIP  {name} (up to date)")
                skipped += 1
            else:
                try:
                    t0 = time.time()
                    region = _region_for_mask_path(mask_path)
                    artifact = build_navgraph(mask_path, region_polygon=region)
                    save_navgraph(artifact, mask_path)
                    elapsed = time.time() - t0
                    stats = artifact["stats"]
                    self.stdout.write(self.style.SUCCESS(
                        f"BUILT {name}: {stats['mpx']} Mpx, ds={stats['downsample']}, "
                        f"nodes={stats['n_nodes']}, edges={stats['n_edges']}, "
                        f"hitzone={stats['hitzone_source']}, "
                        f"main_conn={stats['main_component_connectivity']:.3f}, "
                        f"{elapsed:.1f}s"
                    ))
                    built += 1
                except Exception as exc:
                    self.stdout.write(self.style.ERROR(f"FAILED {name}: {exc}"))
                    failed += 1
                    continue

            if debug:
                try:
                    from scripts.navgraph_debug import render_overlay_for_mask

                    render_overlay_for_mask(mask_path, artifact=artifact)
                    debug_written += 1
                except Exception as exc:
                    self.stdout.write(self.style.ERROR(
                        f"FAILED debug overlay for {name}: {exc}"
                    ))
                    failed += 1

        self.stdout.write(
            f"Done. {built} built, {skipped} skipped, "
            f"{debug_written} debug PNGs, {failed} failed."
        )
