# Medieval Town Generator — Algorithm Reference Notes

Clean-room reference for porting Watabou's town-generation algorithm to JavaScript.
Sources: TownGeneratorOS (Haxe, GPL-3.0, read for algorithm/parameter understanding only —
no source copied), and `reference/starhill.json` (a real mfcg v0.11.5 export used to
sanity-check numeric scale). This document describes behavior and numbers in original
wording; it contains no verbatim GPL code.

---

## 1. Overall pipeline

1. **Voronoi patch generation.** Seed points are placed in a spiral: point `i` gets
   angle `a = startAngle + sqrt(i) * 5` and radius `r = 0` for `i==0`, else
   `r = 10 + i * (2 + random())`. Build a Voronoi diagram over these points; each cell
   is a "patch" (a polygon with neighbor links). The central ~3 patches get a short
   Lloyd-relaxation pass (3 iterations) to make the core more compact/regular.
2. **Junction optimization.** Any two polygon vertices closer than ~8 units are merged
   into one — this removes degenerate slivers from the Voronoi construction before any
   downstream geometry depends on exact vertex identity.
3. **Patch filtering / city extent.** Patches farther than `radius * 3` from the town
   center are discarded (keeps the simulated area finite while leaving "countryside"
   patches around the core for farms).
4. **Inner / outer split.** A subset of patches forms the **city** (walled or
   unwalled core); the rest are **outside** (countryside, used for farms / generic
   rural wards). The boundary between them is found via a circumference walk
   (`findCircumference`) over the chosen inner patch set — this polygon is also the
   basis for the curtain wall.
5. **Curtain wall + gates** (optional — many towns have no wall). Built from the
   circumference polygon of the inner patch set. See §2.
6. **Ward assignment.** Special wards (Castle/Citadel, Market on the plaza, Cathedral,
   Administration, Military, Patriciate) are placed first by location-suitability
   scoring; everything else draws from a shuffled fixed-composition list, falling back
   to Slum when exhausted. Countryside patches become Farm or a generic ward. See §6.
7. **Street / topology graph.** Streets are not drawn explicitly as a separate graph in
   the original; instead every ward's inner geometry is generated already inset from
   its neighboring patches by half a street width, so the *gaps between patches*
   visually form the street network. Arterial streets (between the wall/gates and the
   plaza, or connecting gates to the plaza) are explicitly widened to `MAIN_STREET`.
8. **Per-ward building subdivision.** Each patch's ward instance computes a "city
   block" (its area inset from surrounding streets/walls, §3) then recursively
   subdivides that block into buildings via `createAlleys` (§4), or — for special wards
   — produces bespoke geometry (single large building, ring, plaza furniture, fields,
   radial park paths). See §6.

For a from-scratch JS port, steps 1–3 are well-trodden Voronoi/Lloyd-relaxation
territory; the town-specific value is almost entirely in steps 5–8, which this
document focuses on.

---

## 2. Curtain wall, gates, towers

- **Wall polygon** = the circumference polygon of the inner patch set (or, if only one
  patch is walled, that patch's own boundary).
- **Smoothing.** Each wall vertex that isn't a reserved point (gate or tower-forced
  corner) gets pulled toward a smoothed position by factor
  `min(1, 40 / numPatches)` — i.e. small towns get heavily smoothed/rounded walls,
  large cities get angular ones close to the raw Voronoi boundary.
- **Gates.** Candidate gate locations are "entrances": vertices where ≥2 patches meet
  that aren't already reserved. Repeatedly pick a random entrance, smooth it into a
  gate, then remove its immediate neighbors from the candidate list (1–2 entries
  depending on whether the pick was at an array end) so gates don't cluster. Repeat
  while ≥3 entrances remain — this naturally yields roughly 2–5 gates depending on
  town size, evenly spread around the perimeter.
- **Towers.** Placed at every remaining (non-gate) wall vertex that has at least one
  adjacent wall segment — i.e., towers sit at every wall corner except where a gate
  interrupts.
- **Wall thickness / tower radius (from starhill.json, a real v0.11.5 export):**
  `wallThickness = 7.6`, `towerRadius = 7.6` — i.e. towers are drawn as circles of the
  same radius as the wall is thick, centered on the wall vertex. Wall thickness scales
  with town size; treat 7.6 units (≈7.6 m at 1 unit = 1 m) as a "small/medium town"
  baseline, not a universal constant.
- **Citadel.** A separate small curtain wall is allowed around the castle/citadel
  ward alone, gated behind a compactness check (the candidate patch's shape
  compactness must exceed 0.75) so only reasonably round patches get their own
  inner keep wall. In starhill.json this shows up as the *second*, smaller polygon in
  the `walls` GeometryCollection (27-vertex outer wall vs. a separate small ring
  around the citadel patch).

---

## 3. getCityBlock — insetting a patch into a buildable block

Every ward (except bespoke ones like Castle) starts by shrinking its patch polygon
inward, edge by edge, to leave room for the street/wall that runs along that edge.
Per-edge inset distance is chosen by what's on the other side of the edge:

| Edge borders... | Inset distance |
|---|---|
| The curtain wall | `MAIN_STREET / 2` |
| The plaza, or a designated arterial street | `MAIN_STREET / 2` |
| Another inner-city patch (ordinary street) | `REGULAR_STREET / 2` |
| Nothing special / outer boundary | `ALLEY / 2` |

Then the inset polygon is built either by a `shrink()` (fast straight per-edge offset,
used when the patch is convex) or a more general `buffer()` (handles concavity
correctly) operation, both keyed off that per-edge distance list.

**Street width constants** (full width, i.e. the gap between two neighboring blocks
is the sum of each side's half-width — so two ordinary blocks facing each other get a
gap of `REGULAR_STREET`):
- `MAIN_STREET = 2.0`
- `REGULAR_STREET = 1.0`
- `ALLEY = 0.6`

These are unitless multiplier constants in the original (it works at "block size ~tens
of units" scale and the renderer scales up). starhill.json's actual road centerline
width is `roadWidth = 8` units for a town whose bounding box is ~4430 × 4155 units —
i.e. roads are rendered at a *fixed absolute* width chosen by the generator for the
town's overall scale, while `MAIN_STREET/REGULAR_STREET/ALLEY` are the *relative*
ratios used only when computing per-edge inset distance during block construction. When
porting to metres for a ~1000 m town, don't reuse `2.0/1.0/0.6` literally — pick
absolute widths (§9) and keep the 2:1:0.6 *ratio* between main:regular:alley if you
want the same visual hierarchy.

---

## 4. createAlleys — recursive block subdivision into buildings

Input: a city-block polygon plus four tuning parameters (each ward subclass supplies
its own values, see §6 table):
- `minSq` — minimum building footprint area; recursion stops once a piece would split
  below (a randomized fraction of) this.
- `gridChaos` (0–1) — how far off-center and off-perpendicular each cut is allowed to be.
- `sizeChaos` (0–1) — how much the effective stopping threshold itself jitters from
  piece to piece (so blocks don't all bottom out at exactly the same size).
- `emptyProb` — probability that an undersized leftover piece is dropped (becomes a
  yard/empty lot) rather than kept as a tiny building.

Algorithm (recursive, called on one polygon at a time):

1. **Pick the cut edge.** Scan the polygon's edges, find the longest one; remember its
   start vertex and its neighbor (end vertex). The longest edge is always cut — this is
   what keeps lots roughly square instead of degenerating into slivers.
2. **Pick where along it to cut.** `ratio = (1 - 0.8*gridChaos)/2 + random()*0.8*gridChaos`.
   At `gridChaos = 0` this collapses to exactly `0.5` (perfect bisection at the
   midpoint); as `gridChaos → 1` the cut point can land anywhere from 10% to 90% along
   the edge.
3. **Pick the cut angle.** Normally the cut line is perpendicular to the chosen edge.
   An angle offset of up to `±π/6 * gridChaos` (≈ ±30° at max chaos) is added, but only
   when the local area heuristic says the polygon is "open" enough not to produce a
   self-intersecting or sliver cut (the original guards this off for small/oddly-shaped
   polygons).
4. **Cut.** Call the bisection primitive (§5) with the start vertex, the ratio, the
   angle offset, and a gap width equal to `ALLEY` (or `0` for a seamless party-wall
   split with no alley between the two new buildings — used when the chaos params call
   for tightly packed rowhouses).
5. **Recurse / stop.** Each of the two resulting polygons is tested against a
   *randomized* threshold: `minSq * 2^(4 * sizeChaos * (random() - 0.5))`. This term
   ranges roughly from `minSq * 2^-2sizeChaos` to `minSq * 2^2sizeChaos` — i.e. at
   `sizeChaos=0` every piece must clear exactly `minSq`, while at `sizeChaos=1` the
   effective floor can vary by up to 4x in either direction piece-to-piece. If a
   piece's area is below its rolled threshold, stop recursing on it: keep it as a final
   building footprint, *unless* `random() < emptyProb`, in which case drop it (empty
   lot/yard, no building drawn). If a piece clears the threshold, recurse into step 1.

Net effect: `minSq` sets the "grain size" of the district (small=dense old-town
rowhouses, large=manor plots), `gridChaos` sets how organic vs. grid-like the street
pattern inside the block looks, `sizeChaos` sets how lumpy/irregular individual lot
sizes are, and `emptyProb` sets how many gaps/yards/gardens appear between buildings.

`filterOutskirts()` is applied afterward only when the owning patch is *not* fully
enclosed by other city patches (i.e. it has a raw edge facing the open countryside):
it thins out buildings near that open edge based on distance-weighted random
filtering, so settlements visibly "fray" into looser, sparser development at the city
edge instead of stopping with a hard rectilinear cliff.

---

## 5. Cutter.bisect — constructing one cut line

Given a polygon, a start vertex, the next vertex around the ring, a ratio, an angle
offset, and a gap:

1. **Locate the cut's first point** by linear interpolation between the two vertices:
   `p1 = vertex + ratio * (next - vertex)`.
2. **Compute the edge direction** `d = next - vertex`, then rotate it by the angle
   offset `B` (rotation matrix: `vx = d.x*cos(B) - d.y*sin(B)`, `vy = d.y*cos(B) +
   d.x*sin(B)`). At `B = 0` this is just the original edge vector.
3. **Build the second point perpendicular to that rotated direction:**
   `p2 = (p1.x - vy, p1.y + vx)` — i.e. rotate the (possibly already-angled) edge
   vector by another +90° and step from `p1` in that direction. The cut line is
   `p1 → p2` extended until it crosses the polygon boundary on the far side.
4. **Cut with a gap.** The actual polygon-splitting primitive takes a `gap` distance:
   instead of a single zero-width line, it removes a `gap`-wide strip centered on the
   `p1–p2` line, producing two separate polygons with a real alley-width space between
   them (gap=0 degenerates to a shared wall / zero-width split).

Related primitives used by special wards (§6):
- **`radial(poly, gap)`** — connects the centroid to every edge midpoint/vertex,
  producing pie-slice sectors (with the slice boundaries widened by `gap`) — used for
  formal/compact park layouts.
- **`semiRadial(poly, gap)`** — like radial but rays originate from one chosen edge's
  vertices rather than the true centroid, used when the block is too irregular for a
  clean radial fan (lower compactness).
- **`ring(poly, thickness, gap)`** — peels concentric bands inward, parallel to the
  current outer boundary, each `thickness` wide, processing the polygon's shorter sides
  first; used for circular/courtyard structures like a cathedral cloister ring.

---

## 6. Ward types

The "WARDS" assignment list (used after the special/forced placements below) has 35
entries with this composition — treat these as relative *selection weights*, not a
strict pool (a real implementation can sample with these frequencies instead of
shuffling a fixed array):

| Ward class | Count in 35-entry list | Weight |
|---|---|---|
| CraftsmenWard | 14 | ~40% |
| Slum | 4 | ~11% (also the fallback once the list is exhausted) |
| MerchantWard | 2 | ~6% |
| Market | 2 | ~6% (one is forced onto the plaza patch separately) |
| PatriciateWard | 2 | ~6% |
| Cathedral | 1 | ~3% |
| AdministrationWard | 1 | ~3% |
| MilitaryWard | 1 | ~3% |
| Park | 1 | ~3% |

Forced/special placements happen **before** drawing from that list:
- **Castle/Citadel** → the most "outward" or most compact eligible patch (compactness
  ≥ 0.75 required if it gets its own citadel wall).
- **Market** → the plaza patch, if the town has a plaza.
- **Cathedral** → rated by adjacency to the plaza (prefers a patch bordering it, else
  minimizes distance to it).
- **Gate wards** → patches touching a gate get a small probability of becoming a
  dedicated gate-related ward: 20% chance if the town has no wall, 50% if it does
  (gates matter more, visually/functionally, when there's a wall to puncture).
- **Countryside (outside) patches** → 20% chance of becoming a Farm if compactness
  ≥ 0.7, else a plain/generic ward (sparse low-density buildings).

### Per-ward geometry behavior

| Ward | Geometry produced | Key parameters |
|---|---|---|
| CraftsmenWard (generic residential/default) | Dense small-to-large building grid via createAlleys | `minSq = 10 + 80*rnd*rnd` (skewed small), `gridChaos = 0.5 + 0.2*rnd`, `sizeChaos = 0.6`, `emptyProb = 0.04` (CommonWard default) |
| Slum | Denser, messier building grid | `minSq = 10 + 30*rnd*rnd` (smaller than craftsmen), `gridChaos = 0.6 + 0.4*rnd` (more chaotic), `sizeChaos = 0.8`, `emptyProb = 0.03` |
| MerchantWard | Larger, more regular plots (warehouses/townhouses) | `minSq = 50 + 60*rnd*rnd`, `gridChaos = 0.5 + 0.3*rnd`, `sizeChaos = 0.7`, `emptyProb = 0.15` (more yards/loading space) |
| PatriciateWard | Treat as large-plot, low-chaos, low-empty variant — wealthy district with spacious, regular manor lots (same createAlleys mechanism, larger `minSq` and lower `gridChaos` than Merchant) |
| Market | A plaza-adjacent ward whose own geometry is just plaza furniture: 60% chance a rectangular statue (1–2 units, rotated to the patch's longest edge), else 40% chance a circular fountain (radius 1–2 units). Placement: if there's a statue or a 30% roll, offset 20–60% of the way from centroid toward the longest edge's midpoint; otherwise centered. `rateLocation()` actively avoids two Markets being adjacent and penalizes a Market that's large relative to the plaza. |
| Cathedral | 40% a ring structure (`Cutter.ring`, radius 2–6 units) else 60% one large orthogonal building (`createOrthoBuilding(poly, 50, 0.8)`). Rated to prefer overlooking the plaza. |
| AdministrationWard / MilitaryWard / PatriciateWard (special variants) | Typically one or a few large orthogonal buildings via `createOrthoBuilding`, with `rateLocation()` favoring proximity to plaza/castle — treat geometrically like a low-count, large-`minSq` createAlleys or a single createOrthoBuilding call when porting if exact source isn't available |
| Castle/Citadel | Single dominant orthogonal building: block = patch shrunk by `MAIN_STREET * 2`; building footprint ≈ `sqrt(block.area) * 4` per side (i.e. roughly a square sized so its perimeter relates to the available area), density/aspect parameter `0.6`; wrapped in its own `CurtainWall` built from the subset of the patch's vertices that face *outside* the city. |
| Park | Green space cut by paths, no/sparse buildings. If block compactness ≥ 0.7 use `Cutter.radial()` (regular spoke paths from center), else `Cutter.semiRadial()` (paths from one edge); paths cut at `ALLEY` width. (Tree placement/density isn't specified in source — see §9 for a reasonable invented default.) |
| Farm (countryside) | One small building (`Polygon.rect(4,4)`) placed 30–70% of the way from a random boundary point toward the patch centroid, random rotation `0..π`, raised via `createOrthoBuilding(housing, 8, 0.5)` (so it reads as a farmstead, not a field pattern itself — the surrounding "fields" layer in starhill.json is a separate generation pass over countryside patches, not part of Farm ward's own geometry) |
| Generic/plain countryside ward | Same createAlleys mechanism as CraftsmenWard but very sparse — large `minSq`, often filtered hard by `filterOutskirts()` since these patches are essentially never fully enclosed |

`createOrthoBuilding(poly, minBlockSq, fill)` — used wherever a ward wants "a few big
orthogonal buildings" instead of the organic createAlleys grid: it recursively bisects
along the longest edge exactly like createAlleys but with simpler stopping (no
gridChaos/sizeChaos jitter — `minBlockSq` is the flat area floor) and `fill`
(0–1) controls what fraction of undersized leftover pieces still get included as
small buildings rather than discarded. Use this for Cathedral's orthogonal branch,
Castle's keep, Farm's farmhouse, and any administration/military single-building wards.

---

## 7. Scale sanity-check from starhill.json (real v0.11.5 output)

This is one concrete town export, useful for calibrating absolute numbers (not
hard rules — every town's overall scale varies with patch count):

- `roadWidth = 8`, `wallThickness = 7.6`, `towerRadius = 7.6`, `riverWidth ≈ 31.85`
  (all in the same unit as coordinates).
- Town extent (`earth` polygon bbox): ~4431 × 4155 units.
- Outer wall ring: 27 vertices, bbox ~600 × 650 units (i.e. wall encloses roughly an
  eighth of the full modeled "earth" extent — most of the bbox is open countryside/
  fields beyond the wall).
- A second, smaller wall ring (6 vertices, bbox ~205 × 178) — the citadel's own wall.
- `roads`: 4 LineStrings, each width 8, 3–15 vertices — main arterial streets in/out
  of gates and to the plaza.
- `planks` (bridges): 9 short 2-point LineStrings, width 4.8, length consistently
  ~32 units (one outlier ~36.7) — i.e. planks are short, near-constant-length straight
  segments crossing the river at a near-fixed width-driven length, not winding bridges.
  32 units is close to the river width (31.85) — **a plank's length is essentially the
  local river width plus a small margin**, confirming planks are perpendicular
  river-crossings exactly at street/road intersections with the river.
- `buildings`: 607 polygons, area range ~70–4837, median ~250, mean ~277 (square
  units) — gives a concrete sense of "typical building footprint" for tuning `minSq`.
- `fields` (countryside): 15 polygons, median area ~4743, much larger than buildings,
  confirming fields are a separate large-block layer outside the wall, not part of
  Farm ward's own building geometry.
- `squares` (plaza): 1 polygon, area ~3791, 4 vertices — the plaza is a simple
  quadrilateral in this example.
- `prisms`: 1 small polygon, ~49 area, 8 vertices — likely a monument/landmark/statue
  footprint (matches Market ward's statue object described in §6).
- `districts`: 7 named polygons (e.g. "Long Pass", "The Port", "Wool Crown",
  "Citadel", "Grimrise Gate", "Great Road", "Frostsoul Way") — flavor-text district
  groupings overlaid on the patch layout, purely cosmetic/labeling, not structural.
- `greens` and `trees` are present as layer keys but empty in this particular export
  (this town simply has no Park ward) — confirms they're real output layers, just
  conditionally populated.

---

## 8. Water (rivers, lakes, planks) — not in TownGeneratorOS, inferred

TownGeneratorOS (the open-source repo) has **no water/river code at all** — this is a
feature only in the closed-source/newer mfcg builds. The following is inferred
from starhill.json's actual output shape plus general procedural-town-generation
practice. Treat this section as a design proposal, not a ported algorithm.

**River:**
- Model as a single polyline (the `rivers` LineString, e.g. 16 vertices for the
  reference town) with a constant or slowly-varying `riverWidth`. A simple approach:
  generate the river as one more "edge" of the Voronoi-derived terrain — pick an
  entry point and exit point on the modeled area's boundary (opposite-ish sides for a
  river that crosses the whole town), then route it through a chain of intermediate
  points with mild random lateral jitter (a simple midpoint-displacement / Perlin-noise
  meander gives a natural look) and smooth.
- Rasterize/vectorize the river as a buffered polygon: offset the polyline by
  `riverWidth/2` on each side and produce a ribbon polygon (this is what should get
  unioned into the `water` layer/polygon set).
- **Width ≈ 25–40 m** for a ~1000 m town is consistent with the reference (31.85 units
  in a ~4400-unit-wide modeled area, i.e. river width is roughly 0.7% of the full
  modeled extent — for a 1000 m town that's ~7 m, but that reference town's modeled
  extent included a lot of open countryside around a much smaller walled core; if you
  scale relative to the *walled core* (~600 units) instead, 31.85/600 ≈ 5.3%, which
  for a ~1000 m era walled town footprint of comparable proportions gives a far more
  plausible **~15–25 m** river. Prefer this core-relative scaling, not full-extent
  scaling, when picking a width.)

**Ponds / lakes:**
- Model as standalone closed polygons in the same `water` layer, generated either as
  a widened dead-end stub of the river network or as an independent small irregular
  blob (e.g. jittered circle / low-vertex-count Voronoi cell) placed in a low-priority
  countryside or park patch. Keep them clearly smaller than the river's footprint
  unless deliberately generating a lakeside town.

**Patches/buildings yielding to water:**
- After Voronoi patch generation and before ward geometry creation, **clip every
  patch polygon against the river/lake polygon** (boolean difference). A patch that
  is mostly underwater should be dropped entirely (treat as non-buildable, like
  outside-radius patches); a patch that's partly covered keeps only its dry remainder
  as the polygon fed into `getCityBlock`/`createAlleys`.
- **Leave a bank margin**: after clipping, additionally inset the dry remainder by a
  small constant (e.g. 3–6 m, similar order to `ALLEY`) so buildings don't sit flush
  against the waterline — gives a visual towpath/embankment strip. This can reuse the
  exact same per-edge-inset machinery as `getCityBlock`, just treating "borders water"
  as another edge-context case with its own inset distance.
- Any street segment that would cross the river instead terminates at the bank on
  each side and is connected by a **plank** (see below) rather than being clipped away.

**Planks (bridges):**
- A plank is generated wherever a road/street centerline crosses the river centerline:
  compute the intersection point, then draw a short straight segment perpendicular to
  the river's local direction, spanning from one bank to the other.
- **Length** = local river width at that point + a small fixed margin (the reference
  data's plank length, ~32 units, sits almost exactly at the river width of 31.85,
  i.e. margin ≈ 0). Use `plankLength ≈ riverWidth + 0–2 m`.
- **Width** ≈ 0.6× the road's own width (reference: plank width 4.8 vs road width 8,
  ratio 0.6) — planks/footbridges are narrower than the street that feeds them, since
  not every street needs full carriage width to cross.
- Only generate a plank where an actual street/road would otherwise need to cross —
  don't sprinkle them randomly; this keeps the road graph connected (every gate or
  arterial street that the river bisects gets exactly one crossing).
- For visual variety, occasionally widen one plank near the town center into a proper
  multi-support bridge (cosmetic only — same geometry, thicker line/different render
  style), if a "main bridge" focal point is desired.

---

## 9. Suggested defaults (for a ~1000 m walled town, 1 unit = 1 m)

```text
# Streets / blocks (relative ratios preserved from source; absolute values chosen
# for human/metric scale instead of the original's small-number unitless system)
MAIN_STREET_WIDTH    = 10 m   # arterials, plaza frontage, wall-adjacent streets
REGULAR_STREET_WIDTH = 5 m    # ordinary inter-patch streets
ALLEY_WIDTH           = 3 m    # alleys / cut gaps inside createAlleys

# Curtain wall
WALL_THICKNESS  = 3 m         # scale up for larger towns; ~7.6 units in a much
TOWER_RADIUS    = 3 m         # bigger reference town's own unit system
WALL_SMOOTH_MAX_PATCHES = 40  # smoothFactor = min(1, 40 / numPatches)
GATE_MIN_REMAINING_ENTRANCES = 3
CITADEL_MIN_COMPACTNESS = 0.75

# createAlleys defaults by ward "feel" (minSq in m^2, matches median building
# footprint scale of ~25 m^2 for dense rowhouses up to ~110 m^2 for merchant plots,
# scaled up from the reference town's own unitless 250 median to real building sizes)
CraftsmenWard:   minSq = 25 + 80*rnd*rnd,  gridChaos = 0.5+0.2*rnd, sizeChaos = 0.6, emptyProb = 0.04
Slum:            minSq = 20 + 30*rnd*rnd,  gridChaos = 0.6+0.4*rnd, sizeChaos = 0.8, emptyProb = 0.03
MerchantWard:    minSq = 60 + 60*rnd*rnd,  gridChaos = 0.5+0.3*rnd, sizeChaos = 0.7, emptyProb = 0.15
PatriciateWard:  minSq = 90 + 80*rnd*rnd,  gridChaos = 0.3+0.2*rnd, sizeChaos = 0.5, emptyProb = 0.10
Generic/outskirts: minSq = 80 + 120*rnd*rnd, gridChaos = 0.6+0.3*rnd, sizeChaos = 0.7, emptyProb = 0.2

# Cut gap used inside createAlleys/createOrthoBuilding bisection
ALLEY_CUT_GAP = ALLEY_WIDTH   # or 0 for seamless party-wall splits

# Special wards
MARKET_STATUE_PROB   = 0.6
MARKET_FOUNTAIN_PROB = 0.4
MARKET_OBJECT_SIZE   = 1..2 m (statue), 1..2 m radius (fountain)
CATHEDRAL_RING_PROB  = 0.4
CATHEDRAL_RING_RADIUS = 2..6 m
CATHEDRAL_ORTHO_PARAMS = (minBlockSq=50 -> scale to ~150 m^2, fill=0.8)
CASTLE_BLOCK_INSET   = MAIN_STREET_WIDTH * 2
CASTLE_FOOTPRINT_SIDE = sqrt(blockArea) * 4   # heuristic, clamp to block bounds
CASTLE_DENSITY        = 0.6
PARK_COMPACTNESS_THRESHOLD = 0.7   # >=0.7 radial cut, else semiRadial
PARK_PATH_WIDTH        = ALLEY_WIDTH
FARM_HOUSE_SIZE        = 4..6 m square, placed 30-70% toward centroid, rotation 0..pi

# Ward selection weights (relative frequency, sample-with-replacement style)
CraftsmenWard 40%, Slum 11% (+ fallback), MerchantWard 6%, Market 6%,
PatriciateWard 6%, Cathedral 3%, AdministrationWard 3%, MilitaryWard 3%, Park 3%
(remaining countryside patches: Farm 20% if compactness>=0.7, else generic ward)
GATE_WARD_PROB_NO_WALL = 0.20
GATE_WARD_PROB_WALLED  = 0.50

# Water (inferred, not from source)
RIVER_WIDTH       = 15-25 m   # core-relative scaling, see §8
RIVER_BANK_MARGIN = 4 m       # extra inset for patches/buildings adjacent to water
PLANK_LENGTH      = riverWidth + 0-2 m
PLANK_WIDTH       = 0.6 * REGULAR_STREET_WIDTH (or MAIN_STREET_WIDTH at primary crossings)
POND_MIN_RADIUS   = 15 m, POND_MAX_RADIUS = 60 m (independent of river)
```

---

## Sources consulted

- TownGeneratorOS (Haxe, GPL-3.0) — `wards/Ward.hx`, `wards/CommonWard.hx`,
  `wards/Market.hx`, `wards/Castle.hx`, `wards/Cathedral.hx`, `wards/Park.hx`,
  `wards/Slum.hx`, `wards/MerchantWard.hx`, `wards/CraftsmenWard.hx`, `wards/Farm.hx`,
  `building/Cutter.hx`, `building/Model.hx`, `building/CurtainWall.hx`
  (https://github.com/watabou/TownGeneratorOS) — read for algorithm/parameter
  understanding; no code copied verbatim, descriptions and pseudocode above are
  original wording.
- `reference/starhill.json` — real mfcg v0.11.5 town export, parsed with Python for
  `values` (roadWidth/wallThickness/towerRadius/riverWidth) and all layer geometries
  (earth, roads, walls, rivers, planks, buildings, prisms, squares, greens, fields,
  trees, districts, water).
- `reference/mfcg.js` — not read linearly (1.3 MB minified Haxe/OpenFL); not needed
  given the above two sources already answered every required question.
