# Third-dimension passages for mask pathfinding

**Status:** baseline and runtime overlay implemented; build-time navgraph passage-chain
replacement specified below and pending

**Date:** 2026-07-10

**Scope:** the `project` Django app, its browser-side mask pathfinder, and a later
integration with mask-based Infinity mode

## Implementation progress and resume protocol

**Execution status:** active  
**Last orchestrator update:** 2026-07-12
**Current milestone:** CR 8.4 passage-authoritative build orchestration, staleness,
serving, and backfill implemented; CR 8.5 independent verification/rollout gate and
baseline Phase 7 visual QA remain pending

This table is the authoritative resumable state. The primary agent updates it after
reviewing each delegated package. Delegated agents report back to the primary agent;
they should not independently broaden scope or mark their own package accepted.

| Work package | Status | Owner/effort | Review or handoff note |
|---|---|---|---|
| WP 0.1 | accepted | geometry agent / medium | Seven topology fixtures reviewed and passing. |
| WP 1.1 | accepted | persistence agent / medium | Minimal two-field migration, validator, API, and tests reviewed. |
| WP 1.2 | accepted | persistence agent / medium | Project lifecycle plumbing reviewed; future versions preserved. |
| WP 2.1 | accepted | geometry agent / high | Deterministic cropped rasterizer reviewed and passing. |
| WP 2.2 | accepted | geometry agent / high | Classifier reviewed; critical no-Route-field tests pass. |
| WP 3.1 | accepted | primary agent / very high | Directional sparse A* and bounded allocation passed independent critical review. |
| WP 3.2 | accepted | primary agent / very high | Per-surface any-angle refinement passes diagonal and identity-equivalence tests. |
| WP 3.3 | accepted | primary agent / high | Opt-in worker branch preserves exact legacy dispatch when no passages exist. |
| WP 4.1 | accepted | primary agent / high | Authoritative in-memory spans, including known-empty base results, drive scoring. |
| WP 4.2 | accepted | primary agent / high | Global blocker band stamps only its authoritative/reconstructed surface. |
| WP 4.3 | accepted | distinctness agent / high | Pure layered distinctness reviewed, integrated, and passing. |
| WP 5.1 | accepted | frontend agent / medium | Dedicated committed/preview SVG layers reviewed. |
| WP 5.2 | accepted | frontend agent / high | Multi-node add, shared validation, and width editing implemented. |
| WP 5.3 | accepted | frontend agent / medium | Selection/removal/undo and route-derived-value refresh implemented. |
| WP 5.4 | accepted | frontend agent / high | Sidebar/radial hierarchy and all four language catalogs verified. |
| WP 6.1 | accepted | repository agent / medium | Read-only payload endpoint/fetch reviewed; 4 endpoint tests pass. |
| WP 6.2 | accepted | navgraph agent + primary / very high | Dynamic portal overlay and surface-aware refinement pass topology/real-mask checks. |
| WP 6.3 | accepted | navgraph agent + primary / medium | Deterministic revision is carried through readiness and pair requests. |
| WP 7.1 | accepted | primary + independent reviewers / high | Django, geometry, layered, distinctness, and navgraph suites pass. |
| WP 7.2 | accepted | primary / medium | Typical and maximum-point rasterization plus layered benchmarks recorded. |
| WP 7.3 | review needed | primary + human review / medium | Authenticated HTTP/static smoke passed; in-app browser policy blocked localhost visual QA. |
| CR 8.1 | implemented | senior navgraph agent / high | v3 typed artifact (base/passage/transition + passage_revision), strict Python writer + JS/Node reader validation, cross-language revision parity, and the frozen synthetic false-junction fixture. Real-map fixture frozen as spec (live topology assertions deferred to CR 8.2/8.5). Awaiting orchestrator acceptance. |
| CR 8.2 | implemented | primary + independent geometry review / very high | Canonical Python geometry, projected-base isolation, transverse bypasses, protected typed chains, endpoint-only connectors, component union, diagnostics, and focused synthetic acceptance are implemented. Live top-left-bridge verification still needs its editor-authored canonical passage document; coordinates were not fabricated. |
| CR 8.3 | implemented | senior JS integration agent / high | Worker/router now build Infinity topology from the baked v3 CSR (no dynamic overlay), revision-gate the fetched document, snap only to base nodes, derive typed legs from node ordinals, match barriers by edge surface, and reuse the passage-raster refinement/spans/distinctness. New `navgraph_v3_consume.test.mjs` (15 checks) plus all pathing suites, Python v3-contract/passage-build (28), and the system check pass. Awaiting orchestrator acceptance. |
| CR 8.4 | implemented | primary / high | Build identity, staleness, serving, and backfill are passage-authoritative: coherent-snapshot rebuild with a publish-time region+passage-revision recheck, atomic artifact writes, passage edits revoke infinite play + invalidate in-flight builds, serving/listing revision gate, and shared-map ambiguity refusal in the command. 26 focused Django tests plus 115/115 project+results on isolated SQLite. Awaiting orchestrator acceptance. |
| CR 8.5 | pending | independent review agent / high | Real-map, regression, artifact, and performance acceptance. |

### Resume procedure after a usage reset

When instructed to **continue**, the primary agent should:

1. read this progress table and the latest implementation journal entries below;
2. inspect `git status` and preserve all pre-existing unrelated changes;
3. inspect live/delegated agent status and collect any completed reports;
4. review and test completed packages before changing their status to `accepted`;
5. resume the first `in progress` package, or the first dependency-unblocked `pending`
   package if none is active;
6. update this table and append a journal entry before ending the turn.

Status vocabulary: `pending`, `delegated`, `in progress`, `implemented`, `review
needed`, `accepted`, or `blocked`. `Implemented` means an author reports completion;
only the primary agent may mark a package `accepted` after review and verification.

### Implementation journal

- **2026-07-10 - orchestration started:** persistence/project-state work delegated to
  `passage_persistence`; pure geometry, fixtures, and route classification delegated
  to `passage_geometry`; layered-routing integration received an independent read-only
  architecture review from `layered_arch_review`. The primary agent owns critical
  pathfinding integration and final review.
- **2026-07-10 - baseline:** `.venv\\Scripts\\python.exe manage.py check` passed.
  Existing `project` test suite passed 6/6 against its temporary PostgreSQL test
  database when network access was enabled. This baseline predates passage changes.
- **2026-07-10 - critical contract review:** the layered-routing review identified an
  ambiguity between wide bidirectional entrance regions and deterministic saved-route
  reclassification. The runtime contract now uses two directional search states per
  passage and rejects overlapping entrance caps. This preserves the no-Route-field
  decision at a cost of `2 * cropped passage area`, still independent of full map
  size. The same review fixed the WP 4.2 contract: the route blocker's global 40%-60%
  distance band must be computed once before surface-specific stamping.
- **2026-07-10 - foundations accepted:** WP 0.1, 1.1, 1.2, 2.1, and 2.2 were
  implemented by delegated agents and reviewed by the primary agent. Geometry and
  classifier Node suites pass. The full post-change Django `project` suite passes
  16/16 on isolated SQLite; the post-change PostgreSQL rerun remains queued because
  external-test approval hit the shared usage limit. No Route, ControlPair, or
  EditorSettings model fields were added.
- **2026-07-10 - Phase 3 started:** the primary agent added directional sparse layered
  A*, per-surface refinement, and an opt-in worker branch. Synthetic tests currently
  pass for forward/reverse topology, projected-crossing isolation, wide diagonal
  any-angle routing, stable passage-span reconstruction, and `base + 2 * passage`
  allocation. Existing no-passage requests still call the unchanged legacy pipeline.
- **2026-07-10 - downstream routing implemented:** surface-aware route blocking now
  computes the legacy global middle band once and stamps only the classified surface;
  passage-aware obstacle scoring uses transient spans immediately and deterministic
  reconstruction after reload. Layered distinctness was delegated, independently
  tested, reviewed, and integrated while preserving verbatim legacy results when all
  compared routes are base-only.
- **2026-07-10 - Infinity payload accepted:** a lock-free access-controlled read-only
  endpoint and concurrent Infinity boot fetch now deliver canonical passage data to
  `navgraphReady`. This was the payload prerequisite subsequently consumed by WP 6.2.
- **2026-07-10 - independent hardening review resolved:** authoritative worker-only
  surface identity is retained for the unchanged in-memory route, including an
  explicit empty/base-only classification, and is stripped by the existing explicit
  Django save payloads. Manual route edits and passage edits invalidate it. Passage
  edits now immediately recalculate and save derived obstacle/runtime values. The
  review also added self-overlap rejection plus deterministic per-passage and
  aggregate raster cell/work budgets; rasterization visits segment-local bounds.
- **2026-07-10 - editor and Infinity integration accepted:** the passage editor,
  translated tool hierarchy, dynamic navgraph portal overlay, opposite-cap topology,
  surface-aware refinement/barriers, and passage revision flow are implemented. The
  `.navgraph.bin` format and the Route, ControlPair, and EditorSettings models remain
  unchanged.
- **2026-07-10 - final automated verification:** translation check/build, Django
  system and migration checks, 20/20 isolated SQLite project tests, all focused Node
  suites, six real-mask generated pairs, collectstatic, and authenticated local HTTP
  asset/editor smoke checks pass. The configured PostgreSQL rerun could not start
  because the external-access approval quota was exhausted. In-app visual testing
  was also blocked by browser policy for `127.0.0.1`; manual desktop/touch review is
  the remaining WP 7.3 task.
- **2026-07-10 - final review closure:** the editor now normalizes the complete
  proposed passage document before committing, so aggregate raster cell/work limits
  cannot cause later saved passages to be silently skipped at runtime. Complexity
  rejection is translated in DE/FR/IT. Recalculated route metrics are saved only
  after passage persistence succeeds. The editor contract test and the final 20/20
  isolated Django rerun pass.
- **2026-07-12 - CR 8 specified:** after review of `plan.md`, this plan, the Python
  builder, the v2 binary, and the dynamic overlay, the Infinity design changed to
  build protected centreline chains into a typed navgraph artifact. CR 8.1-8.5 below
  define the false-junction fixture, projected-base isolation, v3 contract, worker
  integration, passage-authoritative activation/staleness, and rollout evidence.
  No implementation was performed in this planning update.
- **2026-07-12 - CR 8.1 implemented:** froze the typed navgraph contract. Bumped
  `NAVGRAPH_VERSION` to 3 and added a passage section (base/passage/transition
  edge kinds, owning-passage ordinals, a per-passage node range table,
  `base_node_count`, and a `passage_revision` string) to the `.npz` keys, the
  `.bin` byte layout, the Python writer (`project/navgraph.py` `_write_bin` /
  `save_navgraph`), and the JS/Node reader (`navgraph_router.js` `loadArtifact`).
  The reader bounds-checks every count, verifies the exact byte length, and
  rejects unknown kinds, out-of-range ordinals/endpoints, and non-contiguous
  passage ranges; `_attach_passage_topology` applies the same validation on the
  Python side. `passage_revision` is reproduced identically in Python and JS
  (canonical JSON with a codepoint id sort — `navgraph_passage_overlay.js` was
  switched off `localeCompare` for cross-engine determinism); a subprocess
  round-trip proves the Python writer and JS reader agree byte-for-byte. Base-only
  builds now emit a valid v3 artifact (`base_node_count == N`, zero passages); a
  legacy v2 artifact still parses for empty-passage files only. New suites:
  `project/static/project/js/pathing/dev/navgraph_v3_contract.test.mjs` (22 checks
  — round-trip for zero/one/multiple passages, corruption/bounds rejection,
  revision determinism/sensitivity/cross-language pin, and the frozen
  false-junction topology fixture that passes correct isolation and fails the old
  additive-overlay graph) and `project/test_navgraph_v3_contract.py` (14 tests).
  The real-map top-left-bridge fixture is frozen as a spec
  (`dev/fixtures/top_left_bridge.fixture.json`) with the invariant checklist; its
  live builder assertions and the concrete passage document are deferred to CR 8.2
  (build) and CR 8.5 (human map review). No production topology construction was
  performed — that is CR 8.2. Verified: the two new suites, all 9 existing pathing
  `*.test.mjs` suites, 88/88 `project`+`results` Django tests on isolated SQLite,
  the Django system check, and a real-mask `build_navgraph` → `save_navgraph` →
  JS-read smoke.
- **2026-07-12 - CR 8.1 necessity reviewed (Lars):** Lars flagged that CR 8.1 may
  have been premature for a still-in-development feature with no production
  artifacts yet, and asked whether it should be reverted/simplified. Assessment:
  the changes are proportionate to the spec, not gold-plating — the v3 typed
  format, `passage_revision`, and reader validation are the foundation CR 8.2
  (build), CR 8.3 (consume), and CR 8.4 (staleness) are written against, so a
  revert would only be redone. The reader stays backward-compatible (existing v2
  artifacts still parse), so current Infinity mode is not broken. The one
  speculative piece is the frozen real-map fixture spec
  (`top_left_bridge.fixture.json`), a checklist not yet exercised. **Decision:
  keep as-is** (Lars, 2026-07-12); no code reverted.
- **2026-07-12 - CR 8.2 implemented:** `build_navgraph` now accepts an explicit
  canonical `level_passages` document, validates the complete document before
  expensive topology work, and derives Python analytic geometry matching the
  runtime's consecutive-point normalization, flat terminal caps, rounded joins,
  constant width, portal depth, self-overlap rule, and raster budgets. The final
  base stage removes body-shadowed nodes, rejects every longitudinal/ambiguous
  local-tangent crossing, retains or creates bounded base-only transverse
  bypasses, then appends protected centreline nodes in stable-id order with
  consecutive typed passage edges and capped endpoint-only transition sectors.
  Typed legs are inclusion-polygon checked, connectors use full-resolution base
  LOS and cannot cross any passage body, original fractional points remain in
  NPZ debug metadata, and passage chains union base component labels for the
  Infinity prefilter. Stats and debug overlays distinguish passages,
  transitions, shadowed/rejected base topology, and unusable endpoints. An
  independent review found and prompted fixes for bent passages behind terminal
  planes, multi-arm edge intersections, connector-body crossings, exact concave
  polygon containment, fractional rounding, bounded bypass candidate work, and
  base-only debug snapping. The focused CR 8.1/8.2/obstacle suite, v3 Node
  contract, all pathing Node suites, translations, Django system check, and
  98/98 `project`+`results` tests on isolated SQLite pass. The frozen real-map
  fixture still has `passage_document: null`; live top-left-bridge assertions
  remain pending the editor-authored canonical document rather than invented
  coordinates.
- **2026-07-12 - CR 8.3 implemented:** the worker/router now consume the baked
  v3 passage topology instead of building a dynamic portal overlay. Passage
  nodes already live in the CSR at `[baseNodeCount, N)`, so `graphAstar` reaches
  them through serialized transition/passage edges with no separate adjacency;
  `buildState` trusts the build's polygon check and keeps every passage node
  routable, and `snapEndpoint` restricts control endpoints and sample targets to
  base nodes, so a passage node is enterable only through a transition edge. A
  new `attachSerializedPassages` verifies the fetched `File.level_passages`
  against the artifact's baked `passage_revision` (a mismatch throws a
  deterministic stale-build error rather than silently downgrading to base-only),
  then indexes the runtime rasters by passage id using the same codepoint id sort
  as `navgraph.py` to map ordinal→id. Typed legs are derived from node ordinals
  (`nodePathToTypedRouteSerialized`): consecutive same-ordinal passage nodes form
  one `passage:<id>` leg, a transition reads as base up to the shared endpoint
  coordinate, and a base edge crossing the passage projection stays base. Barrier
  blocking (`blockedByBarriers`) matches each serialized edge by surface, so a
  projected base barrier cannot block the passage chain and a passage barrier
  cannot block the underpass. The existing complete-raster refinement, passage
  spans, obstacle scoring, typed legality, and layered distinctness are reused
  verbatim through `passageForId`/`activePassages`. The worker's obsolete
  "same base artifact, new passages" overlay-rebuild branch was removed — a
  passage change now arrives as a new artifact keyed by its baked revision; a
  legacy v2 artifact runs only for a file with no passages. New suite
  `project/static/project/js/pathing/dev/navgraph_v3_consume.test.mjs` (15 checks:
  end-to-end typed route over a wall with zero legality violations, forward/
  reverse direction, base-only snapping, deterministic revision-mismatch
  rejection, base/passage barrier surface separation, base-only v3 attach, and v2
  refusal). The dynamic-overlay module is retained per CR 8.5 (not deleted until
  rollout). Verified: all 11 pathing Node suites, the Python
  `test_navgraph_v3_contract`+`test_navgraph_passage_build` (28), and the Django
  system check. CR 8.4 (passage-authoritative build orchestration) is the
  remaining wiring so activation always builds and serves the locked revision.
- **2026-07-12 - CR 8.4 implemented:** build orchestration is now
  passage-authoritative end to end. `navgraph.py` gained a numpy-free
  `read_bin_header` (cheap header parse), `artifact_matches_passage_document`
  (v3 exact `passage_revision`; v2 only for an empty document), a `mask_dimensions`
  helper, and an atomic `save_navgraph` (writes `.npz`/`.bin` to temp siblings via
  a passed file handle, then `os.replace` — a crashed or discarded build leaves no
  half-written binary). `_rebuild_navgraph_for_file` reads region + `level_passages`
  from one snapshot, builds for that revision, and immediately before publishing
  re-locks the row and re-confirms both the region and the baked passage revision;
  a mismatch discards the (still-unwritten) artifact, reports `stale`, and never
  enables the file — the artifact is written only inside the successful branch. A
  committed passage add/edit/remove now revokes infinite play in the same
  transaction and invalidates any in-flight build (`save_element` `level_passages`
  branch and the full `save_file`, both change-detected so a no-op resave keeps the
  flag). `serve_navgraph_file` and the `infinite_mask_maps` picker refuse/hide an
  artifact whose baked revision no longer matches the file's canonical
  passages/mask, so a direct URL cannot bypass the check. The `build_navgraph`
  command loads the exact row for `--file <id>`, and for path/`--all` refuses
  ambiguous shared-`map_file` rows (different region/passage revisions) with a
  developer diagnostic instead of guessing a "latest" row; storage stays mask-scoped
  and per-file revision gating keeps at most one conflicting row servable. Backfill
  staleness now reports mask mtime, region, passage-revision, and format-version
  reasons plus passage counts. The existing `test_passage_edit_does_not_invalidate_
  base_navgraph` was rewritten (passages are baked now, so an edit *does* invalidate)
  and joined by three new Django classes — `NavgraphServingGateTests`,
  `NavgraphRebuildAuthorityTests`, `BuildNavgraphCommandAmbiguityTests`. Verified:
  115/115 `project`+`results` on isolated SQLite (incl. the Python
  `test_navgraph_v3_contract`/`test_navgraph_passage_build`, whose `save_navgraph`
  round-trips exercise the atomic writer), the six listed CR-8 Node suites
  (v3 contract 22 + v3 consume 15 + geometry/layered/overlay/wall-hugging), the
  Django system check, and translation `--check` (no new user-facing copy). Note:
  the repo `manage.py` calls `get_asgi_application()` at import, which freezes
  `DJANGO_SETTINGS_MODULE` before `--settings` is parsed, so isolated SQLite runs
  must pass the settings via the `DJANGO_SETTINGS_MODULE` env var, not `--settings`
  (the latter silently ran earlier CR-8 suites against the shared remote DB).
- **2026-07-12 - endpoint portal-cap hardening:** real-map validation on project 34
  exposed two legal edge cases that the exact integer endpoint rule rejected. A
  continuous saved endpoint can round onto a black pixel while its existing
  three-pixel outward portal band reaches legal base terrain, and two independent
  passages can overlap at an entrance while remaining distinct typed surfaces.
  The builder now chooses a deterministic legal integer representative only inside
  the already-defined outward portal cap (persisted geometry remains unchanged),
  and permits a connector's initial contiguous contact with another passage only
  when it starts inside that passage's terminal entrance region. Re-entry after
  leaving remains forbidden, as does crossing another passage interior. Snapshot
  484 of `20250604_135955.jpg` now builds both in-region passages with 13 transition
  connectors and no unusable endpoints; 130/130 `project`+`results` tests pass.

## Third follow-up change request - build passages into the navgraph

**Requested:** 2026-07-12
**Status:** specified; implementation pending
**Authority:** this section supersedes the original Phase-6 decision to keep
`.navgraph.bin` base-only and dynamically add all passage topology in the worker.
It also supersedes references in `plan.md` to preserving the v2 artifact plus a
dynamic third-dimension overlay. The editor's full-width layered pathfinder,
surface-aware refinement, route classifier, persistence schema, and no-Route-field
decision remain authoritative and are not replaced.

### Product decision and intended simplification

For Infinity mode, passage topology is now part of navgraph construction. After the
ordinary base nodes have been created, append one protected graph node for every
persisted centreline point of every valid passage. A passage's intermediate nodes
connect only to the previous and next point in that same passage. Its first and last
nodes may additionally connect to nearby base nodes with direct legal line of sight.
No other base/passage transition is permitted.

This chain is deliberately a **rough first-stage representation**. It need not model
all lateral choices across the passage width. Once the graph selects a passage, the
existing typed, full-passage-raster refinement remains responsible for choosing a
legal any-angle line across the complete width, optimizing portal anchors, computing
the final terrain-weighted runtime, and producing transient `passageSpans`. The
centreline chain therefore does not revive the rejected "one fixed final route per
passage" design: it is only the high-level spine.

The build order for an Infinity artifact is authoritative:

```text
saved mask + canonical File.level_passages + saved inclusion polygon
    -> base navgraph nodes/topology
    -> projected-crossing isolation
    -> protected passage chains and endpoint connectors
    -> typed artifact serialization
    -> suitability/debug output
    -> explicit Infinity activation
```

### Non-negotiable topology correction

Appending a disconnected passage chain alone does **not** fix the reported bridge
bug. The old planar base graph would still contain its false four-way junction, so a
route could ignore the passage chain and turn between the bridge projection and the
underpass. CR 8 is accepted only if both facts are true:

1. the upper/lower passage exists as a separately typed endpoint-to-endpoint chain;
2. the corresponding longitudinal route through the passage body no longer exists
   in base topology, while a genuine transverse underpass remains connected.

Passage nodes must also be quarantined from all generic graph machinery. They are
never deduplicated with base nodes or with another passage, even at identical
coordinates. They do not enter global k-NN candidate generation, contour adjacency,
witness pruning, or connectivity repair. Those passes must never invent a
mid-passage transition or a passage-to-passage edge.

### CR 8.1 - freeze the artifact and topology contract

**Agent effort:** High
**Recommended owner:** senior navgraph/geometry agent
**Primary files:** `project/navgraph.py`, binary readers in
`navgraph_router.js`/the Node harness, `passage_geometry.js`, and focused fixtures

Before changing production topology, add a minimal synthetic graph fixture and a
real-map fixture covering the top-left bridge in
`mask_20250604_135955.png`. The synthetic fixture must contain a horizontal base
underpass and a crossing passage whose centreline is vertical or diagonal. It must
assert all of the following at graph-path level, before Theta* can hide a defect:

- base-left can reach base-right through the underpass;
- passage-start can reach passage-end through the passage chain;
- passage-start cannot leave into the base graph at the projected middle;
- the base path cannot turn onto the passage-aligned route at the crossing;
- transitions occur only at the two passage endpoint nodes;
- two overlapping passage chains remain independent;
- a passage with two points works in both directions;
- a multi-point passage visits its points in order and cannot skip an intermediate
  point through an ordinary visibility edge;
- empty passage data preserves the established base topology.

The present v2 binary contains no durable surface identity. Do not infer identity
from coincident coordinates. Introduce one documented typed artifact revision
(expected `NAVGRAPH_VERSION = 3`) with the minimum metadata required to reconstruct
typed graph paths without consulting geometry heuristics:

- `base_node_count`;
- a canonical `passage_revision` derived from normalized passage JSON and mask
  dimensions;
- deterministic passage ordinal order (sort by stable passage id, not database or
  input iteration accident);
- a passage-node range table or per-node passage ordinal;
- an edge kind for `base`, `passage`, and `transition` edges;
- the owning passage ordinal for passage edges/nodes;
- enough offsets/counts for strict bounds validation by every reader.

Keep UUID strings out of hot adjacency arrays. The client already receives the
canonical passage document and can map the serialized ordinal to the same stable-id
sort, but it must reject readiness if the document revision does not equal the
artifact revision. Update the module docstring byte layout, `.npz` keys, Python
writer, JS reader, Node reader, truncation/overflow checks, and rebuild error text in
one package. A v2 artifact remains readable only for a file whose canonical passage
list is empty; a passage-bearing file must rebuild to v3 and must never silently run
with a base-only artifact.

**Acceptance:** binary round-trip tests cover zero, one, and multiple passages;
corrupt range/ordinal/kind data is rejected; passage revision is item-order
independent and changes for point/width/id/mask-dimension changes; the frozen
false-junction test fails against the old additive overlay and passes only after
CR 8.2.

### CR 8.2 - construct and isolate passage topology in Python

**Agent effort:** Very high
**Recommended owner:** strongest Python/navgraph agent, followed by an independent
geometry review
**Primary files:** `project/navgraph.py`, `scripts/navgraph_debug.py`, Python
navgraph tests, and parity fixtures shared with passage geometry

#### Builder input and normalization

Change the builder interface to accept the canonical document explicitly, for
example:

```text
build_navgraph(mask_path, region_polygon=None, level_passages=None, verbose=False)
```

The caller, not `navgraph.py`, owns the `File` database lookup. Normalize with the
server validator before starting expensive work. Remove consecutive duplicate
points exactly as runtime normalization does; reject fewer than two distinct points,
non-finite/out-of-bounds geometry, self-overlap, and structural budget failures with
developer-visible build diagnostics. Do not silently build only a subset of a
canonical document.

The Python builder needs only the passage centreline, body footprint, terminal
frames, and endpoint transition points. Put that analytic geometry in a small
testable helper rather than importing Django models into `navgraph.py`. Freeze parity
fixtures against the authoritative JS rules: flat terminal caps, rounded interior
joins, constant full width, and the current outward `PASSAGE_PORTAL_DEPTH = 3` rule.
The Python helper must not become a second editor/runtime classifier.

#### Base-topology isolation

Build ordinary base nodes using the current skeleton/contour/lattice pipeline, then
isolate every passage body before final base edges are serialized:

1. Mark ordinary base nodes whose centres lie inside the drawn passage body between
   its terminal cap planes. Do not include the outward entrance bands in this
   interior set.
2. Remove those shadowed base nodes from the ordinary base roadmap and remap all
   node-indexed structures. Record `base_nodes_shadowed_by_passages` per passage.
   This prevents the projected upper route from remaining traversable as an
   ordinary base-node chain.
3. Preserve the legitimate underpass by creating **base-only transverse bypass
   candidates** between retained base nodes on opposite lateral sides of the
   passage body. A candidate must be within a named bounded radius, remain inside
   the coach polygon, have direct full-resolution LOS on the base mask, enter and
   leave opposite lateral sides, and be sufficiently transverse to the local
   passage tangent. Measure the tangent where the candidate crosses the footprint;
   never use one global angle for a bent passage.
4. Reject passage-intersecting base candidates that run longitudinally with the
   local passage tangent. Generic k-NN, skeleton fallback, and connectivity repair
   must use the same rejection predicate, so a later repair pass cannot recreate
   the deleted bridge-aligned base route.
5. Keep transverse bypass edges typed `base`. They are the underpass. They must
   never become a transition merely because their projected line crosses a passage
   node or passage edge.

Start with named, conservative constants for bypass radius and transverse/longitudinal
angle thresholds. Do not bury thresholds inline. If the real-map fixture cannot
retain both the underpass and passage without an angle heuristic that generalizes,
stop and report the failing geometry rather than falling back to the old four-way
junction.

#### Passage nodes and edges

After base-node compaction and base-edge isolation:

1. Append passage nodes after all base nodes, in canonical passage-id order and
   centreline-point order. Preserve distinct nodes even if rounding puts two surface
   nodes at the same integer coordinate. Store the original finite point coordinates
   for geometric weighting/refinement metadata if integer graph coordinates would
   otherwise collapse a short segment.
2. Mark every passage node protected. Do not pass it through `_dedupe_nodes`,
   `_candidate_edges`, `_prune_redundant_nodes`, or `_repair_connectivity`.
3. For each consecutive point pair, add exactly one undirected typed passage edge.
   An intermediate node has exactly two same-passage neighbours except at a repeated
   point rejected during normalization. No chord, k-NN shortcut, cross-passage edge,
   or base connector is permitted there.
4. Weight a chain edge by passage-surface cost along that centreline segment using
   the same v1 fast-terrain convention as the passage raster. This is an approximate
   high-level cost; final runtime still comes from surface-aware refinement. Keep the
   graph heuristic admissible with the cheapest base/passage per-pixel cost.
5. At the first and last node only, choose an integer graph representative. Use normal
   rounding when it is legal. If rounding lands on an impassable pixel, a fallback is
   permitted only inside the existing bounded outward portal cap: no farther than
   `PASSAGE_PORTAL_DEPTH` longitudinally, no farther than the passage radius laterally,
   and still inside the inclusion polygon. This is raster discretization of the saved
   entrance, not mutation of persisted geometry.
6. Query nearby **base nodes** within a named radius. Add a bounded number of transition
   connectors (nearest visible candidate in each useful angular sector, with an overall
   cap) when the segment has direct full-resolution base-mask LOS and stays inside the
   inclusion polygon. Intermediate nodes are never connector candidates. A connector
   may leave an initial overlapping terminal entrance cap of another independent
   passage, but may not re-enter it or cross another passage interior.
7. A transition connector changes surface only at the chosen endpoint graph
   representative. Split its eventual typed geometry so the adjacent base and passage
   legs share that coordinate. If the bounded cap has no legal representative or no
   legal base connector, fail the Infinity build with the passage id and endpoint name;
   do not silently omit the passage.

Endpoint placement was deliberately left to coaches in the editor, so build-time LOS
failure is a release-readiness diagnostic, not authorization to mutate the saved
passage. The bounded integer representative above does not change the persisted point;
do not otherwise snap or move saved geometry behind the user's back.

#### Components, regions, and debug output

- Passage chains may connect two base-mask components. Union component labels through
  a valid endpoint-to-endpoint chain and update the node/component prefilter used by
  Infinity sampling; otherwise the current coarse-label rejection can discard a
  pair that is connected only by a bridge. Sampling and endpoint snapping remain
  level 0 and must never select a passage node as a control anchor.
- Apply the coach polygon to base nodes, bypass edges, passage points, chain edges,
  and endpoint connectors. No typed leg may bypass the region guarantee.
- Extend stats with passage count, passage node/edge/connector counts, shadowed base
  nodes, retained transverse bypasses, rejected longitudinal edges, unusable
  endpoints, passage revision, and per-stage timings.
- Render passage nodes/edges/connectors in distinct colors in
  `.navgraph.debug.png`; show removed/shadowed base topology in a diagnostic color
  only when an explicit debug flag requests it. The normal overlay must depict the
  effective serialized topology, so the top-left bridge can be reviewed honestly.

**Acceptance:** the synthetic fixture passes; on
`mask_20250604_135955.png` the top-left bridge has one continuous typed passage
chain, base connectivity beneath it, no base/passage turn at the projected crossing,
and transitions only at its two saved endpoints. Every intermediate passage node has
same-passage degree two. All passage endpoints have at least one legal base connector.
No generic or repair edge touches an intermediate passage node. Region legality and
base-only navgraph acceptance remain green.

### CR 8.3 - consume typed serialized passages in the worker

**Agent effort:** High
**Recommended owner:** senior JS/pathfinding integration agent
**Primary files:** `navgraph_router.js`, `navgraph_passage_overlay.js`, `worker.js`,
`refine_theta.js`, Node harnesses, and mask scene source

- Parse the v3 surface/edge metadata and build CSR adjacency directly from the
  serialized graph. Remove the current dynamic portal adjacency as the source of
  Infinity topology for v3 artifacts. Keep only reusable passage-raster and typed
  refinement helpers; do not retain two competing ways to connect a passage.
- Verify the fetched canonical passage document against the artifact revision before
  building state or accepting prefetched pair requests. A mismatch is a stale-build
  error, not an empty-passage fallback.
- Restrict control endpoint snapping and sample targets to indices below
  `base_node_count`. Graph A* may traverse typed passage nodes after entering through
  a serialized transition edge.
- Convert each graph node path to typed legs from edge metadata. Consecutive passage
  edges with the same ordinal form one `passage:<id>` leg. A transition edge changes
  identity only at the serialized endpoint coordinate. Base edges that cross the
  passage projection remain base.
- Reuse the existing complete-raster passage refinement, optimized anchor handling,
  typed legality, passage-span creation, obstacle scoring, surface-aware barriers,
  and layered distinctness. The serialized centreline must never become the final
  served polyline without that refinement and legality pass.
- Barrier blocking must test serialized base edges against base barriers and
  serialized passage edges against the matching passage surface. A projected base
  barrier must not block the passage chain, and a passage barrier must not block the
  underpass.
- Remove or update cache keys that assumed passages could change while retaining the
  same base artifact. Prefetched scenes remain keyed by the artifact passage revision.

**Acceptance:** v3 and matching JSON generate typed refined routes; revision mismatch
is rejected deterministically; the graph-level false-junction fixture, wall-hugging
suite, layered distinctness suite, barrier suite, and no-passage v2 compatibility
suite pass. Generated final routes report zero base/passage legality violations.

### CR 8.4 - make build orchestration passage-authoritative

**Agent effort:** High
**Recommended owner:** Django/repository integration agent
**Primary files:** `project/views.py`, `build_navgraph.py`, `media_access.py`, map
listing/serving tests, and passage-save tests

The current background activation build passes only `infinite_region`; the management
command also looks up only the region. Update every build entry point to pass the same
locked, canonical `File.level_passages` revision used to authorize activation.

1. In `_rebuild_navgraph_for_file`, read the file, mask name, region, and normalized
   passage document from one coherent database snapshot. Compute region and passage
   revisions before building. Immediately before publishing the artifact and flipping
   `infinite_enabled=True`, lock the `File` again and confirm both revisions still
   match. If either changed during the build, discard the temporary output and report
   the build as stale; never publish an artifact for the previous passage document.
2. Write `.npz` and `.bin` to temporary sibling files and atomically replace the
   served artifacts only after the revision check. A failed/stale build must leave no
   half-written binary and must not enable the file.
3. A committed passage add/edit/remove makes the existing Infinity artifact stale.
   Do not serve it with new JSON. Prefer the existing activation workflow: mark the
   file not Infinity-enabled in the same successful passage-save transaction, retain
   the old artifact only as an unservable diagnostic, and require reactivation to
   build the new revision. If product UX instead chooses automatic rebuild, it must
   use the same token/revision race protection and may not issue one build per wheel
   tick.
4. `serve_navgraph_file` and the Infinity map listing must verify that a served
   artifact revision matches the current file's canonical mask/region/passages.
   Direct URL access must not bypass this check.
5. Extend `build_navgraph --file <File id>` to load that exact file's region and
   passages. For path-based `--file` and `--all`, never choose an arbitrary "latest"
   `File` when multiple rows reference the same `map_file` with different region or
   passage revisions. First audit this repository condition. If conflicting rows
   exist, make artifact storage file-scoped and update serving/listing paths; otherwise
   enforce and test the uniqueness assumption. Skip ambiguity with a clear developer
   diagnostic rather than building the wrong topology.
6. Staleness checks include mask mtime/content identity, polygon revision, passage
   revision, builder version, and artifact format version. Backfill output reports
   all rebuild reasons and passage counts.

No new user-facing text is inherently required. If disabling/rebuilding passage-aware
Infinity adds visible status or validation copy, wrap it in gettext, add DE/FR/IT rows
to `locale/source_messages.py`, run translation `--check` and `--build`, and restart
the development server as required by `AGENTS.md`.

**Acceptance:** activation always builds the saved passage revision; an edit during a
build cannot enable stale output; a passage edit makes the previous artifact
unservable; forced backfill is deterministic; ambiguous shared-map ownership is
either eliminated by file-scoped artifacts or rejected explicitly; empty passages
still build and serve through the documented compatibility path.

### CR 8.5 - independent verification and rollout gate

**Agent effort:** High
**Recommended owner:** fresh independent review agent plus human map review

Run, at minimum:

```text
.venv\\Scripts\\python.exe manage.py check
.venv\\Scripts\\python.exe manage.py test project results
.venv\\Scripts\\python.exe scripts/manage_translations.py --check
.venv\\Scripts\\python.exe scripts/manage_translations.py --build
node project/static/project/js/pathing/dev/passage_geometry.test.mjs
node project/static/project/js/pathing/dev/layered_passage.test.mjs
node project/static/project/js/pathing/dev/navgraph_passage_overlay.test.mjs
node project/static/project/js/pathing/dev/wall_hugging.test.mjs
node project/static/project/js/pathing/dev/navgraph_v3_contract.test.mjs
node project/static/project/js/pathing/dev/navgraph_v3_consume.test.mjs
```

The `navgraph_v3_consume` suite is the CR 8.3 worker/router consumption contract
(added 2026-07-12). The last dedicated line before it is the CR 8.1 binary/topology contract suite (added 2026-07-12);
its Python twin is `project.test_navgraph_v3_contract`, run by the `manage.py test
project` line above. Document any further CR-8 test commands in this list and in
the touched test headers. Re-run the representative navgraph batch on no-passage and passage-bearing
maps. Compare N/E, artifact bytes, build time, worker state-build time, pair latency,
refinement fallback, and rejection taxonomy against the previous dynamic-overlay
baseline.

Manual acceptance must include at least five real maps: the reported top-left bridge,
a narrow straight bridge, a wide diagonal bridge, a bent tunnel, and overlapping
independent passages. For each, inspect both the typed debug graph and final refined
routes in both directions. Confirm underpass continuity, passage continuity, endpoint-
only transitions, no mid-corridor switch, no same-cap shortcut, no cross-passage
edge, polygon containment, and correct barrier surface.

Do not delete the old dynamic-overlay code or backfill production artifacts until the
new fixture demonstrates the old false junction and the v3 path passes all acceptance
checks. Rollout is complete only after stale v2 passage-bearing artifacts cannot be
listed or served.

## Post-implementation change request - flat portals and three-level tools

**Requested:** 2026-07-10  
**Status:** follow-up package in progress; CR 1, CR 2, CR 3, CR 4, CR 5, and CR 6 complete — implemented 2026-07-11
**Authority:** this section supersedes the earlier rounded-cap and Phase-5 UI text
where they conflict. Keep the earlier text as the implementation history; do not
mistake it for the target behaviour for the follow-up work. The **second
follow-up package** below (2026-07-11) supersedes this section in turn where
they conflict — in particular the 5 px inward portal bands, the separate
Add/Edit passage actions, and every editor-side portal placement check.

### Second follow-up package — implemented 2026-07-11

Requested by Lars after reviewing the first follow-up package; all items are
implemented and verified.

- **CR 1 revision — outward 3 px portals:** `PASSAGE_PORTAL_DEPTH` is now 3 and
  the entrance bands lie **outside** the drawn corridor: each terminal segment
  is extended outward by the portal depth and the appended full-width rectangle
  is the band (raster membership `-3 ≤ projection < 0`). Clearance, membership,
  `distanceToPassage`, `hitTestPassage`, SVG portal lines, and all fixtures
  follow the outward planes. `passageEntranceAt` treats the drawn cap plane as
  inclusive and honors its tolerance longitudinally so classification of
  anchors on the plane stays robust. Deterministic raster hashes were re-frozen.
- **Portal placement checks removed:** the overlapping/touching-band rejection
  and the "entrance must overlap passable terrain" editor check are gone —
  placement judgment belongs to the coaches. Only a band with zero raster cells
  inside the map still rejects (`empty-entrance`), since such a passage could
  never be entered. Self-overlap, budget, and structural validation remain.
- **CR 2 revision — abortable saves, front end is truth:** passage saves moved
  off the serialized `_saveQueue` onto `passage_save_client.js`
  (`createPassageSaveClient`): a newer save aborts the in-flight request
  (superseded ≠ failure) and server responses are no longer written back into
  `project.level_passages` or route metrics, so a slow stale response can never
  revert newer local edits. The new `passage_save_client.test.mjs` drives the
  client with a spy fetch: one request per action carrying the full metric
  batch, abort-on-newer-save, and the error/failure taxonomy.
- **CR 3 revision — combined Add/Edit, icons, RCM fix, region finish:** the
  third-dimension family now has two actions, `edit` (combined add/edit:
  click on free map adds draft points, node click drags, wheel over a passage
  changes width, right click/Enter finishes) and `remove`; legacy leaf ids map
  onto the combined action. The bridge icon uses the Font Awesome bridge glyph
  and the mask-edit family the FA mask-ventilator glyph (`face-mask`). The RCM
  level-3 all-orange bug is fixed (level-3 segments carry `data-family` for hit
  grouping and were styled by the family loop; only the exact active
  family/action pair highlights now). The infinity region polygon now closes on
  distance to the first vertex (matching the visible close ring) instead of
  requiring the exact 6 px handle as event target — a stacked near-miss vertex
  could previously make finishing impossible.
- **CR 4 revision:** `D` still removes the last draft point; with no open draft
  it deletes the most recently added passage (one undo entry, one save).
- **CR 6 revision — passage-aware Infinity culling:** `generateOnePair` now
  gates the refined pair through `layeredRouteDistinct` whenever either route
  carries passage spans: a pair sharing its passage traversal is rejected
  (`distinct`) even when a level-0 obstacle projected underneath technically
  separates the lines. Base-only pairs keep the established selection tuning.
- **Touch:** holding still (~600 ms) on an open draft finishes the passage —
  touch has no right click or Enter.

**Verification:** all 8 Node pathing suites (including the new save-client
suite and an Infinity-shaped same-passage regression in
`layered_distinct.test.mjs`), `node --check` on every touched file,
`manage_translations.py --check`/`--build`, 60/60 `project`+`results` Django
tests on isolated SQLite, Django system check, and `collectstatic` pass.
Manual visual QA (CR 7) remains open.

### Change-package overview and agent effort

| Change package | Agent effort | Recommended owner | Depends on |
|---|---|---|---|
| CR 1 - flat runtime corridor and 5 px portals — **COMPLETE (2026-07-11)** | Very high | Senior geometry/pathfinding agent | None |
| CR 2 - one passage action, one save request — **COMPLETE (2026-07-11)** | High | Senior Django/editor integration agent | CR 4 transaction boundaries |
| CR 3 - three-level sidebar and radial context menu — **COMPLETE (2026-07-11)** | High | Frontend agent familiar with the editor tool state machine | None |
| CR 4 - add/edit/remove interactions and undo accounting — **COMPLETE (2026-07-11)** | Very high | Senior frontend interaction agent | CR 1 hit testing, CR 3 state hierarchy |
| CR 5 - stronger passage rendering — **COMPLETE (2026-07-11)** | Medium | SVG/CSS frontend agent | CR 1 portal geometry |
| CR 6 - wall-hugging any-angle investigation and correction — **COMPLETE (2026-07-11)** | Very high | Senior pathfinding agent | CR 1, then diagnostic fixtures |
| CR 7 - translations, regression tests, and manual QA | High | Independent review agent plus human visual review | CR 1-6 |

The packages should not be implemented as isolated visual tweaks. In particular,
CR 1 changes the topology used by the worker and classifier, CR 4 defines when an
edit becomes one undo/save action, and CR 2 must use those transaction boundaries.

### CR 1 - flat corridor ends and rectangular portal bands — **COMPLETE (2026-07-11)**

**Agent effort:** Very high  
**Primary files:** `passage_geometry.js`, `passage_classifier.js`,
`navgraph_passage_overlay.js`, `layered_astar.js`, geometry/classifier/navgraph
fixtures, and the editor's passage hit testing

This is a runtime geometry change, not merely a UI change. The persisted document
remains `{id, points, width}` and all existing passages adopt the new geometry; do
not add a cap-style field or a new raster/model field. No data migration is needed.

Required geometry:

- The two terminal corridor ends are flat butt caps perpendicular to the first and
  last non-zero centreline segments. A point beyond either terminal cap is outside
  the passage even when its distance to the endpoint is less than `width / 2`.
- Keep interior joins gap-free. Rounded joins at bends are acceptable unless a
  separate product decision changes them; "flat" in this request applies to the two
  terminal ends, not to creating cracks between adjacent polyline segments.
- Each entrance is a rectangular portal band clipped to the corridor: full passage
  width across the terminal tangent and exactly **5 mask pixels** deep along the
  centreline direction. The 5 px value must be one exported geometry constant used
  by rasterization, classification, transition construction, SVG rendering, and
  tests.
- The start band extends inward from the start cap; the end band extends inward from
  the end cap. It must not protrude beyond the passage or use circular distance from
  the endpoint.
- Replace the current circular-cap overlap rule with an authoritative disjoint-band
  test. Reject a passage if its two 5 px entrance cell sets overlap or touch in a way
  that makes direction ambiguous. Preserve the existing self-overlap and work-budget
  protections.
- Update `distanceToPassage()`, `hitTestPassage()`, `passageEntranceAt()`, the saved
  route classifier, editor hit testing, layered base/passage transitions, and
  Infinity portal sampling to use the same flat-cap/band definition. The current
  point-to-segment distance helper clamps at endpoints and therefore creates round
  caps; it cannot remain the final membership test by itself.
- Bounds and segment-local raster work estimates may still include conservative
  padding, but actual grid membership must be clipped by the two endpoint half
  planes. Boundary-band costs must follow the new flat ends as well as the sides.

Required fixtures:

- horizontal, vertical, and diagonal flat ends;
- a point just inside and just outside each terminal half-plane;
- a bent multi-point corridor with gap-free joins and flat terminal ends;
- exact 5 px entrance depth and full-width transition coverage;
- short/acute passages whose entrance bands overlap;
- forward and reverse traversal, saved-route reclassification, projected crossing,
  overlapping independent passages, and Infinity portal reconstruction;
- unchanged no-passage routing.

**Implementation record — 2026-07-11:**

- `passage_geometry.js` now exports the authoritative
  `PASSAGE_PORTAL_DEPTH = 5` and shared terminal frames. Runtime membership is
  clipped by the start/end tangent half-planes, while the existing union of
  segment strokes keeps rounded, gap-free interior joins. The terminal planes
  also participate in clearance calculation, so the boundary-cost band follows
  the flat ends.
- Entrance rasters are the corridor cells whose inward terminal projection is
  from 0 through 5 mask pixels. Normalization rejects empty, overlapping, or
  8-neighbour-touching start/end entrance cell sets after preserving the existing
  self-overlap, allocation, and work-budget checks.
- `distanceToPassage()`, `hitTestPassage()`, and `passageEntranceAt()` now enforce
  the shared half-plane/band rules. The saved-route classifier, editor hit testing,
  layered base/passage transitions, and Infinity portal overlay continue to consume
  these shared helpers or the authoritative entrance arrays, so they cannot create
  circular-cap or mid-corridor transitions.
- The editor renders butt-capped corridors and terminal-tangent portal bands using
  the exported 5 px constant; the overlap validation message and DE/FR/IT catalogs
  were updated and rebuilt.
- Regression coverage now includes horizontal, vertical, diagonal, and bent flat
  ends; just-inside/outside half-plane probes; exact portal depth and full-width
  edge transitions; straight and acute overlapping bands; forward/reverse layered
  routing; saved-route reclassification; projected and independent crossings;
  Infinity reconstruction; deterministic raster hashes; and unchanged base-only
  behavior. All pathing `*.test.mjs` suites and
  `scripts/manage_translations.py --check` pass.

### CR 2 - coalesce passage persistence into one save-element request — **COMPLETE (2026-07-11)**

**Agent effort:** High  
**Primary files:** `editor.js`, the `save_element` branch in `project/views.py`, and
focused request/transaction tests

**Status:** complete — implemented 2026-07-11.

**Implementation record:**

- `PassageEditor` now waits for passage-dependent route recalculation and builds
  one lazy `route_updates` batch alongside the canonical `level_passages`
  document. Add, edit, remove, point-drag, and width-wheel passage actions all
  use that single persistence path; the old one-request-per-route follow-up was
  removed. The batch contains only persisted route identifiers plus the derived
  `obstacle` and `run_time` values, so `Route.rP` and the model schema remain
  unchanged.
- The `save_element` passage branch now locks the target file and validates every
  route update against that file/control pair. It rejects duplicate, malformed,
  foreign, or out-of-range updates, then writes the passage document and all
  derived route metrics in one database transaction. The response returns the
  canonical passage document, route identifiers/values, and one `last_edited`
  timestamp. Atomic failure returns the existing save failure path and the local
  action is not reported as persisted.
- Added Django coverage for the successful multi-route batch, invalid-metric
  rollback, and cross-file ownership rejection. The editor contract test asserts
  the single batched request path and absence of per-route passage follow-up
  saves. Snapshot saves remain independent and retain their existing cadence.

**Verification:** SQLite-isolated `LevelPassagesPersistenceTests` (12/12),
passage editor contract, passage geometry, layered passage, and layered
distinctness Node suites, plus translation `--check`/`--build`.

Observed current cause: `PassageEditor.finish()` and `removeAt()` save the
`level_passages` document once, then `saveRecalculatedRoutes()` calls `saveRoute()`
for every route in every control pair. A single passage action therefore produces
`1 + route_count` calls to `/editor/save-element/`, which explains the reported
burst of roughly ten save-element logs. The control-pair in-flight guard does not
coalesce those route saves.

Required behaviour:

- One committed passage add, edit, or remove action must create exactly **one**
  `/editor/save-element/` request. Do not follow it with one request per route.
- Recalculate passage-dependent route values before building that request, then send
  the canonical `level_passages` document and the minimal derived route updates in
  the same payload. On the server, validate that every route belongs to the target
  file and update the passage document and route metrics in one database transaction.
- Keep `Route.rP` and the model schema unchanged. Only already-authorized derived
  values such as obstacle/runtime fields should be batched; do not turn this into an
  unrestricted bulk route editor.
- Return the canonical passage document, updated route identifiers/values as needed,
  and one `last_edited` value. Preserve the existing failure warning and do not mark
  the local action persisted when the atomic request fails.
- Snapshot saves remain a separate endpoint. If this action reaches the existing
  every-ten-actions threshold, one `/editor/save-snapshot/` request is allowed in
  addition to the single save-element request; it must not be logged or counted as
  another element save.
- Add a browser contract test that spies on `fetch`: for a project with many routes,
  each add/edit/remove operation emits one save-element request and contains all
  required metric updates. Add Django tests for ownership rejection and rollback of
  the entire batch when any route update is invalid.

### CR 3 - restore a three-level mask tool hierarchy — **COMPLETE (2026-07-11)**

**Agent effort:** High  
**Primary files:** `editor.js`, `editor.css`, `editor.html`, and `static/js/icons.js`

The sidebar and radial context menu must expose the same state tree:

```text
Level 1: Mask tool
  Level 2: Lock / view only
  Level 2: Mask edit
    Level 3: Add
    Level 3: Remove
  Level 2: 3rd dimension
    Level 3: Add
    Level 3: Edit
    Level 3: Remove
```

Sidebar requirements:

- Restore the older column-style subtool layout used by other tool modes. The main
  Mask wheel segment is level 1. Immediately beside it, render a vertical level-2
  column in this order: lock/view-only, mask edit, 3rd dimension. Render the active
  family's level-3 actions in a separate vertical column to the right of level 2.
- Lock has no level-3 actions. Mask edit shows Add and Remove. 3rd dimension shows
  Add, Edit, and Remove. Do not show both families' actions simultaneously and do
  not retain the current labelled grid of two families.
- Add a `bridge` icon to `static/js/icons.js` and use it for 3rd dimension. Continue
  using the shared `icon()`/`<x-icon>` path; do not paste standalone SVG into the
  editor code.

Radial context menu (RCM) requirements:

- Add one more radial level for hierarchical branches instead of flattening Mask
  into five same-level leaves. The Mask segment is level 1, lock/mask edit/3rd
  dimension are level 2, and the chosen family's actions are level 3.
- Size and hit-test all three rings from shared radii. Hovering a level-2 family must
  populate its level-3 ring, preserve the guide line, and keep sticky/double-right-
  click selection working. Other tools may keep their current depth.
- A right click used to finish an in-progress 3d Add operation (CR 4) takes priority
  and must not open or select from the RCM.
- Sidebar clicks, RCM selection, keyboard handling, cursor state, and help text must
  all use one nested mask-tool state machine. Do not reintroduce separate flattened
  state that can drift between the two menus.

**Status:** complete — implemented 2026-07-11.

**Implementation record:**

- Replaced the flattened Mask subtool list with one canonical nested state machine:
  `lock/view`, `mask-edit/add|remove`, and
  `third-dimension/add|edit|remove`. Legacy leaf IDs remain readable when restoring
  undo snapshots, while new sidebar and RCM selections write the canonical state.
- Restored the two-column sidebar layout: the level-2 family column contains lock,
  mask edit, and 3rd dimension; the level-3 column contains only the active family's
  actions. The third-dimension family uses the shared `bridge` icon from
  `static/js/icons.js`.
- Extended the RCM with shared center/level-1/level-2/level-3 radii. Mask branches
  render level-2 families and dynamically populate the level-3 action ring on hover;
  guide-line, sticky, double-right-click, wheel, cursor, and keyboard dispatch all
  use the same nested state.

**Verification:** `node --check` for `editor.js` and `icons.js`,
`python scripts/manage_translations.py --check`, and `git diff --check` pass.

### CR 4 - direct passage add, edit, remove, and undo interactions

**Agent effort:** Very high  
**Primary files:** `editor.js`, `editor.html`, `editor.css`, editor contract tests,
and all translated help strings

**Status:** Complete - 2026-07-11

**Implementation notes:**

- Add now starts one undo/action transaction before its first point. Primary clicks
  append points, right click or Enter finishes, `D` removes the last draft point,
  and Escape cancels. Double click no longer finishes. The finishing right-button
  down/up pair is consumed before the RCM or pan handlers, and the sidebar Finish/
  Cancel buttons were replaced with translated direct-interaction help.
- Edit has no persistent passage selection. Each hover, wheel, and primary-button
  down resolves all passage hits through shared passage geometry. Node candidates
  are ordered by screen distance, topmost render order, stable passage id, and point
  index. A body hit outside the node tolerance does not move a node. Hover feedback
  is transient and node drags retain their passage id and point index for the full
  gesture.
- Width wheel ticks update the hovered passage immediately and are coalesced into
  one undo/save action by an idle debounce. Node drags push once before their first
  real mutation and commit once on pointer up. Full-document geometry/work budgets,
  mask bounds, entrance overlap, and passable-terrain checks run before edits are
  accepted; invalid drags restore the pre-gesture passage document.
- Remove still deletes the whole topmost hit passage and contributes one shared
  undo/action entry. Cancelled/no-op/invalid interactions do not retain undo entries.
  Undo/redo and state restore clear drafts, hover, drag, and width-debounce state.
- `passage_editor_contract.test.mjs` now guards the direct Add controls, right-click
  RCM priority, deterministic Edit ordering, width debounce, first-mutation undo
  boundary, and removal of the sidebar Finish/Cancel buttons. The focused Node
  contract, JavaScript syntax check, translation check/build, and `git diff --check`
  pass. The focused Django passage suite could not start because this environment's
  configured PostgreSQL host is network-blocked; no database assertion ran.

#### Add mode

- A normal primary click places the first point and subsequent primary clicks append
  points. Right click finishes the passage. Enter also finishes it.
- Remove the Finish and Cancel buttons from the sidebar. Replace them with concise,
  translated key/mouse help describing click to add a point, right click or Enter to
  finish, `D` to remove the last point, and Escape to cancel.
- Do not finish on double click. Suppress the browser context menu and the editor RCM
  for the finishing right click, and ensure that right-button down/up cannot also pan
  or add a point.
- `D` removes the most recently placed draft point and refreshes the preview. Ignore
  the shortcut while typing in an input/textarea/contenteditable element or when a
  Ctrl/Alt/Meta modifier is held. With no draft point it does nothing.

#### Edit mode

- There is no selected-passage state. For every hover/wheel/down event, hit-test all
  visible passages below the cursor using the shared flat geometry.
- Mouse wheel over a passage changes that passage's constant width, with the existing
  min/max limits and immediate preview. Consume the wheel so it does not also zoom
  the map or alter the mask brush. Coalesce a wheel burst into one edit action and
  persist after a short idle debounce, not once per wheel tick.
- On primary-button down, test the editable centreline nodes of every passage below
  the cursor. Drag the nearest node, preserving its point index and passage id for
  the gesture, and commit on pointer up. A body hit that is not close enough to a node
  must not silently move an arbitrary node.
- When candidates overlap, use a deterministic rule: nearest node in screen pixels,
  then topmost render order, then stable passage id/point index. Show hover feedback
  for the node or passage that would receive the gesture, but do not persist a
  selection.
- Validate width and node moves with the complete-document geometry budgets and
  entrance/passable-terrain rules before commit. Invalid edits restore the pre-edit
  geometry and show the translated validation message.

#### Remove mode

- Preserve the current object-level delete behaviour: clicking any hit passage
  removes the whole passage. Use the same all-passages/topmost hit ordering as Edit.

#### Undo and snapshot action counter

- Push the undo state **before** the first point of a new passage, before the first
  actual mutation of a width-wheel or node-drag edit, and before deletion. The current
  add path pushes only at `finish()`; move that boundary to the first point and do not
  push a second state at finish.
- One add gesture, one coalesced wheel edit, one node drag, or one delete contributes
  exactly one call to the shared undo/action helper and therefore increments
  `actionCount` exactly once. This ensures the action participates in the existing
  `SNAPSHOT_EVERY` counter.
- Do not push merely for hover, entering Edit mode, a mouse-down that does not move,
  or an invalid/no-op edit. A wheel burst and a drag need explicit transaction state
  so repeated move events neither fill the undo stack nor trigger repeated saves.
- Ensure Undo while an Add draft is open cancels the draft and restores the project
  snapshot captured before its first point. Redo/restore must also clear transient
  hover, drag, debounce, and draft state before redrawing.

### CR 5 - stronger, simpler passage appearance

**Agent effort:** Medium  
**Primary files:** the passage SVG renderer in `editor.js` and passage rules in
`map_objects.css`

**Status:** complete — the renderer now uses shared terminal frames for flat butt
caps and 5 mask-pixel transverse portal bands in both committed and preview
geometry. The dashed centreline and circular/dashed entrance treatment were
removed. Passage overlays now use a stronger cyan accent with higher normal and
preview opacity; the control/route purple accent remains separate. Passage
selection has no persistent visual treatment, while node handles remain limited
to the active draft and transient hover feedback.

**Verification:** `node --check project/static/project/js/editor.js`, the passage
geometry/classifier suite, the passage editor contract suite, `git diff --check`,
and the rebuilt repository translation catalogs pass.

- Render the corridor with flat SVG caps (`stroke-linecap="butt"`) so its visible
  terminal planes agree with CR 1. Preview and committed geometry must use the same
  terminal tangent logic.
- Remove the dashed centreline completely.
- Replace the circular/dashed entrance markers with straight, non-dashed transverse
  end/portal lines. Their stroke width is the shared **5 mask pixel** portal thickness
  converted through `PATHING_MASK_TRAIN_SCALE`; do not use `vector-effect` for that
  thickness because it represents map geometry, not a fixed screen decoration.
- Use a stronger passage-specific accent and higher normal opacity so the overlay is
  immediately recognizable as a passage, including outside Mask mode. Keep preview/
  hover contrast accessible and ensure the route/control accent is still visually
  distinct.
- Node handles appear only as Edit-mode hover/drag feedback or as Add draft points;
  there is no persistent selected rendering.

### CR 6 - investigate and correct wall-hugging passage routes — **COMPLETE (2026-07-11)**

**Agent effort:** Very high  
**Primary files:** `layered_pipeline.js`, `layered_astar.js`, `theta_star.js`,
passage fixtures/benchmarks, and possibly `navgraph_passage_overlay.js` for Infinity

The reported symptom is that a route can hug one passage wall even though a gradual
lateral change across the passage looks shorter. The following code is suspicious
and must be measured before choosing a fix:

1. `layeredAstar()` chooses one exact base/passage transition cell. Then
   `refineTypedPath()` refines each surface leg independently and pins both ends of
   every refined leg to those discrete transition cells. The any-angle stage cannot
   jointly slide an entrance crossing and the adjacent base/passage lines to find a
   better continuous route.
2. `refineDenseLeg()` builds a fixed-radius corridor around the dense 8-neighbour
   result. On a passage wider than twice that radius, much of the legal passage
   surface can be excluded from refinement. A wall-biased dense leg can therefore
   become a wall-biased any-angle leg even when open space exists farther away.
3. `guidedThetaStar()` advances one mutable `guidanceIdx` for the entire search as
   nodes are popped, rather than storing guidance progress per search state. Its
   heuristic targets the current guidance waypoint rather than always the final
   goal. That makes the result expansion-order dependent and is worth isolating,
   even if it also affects the legacy base-only path.

Required diagnostic work:

- Add a wide straight and wide diagonal passage fixture where the globally shortest
  route enters near one side and changes lateral position gradually. Record the
  selected start/end portal cells, dense layered cost, refined cost, minimum distance
  to each wall, and a reference optimum over the full legal passage raster.
- Add variants with a broad entrance, a bend, unequal base-terrain costs near the
  entrance, reversed direction, and widths both below and above twice the refinement
  corridor radius.
- Separately test the three suspicions above. Do not label the issue fixed merely
  because a larger hard-coded corridor makes one screenshot look better.

Preferred correction sequence:

1. Refine a passage leg over its complete cropped passage raster (or a corridor that
   is provably wide enough to contain the whole relevant cross-section), since these
   rasters are already tightly bounded.
2. If the discrete transition remains the limiting factor, jointly evaluate/legalize
   alternative cells across the 5 px portal bands and allow the refined transition
   anchor to move, while requiring the base and passage legs to share the exact same
   projected transition point.
3. If guidance-state tests reproduce expansion-order bias, make guidance progress
   part of the search state or replace the waypoint heuristic with an admissible
   goal-based formulation. Protect the no-passage legacy path unless separate tests
   authorize changing it.

Acceptance requires the new fixtures to choose the shorter gradual line, preserve
flat-portal-only level changes, remain legal after simplification, and show no
material no-passage regression. Apply the same diagnosis to Infinity if its dynamic
portal route/refinement shows the symptom.

**Implementation record — 2026-07-11:**

- The investigation reproduced all three limiting mechanisms in the passage branch:
  a fixed-radius refinement tube excluded legal cross-sections wider than 48 px,
  independently pinned transition cells left avoidable bends after per-leg
  refinement, and the shared mutable waypoint index could make passage refinement
  expansion-order dependent. The legacy base-only branch remains unchanged.
- `layered_pipeline.js` now refines every passage leg over its complete cropped legal
  raster and uses goal-directed Theta* guidance for that surface. Before refinement,
  a bounded deterministic coordinate-descent pass evaluates live cells across both
  5 px portal bands, legalizes improved anchors, and writes the same exact projected
  coordinate into the adjoining base and passage legs. Transitions therefore remain
  limited to the two authoritative flat portal bands.
- Infinity used the same fixed-radius passage tube. `navgraph_router.js` now also
  refines dynamic passage legs over their complete cropped raster with goal-directed
  guidance; its established base-navgraph corridor remains unchanged.
- `wall_hugging_fixtures.mjs` adds wide straight, reversed, unequal-entrance-terrain,
  below-2×-radius, diagonal, and bent cases. `wall_hugging.test.mjs` records the chosen
  portal cells, dense layered cost, total and passage refined costs, both wall
  clearances, and an independent full-raster 8-neighbour reference optimum. It also
  checks gradual lateral movement, exact opposite-band transitions, post-simplify
  raster legality, deterministic saved-route reclassification, and the Infinity
  dynamic-overlay path.
- On the recorded run, passage any-angle costs were 859.60–1115.09 versus discrete
  full-raster reference costs of 924.58–1200.36. The six end-to-end layered cases
  completed in 19–79 ms on the verification machine; the existing four-passage
  benchmark recorded a 106.71 ms median with 153,240 allocated nodes. These are
  diagnostic machine-local values, not frozen cross-machine performance thresholds.
- All seven pathing `*.test.mjs` suites, `layered_bench.mjs`,
  `scripts/manage_translations.py --check`, `git diff --check`, the Django system
  check, and all 54 `project`/`results` tests on isolated SQLite pass. No user-facing
  strings, persisted schemas, or route payloads changed.

### CR 7 - translations, verification, and handoff

**Agent effort:** High

- Every new or changed label, title, aria-label, help sentence, validation message,
  and undo label must use gettext. Add DE/FR/IT values to
  `locale/source_messages.py`, then run translation check and build. Follow informal
  address and Swiss German spelling.
- Extend the editor contract suite for the nested tool state, third RCM ring, right-
  click finish precedence, `D`, Enter, wheel coalescing, node drag, no-selection
  semantics, undo timing, snapshot counter increments, and one-request persistence.
- Run all existing passage geometry, layered routing, classifier, distinctness,
  navgraph overlay, Django, and no-passage regression suites after the flat geometry
  change. Record benchmark deltas for full-passage refinement.
- Manual QA must cover mouse and trackpad wheel behaviour, right-click and sticky RCM,
  zoomed node hit targets, overlapping passages, high-DPI rendering, all four
  languages, Undo/Redo during a draft, and a project with enough routes to expose any
  save burst.
- Update the progress table and append a new journal entry only after each CR package
  has been implemented, independently reviewed, and accepted. Until then, the
  authoritative state of all CR packages is `pending`.

## 1. Goal

Support bridges, tunnels, underpasses, and similar non-planar passages where two
traversable routes can occupy the same map coordinates without being connected at
their projected crossing.

The user-facing concept is a multi-node passage with an adjustable constant width.
The passage forms a small additional traversable surface. It connects to the
existing mask only at automatically derived entrance regions at its first and last
nodes. A path may move at any angle within the passage surface and may choose
different lines across a wide passage.

The implementation must preserve the current mask and Route formats. In particular,
the final generated route remains an ordinary two-dimensional polyline.

## 2. Executive design decision

### 2.1 Persist vector corridors, not full-size raster layers

Persist each additional passage as a centreline polyline plus a constant width in a
versioned JSON document on `File`. At runtime, rasterize only a tightly cropped
surface around each relevant passage.

This gives the pathfinder true separate states at the same `(x, y)` while keeping
storage and working memory proportional to passage area rather than map area.

For example, a 300 px long and 30 px wide bridge needs roughly 9,000 upper-surface
cells, rather than another 8.6 million cells for a median mask or 75 million cells
for the largest existing masks.

### 2.2 Do not create a middle layer

The proposed black middle layer represents only a prohibition on changing levels.
That prohibition is expressed directly in graph connectivity:

- cells inside a passage connect to neighbouring cells of the same passage;
- level-0 mask cells connect to neighbouring level-0 mask cells;
- cross-level edges exist only in the two entrance regions;
- projected crossings create no edge.

There is therefore no semantic or computational reason to store a middle raster.

### 2.3 Do not change the Route model

`Route.rP` continues to store only `{x, y}` points. `length`, `noA`, `obstacle`, and
`run_time` continue to be stored exactly as they are today.

During pathfinding, route legs carry transient level information so that refinement,
obstacle scoring, alternative-route blocking, and distinctness checks act on the
correct surface. That information is flattened away before persistence.

When a saved 2D route is loaded again, passage use is reconstructed geometrically:
a contiguous route span is classified as using a passage only if it enters through
one derived entrance region, remains inside that passage corridor, and leaves
through the opposite entrance region. Merely crossing the passage footprint in the
middle does not qualify.

This is the central constraint that permits reliable behaviour without adding a
Route field.

## 3. Strict v1 scope and non-goals

These constraints are intentional. An implementation agent must not broaden them
without a separate product decision.

### Included in v1

- Multiple independent passages per map.
- A passage represented by a multi-node centreline and one constant width.
- Rounded corridor joins and rounded endpoint caps.
- Automatically derived entrance regions at the first and last nodes.
- Bidirectional passage travel.
- Directional runtime states enforce that a traversal entering one entrance can leave
  only through the opposite entrance. The reverse direction uses a separate sparse
  state over the same corridor geometry.
- Any-angle refinement inside both the existing mask and passage surfaces.
- Two passages may overlap geometrically without connecting directly.
- A level-0 path may pass under or over a passage at identical coordinates without
  switching levels.
- Passage geometry is saved, restored in snapshots, exported in offline project
  JSON, and included in normal project duplication.
- Existing maps with no passage data retain exactly their current behaviour.

### Explicitly excluded from v1

- No `Route` model field and no level marker in `Route.rP`.
- No `ControlPair` model field. Controls are assumed to lie on level 0. A control in
  the interior of an added passage is unsupported in v1; controls at an entrance
  remain valid because the entrance connects to level 0.
- No separate `Passage` Django model.
- No full-size second- or third-layer PNG.
- No middle-layer raster or editable transition mask.
- No variable width along a single passage.
- No manually painted obstacles on passage surfaces.
- No one-way passages.
- No branching within a passage object. A passage has exactly two entrances.
- No direct passage-to-passage transition. Two passages can interact only by both
  connecting through level 0 at their entrances.
- Existing `blocked_terrain` lines and polygons affect level 0 only. A projected
  blocker does not block an upper/lower passage in v1.
- No neural-network changes or retraining.
- No attempt to infer passage width automatically from the map image.

### Later extensions that the v1 schema must not prevent

- Per-node widths for tapered surfaces.
- Explicit entrance shapes or partial-width stairs/ramps.
- Passage terrain classes such as stairs or slow surfaces.
- Controls assigned to a passage surface.
- Passage-surface obstacles.
- Direct junctions between passage surfaces.

These are not to be partially implemented in the initial work packages.

## 4. Canonical persisted data contract

### 4.1 Django fields

Only the following model fields are permitted:

1. `File.level_passages = models.JSONField(null=True, blank=True)`
2. `FileSnapshot.level_passages = models.JSONField(null=True, blank=True)`

They should be added in one migration, expected to be `0006` based on the current
migration sequence.

No other model change is required. In particular:

- do not alter `Route`;
- do not alter `ControlPair`;
- do not add a `Passage` table;
- do not add passage fields to `EditorSettings`;
- do not store a duplicate raster artifact in the database.

The snapshot field is necessary because `FileSnapshot` is defined as a snapshot of
the full editable project state. Omitting it would make snapshot restoration silently
delete or retain stale passage data.

### 4.2 JSON schema

The canonical shape is:

```json
{
  "version": 1,
  "items": [
    {
      "id": "8cb8a384-c073-4a4d-9dce-b67e2c6de101",
      "points": [[1420.5, 830.0], [1460.0, 845.5], [1510.0, 870.0]],
      "width": 24.0
    }
  ]
}
```

Contract details:

- Coordinates are finite numeric values in **mask-pixel coordinates**.
- Width is the full traversable width in mask pixels, not radius.
- `id` is a stable UUID string generated by the editor. It is identity for editing,
  cache invalidation, logging, and transient routing results; it is not a database
  primary key.
- `points` contains at least two distinct positions.
- The first and last points define entrance centres.
- The corridor is the rounded stroke of the complete polyline at the given width.
- Entrance regions are derived, not stored: each is the portion of the corridor
  within a radius of `width / 2` around the corresponding endpoint.
- The two derived entrance regions must not overlap. A passage that is too short for
  its width is invalid in v1 because its directional entrance identity is ambiguous.
- Passage movement uses the existing fast-terrain cost in v1. Do not add a persisted
  terrain value until there is a user requirement for passage-specific runnability.
- `null`, a missing field, and `{ "version": 1, "items": [] }` all mean no
  passages when reading. Writes should normalize to the canonical versioned object.
- Unknown future versions must be rejected for editing and ignored safely by the
  pathfinder, never reinterpreted as version 1.

### 4.3 Structural limits

Define limits once in the server validator and mirror them in the editor:

- at most 64 passages per file;
- at most 256 centreline points per passage;
- width between 2 and 256 mask pixels;
- finite coordinates only;
- UUID/id length capped at 64 characters;
- total serialized JSON size capped to a conservative value such as 512 KiB.

The exact limits may be adjusted during WP 1.1, but the server must enforce them.
Server validation should remain structural and must not decode the full mask during a
save request. Geometry that depends on current mask dimensions is validated in the
editor/worker after the mask is loaded.

### 4.4 Coordinate conversions

The persisted contract uses mask pixels. The editor displays map/world coordinates.
All conversions must go through one shared pair of utilities based on the existing
`PATHING_MASK_TRAIN_SCALE`, rather than adding new inline divisions or multiplications.

- Editor/map point to persisted passage point: divide by train scale.
- Persisted passage point to editor/map display point: multiply by train scale.
- Passage width follows the same scale conversion.

Passage geometry must not include `project.scale`; that value controls map display and
real-world measurements and is not the map-to-mask sampling ratio.

## 5. Runtime geometry contract

### 5.1 Normalized passage object

The pure JavaScript geometry module consumes the persisted schema and produces a
normalized immutable object per valid passage:

```text
id
points                 global mask-pixel coordinates
width
bounds                 inclusive global mask-pixel bounds plus safety padding
localWidth/localHeight
originX/originY         global coordinate of local raster origin
grid                    cropped Uint8Array surface cost grid
startEntrance           sparse local-cell set or sorted indices
endEntrance             sparse local-cell set or sorted indices
```

`grid == 0` means outside the passage. Interior cells use the current fast mask value.
A narrow internal boundary band should use the same outline/clearance cost convention
as the base mask so routes do not unrealistically scrape railings. The band must not
make the minimum supported width impassable.

The rasterizer must be deterministic in browsers and the Node test harness. Do not
use Canvas or `OffscreenCanvas` as the authoritative rasterizer because that would
make headless parity and pixel rules browser-dependent.

### 5.2 Layer identity

Internal nodes have an explicit surface identity:

- `base` for the existing mask;
- `passage:<id>:from-start` for a passage cell reached through the start entrance;
- `passage:<id>:from-end` for a passage cell reached through the end entrance.

Two nodes with the same global `(x, y)` but different surface identities are distinct.
Base-to-passage transitions enter the matching directional state. A `from-start`
state may return to base only through the end entrance; a `from-end` state may return
only through the start entrance. This prevents a route from using two cells of one
wide entrance as an unreconstructable same-end shortcut.

The two directional states share the same immutable raster geometry but have separate
search scores, parents, and closed flags. Runtime search allocation is therefore
`baseSubgridCells + 2 * sum(relevantPassageCells)`. This remains sparse and is the
intentional exception to the earlier one-state estimate.

Two overlapping passage rasters also remain distinct. There is no automatic edge
between them.

### 5.3 Typed route legs

The hybrid search and refinement stages exchange typed legs internally:

```json
{
  "legs": [
    {"surface": "base", "points": [0, 0, 1, 1]},
    {"surface": "passage:uuid", "points": [1, 1, 2, 1, 3, 2]},
    {"surface": "base", "points": [3, 2, 4, 2]}
  ]
}
```

Points in this internal contract are flat mask-coordinate arrays, matching the current
pathing modules. Adjacent legs share their transition coordinate. The public worker
response remains the existing editor polyline plus optional transient diagnostics:

```text
path: [[mapX, mapY], ...]
passageSpans: [{ passageId, fromIndex, toIndex }]
```

`passageSpans` is never sent to Django and never added to `_projectBody()`. It may be
used immediately for obstacle scoring and debugging. Any later recalculation must be
able to reconstruct equivalent spans from the saved 2D route and current passage
geometry.

### 5.4 Deterministic route reclassification

Define one shared algorithm that classifies passage spans from a 2D mask-coordinate
polyline. It must:

1. detect entry into either derived entrance region;
2. follow the route while it remains inside the passage footprint, with a small
   rasterization tolerance;
3. require exit through the opposite entrance;
4. reject spans that leave through a side, terminate in the passage, or merely cross
   the middle;
5. support passage traversal in either direction;
6. choose deterministically if footprints overlap; valid complete entrance-to-entrance
   matches outrank partial matches, then the longest contained span wins, then stable
   passage id order breaks a tie.

This classifier is the interface that replaces persisted Route-level metadata. It is
used by:

- obstacle/stair recomputation in the editor;
- existing-route blocking for alternative generation;
- route distinctness checks;
- restored routes after reopening or snapshot loading;
- debug assertions comparing transient search legs with reconstructed spans.

The classifier must have adversarial tests. Its most important negative case is a
base route crossing the middle of a passage at the same `(x, y)`.

## 6. Agent profiles and effort scale

The work packages below use these recommendations.

### Agent profiles

**Repository agent**

A Codex/GPT-5-class coding agent with strong Django and general JavaScript skills.
Appropriate for well-bounded persistence, API, and UI wiring work.

**Geometry/algorithm agent**

A Codex/GPT-5-class coding agent instructed to focus on computational geometry,
typed arrays, graph search invariants, and deterministic tests. It should receive the
entire contracts in sections 3-5, not only a one-line task.

**Senior integration agent**

The strongest available reasoning/coding agent, with broad repository context and
authority to refactor interfaces while preserving behaviour. Use for changes spanning
A*, Theta*, worker caching, alternative-route generation, and navgraphs.

**Independent review agent**

A fresh high-reasoning agent that did not author the work package. It reviews diffs,
tests topology invariants, checks accidental model/schema expansion, and runs
regression benchmarks. It should not be asked merely to restate the author's notes.

### Effort levels

- **Low:** narrow, local change; approximately one focused agent turn.
- **Medium:** several related files and tests; approximately one sustained agent task.
- **High:** algorithmic or cross-layer work requiring repeated test/fix cycles.
- **Very high:** core architectural integration; use the strongest agent, a written
  plan/checklist, benchmark fixtures, and independent review.

Complexity and effort are separate: a conceptually simple task can still have high
effort because it touches many persistence paths.

## 7. Phase 0 - Freeze invariants and fixtures

### WP 0.1 - Architecture contract and synthetic fixtures

**Complexity:** Medium

**Recommended agent:** Geometry/algorithm agent, medium effort

**Review:** Senior integration agent, medium effort

**Purpose**

Turn the contracts above into executable fixtures before production routing code is
changed.

**Deliverables**

- A small pure-JS fixture format containing a base mask, passage definitions, start,
  goal, and expected topology.
- At minimum, fixtures for:
  - a `+` crossing where the horizontal base path and vertical passage overlap but do
    not connect in the middle;
  - a wide rectangular passage where the shortest route enters/exits off-centre and
    crosses diagonally;
  - a bent passage where any-angle refinement may cut across the interior but never
    leave the corridor;
  - forward and reverse traversal;
  - two geometrically overlapping passages that remain disconnected;
  - invalid entrances that do not overlap passable base pixels;
  - a base-only map used for exact regression comparison.
- A benchmark fixture with a realistic base subgrid and several small passages.
- Written expected semantics for controls, blockers, mask edits, and route
  reclassification.

**Acceptance criteria**

- Every later algorithm work package uses these fixtures rather than inventing new
  interpretations.
- The crossing fixture explicitly asserts that no mid-passage transition exists.
- The wide-passage fixture cannot pass if routing is reduced to a centreline edge.

**Interface handed to WP 2**

The fixture passage objects use the exact persisted schema from section 4.2.

## 8. Phase 1 - Minimal persistence and project-state plumbing

### WP 1.1 - Django fields, migration, and validation

**Complexity:** Low algorithmically, Medium integration

**Recommended agent:** Repository agent, medium effort

**Independent review:** Repository agent, low effort

**Files likely involved**

- `project/models.py`
- `project/migrations/0006_*.py`
- a new small validation module under `project/`
- `project/views.py`
- `project/admin.py` only if the fields need inspection, not custom editing
- `project/tests.py`

**Required changes**

- Add only the two JSON fields listed in section 4.1.
- Implement a canonical server-side normalizer/validator.
- Include `level_passages` in:
  - `open_file` project payload;
  - full `save_file` reads and writes;
  - `_create_db_snapshot`;
  - `save_snapshot`;
  - snapshot load payload;
  - project duplication/full-save paths.
- Extend the existing granular `save_element` endpoint with
  `type == "level_passages"`; do not add a new write URL.
- Apply the same permission, lock timestamp, author, and `last_edited` behaviour as
  `blocked_terrain`.
- Reject invalid payloads with a translated user-facing validation message where the
  UI can display it. Internal diagnostic details may remain developer-facing.

**Tests**

- Migration defaults leave existing files and snapshots valid.
- Valid version-1 data round-trips.
- Missing/null data reads as empty.
- Invalid version, non-finite coordinates, oversized width, duplicate/missing ids,
  excessive item/point counts, and oversized documents are rejected.
- Another team's file cannot be read or modified through the new payload.
- Snapshot save/load round-trips passages.
- Full project save and granular save produce the same normalized representation.

**Prohibited changes**

- No Route migration.
- No new database relation.
- No raster generation on the server request path.
- No navgraph rebuild in this work package.

### WP 1.2 - Frontend project-state persistence

**Complexity:** Medium

**Recommended agent:** Repository agent with frontend experience, medium effort

**Required changes**

- Add canonical empty `level_passages` state to every project initializer/reset path.
- Include it in `_projectBody()` and offline JSON import/export.
- Add `saveLevelPassages()` using `save_element`.
- Ensure opening another map clears stale passage render/cache state.
- Ensure snapshots and undo project clones retain passage JSON.
- Do not add route fields to any save payload.

**Acceptance criteria**

- A manually injected valid passage document survives save, reload, snapshot restore,
  duplicate, offline export/import, and project reset.
- Existing projects without the field open normally.
- `_projectBody()` still emits the unchanged Route schema.

**Interface handed to WP 3 and WP 5**

`project.level_passages` is always a canonical version-1 object in memory. Pathing
messages receive a structured-cloneable copy of `items`; UI code mutates project state
only through normalized objects.

## 9. Phase 2 - Pure passage geometry

### WP 2.1 - Deterministic corridor rasterizer

**Complexity:** High

**Recommended agent:** Geometry/algorithm agent, high effort

**Independent review:** Senior integration agent, medium effort

**New module responsibility**

Create a pure, dependency-light pathing module responsible for:

- schema normalization needed at runtime;
- global bounds for a stroked polyline;
- deterministic rounded-segment corridor rasterization;
- rounded joins and endpoint caps;
- derived start/end entrance cell sets;
- boundary clearance/outline costs;
- global-to-local and local-to-global coordinate conversion;
- hit testing for editor preview/selection;
- invalid-geometry diagnostics.

The module must work in both the browser worker and Node verification scripts.

**Geometry rules**

- A cell belongs to the corridor when its centre is within `width / 2` of at least
  one centreline segment.
- End caps are round and centred on first/last points.
- Joins are the union of adjacent segment strokes, producing round joins.
- Remove consecutive duplicate points before rasterization.
- A passage with fewer than two distinct normalized points is invalid.
- Clip local raster work to the calculated padded bounds, not the full map.
- An entrance cell must also map to an in-bounds base cell; whether that base cell is
  passable is evaluated later because blocked-terrain overlays can change it.
- Boundary-cost generation must be deterministic and independently testable.

**Tests**

- Horizontal, vertical, diagonal, and sharply bent corridors.
- Fractional coordinates and widths.
- Width limits and very short first/last segments.
- No holes at joins.
- Bound size remains proportional to the corridor bbox.
- Pixel snapshots or compact hashes remain stable across Node runs.
- A narrow valid passage retains a connected interior after adding the outline band.

**Output contract**

Exactly the normalized passage object described in section 5.1. WP 3 must consume it
without re-rasterizing or interpreting geometry differently.

### WP 2.2 - Route-to-passage classifier

**Complexity:** High because it replaces persisted route metadata

**Recommended agent:** Geometry/algorithm agent, high effort

**Independent review:** Independent review agent, high effort

**Required behaviour**

- Accept a 2D route in mask coordinates and the normalized passage objects.
- Return ordered typed legs and passage spans.
- Implement all rules in section 5.4.
- Preserve every input route point and its order; classification does not simplify
  geometry.
- Treat a one-pixel/tolerance excursion caused by rounding consistently, but never
  allow that tolerance to bridge a true side exit.
- Return developer diagnostics explaining rejected partial matches.

**Critical tests**

- A route crossing the centre of a bridge at 90 degrees stays entirely on base.
- A route entering one cap, following the corridor, and exiting the other is a
  passage traversal.
- A route entering and returning through the same cap is not a complete traversal.
- Hybrid search cannot produce a same-cap excursion because its directional state
  exposes an exit only at the opposite cap.
- Reverse direction produces the corresponding reversed span.
- Overlapping passage footprints resolve deterministically.
- Classification of the hybrid search output exactly matches its transient typed
  legs after flattening.

**Handoff contract**

WP 3 uses typed legs directly during the current search. WP 4 uses this classifier
for all previously saved routes. Those two representations must be asserted equivalent
in tests.

## 10. Phase 3 - Hybrid layered pathfinding and any-angle refinement

### WP 3.1 - Sparse layered A* core

**Complexity:** Very high

**Recommended agent:** Senior integration agent, very high effort

**Independent review:** Geometry/algorithm agent, high effort

**Implementation strategy**

Keep the existing `astar()` untouched for the no-passage path and for local helper
searches. Add a hybrid search path used only when at least one valid relevant passage
exists.

For each margin-growth attempt:

- retain the current cropped base subgrid;
- select passages whose two entrance bboxes can connect within that attempt;
- attach each selected cropped passage grid as two directional node namespaces that
  share geometry but keep independent search state;
- connect ordinary neighbours only within the same surface;
- add base-to-direction cross-level edges at entrance cells whose corresponding base
  cell is in bounds and non-zero, and expose direction-to-base edges only at the
  opposite entrance;
- never add transition edges along sides or projected crossings;
- return typed dense legs, not only a flat 2D path.

The node arrays may be indexed as a contiguous base range followed by one range per
passage. The exact representation is implementation-defined, but it must allocate
only `baseSubgridCells + 2 * sum(relevantPassageCells)`, never `mapWidth * mapHeight`
per passage. The factor of two is required by the no-Route-metadata reconstruction
contract and must not be optimized away into an ambiguous single state.

**Cost rules**

- Base moves retain the exact existing `distance * (255 - neighbourValue)` rule.
- Passage moves use their local grid value and the same rule.
- Cross-level transitions at the same projected coordinate have zero geometric
  length and zero additional v1 penalty.
- The heuristic must remain admissible under the chosen passage cost. Document the
  proof or use a conservative heuristic.

**Search bounds**

- Preserve the current margin-growth policy and maximum margin.
- A passage becomes usable when both derived entrance regions have at least one
  transition in the current base subgrid.
- Passage interior geometry may extend outside the base subgrid because it is stored
  in its own local raster; both usable entrances must still connect back inside.
- Do not silently increase the global maximum margin as part of this feature.

**Failure handling**

- Invalid or disconnected passages are skipped with developer diagnostics.
- Passages whose derived entrance regions overlap are invalid and skipped.
- If every passage is skipped, fall back to the existing base pipeline behaviour.
- Mask edits and `blocked_terrain` overlays can invalidate an entrance for one request
  without deleting the persisted passage.

**Acceptance criteria**

- The `+` crossing fixture cannot switch at its centre.
- Both forward and reverse passage routes work.
- An adversarial route cannot enter and leave through different cells of the same
  entrance.
- Multiple passages can be chained through level-0 segments.
- Wide-passage A* is free to choose non-central entrance cells.
- No-passage path output and timings remain on the current code path.
- Memory measurements confirm allocation is proportional to selected cropped areas.

### WP 3.2 - Surface-aware Theta*/any-angle refinement

**Complexity:** Very high

**Recommended agent:** Senior integration agent, very high effort

**Independent review:** Independent review agent, high effort

**Required refactor**

The current pipeline performs one corridor and Theta* pass over a wholly 2D A* path.
That cannot be used unchanged because it could reject a legal passage leg or shortcut
between levels.

The public no-passage branch must continue to call the current pipeline unchanged.
Do not send base-only routes through a newly extracted/refactored refinement helper
until an exact-output parity test proves that doing so is behaviour-neutral. The
layer-aware helper is initially an additional branch, not an authorization to rewrite
the established base-only algorithm.

Refactor refinement into a helper that accepts one typed leg plus its authoritative
surface grid:

- base legs refine against the existing base subgrid;
- passage legs refine against the passage's cropped grid;
- line-of-sight is never evaluated across a surface transition;
- transition coordinates are pinned while refining adjacent legs;
- adjacent refined legs are stitched without duplicate points;
- the final flattened path remains in global mask coordinates.

Passage interiors should use the same high-level sequence as base routing where
applicable: dense path reduction, corridor restriction, any-angle refinement, and
final simplification. It is acceptable to use a simpler direct Theta* on the small
uniform passage raster if tests prove equivalent legality and better stability.

**Wide-passage acceptance criteria**

- A diagonal approach/exit produces a diagonal line across the passage when legal.
- The result is not forced through the centreline.
- The route may use a near edge when it is shorter, while the boundary cost prevents
  unrealistic railing contact.
- A bent passage can cut across its open interior but cannot cross outside the
  rasterized footprint.
- Simplification never removes a required entrance transition.

**Output contract**

Return the section-5.3 typed legs plus flattened path and passage spans. The worker
integration in WP 3.3 must not reconstruct level changes by guessing at this stage.

### WP 3.3 - Worker messages, caches, and invalidation

**Complexity:** High

**Recommended agent:** Senior integration agent, high effort

**Required changes**

- Extend `maskReady` or add a separate `passagesReady` message carrying canonical
  passage items.
- Extend `pathfind` with the current passage revision/items when necessary.
- Cache normalized passage rasters by a deterministic key derived from passage JSON
  and mask dimensions.
- Invalidate layered connectivity/search caches when:
  - the mask changes via `maskReady` or `maskDiff`;
  - `blocked_terrain` changes;
  - passage JSON changes;
  - mask dimensions change.
- Keep base grid/label caching unchanged for no-passage requests.
- Extend path replies with transient `passageSpans` and per-stage timings.
- Ensure all new messages remain structured-cloneable and transfer only buffers that
  are safe to detach.

**Acceptance criteria**

- Editing passage width invalidates only passage-dependent caches.
- A mask brush edit invalidates entrance validation and layered connectivity.
- Repeated path requests on unchanged data reuse normalized passage rasters.
- No-passage requests do not pay rasterization or layered-search overhead.

## 11. Phase 4 - Existing routes, scoring, and alternative generation

### WP 4.1 - Passage-aware obstacle scoring without Route fields

**Complexity:** High

**Recommended agent:** Geometry/algorithm agent with editor context, high effort

**Independent review:** Repository agent, medium effort

**Problem**

The editor currently samples the level-0 mask under every route segment when
calculating obstacle/stair entry penalties. A legal passage can cross black or slow
level-0 pixels.

**Required changes**

- For a newly generated path, use transient passage spans from the worker.
- For a loaded or edited route, call the WP 2.2 classifier.
- Sample the existing mask only for base legs.
- Treat v1 passage legs as fast passage terrain with no underlying level-0 obstacle
  entry.
- Keep length and NoA calculations unchanged because final route geometry is still a
  correct 2D polyline.
- Ensure `recalculateProjectRoutes()`, scale changes, endpoint synchronization, route
  edits, and toggling auto-obstacle all use the same classifier path.
- Do not persist the reconstructed spans.

**Acceptance criteria**

- Reopening a project and recalculating produces the same obstacle/runtime values as
  immediately after generation.
- A base route crossing beneath the passage still samples its base terrain normally.
- No route save payload contains passage metadata.

### WP 4.2 - Layer-aware existing-route blocking

**Complexity:** High

**Recommended agent:** Senior integration agent, high effort

**Problem**

Existing route polylines are stamped into the base subgrid to force alternative
routes. Stamping a bridge leg onto base would incorrectly block the underpass.

**Required changes**

- Convert every existing/temporary route payload to mask coordinates as today.
- Classify it using WP 2.2.
- Stamp base legs only into the base subgrid.
- Stamp passage legs only into the corresponding passage raster.
- Preserve existing start/goal exceptions in the correct surface.
- If a saved route cannot be completely classified, treat unclassified portions as
  base rather than guessing passage use.

**Acceptance criteria**

- Blocking a route over a bridge does not block the route underneath.
- Blocking a base route underneath does not block the bridge surface.
- A second route may use a different line across a wide passage if space remains.
- If the full passage width is blocked by a prior route mask, the alternative search
  may reject that passage and choose another route.

### WP 4.3 - Layer-aware route distinctness

**Complexity:** High

**Recommended agent:** Geometry/algorithm agent, high effort

**Required changes**

- Compare classified typed legs rather than only projected points.
- Routes on different surfaces are topologically separated even if their projected
  coordinates overlap.
- Retain the existing real-obstacle separation logic for two base routes.
- Treat one passage traversal as one route choice regardless of lateral separation
  inside its corridor. Two routes using the same passage are distinct only when a
  real base-surface obstacle separates their surrounding approach or exit legs.
- Include surface-aware diagnostics in the worker response for development.

**Acceptance criteria**

- Over/under routes can be considered distinct.
- Two almost identical routes on the same bridge are not distinct.
- Routes on opposite sides of the same wide passage are not distinct when their
  only difference is inside that passage.
- Existing base-only distinctness fixtures remain unchanged.

## 12. Phase 5 - Editor UI

This phase intentionally follows the pathfinding core. A debug fixture/manual JSON
can exercise Phases 1-4 before committing to the interaction design.

### WP 5.1 - Passage rendering and hit testing

**Complexity:** Medium

**Recommended agent:** Repository agent with SVG/canvas frontend experience, medium
effort

**Required behaviour**

- Render the vector corridor as a translucent overlay aligned with the map.
- Render entrance regions distinctly from the passage body.
- Use the WP 2.1 geometry/hit-test rules; do not create a visually different second
  interpretation of width.
- Keep overlays visible in passage-edit mode and optionally dim/hide them in other
  modes according to the final UX decision.
- A passage crossing must visually communicate that its midsection is not an
  entrance.

### WP 5.2 - Add passage interaction and width control

**Complexity:** High UI effort, Medium algorithmic complexity

**Recommended agent:** Frontend-focused Repository agent, high effort

**Independent review:** Independent review agent with mobile/touch focus, medium
effort

**Recommended v1 interaction**

- Enter `Mask layer -> 3rd dimension -> Add`.
- Click/tap to place centreline nodes.
- Double-click, Enter, or an explicit finish action commits the passage.
- Escape cancels the uncommitted object.
- A live translucent corridor preview shows the actual width and entrances.
- Reuse the mask brush-size slider and wheel gesture to adjust one constant width.
- Generate a UUID at commit.
- Validate at least two distinct nodes and at least one passable base transition cell
  in each entrance.
- Save through `saveLevelPassages()`.

Do not add per-node width handles in v1.

### WP 5.3 - Select, adjust width, and remove

**Complexity:** Medium

**Recommended agent:** Frontend-focused Repository agent, medium effort

**Required behaviour**

- `3rd dimension -> Remove` removes the clicked passage as one object.
- Selecting an existing passage exposes the same constant-width control.
- Width changes update preview immediately and persist on commit.
- Passage edits participate in undo/redo using compact project JSON snapshots, not
  mask-pixel diffs.
- Removing or changing a passage invalidates pathing caches and Infinity/navgraph
  readiness as defined in later phases.

Node editing can be added if it falls naturally out of the existing multi-node editor,
but it is not required for the first usable version. Do not delay removal/width support
to build a general vector editor.

### WP 5.4 - Tool-wheel hierarchy and translations

**Complexity:** High because the current wheel has a shallower hierarchy

**Recommended agent:** Frontend-focused Repository agent, high effort

**Target hierarchy**

```text
Mask layer
  Obstacles
    Add
    Remove
  3rd dimension
    Add
    Remove
```

Preserve pan/lock access without making painting gestures ambiguous. The agent should
first document how the existing toolbar wheel, radial context menu, subtool panel,
mouse wheel, and touch input map onto this hierarchy, then implement one consistent
state machine shared by those surfaces.

All visible strings, titles, aria labels, errors, status text, and confirmation text
must use Django/JavaScript gettext. Add every new msgid and German/French/Italian
translation to `locale/source_messages.py`, then run:

```text
python scripts/manage_translations.py --check
python scripts/manage_translations.py --build
```

The task is incomplete until `--check` is clean.

## 13. Phase 6 - Navgraph and Infinity-mode integration

This phase is not required to prove the editor pathfinder MVP, but it is required
before claiming that all mask-based pathfinding surfaces support passages.

### WP 6.1 - Read-only passage delivery for Infinity mode

**Complexity:** Medium

**Recommended agent:** Repository agent, medium effort

**Recommended interface**

- Add a read-only authenticated endpoint returning normalized passage JSON for a file
  the caller may access. Do not reuse an editor-open endpoint that acquires locks.
- `MaskSceneSource._boot()` fetches navgraph, full-res mask, and passage JSON together.
- Include canonical passage items in `navgraphReady`.
- Empty/missing passage data preserves the existing boot path.

No model changes are allowed in this package.

### WP 6.2 - Dynamic passage overlay on the base navgraph

**Complexity:** Very high

**Recommended agent:** Senior integration agent, very high effort

**Independent review:** Geometry/algorithm agent plus independent review agent, high
effort each

**Recommended approach**

Keep the serialized navgraph artifact base-only. Dynamically attach passage portal
states in the worker so editing a passage does not require a costly Python navgraph
rebuild or a second geometry implementation.

- Rasterize passages with the same WP 2.1 module used by editor pathfinding.
- Sample multiple candidate transition points across each entrance, not only the
  centre.
- Connect candidate transition points to existing base navgraph snap candidates using
  full-res legal connector costs.
- Represent passage traversal as a dynamic graph section whose cost is computed on
  its local surface.
- Preserve passage identity in the graph route until full-res refinement.
- Refine accepted routes through the same WP 3.2 surface-aware refiner.
- Recompute refined runtime and legality before serving an Infinity pair.

The exact dynamic adjacency structure may differ from the editor hybrid A*, but its
input is the same normalized passage object and its final legality is checked by the
same surface-aware refinement.

**Acceptance criteria**

- Infinity sampling remains on level 0, consistent with the v1 control constraint.
- Generated route pairs may use passages.
- A route cannot switch at a projected crossing.
- Passage width affects available alternatives.
- Empty passage data produces byte-compatible navgraph parsing and unchanged routing.
- Passage changes do not require changing `.navgraph.bin` format or version.

### WP 6.3 - Invalidation policy

**Complexity:** Medium

**Recommended agent:** Senior integration agent, medium effort

Because passages are dynamically overlaid, editing them does not invalidate the
base-only navgraph artifact. It does invalidate:

- in-memory worker passage rasters;
- dynamic portal connections;
- prefetched Infinity scenes generated with the previous passage revision;
- editor pathing caches.

Define a deterministic passage revision hash and carry it through worker readiness and
prefetch state. Do not reuse `File.last_edited` as the sole cache key because unrelated
route edits also change it.

## 14. Phase 7 - Verification, performance, and rollout

### WP 7.1 - Automated topology and regression suite

**Complexity:** High

**Recommended agent:** Independent review agent, high effort

**Required coverage**

- All Phase-0 fixtures.
- Structural validation and security tests.
- Snapshot/full-save/granular-save/offline JSON round trips.
- Base route through projected crossing.
- Passage route through both entrances.
- No mid-corridor switch.
- Reverse traversal.
- Wide diagonal any-angle route.
- Boundary clearance.
- Overlapping independent passages.
- Multiple passages chained through base.
- Mask edit invalidating an entrance.
- Blocked-terrain base-only semantics.
- Existing route blocking on the correct surface.
- Route reclassification after reload.
- Obstacle/runtime equality before and after reload/recalculation.
- No Route payload/model change.
- No-passage exact output regression for representative routes.

### WP 7.2 - Performance benchmarks

**Complexity:** Medium

**Recommended agent:** Geometry/algorithm agent, medium effort

**Measurements**

- Cold and warm worker initialization.
- Passage rasterization time by length and width.
- Layered A* time and peak typed-array allocation.
- Theta/refinement time for base and passage legs.
- Route reclassification time for saved routes.
- No-passage route timings before/after feature branch.
- Representative median mask and largest practical mask subgrid.

**Initial performance gates**

- No-passage requests stay on the existing path and show no material regression
  beyond message/schema checks.
- Passage raster memory is bounded by summed cropped passage bboxes.
- Passage normalization/rasterization is cached across repeated requests.
- A typical map with fewer than ten passages adds negligible load time relative to
  full mask decoding/labeling.

Exact millisecond thresholds should be recorded from the baseline machine before WP
3.1 and frozen in the benchmark report rather than guessed here.

### WP 7.3 - Manual map validation and staged rollout

**Complexity:** Medium

**Recommended agent:** Repository agent, medium effort, with human product review

**Procedure**

1. Enable only in development/staging.
2. Annotate at least five real sprint maps covering narrow bridges, wide bridges,
   tunnels, bent passages, and an over/under crossing.
3. Review generated paths visually at entrances, edges, diagonal crossings, and
   projected crossings.
4. Confirm width editing is fast enough that users do not need pixel-level editing.
5. Compare alternate-route generation before/after passage annotation.
6. Verify saved projects, snapshots, duplicated projects, and published playback.
7. Only then enable in production.

If the geometric route classifier proves ambiguous on real maps, stop rollout and
revisit the explicit no-Route-metadata decision with evidence. Do not silently add a
Route field inside a bug fix.

## 15. Work-package dependency and handoff matrix

| Work package | Depends on | Produces the authoritative interface for |
|---|---|---|
| WP 0.1 | None | All geometry and topology tests |
| WP 1.1 | Section 4 contract | Server persistence and validation |
| WP 1.2 | WP 1.1 | `project.level_passages` frontend state |
| WP 2.1 | WP 0.1 | Normalized passage rasters, bounds, entrances |
| WP 2.2 | WP 2.1, WP 0.1 | Reconstructed typed route legs |
| WP 3.1 | WP 2.1, WP 0.1 | Dense typed hybrid-search legs |
| WP 3.2 | WP 3.1, WP 2.1 | Refined typed legs and flattened route |
| WP 3.3 | WP 1.2, WP 3.2 | Worker cache/message contract |
| WP 4.1 | WP 2.2, WP 3.3 | Correct runtime/obstacle recomputation |
| WP 4.2 | WP 2.2, WP 3.1 | Layer-aware alternative blocking |
| WP 4.3 | WP 2.2, WP 3.3 | Layer-aware distinctness |
| WP 5.1 | WP 1.2, WP 2.1 | Visual corridor representation |
| WP 5.2 | WP 5.1, WP 1.2 | Passage creation/width editing |
| WP 5.3 | WP 5.2 | Passage selection/removal/undo |
| WP 5.4 | WP 5.2, WP 5.3 | Final tool hierarchy and translations |
| WP 6.1 | WP 1.1 | Read-only Infinity passage payload |
| WP 6.2 | WP 3.2, WP 6.1 | Dynamic navgraph passage routing |
| WP 6.3 | WP 3.3, WP 6.2 | Cross-surface cache revision policy |
| WP 7.1 | All implemented packages | Release regression evidence |
| WP 7.2 | WP 3.3, optionally WP 6.2 | Performance evidence |
| WP 7.3 | WP 5.4, WP 7.1, WP 7.2 | Production decision |

## 16. Recommended execution sequence and parallelism

1. Execute WP 0.1 first and freeze its fixtures.
2. WP 1.1/1.2 and WP 2.1 may then proceed in parallel because they meet at the
   section-4 schema.
3. Execute WP 2.2 after the rasterizer contract is stable.
4. Execute WP 3.1 and WP 3.2 sequentially with the same senior integration agent or a
   very explicit handoff. Splitting them among agents without the typed-leg contract
   is high risk.
5. Execute WP 3.3, then WP 4.1-4.3. These packages overlap in worker/editor files and
   should not be edited concurrently in the same worktree.
6. Begin UI work only after the geometry module is stable. WP 5.1 may be prototyped
   earlier, but persistence should not merge before WP 1.2.
7. Treat Phase 6 as a separate milestone after editor pathfinding is accepted.
8. Use a fresh independent review agent after Phases 3, 4, and 6, not only at the end.

## 17. Required verification commands

Agents should use the repository's existing commands and add focused Node harnesses
where needed. At minimum before handoff:

```text
python manage.py check
python manage.py test project results
python scripts/manage_translations.py --check
python scripts/manage_translations.py --build
```

Run the passage geometry/pathfinding Node tests and benchmark scripts introduced by
the relevant work packages. The exact commands must be documented in those scripts'
headers and added to the work-package completion note.

Restart the development server after translation catalogs are rebuilt.

## 18. Definition of done

The feature is complete for the editor MVP only when all of the following are true:

- A user can create, resize, select, and remove a multi-node passage without editing
  a raster layer directly.
- The passage persists through every project and snapshot lifecycle.
- The pathfinder can travel freely and at any angle across the full passage width.
- It can change levels only in the two entrance regions.
- Base and passage paths may overlap without accidental connection.
- Alternative-route blocking and distinctness respect surface identity.
- Saved routes remain ordinary 2D `Route.rP` data.
- Runtime/obstacle recalculation after reopening matches initial generation.
- Existing no-passage projects retain their current routing behaviour and performance.
- Translation checks, Django tests, geometry tests, pathfinding tests, and performance
  gates pass.

Infinity-mode support is complete only after Phase 6 and its additional tests pass.

## 19. Stop conditions requiring a new design decision

An implementation agent must stop and report evidence rather than expand the schema if
any of these occur:

- Real routes cannot be reliably reclassified after reload from their 2D geometry.
- Controls must be placed in passage interiors.
- Users require passage-specific terrain or stair costs.
- Constant width is inadequate on a meaningful share of real passages.
- Passage surfaces need manually drawn internal obstacles.
- Direct passage-to-passage junctions are required.
- Dynamic navgraph integration cannot meet latency targets without changing the
  artifact format.

Each condition could justify a later schema or model extension, but none is authorized
by this plan.

## 20. Rejected alternatives

### Three full-size PNG layers

Rejected because an all-black layer still incurs decode, labeling, initialization,
and working-array costs. It also stores a topology rule as redundant pixels.

### Two full-size surfaces plus a transition mask

Semantically valid but still wasteful for a handful of narrow passage objects. It
would also require a more complex direct-painting editor.

### One fixed graph edge per passage

Rejected for the final design because every route would use the same centreline and
wide bridges could not support diagonal or edge-aware paths.

### Persisted Route-level passage spans

Not currently justified. Final route coordinates, length, NoA, and runtime do not
intrinsically require a level. The deterministic classifier is the approved v1
mechanism for downstream operations. This decision must be revisited only if real-map
evidence triggers the stop condition above.

### Separate Passage Django model

Rejected for v1 because passages are small, file-owned annotation documents with no
independent query, permission, or lifecycle requirements. A versioned `File` JSONField
matches the existing project-state architecture with substantially less persistence
surface area.
