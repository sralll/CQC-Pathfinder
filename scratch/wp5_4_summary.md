# WP 5.4 — Play wiring, stats + live verification — summary (2026-07-10)

## Starting state

plan.md already carried a "Progress (2026-07-10)" note under WP 5.4 stating the
JS wiring (worker.js, mask_scene_source.js, buildMaskScene, the stats panel
diagnostics block, play.css, locale rows) was implemented and locally checked
in an earlier pass of this WP, but **live staging verification could not run**
because that runtime had no Django installed. This session had a working
Django/staging DB, so the job was: verify the inherited wiring is actually
correct against the real `generateOnePair` meta shape, then complete the
`collectstatic` → preview server → `/dev/agent-login/` → live-session steps
that were blocked before. **No source files were modified this session** — the
inherited implementation was checked line-by-line against `navgraph_router.js`
and found correct; live testing confirmed it end-to-end.

## Verification of the inherited wiring

- `project/static/project/js/pathing/worker.js`: forwards `barriers`,
  `skippedBarriers`, `meta` (incl. `rejectionCounts`, `refineMode`,
  `refineFallback`, `refine[2]`, `timings.{sample,snap,route,refine,theta}`)
  in the `pair` message; sets `res.meta.workerMs = +dt.toFixed(2)` from the
  same `dt` tested by `if (dt > PAIR_WARN_MS) console.warn(...)` (`PAIR_WARN_MS
  = 5000`) — so `workerMs` is proof-by-construction of whether that warning
  fired. `PAIR_TIMEOUT_MS` (20000, in `mask_scene_source.js`) is untouched.
- `results/static/results/js/infinite/mask_scene_source.js`: `this.metrics =
  {requested, completed, failed, slow, starved, maxPairMs}`; `_requestPair`
  increments `slow` when a round trip exceeds `PAIR_WARN_MS` (5000);
  `takeScene()` `console.warn`s `"[mask-source] buffer low: N ready, M in
  flight"` whenever post-take `buffer.length < 2`, live-confirmed firing (see
  below).
- `results/static/results/js/infinite_play.js` `buildMaskScene`: `scene.meta`
  = `{seed, retries, attempts, sideGap, relGap, legality, timings, workerMs,
  rejectionCounts, refineMode, refineFallback, refine}` — checked field-by-
  field against `generateOnePair`'s actual return shape
  (`navgraph_router.js:1381-1417`): exact match, nothing renamed or dropped.
  `scene.routeResult = {skippedBarriers, blockFastest, barriers}` from
  `pair.skippedBarriers`/`pair.barriers` — unchanged shape from WP 5.3, so the
  existing `drawRouteBlocks` still Just Works.
- `renderStatsPanel` (same file, ~L3811-3838): new `.stats-mask-diagnostics`
  block, gated on `cp.kind === 'mask'`, reads exactly the `scene.meta` fields
  above through 6 `gettext()`-wrapped labels.
- **"check stats.js expectations" (spec item 1) — resolved**: I grepped
  `results/static/results/js/stats.js` (the trainer analytics dashboard, a
  *different* file from `infinite_play.js`'s in-page `renderStatsPanel`) for
  `rejectionCounts`/`refineMode`/etc. — no matches, and no `.py` file
  persists/reads these fields either. City mode's own per-scene
  `rejectionCounts` (set in `infinite_play.js` ~L1656-1665,
  `buildSceneBatchCandidate`) is likewise never sent to the backend or read by
  `stats.js` — it's a live, client-only diagnostics surface. So "the same
  stats surfaces the city mode fills" means the in-page `renderStatsPanel`
  panel (which mask now also feeds), not the trainer `stats.js` dashboard.
  Confirmed no `stats.js` changes are needed for this WP; the one line already
  touched there (`MODE_LABEL.random: gettext('Infinity')`, was a raw string)
  is an unrelated pre-existing translation-discipline fix, not new wiring.

## PAIR_TIMEOUT_MS / budget interplay — verified, no change needed

Worker-side budgets (`primaryBudgetMs:400`, `extraBudgetMs:200` from WP 5.1;
`refineBudgetMs:600`/route from WP 5.2) are unchanged. Live-measured
`generatePair` round-trips (see below) topped out at **8062.8 ms** wall-clock
on the worst 75 Mpx mask under 3-deep concurrent prefetch — comfortably under
the 20000 ms `PAIR_TIMEOUT_MS` guard, so no bump was warranted. Individual
worker computations (`meta.workerMs`, excludes queueing) never exceeded 3.9 s
in any sample.

## i18n status

`python scripts/manage_translations.py --check` → **exit 0, "OK"** (only
non-fatal "unused in table" notices, all belonging to the parallel
level-passages/3rd-dimension session's future strings). `--build` → exit 0,
all 3 languages rebuilt cleanly. My WP5.4 msgids, all present with de/fr/it
rows in `locale/source_messages.py` `DJANGOJS`: `"Mask generation"`,
`"Attempts"`, `"Retries"`, `"Refine"`, `"fallback"`, `"Rejections"`,
`"Timings"`, `"Infinity"` (the last replaces a hard-coded literal in
`stats.js`'s `MODE_LABEL.random`). Everything else in the diff (passage tool
strings, "3rd dimension", "Finish", etc.) belongs to the parallel session per
the brief and was left untouched. The task brief's caveat about `--check`
failing on inherited strings did **not** reproduce in this environment — the
one previously-missing msgid (`"This file is not a valid project."`) is
already present in the table, so the check is fully clean, not just clean for
my own strings.

`node --check` passes on `worker.js`, `mask_scene_source.js`,
`infinite_play.js`, `stats.js`; `git diff --check` clean.

## collectstatic + preview server

`python manage.py collectstatic --noinput` → `0 static files copied ...,
1058 post-processed` (manifest rebuilt). Started `uvicorn-preview`
(`.claude/launch.json`, port 8765) via `preview_start` — did not touch the
main :8000 server.

## Live staging session

`http://127.0.0.1:8765/dev/agent-login/` (never `localhost`, per the repo
memory note) → `python manage.py ensure_agent_user --team Nationalkader` to
re-flip the agent's active team (agent-login resets it to `Agents` on every
login; this must run *after* login since it edits the DB row the already-
logged-in session reads live). Navigated to
`/play/infinity/?source=mask&file=35&filename=20250605_114059.jpg` — page,
worker, and `/editor/navgraph|mask|level-passages/35/` all loaded 200 OK.

**rAF-frozen hidden tab** (repo-known limitation): `document.visibilityState
=== 'hidden'` in this automated preview, so the real rAF-driven render loop
and the phase-gated in-game stats-toggle handler (`initStatsPanel`, requires
`phase==='reveal'` with a live module-internal `scene`) can't be driven end-
to-end from here. Followed the established workaround: dynamically
`import()`'d the **unmodified, already-loaded** production module
`/static/results/js/infinite/mask_scene_source.js` from the page console and
drove its real `MaskSceneSource` class directly (real `Worker`, real fetches
with cookies, real prefetch/refill logic) — this exercises the exact
worker.js → navgraph_router.js → route_pair_selection.js → refine_theta.js
path a live session uses, decoupled only from rendering.

### Buffer / cadence probe (25-30 pairs @ 2 s cadence per map)

| map | fileId | px | pairs | max round-trip | slow (>5s) | starved (after warm-up) | refine theta/fallback |
|---|---:|---:|---:|---:|---:|---:|---:|
| Solothurn | 35 | 2295×3115 (7.1 Mpx) | 25 (+ warm-up) | 5357.5 ms | 2 | 0 | 9 / 16 |
| Aarberg | 37 | 3106×2171 (6.7 Mpx) | 12 | 2185.8 ms | 0 | 0 | 12 / 0 |
| Locarno Sprint Floli | 142 | 8561×8784 (75.2 Mpx) | 11 (+ warm-up) | 8062.8 ms | 2 | 0 | 2 / 9 |

File 142 is not `infinite_enabled` and has no drawn `infinite_region` (the WP
5.2/5.3 stress-test mask); its raw `/editor/navgraph|mask|level-passages/`
endpoints aren't gated by that flag (only the map-picker listing is), so it
could be driven directly without touching the model — "ideally also on the 75
Mpx map" from the acceptance list.

Buffer behaviour: `buffer.length` never hit 0 during any loop (no forced
waits/hangs) — `metrics.starved` only incremented once per source, from the
unavoidable very first cold-start `takeScene()` before any prefetch exists.
After warm-up, `buffer.length` sat at 2-3 the large majority of the time and
briefly dipped to 1 (never 0) during bursts of consecutive slow generations
(observed on File 35 and 142, never on 37) — the `"[mask-source] buffer low: N
ready, M in flight"` `console.warn` fired live and was captured in the
browser console (40+ occurrences) confirming the diagnostic works. This is a
genuine, honest finding: the "≥2 buffered" target is met on average and never
starves, but isn't an absolute invariant on the two larger/busier masks when a
run of legal-fallback pairs (which cost more retries) lands back-to-back.
Not a WP5.4 wiring defect — the refill logic (`_scheduleRefill`) is
unchanged from WP5.3 and correctly re-triggers every time; it's inherent to
generation being occasionally slower than the 2s cadence on these masks.

### Rejection counters — live evidence

Full non-zero counter breakdown for File 35 (25 pairs):
`obstacle:5 distinct:1 side:7 routeside:2 balanced:14`. All 13 taxonomy keys
present (zero-valued ones included) in every `meta.rejectionCounts` object
captured — matches `generateOnePair`'s fixed-key initialization exactly.
Worker-thread `console.log`/`console.warn` (`[theta-client] generatePair
OK/FAILED ... rejects={...}` and the 5s slow-pair warning) did **not** surface
through this browser tool's console capture — dedicated Worker execution
contexts are a separate CDP target this simplified preview harness doesn't
attach to, a tooling limitation, not a code defect. Equivalent proof is
deterministic: `meta.workerMs` is computed from the identical `dt` the
worker's own `if (dt > PAIR_WARN_MS) console.warn(...)` branch tests, so any
`workerMs > 5000` in the captured data is proof-by-construction the warning
fired (main-thread `console.warn`, e.g. the buffer-low warning above, *did*
capture correctly, confirming this is worker-vs-main-thread scoping, not a
general console capture failure).

### Stats panel — DOM evidence

Reproduced the literal (unmodified) `.stats-mask-diagnostics` block from
`renderStatsPanel` against a real captured `meta` object, injected into the
page's real `#play-stats-panel` node (real `gettext()` catalog, real
`play.css` post-collectstatic): rendered
`Mask generation / Attempts 1 / Retries 0 / Refine legal-fallback (fallback) /
Rejections 0 / Timings sample 0ms, snap 0ms, route 61ms, refine 37ms, theta
1201ms`, non-zero bounding box (1285×37 px), `color: rgb(221,221,221)`
matching `--text-dim`. Done via DOM injection rather than the in-game
phase-gated toggle, for the rAF-frozen-tab reason above.
`preview_screenshot` timed out (same known limitation as WP 5.3's live
check) — DOM/style probing substitutes per the accepted repo pattern.

### Barrier threading — spot check

A buffered pair carried `barriers: [4 items]`, `skippedBarriers: [3 items]`,
already converted to map units (`× TRAIN_SCALE_VALUE`) by `_wrapPair` —
confirms the WP 5.3 barrier pipeline is untouched and still flows correctly
through the WP 5.4 changes into `scene.routeResult`.

### Node-side regression re-check

`node scripts/wp5_3_verify.mjs --seed 1 --count 15 --mask small` →
`legality=0, bar-cross=0` (15 fresh pairs). Confirms nothing in this
(read-only) session disturbed the WP 5.1-5.3 invariants.

Evidence file: `scratch/wp5_4/live_probe.json`.

## Deferred findings from 5.1-5.3 (not fixed — out of scope for this WP)

- **Legal-fallback rate is high on busier/larger masks** — File 35: 16/25
  (64%) fell back to `refineRouteLegal` output instead of θ*; File 142 (75
  Mpx): 9/11 (82%). File 37 (the smallest/simplest of the three): 0/12 (0%
  fallback, always θ*). This is steeper than WP 5.2's own Node-harness
  acceptance number ("θ* used on ~95%+"). Two plausible confounds, not
  disentangled here: (a) `refineBudgetMs:600`/route may be tight for these
  specific masks' terrain complexity (WP 5.2/5.3 already flag budget/corridor
  tuning as Phase 6 work), and (b) this browser session ran in a backgrounded
  ("hidden") preview tab, which Chrome deprioritizes (CPU/timer throttling) —
  a real player's foregrounded tab would likely see lower θ* wall-clock times
  and thus fewer budget timeouts. Recommend Phase 6 re-measure on a
  foregrounded tab or headed browser before treating this as a tuning
  regression. Not a WP5.4 wiring defect either way — `refineTimeoutPolicy:
  'fallback'` served every pair correctly with zero legality/bar-crossing
  violations regardless of mode.
- No other defects found; WP 5.1-5.3 algorithms were not touched.
