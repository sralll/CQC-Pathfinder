# WP 5.2 — Corridor + guided θ* refinement of served routes — DONE (2026-07-10)

Full-quality any-angle terrain-weighted refinement of the accepted pair's two
routes (outside the retry loop), reusing the editor modules verbatim. Legal spine
(`refineRouteLegal`) → subgrid → barrier stamping → `corridorMask` → `applyCorridor`
→ `guidedThetaStar` (switch 10, budgeted) → `simplifyThetaPath` (10°, 5 px).

## Files changed

- **NEW `project/static/project/js/pathing/refine_theta.js`** — the whole WP 5.2
  module. Exports `refineRouteTheta`, `countBarrierViolations`, `activeBarriersFor`,
  `BARRIER_DRAW_WIDTH_MASK_PX`.
- `project/static/project/js/pathing/navgraph_router.js` —
  - `DEFAULT_CONFIG` += `corridorRadius: 24`, `refineBudgetMs: 600`,
    `refineTimeoutPolicy: 'fallback'`.
  - `import { refineRouteTheta, countBarrierViolations } from './refine_theta.js'`
    (circular but function-body-only → safe live bindings in Node + worker).
  - `computeRouteOptions`: each placed barrier tagged `barrier.attemptIndex = rec.routeIndex`.
  - `generateOnePair`: refinement now calls `refineRouteTheta` per selected route;
    timeout/fallback policy coordination; **barrier-legality guard**; θ*-refined
    runtimes drive the gap re-check + balance reject (unchanged position); new
    `meta.refineMode` / `meta.refineFallback` / `meta.refine[]` / `timings.theta`.
- `project/static/project/js/pathing/theta_star.js` — `guidedThetaStar` gains an
  optional 8th param `deadlineMs = null` (pop-loop abort every ~1024 pops). Editor
  path (`pipeline.js`, 7 args) unaffected.
- `project/static/project/js/pathing/worker.js` — `[theta-client]` generatePair OK
  line now logs `refine=<mode>` and `theta <ms>` alongside `refine <ms>`.
- **NEW `scripts/wp5_2_verify.mjs`** — acceptance harness (below).

`pipeline.js` (editor) untouched; `refine_theta.js` + `navgraph_router.js` stay
Node-clean (verified: import test + full Node harness run).

## `refineRouteTheta` signature / return (for WP 5.3 / 5.4)

```js
refineRouteTheta(state, path, barriers, opts) -> {
  path,          // served polyline (θ* on success, legal spine on fallback), full-res {x,y}[]
  cost,          // Σ lineCost of `path` on the TRUE mask
  mode,          // 'theta' | 'legal-fallback' | 'unusable'
  legalPath, legalCost,     // the legal spine (always present) + its cost
  thetaCost,     // raw θ* cost or null (θ* failed) — for the ≤-legal metric
  thetaFail,     // failure-reason string when θ* failed: 'snap'|'timeout'|'nopath'|'clip'|'truemask'|'cost'|'tiny'|'error'
  activeBarriers,// barriers with attemptIndex < routeIndex (the ones stamped)
  routeIndex, tRefine, tTheta
}
// opts: { routeIndex, corridorRadius?, budgetMs?, now? }
```

Timeout/failure coordination lives in `generateOnePair`:
- `refineTimeoutPolicy: 'fallback'` (default): θ* miss on **either** route → serve
  **both** as legal spine (same cost basis); pair only rejects (`timeout`) if a
  legal spine is `unusable`.
- `'reject'`: any θ* miss rejects the pair as `timeout` (strict city-style).
- Counted either way: `meta.refineFallback` (0/1), `meta.refineMode`.

## Barrier-rasterization interface (implemented now; WP 5.3 consumes)

- `BARRIER_DRAW_WIDTH_MASK_PX` — the **single** exported enforcement-width constant,
  used by (a) subgrid stamping here and (b) `countBarrierViolations`. WP 5.3 item 5
  should extend the served-route legality assertion with `countBarrierViolations`.
- `countBarrierViolations(path, barriers, width=BARRIER_DRAW_WIDTH_MASK_PX)` — the
  barrier analogue of `countLegalityViolations` (stamped-band sampling). Ready for
  WP 5.3's "visuals and routing cannot drift apart" invariant.
- Stamping filter: barriers with `attemptIndex < routeIndex` (`activeBarriersFor`).
  `computeRouteOptions` now tags `barrier.attemptIndex`; `skippedBarriers` objects
  carry it too.

## `meta` additions WP 5.4 must thread through

- `meta.refineMode` — `'theta' | 'legal-fallback'` (both served routes share a basis).
- `meta.refineFallback` — 0/1 (count of pairs served as legal spines).
- `meta.refine[2]` — per served route `{ mode, thetaCost, legalCost, thetaFail,
  routeIndex, activeBarriers }`.
- `meta.timings.theta` — new per-stage ms alongside `refine` (legal spine ms).

## Acceptance (Node, laptop; seed 1; `node scripts/wp5_2_verify.mjs`)

3 size-varied masks, **220 accepted pairs** (small 90 / median 90 / 75 Mpx 40):

| mask | accepted | legality | bar-cross (band / geom) | refined ≤ legal | p90 refine/pair | mean |
|---|---|---|---|---|---|---|
| small `mask_20250602_081036` (~1.2 Mpx) | 90 | 0 | 0 / 0 | 180/180 | 772 ms | 382 ms |
| median `mask_20250715_092410` (~5.7 Mpx) | 90 | 0 | 0 / 0 | 178/178 | 885 ms | 429 ms |
| 75 Mpx `mask_20260422_134232` | 40 | 0 | 0 / 0 | 74/74 | 1413 ms | 691 ms |
| **total** | **220** | **0** | **0 / 0** | **432/432 = 100 %** | — | — |

- **Legality on the true mask: 0** (all served routes).
- **Drawn-bar crossings: 0** by both the enforced stamped-band check and the
  stricter geometric segment-intersection check.
- **Refined runtime ≤ legal-spine runtime: 100 %** of θ*-refined routes (θ* only
  improves).
- **p90 refine/pair:** small under ~800 ms; median ~885 ms (≈ target, within
  run-to-run Node variance — repeated runs of the identical seeded work ranged
  560–950 ms depending on machine load); **75 Mpx ~1.4 s** — the acknowledged
  extreme outlier (plan gates it behind opt-in). Phase 6 can trim it via
  `refineBudgetMs` / `corridorRadius`.
- `[theta-client]` timings extended with `theta`. Spot-check PNGs (4/mask) in
  `scratch/wp5_2/*.wp52.pair*.png` — smooth any-angle polylines hugging terrain,
  clean L/R splits, routes detouring around the orange barriers.

## Deviations from spec (all documented in code)

1. **`BARRIER_DRAW_WIDTH_MASK_PX = 3`, not the naive `round(1.0/0.710)=1`.** The
   stamp radius is `floor((w-1)/2)`, so widths 1 **and** 2 both stamp a single
   hairline whose 8-connected diagonal steps leave sub-pixel gaps — a θ* segment
   can geometrically cross the drawn bar while threading a corner touch-point
   without sampling a 0-pixel (measured 24 such crossings at width 1). Width 3
   (r = 1) is the smallest watertight band this stamp produces; crossings → 0 with
   no legality/timeout regression. This is the **enforcement** width (mask px); the
   player-visible bar is still rendered separately at `BLOCKING_STROKE_WIDTH` by
   `drawRouteBlocks` (WP 5.3 item 4). Kept a tunable literal for Phase 6.
2. **LOS-guarded densifying repair after `simplifyThetaPath`.** θ*'s in-loop test
   is Bresenham LOS, but the plan's legality assertion (`countLegalityViolations`)
   samples with linear interpolation; the two disagree at corners, so the raw
   simplified path failed the legality check ~55 % of the time → forced fallback.
   `losRepair` keeps every simplified shortcut that is linear-clean and re-expands
   only the over-shortcut segments back to the raw θ* sub-path, densifying any
   remaining linear-dirty LOS-jump to adjacent Bresenham pixels. Result: legality 0
   **and** θ* actually used on ~95 %+ of routes (was ~45 %). Smoothness preserved
   everywhere the straight line is clean.
3. **Barrier-legality guard on the fallback path.** A legal-spine fallback is
   barrier-unaware and can cross an active barrier. `generateOnePair` rejects any
   served pair whose route crosses its active barriers (`countBarrierViolations`),
   bucketed as `timeout` (no `barrier` key exists in the 13-key taxonomy; WP 5.3
   owns barrier-reason semantics). This is what drives bar-crossings to exactly 0.
   θ* routes never trip it (barrier-clean by construction on the stamped subgrid).

## Notes for WP 5.4

- `collectstatic` + server restart **not** run in this WP (no browser check here);
  WP 5.4 does the live pass. Worker JS was edited, so 5.4 must collectstatic.
- `route_pair_selection.js` injection, budgets, rejection taxonomy from WP 5.1 are
  untouched and still work (harness re-run: legality 0, gap centred ~0.09).
