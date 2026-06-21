# Infinite-mode town generator — module contracts (Phase 1)

**Read this fully before writing code.** Phase 1 = a *standalone* procedural
town generator + ISSprOM SVG visualization, opened via a local `test.html`. NO
start/ziel, NO routing/pathfinding (that's a later phase). Everything is
**vanilla ES modules, no external dependencies, no build step**, runnable in the
browser and in a Web Worker later (so generator modules must be **DOM-free**;
only `issprom.js` touches the DOM).

We are doing a **clean-room port** of Watabou's town-generation *algorithm*
(Voronoi patches → typed wards → recursive parcel subdivision → buildings, plus
walls/streets, and our own water). **Do NOT copy GPL-3.0 source**; implement the
standard, well-known algorithms yourself.

---

## 1. Coordinate & data conventions

- Coordinates are **planar metres**, `+x` right, `+y` down (SVG-friendly). Origin
  is arbitrary; the renderer auto-fits the model bbox into the SVG viewBox.
- Primitive types (use plain arrays — JSON-compatible, matches the fixture):
  - `Pt`     = `[number, number]`  → `[x, y]`
  - `Ring`   = `Pt[]`              → a polygon ring. **May or may not repeat the
    first vertex; always treat rings as implicitly closed.** Outer rings wound
    counter-clockwise, holes clockwise (don't rely on it — compute orientation).
  - `Polygon` = `Ring[]`           → `ring[0]` = outer, `ring[1..]` = holes
    (most polygons have a single ring).
  - `LineString` = `Pt[]`
- **RNG:** all randomness goes through a single seeded PRNG from `geom.js`
  (`makeRng(seed)`), so a given seed reproduces a layout exactly. Never call
  `Math.random()` in generator code.

---

## 2. Output: `TownModel` (the one schema everything shares)

`model.generateTown(opts)` returns this; `issprom.renderTown` consumes it; the
fixture `fixtures/sample-town.json` is an instance of it (slimmed from the real
mfcg oracle `reference/starhill.json`, mfcg v0.11.5).

```js
TownModel = {
  meta: {
    sizeM,          // number — town extent in metres (Phase 1 default 1000)
    seed,           // string|number — RNG seed used
    bbox,           // [minx,miny,maxx,maxy]
    roadWidth,      // metres (street stroke width)        e.g. 8
    wallThickness,  // metres (curtain wall thickness)     e.g. 7.6
    towerRadius,    // metres                              e.g. 7.6
    riverWidth,     // metres (river stroke width)         e.g. 32
    version,
  },
  layers: {
    earth:     Polygon[],   // land base outline(s)
    districts: Polygon[],   // ward/patch regions (internal; usually not drawn)
    buildings: Polygon[],   // building footprints (black)
    prisms:    Polygon[],   // landmark / tall buildings (black, treat as building)
    walls:     Polygon[],   // curtain-wall ring(s) -> impassable stone wall
    squares:   Polygon[],   // plazas (paved)
    greens:    Polygon[],   // parks (forest/open green)
    fields:    Polygon[],   // farmland (cultivated/olive or rough)
    water:     Polygon[],   // water bodies (blue, uncrossable)
    roads:     LineString[],// street network (width = meta.roadWidth)
    rivers:    LineString[],// river centerlines (width = meta.riverWidth)
    planks:    LineString[],// bridges/docks over water (crossing glyph)
    trees:     Pt[],        // tree positions (point symbol)
    // optional extras you may add: hedges: LineString[], gardens: Polygon[],
    // fountains: Pt[], wells: Pt[], boulders: Pt[]
  }
}
```

Empty layers must still be present as empty arrays. Keep the layer **names
exactly** as above (renderer keys off them).

---

## 3. Module interfaces (file → exports)

All under `results/static/results/js/infinite/`. Generator modules in `town/`.

### `town/geom.js`  (DOM-free) — load-bearing primitives, build first
```js
export function makeRng(seed): () => number   // deterministic float in [0,1)
export function area(ring): number            // signed area (>0 == CCW)
export function centroid(ring): Pt
export function perimeter(ring): number
export function bbox(ring): [minx,miny,maxx,maxy]
export function lerp(a: Pt, b: Pt, t): Pt
export function rotate(p: Pt, angle, origin=[0,0]): Pt
export function longestEdge(ring): { index, a: Pt, b: Pt, length }
// Split a simple ring by the infinite line through p1->p2 into two rings.
// `gap` pulls the two halves apart by `gap` total (gap/2 each side, along the
// cut normal) — this is what creates alleys between parcels. Returns [] if the
// line misses the polygon, else [ringA, ringB].
export function cut(ring, p1: Pt, p2: Pt, gap=0): Ring[]
// Inset (shrink) a ring inward by `dist` metres (uniform), or per-edge if
// `dist` is a number[] (one inset per edge, same order as edges). Positive =
// inward. Returns a (possibly empty) ring. Must tolerate concave rings.
export function shrink(ring, dist: number | number[]): Ring
// Outward offset (buffer). Positive = outward.
export function buffer(ring, dist: number): Ring
```
Implement robustly for convex AND mildly concave rings. Include a self-test
block (guarded `if (import.meta.url === ...)` or an exported `__selfTest()`)
covering area sign, cut producing two rings whose areas ≈ original minus gap,
and shrink reducing area.

### `town/voronoi.js`  (DOM-free) — depends on geom.js
```js
// Scatter `count` seeds in bbox via rng, build a Voronoi diagram, run `lloyd`
// relaxation passes, return the cell polygons (as rings) clipped to bbox.
export function generatePatches(rng, bbox, count, lloyd=2): Ring[]
// (Optional lower-level helpers ok: voronoiCells(points, bbox), lloydRelax(...).)
```
Use a standard Voronoi (e.g. Fortune's or a Delaunay-dual); pure JS, no deps.

### `town/cutter.js`  (DOM-free) — depends on geom.js
```js
// Bisect `ring` near `vertexIndex`: interpolate a point at `ratio` along the
// edge from that vertex, build a line at `angle` to that edge, cut with `gap`.
export function bisect(ring, vertexIndex, ratio=0.5, angle=0, gap=0): Ring[]
// Optional: radial/ring ("peel") cutters for plaza/castle wards.
```

### `town/ward.js`  (DOM-free) — depends on geom.js, cutter.js
```js
export const WARD_TYPES   // array of {name, weight, ...} (Residential, Market,
                          // Park, Farm, Castle, Cathedral, Slum, Craftsmen, ...)
// Inset a patch ring to leave room for streets/walls (per-edge widths).
export function getCityBlock(patchRing, opts): Ring
// Recursively subdivide a block into building footprints. Find longest edge,
// bisect with ratio jittered by gridChaos + gap (alley), recurse until area <
// minSq, vary by sizeChaos, drop ~emptyProb of plots. Returns building rings.
export function createAlleys(blockRing, { minSq, gridChaos, sizeChaos, emptyProb, gap }, rng): Ring[]
// Produce one ward's contributions, dispatched by type.
export function buildWard(patchRing, wardType, rng, params): {
  buildings: Ring[], squares: Ring[], fields: Ring[], greens: Ring[],
  trees: Pt[], hedges?: LineString[], gardens?: Ring[]
}
```

### `town/model.js`  (DOM-free) — the entry point; depends on all above
```js
// THE generator. Returns a TownModel (section 2).
export function generateTown(opts = {}): TownModel
//   opts: { sizeM=1000, seed=<random>, patchCount, water=true|0..1,
//           minSq, gap, gridChaos, sizeChaos, emptyProb, treeDensity,
//           largeBuildingProb, wall=true|0..1, ...all tunables w/ sane defaults }
```
Steps: patches (voronoi) → inner/outer split → optional CurtainWall ring(s) +
gates → street graph (roads) → assign ward types → per patch `getCityBlock` +
`buildWard` → **water** (rivers/ponds + planks bridges, clip/offset patches &
buildings, add bank) → assemble layered TownModel. Fill `meta` (incl. bbox).

### `issprom.js`  (DOM module) — depends only on the TownModel schema
```js
export const COLORS   // ISSprOM colour table (section 4)
export const WEIGHTS  // line weights in metres (section 4)
// Render a TownModel into an <svg> element. Fits meta.bbox into the viewBox
// with a small margin; draws layers back-to-front in the order in section 4.
export function renderTown(townModel, svgElement, opts = {}): void
```

---

## 4. ISSprOM symbology (from `reference/Base SVGs/` + `reference/Base Rescales/`)

Colours sampled from the OCAD exports (RGB):
- open land (yellow): `rgb(255,204,54)`
- building / wall / fence (black): `rgb(0,0,0)`
- forest runnable (white): `rgb(255,255,255)`
- paved (grey): `rgb(204,204,204)` light, `rgb(115,115,115)` dark
- out-of-bounds / garden / cultivated (olive): `rgb(171,193,48)`
- vegetation greens: `rgb(74,255,23)` slow-run, `rgb(0,135,0)` impassable/hedge
- water (blue): `rgb(74,189,255)` fill, darker `rgb(13,179,255)` / black bank
- course overprint (magenta, later phases): `rgb(255,0,255)`

Draw order (back → front) and mapping:
1. `earth` → open-land base fill (yellow).
2. `fields` → cultivated/olive; `greens` → green/forest.
3. `squares` → paved grey; `roads` → paved/path stroke (width `roadWidth`).
4. `water` → blue fill + bank; `rivers` → blue stroke (width `riverWidth`).
5. `buildings` + `prisms` → black fill, thin outline.
6. `walls` → solid black stroke (width `wallThickness`); `hedges` → dark-green
   band; fences → black + tick marks at a regular interval.
7. `planks` → bridge/crossing glyph over water.
8. `trees` → green dot; fountains/wells → blue point; boulders → black dot.

Weights are in **metres** and scaled to px via the renderer's px-per-metre
(`viewBoxPx / sizeM`). Tune to *look like* the references on screen.

---

## 5. Fixture & how to test in isolation

- `fixtures/sample-town.json` is a valid `TownModel`. The renderer (`issprom.js`)
  and `test.html` must work against it **before** `model.generateTown` exists —
  load the JSON and render it. This lets the renderer/harness be built in
  parallel with the generator.
- `test.html` lives at `results/static/results/infinite/test.html`. It imports
  `../js/infinite/town/model.js` + `../js/infinite/issprom.js`, renders one town,
  and offers **Regenerate**, a **seed** input, and tunable inputs. It must also
  have a "load fixture" path so it works before the generator lands. ES-module
  imports are blocked under `file://` — document opening via
  `python -m http.server` at the repo root.

---

## 6. Defaults (Phase 1)

`sizeM=1000`, `patchCount≈ sizeM/70`, `lloyd=2`, street `roadWidth≈8`,
`wallThickness≈7.6`, building `minSq≈ (8..12)²`, alley `gap≈1.5`,
`gridChaos≈0.5`, `sizeChaos≈0.6`, `emptyProb≈0.04`, `water` ~40% of towns.
All overridable via `generateTown(opts)`.
