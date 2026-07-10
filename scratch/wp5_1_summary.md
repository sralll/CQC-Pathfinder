# WP 5.1 — Selection/rejection parity + time budgets — implementation summary

Date: 2026-07-10. Scope: mask-mode infinite router now uses the **shared** city
selection module + city A* budget/kick semantics + full rejection taxonomy.

## Files changed (working tree)

- `project/static/project/js/pathing/navgraph_router.js`
- `project/static/project/js/pathing/worker.js`
- `scripts/navgraph_harness.mjs` (de-drifted — now imports the router)
- `scripts/navgraph_batch.mjs` (legality assert on already-refined routes; gap-dist reporting)

(Working-tree `locale/*` and `results/static/results/js/stats.js` changes are
pre-existing, not part of this WP.)

## What changed (7 spec items)

1. `route_pair_selection.js` injected: worker imports it (`/static/…` specifier)
   and passes `generateOnePair(state, { selection })`; Node callers inject by
   path. Local `selectRuntimeRouteOptions` deleted from navgraph_router.js.
2. Route records now carry `routeIndex = attempt+1`, `barrier` (placed after the
   route), `run_time = graph cost`. `routeAttempts` 4 → 5.
3. `selectWeightedRoutePair(paths, { start, goal, config: {…DEFAULT_ROUTE_PAIR_
   SELECTION, minSideGap: cfg.sideGapMinPx (40), maxRelativeGap: 0.40 }, rng })`;
   sides via shared `ensureRouteSides` (called inside the picker); seeded rng
   threaded; `skippedBarriers = skippedBarriersForSelection(paths, selected)`
   computed and returned.
4. Per-route budgets: routes 1–2 `primaryBudgetMs` (400), routes 3+
   `extraBudgetMs` (200). Deadline checked in `graphAstar` pop loop (pop 0 + every
   512) and `astarSubgrid` (every 1024 expansions). Route 1's budget also bounds
   the snap stubs. Timed-out route dropped; < 2 routes → attempt fails `timeout`.
5. Balance reject stays post-refinement, synced to 0.05 / **0.8**.
6. Rejection taxonomy `{ empty, distance, obstacle, snap, unreachable, distinct,
   runtime, side, routeside, lateral, timeout, runtime_refined, balanced }`
   aggregated in `meta.rejectionCounts`; logged in the worker `generatePair
   OK/FAILED` line as `rejects={reason:count …}`.
7. Harness de-drifted: `generatePairs` now calls the real `generateOnePair` per
   valid pair (selection injected), so the batch exercises the exact worker path.

All new constants live in `DEFAULT_CONFIG` (navgraph_router.js): `maxRelativeGap
0.40`, `routeAttempts 5`, `primaryBudgetMs 400`, `extraBudgetMs 200`,
`balanceRejectProbability 0.8`.

## Acceptance (12 WP-2.2 masks, count 60, seed 1)

- **Zero legality violations** across all accepted pairs, both routes, all maps.
- **Reproducible**: same seed run twice → byte-identical served output.
- **Tiny budget** `primaryBudgetMs:1` → timeout rejections occur, no hang;
  `primaryBudgetMs:0` (largest-graph mask, 200 attempts) → `ok:false reason:timeout`,
  183 `timeout` rejects, completes in 182 ms.
- **ms/valid within 2×**: measured on the *served* pipeline (generateOnePair,
  which always included refinement) — pre-change vs post-change:

| metric | pre (HEAD) | post (NEW) |
|---|---:|---:|
| mean wall ms / valid pair (12 masks) | 18.9 | **15.2 (×0.80)** |
| per-map worst ratio | — | ×1.16 |

New is *faster* than the pre-change served path (deeper exploration is offset by
budgets + earlier weighted rejects). Comfortably within ~2×.

## Rebaseline: intended distribution shift (as plan predicted)

Served relative-gap distribution now centres near 0.10:

- mean per-map median relative gap **0.113**, mean **0.136**
- histogram (served pairs): `{<0.05:31, <0.10:274, <0.15:183, <0.20:93, <0.30:93, <0.40:46, >=0.40:0}`

Rejection reasons (aggregate over the 12 masks):

| reason | pre (closest-pair, gap 0.5) | post (weighted, gap 0.40) |
|---|---:|---:|
| side | 571 | 365 |
| routeside | 479 | 138 |
| obstacle | 94 | 84 |
| runtime | 10 | 0 |
| balanced | (n/a) | **203** |
| runtime_refined | (n/a) | 1 |
| distinct / snap | 3 / 3 | 0 / 0 |

`balanced` rejects (203) are new and prominent, `side` remains the top reason —
the intended training-distribution change, not a regression. GO / 100 % gate / 0
legality on the batch driver.

Data artifacts: `scratch/wp5_1_rebaseline.md` + `.json` (navgraph_batch output),
`scratch/wp5_baseline_pre.json` (pre-change), `scratch/wp5_compare.mjs` (fair
served-cost comparison + reproducibility + timeout tests).

## Notes for WP 5.2 / 5.3

- **`skippedBarriers`** (WP 5.3) is returned from `generateOnePair` as
  `result.skippedBarriers` and forwarded in the worker `pair` postMessage
  (`skippedBarriers` field). Shape: `Array<{ ax, ay, bx, by }>` in full-res mask
  px — the barrier segments of faster lower-`routeIndex` routes the picker
  skipped. Empty array when the fastest route was served.
- **`meta.rejectionCounts`**: the 13-key object above, per generatePair call.
- Refinement is still `refineRouteLegal` (legal spine). WP 5.2 layers corridor +
  guided θ* on the accepted pair's two routes *after* selection; the budget/kick
  machinery here only covers graph A* + snap, so θ* timing is WP 5.2's concern.
- `computeRouteOptions` return gained `{ …, reason, timedOut }`; route records
  gained `{ run_time, routeIndex, barrier }`.

## Not done here (out of scope / follow-up)

- `collectstatic` was **not** run — no browser check in this WP (acceptance is
  static/Node). Before any browser session (WP 5.4), run
  `python manage.py collectstatic --noinput` + restart so the hashed worker.js /
  navgraph_router.js are served.
