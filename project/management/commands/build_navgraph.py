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

from project.navgraph import build_navgraph, region_revision, save_navgraph

# Marker used by any derived artifact (npz/bin/debug overlay/...) so --all
# never mistakes one for a mask, regardless of where the marker falls.
NAVGRAPH_INFIX = ".navgraph."
_FILE_LOOKUP_DISABLED = False


def _masks_dir():
    return os.path.join(settings.MEDIA_ROOT, "masks")


def _canonical_region(region):
    """The stored/current region polygon in a stable comparable form, or None."""
    if isinstance(region, list) and len(region) >= 3:
        return [[int(x), int(y)] for (x, y) in region]
    return None


def _file_rows_for_mask_path(mask_path):
    """Non-deleted ``File`` rows whose ``map_file`` resolves to this mask.

    The artifact is stored per *mask file* (``masks/mask_<stem>.*``), but several
    ``File`` rows can reference the same ``map_file`` (it is not unique). Lookup
    is best-effort: a database missing the ``infinite_region`` / ``level_passages``
    columns disables it and the caller falls back to an automatic/full-map,
    base-only build. Returns ``None`` when lookup is unavailable, otherwise a
    (possibly empty) list of rows."""
    global _FILE_LOOKUP_DISABLED
    if _FILE_LOOKUP_DISABLED:
        return None

    name = os.path.basename(mask_path)
    if not (name.startswith("mask_") and name.lower().endswith(".png")):
        return None
    stem = name[len("mask_"):-len(".png")]

    from project.models import File

    try:
        rows = list(
            File.objects.filter(map_file__startswith=stem, deleted=False)
            .only("id", "map_file", "infinite_region", "level_passages", "last_edited")
            .order_by("-last_edited")
        )
    except DatabaseError:
        _FILE_LOOKUP_DISABLED = True
        return None
    # ``startswith`` is a coarse prefilter; keep only exact-stem matches.
    return [r for r in rows if os.path.splitext(r.map_file or "")[0] == stem]


def _row_identity(row):
    """(region, normalized passages) identity used to detect ambiguous rows.

    An unreadable stored document yields a per-row sentinel so it never
    compares equal to another row (ambiguity is reported, not a crash)."""
    from project.passage_validation import (
        LevelPassagesValidationError, normalize_level_passages,
    )

    region = _canonical_region(row.infinite_region)
    try:
        passages = normalize_level_passages(row.level_passages)
    except LevelPassagesValidationError:
        passages = ("invalid", row.id)
    return (region, passages)


def _build_inputs_for_mask_path(mask_path):
    """Return ``(region, level_passages, error)`` for a path/`--all` build.

    ``error`` is a non-empty diagnostic when several ``File`` rows reference this
    mask with *conflicting* region or passage revisions — ambiguous ownership
    that must be skipped rather than silently building one row's topology and
    serving it to the others. Build a specific row with ``--file <id>`` instead.
    An orphan mask (no ``File`` row) or an unavailable lookup builds base-only
    from the automatic/full-map fallback."""
    rows = _file_rows_for_mask_path(mask_path)
    if not rows:  # None (lookup off) or [] (orphan mask)
        return None, None, None
    identity = _row_identity(rows[0])
    for row in rows[1:]:
        if _row_identity(row) != identity:
            ids = ", ".join(str(r.id) for r in rows)
            return None, None, (
                f"{len(rows)} File rows ({ids}) share this mask with different "
                f"region/passage revisions; refusing to guess which to build. "
                f"Build a specific row with --file <id>."
            )
    return rows[0].infinite_region, rows[0].level_passages, None


def _resolve_file_id_job(file_id):
    """``--file <id>`` builds *that exact* row's region + passages."""
    from project.models import File

    try:
        row = File.objects.only(
            "map_file", "infinite_region", "level_passages").get(pk=file_id)
    except File.DoesNotExist:
        raise CommandError(f"No File with id={file_id}.")

    stem, _ = os.path.splitext(row.map_file or "")
    if not stem:
        raise CommandError(f"File id={file_id} has no map_file set.")
    mask_path = os.path.join(_masks_dir(), f"mask_{stem}.png")
    if not os.path.isfile(mask_path):
        raise CommandError(
            f"File id={file_id} (map_file={row.map_file!r}) has no mask "
            f"at {mask_path}."
        )
    return mask_path, row.infinite_region, row.level_passages


def _npz_path(mask_path):
    base, _ = os.path.splitext(mask_path)
    return base + ".navgraph.npz"


def _bin_path(mask_path):
    base, _ = os.path.splitext(mask_path)
    return base + ".navgraph.bin"


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


def _artifact_region_revision(npz_path):
    """Read the polygon revision from stats, with a legacy-stats fallback."""
    if not os.path.isfile(npz_path):
        return None
    try:
        import numpy as np

        with np.load(npz_path, allow_pickle=True) as data:
            stats = json.loads(str(data["stats"]))
            revision = stats.get("region_revision")
            if revision:
                return str(revision)
            shape = stats.get("mask_shape")
            region = stats.get("region_polygon")
        if isinstance(shape, (list, tuple)) and len(shape) == 2:
            return region_revision(region, int(shape[1]), int(shape[0]))
    except Exception:
        return None
    return None


def _artifact_counts(npz_path):
    """Read prior artifact node/edge counts for deterministic backfill output."""
    if not os.path.isfile(npz_path):
        return {}
    try:
        import numpy as np

        with np.load(npz_path, allow_pickle=True) as data:
            stats = json.loads(str(data["stats"]))
        return {
            "nodes": int(stats["n_nodes"]),
            "edges": int(stats["n_edges"]),
        }
    except Exception:
        return {}


def _rebuild_reasons(mask_path, region, level_passages):
    """Every reason the artifact is stale for these build inputs (empty = fresh).

    Covers mask mtime/content, polygon revision, passage revision, and artifact
    format version so ``--all`` backfill can report exactly why it rebuilt."""
    from project.navgraph import (
        NAVGRAPH_VERSION, filter_level_passages_for_region, mask_dimensions,
        passage_revision, read_bin_header,
    )
    from project.passage_validation import normalize_level_passages

    npz_path = _npz_path(mask_path)
    bin_path = _bin_path(mask_path)
    if not os.path.isfile(npz_path) or not os.path.isfile(bin_path):
        return ["no artifact"]

    reasons = []
    try:
        width, height = mask_dimensions(mask_path)
    except Exception:
        return ["unreadable mask"]
    if os.path.getmtime(npz_path) < os.path.getmtime(mask_path):
        reasons.append("mask changed")
    if _artifact_region_revision(npz_path) != region_revision(region, width, height):
        reasons.append("region changed")

    header = read_bin_header(bin_path)
    if header is None:
        return ["unreadable artifact"]
    if header["version"] != NAVGRAPH_VERSION:
        reasons.append(f"format v{header['version']}->v{NAVGRAPH_VERSION}")
    else:
        try:
            effective, _ignored = filter_level_passages_for_region(
                normalize_level_passages(level_passages), region, width, height)
            current = passage_revision(effective, width, height)
        except Exception:
            current = None
        if current is None or header["passage_revision"] != current:
            reasons.append("passages changed")
    return reasons


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

        # A job is (mask_path, region, level_passages, ambiguity_error). Numeric
        # --file <id> builds that exact row; path-based --file and --all resolve
        # the shared-map rows and refuse ambiguous ownership.
        jobs = []
        if file_arg:
            if file_arg.isdigit():
                mask_path, region, passages = _resolve_file_id_job(int(file_arg))
                jobs.append((mask_path, region, passages, None))
            else:
                if not os.path.isfile(file_arg):
                    raise CommandError(f"Mask file not found: {file_arg}")
                region, passages, err = _build_inputs_for_mask_path(file_arg)
                jobs.append((file_arg, region, passages, err))
        else:
            mask_paths = list(_iter_all_masks(
                limit=limit, randomize=randomize, seed=seed))
            if not mask_paths:
                self.stdout.write(self.style.WARNING(
                    f"No masks found under {_masks_dir()}."
                ))
                return
            for mask_path in mask_paths:
                region, passages, err = _build_inputs_for_mask_path(mask_path)
                jobs.append((mask_path, region, passages, err))

        built = 0
        skipped = 0
        failed = 0
        ambiguous = 0
        debug_written = 0

        for mask_path, region, passages, err in jobs:
            name = os.path.basename(mask_path)
            artifact = None

            if err:
                self.stdout.write(self.style.WARNING(f"SKIP  {name} ({err})"))
                ambiguous += 1
                continue

            reasons = _rebuild_reasons(mask_path, region, passages)
            if not force and not reasons:
                self.stdout.write(f"SKIP  {name} (up to date)")
                skipped += 1
            else:
                try:
                    prior_counts = _artifact_counts(_npz_path(mask_path))
                    t0 = time.time()
                    artifact = build_navgraph(
                        mask_path, region_polygon=region,
                        level_passages=passages,
                        collect_diagnostics=debug)
                    save_navgraph(artifact, mask_path)
                    elapsed = time.time() - t0
                    stats = artifact["stats"]
                    bin_bytes = os.path.getsize(_bin_path(mask_path))
                    before_nodes = stats.get(
                        "nodes_before_region_prune",
                        prior_counts.get("nodes", stats["n_nodes"]),
                    )
                    before_edges = prior_counts.get("edges", stats["n_edges"])
                    after_nodes = stats.get("nodes_after_region_prune", stats["n_nodes"])
                    after_edges = stats["n_edges"]
                    why = "forced" if (force and not reasons) else ", ".join(reasons)
                    connectivity = stats.get("region_component_connectivity")
                    connectivity_text = (
                        f", main_conn={connectivity:.3f}"
                        if connectivity is not None else "")
                    self.stdout.write(self.style.SUCCESS(
                        f"BUILT {name}: {stats['mpx']} Mpx, ds={stats['downsample']}, "
                        f"nodes={before_nodes}->{after_nodes}, edges={before_edges}->{after_edges}, "
                        f"bin={bin_bytes}B, build={elapsed:.1f}s, "
                        f"passages={stats.get('n_passages', 0)}, "
                        f"hitzone={stats['hitzone_source']}"
                        f"{connectivity_text}, "
                        f"region={stats.get('region_revision') or 'auto'} [{why}]"
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
            f"{ambiguous} ambiguous, {debug_written} debug PNGs, {failed} failed."
        )
