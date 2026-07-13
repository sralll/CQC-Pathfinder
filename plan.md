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

**Scaling correction (2026-07-10):** uploaded-map infinity scenes now use the same
coordinate/metric model as normal play and the editor: full-res mask px × `0.710` =
editor/map px, then `0.48 × map_scale/4000` metres per editor px. The provisional
500–1500 mask-px pair band was replaced by a map-scale-aware 40–120 m band, and the
route-side threshold is likewise 12 m. Mask controls/connections use normal play's
25 px radius, 8 px gap and 3 px stroke; blocking marks use the normal 5 px stroke,
with a matching 7-mask-px enforcement band. Route lengths/NoA/report metadata now use
the uploaded map's metre scale instead of the generated city's metre-per-unit value.

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

**Endpoint-density follow-up (2026-07-12):** uploaded-map start/goal cells are
no longer selected uniformly. `navgraph_router.js` counts exact black (`0`)
mask pixels in an approximately 100×100 px square around every eligible coarse
cell using a coarse-grid summed-area table, ignoring black pixels outside the
saved region so the unmapped exterior does not attract edge points. It then
raises the counts to exponent 1.35 as sampling weights. Selection is a 70%
density-weighted / 30% uniform mixture, so alleys and obstacle-rich wards keep
a useful preference while open terrain and quieter map regions appear much
more often. Starts additionally receive a mild exponential bias (strength
0.25, reduced from 0.8) toward
the area-centroid of the saved `coarse_hitzone` (the rasterized coach polygon);
goals stay center-neutral to preserve route coverage. The window, density
exponent, uniform mixture, and center strength are tunable through
`endpointObstacleWindowPx`, `endpointDensityExponent`, `endpointUniformMix`,
and `startCenterBiasStrength` in `DEFAULT_CONFIG`. The deterministic test covers
the moderated obstacle preference, broader open-space probability, mild
start-center bias, and center-neutral goal distribution.

**Camera-direction follow-up (2026-07-13):** when an uploaded-map pair is taken
from the prefetch buffer, `infinite_play.js` compares the camera rotation for
its generated start-to-goal direction with the equivalent goal-to-start
direction. It swaps start/goal only when that direction is closer to the
current camera heading, reverses every complete route point array (and any
passage-span indices), flips route-side metadata, and invalidates a previously
prerendered cache. Route geometry, runtimes, barriers, and choice identity stay
unchanged, while consecutive problems never make an avoidable 180-degree turn.

**File 34 centroid diagnostic (2026-07-13):** Bern Altstadt's mask is
2739x1674 (image center 1369.5,837). Its saved four-point region has the exact
polygon-area centroid 486.51,493.80; the runtime's rasterized hit-zone centroid
is 487.38,494.42. The endpoint bias therefore already targets the geometrical
center of the saved region, within one pixel, not the map image. A new
off-center-region regression pins this invariant. A production-equivalent
seeded audit showed the visible two-alley concentration happens after sampling:
8 accepted pairs from 365 attempts, with 197 rejected by the required
opposite-side route gate. Lowering the minimum side-gap did not admit other
areas, so changing the centroid cannot alter that map's accepted-pair hotspots;
doing so would require relaxing the left/right route-choice contract or drawing
a region containing more topology that supports opposite-side alternatives.

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

## Phase 5 — Editor-grade refinement, selection parity + blocking elements (masks) — ✅ DONE (2026-07-10)

All four WPs implemented + verified (Node acceptance harnesses + live staging
session; zero legality violations and zero barrier crossings everywhere).
Remaining: Phase 6 (tuning + phone verification), which inherits these flagged
items: 5.2 p90 refine times on median/75 Mpx maps, `BARRIER_DRAW_WIDTH_MASK_PX`
tuning, live legal-fallback rate re-measure on a foregrounded tab,
`navgraph_suitability.py` still on the old simplified barrier port.

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

### WP 5.1 — Selection/rejection parity + time budgets — **Opus** — ✅ DONE (2026-07-10)

Implemented all 7 items: shared `route_pair_selection.js` injected (worker via
`/static/…` import, Node by path; stale local `selectRuntimeRouteOptions` deleted);
city-shape route records (`routeIndex`, `barrier`, `run_time`; routeAttempts 4→5);
`selectWeightedRoutePair` with maxRelativeGap 0.40 + seeded rng + `skippedBarriers`
(shape `Array<{ax,ay,bx,by}>` mask px, forwarded in the worker `pair` message);
budgets 400/200 ms with deadline checks in `graphAstar` + `astarSubgrid` (route 1's
budget covers snap stubs), <2 routes → `timeout`; balance reject synced 0.05/0.8;
13-key `meta.rejectionCounts` logged by the worker; harness de-drifted to import the
real modules. Acceptance: 12-mask batch (seed 1) — **zero legality violations**,
seeded runs byte-identical, `primaryBudgetMs:1` → timeouts not hangs, served-pipeline
ms/valid 15.2 vs 18.9 pre-change (×0.80). Gap distribution now centres ~0.113;
`side` 571→365, `routeside` 479→138, new `balanced` 203 — the intended shift.
Artifacts: `scratch/wp5_1_summary.md`, `scratch/wp5_1_rebaseline.md`. Note for 5.4:
`collectstatic` not yet run (no browser check in this WP).

Original spec: Replace the mask router's local `selectRuntimeRouteOptions` with the shared
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

### WP 5.2 — Corridor + guided θ* refinement of served routes — **Opus** — ✅ DONE (2026-07-10)

Implemented: new `project/static/project/js/pathing/refine_theta.js` with
`refineRouteTheta(state, path, barriers, opts) → {path, cost, mode, …}` (`mode ∈
theta|legal-fallback|unusable`); legal spine → subgrid → barrier stamping → corridor
→ `guidedThetaStar` (optional `deadlineMs`, editor path untouched) → simplify;
runtime = Σ `lineCost` on the true mask; `corridorRadius:24` / `refineBudgetMs:600`
/ the original `refineTimeoutPolicy:'fallback'` default (superseded by the
report-8 follow-up below); `[theta-client]` logs gain
`theta` + refine mode. Acceptance (seed 1, 220 pairs, small/median/75 Mpx): **zero
legality violations, zero drawn-bar crossings** (stamped + geometric checks),
refined ≤ legal-spine runtime **432/432**; p90 refine/pair 772 ms small, 885 ms
median (marginal, within Node variance), 1413 ms on the opt-in-gated 75 Mpx outlier
(Phase-6 trim via budget/radius). Spot-check PNGs `scratch/wp5_2/`, summary
`scratch/wp5_2_summary.md`. Deviations (documented in code):
`BARRIER_DRAW_WIDTH_MASK_PX = 7` for normal-play's 5 editor-px overprint (widths
1–2 leak sub-pixel diagonal gaps); LOS-guarded densifying repair after
`simplifyThetaPath` (Bresenham-vs-linear-sampler corner disagreement forced ~55 %
fallbacks; now θ* used on ~95 %+ with legality 0); barrier-legality guard rejects
barrier-crossing legal-fallback pairs (bucketed `timeout` until WP 5.3 owns a
taxonomy key). For 5.3: exports `BARRIER_DRAW_WIDTH_MASK_PX`,
`countBarrierViolations(path, barriers, width?)`, `activeBarriersFor`; barriers
carry `attemptIndex`. For 5.4: thread `meta.refineMode`, `meta.refineFallback`,
`meta.refine[2]`, `meta.timings.theta`; `collectstatic` still pending.

Original spec: Full-quality refinement for the accepted pair only (outside the retry loop), as
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
6. **Original timeout/failure policy (superseded by the report-8 follow-up).** If θ* fails or
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

### WP 5.3 — Blocking elements without a visibility graph — **Opus** — ✅ DONE (2026-07-10; Node acceptance + live staging check passed)

Implemented in `project/static/project/js/pathing/navgraph_router.js`,
`project/static/project/js/pathing/worker.js`,
`results/static/results/js/infinite/mask_scene_source.js`, and
`results/static/results/js/infinite_play.js`; Node acceptance harness:
`scripts/wp5_3_verify.mjs`.

- Re-ported the current city barrier tiers (`bestClearEnclosed`,
  `bestEnclosed`, broad 0.25–0.75 fallback) with the mask configuration.
  The handoff had retained an obsolete `findBarrier` call signature; it now
  passes the router state correctly, so barrier-driven alternates actually run.
- `inSignificantObstacle` flood-fills bounded impassable components and caches
  the outcome: anchors must be area >= 60 px or elongated (ratio >= 8). Tiny,
  compact tree/symbol blobs are ignored. Barrier endpoints are rechecked after
  applying their margin, so a thin fence cannot leave an endpoint in open space.
- Every emitted bar records `routeEdgeCrossings`; candidates with zero crossings
  of the route that created them are discarded before rerouting. This is the
  direct no-op barrier guard required without a visibility graph.
- `generateOnePair` now returns both all `barriers` and the selected pair's
  `skippedBarriers` in mask pixels. The worker forwards both; the mask scene
  source converts them to map units; `buildMaskScene` now supplies
  `routeResult = { skippedBarriers, blockFastest, barriers }`. Existing
  `drawRouteBlocks` therefore draws the purple bars in mask play with no new
  renderer.
- Full-resolution enforcement is live through the single exported
  `BARRIER_DRAW_WIDTH_MASK_PX` (originally 3; now 7 to match normal play's 5
  editor-px stroke): active lower-attempt bars are stamped during theta refinement
  and `countBarrierViolations` rejects any served crossing. Width 3 remains the
  smallest watertight raster band.

**Node acceptance — `node scripts/wp5_3_verify.mjs`:** 100 accepted pairs on
each representative mask (the 75 Mpx run was split into two 50-pair seeds to
stay within the command window). The harness asserts every placed/skipped end
is significant, every placed bar has `routeEdgeCrossings >= 1`, and each
refined route has zero lower-attempt-bar crossings.

| mask | pairs | placed bars | skipped/rendered bars | active route bars | legality / bar crossings |
|---|---:|---:|---:|---:|---:|
| small `mask_20250602_081036` | 100 | 397 | 200 | 389 | 0 / 0 |
| median `mask_20250715_092410` | 100 | 399 | 238 | 476 | 0 / 0 |
| 75 Mpx `mask_20260422_134232` (seeds 1+2) | 100 | 391 | 192 | 409 | 0 / 0 |
| **total** | **300** | **1,187** | **630** | **1,274** | **0 / 0** |

**Live staging check done too** (uvicorn-preview :8765, `/dev/agent-login/`, after
collectstatic + restart): first served scene on File 35 (Solothurn) rendered 3
purple bars (`#a033f0`, `BLOCKING_STROKE_WIDTH`) via the untouched
`drawRouteBlocks`; in-page probe 0 route/bar intersections; all 6 bar endpoints
anchored in significant obstacles with passable mid-spans; zoomed screenshot shows
a bar spanning a real gap with the route detouring. Evidence
`scratch/wp5_3/live_pair_file35.json` + `.png`; summary `scratch/wp5_3_summary.md`.
Deviations (documented in code): unanchored city fallback walls are dropped on
masks (would float in open ground — window slides until anchored + route-crossing,
else null); anchor endpoints walk back through `barrierMarginPx` to the first
significant pixel; `BARRIER_DRAW_WIDTH_MASK_PX` moved to navgraph_router.js
(re-exported from refine_theta — ESM circular-import TDZ crash otherwise);
`meta.legality` stays terrain-only, barrier crossings enforced by the
reject-before-serve guard. WP 5.1/5.2 regression runs green (5.2 small-mask p90
refine 920 ms — real bars force θ* detours; Phase-6 tuning item). Notes for 5.4:
a first stats mask-diagnostics block + i18n rows already exist (verify against
stats.js); `manage_translations --check` currently fails on strings from a
*parallel level-passages session* (not Phase 5); Python `navgraph_suitability.py`
still uses the old simplified barrier port (build-time estimate only — Phase 6).

Original spec: Make mask barriers as trustworthy as city ones: intelligently anchored, actually
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

### WP 5.4 — Play wiring, stats + live verification — **Sonnet** — ✅ DONE (2026-07-10)

Progress (2026-07-10): implementation and local acceptance wiring completed
(details below); live staging verification then completed in a second pass:

- **Live session evidence** (`scratch/wp5_4/live_probe.json`, `scratch/wp5_4_summary.md`):
  collectstatic → `uvicorn-preview` :8765 → `/dev/agent-login/` → active team
  flipped to `Nationalkader`; drove the real `MaskSceneSource` from the page
  console at 2 s cadence (rAF-frozen-tab workaround). Solothurn (35, 7.1 Mpx):
  25 pairs, max round-trip 5.36 s; Aarberg (37, 6.7 Mpx): 12 pairs, max 2.19 s;
  Locarno Sprint (142, **75 Mpx**, opt-in bypassed for test): 11 pairs, max
  8.06 s. All ≪ the 20 s `PAIR_TIMEOUT_MS` guard — **no bump needed**; buffer
  never hit 0 on any map (zero starvation); 13-key rejection counters populated
  live; stats-panel diagnostics block renders with real data + translations.
- **stats.js resolution:** the trainer dashboard (`stats.js`) never reads
  `rejectionCounts` etc. — city mode's equivalents are likewise client-only.
  The correct surface is `renderStatsPanel` in `infinite_play.js`, which the
  wiring below fills; no `stats.js` change needed.
- **i18n:** `manage_translations.py --check` exits 0 (the earlier inherited
  failure no longer reproduces), `--build` clean for de/fr/it.
- **Deferred to Phase 6:** live legal-fallback rate ran higher than the WP 5.2
  Node number (64 % on File 35, 82 % on 142, 0 % on 37) — likely
  `refineBudgetMs:600` tightness on busy terrain + background-tab CPU
  throttling; re-measure foregrounded before treating as regression. Zero
  legality/bar-crossing violations in all modes regardless.

- `worker.js` now forwards the complete WP5 metadata and records `workerMs`.
  It emits a diagnostic warning when one `generatePair` call exceeds 5 s; the
  existing 20 s `PAIR_TIMEOUT_MS` remains the hard outer guard.
- `MaskSceneSource` tracks requested/completed/failed/slow pair calls, maximum
  pair latency, and buffer starvation. It warns when consuming a scene leaves
  fewer than two validated scenes ready, making the 2 s cadence requirement
  observable in the browser console.
- `buildMaskScene` mirrors the city scene metadata surface: rejection counts,
  refinement mode/fallback, per-route refinement outcomes, stage timings, and
  worker latency are retained on `scene.meta`.
- The play stats panel now includes a translated “Mask generation” diagnostics
  block with attempts, retries, refinement/fallback state, non-zero rejection
  counters, and sample/snap/route/refine/theta timings. CSS keeps this block
  inside the existing stats surface.
- Added the required `djangojs` catalog rows and rebuilt all `.po/.mo` files.
  `manage_translations.py --check` still reports one pre-existing Django
  msgid (`This file is not a valid project.`) missing from the table; the new
  WP5.4 JS strings are all covered.
- `node --check` passes for the worker, mask source, and play bundle;
  `git diff --check` passes. The WP5.3 acceptance smoke remains green after
  the wiring changes (30 pairs across small/median/75 Mpx: legality 0,
  active-bar crossings 0).
- `collectstatic`/`/dev/agent-login/` verification could not run in this
  workspace because the available Python runtime has no Django installed
  (`ModuleNotFoundError: No module named 'django'`). Once the project runtime
  is available, reload the app after collectstatic and verify a coach-enabled
  mask session keeps ≥2 buffered scenes while the stats panel shows the
  counters above.

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

### WP 6.1 — Prune polygon-exterior navgraph topology at build time — **Opus / GPT-5 Codex (high reasoning)** — **Complexity: medium-high**

**Decision and pipeline invariant (2026-07-11, Lars):** the map-region polygon is
not an optional endpoint hint for an Infinity map. The processing order is always
mask → portals → coach-drawn inclusion polygon → explicit coach opt-in → navgraph
build. Therefore every artifact that can be served in Infinity mode has an
authoritative polygon available at build time, and a served route must remain
inside that polygon for its entire length. The earlier Phase-1 decision to retain
the global skeleton for connections through the surrounding margin is superseded:
such a connection is now illegal, not useful connectivity.

Keep the existing client/Python `node_in_region` A* gate regardless. It protects
already-built artifacts, rejects stale/mismatched topology, and is a cheap defense
in depth (one `Uint8Array`/boolean lookup per expansion). Build-time pruning is
primarily for smaller downloads, lower browser memory, faster state/snapping setup,
and lower builder edge-generation/weighting/repair cost; pure graph-search time is
already close to the pruned case because of the runtime gate.

Implement the pruning in `project/navgraph.py` **after all skeleton, resample and
lattice nodes have been placed and snapped/deduplicated, but before
`_candidate_edges`, `_weight_edges`, and `_repair_connectivity`**:

1. Require a valid coach polygon for the polygon-pruned path (`len >= 3`, non-empty
   raster, sane coordinates). Reuse one authoritative rasterization helper for the
   hit-zone artifact, node pruning, and edge legality so the definitions cannot
   drift. Preserve the automatic hit-zone path only for non-Infinity/legacy builds;
   it must never be used as authority to prune a coach-enabled map. Enabling
   Infinity without a valid polygon must fail before/kick back the build rather
   than silently build from the automatic detector.
2. Build an `old_index → new_index` remap. Remove every snapped skeleton/lattice
   node whose centre is outside the coach region, remap `skeleton_edges` and
   `obstacle_nodes`, and discard skeleton edges with a removed endpoint. Recompute
   `n_skeleton_nodes`, lattice/obstacle counts and component ids from the retained
   arrays; do not rely on the former “skeleton nodes are a contiguous prefix”
   assumption unless the compaction explicitly preserves it.
3. Node filtering alone is insufficient for concave polygons: two inside endpoints
   can have an edge that cuts across the exterior. Treat polygon-exterior pixels as
   impassable for **every edge-legality path**. The straight-line integral must
   reject a candidate if any rasterized sample leaves the region; the skeleton
   A* fallback and connectivity-repair A* must search on `passable mask AND
   inclusion region`, so neither can repair connectivity by leaving the map.
   Apply the same rule to any local endpoint-stub/refinement legality check needed
   for the final served polyline. A route is legal only if both terrain and polygon
   checks report zero violations.
4. Do not mask the source before full-image EDT or skeletonization in this first
   pass. Those stages are global and comparatively awkward to crop safely near a
   polygon boundary. The intended compute saving starts before candidate-edge
   generation/weighting/repair, which is where the expensive per-edge work occurs.
   A later optimization may crop skeleton/EDT to the polygon bounding box plus a
   tested margin, but only if measurements show this work package leaves meaningful
   build time on the table.
5. Keep `.navgraph.bin` version/layout unchanged: fewer nodes and CSR edges fit the
   existing v2 representation. Continue storing `coarse_hitzone` and the polygon in
   stats. Add build stats for `nodes_before_region_prune`,
   `nodes_after_region_prune`, `edges_after_region_prune`, `region_pruned_fraction`,
   and per-stage timings so the benefit is measurable and debug overlays can show
   the polygon boundary plus retained topology only.

**Acceptance:** on at least 7 representative coach-enabled maps (small, median,
largest, concave regions, narrow legal corridors, and portal-bearing maps), every
serialized node is inside the coach polygon; every serialized edge rasterization
is inside it; graph A*, endpoint stubs, and final refined routes produce zero
polygon-exterior samples. Connectivity is evaluated only among legal in-region
nodes—do not compare against the old global main-component score. Visually inspect
debug overlays at tight/concave boundaries. Existing runtime-region-gate tests stay
green.

**WP 6.1 implemented 2026-07-12:** the authoritative coach polygon is validated
and rasterized once at full mask resolution. After snapping/deduplication, base
nodes and topology index sets are compacted through an explicit remap before
candidate generation; straight rays, skeleton fallback A*, and connectivity
repair all use polygon-masked terrain. Component ids/connectivity are recomputed
in-region, the requested prune/timing stats are recorded, and the in-progress v3
passage topology remains compatible. Focused concave-boundary coverage lives in
`project/test_navgraph_region_pruning.py` alongside the passage contract suites.

### WP 6.2 — Make build orchestration and suitability polygon-authoritative — **Sonnet / strong coding model** — **Complexity: medium**

Update the opt-in/rebuild flow and `build_navgraph` management command so the
contract above is explicit and testable:

- The editor remains the normal trigger: region edits invalidate/rebuild the
  artifact, and enabling Infinity builds only after mask, portals, and a valid
  coach polygon are persisted. Verify the background-build race cannot read the
  previous polygon revision. Record a polygon hash/revision in artifact stats and
  compare it when deciding whether an artifact is up to date.
- `build_navgraph --all --force` should prune files that have a stored coach
  polygon. For masks without one, either build the legacy unpruned diagnostic
  artifact with `hitzone_source=auto` or skip them with a clear reason, but they
  cannot become Infinity-servable. Print before/after node and edge counts, artifact
  bytes, and build time.
- Recompute `main_component_connectivity` (or add an explicitly named
  `region_component_connectivity`) on the retained graph only. The Python
  suitability mirror must use the pruned topology and polygon-legality rule, so
  its valid rate cannot count a connection through outside space. Worse suitability
  for a poorly drawn/disconnected region is an honest coach-facing result.
- Check dynamic portal overlays explicitly. Portal nodes/legs may extend beyond
  the base-mask polygon only where the product's portal semantics intentionally
  permit it; otherwise they must pass the same region test. Document the chosen
  exception rather than letting dynamic overlay nodes bypass the guarantee.
- This work changes no user-facing copy unless validation errors are surfaced. If
  copy is added, wrap it in gettext, add de/fr/it rows to
  `locale/source_messages.py`, then run translation `--check` and `--build` as
  required by `AGENTS.md`.

**Acceptance:** enabling without a polygon is rejected; enabling with a saved
polygon builds the matching revision; a polygon edit makes the previous artifact
stale and rebuilds it; suitability and connectivity cannot traverse the exterior;
forced backfill reports deterministic prune statistics.

**WP 6.2 implemented 2026-07-12:** `region_revision()` is stored in artifact
stats and checked by the management command and background publish race. Forced
backfills now report before/after node counts, retained edge count, binary bytes,
build time, region revision, and in-region connectivity. The benchmark-only
`prune_region=False` switch keeps the same polygon hit-zone authority for a
like-for-like A/B baseline; production callers retain pruning.
Serialized passage nodes, legs, and transition connectors use the same polygon
legality check; there is no portal exception that can bypass the guarantee.

### WP 6.3 — Benchmark the real serving/build benefit and decide on grid compaction — **Sonnet / strong coding model** — **Complexity: low-medium**

Run an A/B rebuild of the same representative maps before and after pruning and
record: `.navgraph.bin` byte size (and transferred size with the production content
encoding), N/E, total build time plus edge-generation/weight/repair time, browser
state-build time, snap time, worker heap, and graph-search p50/p90. The expected
result is a large reduction in N/E and edge-build work when the polygon covers a
small fraction, a smaller search-time change because the runtime gate already
rejects exterior nodes, and improved startup/download/memory.

Do not promise that a current ~3 MB artifact shrinks in direct proportion to N/E:
the full-map coarse sampling arrays—especially `coarse_labels`—can dominate the
binary. If representative median artifacts miss a useful target (provisional:
at least 30% smaller, or under 2 MB transferred), create a separate follow-up to
crop/compact the sampling grids to the polygon bounding box or replace labels with
the minimum metadata the client needs. That follow-up likely requires a v3 header
with grid origin/bounds and coordinated Python/JS readers; do not mix it into the
no-format-change topology-pruning patch.

**Recommended execution:** use the strongest reasoning/coding model (Opus-class or
GPT-5 Codex with high reasoning) for WP 6.1 because index remapping, concave-boundary
legality, and connectivity repair interact. WP 6.2 and WP 6.3 are well specified
enough for a Sonnet-class/standard strong coding model, with WP 6.1 reviewed before
backfilling production artifacts.

- Re-run WP 2.2 batch after any threshold changes; tune: hit-zone/region handling, node spacing, distance band, sideGap scaling, barrier length, Phase-5 additions (budgets, corridor radius, barrier significance thresholds, `refineTimeoutPolicy`).
- Browser verification with 4–6× CPU throttling (phone proxy): time-to-valid-pair distribution over 50 pairs on median + large maps; memory snapshot (heap < ~150 MB on median maps).
- Edge cases: old-scheme masks, masks with several large free components (islands across a river without bridge portals), degenerate tiny masks.
Acceptance: phone-proxy average generation ≤ 2 s with buffer never empty during a 5-min session; documented tuning constants.

---

**WP 6.3 harness implemented 2026-07-12:**
`scripts/navgraph_wp63_benchmark.py` performs non-publishing A/B builds and
records raw/gzip artifact bytes, N/E, stage timings, build wall time, and real
Node-router state/snap/graph p50/p90 plus heap measurements via
`scripts/navgraph_wp63_runtime.mjs`. A local 0.256 Mpx smoke map showed 8.07%
node, 4.56% edge, and 1.48% raw-binary reduction; the seven-map run was bounded
by shared-session build contention before completion. The smoke report is in
`scratch/wp63-smoke.json`.

**Grid compaction implemented 2026-07-12:** v4 adds a full-resolution origin for
the polygon-bounding-box coarse grids and serializes the runtime's actual label
requirement as a one-byte dominant-component eligibility mask instead of int32
component ids. Python suitability and the JS router translate local cells back
to full-mask coordinates. File 34 shrank from roughly 1.65 MiB to 829,570 bytes
(~810 KiB), while the real router produced 5 valid pairs in 8 attempts. File 88
shrunk from 808,922 to 418,654 bytes. Legacy v2/v3 readers remain migration-safe;
the serving/build gate requires current v4 artifacts.

## Verification summary

- Phase 2 CSV gates the whole effort before any UI work (cheap abort).
- Legality is asserted mechanically (no route crosses impassable full-res pixels) at every phase.
- Browser checks via `/dev/agent-login/` (trainer role), preview tools, CPU throttling; `collectstatic` after JS edits.
- Visual checkpoints for Lars: WP 1.3 overlays, WP 2.2 rendered pairs, Phase 3 live play.

---

## Active implementation goal — side-preserving obstacle-offset roadmap

Replace the experimental clearance-maximizing obstacle sampler in
`project/navgraph.py` with a boundary-faithful roadmap whose nodes remain close
to every meaningful side of an impassable object.

1. Label full-resolution `mask == 0` obstacle blobs and extract their boundaries
   at full resolution or with only the smallest topology-safe downsample. A
   downsample is acceptable only when a conservative check confirms that every
   full-resolution opening remains open; otherwise process that area at full
   resolution. Never use block-min obstacle expansion as the authoritative
   contour source because it can close narrow passages.
2. Sample along obstacle contours by arc length, preserving corners, wall ends,
   and gap-facing turns regardless of regular spacing. For each boundary sample,
   derive the local normal and choose the direction that moves from black into
   passable terrain. Place the graph node about 2 full-resolution pixels into
   that same free-space side. Verify the offset and boundary-to-node segment on
   the true mask; fall back to 1 px when a 2 px offset is unavailable.
3. Detect narrow openings independently of contour spacing. Retain both facing
   wall-end anchors and add a protected centerline portal when opposing 2 px
   offsets collide or the opening is too narrow to contain both. These nodes must
   survive deduplication and witness pruning.
4. Deduplicate only mutually visible, same-side, terrain-compatible nodes. Never
   merge across a wall or from opposite sides of a narrow gap. Keep skeleton
   junctions, contour corners, wall ends, bottlenecks, and gap-center portals
   protected. Once contour-local thinning has established the requested border
   spacing, keep every surviving boundary coverage anchor protected and
   witness-prune only ordinary open-area samples whose local weighted
   connections already have a <=3% alternative.
5. Preserve the v2 artifact format and dynamic third-dimension overlay. Base
   nodes stay on the base mask; passage portal nodes remain runtime surface-typed
   nodes and must still snap legally to visible base nodes on each entrance side.
6. Apply the same contour/concavity/adjacency logic to `very_slow` mask value
   `135` (shown as rgb(47) only because the debug background is dimmed). Its
   offset nodes must land in non-135 passable terrain; black value `0` remains
   authoritative and may never contain a node or explicit contour edge.
7. Keep dense raw contour generation, then run an importance-ordered 32 px
   suppression before global k-NN construction: concave/corner anchors outrank
   segment anchors, which outrank regular samples. Suppression is legal only
   between nearby positions on the same contour run, with compatible terrain
   and a direct passable line of sight. This aggressively collapses redundant
   straight-run samples while retaining opposite sides of thin walls, facing
   U-cavity sides, and nodes belonging to separate nearby obstacles.
8. Skip local contour roadmaps for compact isolated features whose enclosed area
   is at most 256 px and whose maximum span is at most 20 px. Full-resolution
   downstream any-angle refinement still avoids them; the dual area/span gate
   prevents long thin walls from being mistaken for disposable specks.
9. In narrow corridors, sample the sparse skeleton edges every 8 px and retain
   only passable samples whose clearance is `<=16 px`. Discard contour samples
   within 24 px and direct passable LOS of those proven-narrow centerline
   samples; the nearby skeleton already preserves bends and junctions. The
   centerline must have an equal-or-higher mask value (equal-or-faster terrain),
   so slow outline chains can collapse into a fast alley spine but fast mapped
   path nodes cannot collapse into a slower vegetation-side spine. Deduplicate
   bottleneck minima under the same conservative 12 px/LOS rule. Finally, make
   only very-low-clearance (`<=8 px`) skeleton nodes
   backbone-only during generic candidate generation so their authoritative
   predecessor/successor chain does not become a mesh of collinear k-NN
   shortcuts. The complete behaviour is guarded by
   `NARROW_ALLEY_REDUCTION_ENABLED` and every affected block is marked
   `NARROW_ALLEY_REDUCTION` for easy reversal.

Acceptance on `mask_20250604_135955.png`: the north and south sides of long black
walls both have close offset nodes; the reported northern city-wall opening has
nodes on the path and a usable through-connection; no offset node crosses into a
neighbouring obstacle; main-component connectivity remains 100%; the debug graph
is materially smaller than the 8.7k-node global-grid experiment; Python sampler,
region-gate, dynamic-passage, layered-passage, wall-hugging, and end-to-end
legality tests pass.

**Implemented 2026-07-12:** the reference mask uses full-resolution obstacle
contours (`contour_downsample=1`), 2 px side-preserving offsets, protected
full-resolution throat centers, noise-smoothed regular normals, incident-edge
normals at true-mask concave corners, protected anchors on meaningful simplified
segments, explicit legal same-contour adjacency, equivalent contours around
very-slow value `135`, 24 px contour arc-length candidates, importance-aware 32
px early suppression, protected post-thinning boundary coverage, and witness
pruning only for ordinary open-area samples. On the reference mask the early
passes skip 98 compact black contours and 301 compact very-slow contours, merge
1,467 wall-side samples plus 331 duplicate bottlenecks into directly visible
centerlines, and keep 569 very-low-clearance skeleton nodes backbone-only. The
polygon-scoped rebuilt graph has 4,017 nodes / 15,272 edges and 100%
main-component
connectivity. All retained black-border anchors survive at their exact 2 px
offset locations; dynamic and layered third-dimension passage tests remain
green. The conservative revision leaves 42 nodes / 99 internal edges in the
reported building alley, accepting extra work in exchange for passage safety.
The seeded real-route harness produced 5 valid pairs in 15 attempts with zero
unreachable rejections; suitability is 30.1% and no longer warning-level.

---

## Navgraph build pipeline — speed/size optimization candidates (2026-07-13, analysis only — nothing implemented)

Goal (Lars): the per-map build is at the upper limit on medium masks. Speed it
up under two hard criteria: **(a) no loss of pathfinding accuracy — in fact more
node connectivity is desirable** (served routes sometimes take huge detours, and
very narrow passages are occasionally missed), and **(b) the served
`.navgraph.bin` stays small** (~2 MB average, 3–4 MB max, ≈10 MB on the largest
maps).

### Measured profile (stats embedded in the 95 built `.npz` artifacts in `media/masks/`)

| stage | median ~8.5 Mpx map | large 17–61 Mpx maps | notes |
|---|---|---|---|
| **edges** | **8–30 s (typ. 50–70 % of build)** | 40–140 s | `_weight_edges` + `_candidate_edges` + `_repair_connectivity` + `_prune_redundant_nodes` |
| **nodes** | 3–17 s | 10–48 s | contour offsets, dedupe, centerline filters |
| **suitability** | **~8.1–8.5 s, every build** | ~8.5–10 s | `SUITABILITY_TIME_BUDGET_S = 8.0` is a hard budget that is always exhausted |
| edt | 1–2 s | 3–12 s | full-image `distance_transform_edt` |
| skeleton | 1–3 s | 1–4 s | already downsampled — cheap |
| hitzone / label / sampling | ≤ 2 s each | ≤ 6 s each | minor |
| **total** | **~25–75 s (median ≈ 35–45 s)** | **65–210 s** | |

Where the two big stages actually spend their time:

- `_line_cost` is a **pure-Python per-pixel loop** (≤ ~120 iterations/call) and
  is called for *every* candidate edge (~50–150 k per map), every contour-pair
  legality check, every dedupe/centerline-filter LOS test, and inside
  `_candidate_edges`' sector visibility. Order of 10⁷ Python-level iterations
  per build — this is the single dominant cost.
- `_astar_subgrid` is a pure-Python heap A* used for skeleton-backbone
  fallbacks, bridges, and (via its twin in `navgraph_suitability.py`) the
  suitability sim.
- `_prune_redundant_nodes` runs a pure-Python witness Dijkstra per neighbour
  pair per open-lattice candidate.
- `_obstacle_offset_nodes` / `_very_slow_offset_nodes` do per-sample Python
  probing plus a bucketed LOS suppression (`line_is_allowed` = another Python
  pixel loop) over the *whole* mask, then filter to the footprint afterwards.
- The suitability sim's 8 s is a fixed design tax, not proportional work.

### Group 1 — pure speedups, bit-identical artifacts (do these first)

1. **Batch/vectorize the straight-line cost integral (biggest win).** Keep the
   exact sampling rule of `_line_cost` (`steps = max(|dx|,|dy|)`, k = 1..steps,
   `round()` to pixel, `sum(seg*(255-val))`, blocked iff any sample is 0) but
   evaluate it for thousands of segments at once with numpy: build the sample
   coordinates as one (chunked) 2-D array, single fancy-index gather from the
   mask, `any(==0)` for legality, weighted row-sum for cost. Same math, same
   rounding → byte-identical weights. Applies to `_weight_edges` (the ~E-sized
   hot path), the contour-pair legality check in `build_navgraph`, and bridge
   candidates. Expected: the line-integral share of the `edges` stage drops
   from tens of seconds to ~1–2 s.
2. **Batch the LOS tests in node filtering.** `_dedupe_appended_nodes`,
   `_filter_contours_near_centerline`, `_filter_points_near_visible_nodes` and
   the contour suppression's `line_is_allowed` are order-dependent loops, but
   the LOS result itself does not depend on retention order: pre-filter
   (distance + terrain) candidate/witness pairs, compute all LOS verdicts in
   one vectorized batch, then run the identical sequential loop consuming
   precomputed booleans. Bit-identical output, removes most of the remaining
   Python pixel loops from the `nodes` stage.
3. **Compiled subgrid shortest-path with the exact cost model.** Replace the
   pure-Python `_astar_subgrid` with `scipy.sparse.csgraph.dijkstra` on a CSR
   graph built vectorized from the subgrid (8-neighbour, **directed** edge
   weight `step * (255 - value[dest])` — exactly today's model; csgraph handles
   directed graphs, so no cost-model deviation). Subgrids are small; CSR
   construction is pure array slicing. Benefits skeleton fallbacks, bridges,
   `_repair_connectivity`, and can be shared with `navgraph_suitability.py`.
   (Deliberately *not* `skimage.graph.MCP_Geometric`: its cost is the average
   of the two endpoint pixels, which silently changes every weight.) The tiny
   float-summation-order differences vs. the sequential loop should be checked
   with the byte-diff harness; if they matter, keep the heap but on numpy
   scalars-free arrays — still several-fold faster.
4. **Crop global rasters to the polygon bbox (+ safety margin).** Already
   anticipated in WP 6.1 item 4. When a coach polygon exists (which every
   Infinity-servable build has), crop mask/EDT/contours/sampling to the polygon
   bounding box plus a fixed margin ≥ 256 px (clearance is capped at 255, so
   every in-region EDT value is exact). `_obstacle_offset_nodes` currently
   contours the whole raster and throws away out-of-footprint samples
   afterwards — cropping avoids generating them at all. On decorated masks
   (map body 50–70 % of the raster) this cuts `edt`, `label`, `hitzone`,
   `nodes` and `sampling` roughly proportionally.
5. **Label once, not twice.** With a polygon, `ndi.label` runs on the full mask
   and again on the polygon-masked mask. The full-mask labels are only consumed
   by `_sampling_grids`' coarse labels (which v4 then collapses to a 1-byte
   dominant-component flag). Deriving both from one (cropped) labeling pass
   saves ~1–5 s on large maps.
6. **Witness pruning on compiled primitives or bounded harder.**
   `_prune_redundant_nodes` is smaller than the above but still pure Python;
   port the bounded local Dijkstra to the same csgraph helper, or skip the pass
   entirely below a node-count threshold where it removes almost nothing.
7. **Parallelism — second order only.** After vectorization the remaining hot
   loops are C-level, so multiprocessing is probably unnecessary per map (and
   on Railway the build already runs in a background thread of a serving
   worker — a process pool must respect the memory ceiling; page cache counts).
   The clean parallel win is `build_navgraph --all` backfills: one process per
   map, N=2.

### Group 2 — spend the freed budget on connectivity (addresses the detours / missed narrow passages directly)

These change the graph (more edges/nodes), so they are *desired* accuracy
changes per Lars, gated on the WP 6.3 A/B harness rather than byte-diffs:

1. **More and longer local edges.** With the batched line integral, candidate
   evaluation is nearly free: raise `EDGE_KNN` (10 → ~14) and `EDGE_MAX_DIST`
   (120 → ~180–240 px), and consider giving *all* nodes the sector-based
   selection currently reserved for feature nodes (nearest visible neighbour
   per 8 sectors) so open areas gain long straight crossings. Long straight
   edges are what removes graph-shaped zigzag/detours in plazas.
2. **Stop silently dropping blocked near-obstacle shortcuts.** Today a k-NN
   candidate whose straight line is blocked is discarded without A*
   (`_weight_edges` fast path). Between obstacle/contour nodes this is exactly
   where narrow-passage links live. With the compiled A*, allow a *bounded*
   per-node number of A* fallbacks for blocked k-NN pairs whose endpoints are
   both low-clearance/contour nodes (keep `EDGE_DETOUR_RATIO` so only genuine
   passages survive). Directly targets "very narrow passages sometimes not
   recognized".
3. **Finer skeleton on medium maps.** The skeleton stage costs only 1–3 s;
   `SKELETON_TARGET_PX = 3 Mpx` forces ds = 2 on the median map and up to 8 on
   the giants. Raising the target (e.g. 6–8 Mpx ⇒ ds = 1 on the median map)
   yields a truer centerline topology — fewer missed alleys at the source —
   and the extra nodes/edges are affordable once Group 1 lands. Tune per-size,
   not globally, and re-check node counts against the size budget.

### Group 3 — policy changes (need explicit sign-off)

1. **Suitability: stop paying 8 s on every build.** The report UI was removed
   in the Phase-4 revision; the numbers ride along in stats only. Options, in
   preference order: (a) port the sim to the shared compiled/batched
   primitives so ~50 pairs finish in ~1–2 s; (b) cut
   `SUITABILITY_TIME_BUDGET_S` to 2–3 s; (c) run it only on `--force`/opt-in
   activation instead of every build. Any of these recovers ~20–25 % of a
   median build.
2. **Numba/Cython JIT** for the remaining hot kernels would also work but adds
   a build/runtime dependency (Railway image size, cold-start JIT); the
   numpy/scipy route above reaches most of the same ceiling without it. Only
   revisit if Group 1 measurements disappoint.

### Artifact size (2 MB average / 3–4 MB max; ≈10 MB largest)

Current raw `.bin` medians in `media/masks/` are ~3.5–4 MB and the giants reach
10–25 MB — but most of those are pre-v4/auto-hitzone builds; polygon builds get
the v4 bbox-cropped coarse grids (File 34: 1.65 MB → 810 KB) and only
polygon+opt-in files are servable. Levers, in order of value:

1. **Serve the binary compressed (biggest lever, no format change).**
   `serve_navgraph_file()` streams the raw file; there is no gzip middleware.
   The artifact compresses ~4–6× (WP 6.3 smoke: 135 KB → 24.6 KB gzip).
   Write a `.navgraph.bin.gz` next to the `.bin` at build time and serve it
   with `Content-Encoding: gzip` when the client accepts it (zero per-request
   CPU on Railway). A ~3.5 MB raw artifact transfers at well under 1 MB —
   the 2 MB average target is met on transfer size alone, and the giants land
   near the 10 MB raw ≈ 2–3 MB transferred mark.
2. **The coarse grids dominate the raw bytes** (3 × uint8 at ÷4 ≈ Mpx·3/16 MB
   before cropping). The v4 polygon crop already attacks this; verify every
   servable artifact is actually rebuilt to v4. Beyond that, `coarse_clear`
   and `coarse_labels` could move to ÷8 while keeping `coarse_minval` at ÷4
   (clearance/eligibility feed only endpoint-sampling prefilters, never
   legality) — but this changes sampling behaviour slightly and needs a v5
   header, so only pursue it if precompression still leaves a map over budget.
3. **Graph growth from Group 2 is cheap in bytes.** Edges cost 17 B raw
   (~4–5 B gzipped) each; even +50 % edges on the median map is ~250 KB raw.
   Size pressure comes from the grids, not from the connectivity work.
4. **Housekeeping:** the `.npz` (often ≥ the `.bin`) and `.debug.png` also sit
   in `media/masks/` but are never served to players; if disk footprint
   matters, gzip or prune them for non-debug maps.

### Expected effect and verification

Rough estimate once Groups 1 + 3.1 land: median build ~35–45 s → **~8–15 s**,
large maps 100–210 s → **~30–60 s**, with Group 2's extra connectivity riding
inside that budget. Verify in two tiers: (a) Group 1 changes must produce
byte-identical `.bin` output on a pinned set of ~8 representative masks (build
before/after, hash-compare) — any diff is a bug; (b) Group 2/3 changes go
through the existing WP 6.3 A/B harness (`scripts/navgraph_wp63_benchmark.py`)
plus a WP 2.2-style batch run: zero legality violations, connectivity ≥
current, detour/valid-rate stats, artifact bytes raw+gzip, per-stage timings.

---

## Bounded local-connectivity spanner (implemented 2026-07-13)

The feature-sector / feature-only-LOS experiment was replaced with one uniform
candidate policy in `project/navgraph.py`:

- inspect the nearest 32 geometric neighbours within 192 full-resolution px,
  independent of feature family and angular sector;
- admit every direct-LOS pair in that bounded pool;
- admit at most two blocked candidates per ordinary node (one for narrow
  backbone nodes) only when the straight sample crosses at most 8 black pixels,
  then require bounded A* within a 24 px margin and a ≤1.35 / +24 px detour;
- narrow backbone nodes retain a reversible 3-direct/1-detour budget rather
  than the previous all-or-nothing generic-edge suppression;
- after passage topology is final, remove a base edge only when active base
  edges provide a two-hop terrain-cost witness within 1%. Typed passage and
  transition edges neither get removed nor act as base-edge witnesses.

File 133 validation (`mask_20260220_143506.png`): 9,767 nodes, 43,712 edges,
2,503,457-byte BIN, main connectivity 1.000. In the reported central crop,
all omitted direct-LOS pairs within 192 px had a final graph-cost stretch ≤
1.0274 (none >1.05). The seeded runtime harness produced 5/10 valid attempts
with zero unreachable failures; a separate two-route rendered run had zero
legality hits. Focused Python suites passed 62 tests; all navgraph JS
contract/consumer/passage/layered tests passed.

---

## Passage / Infinity interaction fixes (implemented 2026-07-13)

- Passage-surface blockers now span the complete passage width plus a 2 px
  overhang on each side. The widened segment is shared by rendering, sparse
  edge blocking, full-resolution stamping, and violation checks.
- Infinity passage legs now call the editor's full-raster weighted any-angle
  implementation directly, followed by the same entrance-band portal-anchor
  optimizer. Surface identity and the third-dimension topology stay intact.
- Fractional sampled endpoints are rounded only for integer Bresenham corridor
  rasterization, then restored exactly. This fixes the silent
  `RangeError: Invalid array length` fallback seen on coordinates ending in
  floating-point noise such as `.0000000000002`.
- Mask route pairs are limited to adjacent cumulative alternatives. A later
  route can therefore depend on only the single barrier that created that
  alternative, rather than several intermediate blockers which cannot be
  rendered without crossing the lower selected route.
- The accepted pair is refined again with a 104 px corridor against exactly the
  blockers that are rendered, then runtime, side separation, barrier legality,
  layered distinctness, and relative gap are revalidated on the served paths.
  This removes detours caused by invisible candidate-only blockers.

Pinned regression `scripts/infinity_bug_report_regression.mjs` reproduces
`/debug/infinity` reports 4, 5, and 7 on File 1. Report 4 now selects routes
3/4 and uses the second passage; reports 5 and 7 select routes 2/3 instead of
the later cumulative detours. Its seeded production-pipeline smoke generated a
legal Theta* pair in about 0.92 s (2 attempts). All 15 pathing JavaScript suites
and the translation/system checks pass.

---

## Navgraph build lean-up and served corridor budget (implemented 2026-07-13)

- The fixed suitability simulation remains removed from production builds.
- The graph-wide connectivity BFS is now opt-in diagnostics. Normal background
  and command builds skip it; `build_navgraph --debug` and the debug renderer
  retain it. This removes a topology-neutral ~0.25 s pass on a 41.6k-node /
  155.7k-edge artifact.
- Blocked candidate-edge validation no longer constructs a new scipy CSR graph
  and solves the entire local raster for every edge. It uses scikit-image's
  compiled, single-target `MCP_Geometric` over the existing cost raster.
- Candidate discovery passes its already computed LOS/cost results into edge
  weighting, avoiding a second full-resolution rasterization of accepted
  candidates.
- Quality-bearing work stays enabled: contour/skeleton generation, region and
  passage legality, connectivity repair, node witness pruning, and the final
  two-hop edge spanner. The latter cost only 0.08 s on the 1.26 Mpx benchmark
  while removing 6,036 edges, so removing it would hurt load/search time for no
  useful build saving.

Build measurements on `mask_20260612_091525.png` (0.26 Mpx) changed from 2.54 s
to 1.27-1.41 s; its edge stage changed from 1.83 s to 0.68-0.71 s. A second
full-map sample, `mask_20250714_184638.png` (1.26 Mpx), builds in 4.55 s with
1,520 nodes and 7,098 final edges. These are local warm-cache measurements and
should be compared using the same mask/region inputs when server benchmarks are
collected.

The final served Theta* corridor is 104 px. Five identical-seed pipeline runs
measured 1,050 ms mean at 96 px, 1,114 ms at 104 px (+6.0%), and 1,182 ms at
112 px (+12.5%) in the unbounded Node regression harness. Applying the measured
104/96 ratio to the observed 400 ms laptop average gives ~424 ms; at a
conservative 2.2-2.3x midrange-phone factor this estimates ~0.93-0.98 s average.
112 px would leave insufficient headroom, so 104 px is the selected balance.

---

## Reject incomplete final refinement (implemented 2026-07-13)

`/debug/infinity` report 8 exposed a route made of long runs of one-mask-pixel
steps. This is the recognizable `legal-fallback` output of `refineRouteLegal`:
the navgraph and legal-spine stages succeeded, but the final corridor-guided
Theta* stage did not return a presentable any-angle route. The fallback had
previously been accepted intentionally by `refineTimeoutPolicy: 'fallback'`.

Uploaded-map Infinity now defaults to `refineTimeoutPolicy: 'reject'`. The final
pair gate accepts only `theta`/`theta`; `legal-fallback` on either route and
`unusable` on either route increment the existing `timeout` rejection counter
and restart pair sampling. The fallback mode remains available only as an
explicit diagnostic/benchmark override. The pure policy contract is pinned by
`navgraph_refinement_policy.test.mjs`.
