# Tests and benchmarks

Last audited: 2026-07-13. The current navgraph artifact version is v4.

This document is both the human runbook and the agent inventory for automated
checks. Run commands from the repository root in PowerShell:

```powershell
Set-Location C:\Users\larsb\polybox\Projects\CQC-Pathfinder\CQCPathfinder
```

Audit result on 2026-07-13:

- All 17 JavaScript pathing files passed.
- All 63 database-free Python navgraph tests passed.
- `manage.py check` and the translation consistency check passed.
- Django discovered all 140 tests. The 77 database-backed tests could not start
  in the audit sandbox because its configured PostgreSQL host was unreachable;
  that was an infrastructure failure while creating the test database, not a
  test assertion failure. Run them locally with the database setup below.

## What should normally be run

For pathfinding-only work, run the JavaScript pathing suite and the database-free
Python navgraph suite:

```powershell
$tests = Get-ChildItem project\static\project\js\pathing\dev -Filter '*.test.mjs' |
    ForEach-Object { $_.FullName }
node --test $tests

.\.venv\Scripts\python.exe manage.py test `
    project.test_navgraph_obstacle_sampling `
    project.test_navgraph_passage_build `
    project.test_navgraph_region_pruning `
    project.test_navgraph_v3_contract `
    --verbosity 1
```

For a complete pre-release check, also run the full Django suite, Django system
checks, and the translation audit:

```powershell
$env:DEBUG = 'True'
.\.venv\Scripts\python.exe manage.py test --verbosity 1
.\.venv\Scripts\python.exe manage.py check
.\.venv\Scripts\python.exe scripts\manage_translations.py --check
```

The full Django suite needs a running PostgreSQL server. With the repository's
default development settings it connects to `localhost:5432`, database `db`, and
the test runner creates and later drops `test_db`. The database user therefore
needs permission to create databases. To use another local PostgreSQL instance:

```powershell
$env:DEBUG = 'True'
$env:DATABASE_URL = 'postgres://USER:PASSWORD@localhost:5432/DATABASE'
.\.venv\Scripts\python.exe manage.py test --keepdb --verbosity 1
```

Do not point tests at a production database. `--keepdb` reuses the test database
between runs. `--failfast` stops at the first failure. A module, class, or single
test can be selected with a Django test label, for example:

```powershell
.\.venv\Scripts\python.exe manage.py test project.tests.NavgraphServingGateTests
.\.venv\Scripts\python.exe manage.py test `
    results.tests.InfinityDebugSecurityTests.test_superuser_can_list_and_load_infinity_reports
```

Avoid `--parallel` when validating query-count tests; their purpose is easiest to
interpret in a single process.

JavaScript dependencies are installed with `npm install`. Python dependencies
are installed with:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Node may print `MODULE_TYPELESS_PACKAGE_JSON` warnings. They are currently
benign and do not mean a test failed.

## Status definitions

- **Core**: maintained and expected to pass after related changes.
- **Specialized**: useful for a particular subsystem or fixed fixture, but too
  slow or too narrow to be a default gate.
- **Helper**: invoked by another script; not normally called directly.
- **Historical name**: still relevant, but the filename/comment refers to the
  v2/v3 migration. It now also checks v4 and backward compatibility.

There are no intentionally dead test files in the repository. The old work
package harnesses remain useful, but their fixed artifacts must not be mistaken
for a benchmark of freshly built v4 graphs.

## Python and Django test catalogue

The audit found 140 Django-discoverable tests: 77 database-backed application
tests and 63 database-free navgraph tests.

### Database-backed application tests

| Module / class | Count | What it verifies | Status |
|---|---:|---|---|
| `account.tests.ForumQueryCountTests` | 1 | The forum thread view uses annotated vote counts and does not introduce a per-post query. | Core |
| `project.tests.AuthenticatedSurfaceTests` | 2 | Private pages redirect anonymous users while login remains public. | Core |
| `project.tests.EditorSecurityTests` | 4 | Team isolation for snapshots/files and asynchronous OCAD upload success/failure reporting. | Core |
| `project.tests.NavgraphInvalidationTests` | 9 | Mask, region, and passage edits disable stale Infinity artifacts; in-flight builds cannot republish stale data; no-op passage saves remain enabled. | Core |
| `project.tests.LevelPassagesValidationTests` | 3 | Passage document schema, canonical empty form, normalization, and rejection of invalid documents. | Core |
| `project.tests.LevelPassagesPersistenceTests` | 12 | Canonical storage, mask-state reconciliation, atomic passage/route metric saves, rollback, authorization, snapshots, duplication, and unknown-version safety. | Core |
| `project.tests.LevelPassagesReadEndpointTests` | 5 | Authentication/team isolation, canonical reads, no write lock during reads, and region filtering. | Core |
| `project.tests.NavgraphServingGateTests` | 6 | Only current, enabled, mask-matching artifacts are served/listed; legacy base-only v3 remains readable when no passages exist. | Core |
| `project.tests.NavgraphRebuildAuthorityTests` | 2 | A build publishes only if its source document is still current. | Core |
| `project.tests.BuildNavgraphCommandAmbiguityTests` | 1 | Shared mask rows with conflicting region/passage authority are skipped rather than built ambiguously. | Core |
| `results.tests.ErrorPotentialStatsTests` | 9 | Runtime-gap/error-potential formulas, sensitivity fits, filters, and aggregate query calculations. | Core |
| `results.tests.PlaySubmissionSecurityTests` | 2 | Submitted route/control-pair IDs cannot escape the user's accessible team/project. | Core |
| `results.tests.InfinityReportSubmissionTests` | 2 | Bug reporting deletes only the matching latest Infinity choice. | Core |
| `results.tests.InfinityUserStatsTests` | 5 | Per-user Infinity counts, choice persistence, uploaded-map association, play-file aggregation, and random-stat response data. | Core |
| `results.tests.InfinityDebugSecurityTests` | 6 | Superuser-only debug APIs, report/file/passage loading, legacy report inference, seed/file matching, and deletion. | Core |
| `results.tests.StatsSecurityTests` | 4 | Team scoping and the 100-control threshold for sensitivity statistics. | Core |
| `results.tests.StatsQueryCountTests` | 1 | Competition stats remain within their intended query count. | Core |
| `results.tests.ResultsAdminTests` | 3 | Staff filtering and CSV export for normal and Infinity choices. | Core |

These tests touch the database and may create files in temporary media roots.
Run all of them through `manage.py test`; do not execute the files directly.

### Database-free navgraph tests

| Module | Count | What it verifies | Status |
|---|---:|---|---|
| `project.test_navgraph_obstacle_sampling` | 25 | Dense contour sampling, noisy U-shapes, close obstacle offsets, gaps/thin walls, tiny-obstacle suppression, 3-D terrain preservation, LOS-aware deduplication, corridor/backbone reduction, bounded detour connections, edge spanners, and witness pruning. | Core |
| `project.test_navgraph_passage_build` | 18 | Passage geometry/raster parity, clipping and overlap rejection, flat caps/joins, transverse crossings, region filtering, typed passage chains/transitions, false-junction isolation, ordering, overlapping entrances, and empty-document compatibility. | Core |
| `project.test_navgraph_region_pruning` | 6 | Region revision, polygon validation/clipping, coarse hit-zone authority, optional unpruned A/B mode, and removal of outside nodes and edges. | Core |
| `project.test_navgraph_v3_contract` | 14 | Current version is v4, passage-revision parity with JavaScript, typed topology validation, binary serialization/layout, and Python-writer/JavaScript-reader compatibility. | Core, historical name |

These are `SimpleTestCase` tests and do not connect to PostgreSQL. They are the
fastest Python safety net for navgraph work.

## JavaScript pathing test catalogue

All files below live in `project/static/project/js/pathing/dev/`. They import
production modules rather than copied pathfinding implementations.

| File | What it verifies | Status |
|---|---|---|
| `barrier_width.test.mjs` | Route blockers use the same finite butt-capped, fractional-width geometry as player rendering. | Core |
| `infinite_scene_orientation.test.mjs` | Uploaded-map pairs reverse start/goal, route points, passage spans, and side metadata only when this reduces camera rotation. | Core |
| `layered_distinct.test.mjs` | Passage/base surface identity, shared-passage culling, obstacle-separated alternatives, route distinctness, and diagnostics. | Core |
| `layered_passage.test.mjs` | Directional layered topology, crossing isolation, full-width portals, surface-specific barriers, chained passages, any-angle refinement, and reclassification. | Core |
| `navgraph_endpoint_density.test.mjs` | Endpoint sampling preference around obstacle-rich areas and saved-region rather than image centering. | Core |
| `navgraph_endpoint_terrain.test.mjs` | Endpoints land on eligible terrain even in mixed coarse cells. | Core |
| `navgraph_obstacle_runtime.test.mjs` | Obstacle/stair entry penalties and exclusion of projected base terrain while travelling on a passage surface. | Core |
| `navgraph_passage_overlay.test.mjs` | Typed passage topology, production route computation, portal-width optimization, surface-separated barriers, revision policy, and empty-passage compatibility. The “overlay” name is historical. | Core, historical name |
| `navgraph_refinement_policy.test.mjs` | Uploaded-map Infinity accepts only pairs where both final routes completed Theta*; dense legal-spine fallbacks remain diagnostic-only. | Core |
| `navgraph_region_gate.test.mjs` | Sampling, snapping, and graph A* cannot use nodes outside the coach region. | Core |
| `navgraph_v3_consume.test.mjs` | Current typed artifacts plus passage JSON, forward/reverse traversal, base-only endpoint snapping, stale-document rejection, barrier surface separation, and v2/v3 compatibility. | Core, historical name |
| `navgraph_v3_contract.test.mjs` | Binary parse/validation, typed-edge invariants, false-junction isolation, revision determinism, cross-language pin, and legacy readers. | Core, historical name |
| `passage_editor_contract.test.mjs` | Static integration guards for the non-module editor/player bundles: atomic save wiring, undo/edit UI hooks, region editing, blocker width, and a five-scene uploaded-map prefetch buffer that serves ready work immediately. This is a wiring/regex test, not browser E2E. | Core but brittle by design |
| `passage_geometry.test.mjs` | Passage normalization, raster geometry, full-width portal bands, route classification, topology, overlap ordering, and bounded allocation. | Core |
| `passage_save_client.test.mjs` | One coalesced save request, cancellation by newer saves, and server/network failure taxonomy. | Core |
| `route_pair_selection.test.mjs` | Which skipped blockers may be displayed and rejection of non-adjacent cumulative route alternatives. | Core |
| `wall_hugging.test.mjs` | Passage edge hugging for wide, narrow, diagonal, bent, reverse, and terrain-weighted fixtures; legality and cost diagnostics. | Core |

Run one JavaScript file directly when isolating a failure:

```powershell
node project\static\project\js\pathing\dev\wall_hugging.test.mjs
```

## Uploaded-map Infinity benchmarks

Benchmarks are seeded but still depend on the machine, Node version, mask,
artifact, and warm/cold filesystem cache. Compare runs on the same machine and
record those details. Local Node timings do not prove the midrange-phone target;
they are a reproducible relative benchmark.

### Prepare a current artifact and passage document

Build or rebuild by Django `File.id`:

```powershell
$fileId = 133
.\.venv\Scripts\python.exe manage.py build_navgraph --file $fileId --force
```

Important `build_navgraph` arguments:

| Argument | Meaning |
|---|---|
| `--file ID_OR_PATH` | Build one exact database row by ID, or one mask path. Prefer an ID when passages/regions are stored in the database. |
| `--all` | Backfill masks under `media/masks`. |
| `--force` | Rebuild even if the artifact appears current. |
| `--limit N` | Process at most N masks; implies `--all` if no source was given. |
| `--random` / `--seed N` | Randomize the all-mask sample reproducibly. |
| `--debug` | Also render the debug navgraph PNG. |

Typed v4 artifacts store passage graph nodes, but the browser receives passage
geometry separately from Django. Headless benchmarks must therefore receive the
same JSON. Export it from a local database like this:

```powershell
$fileId = 133
$passages = "scratch\file-$fileId.passages.json"
.\.venv\Scripts\python.exe manage.py shell --no-imports -c `
    "import json; from pathlib import Path; from project.models import File; f=File.objects.get(pk=$fileId); Path(r'$passages').write_text(json.dumps(f.level_passages), encoding='utf-8')"
```

A passage file may be either the canonical `{ "version": 1, "items": [...] }`
document or the raw items array. Omit `--passages` only for a base-only artifact.
The harness now fails clearly instead of silently benchmarking a typed graph
without its passage geometry.

### Generate and time 1,000 production route pairs

This is the preferred one-map performance and distribution benchmark. It calls
the production `generateOnePair` pipeline, including sampling, graph A*, route
alternatives, weighted pair selection, blockers, legality, and Theta* refinement.

```powershell
$mask = 'media\masks\mask_20260105_093048.png'
$passages = 'scratch\file-88.passages.json'
node scripts\infinity_endpoint_heatmap.mjs `
    --mask $mask `
    --passages $passages `
    --count 1000 `
    --seed 1 `
    --out scratch\endpoint_heatmap
```

Outputs are a row-per-pair CSV, a timing summary containing mean/median/p90/p99/
maximum, and combined/start/goal endpoint heatmaps.

| Argument | Default | Meaning |
|---|---:|---|
| `--mask PATH` | required | Mask PNG; the `.navgraph.bin` must be beside it. |
| `--passages PATH` | none | Required when the artifact contains passage nodes. |
| `--count N` | 1000 | Accepted route pairs to generate. |
| `--seed N` | 1 | Reproducible random sequence. |
| `--max-attempts N` | `max(20000, count*60)` | Overall attempt budget. Raise it for difficult regions. |
| `--out DIR` | `scratch/endpoint_heatmap` | Output directory. |
| `--max-out PX` | 1600 | Longest heatmap output side. Does not change routing. |
| `--sigma PX` | 6 | Heatmap blur only. |
| `--percentile P` | 99.5 | Heatmap colour normalization only. |

For a smaller smoke run with optional route PNGs:

```powershell
node scripts\navgraph_harness.mjs `
    --mask $mask --passages $passages `
    --count 100 --max-attempts 4000 --seed 1 `
    --render 6 --out scratch\harness
```

`--count`, `--max-attempts`, `--seed`, `--render`, `--out`, `--mask`, and
`--passages` have the meanings above. `--all-demo` runs three fixed sample masks;
those checked-in artifacts are historical fixtures, not a current v4 baseline.

### Benchmark every current artifact

`navgraph_batch.mjs` discovers only artifacts whose binary version matches the
current production reader. It checks every accepted route for legality and
writes aggregate Markdown/JSON. Passage files are matched as
`<mask-stem>.passages.json` under `--passages-dir`.

```powershell
node --max-old-space-size=4096 scripts\navgraph_batch.mjs `
    --masks-dir media\masks `
    --passages-dir scratch\passage-documents `
    --count 100 --max-attempts 4000 --seed 1 `
    --out scratch\navgraph_batch.md `
    --json scratch\navgraph_batch.json `
    --label baseline
```

Important extra arguments are `--side-gap PX` (temporary endpoint-side-gap
override), `--masks-dir DIR`, and `--label TEXT`. Maps above 35 Mpx receive 50%
of the requested count; maps above 60 Mpx receive 30%, with minimums of 30 and
20. The current aggregate gate is zero legality violations plus mean retries at
most 5 and mean route-pair time at most 1000 ms on at least 70% of successful
maps. Missing passage JSON is recorded as a map error, not silently ignored.

### Region-pruning build/size A/B

This benchmark builds temporary unpruned and polygon-pruned artifacts. It never
publishes them. It compares build time, nodes, edges, raw/gzip/brotli size, state
construction, snapping, graph search, and heap usage.

```powershell
.\.venv\Scripts\python.exe scripts\navgraph_wp63_benchmark.py `
    --auto-select 7 --max-mpx 40 `
    --runtime-count 20 `
    --output scratch\wp63-benchmark.json
```

Instead of `--auto-select N`, pass `--manifest PATH`. The manifest is a JSON
array of `{ "mask": "media/masks/mask_X.png", "region": [[x,y], ...] }`.
Paths may be absolute or repository-relative. `--runtime-count` currently has
an effective maximum of 20 because the Node helper deliberately caps probes.
`scripts/navgraph_wp63_runtime.mjs` is that helper and is not a normal direct
test entrypoint.

### Pinned reported-route regressions

This specialized fixture reproduces Infinity bug reports 4, 5, and 7 for one
specific map and passage document. It checks route quality/legality around the
reported locations:

```powershell
node scripts\infinity_bug_report_regression.mjs       # all three reports
node scripts\infinity_bug_report_regression.mjs 5     # one report
node scripts\infinity_bug_report_regression.mjs sample 36 100
```

For `sample`, the arguments are corridor radius and sample count. This mode uses
unlimited primary/refinement budgets and a fixed 200-attempt cap, so it is useful
for correctness and corridor-radius comparisons, not production latency claims.

## City-mode Infinity benchmarks

These use the production procedural-city worker and need no Django database.

`selection_harness.mjs` compares the old closest-runtime selector with the
current weighted selector:

```powershell
node scripts\selection_harness.mjs `
    --count 1000 --pairs 5 --routes 5 `
    --cap 0.40 --target 0.10 --stddev 0.06 `
    --uniform 0.10 --index-bias 1.25 --seed 1
```

- `--count`: accepted problems per comparison pass.
- `--pairs`: problems generated per city batch.
- `--routes`: candidate routes explored by the weighted pass.
- `--cap`: maximum relative runtime gap.
- `--target` / `--stddev`: centre and width of the desired gap distribution.
- `--uniform`: baseline probability mass for diversity.
- `--index-bias`: preference for later route attempts.
- `--seed`: reproducible city sequence.

`balance_harness.mjs` compares balance rejection off/on over identical cities:

```powershell
node scripts\balance_harness.mjs `
    --count 1000 --pairs 5 --prob 0.5 --threshold 0.05 --seed 1
```

`--prob` is the treatment rejection probability. `--threshold` is the relative
runtime-gap rejection band. Reported histogram buckets remain fixed at <=5%,
5-10%, and >10%; changing `--threshold` does not change those bucket boundaries.

## Specialized acceptance harnesses

These exercise current production code but fixed, checked-in map artifacts. The
artifacts are predominantly legacy v3. Use them to detect behavioural regressions,
not to measure current v4 graph build or file-size performance.

| Command | Purpose and arguments | Status |
|---|---|---|
| `node scripts\wp5_2_verify.mjs --seed 1` | Fixed 90/90/40 pair run on small/median/75-Mpx masks. Checks true-mask legality, blocker crossings, Theta* improvement ratio, p90 refinement time, and renders samples. Only `--seed` is configurable. | Specialized, slow |
| `node scripts\wp5_3_verify.mjs --seed 1 --count 100` | Checks blocker anchors, effectiveness, active blocker crossings, and legality on each fixed mask. `--mask` accepts the label `small`, `median`, or `75Mpx`, not a file path. | Specialized, slow |

A one-pair smoke run is syntactically useful, but it may place no blocker and is
not meaningful coverage:

```powershell
node scripts\wp5_3_verify.mjs --seed 1 --count 1 --mask small
```

## Diagnostics (not pass/fail tests)

Render a navgraph debug PNG next to each mask:

```powershell
.\.venv\Scripts\python.exe scripts\navgraph_debug.py `
    media\masks\mask_20260105_093048.png `
    --pair 100,200,900,1200 `
    --show-shadowed
```

- Positional arguments: one or more mask PNG paths.
- `--pair y1,x1,y2,x2`: highlight a graph shortest path between the closest
  nodes to those two points.
- `--show-shadowed`: also draw base edges hidden by typed passage topology.

If the `.navgraph.npz` is absent, this script builds and saves one. It is
therefore diagnostic and potentially mutating, not a pure test.

`scripts/manage_translations.py --check` is a validation command. Use
`--build` to regenerate `.po`/`.mo` catalogues after changing UI text. The script
does not implement a conventional `--help`; invocation without `--check` also
builds catalogues.

## Known gaps and maintenance rules

1. There is no real browser end-to-end suite. The static editor contract catches
   wiring loss, while geometry/router modules have behavioural Node tests, but
   mouse interaction, Web Worker scheduling, rendering, and a complete logged-in
   browser flow still require manual or future browser automation.
2. There is no CPU-throttled or physical-phone benchmark. A laptop Node result is
   comparative evidence only.
3. The complete Django suite cannot run without PostgreSQL. The 63 navgraph
   tests remain available when the database is offline.
4. Files named `navgraph_v3_*` are deliberately retained because they lock
   backward readers and cross-language binary compatibility. They also assert
   the current v4 version; do not delete them based on the filename alone.
5. `wp5_2_verify.mjs`, `wp5_3_verify.mjs`, and `--all-demo` use fixed historical
   artifacts. Rebuild or replace those fixtures before using them as a current
   performance baseline.
6. A benchmark containing typed passage nodes is invalid without the matching
   passage JSON. Generic harnesses enforce this now.

When adding or changing a test:

- Import the production implementation; do not copy pathfinding logic into a
  harness unless the copy itself is an explicit binary-format reference model.
- Use a deterministic seed and state what constitutes pass/fail.
- Keep small correctness fixtures in the normal suite; put large statistical or
  timing runs in `scripts/` as benchmarks.
- If an artifact format or passage/region revision changes, update Python and
  JavaScript compatibility tests together.
- Update this document when adding, removing, renaming, or materially changing
  an entrypoint or argument.
- Any changed user-facing string still requires
  `scripts/manage_translations.py --check` and `--build` per `AGENTS.md`.
