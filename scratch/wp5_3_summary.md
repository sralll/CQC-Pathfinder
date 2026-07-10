# WP 5.3 — Blocking elements without a visibility graph — summary (2026-07-10)

Mask barriers are now as trustworthy as city ones: anchored only in *significant*
obstacles, guaranteed to actually cross the route they block, rendered to the
player as the existing purple bars, and enforced at full resolution during
refinement. All five spec items of plan.md WP 5.3 are implemented.

## What was built (per spec item)

1. **Faithful `findSmartBarrier` re-port** (`navgraph_router.js findBarrier`).
   The stale pre-refactor port was replaced with the current RoutePlanner.js
   structure: probe carries `distFromPrev`/`distToNext`, narrow slide window has
   the two city tiers (`bestClearEnclosed` gated by `isClearOfRouteNodes`, then
   `bestEnclosed`), broad 0.25–0.75 fallback window. Constants px-scaled in
   `DEFAULT_CONFIG`; `barrierSlideSamples` 16→32 and `barrierFallbackSamples`
   20→30 synced to the city values. New config entries:
   `barrierAnchorMinAreaPx: 60`, `barrierElongationRatio: 8`,
   `barrierFloodCapPx: 250`, `barrierClearNodeDistPx: BARRIER_DRAW_WIDTH_MASK_PX`.

2. **Obstacle-significance test** (`inSignificantObstacle(state, x, y)`,
   exported). Raw impassable probing is gone. On an impassable hit the
   component is bounded-flood-filled (8-connected, cap 250 px — cap hit ⇒
   significant) and accepted iff `area ≥ 60` **or**
   `max(bboxW,bboxH)²/area ≥ 8` (thin walls/fences significant at any area).
   Results memoized per pixel in `state.sigMemo` (sparse Map on `buildState`).
   Off-mask still counts as wall; lone trees / symbol specks are
   barrier-invisible exactly like city hedges.

3. **Effectiveness guarantee.** Every candidate wall must (a) be anchored in
   significant obstacles on BOTH ends and (b) properly intersect ≥ 1 edge of
   the current route's polyline (`barrierCrossesRoute` over ≤ ~40 edges,
   count kept on the barrier as `routeEdgeCrossings` for auditability). The
   narrow window is tried first, then the broad window slides (enclosed probes
   nearest-center first, then remaining probes narrowest-first) until an
   effective wall is found, else `findBarrier` returns null and the attempt
   ends with the routes found so far.

4. **Serve + render.** `generateOnePair` returns `barriers` (all placed, with
   `attemptIndex`/`enclosed`/`routeEdgeCrossings`) alongside `skippedBarriers`
   (WP 5.1), both in mask px; `worker.js` forwards both in the `pair` message;
   `mask_scene_source._wrapPair` converts to map units (× TRAIN_SCALE_VALUE);
   `buildMaskScene` sets
   `scene.routeResult = { skippedBarriers, blockFastest, barriers }`. The mask
   render branch already calls `drawRouteBlocks` in all three paths
   (`renderScene`, `buildRenderedScene`, the route-animation redraw), so the
   purple bars render with **zero new drawing code** — verified live.

5. **Full-res enforcement + single width source.**
   `BARRIER_DRAW_WIDTH_MASK_PX` (=3) is the one constant behind (a) WP 5.2's
   subgrid stamping, (b) the `countBarrierViolations` legality band asserted on
   every served route against its active (`attemptIndex < routeIndex`)
   barriers — a violating pair is rejected, never served — and (c) the
   `isClearOfRouteNodes` gate. The constant's **definition moved** from
   refine_theta.js to navgraph_router.js (re-exported from refine_theta for
   WP 5.2 consumers): the two modules import each other, and referencing it at
   module-init from the non-root side crashes with an ESM TDZ ReferenceError
   when refine_theta is the import entry (reproduced in Node, fixed, both
   orders tested).

## Deviations from spec (documented in code)

- **Unanchored fallback walls dropped.** The city keeps width-minimising
  fallback walls that may dangle in open space (`bestFallback`/`broadFallback`);
  the vis graph still blocks them. On masks an unanchored bar would render as a
  purple line floating in open ground and violate the acceptance ("both ends
  anchored"), so the mask port requires anchoring on both ends and instead
  slides the probe window further. Practical effect: slightly fewer barriers on
  wide-open routes, each one guaranteed meaningful.
- **Anchor walk-back.** `barrierMarginPx` pushes endpoints deeper into the
  obstacle; a fence thinner than the margin would land the endpoint back in
  open ground. The endpoint walks back to the first significant pixel so the
  *returned coordinates themselves* pass the significance test.
- **`routeEdgeCrossings` audit field** on each placed barrier (cheap; lets the
  verify harness prove no placed bar was a no-op).
- **`BARRIER_DRAW_WIDTH_MASK_PX` = 3, not round(1/0.710)=1** — WP 5.2's
  watertightness deviation, unchanged.
- **meta.legality stays terrain-only.** Barrier crossings are enforced by the
  `countBarrierViolations` guard (reject-before-serve) rather than folded into
  the same counter; served pairs therefore have zero of both by construction,
  and the verify harness asserts both independently.

## Acceptance — Node (scripts/wp5_3_verify.mjs, seed 1, 100 pairs/mask)

| mask | pairs | placed bars | skipped (rendered) bars | active-route bars | anchor failures | no-op bars | active-bar crossings | true-mask legality |
|---|---|---|---|---|---|---|---|---|
| small (mask_20250602_081036) | 100 | 397 | 200 | 389 | 0 | 0 | 0 | 0 |
| median (mask_20250715_092410) | 100 | 399 | 238 | 476 | 0 | 0 | 0 | 0 |
| 75 Mpx (mask_20260422_134232) | 100 | 382 | 191 | 412 | 0 | 0 | 0 | 0 |
| **total** | **300** | **1178** | **629** | **1277** | **0** | **0** | **0** | **0** |

(Final post-refactor run; wall time 43.3 s / 42.7 s / 105.2 s per mask, laptop
Node. Each mask produced its 100 valid pairs in exactly 100 generateOnePair
calls — no call failed to converge. 75 Mpx bar counts vary by ±3 between runs —
per-route time budgets make deep-attempt exploration timing-sensitive there;
every assertion is zero-violation on every run.)

Every bar endpoint (placed AND skipped/served) re-asserted through
`inSignificantObstacle`; every placed bar has `routeEdgeCrossings ≥ 1`; both
served routes checked against their active bars with `countBarrierViolations`.
Results JSON: `scratch/wp5_3/wp5_3_results.json`.

## Regression checks

- **WP 5.2 verify re-run** (now with real barrier pressure): 220 pairs,
  legality 0, active-bar crossings 0 (stamped-band AND geometric),
  refined ≤ legal 433/433 = 100 %, θ* fail reasons only `timeout:7` on the
  75 Mpx outlier. p90 refine/pair: small 920 ms, median 723 ms, 75 Mpx 1274 ms —
  small drifted above the ~800 ms guideline (was 772 ms) because refinement now
  stamps real bars and θ* detours around them; 75 Mpx *improved* (1413→1274).
  Correctness gates all green; timing trim is Phase 6 (budget/radius).
- **WP 5.1-style batch smoke** (median mask, 40 pairs, seed 7): legality 0,
  meanRetries 1.8, meanMs/valid ~340, medRelGap 0.102, 13-key taxonomy intact,
  `timeout:0`. **Seeded reproducibility**: two identical-seed runs produce
  byte-identical pair CSV (geometry + runtimes).

## Live verification (staging DB, uvicorn-preview :8765, /dev/agent-login/)

Setup: `collectstatic` + server restart; agent's `active_team` flipped to
Nationalkader (the two `infinite_enabled` maps, Files 35/37, live there; the
dev login resets the team to Agents on every login — flip after login).
URL: `/play/infinity/?source=mask&file=35&filename=20250605_114059.jpg`.

- First served scene on File 35 (Solothurn) rendered **3 purple bars**
  (stroke `#a033f0` = CONTROL_COLOR, stroke-width 1 = BLOCKING_STROKE_WIDTH) in
  `#rp-route-layer` — i.e. `blockFastest` pair, drawn by the untouched
  `drawRouteBlocks`.
- In-page probe: **0 segment intersections** between the two served route
  polylines (50/39 pts) and the 3 bars.
- Bars re-checked in Node against the true File-35 mask (÷ TRAIN_SCALE_VALUE):
  all **6 endpoints anchored in significant obstacles**, and the middle of each
  bar spans passable terrain (15/17, 13/17, 8/17 passable mid-samples) — each
  bar genuinely covers a passage.
- Zoomed screenshot (rotation-group transform probe): bar spans exactly from a
  building corner to the olive-area border, blocking the gap; the nearby route
  visibly passes around it. Evidence: `scratch/wp5_3/live_pair_file35.json`
  (bars/controls/routes from the SVG DOM) +
  `scratch/wp5_3/live_pair_file35.png` (the same live pair re-rendered over the
  true mask: red/blue detouring routes, orange bars plugging the mid passages).
- rAF-frozen-tab caveat hit on the re-check after the statics rebuild (page
  stuck pre-render in a hidden tab, documented repo limitation) — worked around
  by driving the deployed `worker.js` directly from the page:
  `navgraphReady` ack 4569 nodes / 13543 edges, seeded `generatePair` → pair
  with 4 placed bars (fields `attemptIndex`/`enclosed`/`routeEdgeCrossings=1`),
  3 skippedBarriers, legality 0, refineMode `theta`, 13 rejection keys.

## Taxonomy / meta changes

- **No new rejection keys** — the 13-key taxonomy is unchanged. Barrier-crossing
  legal-fallback pairs still bucket as `timeout` (WP 5.2's guard, now much rarer
  since θ* stamps the real bars).
- `pair` message gains **`barriers`** (all placed bars, mask px, with
  `attemptIndex`, `enclosed`, `routeEdgeCrossings`).
- `scene.routeResult = { skippedBarriers, blockFastest, barriers }` on mask
  scenes (map units) — same shape the city renderer reads.

## Files changed (WP 5.3 scope)

- `project/static/project/js/pathing/navgraph_router.js` — significance test +
  memo, findBarrier re-port with anchoring/effectiveness, new DEFAULT_CONFIG
  entries, `BARRIER_DRAW_WIDTH_MASK_PX` definition (moved here),
  `generateOnePair` returns `barriers`.
- `project/static/project/js/pathing/refine_theta.js` — constant now imported
  from navgraph_router and re-exported (TDZ fix); stamping/violation logic
  unchanged.
- `project/static/project/js/pathing/worker.js` — forwards
  `barriers`/`skippedBarriers`; slow-pair console warn (>5 s).
- `results/static/results/js/infinite/mask_scene_source.js` — `_wrapPair`
  converts both barrier arrays to map units; source-side pair metrics.
- `results/static/results/js/infinite_play.js` — `buildMaskScene` sets
  `scene.routeResult`; stats-panel mask diagnostics block (+ play.css styles,
  + locale rows, built).
- `scripts/wp5_3_verify.mjs` — acceptance harness (new).
- Evidence: `scratch/wp5_3/` (results JSON, live pair JSON/PNG, repro CSVs).

## Handoff to WP 5.4

- `meta.rejectionCounts`, `meta.refineMode`, `meta.refineFallback`,
  `meta.refine[2]`, `meta.timings.{sample,snap,route,refine,theta}` and
  `meta.workerMs` all ride the `pair` message and are already copied into
  `scene.meta` by `buildMaskScene`; a first stats surface (mask diagnostics in
  the play stats panel + i18n rows) exists — 5.4 should verify it against
  stats.js expectations and thread anything missing.
- `PAIR_TIMEOUT_MS` interplay: worker warns above 5 s/pair; `MaskSceneSource`
  tracks `metrics.{requested,completed,failed,slow,starved,maxPairMs}` and
  warns when the buffer drops below 2.
- Live session caveats for 5.4's full run: use `127.0.0.1` (not localhost),
  re-flip the agent's team after every `/dev/agent-login/` (login resets it to
  Agents), keep the preview tab foregrounded or probe via a page-driven worker
  (rAF freeze).
- i18n: `manage_translations --check` currently FAILS on strings from the
  parallel level-passages/3rd-dimension session (`'Finish'`, `'Add passage'`,
  `'3rd dimension'`, …) — NOT from Phase 5. All Phase-5 strings have rows and
  built catalogs.
- Python `navgraph_suitability.py` still carries the old simplified barrier
  port (build-time estimate only; acceptable drift — flag for Phase 6 if the
  suitability numbers should track the new placement).
