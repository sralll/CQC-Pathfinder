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

### Client flow (scene source inside infinite_play, per Lars)

Per attempt: sample pair with prefilters → snap endpoints to graph (bucketed lookup + tiny local full-res A* stubs) → graph A* → alternates 2–4 via `findSmartBarrier` port blocking crossed graph edges → existing selection (runtime gap ≤ 0.5, side split; graph cost = runtime, no NoA needed). For the accepted pair only: corridor + guided theta* at full res, re-check gap, serve. Prefetch buffer generates pairs in the worker while the user plays.

Reused as-is: `astar.js`, `theta_star.js`, `corridor.js`, `simplify.js`, `preprocess.js` (blocked-terrain overlay = barrier mechanism), `worker.js` caching. Selection logic: [infinite_play.js](results/static/results/js/infinite_play.js) `selectRuntimeRouteOptions` (~line 1674); barrier logic: [RoutePlanner.js:71](results/static/results/js/infinite/citygen/core/RoutePlanner.js) `findSmartBarrier`.

### Memory (phones)

Client holds navgraph (<1 MB) + coarse sampling grid (median ~0.5 MB); full-res mask decoded lazily only for refinement subgrids (median 8.6 MB — fine). 75 Mpx outliers gated by opt-in initially; tiled refinement later if needed.

---

# Implementation phases — work packages for execution

Each package is self-contained with acceptance criteria. "Model" = suggested agent capability (Opus = complex/algorithmic, Sonnet = well-specified/simpler). Execute in order; packages within a phase can sometimes parallelize (noted).

## Phase 1 — Server-side navgraph builder (Python)

### WP 1.1 — `project/navgraph.py` core builder — **Opus**
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

### WP 1.2 — Management command + backfill — **Sonnet**
`project/management/commands/build_navgraph.py`: args `--file <mask path or File id>`, `--all` (iterate masks in `media/masks/`), `--force`; skip if artifact newer than mask; print per-map timing + node/edge counts; `--limit N` for testing. Follow existing management-command style in the repo (see `account/management/` and `results/management/`).
Acceptance: `python manage.py build_navgraph --limit 5` produces artifacts; re-run skips them; `--force` rebuilds.

### WP 1.3 — Debug overlay visualizer — **Sonnet**
Script `scripts/navgraph_debug.py`: renders mask (dimmed) + nodes/edges (colored by weight/px) + filtered blobs highlighted, saves PNG next to artifact (`.navgraph.debug.png`). Optionally a `--pair y1,x1,y2,x2` flag drawing the graph A* path.
Acceptance: overlays generated for 8–10 varied staging masks (small/large, old/new scheme); visually: alleys have edges, trees filtered, thin walls respected. **Lars reviews these overlays — checkpoint.**

## Phase 2 — Headless validation harness (Node) — go/no-go gate

### WP 2.1 — Node harness implementing the client algorithm — **Opus**
Script `scripts/navgraph_harness.mjs` (Node, no browser). Loads `.navgraph.bin` + coarse grids + full-res mask (add `pngjs` as devDependency or decode via a small Python-exported raw file). Implements, as importable functions (they will be reused in Phase 3):
1. Pair sampling + prefilters: uniform over main-component coarse cells with clearance ≥ ~3 (coarse px) and terrain not very_slow; distance band (mirror ROUTE_PICK_MIN/MAX_DIST=40/120 map-units scaled to px via map scale — start with 500–1500 px, tune later); map-edge margin ~100 px; straight-line raycast must cross an impassable component with area above threshold.
2. Endpoint snapping: bucket grid over nodes; connect endpoint to ≤3 nearest nodes with local full-res weighted A* on a ~200 px subgrid.
3. Graph A* (binary heap, heuristic = euclid × min_cost_per_px).
4. Alternates: port `findSmartBarrier` semantics from [RoutePlanner.js:71](results/static/results/js/infinite/citygen/core/RoutePlanner.js) — find perpendicular barrier near route midpoint, temporarily remove graph edges crossing it, re-run A*; up to 4 routes total.
5. Selection: port `selectRuntimeRouteOptions` criteria from [infinite_play.js](results/static/results/js/infinite_play.js) (~1674): runtime gap ≤ 0.5 using graph cost as runtime, sideGap ≥ 10 equivalent (scale to px), opposite signs, routeside check.
6. CSV output matching the route-stress format (retries, per-attempt ms, rejection reasons, route lengths/sides) + optional SVG/PNG dump of accepted pairs for spot-checks.
Acceptance: runs end-to-end on 3 masks, produces CSV + a handful of rendered pairs.

### WP 2.2 — Batch run + analysis — **Sonnet**
Run harness on ≥ 20 staging masks × 100 pairs. Summarize per map: valid-pair rate, mean/median/p90 retries, mean ms/valid pair, rejection breakdown. Assert **zero route segments crossing impassable pixels of the true mask** (sample points along polylines). Write summary markdown to `docs/` or scratch for review.
Acceptance criteria (go/no-go, reviewed by Lars): mean retries ≤ ~5 and mean time-to-valid-pair ≤ ~1 s laptop-Node on ≥ 70 % of urban maps; zero legality violations. If side-rejections dominate, tune prefilter thresholds before proceeding.

## Phase 3 — Client integration

### WP 3.1 — Artifact serving — **Sonnet**
Serve `.navgraph.bin` alongside masks via the same authenticated path as `serve_mask_file()` in [media_access.py](project/media_access.py) (new endpoint or extend existing, mirroring its permission checks). Add URL in the relevant urls.py.
Acceptance: logged-in fetch returns the binary with correct content-type; anonymous fetch is rejected. Verify via `/dev/agent-login/` + fetch.

### WP 3.2 — Mask scene provider in the pathing worker — **Opus**
Port the WP 2.1 functions into `project/static/project/js/pathing/` (new `navgraph_router.js` + additions to `worker.js`): load/cache artifact per map (existing worker cache pattern, keyed like the grid cache at worker.js:36-51), pair generation, graph A*, barriers, selection. For the accepted pair only: corridor + guided theta* refinement reusing `corridor.js`, `theta_star.js`, `simplify.js` on full-res subgrids along the graph path (mask decoded lazily, subgrid extraction via `preprocess.js`); recompute runtimes from refined paths and re-check the gap (re-reject if now > 0.5). Message protocol: `generatePair(mapId) → {start, goal, routes[2], runtimes, meta}`.
Acceptance: from a test page or console, worker returns valid pairs on a staging mask; timings logged per stage like the existing `[theta-client]` logs.

### WP 3.3 — infinite_play wiring + prefetch buffer — **Opus**
In [infinite_play.js](results/static/results/js/infinite_play.js): introduce a scene-source abstraction (city generator = existing path; mask provider = new). Mask scenes: map raster as background (however the normal play view renders map images), pair + 2 routes from WP 3.2, same play/scoring flow (`scene.meta` fields mirrored). Prefetch buffer of ≥ 2 validated pairs filled during play; map picker listing only opt-in maps (endpoint from WP 4.1). New user-facing strings go through `locale/source_messages.py` + `python scripts/manage_translations.py --check && --build` (djangojs domain).
Acceptance: playable end-to-end on staging via `/dev/agent-login/`; buffer hides generation latency (no visible wait at 2 s cadence). Run `collectstatic` + restart before browser verification.

## Phase 4 — Opt-in + suitability

### WP 4.1 — Opt-in flag — **Sonnet** *(⚠ model change — get Lars's explicit approval first)*
Add `File.infinite_enabled = BooleanField(default=False)` (project app model that owns masks) + migration; editor UI toggle (visible when `has_mask`); endpoint listing enabled maps for the picker.
Acceptance: toggle persists; picker shows only enabled maps.

### WP 4.2 — Suitability report at opt-in — **Sonnet**
At navgraph build time (extend WP 1.1/1.2), run a lightweight pair-generation simulation in Python (mirror of the sampling+graph-A*+selection logic; N≈50 pairs) and store `{valid_rate, mean_retries, mean_ms}` in the artifact. Editor shows these next to the opt-in toggle with a soft warning below thresholds (no hard block).
Acceptance: report visible in editor for 3 test maps; warning appears on a known-bad (e.g. park) map.

## Phase 5 — Tuning + phone verification — **Opus**

- Re-run WP 2.2 batch after any threshold changes; tune: blob-filter thresholds, node spacing, distance band, sideGap scaling, barrier length.
- Browser verification with 4–6× CPU throttling (phone proxy): time-to-valid-pair distribution over 50 pairs on median + large maps; memory snapshot (heap < ~150 MB on median maps).
- Edge cases: old-scheme masks, masks with several large free components (islands across a river without bridge portals), degenerate tiny masks.
Acceptance: phone-proxy average generation ≤ 2 s with buffer never empty during a 5-min session; documented tuning constants.

---

## Verification summary

- Phase 2 CSV gates the whole effort before any UI work (cheap abort).
- Legality is asserted mechanically (no route crosses impassable full-res pixels) at every phase.
- Browser checks via `/dev/agent-login/` (trainer role), preview tools, CPU throttling; `collectstatic` after JS edits.
- Visual checkpoints for Lars: WP 1.3 overlays, WP 2.2 rendered pairs, Phase 3 live play.
