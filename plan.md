# Infinity mode on real (user-uploaded) masks — feasibility + implementation plan

## Context

Goal: run the infinite-play experience (random control pairs, 4 candidate routes, runtime-gap/side-split rejection, ~1 valid pair every 2 s average) on real uploaded map masks instead of generated cities, with pathfinding staying in frontend JS and working on phones. Today a single route on a real mask takes 645–1060 ms on a strong laptop (dominated by full-res weighted A*: 400–850 ms), and one attempt needs up to 4 routes with up to ~30 retries — a ~20–40× gap to close.

## Empirical findings (measured 2026-07-04)

- **254 masks**, median 8.6 Mpx, mean 13.3 Mpx, max 75 Mpx (8561×8784); 33 masks > 20 Mpx.
- Masks are 8-bit terrain-class grids (0 = impassable; 135/200/231/241/242/243 new scheme, 100/150/200/230 old). A* cost = `dist × (255 − value)` ([astar.js:84](project/static/project/js/pathing/astar.js)).
- **Structure is favorable**: every sampled mask has one dominant free component (92–99.7 % of free space). Worst mask has ~10 k impassable components, but many are small compact objects (trees, fountains) that per Lars **may be ignored for route topology** — long thin features (walls, fences, incl. *passable* dark-grey ones) must be kept, they drive route choice.
- **Coarse A* benchmark (Node, typed arrays, weighted, 8-connected)** on the worst 75 Mpx mask at ¼ res (4.7 M cells): **median 36 ms, max 235 ms**; median map is ~9× smaller. Phones ≈ 2–4× slower.
- **Pair prefilter**: 88–99 % of random in-component pairs (500–1500 px apart) cross a substantial obstacle on the straight line; raycast test ~0.1 ms.
- City-generator reference (route-stress CSV, 900 runs): mean 2.9 retries/pair, 93 ms/attempt, 366 ms until valid pair; rejections dominated by `side` (2503 of ~2590).
- `media/masks/*.navgraph.npz` (~19 files) — abandoned sparse-navgraph experiment (nodes, weighted edges, component ids, `min_cost_per_px`); no code remains. Searching a ~1 k-node graph is sub-ms.

## Verdict (the five questions)

1. **Feasible.** Navgraph search per attempt: few ms even on phones; full-res refinement (~150–400 ms) runs once per accepted pair, outside the retry loop. 2 s average with a prefetch buffer has ample headroom.
2. **Precompute: modest, one-off, at upload in the editor pipeline** (per Lars). Navgraph + sampling metadata; seconds-to-a-minute per map in Python; backfill command for existing masks.
3. **Robust on urban sprint maps; gate weak masks via coach opt-in** + automated suitability report (simulated pair-generation stats). Direct UNet-quality scoring vs the map image is not reliably computable; entropy-based proxies can be added later.
4. **Effort: ~8–15 focused sessions** (see phases below).
5. **Keep random+reject as final gate; add ~0.1 ms prefilters** (component, clearance, terrain, distance band, obstacle-crossing raycast). Barrier-forced routes 3/4 port to blocking navgraph edges.

## Architecture

### Role of the navgraph vs. the existing pipeline

The navgraph replaces **exactly one stage** of the proven theta-client pipeline: the margin-growth full-map A* (the 400–850 ms `a_star` stage). The graph path is the waypoint chain feeding the *unchanged* corridor + guided theta* stages. Theta* is still required: (a) graph paths zigzag node-to-node, theta* gives natural any-angle polylines; (b) edge weights are build-time approximations, scoring needs exact full-res terrain-weighted runtimes; (c) theta* moves only inside a full-res passable corridor → final legality guarantee regardless of graph approximation.

### Navgraph build — free-space skeleton, not obstacle polygonization

Polygonizing black pixels = visibility graph = uniform-cost assumption → would ignore terrain weights (only OK in the city mode because generated cities are uniform-cost). Instead:

1. **Blob prefilter (topology only)**: remove impassable/very-slow components that are small AND compact (roundish: `area < T_area` and low elongation, e.g. area/(bbox or perimeter²) test) — trees, fountains. Keep elongated features regardless of size (thin walls/fences, incl. passable dark-grey ones). Filter applies **only** to the graph/skeleton build; full-res refinement uses the true mask, so nothing illegal can result.
2. Distance transform + medial-axis skeleton of (filtered) passable space **at full resolution** → nodes at junctions, sampled along corridors, at terrain-class boundaries, plus sparse lattice over large open areas. Narrow alleys survive — a 3-px passage is a skeleton branch. (Fallback v1: pruned uniform node lattice every ~32–64 px.)
3. Edges between skeleton-adjacent / mutually-near nodes; **weight = actual full-res weighted A\* cost** on a small subgrid (same `dist × (255 − value)` model, unfiltered mask); drop edges whose detour ≫ straight distance. Terrain respected twice: node placement + measured edge costs.

### Map region (hit zone) — coach-drawn polygon

A mask is a full rectangle but the map fills only part of it; the surrounding margin (white
paper, title banner, sponsor logos, scale text) is classified as ordinary open/fast terrain
and is **indistinguishable from real open ground by pixel value**. Random endpoints placed
there would be off-map and rejected en masse. Automatic detection (class-boundary density —
see the WP 1.1 refinement note) is too fragile to trust across the map variety, so the
**authoritative** map region is a **polygon a coach draws in the editor** (WP 4.1). It is
stored on the map's model, rasterized into the navgraph artifact's `coarse_hitzone` at build
time, and is the region within which route **endpoints** are sampled. The automatic detector
remains as a fallback for un-annotated masks and to pre-fill the editor polygon as an initial
suggestion. The region gates endpoint *placement*, not graph topology — the graph keeps
nodes everywhere so island-type maps (only linked across the open margin) stay connected.

### Client flow (scene source inside infinite_play, per Lars)

Per attempt: sample pair with prefilters → snap endpoints to graph (bucketed lookup + tiny local full-res A* stubs) → graph A* → alternates 2–4 via `findSmartBarrier` port blocking crossed graph edges → existing selection (runtime gap ≤ 0.5, side split; graph cost = runtime, no NoA needed). For the accepted pair only: corridor + guided theta* at full res, re-check gap, serve. Prefetch buffer generates pairs in the worker while the user plays.

Reused as-is: `astar.js`, `theta_star.js`, `corridor.js`, `simplify.js`, `preprocess.js` (blocked-terrain overlay = barrier mechanism), `worker.js` caching. Selection logic: [infinite_play.js](results/static/results/js/infinite_play.js) `selectRuntimeRouteOptions` (~line 1674); barrier logic: [RoutePlanner.js:71](results/static/results/js/infinite/citygen/core/RoutePlanner.js) `findSmartBarrier`.

### Memory (phones)

Client holds navgraph (<1 MB) + coarse sampling grid (median ~0.5 MB); full-res mask decoded lazily only for refinement subgrids (median 8.6 MB — fine). 75 Mpx outliers gated by opt-in initially; tiled refinement later if needed.

---

# Implementation phases — work packages for execution

Each package is self-contained with acceptance criteria. "Model" = suggested agent capability (Opus = complex/algorithmic, Sonnet = well-specified/simpler). Execute in order; packages within a phase can sometimes parallelize (noted).

## Phase 1 — Server-side navgraph builder (Python) — ✅ DONE (2026-07-04)

Implemented: `project/navgraph.py` (WP 1.1), `project/management/commands/build_navgraph.py`
(WP 1.2), `scripts/navgraph_debug.py` (WP 1.3). All acceptance criteria met on 5+
validated masks (1.7 → 75 Mpx, old & new schemes): build < 60 s each, main-component
graph connectivity ≥ 0.95, zero nodes on impassable pixels, `.navgraph.bin` round-trips.
`scipy` + `scikit-image` added to `requirements.txt`.

Deviations from the original spec, forced by measured performance (documented in the
`navgraph.py` module docstring):
- Full-res `skeletonize` was ~224 s / 94 k junctions on the 75 Mpx mask → the **skeleton
  stage runs on an adaptively block-downsampled passability grid**; mask, EDT, labels,
  edge A* and sampling grids stay full-resolution (legality/weights exact).
- Edge weighting uses a **straight-line cost integral fast-path with A* fallback only for
  the skeleton backbone** (per-edge A* everywhere was too slow); k-NN shortcuts whose
  straight line is blocked are dropped, and a **connectivity-repair pass** bridges
  fragments that share a free-space component.
- Detour rejection compares geometric path length (not weighted cost) to straight
  distance, so genuinely slow terrain isn't wrongly dropped.

⚠ **Open item for Phase 3:** the ÷4 `coarse_labels` (int32) grid makes the `.bin` ~28 MB
on the 75 Mpx map (~3 MB on median) — contradicts the "<1 MB client artifact" goal.
Fine server-side; Phase 3 should ship a compacter sampling grid (main-component bit +
uint8 clearance) or the deferred tiling.

⏳ **WP 1.3 checkpoint pending:** Lars to review the `.navgraph.debug.png` overlays in
`media/masks/` before relying on the graphs.

### Refinements (2026-07-05, Lars-directed) — supersede parts of WP 1.1/1.3 below
- **Blob prefilter removed.** It filtered almost nothing and modified topology; the graph
  now builds directly on the true free space (steps 2–3 below no longer apply).
- **Map region is coach-drawn (authoritative); automatic detection is only a fallback.**
  Auto hit-zone detection proved too fragile across the map variety (decorated margins,
  sparse maps, banners/logos indistinguishable from open ground by value). The relevant map
  region will be a **polygon a coach draws in the editor** (see new **WP 4.1**). *Phase-1
  prep implemented now:* `build_navgraph(mask_path, region_polygon=...)` rasterizes the
  polygon (`_rasterize_region`) into the stored ÷16 `coarse_hitzone` and confines the
  open-area lattice to it; `stats.hitzone_source` = `polygon`|`auto`, `stats.region_polygon`
  records the vertices. When no polygon is set it falls back to automatic detection so
  existing masks still build. Artifact `version` → 2; `.bin`/`.npz` gain `hitzone_scale` +
  `coarse_hitzone`.
- **Automatic `_hitzone` kept as fallback + editor seed.** Class-boundary density on a
  coarse grid (a real map changes class often over short distances; a margin/logo/big field
  is one class over a large area) yields a **footprint** (map body) and a **sample** mask
  (the ÷16 `coarse_hitzone`). The editor pre-fills the coach polygon from this suggestion
  so drawing is a quick correction, not from scratch.
- **Hit zone gates endpoints, not topology.** Hard-pruning off-map nodes dropped
  connectivity to ~0.85 (island-type maps are only linked *across* the open margin), so the
  graph is **not** pruned. Only the dense open-area **lattice is confined to the region**
  (the sparse skeleton still spans the margin for connectivity). Boring uniform fields stay
  crossable but are never sampled as endpoints. Preventing routes from *traversing* the
  margin is deferred (it would disconnect some maps).
- **Denser, more uniform open-field lattice** (`OPEN_CLEARANCE_PX` 40→24,
  `LATTICE_SPACING_PX` 64→40) so plazas/fields get straight crossings instead of skeleton
  corner-bends. ~1.5–2× nodes inside the region.
- Re-validated on 7 size-varied masks (0.3–75 Mpx incl. decorated Monopoli): build < 60 s,
  main-component connectivity ≥ 0.95 (min 0.953 @ 75 Mpx), zero nodes on impassable, v2
  `.bin` round-trips. Debug overlay tints red = off-map, yellow = in-map-but-boring.

### WP 1.1 — `project/navgraph.py` core builder — **Opus** — ✅ DONE
Create `project/navgraph.py` with a function `build_navgraph(mask_path) -> artifact dict` implementing:
1. Load mask PNG → `np.uint8` grayscale (values as in [UNet.py](project/UNet.py) `mo` namespace; support old scheme 100/150/200/230 too — derive "impassable"=0, everything else passable with weight).
2. Blob prefilter (see Architecture): label impassable components (8-conn, `scipy.ndimage.label`); drop components with `area < T_area` (start T_area ≈ 200 px) AND elongation below threshold (e.g. `max(bbox_w,bbox_h)² / area < 8` keeps thin walls). Make thresholds module constants. Produce `topo_mask` (filtered) alongside the true mask.
3. `scipy.ndimage.distance_transform_edt` on `topo_mask` passable space; skeleton via `skimage.morphology.skeletonize` (add scikit-image to requirements if absent — check first; if adding a dep is undesirable, implement thinning via scipy or use the lattice fallback in WP 1.5).
4. Node extraction: skeleton junction pixels (≥3 skeleton neighbors) + endpoints; resample long skeleton segments every ~48 px; add nodes where terrain class changes along the skeleton; add sparse lattice nodes (~every 64 px) in large open regions (distance transform > ~40 px) so plazas are crossable diagonally.
5. Edges: connect nodes adjacent along the skeleton; plus k-nearest (k≈6, within ~120 px) candidates. For each edge run full-res weighted A* (cost `dist × (255 − value)`, **unfiltered** mask) on the bounding subgrid + margin; store cost; drop edge if no path or cost > ~3× straight-line × min_cost.
6. Output arrays: `nodes (N,2 int32)`, `edges (E,2 int32)`, `weights (E float32)`, `components (N int32)` (free-space component id per node, from the *unfiltered* mask labels), `min_cost_per_px`, `mask_shape`, `version`.
7. Sampling metadata: ÷4 min-pooled passability grid (uint8: 0 or min terrain value), ÷4 labels of the unfiltered free space, ÷4 clearance grid (uint8, capped 255) from the distance transform, per-map stats (main-component fraction, free fraction, node/edge counts).
8. Serialize: `.navgraph.npz` next to the mask (server/debug) **and** a compact little-endian binary (or gzipped JSON) `.navgraph.bin` for JS consumption — document the byte layout in a docstring.

Acceptance: builds on 5 sample masks incl. `mask_20260422_134232.png` (75 Mpx) in < 60 s each; graph on main component is connected (single graph-component covering ≥ 95 % of nodes whose free-space component is the main one); README-style docstring at top of module.

### WP 1.2 — Management command + backfill — **Sonnet** — ✅ DONE
`project/management/commands/build_navgraph.py`: args `--file <mask path or File id>`, `--all` (iterate masks in `media/masks/`), `--force`; skip if artifact newer than mask; print per-map timing + node/edge counts; `--limit N` for testing. Follow existing management-command style in the repo (see `account/management/` and `results/management/`).
Acceptance: `python manage.py build_navgraph --limit 5` produces artifacts; re-run skips them; `--force` rebuilds.
**Follow-up (with WP 4.1):** once the map region field exists, the command must load it and pass `region_polygon=` to `build_navgraph`, and treat a region edit as a reason to rebuild (region is part of the skip/`--force` staleness check). Until then it builds with automatic detection.

### WP 1.3 — Debug overlay visualizer — **Sonnet** — ✅ DONE (Lars review pending)
Script `scripts/navgraph_debug.py`: renders mask (dimmed) + nodes/edges (colored by weight/px) + filtered blobs highlighted, saves PNG next to artifact (`.navgraph.debug.png`). Optionally a `--pair y1,x1,y2,x2` flag drawing the graph A* path.
Acceptance: overlays generated for 8–10 varied staging masks (small/large, old/new scheme); visually: alleys have edges, trees filtered, thin walls respected. **Lars reviews these overlays — checkpoint.**

## Phase 2 — Headless validation harness (Node) — go/no-go gate

### WP 2.1 — Node harness implementing the client algorithm — **Opus** — ✅ DONE (2026-07-05)
`scripts/navgraph_harness.mjs` implements the full pipeline as importable functions
(reused by Phase 3) + a CLI. Mask decode via `sharp` (already a dep — no `pngjs`
added). Validated end-to-end on 3 size-varied v2 masks (1.7 / 8 / 75 Mpx): CSV +
PNG spot-checks produced, zero legality violations, rendered pairs show clean
left/right route splits. Note: the harness requires **v2** `.navgraph.bin`
artifacts (with `coarse_hitzone`) and rejects v1 with a rebuild hint.

Script `scripts/navgraph_harness.mjs` (Node, no browser). Loads `.navgraph.bin` + coarse grids + full-res mask (add `pngjs` as devDependency or decode via a small Python-exported raw file). Implements, as importable functions (they will be reused in Phase 3):
1. Pair sampling + prefilters: uniform over main-component coarse cells **restricted to the `coarse_hitzone`** (the coach-drawn region, or the automatic fallback) with clearance ≥ ~3 (coarse px) and terrain not very_slow; distance band (mirror ROUTE_PICK_MIN/MAX_DIST=40/120 map-units scaled to px via map scale — start with 500–1500 px, tune later); straight-line raycast must cross an impassable component with area above threshold. (The hit zone replaces the old fixed "map-edge margin ~100 px" — the polygon defines the true boundary.)
2. Endpoint snapping: bucket grid over nodes; connect endpoint to ≤3 nearest nodes with local full-res weighted A* on a ~200 px subgrid.
3. Graph A* (binary heap, heuristic = euclid × min_cost_per_px).
4. Alternates: port `findSmartBarrier` semantics from [RoutePlanner.js:71](results/static/results/js/infinite/citygen/core/RoutePlanner.js) — find perpendicular barrier near route midpoint, temporarily remove graph edges crossing it, re-run A*; up to 4 routes total.
5. Selection: port `selectRuntimeRouteOptions` criteria from [infinite_play.js](results/static/results/js/infinite_play.js) (~1674): runtime gap ≤ 0.5 using graph cost as runtime, sideGap ≥ 10 equivalent (scale to px), opposite signs, routeside check.
6. CSV output matching the route-stress format (retries, per-attempt ms, rejection reasons, route lengths/sides) + optional SVG/PNG dump of accepted pairs for spot-checks.
Acceptance: runs end-to-end on 3 masks, produces CSV + a handful of rendered pairs.

### WP 2.2 — Batch run + analysis — **Sonnet** — ✅ DONE (2026-07-05) — **GO**
Batch driver `scripts/navgraph_batch.mjs`; summary `scratch/wp2_2_summary.md`. Built
26 v2 artifacts (33 total) and ran 33 masks (0.26–75 Mpx; 100 pairs, largest 4 maps
reduced to 30–50). Result: **zero legality violations** across all 2,980 accepted
pairs / 5,960 refined routes; gate (mean retries ≤ 5 AND mean ms/valid ≤ 1 s) met on
**30/33 maps (90.9 % ≥ 70 %)**; aggregate mean-of-mean retries 3.42, mean ms/valid
2.5 (laptop Node). `side` dominates rejections (30.6 %), as expected from the city-gen
reference. The 3 gate misses are explainable outliers, not harness bugs:
`mask_20260612_091525` (0.26 Mpx, diagonal 719 px < the 500–1500 band → all `distance`
rejects), and two large obstacle-dense maps (`_20260604_191144` 46.8 % impassable;
`_20260421_092111` 50 Mpx, `unreachable`-heavy). Tuning of `sideGapMinPx` / distance
band / `obstacleMinRunPx` deferred to Phase 6 (no algorithm changes made). ⚠ Lars
review of the go/no-go summary is the gate before Phase 3.

Run harness on ≥ 20 staging masks × 100 pairs. Summarize per map: valid-pair rate, mean/median/p90 retries, mean ms/valid pair, rejection breakdown. Assert **zero route segments crossing impassable pixels of the true mask** (sample points along polylines). Write summary markdown to `docs/` or scratch for review.
Acceptance criteria (go/no-go, reviewed by Lars): mean retries ≤ ~5 and mean time-to-valid-pair ≤ ~1 s laptop-Node on ≥ 70 % of urban maps; zero legality violations. If side-rejections dominate, tune prefilter thresholds before proceeding.

## Phase 3 — Client integration — ✅ DONE (2026-07-05)

All three WPs implemented + verified on the data path. `.navgraph.bin` is served over an
authed endpoint (3.1); the tested Phase-2 harness is ported into the pathing worker with a
`navgraphReady`/`generatePair`→`pair` protocol and per-accepted-pair legal refinement (3.2,
Node parity, legality=0); infinite_play gains a scene-source switch + mask provider + prefetch
buffer + raster background (3.3, live-verified on staging File 25: nav ack 4019 nodes/9275
edges, legal pairs, buffer held at 3, map image loads). Refinement stays at `refineRouteLegal`
(theta* deferred to Phase 5, plan's low-risk rec).

⚠ **Not yet confirmable end-to-end** (two known gates, both expected):
- **Real map-region testing awaits WP 4.1** (coach-drawn polygon). Until then endpoint sampling
  uses the *automatic* hit-zone fallback, so "works" ≠ "validated on true regions" (Lars).
- The map picker + `/play/infinity/mask-maps/` listing are a **temporary disk-scan placeholder**
  marked `TODO(WP 4.2)` (opt-in model/flag not built). The `Agents` team has no artifact-bearing
  maps, so live play needs an opt-in map (WP 4.2) or a navgraph map assigned to the agent's team.
- Live *animated* frames were not screenshot-verifiable (hidden-preview-tab rAF freeze, documented);
  render inputs proven valid instead.

### WP 3.1 — Artifact serving — **Sonnet** — ✅ DONE (2026-07-05)
Serve `.navgraph.bin` alongside masks via the same authenticated path as `serve_mask_file()` in [media_access.py](project/media_access.py) (new endpoint or extend existing, mirroring its permission checks). Add URL in the relevant urls.py.
Acceptance: logged-in fetch returns the binary with correct content-type; anonymous fetch is rejected. Verify via `/dev/agent-login/` + fetch.
Implemented: `serve_navgraph_file()` in `media_access.py`, `get_navgraph()` view, URL
`navgraph/<int:file_id>/` (name `get_navgraph`). **Endpoint is `/editor/navgraph/<file_id>/`**
(project urls mounted under `editor/`, same as `/editor/mask/<id>/`). Verified live on staging
File 23: authed → 200 `application/octet-stream` bytes `NVG1\x02…`; anonymous → 302; team-scoped
permission parity with the mask endpoint confirmed.

### WP 3.2 — Mask scene provider in the pathing worker — **Opus** — ✅ DONE (2026-07-05)
Ported the WP 2.1 harness functions verbatim into new `project/static/project/js/pathing/navgraph_router.js`
(pure ES module, Node+browser importable). Added `navgraphReady` (build+cache scene per map, keyed like the
grid cache) and `generatePair`→`pair` handlers to `worker.js` alongside the **untouched** editor pathfind path.
Accepted pair's two routes refined to legal full-res polylines via `refineRouteLegal` (Phase-2-validated;
theta* deliberately NOT layered — plan's explicit low-risk recommendation), runtimes recomputed from the
refined terrain-weighted cost and the relative gap re-checked (re-reject if now > 0.5). Per-stage
`[theta-client]` timings logged. Node parity: 8/8 pairs on `mask_20250602_081036` + `mask_20250715_092410`,
**zero legality violations**, mean retries 2.25 / 3.25 (matches Phase-2 harness). Exact `pair` protocol
recorded in `scratch/phase3_progress.md` for WP 3.3. `collectstatic` + restart needed before browser testing.

Port the WP 2.1 functions into `project/static/project/js/pathing/` (new `navgraph_router.js` + additions to `worker.js`): load/cache artifact per map (existing worker cache pattern, keyed like the grid cache at worker.js:36-51), pair generation (endpoints sampled only inside the artifact's `coarse_hitzone` = coach region), graph A*, barriers, selection. For the accepted pair only: corridor + guided theta* refinement reusing `corridor.js`, `theta_star.js`, `simplify.js` on full-res subgrids along the graph path (mask decoded lazily, subgrid extraction via `preprocess.js`); recompute runtimes from refined paths and re-check the gap (re-reject if now > 0.5). Message protocol: `generatePair(mapId) → {start, goal, routes[2], runtimes, meta}`.
Acceptance: from a test page or console, worker returns valid pairs on a staging mask; timings logged per stage like the existing `[theta-client]` logs.

### WP 3.3 — infinite_play wiring + prefetch buffer — **Opus** — ✅ DONE (2026-07-05)
Implemented: scene-source switch in [infinite_play.js](results/static/results/js/infinite_play.js)
(`?source=mask&file=<id>&filename=<name>` at play start; city path is the untouched
default/fallback). New module `results/static/results/js/infinite/mask_scene_source.js`
owns the pathing worker, fetches `/editor/navgraph/<id>/` (ArrayBuffer) + decodes
`/editor/mask/<id>/` (createImageBitmap + OffscreenCanvas, channel 0 → greyscale
Uint8Array), posts `navgraphReady`, and drives `generatePair`→`pair` (WP 3.2 protocol),
keeping a prefetch buffer (target 3, ≥ 2 kept full). `buildMaskScene(pair)` produces a
scene mirroring the city scene shape (`kind:'mask'`, start/ziel, two routes with
run_time/side/length/noA); `renderScene`/`buildRenderedScene` branch on `kind` to draw the
real map raster as an SVG `<image>` (`/editor/map/<filename>`; mask px × TRAIN_SCALE_VALUE)
with routes/endpoints overlaid. Map picker: temporary authed `/play/infinity/mask-maps/`
listing files with a `.navgraph.bin` on disk + an in-page picker overlay, both clearly
marked `TODO(WP 4.2)`. New JS strings via `locale/source_messages.py` (djangojs) + built.
Verified live on staging File 25 via `/dev/agent-login/`: navgraph ack (4019 nodes / 9275
edges / 27785 sample cells), legal pairs (`legality==0`), coord conversion correct, prefetch
buffer stayed at 3, map raster loads. rAF-frozen hidden preview tab prevented live animated
frame capture (documented limitation) — data path proven, live rendering awaits a foreground
tab / WP 4.1 real-region testing.

Original spec: In [infinite_play.js](results/static/results/js/infinite_play.js): introduce a scene-source abstraction (city generator = existing path; mask provider = new). Mask scenes: map raster as background (however the normal play view renders map images), pair + 2 routes from WP 3.2, same play/scoring flow (`scene.meta` fields mirrored). Prefetch buffer of ≥ 2 validated pairs filled during play; map picker listing only opt-in maps (endpoint from WP 4.2). New user-facing strings go through `locale/source_messages.py` + `python scripts/manage_translations.py --check && --build` (djangojs domain).
Acceptance: playable end-to-end on staging via `/dev/agent-login/`; buffer hides generation latency (no visible wait at 2 s cadence). Run `collectstatic` + restart before browser verification.

## Phase 4 — Map region, opt-in + suitability — ✅ DONE (2026-07-05)

All three WPs implemented + verified (model change approved by Lars). Coaches can
draw/drag/insert/delete the authoritative map-region polygon over the mask (4.1,
persisted to `File.infinite_region`, save→async navgraph rebuild); opt-in is gated
behind a set region and flips `File.infinite_enabled`, which drives the mask-map
picker (4.2); a build-time Python pair simulation (`navgraph_suitability.py`, mirror
of the Phase-2 harness) writes `{valid_rate, mean_retries, mean_ms}` into the `.npz`
and the editor renders it with a soft warning below thresholds (4.3), matching the
WP 2.2 harness ballpark on 3 test masks. **Outstanding for Lars:** hands-on click-test
of the region editor's mouse feel, then a real end-to-end infinite-play session on a
coach-drawn region (the gate the whole effort was waiting on). Remaining phases:
Phase 5 (refinement/selection parity/blocking) and Phase 6 (tuning + phone
verification).

### Phase 4 UI REVISION — ✅ DONE (2026-07-05, Lars-directed) — READ BEFORE RE-IMPLEMENTING 4.1–4.3

> **For a future completeness check:** WP 4.1–4.3 below are the *original* specs and
> are kept for context, but the **UI and build flow were deliberately reworked by Lars
> after first implementation**. The items marked "superseded" here are **intentionally
> gone — do not restore them**. The underlying capability (draw a region, opt a map in,
> build its navgraph) is unchanged and still complete; only the surfacing changed.

**What changed and why (Lars's reasoning):**

1. **Infinity is now a first-class editor tool mode**, not buttons bolted into the mask
   panel. Added `ToolMode.INFINITY` + `InfinityTool`, one slice in the sidebar tool-wheel
   (now **6 segments / 60°**, was 5/72°) and one in the right-click radial menu (RCM
   generalised to N slices). *Why: separate the UI properly — region editing is its own
   activity, not a sub-feature of masking.*
2. **Subtools `edit` (drag / edge-insert) and `remove` (click a vertex to delete, min-3
   guard).** The old **right-click-to-delete and Del-key handlers were removed**
   (`RegionEditor.onRightDown` / `onKeyDown` / `trackHover` gone). *Why: deletion should
   be an explicit, discoverable subtool, not a hidden mouse/keyboard gesture.*
3. **Side panel = `#infinity-controls`** (shown in `body.mode-infinity`): "Infinity Mode"
   title, explanation of the two subtools, and a highlighted note to keep the selection
   tight so routes can't run around the map. **No auto-suggest / save / finish buttons —
   editing autosaves** on every drag/insert/delete. *Superseded:* `#region-panel` inside
   `#mask-controls`, the Edit/Auto-suggest/Save/Done buttons.
4. **Base region = the four map corners** (the coach drags them inward). The **automatic
   zone detector `suggest_region_polygon()` was fully removed** from `navgraph.py`, and
   `region_suggest` now returns the saved region or the frame corners (`source:'frame'`).
   *Why: the marching-squares contour produced far too many vertices — unusable for a real
   coach to hand-edit.* `_hitzone` stays (it's still the builder's internal fallback, not
   user-facing). *Superseded:* `suggest_region_polygon`, the `?fresh=1` re-suggest branch.
5. **Activation toggle moved to the navbar (left of Publish)** as `NavInfinity` (button
   `#nav-infinity-btn`), replacing the in-panel `InfiniteToggle` checkbox. Enabling on a
   region that is still exactly the map-frame corners (or absent) shows a **publish-style
   warning modal** — same pattern as "Controls without routes" — and is blocked
   (`_region_is_full_frame` in `views.py`). *Why: if the region isn't tightened, generated
   routes can run around the map edge.* *Superseded:* `InfiniteToggle`, the
   `#infinite-enabled-toggle` checkbox + its `#region-panel` row.
6. **Navgraph build is deferred to activation time**, not on region save and not on every
   mask edit. `save-region` now only persists (cheap). `toggle-infinite` (enable) validates
   the region then builds in a background thread via
   `_rebuild_navgraph_for_file(enable_on_success=True)`, showing a **spinner in the navbar
   button**; **`File.infinite_enabled` flips only after the build succeeds** (never before —
   a half-built map can't be served). *Why Lars asked: don't rebuild on every mask/region
   edit — only build once the coach "releases" the file for infinity.*
7. **`region-build-status` is polled only while an activation build is in flight**
   (`NavInfinity.pollBuild`), then stops. *Why: it was previously firing on basically every
   editor action (the old `save-region`→poll path).* Verified: no build-status calls during
   open / save-region / tool-switching.
8. **Suitability report removed from the UI** (`SuitabilityReport` module + `#suitability-*`
   markup gone). The **backend is intentionally kept** — `project/navgraph_suitability.py`,
   the `stats["suitability"]` in the `.npz`, and `GET /editor/region-suitability/<id>/` all
   still exist and still run at build time; they're just not surfaced. *Lars's call.*
9. **Editing the region after enabling stays enabled** (autosave only). Re-toggling rebuilds
   the navgraph fresh, which covers both mask and region changes since the last build.

**Net endpoint/flow after the revision:** `region-suggest` = saved-or-frame; `save-region`
= persist only (no build); `toggle-infinite` enable = validate (region present + not full
frame) → background build → flag flips on success; disable = immediate. New i18n strings
built for DE/FR/IT. Verified live on a masked file via `/dev/agent-login/` (frame default,
both warnings fire, deferred build + spinner + flag flip, autosave persists, min-3 guard),
then the test file was reverted. Left as harmless dead code: old `.region-*`/`.suitability-*`
CSS and now-unused translation rows (flagged "unused" by `manage_translations --check`, not
errors).

### WP 4.1 — Map-region polygon editor — **Opus** — ✅ DONE (2026-07-05)
Implemented: `suggest_region_polygon()` (marching-squares contour of `_hitzone`
footprint → skimage `approximate_polygon` DP simplify to 10–40 verts, bbox
fallback) in `project/navgraph.py`; authed endpoints `GET /editor/region-suggest/
<id>/` (saved region or auto/`?fresh=1` suggestion), `POST /editor/save-region/
<id>/` (validate + persist `File.infinite_region` + async navgraph rebuild),
`GET /editor/region-build-status/<id>/` (poll rebuild state); `RegionEditor`
module in `project/static/project/js/editor.js` (draggable closed polygon in the
overlay `#ui-layer`, edge-click insert, right-click/Del delete, persistent SVG
nodes per the no-DOM-churn convention); controls in `#region-panel` inside
`#mask-controls`; `build_navgraph` command loads the region + treats a region
change as a rebuild reason. Coord map: world(SVG) = maskPx ×
PATHING_MASK_TRAIN_SCALE (0.710). Verified on File 25 (suggest/save/rebuild →
`coarse_hitzone` matches polygon bbox, `hitzone_source=polygon`; UI drag/insert/
delete + save-rebuild-poll). *(⚠ model change was approved by Lars 2026-07-05.)*

Original spec:
The coach draws the relevant map area as a polygon over the map image; this is the authoritative hit zone consumed by the navgraph builder (Phase-1 prep already done: `build_navgraph(region_polygon=…)` + `_rasterize_region`; `coarse_hitzone` in the artifact).
1. **Model/storage:** add `File.infinite_region = JSONField(null=True, blank=True)` (project app model that owns masks) storing polygon vertices as `[[x,y],…]` in full-res mask pixel coords (same space as `nodes`). One migration; can share the migration with WP 4.2's opt-in flag.
2. **Editor UI** (in the existing map editor where the mask/preview renders): an SVG overlay on the map raster with a draggable closed polygon. Interactions required: **drag a vertex** to move it; **click on a polygon edge to insert a new vertex** there; delete a vertex (right-click / Del). Reuse-node rendering per the "editor live previews reuse SVG nodes (no per-frame add/remove)" convention to avoid password-manager reflow lag. Handle display↔pixel coordinate mapping (map image may be scaled/rotated in the editor).
3. **Initial suggestion:** pre-fill the polygon from the automatic detector so the coach corrects rather than draws from scratch — add a server helper `suggest_region_polygon(mask)` (marching-squares contour of `_hitzone`'s footprint → `simplify`/Douglas–Peucker to ~10–40 vertices), exposed via a small authenticated endpoint. Fallback: mask bounding box.
4. **Save → rebuild:** persisting the region triggers a navgraph rebuild (or a lighter re-rasterize-hitzone path) so `coarse_hitzone` reflects the polygon; surface build state in the editor. New user-facing strings via `locale/source_messages.py` + `manage_translations.py --check && --build`.
Acceptance: coach can draw/drag/insert/delete polygon points on a staging map via `/dev/agent-login/`; region persists; rebuilt artifact's `coarse_hitzone` (and debug overlay) matches the drawn polygon; endpoints then sample only inside it.

### WP 4.2 — Opt-in flag — **Sonnet** — ✅ DONE (2026-07-05) *(model change approved; shared migration with WP 4.1)*
Implemented: `InfiniteToggle` in `editor.js` + toggle row in `#region-panel`; endpoint
`POST /editor/toggle-infinite/<id>/` (`{enabled}`→persist; 400 if enabling with no region, 403
off-team); `open_file()` JSON now returns `infinite_enabled`+`infinite_region_set`. Toggle is
**disabled until a region is set** (client UX gate seeded from `infinite_region_set`, flipped on
`RegionEditor.save()`; server re-validates region ≥3 pts). `infinite_mask_maps` now lists
`infinite_enabled=True` (+ existing team-scope & `.navgraph.bin`-on-disk check); all `TODO(WP 4.2)`
markers removed. Verified on File 25: toggle gates + persists, listing includes/excludes correctly,
400/403 guards fire. i18n strings built.
Add `File.infinite_enabled = BooleanField(default=False)` + migration (bundle with WP 4.1's `infinite_region`); editor UI toggle (visible when `has_mask`; ideally disabled until a region is set); endpoint listing enabled maps for the picker (referenced by WP 3.3).
Acceptance: toggle persists; picker shows only enabled maps.

### WP 4.3 — Suitability report at opt-in — **Sonnet** — ✅ DONE (2026-07-05)
At navgraph build time (extend WP 1.1/1.2), run a lightweight pair-generation simulation in Python (mirror of the sampling+graph-A*+selection logic; N≈50 pairs, **sampling within the region hit zone**) and store `{valid_rate, mean_retries, mean_ms}` in the artifact. Editor shows these next to the opt-in toggle with a soft warning below thresholds (no hard block).
Acceptance: report visible in editor for 3 test maps; warning appears on a known-bad (e.g. park) map.

Implemented in `project/navgraph_suitability.py` (mirrors `scripts/navgraph_harness.mjs`: sample→snap→graph-A*→barrier alternates→`selectRuntimeRouteOptions` port), called from `build_navgraph` (try/except-guarded — a sim failure never breaks a build) and stashed in `stats["suitability"]`, which already rides along in the `.npz` (no `.bin` format/version change). Endpoint `GET /editor/region-suitability/<file_id>/`; editor `SuitabilityReport` module (`editor.js`) renders in `#region-panel` below the opt-in toggle, with a soft warning driven by a server-computed `warn` flag. Verified on 3 masks: tiny/weak (0.26 Mpx) → 0% valid, warn; small (1.7 Mpx) → 18%, no warn; mid urban (8 Mpx) → 26%, no warn — same ballpark as the WP 2.2 harness numbers for the same masks.

## Phase 5 — Editor-grade refinement, selection parity + blocking elements (masks) — **NEW 2026-07-09**

This phase closes the three gaps Phase 3 deliberately left open, and is the missing
"rest of the pipeline" from the editor:

1. **Refinement quality.** Served routes are currently `refineRouteLegal` output
   (straight-segment patching with local A* detours) — legal, but not the editor's
   any-angle, terrain-weighted polyline. The editor pipeline
   ([pipeline.js](project/static/project/js/pathing/pipeline.js) `runPipeline`) is:
   full-map margin-growth A* → `simplifyAStarSameTerrainPath` → `corridorMask`
   (radius 24 @ scale 0.5) → `applyCorridor` → `guidedThetaStar` (switch radius 10)
   → `simplifyThetaPath` (10°, 5 px). In mask mode the navgraph replaces the first
   stage (per the Architecture section); **the corridor + guided θ* stages must now
   be layered on top of the accepted pair's routes**, reusing the editor modules
   as-is.
2. **Selection/rejection parity.** The city mode's selection was refactored (commit
   `1447d14`) into the shared module
   [route_pair_selection.js](results/static/results/js/infinite/route_pair_selection.js)
   (weighted pair choice targeting ~10 % runtime gap, lateral reject, route-index
   bias, `skippedBarriersForSelection`) plus per-route **A* time budgets with
   timeout kicks** ([RoutePlanner.js](results/static/results/js/infinite/citygen/core/RoutePlanner.js)
   `computeRouteOptions`: `primaryBudgetMs` 400 for routes 1–2, `extraBudgetMs` 200
   for 3+, timed-out route dropped → `timeout` rejection) and balance-reject
   0.05/0.8 (`infinite_batch_worker.js` `balanceRejectConfig`). The mask router
   ([navgraph_router.js](project/static/project/js/pathing/navgraph_router.js))
   still carries the **pre-refactor** port: closest-pair selection, maxRelativeGap
   0.5, no weighting, no budgets, balance-reject 0.5. Mask mode must use the same
   shared module and the same rejection taxonomy — timeouts WILL trigger on masks
   (full-res refinement is the slow stage), so the budget/kick machinery matters.
3. **Blocking elements without a visibility graph.** In city mode, when the selected
   pair skips a faster lower-index route, that route's barrier is *drawn* as a
   purple blocking bar (`skippedBarriersForSelection` → `drawRouteBlocks` in
   [infinite_play.js:3470](results/static/results/js/infinite_play.js)) and the
   visibility graph enforces it. On masks there is no vis graph: barriers currently
   only block navgraph edges (approximate), are never rendered, anchor on *any*
   impassable pixel (a lone tree qualifies), and refinement ignores them entirely —
   a refined route could legally cross a drawn bar. This phase makes barriers
   intelligently placed (pixel-probing with obstacle-significance tests),
   rendered, and enforced at full resolution.

Execute WPs in order — 5.2 (selection + budgets) first because 5.1 and 5.3 hang
their timeout/skipped-barrier semantics off it. Constants live in
`DEFAULT_CONFIG` (navgraph_router.js) unless noted; every new threshold goes there
too so Phase 6 can tune in one place.

### WP 5.1 — Selection/rejection parity + time budgets — **Opus**

Replace the mask router's local `selectRuntimeRouteOptions` with the shared
weighted selection, and port the city planner's budget/kick semantics.

1. **Shared module via dependency injection.** `route_pair_selection.js` is pure and
   dependency-free, but navgraph_router.js must stay importable in Node (harness) and
   the browser worker — a cross-app relative import works in neither. So: inject.
   `worker.js` (browser-only) adds
   `import { selectWeightedRoutePair, skippedBarriersForSelection, ensureRouteSides, DEFAULT_ROUTE_PAIR_SELECTION } from '/static/results/js/infinite/route_pair_selection.js';`
   (absolute `/static/…` specifiers are the established cross-app pattern — see
   [mask_scene_source.js:14](results/static/results/js/infinite/mask_scene_source.js))
   and passes them into `generateOnePair(state, { selection })`. Node callers import
   the module by file path and inject the same way. Delete the stale local
   `selectRuntimeRouteOptions` from navgraph_router.js.
2. **Path records get city-shape fields.** In `computeRouteOptions` (navgraph_router):
   `routeIndex = attempt + 1`, `barrier` = the barrier placed *after* this route
   (same convention as RoutePlanner `pathRecord.barrier`), `run_time` = graph cost.
   Dedupe by node-path signature as today. Raise `routeAttempts` 4 → 5 to match
   city `selectionConfig.maxRoutes` (the weighted picker's `highRouteIndexBias`
   assumes deeper exploration).
3. **Selection call.** `selectWeightedRoutePair(paths, { start, goal, config: {
   ...DEFAULT_ROUTE_PAIR_SELECTION, minSideGap: cfg.sideGapMinPx /* px, 40 */,
   maxRelativeGap: 0.40 }, rng })` — note maxRelativeGap drops 0.5 → 0.40 to match
   `ROUTE_PAIR_MAX_RELATIVE_GAP`. Sides via the shared `ensureRouteSides` (side is
   in px on masks because it's normalized by direct length — the scale-free
   `lateral` check ports unchanged). Pass the seeded rng through so seeded runs
   stay reproducible. Compute `skippedBarriers = skippedBarriersForSelection(paths,
   selected)` and return it with the pair (WP 5.3 consumes it).
4. **Budgets + timeout kicks.** Port RoutePlanner semantics: routes 1–2 get
   `primaryBudgetMs` (default 400), routes 3+ `extraBudgetMs` (default 200). The
   budget covers the whole per-route step on masks: graph A* + (for route 1) the
   snap stubs. Implement as a deadline checked inside `graphAstar`'s pop loop and
   `astarSubgrid` (it already has `maxExpansions`; add `deadlineMs` checked every
   ~1024 expansions). A timed-out route is dropped; if that leaves <2 routes the
   attempt fails with reason `timeout` — mirroring RoutePlanner's
   `failedRoute(timeout ? 'timeout' : 'distinct', …)`.
5. **Balance reject stays post-refinement** but syncs to `balanceRejectConfig`
   values (maxRelativeGap 0.05, probability **0.8** — currently 0.5 here; the
   DEFAULT_CONFIG comment already says "keep the two in sync").
6. **Rejection taxonomy + counters.** `generateOnePair` aggregates per-call counts
   over all attempts — `{ empty, distance, obstacle, snap, unreachable, distinct,
   runtime, side, routeside, lateral, timeout, runtime_refined, balanced }` — and
   returns them in `meta.rejectionCounts` (the mask analogue of the city batch's
   `rejectionCounts`), logged in the worker's `generatePair OK/FAILED` line.
7. **Harness de-drift.** Refactor `scripts/navgraph_harness.mjs` to import
   navgraph_router.js and route_pair_selection.js directly (navgraph_router is
   already Node-clean by design) instead of carrying drifted copies; re-run
   `scripts/navgraph_batch.mjs` on the WP 2.2 mask set to re-baseline. Expect the
   gap distribution to center near 0.10 and `side`/`balanced` rejects to rise —
   that is the intended training-distribution change, not a regression.

Acceptance: Node batch on ≥ 10 WP 2.2 masks completes with the shared selection
(zero legality violations, mean ms/valid within ~2× of the WP 2.2 baseline);
seeded runs reproducible; a forced tiny budget (e.g. `primaryBudgetMs: 1`) yields
`timeout` rejections, not hangs; worker logs show the new counters.

### WP 5.2 — Corridor + guided θ* refinement of served routes — **Opus**

Full-quality refinement for the accepted pair only (outside the retry loop), as
plan.md's Architecture always intended. New module
`project/static/project/js/pathing/refine_theta.js` (same-dir relative imports of
`preprocess.js`, `theta_star.js`, `simplify.js` work in both Node and the worker),
exporting `refineRouteTheta(state, path, barriers, opts) → { path, cost, mode }`.

Per selected route:
1. **Legal spine first.** Run the existing `refineRouteLegal` (unchanged, Phase-2
   validated) → a guaranteed-legal full-res polyline. This replaces the editor's
   margin-growth A* output as the waypoint chain — it plays the exact role `wps`
   plays in `runPipeline`, and guarantees the corridor around it contains at least
   one legal path (itself). Do **not** feed raw graph node chains to the corridor:
   long detour edges validated by the builder's A* can stray far from the
   node-node straight line and a radius-24 corridor around it would sever them.
2. **Subgrid = bbox of the legal spine** + `corridorRadius + 8` margin, extracted
   from the true full-res mask (this is the "corridoring the relevant section of
   the map" step; no margin-growth loop needed — the spine tells us the region).
3. **Rasterize active barriers** (WP 5.3 interface): every barrier with
   `attemptIndex < routeIndex` of the route being refined is stamped into the
   subgrid as an impassable thick line (single shared width constant, see WP 5.3)
   — the mask-mode equivalent of the editor's `applyBlockedTerrain` blocked-lines
   overlay, which plan.md already names as the barrier mechanism.
4. **Corridor + θ*.** `corridorMask(spineWps, sw, sh, corridorRadius)` →
   `applyCorridor` → `guidedThetaStar(constrained, sw, sh, startSub, goalSub,
   spineWps, THETA_SWITCH_RADIUS=10)` → `simplifyThetaPath(10°, 5 px)`.
   `corridorRadius` = 24 mask px by default (mask px ≈ the editor's scale-0.5
   reference frame; make it a `DEFAULT_CONFIG` entry). Add a `deadlineMs`
   check to `guidedThetaStar`'s pop loop (new optional param; the editor path
   passes none and is unaffected).
5. **Runtime = Σ `lineCost`** over the final polyline segments on the **true**
   mask (not the barrier-stamped grid — bars are virtual fences, terrain cost is
   real). Both the relative-gap re-check and the balance reject then operate on
   these θ*-refined runtimes, exactly where the `refineRouteLegal` costs are used
   today.
6. **Timeout/failure policy (recommended: consistent fallback).** If θ* fails or
   exceeds its budget (`refineBudgetMs`, default 600/route) for *either* route,
   serve **both** routes as plain `refineRouteLegal` output (`mode:
   'legal-fallback'`) — the pair already passed selection, the legal polylines are
   Phase-2-validated, and falling back for both keeps the two runtimes on the same
   cost basis (θ* paths are systematically slightly cheaper; mixing bases would
   bias the gap). Only if even the legal spine is unusable does the pair reject
   (`timeout`). Expose `refineTimeoutPolicy: 'fallback' | 'reject'` in
   DEFAULT_CONFIG so the strict city-style behaviour is one flag away; count
   fallbacks in `meta` either way.

Acceptance: Node parity run on ≥ 3 size-varied masks (small / median / 75 Mpx),
≥ 200 accepted pairs: zero legality violations on the true mask; zero drawn-bar
crossings; refined runtime ≤ legal-spine runtime on ≥ 95 % of routes (θ* should
only improve); p90 refine time per pair ≤ ~800 ms laptop-Node; harness PNG
spot-checks show smooth any-angle polylines hugging terrain (Lars eyeballs a
handful). Per-stage `[theta-client]` timings extended with `theta` alongside
`refine`.

### WP 5.3 — Blocking elements without a visibility graph — **Opus**

Make mask barriers as trustworthy as city ones: intelligently anchored, actually
route-blocking, rendered to the player, and enforced in refinement.

1. **Port the *current* `findSmartBarrier`.** The navgraph_router `findBarrier`
   port predates RoutePlanner's newer tiers (`bestClearEnclosed` /
   `isClearOfRouteNodes` / `broadFallback`); re-port [RoutePlanner.js:75](results/static/results/js/infinite/citygen/core/RoutePlanner.js)
   faithfully with px-scaled constants (existing `barrier*Px` config entries).
2. **Obstacle-significance test (the "no clean vis graph" answer).** The city
   version anchors only in *significant* polygon obstacles (hedges excluded); the
   mask version must not anchor a bar on a lone tree dot or map-symbol speck.
   Replace the raw `inObstacle` probe with `inSignificantObstacle`: on a probe
   hit, bounded flood-fill the impassable component (cap ~250 px, memoized per
   pixel) and accept as anchor iff `area ≥ barrierAnchorMinAreaPx` (default 60)
   **or** the component is elongated (thin walls/fences are significant at any
   area — reuse the elongation idea from the retired blob prefilter:
   `max(bboxW,bboxH)² / area ≥ 8`). Small compact blobs remain barriers-invisible
   exactly like city hedges.
3. **Effectiveness guarantee.** A bar that intersects zero navgraph edges of the
   route it is meant to block does nothing (today the re-route dedupes and the
   attempt silently degrades to `distinct`). After placing a candidate bar,
   require it to intersect ≥ 1 edge of the *current route's* `nodePath`; if not,
   slide the probe window further along the route (reuse the 0.25–0.75 fallback
   window) until one does, else return null (no barrier — attempt ends with the
   routes found so far). This is cheap: intersection only against the ≤ ~40 edges
   of the current route, not all E edges.
4. **Serve + render.** `generateOnePair` returns `barriers` (all placed) and
   `skippedBarriers` (from WP 5.1) in mask px; `mask_scene_source._wrapPair`
   converts to map units (× TRAIN_SCALE_VALUE); `buildMaskScene` sets
   `scene.routeResult = { skippedBarriers, blockFastest: skippedBarriers.length > 0,
   barriers }` so the **existing** `drawRouteBlocks` renders the purple bars on the
   map raster with zero new drawing code (verify the mask render branch calls it;
   wire if not).
5. **Full-res enforcement + single width source.** One exported constant
   `BARRIER_DRAW_WIDTH_MASK_PX` (start: `BLOCKING_STROKE_WIDTH / TRAIN_SCALE_VALUE`
   rounded — the bar the player sees) used by (a) WP 5.2's subgrid rasterization
   and (b) the legality assertion: extend `countLegalityViolations` for the
   refined routes to also count intersections with barriers of lower
   `attemptIndex` — mirrors the city invariant "the drawn rectangle is blocked,
   visuals and routing cannot drift apart"
   ([RoutePlanner.js:16](results/static/results/js/infinite/citygen/core/RoutePlanner.js)).

Acceptance: on ≥ 3 masks × 100 pairs (Node): every served `skippedBarrier` both
ends anchored in significant obstacles (assert via the significance test), zero
refined-route crossings of active bars, no pair where a placed barrier
intersected zero route edges; live on staging via `/dev/agent-login/`: a pair
with `blockFastest` shows the purple bar exactly covering the passage, routes
visibly detour around it.

### WP 5.4 — Play wiring, stats + live verification — **Sonnet**

- Thread `meta.rejectionCounts`, refine mode/fallback counts and per-stage timings
  from the worker `pair` message through `buildMaskScene` into the same stats
  surfaces the city mode fills (mirror the `scene.meta` fields the stats panel
  reads; check [stats.js](results/static/results/js/stats.js) expectations).
- Bump/verify `PAIR_TIMEOUT_MS` interplay: worker-side budgets (WP 5.1/5.2) must
  make a `generatePair` round-trip comfortably < the 20 s outer guard even on the
  75 Mpx map; log a warning if a single pair exceeds ~5 s.
- Any new user-facing strings via `locale/source_messages.py` +
  `python scripts/manage_translations.py --check && --build` (djangojs).
- `collectstatic` + server restart, then live session on a coach-enabled map via
  `/dev/agent-login/`: buffer stays ≥ 2 at 2 s cadence with θ* refinement on;
  console shows the new counters; screenshot/eval-probe evidence per the
  rAF-frozen-tab workaround.

Acceptance: end-to-end staging session with all Phase-5 pieces on; no buffer
starvation; stats panel shows mask rejection counts like city ones.

## Phase 6 — Tuning + phone verification — **Opus** *(was Phase 5)*

- Re-run WP 2.2 batch after any threshold changes; tune: hit-zone/region handling, node spacing, distance band, sideGap scaling, barrier length, Phase-5 additions (budgets, corridor radius, barrier significance thresholds, `refineTimeoutPolicy`).
- Browser verification with 4–6× CPU throttling (phone proxy): time-to-valid-pair distribution over 50 pairs on median + large maps; memory snapshot (heap < ~150 MB on median maps).
- Edge cases: old-scheme masks, masks with several large free components (islands across a river without bridge portals), degenerate tiny masks.
Acceptance: phone-proxy average generation ≤ 2 s with buffer never empty during a 5-min session; documented tuning constants.

---

## Verification summary

- Phase 2 CSV gates the whole effort before any UI work (cheap abort).
- Legality is asserted mechanically (no route crosses impassable full-res pixels) at every phase.
- Browser checks via `/dev/agent-login/` (trainer role), preview tools, CPU throttling; `collectstatic` after JS edits.
- Visual checkpoints for Lars: WP 1.3 overlays, WP 2.2 rendered pairs, Phase 3 live play.
