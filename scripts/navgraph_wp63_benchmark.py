"""WP 6.3 A/B benchmark for polygon-pruned navgraph artifacts.

This deliberately never publishes artifacts.  For each mask it builds an
automatic/global baseline and the same mask with a supplied coach polygon,
serializes each only to a temporary binary, and optionally asks the production
Node router to measure state/snap/search timings.

Examples::

    python scripts/navgraph_wp63_benchmark.py --auto-select 7 --output scratch/wp63.json
    python scripts/navgraph_wp63_benchmark.py --manifest scratch/wp63-manifest.json

Manifest rows are ``{"mask": "...png", "region": [[x,y], ...]}``; paths are
relative to the repository root unless absolute.
"""

import argparse
import gzip
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from project.navgraph import _write_bin, build_navgraph


def _path(value):
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def _default_region(mask_path):
    with Image.open(mask_path) as image:
        width, height = image.size
    margin = max(4, min(width, height) // 20)
    return [
        [margin, margin], [width - 1 - margin, margin],
        [width - 1 - margin, height - 1 - margin], [margin, height - 1 - margin],
    ]


def _select_masks(count, max_mpx=None):
    paths = []
    for path in sorted((ROOT / "media" / "masks").glob("mask_*.png")):
        if ".navgraph." in path.name:
            continue
        try:
            with Image.open(path) as image:
                mpx = image.width * image.height
            paths.append((mpx, path))
        except Exception:
            continue
    if max_mpx is not None:
        limited = [row for row in paths if row[0] <= max_mpx * 1e6]
        if limited:
            paths = limited
    if not paths:
        raise RuntimeError("no mask PNGs found under media/masks")
    paths.sort()
    # Quantiles cover small, lower/mid/upper median, large and the largest
    # available map without hard-coding volatile production filenames.
    indices = sorted({
        round(i * (len(paths) - 1) / max(1, count - 1))
        for i in range(min(count, len(paths)))
    })
    return [{"mask": str(paths[i][1]), "region": _default_region(paths[i][1])}
            for i in indices]


def _load_manifest(path):
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise ValueError("manifest must be a JSON list")
    out = []
    for row in rows:
        if not isinstance(row, dict) or "mask" not in row:
            raise ValueError("each manifest row needs mask and region")
        out.append({"mask": str(_path(row["mask"])),
                    "region": row.get("region") or _default_region(_path(row["mask"]))})
    return out


def _encoded_sizes(data):
    result = {"rawBytes": len(data), "gzipBytes": len(gzip.compress(data, compresslevel=9))}
    try:
        import brotli
        result["brotliBytes"] = len(brotli.compress(data, quality=11))
    except Exception:
        result["brotliBytes"] = None
    return result


def _write_temp_bin(artifact, directory):
    fd, name = tempfile.mkstemp(prefix="wp63-", suffix=".navgraph.bin", dir=directory)
    os.close(fd)
    _write_bin(name, artifact)
    return Path(name)


def _runtime_metrics(mask_path, bin_path, count):
    helper = ROOT / "scripts" / "navgraph_wp63_runtime.mjs"
    try:
        completed = subprocess.run(
            ["node", str(helper), "--mask", str(mask_path), "--bin", str(bin_path),
             "--count", str(count)],
            cwd=ROOT, check=True, capture_output=True, text=True, timeout=180,
        )
        return json.loads(completed.stdout.strip().splitlines()[-1])
    except Exception as exc:
        return {"error": f"runtime benchmark unavailable: {exc}"}


def _build_one(mask_path, region, runtime_count, temp_dir):
    variants = {}
    for label, polygon, prune_region in (
        ("unpruned", region, False), ("polygon_pruned", region, True),
    ):
        start = time.perf_counter()
        artifact = build_navgraph(
            str(mask_path), region_polygon=polygon, prune_region=prune_region)
        elapsed = time.perf_counter() - start
        bin_path = _write_temp_bin(artifact, temp_dir)
        data = bin_path.read_bytes()
        stats = artifact["stats"]
        variants[label] = {
            "buildSecondsWall": round(elapsed, 3),
            "nodes": int(len(artifact["nodes"])),
            "edges": int(len(artifact["edges"])),
            "bin": _encoded_sizes(data),
            "timings": stats.get("timings", {}),
            "regionPrunedFraction": stats.get("region_pruned_fraction"),
            "runtime": _runtime_metrics(mask_path, bin_path, runtime_count),
        }
        bin_path.unlink(missing_ok=True)
    before, after = variants["unpruned"], variants["polygon_pruned"]
    with Image.open(mask_path) as image:
        mask_mpx = round(image.width * image.height / 1e6, 3)
    return {
        "mask": str(mask_path),
        "maskMpx": mask_mpx,
        "region": region,
        "variants": variants,
        "delta": {
            "nodeReductionFraction": round(1 - after["nodes"] / before["nodes"], 4)
            if before["nodes"] else 0,
            "edgeReductionFraction": round(1 - after["edges"] / before["edges"], 4)
            if before["edges"] else 0,
            "binReductionFraction": round(
                1 - after["bin"]["rawBytes"] / before["bin"]["rawBytes"], 4)
            if before["bin"]["rawBytes"] else 0,
            "buildSecondsDelta": round(
                after["buildSecondsWall"] - before["buildSecondsWall"], 3),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--manifest")
    source.add_argument("--auto-select", type=int, metavar="N")
    parser.add_argument(
        "--max-mpx", type=float, default=None,
        help="When auto-selecting, exclude masks larger than this many megapixels.",
    )
    parser.add_argument("--output", default="scratch/wp63-benchmark.json")
    parser.add_argument("--runtime-count", type=int, default=20)
    args = parser.parse_args()

    rows = (_load_manifest(args.manifest) if args.manifest
            else _select_masks(max(1, args.auto_select), args.max_mpx))
    results = []
    output = _path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    def write_partial():
        payload = {
            "workPackage": "6.3",
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "runtime": "local Node, no CPU throttling",
            "complete": len(results) == len(rows),
            "results": results,
        }
        output.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="wp63-", dir=ROOT / "scratch") as temp_dir:
        for index, row in enumerate(rows, start=1):
            print(f"[{index}/{len(rows)}] {row['mask']}", flush=True)
            results.append(_build_one(_path(row["mask"]), row["region"],
                                      args.runtime_count, temp_dir))
            write_partial()
    write_partial()
    print(json.dumps({"output": str(output), "maps": len(results)}, indent=2))


if __name__ == "__main__":
    main()
