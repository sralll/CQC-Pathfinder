# CQC Pathfinder — Memory Cost Reduction Plan (Railway)

> **For executing agents:** work through phases in order; tick checkboxes as tasks complete. Read the Ground rules first. This plan replaces the completed optimization plan (all phases of which were committed to `staging` by 2026-07-03; see git history around `b1edaef`).

## Context

The app runs on Railway as three services: the main Django web service (gunicorn + 4 uvicorn workers, `scripts/start.sh`), a staging DB-mirror cron (`scripts/mirror_prod_to_staging.sh`), and a volume-sync cron (`scripts/sync_volume_r2.sh`, direction=push on prod) that only curls the web service — the actual sync + optional DB backup run **inside the web service** (`CQCPathfinder/internal_views.py` → `sync_volume_to_r2` / `backup_database_to_r2` management commands).

Railway bills GB-hours of the cgroup memory metric, **which counts OS page cache** (documented in `CQCPathfinder/management/commands/sync_volume_to_r2.py:11-21`). The user already halved memory cost by running `--max-requests 50` across 4 workers to contain leaks. Goal: lower steady-state and peak memory further, and remove the need for such aggressive worker recycling by fixing the leak sources instead of masking them.

Audit conclusions (2026-07-03):
- **Stats/results views are efficient** — `results/stats_views.py` uses `values()` row dicts, per-team caching, and additive fit-sums; `results/results_views.py::get_file_results` has a documented sizing check (~1.3k rows max). No action needed.
- **The volume-sync push path is already memory-tuned** (size+mtime comparison, capped TransferConfig, explicit client release + gc). No leak found in the cron trigger path; sidecar curl containers are one-shot and negligible.
- **The real memory hogs:** (a) 4 non-preloaded workers each carrying a full private copy of Django+deps, (b) UNet mask generation allocating a float32 full-map array + several full-map temporaries inside a web worker (onnxruntime arena + glibc fragmentation then keep that worker's RSS elevated — this is almost certainly the "leak" the low max-requests is fighting), (c) the nightly DB backup writing the full pg_dump to a temp file inside the web container (page cache spike).

## Ground rules

- Work on `staging`. No behavior changes: identical JSON responses, identical mask PNG pixel values (verify byte-for-byte or pixel-diff before/after Phase B changes).
- `python manage.py test --noinput` after every backend phase (plain `test` hangs on a stale test-DB prompt).
- Static files are manifest-hashed via servestatic — run `collectstatic` after any CSS/JS edit (none expected in this plan).
- Anything marked **[Railway console]** is a dashboard/env change the human must apply; record what was set in this file.
- Measure before/after: Railway memory graph over ≥24h per change batch; don't stack multiple phases into one deploy window or attribution is lost.

---

## Phase A — start.sh / gunicorn (biggest, cheapest win)

### A.1 Add `--preload`
- [ ] Done

`scripts/start.sh`: add `--preload` so the master imports Django once and workers fork with copy-on-write pages. Today each of the 4 workers holds a fully private interpreter+Django+boto3 image, and every `max-requests` recycle re-imports from scratch (CPU spike + no page sharing). Verified safe for this codebase: the module-level `ThreadPoolExecutor` in `project/views.py:27` spawns threads lazily (master never submits), `UNet.py` job dict is empty at fork, DB connections are lazy, onnxruntime/numpy are imported inside functions. Expect the largest single RSS reduction of this plan.

### A.2 Set `MALLOC_ARENA_MAX=2` **[Railway console]**
- [ ] Done

Env var on the web service. The process is thread-heavy (per-request sync executor, SSE mask threads, boto3 transfer threads, ONNX intra-op threads) and glibc creates up to 8×cores malloc arenas — a classic source of "leaking" RSS that is actually fragmentation. `MALLOC_ARENA_MAX=2` typically cuts steady RSS noticeably at negligible perf cost.

### A.3 Re-evaluate worker count **[Railway console + measurement]**
- [ ] Done

Under ASGI, Django sync views serialize onto one thread per worker, so 4 workers ≈ 4 concurrent sync requests. For the current user base, check Railway's concurrent-request reality (access logs) and try `--workers 2` or `3`. Each dropped worker is a full worker-RSS saving. Keep 4 only if p95 latency degrades.

### A.4 Raise `--max-requests` AFTER Phase B lands
- [ ] Done

Once the mask-generation footprint is fixed (Phase B), raise to `--max-requests 500 --max-requests-jitter 50` and watch the memory graph for a week. The current value of 50 wipes per-worker locmem stats caches constantly (recompute cost) and, combined with `--graceful-timeout 900`, creates old+new worker overlap windows (a recycled worker with a running mask thread stays alive as a 5th process for up to 15 min). Do not raise before B — verify with the graph, not hope.

### Phase A verification
Deploy, then compare Railway memory graph 24h before/after. `railway ssh` (or shell) → `ps -o rss,cmd` to record per-worker RSS with/without preload.

---

## Phase B — UNet mask generation footprint (`project/UNet.py`)

The mask run allocates, for an H×W map (cap 16000×16000): `output_img` float32 (H·W·4 bytes — up to 1 GB at cap), `vis` uint8 H×W×1, two padded bool arrays for dilation, and `np.repeat(vis, 3)` for the final RGB PNG (3× copy). Plus the onnxruntime session arena, which by default does not return freed memory to the OS.

### B.1 Disable the ONNX CPU memory arena + cap intra-op threads
- [ ] Done

`UNet.py:104`: create the session with options —
```python
so = ort.SessionOptions()
so.enable_cpu_mem_arena = False
so.intra_op_num_threads = 2  # Railway shared vCPU; also fewer malloc arenas
ort_session = ort.InferenceSession("best_model_300dpi.onnx", sess_options=so)
```
Arena-off means tile buffers are freed back to the allocator after each run instead of being hoarded until worker death. Benchmark one mask generation before/after (per-tile time is logged already); accept up to ~15% slowdown — this endpoint is rare and background.

### B.2 Shrink the working arrays
- [ ] Done

- `output_img`: values are class indices (0–34) after argmax — use `np.uint8` instead of `float32` (4× smaller; the threshold comparisons at lines 145–153 work unchanged on integers; `tile_pred` cast becomes `.astype(np.uint8)`). Watch the `out.shape[0] > 1` branch: argmax output is integer already; the single-channel branch (`out` float) needs a safe cast — clip/round before uint8.
- Save the final PNG as grayscale (`mode="L"`) instead of `np.repeat(...)` to RGB — **only if** every consumer reads it channel-agnostically. Check consumers first: the editor/pathfinding JS reads mask pixels via canvas (`getImageData` returns RGBA regardless of source PNG mode, values identical) and `preprocess.js` grid building. If any consumer compares per-channel, skip this sub-item and just drop the intermediate: `np.repeat` can be replaced by `Image.fromarray(vis_2d, mode="L").convert("RGB")` done via PIL streaming… simplest safe form: keep RGB output but build it with `np.broadcast_to` (view, no copy) passed through `np.ascontiguousarray` only at save time — measure which variant actually reduces peak.
- Free `img` (the resized PIL RGB, up to H·W·3) explicitly right after the tile loop — it's only needed for `crop()`.

Verification: run mask generation on 2–3 real maps before/after; output PNGs must be pixel-identical (`PIL.ImageChops.difference` all-zero). Peak RSS measured with `tracemalloc` or `/proc/self/status` VmHWM logging around the run.

### B.3 (Gated) subprocess isolation
- [ ] Done / consciously skipped

If, after B.1+B.2 and a week of metrics, mask runs still ratchet worker RSS: move `_run_mask_generation` into a `subprocess` (own Python, line-based progress on stdout parsed into `job.publish`, mirroring the OCAD node-subprocess pattern in `project/ocad_tools/ocad.py`). 100% of the memory returns on exit and `--max-requests` could be raised further or dropped. Skip if B.1/B.2 suffice — it complicates the SSE relay.

---

## Phase C — DB backup page-cache spike (web service)

### C.1 Stream pg_dump → R2 without a temp file
- [ ] Done

`CQCPathfinder/management/commands/backup_database_to_r2.py:81-103` writes the full dump to a temp file (page cache = full DB size, counted by Railway) then uploads. Replace with: `subprocess.Popen(["pg_dump", "--format=custom", ...], stdout=PIPE)` and `client.upload_fileobj(proc.stdout, bucket, key, ExtraArgs=..., Config=_TRANSFER_CONFIG)` — boto3 handles non-seekable streams via multipart, buffering only ~chunksize×concurrency (≤16 MB with the existing config). Check `proc.wait()` returncode after upload and fail loudly (delete the incomplete R2 object) on nonzero. `copy_object` for `latest.dump` is server-side and stays as is. Keep the size log via the multipart response or a `CountingReader` wrapper.

### C.2 (Optional, low value) stream the staging mirror
- [ ] Done / consciously skipped

`scripts/mirror_prod_to_staging.sh:48-67`: `pg_dump -Fc "$PROD_URL" | pg_restore --no-owner --no-acl --dbname="$TARGET_URL"` removes the `/tmp` dump file (custom format from stdin is supported when not using `-j`). This cron bills only while running, so the win is small — do it only if touching the file anyway. Keep the schema-reset step before the pipe.

---

## Phase D — Cache backend (conditional)

### D.1 Check prod cache config **[Railway console]**
- [ ] Done

If `CACHE_URL`/`REDIS_URL` **is** set on prod: a Redis service costs its own memory — evaluate whether the stats cache justifies it; the DatabaseCache below is the frugal alternative.
If it is **not** set: prod falls back to per-worker locmem (`settings.py:160-166`), which is duplicated ×4 workers and wiped every `max-requests` recycle — the team-stats caching (`STATS_TEAM_CACHE_TIMEOUT=600`) barely ever hits.

### D.2 Switch the no-Redis fallback to DatabaseCache
- [ ] Done

`django.core.cache.backends.db.DatabaseCache` with a `createcachetable` step (add to `preDeployCommand` after `migrate`, or a migration-style release note). Shared across workers, survives recycling, zero extra memory. Entries here are small dicts (team stats/fit sums) — DB round-trip cost is fine. Keep the Redis branch untouched.

---

## Phase E — Measurement & wrap-up

- [ ] Record in this file: Railway memory graph averages (web service GB) for: baseline week, post-Phase-A, post-Phase-B/C. Include the `ps` RSS snapshots.
- [ ] After 2 stable weeks at raised `--max-requests`, decide whether `--graceful-timeout 900` is still the right trade (it exists for in-flight mask SSE runs; with B.3 subprocess isolation it could drop to ~60s).

## Explicitly out of scope
- Celery/queue infrastructure (unchanged decision from the previous plan).
- Moving media to R2-served URLs (media is streamed via `FileResponse` — chunked, no full-file buffering; page cache from media reads is real but small at current traffic).
- Changing the ASGI/uvicorn worker class — required by the SSE mask-progress endpoint.
