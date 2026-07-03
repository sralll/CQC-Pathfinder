# CQC Pathfinder — Optimization & Cleanup Plan

> **For executing agents:** work through the phases in the order given under "Suggested execution order & commits" at the bottom. Tick the checkboxes as tasks complete. Read the Ground rules before touching anything.

## Context

The app is functionally complete with no significant known bugs, but has not been optimized for efficiency. The heavy computational parts are (a) editor pathfinding (`project/static/project/js/editor.js` + `pathing/` modules, running in a Web Worker) and (b) infinite-mode map generation + route computation (`results/static/results/js/infinite_play.js` + `infinite/` citygen modules, also worker-based). Infinite mode is about to be linked into the play menu, so its cold-start and per-scene performance will soon be user-facing (including mobile). Additionally, three deprecated Django apps and various dev artifacts remain in the codebase.

Goal: optimize the hot compute paths, clean out dead code, harden the backend, fix one known OCAD renderer bug, and add a superuser debug page for reported infinity scenes.

---

## Ground rules for executing agents

- Work on the `staging` branch. There are uncommitted changes from the infinity-mode port — do not revert or clobber them.
- **Static files are manifest-hashed via servestatic.** After editing any CSS/JS run `python manage.py collectstatic` and restart the dev server or changes won't show.
- **No unintended behavior changes.** JS optimizations must be verified against baselines (per-phase verification). Backend changes must keep identical JSON responses.
- **Infinite-mode determinism policy:** infinite mode is seed-deterministic (`ReportedInfinity` stores `seed`, `pair_index`; the city is regenerated client-side from the seed). There are **no production results yet**, so breaking seed-compatibility is currently ALLOWED — e.g. porting geometry math to `Float32Array` is fine if it wins performance. However: (1) every generation change must be deliberate — run the determinism harness (task 4.0) before/after and re-baseline when output legitimately changes; (2) once infinite mode is live in the play menu and real `ReportedInfinity`/`InfiniteChoice` rows exist, the generator output is frozen — land all generation-changing optimizations BEFORE that launch.
- Editor live previews must reuse SVG nodes — per-frame DOM add/remove triggers password-manager (Bitwarden) lag.
- The existing tests are valuable — keep them green: `project/tests.py` (auth surface + cross-team editor security), `results/tests.py` (stats math unit tests + submission/stats authorization). Run `python manage.py test` after every backend phase. When a phase touches secured endpoints, add matching tests in the same style (see per-phase notes).

---

## Phase 1 — Dead code & artifact cleanup (low risk, do first)

### 1.1 Remove the three deprecated apps: `accounts`, `coursesetter`, `play`
- [ ] Done

User confirmed these are dead (kept only for a past data migration, now complete) and approved **full removal including dropping DB tables**. Cross-references: `coursesetter/models.py:10` and `play/models.py:18` reference `accounts.Kader` by string.

Safe removal order (tables must be dropped by migration before the code disappears):
1. Empty `models.py` in all three apps (delete all model classes; keep the files).
2. `python manage.py makemigrations accounts coursesetter play` — Django generates `DeleteModel` migrations and handles the cross-app FK ordering.
3. Verify with `python manage.py migrate --plan`, then `migrate` locally/staging.
4. Commit. **Prod must deploy this commit once (preDeploy runs migrate) before the follow-up commit that deletes the app directories.**
5. Follow-up commit: delete the three app directories, remove the three entries from `INSTALLED_APPS` in `CQCPathfinder/settings.py` (~lines 39–54).

### 1.2 Update the prod→staging DB mirror script
- [ ] Done

`scripts/mirror_prod_to_staging.sh:69-81` runs `manage.py migrate` after restoring the prod dump. Per user: prod now has the account-migration in place, so the nightly mirror should be a **plain copy — no migration run**. Flip the default at line 69 from `:-true` to `:-false` (keep the `RUN_DJANGO_MIGRATIONS_AFTER_RESTORE` env override). ⚠️ Caveat to document in the script comment: while staging code carries migrations not yet deployed to prod (e.g. Phase 1.1 / 2.1 of this plan), the nightly mirror will restore a schema that's behind staging's code — either temporarily set the env var to `true` on the Railway CRON service or redeploy staging after the mirror (preDeploy migrate) during that window.

### 1.3 Settings cleanup
- [ ] Done

Remove commented-out `admin_reorder` lines: `settings.py:53-54` (INSTALLED_APPS), `:74` (MIDDLEWARE), and the unused `ADMIN_REORDER` config block (~lines 77–97).

### 1.4 File artifacts
- [ ] Done

- Delete `media/maps/debug_ocad_upload_test.png` (1.3 MB debug upload).
- Delete `docs/debug/infinite-CONTRACTS.md` and `docs/debug/infinite-REFERENCE_NOTES.md` (user is done developing this mode; notes no longer needed).
- Orphaned compiled assets in `staticfiles/`: `staticfiles/results/css/random_play.*` and `staticfiles/results/js/random_play.*` (+ hashed/.gz variants) have no source files and no references. Delete if git-tracked; run `collectstatic --clear` to regenerate clean output (also clears stale `staticfiles/results/infinite/test.html`).

### 1.5 requirements.txt pruning (verify each before removing)
- [ ] Done

Likely-unused (grep for imports before deleting each): `yarg`, `django-storages` (not configured in settings; R2 sync uses boto3 directly), and the "transitive leftovers" blocks (~lines 38–50). Remove only entries that aren't transitive deps of kept packages; verify with a clean venv: `pip install -r requirements.txt` then `python manage.py check` + smoke-run.

### Phase 1 verification
`python manage.py check`, `python manage.py test`, `migrate --plan` clean, app boots, admin/editor/play/stats pages load.

---

## Phase 2 — Backend quick wins

### 2.1 Database indexes (approved; migrations required)
- [ ] Done

- `project/models.py` `File`: queries filter by `team` + `deleted` and order by `-last_edited` (`project/views.py:144-161`) — add a composite `models.Index(fields=['team', 'deleted', '-last_edited'])` to `File.Meta.indexes`. Add plain `db_index=True` on `last_edited` only if other query paths order on it without the team filter.
- `account/models.py:21` `Profile.active_team`: FKs get an index automatically in Django — **verify via `sqlmigrate`/DB inspection first**; likely a false positive from exploration. Only act if genuinely missing.
- `makemigrations`, review with `sqlmigrate`, migrate.

### 2.2 N+1 fixes
- [ ] Done

- `account/views.py:109` (`forum_thread`): `thread.upvotes.count()` — annotate the queryset (`Count('upvotes', distinct=True)`) reusing the pattern from `forum_index` at `account/views.py:67-69`. The single post-write counts in the vote endpoints (`:127`, `:141`) are acceptable; fix only if trivial.
- `results/stats_views.py:578-599` (`_cached_team_error_potential_fit`): replace the two-step "fetch member user IDs as list, then filter" with an unevaluated subquery (`user_id__in=User.objects.filter(...)`).
- `results/stats_views.py:709-724` (`get_user_stats`): `_min_time_per_cp()`, `_route_runtime_stats_for_cp()`, `_choice_time_benchmarks_per_cp()` each query separately over the same `cp_ids`. Consolidate where the aggregations can share a pass; response JSON must stay identical (the stats unit tests in `results/tests.py:22-137` guard the math — keep them passing).

### 2.3 Unbounded result loading (assess, then fix if warranted)
- [ ] Done

`results/results_views.py:~136` (`get_file_results`) loads all choices for a file with no limit. Measure realistic sizes first (CPs × athletes for the largest team); if payloads can exceed a few thousand rows, add limit/offset params and update `results/static/results/js/file_results.js`. If sizes are small in practice, document that and skip.

### Phase 2 verification
`python manage.py test`; diff JSON responses of forum/stats/results endpoints before/after (identical); add `assertNumQueries` tests to lock in the improved query counts.

---

## Phase 3 — Editor pathfinding JS optimizations

Files under `project/static/project/js/pathing/` unless noted. The pipeline already uses a Web Worker, typed arrays (`Float32Array` gScore, `Int32Array` parent, `Uint8Array` grid/closed), and a binary min-heap — the architecture is sound; these are targeted hot-loop fixes.

### 3.0 Behavior baseline (do first)
- [ ] Done

Run auto-pathfind on a known file and capture the produced route polylines (temporary debug flag logging JSON of waypoints per CP from `pipeline.js`). After each change, re-run with identical inputs and diff. A*/θ* are deterministic given the same grid, so output must be identical unless a change intentionally alters simplification. Also wrap `runPipeline` stages in `performance.now()` timings and record before/after numbers.

### 3.1 `simplify.js:125+` — `simplifyAStarSameTerrainPath` backward-scan
- [ ] Done

Scans backwards from the goal (`j = n-1` down to `i`) for every output point → worst-case O(path²) with a Bresenham LOS+terrain check per step. Fix: galloping start — track the previous successful jump length and begin the scan near `i + lastJump*2` instead of `n-1`, falling back to the full scan if needed so the selected `j` (furthest LOS) is unchanged. The sibling `simplifyAStarPath` (`simplify.js:81-118`) has the same pattern — check callers first (its header says it's a kept-around candidate and may not be on the hot path).

### 3.2 θ* LOS cache — `theta_star.js:62-74` + `worker.js`
- [ ] Done

`losCache` is per-request; LOS results depend on the per-request subgrid (margin cropping + corridor mask), so a naive persistent cache is wrong. **Profile first** — only if LOS checks dominate, consider a flat keying scheme or full-grid-coordinate cache restricted to corridor-independent checks.

### 3.3 `pipeline.js:108-137` — margin-growth retry loop
- [ ] Done

Each failed A* attempt re-extracts the subgrid and re-runs A* at a larger margin. Improvements: start margin at a heuristic based on straight-line start→ziel distance (e.g. `max(100px, 0.5 * dist)`); reuse `gScore`/`parent`/`closed` allocations across attempts (allocate once at max expected size).

### 3.4 `preprocess.js:39-63` — scanline polygon fill
- [ ] Done

Per-y sort of x-intersections. Replace with edge-table + active-edge-list scanline. Only matters for large blocked areas on big maps — measure with a 3000×2000 mask + complex polygon first; skip if fill time is <10 ms.

### 3.5 `distinct.js` — route distinctness check
- [ ] Done

O(routes² × waypoints) but max 4 routes per CP — likely cheap in absolute terms. **Profile before optimizing**; if hot, spatial-hash existing routes' waypoints once per CP.

### 3.6 `editor.js` — RAF consolidation (optional, lowest priority)
- [ ] Done

Six `requestAnimationFrame` call sites (~lines 1775, 1922, 3127, 4195-4198, 6252, 7269-7272). Only consolidate if frame profiling shows overlapping RAF work; respect the no-DOM-churn rule.

### Phase 3 verification
Baseline route diff identical (or intentional changes documented); stage timings recorded before/after; `collectstatic` + manual editor session (drag CPs, auto-pathfind full file, draw blocked terrain).

---

## Phase 4 — Infinite mode: debug page + citygen/route optimizations

Files: `results/static/results/js/infinite_play.js` (3,768 lines), `results/static/results/js/infinite/infinite_batch_worker.js` (521 lines), `results/static/results/js/infinite/citygen/core/{CityGen,Voronoi,Random,Noise}.js`.

### 4.0 NEW FEATURE (user-requested): superuser debug page at `/debug/infinity`
- [ ] Done

A permanent, hidden page (no nav buttons anywhere) for inspecting `ReportedInfinity` reports (`results/models.py:76-112`: stores `seed`, `pair_index`, `start_x/y`, `goal_x/y`, `routes` JSON, `route_indexes`, `settings`, `client_state`).

- **Access:** superuser only — `@user_passes_test(lambda u: u.is_superuser)` (LoginRequiredMiddleware already forces auth; return 404 or 403 for non-superusers).
- **Backend:** new `results/debug_views.py` + URL `debug/infinity/` wired in `CQCPathfinder/urls.py`; JSON endpoints: (a) list reports (id, user, team, timestamp, seed, pair_index — newest first, simple limit), (b) report detail (full JSON fields).
- **Frontend:** template `results/templates/results/debug_infinity.html` + JS. Reuse the existing citygen modules/worker to regenerate the city from the stored `seed` (check how `infinite_play.js` drives `infinite_batch_worker.js`; add a targeted "generate single scene for seed/pair_index" worker message if the batch protocol doesn't support it). Draw the map SVG using the same layer-building code as `infinite_play.js` (`getLayerElements`) where reusable, plus the routes of the reported control pair from the stored `routes` JSON and start/goal markers from stored coords.
- **UI requirements:** report selector (list → click to load); **no camera animation** — static view; **zoomable** (wheel zoom + drag pan via SVG viewBox manipulation); **toggle button to show/hide the routes layer**.
- **Determinism harness lives here too:** add a "determinism check" button that, for a fixed list of ~20 seeds, runs generation in the worker and prints a hash of the serialized scene output (city geometry + route choices + NoA/runtime values). Record baseline hashes in `docs/debug/infinite-determinism-baseline.txt`. Re-run after every citygen change; re-baseline deliberately when output legitimately changes (allowed pre-launch, see ground rules). Note on the page: reports created under an older generator version may not reproduce their city after generation changes.
- Add a small test in `results/tests.py`: non-superuser gets 403/404 on the page and both endpoints (follow the existing security-test style).

### 4.1 `Voronoi.js:~114` — point location in Bowyer–Watson insertion
- [ ] Done

`addPoint(p)` scans ALL triangles for the circumcircle test → O(n²) total; the single biggest citygen cost. Fix options in order of safety: (1) circumcircle bounding-box prefilter per triangle — pure lookup acceleration, zero output change; (2) walk-based point location starting from the last insertion. Preserve iteration order when collecting "bad" triangles so serialized output is unchanged (verify with harness).

### 4.2 `Voronoi.js:166-172` — full region-map rebuild on dirty
- [ ] Done

`.regions` rebuilds the whole Map whenever `_regionsDirty`. Check call sites in `CityGen.js`: defer the rebuild until insertion batches complete, or update incrementally for affected points only.

### 4.3 Time-to-first-scene: stream scene generation
- [ ] Done

`infinite_play.js:~70-71`: `CITY_SCENE_ATTEMPTS = 12`, `CITY_ROUTE_RETRIES = 240` — the worker generates the full batch before the player sees anything. Change the worker protocol to post each accepted scene as ready (`{type:'scene', index, scene}`) + final `{type:'batch_done'}`; start play once scene 0 arrives, fill the rest in the background. No generation-math changes. Directly improves the play-menu entry experience. Keep the existing `_renderCache` idle pre-render (`infinite_play.js:2097-2118`).

### 4.4 Route-retry cost in the worker
- [ ] Done

`infinite_batch_worker.js`: up to 240 route retries per scene. Profile which computations are invariant across retries within one scene (city geometry is; routes vary) and hoist them out of the retry loop. If hoisting changes RNG draw order, that's a generation change — harness + deliberate re-baseline.

### 4.5 Typed-array port for geometry (optional, profiler-gated)
- [ ] Done

Plain `{x,y}` objects for thousands of points cause GC churn. If allocation profiling shows GC pauses during generation, port hot geometry to flat typed arrays. **User has approved Float32Array** (no production results yet, so seed-output changes are acceptable — re-baseline the harness). Prefer 4.1/4.3 first; they may make this unnecessary.

### 4.6 Rendering check
- [ ] Done

SVG layers are cached per scene. Verify with DevTools that scene transitions (camera lerp, `infinite_play.js:2240-2293`) hold 60fps on a mid-range/mobile device after the other changes. No DOM churn.

### Phase 4 verification
Debug page: superuser can list reports, load one, see map + routes, zoom/pan, toggle routes; non-superuser blocked (test in `results/tests.py`). Harness hashes stable across pure-lookup changes (4.1 option 1, 4.2, 4.3); re-baselined deliberately for generation changes (4.4 RNG shifts, 4.5). Record time-to-first-scene and total batch time before/after. `collectstatic`; manual playthrough of ~10 scenes.

---

## Phase 5 — OCAD: renderer bug fix + async conversion

### 5.1 BUG FIX (user-reported): point objects ignored by the map renderer
- [ ] Done

Some OCAD point objects don't appear in the rendered map PNG. The object categorization was tightened to keep labels out and now excludes too much. Where to look: `project/ocad_tools/convert_ocad.js` — `makeRenderableObjectFilter` (lines 151–159: drops course-display syms, "actual route" objects, and any object whose symbol `status != 0`) and `COURSE_DISPLAY_EXCLUDED_SYMS` (lines 28–41).

Task: **widen the categorization — render basically everything except labels/text.** Approach:
1. Diagnose: with a sample file, log excluded objects grouped by symbol number, symbol `type`, and `status` to see exactly which point symbols get dropped and by which condition.
2. Rework the filter to exclusion-by-kind: drop text/label objects (OCAD symbol type for text — verify the type constant against the `ocad2geojson` package docs/source in `node_modules`) and the course-overprint symbols (control numbers 704000/704001, course title/description 720000/721000, etc. — keep the existing set), but stop dropping non-text objects on other grounds (e.g. reconsider the blanket `status != 0` exclusion — check what statuses the missing point objects carry; genuinely hidden symbols should presumably stay hidden).
3. **Test files: the user has OCAD files in `C:\Users\larsb\Downloads`** (glob for `*.ocd` there). Convert before/after and compare rendered PNGs — missing point objects appear, no label/text objects appear.

### 5.2 Async OCAD/UNet conversion (approved scope)
- [ ] Done

`project/views.py:~1028-1070` runs `convert_ocad_map_to_editor_assets()` (node/resvg subprocess via `project/ocad_tools/ocad.py`, 180 s timeout + ONNX UNet mask inference in `project/UNet.py`) synchronously inside the upload request — can hit gunicorn timeouts and blocks a worker.

Approach — no new infrastructure (no Celery; Railway single service):
1. Module-level `concurrent.futures.ThreadPoolExecutor(max_workers=1)` singleton — serializing conversions avoids memory spikes from concurrent UNet sessions; subprocess + ONNX release the GIL.
2. Reuse the existing progress pattern: `File.batch_progress` JSONField (`project/models.py:30`) — check how the editor already polls it (search `batch_progress` in `project/views.py` and `editor.js`) and reuse that endpoint/mechanism for conversion status (`pending → converting → done/failed` + error message).
3. Upload view returns immediately (202-style JSON); `editor.js` polls until done, then loads the map/mask.
4. Robustness: try/except that always writes a terminal status; on poll, treat "converting" states older than N minutes as failed (thread dies on dyno restart — acceptable at this scale; Celery is the upgrade path if it ever isn't; document this in a code comment).
5. Add a test: upload endpoint returns immediately and status endpoint transitions (mock the converter).

### Phase 5 verification
5.1: convert the Downloads OCAD files; previously-missing point objects render; labels don't. 5.2: upload a real OCAD file on the preview server — response immediate, progress advances, mask appears; corrupt file → `failed` status with message shown in UI; `python manage.py test`.

---

## Suggested execution order & commits

1. Phase 1 (cleanup + mirror script) — 2 commits: (a) model-deletion migrations, (b) app/file removal + settings + requirements + mirror script.
2. Phase 2 (backend) — 1–2 commits.
3. Phase 4.0 + 4.3 (debug page + determinism harness + scene streaming) — early, since infinite mode ships to the play menu soon and generation-changing work must land before launch.
4. Phase 4.1/4.2/4.4/4.5 (citygen) and Phase 3 (editor pathing) — profile-first items, separate commits per optimization with timings in the commit message.
5. Phase 5 (OCAD fix + async upload) — 5.1 is independent and can land anytime; 5.2 last, most invasive backend change.

## Explicitly out of scope (user decision)
- Migrating Python stats aggregation to PostgreSQL window functions (stats are cached; revisit if stats pages get slow).
- Celery/queue infrastructure.
- `home_infinity.js` particle animation (capped at 128 particles, RAF + reduced-motion aware — not a bottleneck).
- Console/print logging cleanup — audited; all intentional error handling or profiling.
