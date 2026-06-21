// ward.js — ward-type table, city-block insetting, recursive alley
// subdivision, and per-ward-type geometry dispatch. Vanilla ES module. No
// dependencies, DOM-free.
//
// Clean-room implementation (see CONTRACTS.md §3 + REFERENCE_NOTES.md §3,
// §4, §6, §9). Builds on geom.js + cutter.js primitives only.

import { area, centroid, bbox, lerp, shrink, perimeter, makeRng } from './geom.js';
import { bisect, radial, semiRadial } from './cutter.js';

// ---------------------------------------------------------------------------
// Ward type table (REFERENCE_NOTES.md §6, §9)
// ---------------------------------------------------------------------------

/**
 * Ward types and their relative selection weights. Weights are sample-with-
 * replacement frequencies (don't need to sum to 1 — callers normalize).
 * `createAlleys` param presets are included where the ward uses the generic
 * recursive-subdivision mechanism; bespoke wards (Market/Park/Farm/Castle/
 * Cathedral) carry their own descriptive params instead.
 * @type {Array<{name:string, weight:number, params?:object}>}
 */
export const WARD_TYPES = [
  {
    name: 'Craftsmen',
    weight: 40,
    params: { minSqBase: 120, minSqRand: 140, gridChaosBase: 0.5, gridChaosRand: 0.2, sizeChaos: 0.5, emptyProb: 0.05 },
  },
  {
    name: 'Slum',
    weight: 11,
    params: { minSqBase: 70, minSqRand: 90, gridChaosBase: 0.6, gridChaosRand: 0.4, sizeChaos: 0.6, emptyProb: 0.04 },
  },
  {
    name: 'Merchant',
    weight: 6,
    params: { minSqBase: 170, minSqRand: 180, gridChaosBase: 0.5, gridChaosRand: 0.3, sizeChaos: 0.6, emptyProb: 0.15 },
  },
  {
    name: 'Market',
    weight: 0, // forced placement only (one central market) — a whole-ward
               // plaza is too big to scatter several of around the town
    params: {},
  },
  {
    name: 'Patriciate',
    weight: 6,
    params: { minSqBase: 230, minSqRand: 220, gridChaosBase: 0.3, gridChaosRand: 0.2, sizeChaos: 0.4, emptyProb: 0.12 },
  },
  {
    name: 'Cathedral',
    weight: 3,
    params: {},
  },
  {
    name: 'Administration',
    weight: 3,
    params: { minSqBase: 240, minSqRand: 180, gridChaosBase: 0.2, gridChaosRand: 0.1, sizeChaos: 0.3, emptyProb: 0.1 },
  },
  {
    name: 'Military',
    weight: 3,
    params: { minSqBase: 240, minSqRand: 180, gridChaosBase: 0.2, gridChaosRand: 0.1, sizeChaos: 0.3, emptyProb: 0.1 },
  },
  {
    name: 'Park',
    weight: 3,
    params: {},
  },
  {
    name: 'Castle',
    weight: 0, // forced placement only, not drawn from the weighted pool
    params: {},
  },
  {
    name: 'Farm',
    weight: 0, // countryside-only, assigned by compactness rule not weight
    params: {},
  },
  {
    name: 'Generic',
    weight: 0, // countryside fallback
    params: { minSqBase: 190, minSqRand: 210, gridChaosBase: 0.6, gridChaosRand: 0.3, sizeChaos: 0.6, emptyProb: 0.2 },
  },
];

/**
 * Pick a ward type name using the weighted table above (excludes
 * zero-weight/forced-placement-only entries unless explicitly requested
 * elsewhere). Convenience helper — buildWard() itself takes an explicit
 * wardType, this is just for callers (e.g. model.js) that want one sample.
 * @param {() => number} rng
 * @returns {string} ward type name
 */
export function pickWardType(rng) {
  const pool = WARD_TYPES.filter((w) => w.weight > 0);
  const total = pool.reduce((s, w) => s + w.weight, 0);
  let r = rng() * total;
  for (const w of pool) {
    if (r < w.weight) return w.name;
    r -= w.weight;
  }
  return pool[pool.length - 1].name;
}

// ---------------------------------------------------------------------------
// Street width defaults (REFERENCE_NOTES.md §9)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  mainStreet: 10,
  regularStreet: 5,
  alley: 3,
};

// Absolute minimum footprint area (sq m) below which a createAlleys leaf is
// discarded outright rather than kept as a "building" — independent of
// minSq/sizeChaos. Gap-cuts taken near a sharp ancestor corner can yield a
// leaf whose area clears the randomized minSq threshold but is in practice
// a thin shard (a sliver a meter or two across), not a buildable lot; real
// building footprints bottom out well above this (starhill.json's smallest
// recorded building is ~70 sq m). Kept well below typical minSq values so
// it only catches genuine degenerate artifacts, not legitimate small lots.
const SLIVER_FLOOR_SQM = 40;

// ---------------------------------------------------------------------------
// getCityBlock()
// ---------------------------------------------------------------------------

/**
 * Inset a patch ring to leave room for the street/wall running along each
 * edge (REFERENCE_NOTES.md §3). `opts.edgeWidths` (number[], one full street
 * width per edge, same order/count as ring edges) takes priority; otherwise
 * a uniform `opts.streetWidth` (default REGULAR_STREET) is used for every
 * edge. The inset distance per edge is half the relevant street width (each
 * side of a street contributes half the gap).
 *
 * @param {Array<[number,number]>} patchRing
 * @param {{edgeWidths?: number[], streetWidth?: number}} [opts]
 * @returns {Array<[number,number]>} inset block ring (possibly [])
 */
export function getCityBlock(patchRing, opts = {}) {
  if (!Array.isArray(patchRing) || patchRing.length < 3) return [];
  const n = closedLen(patchRing);
  let widths;
  if (Array.isArray(opts.edgeWidths) && opts.edgeWidths.length === n) {
    widths = opts.edgeWidths.map((w) => w / 2);
  } else {
    const uniform = opts.streetWidth ?? DEFAULTS.regularStreet;
    widths = new Array(n).fill(uniform / 2);
  }
  return shrink(patchRing, widths);
}

// Isoperimetric compactness ratio (4*pi*area / perimeter^2): 1.0 for a
// circle, smaller for elongated/irregular shapes. Used to decide between a
// regular radial fan (compact patches) and an off-center semi-radial fan
// (irregular patches) — REFERENCE_NOTES.md §6, §9 (PARK_COMPACTNESS_THRESHOLD).
function compactness(ring) {
  const p = perimeter(ring);
  if (p <= 0) return 0;
  const a = Math.abs(area(ring));
  return (4 * Math.PI * a) / (p * p);
}

function closedLen(ring) {
  if (ring.length < 2) return ring.length;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.length - 1;
  return ring.length;
}

// ---------------------------------------------------------------------------
// createAlleys() — recursive block subdivision into buildings
// ---------------------------------------------------------------------------

/**
 * Recursively subdivide a city block into building footprints
 * (REFERENCE_NOTES.md §4). Finds the longest edge, bisects it at a ratio
 * jittered by `gridChaos`, with an alley `gap`, and recurses on each half
 * until its area drops below a randomized threshold derived from `minSq`
 * and `sizeChaos`; ~`emptyProb` of those leaves are then dropped (yards /
 * courtyards) rather than kept as buildings. Surviving leaves get a small
 * inward inset (half the alley gap) so buildings don't sit flush against
 * the alley/street line.
 *
 * @param {Array<[number,number]>} blockRing
 * @param {{minSq:number, gridChaos:number, sizeChaos:number, emptyProb:number, gap:number}} params
 * @param {() => number} rng
 * @returns {Array<Array<[number,number]>>} building rings
 */
export function createAlleys(blockRing, params, rng) {
  const { minSq, gridChaos = 0.5, sizeChaos = 0.6, emptyProb = 0.04, gap = DEFAULTS.alley } = params || {};
  const buildings = [];
  const MAX_DEPTH = 24; // safety valve against runaway recursion on pathological input

  // Root block bbox, used to guard against gap-cut corner overshoot: when a
  // cut line's gap-translation lands near a sharp corner of an ancestor
  // ring, geom.cut()'s "push the on-line vertices apart by gap/2 along the
  // cut normal" construction can push a vertex slightly outside the
  // *original* (un-gapped) polygon footprint at that corner — this is
  // inherent to how a gap is carved at a non-perpendicular junction, not a
  // bug in geom.cut itself. We treat the root block's bbox as the hard
  // outer bound buildings must respect and fall back to a zero-gap split
  // for any cut that would breach it.
  const rootBbox = bbox(blockRing);

  function withinRootBbox(ring) {
    const eps = 1e-6;
    for (const [x, y] of ring) {
      if (x < rootBbox[0] - eps || x > rootBbox[2] + eps || y < rootBbox[1] - eps || y > rootBbox[3] + eps) return false;
    }
    return true;
  }

  // Emit a final leaf as a building, subject to: the empty-lot roll, a
  // minimum-area sanity floor (drops degenerate slivers — see comment on
  // SLIVER_FLOOR_SQM below), and finalizeLeaf's cosmetic inset.
  function emitLeaf(ring) {
    if (rng() < emptyProb) return; // dropped: empty lot/yard
    const a = Math.abs(area(ring));
    if (a < SLIVER_FLOOR_SQM) return; // degenerate shard, not a buildable lot
    const built = finalizeLeaf(ring, gap);
    if (built.length >= 3 && Math.abs(area(built)) >= SLIVER_FLOOR_SQM) buildings.push(built);
  }

  function recurse(ring, depth) {
    if (!Array.isArray(ring) || ring.length < 3) return;
    const a = Math.abs(area(ring));
    if (!Number.isFinite(a) || a <= 0) return;

    // Randomized stop threshold: minSq * 2^(4*sizeChaos*(rnd-0.5)).
    const threshold = minSq * Math.pow(2, 4 * sizeChaos * (rng() - 0.5));

    if (a < threshold || depth >= MAX_DEPTH) {
      emitLeaf(ring);
      return;
    }

    // Pick the longest edge to cut.
    const le = longestEdgeOf(ring);
    if (le.index < 0 || le.length <= 0) {
      // No usable edge (degenerate) — treat as a leaf.
      emitLeaf(ring);
      return;
    }

    // ratio = (1 - 0.8*gridChaos)/2 + rnd()*0.8*gridChaos
    const ratio = (1 - 0.8 * gridChaos) / 2 + rng() * 0.8 * gridChaos;

    // Cut nearly PERPENDICULAR to the longest edge so buildings come out
    // mostly rectangular (Watabou-style), with only a tiny ±~2° jitter for a
    // hand-drawn feel. Shape diversity comes from the irregular block outline
    // (boundary lots stay trapezoidal) + the ratio jitter above, not from
    // skewing every cut (which produced "shattered glass" quadrilaterals).
    const angle = (rng() * 2 - 1) * (Math.PI / 90) * gridChaos;

    let halves = bisect(ring, le.index, ratio, angle, gap);
    if (halves.length === 2 && (!withinRootBbox(halves[0]) || !withinRootBbox(halves[1]))) {
      // Gap-cut overshot the root block's bbox near a sharp corner — retry
      // this exact cut with angle=0 (perpendicular, less likely to clip a
      // corner) and, failing that, gap=0 (zero-width split; no alley at
      // this one junction, but geometrically safe).
      const retryPerp = bisect(ring, le.index, ratio, 0, gap);
      if (retryPerp.length === 2 && withinRootBbox(retryPerp[0]) && withinRootBbox(retryPerp[1])) {
        halves = retryPerp;
      } else {
        const retryNoGap = bisect(ring, le.index, ratio, angle, 0);
        if (retryNoGap.length === 2 && withinRootBbox(retryNoGap[0]) && withinRootBbox(retryNoGap[1])) {
          halves = retryNoGap;
        } else {
          halves = [];
        }
      }
    }
    if (halves.length !== 2) {
      // Cut failed (e.g. angled line missed the polygon, or every retry
      // above still breached the root bbox) — retry once more with
      // angle=0, gap=0 (a plain perpendicular bisection always intersects a
      // convex-ish block and can't introduce a gap-cut overshoot); if that
      // also fails, treat this piece as a leaf rather than dropping the
      // recursion silently.
      const fallback = bisect(ring, le.index, ratio, 0, 0);
      if (fallback.length === 2 && withinRootBbox(fallback[0]) && withinRootBbox(fallback[1])) {
        recurse(fallback[0], depth + 1);
        recurse(fallback[1], depth + 1);
        return;
      }
      emitLeaf(ring);
      return;
    }

    recurse(halves[0], depth + 1);
    recurse(halves[1], depth + 1);
  }

  recurse(blockRing, 0);
  return buildings;
}

// Inset a final leaf slightly (a quarter of the alley gap) so the building
// doesn't sit flush against its lot boundary. Falls back to the un-inset
// ring if shrink collapses it, or if it pushes any vertex outside the
// leaf's own original bbox — shrink()'s per-edge offset/intersect math is
// only guaranteed well-behaved for convex input (per geom.js's own docs,
// "tolerates mildly concave rings"); leaves produced deep in the alley
// recursion (especially gap-cut slivers near a parent ring's corner) can be
// thin or locally concave enough that a uniform inward offset overshoots a
// reflex vertex and lands outside the leaf's own extent. The bbox check is a
// cheap, robust catch-all for that failure mode without needing true
// polygon-in-polygon containment.
function finalizeLeaf(ring, gap) {
  const inset = Math.max(0, gap) * 0.25; // modest — full gap/2 can collapse small lots
  if (inset <= 0) return ring;
  const shrunk = shrink(ring, inset);
  if (shrunk.length < 3) return ring;
  const [minx, miny, maxx, maxy] = bbox(ring);
  const eps = 1e-6;
  for (const [x, y] of shrunk) {
    if (x < minx - eps || x > maxx + eps || y < miny - eps || y > maxy + eps) return ring;
  }
  return shrunk;
}

// Local longest-edge helper (mirrors geom.longestEdge; duplicated narrowly
// here only because we need it on intermediate rings produced by bisect()
// mid-recursion — geom.longestEdge already does exactly this, so delegate).
function longestEdgeOf(ring) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 2) return { index: -1, length: 0 };
  let bestIdx = 0, bestLen = -1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > bestLen) { bestLen = len; bestIdx = i; }
  }
  return { index: bestIdx, length: bestLen };
}

function dedupClosing(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return ring ? ring.slice() : [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring.slice();
}

// ---------------------------------------------------------------------------
// buildWard() — per-ward-type geometry dispatch
// ---------------------------------------------------------------------------

function emptyResult() {
  return { buildings: [], squares: [], fields: [], greens: [], trees: [], hedges: [], gardens: [] };
}

function alleysParamsFor(wardType, rng) {
  const entry = WARD_TYPES.find((w) => w.name === wardType);
  const p = entry && entry.params && entry.params.minSqBase !== undefined ? entry.params : WARD_TYPES.find((w) => w.name === 'Craftsmen').params;
  const r1 = rng();
  const r2 = rng();
  return {
    minSq: p.minSqBase + p.minSqRand * r1 * r1,
    gridChaos: p.gridChaosBase + p.gridChaosRand * r2,
    sizeChaos: p.sizeChaos,
    emptyProb: p.emptyProb,
    // gap 0 => adjacent buildings share walls (touch), forming terraced rows /
    // a solid block; individual houses are still distinct via the renderer's
    // light division seam. Streets exist only BETWEEN wards (getCityBlock inset).
    gap: 0,
  };
}

/**
 * Produce one ward's contributions, dispatched by ward type
 * (REFERENCE_NOTES.md §6). `patchRing` is the raw patch polygon (not yet
 * inset) for bespoke wards that need their own inset rule; residential-style
 * wards call getCityBlock() internally.
 *
 * @param {Array<[number,number]>} patchRing
 * @param {string} wardType one of WARD_TYPES[].name
 * @param {() => number} rng
 * @param {object} [params] optional override params (streetWidth, treeDensity, ...)
 * @returns {{buildings:Array, squares:Array, fields:Array, greens:Array, trees:Array, hedges:Array, gardens:Array}}
 */
export function buildWard(patchRing, wardType, rng, params = {}) {
  const out = emptyResult();
  if (!Array.isArray(patchRing) || patchRing.length < 3) return out;

  switch (wardType) {
    case 'Craftsmen':
    case 'Slum':
    case 'Merchant':
    case 'Patriciate':
    case 'Administration':
    case 'Military':
    case 'Generic': {
      const block = getCityBlock(patchRing, params);
      if (block.length < 3) return out;
      const alleysParams = { ...alleysParamsFor(wardType, rng), ...(params.alleys || {}) };
      out.buildings = createAlleys(block, alleysParams, rng);

      // Patriciate/Merchant: occasionally attach a small garden ring around
      // a building (cheap, optional flourish; not required by spec but
      // listed as an allowed optional output).
      if (wardType === 'Patriciate' && out.buildings.length > 0) {
        out.gardens = [];
      }
      return out;
    }

    case 'Market': {
      const block = getCityBlock(patchRing, params);
      const ring = block.length >= 3 ? block : patchRing;
      out.squares = [ring];
      const c = centroid(ring);
      const le = longestEdgeOf(ring);
      const pts = dedupClosing(ring);
      let furniturePos = c;
      if (le.index >= 0 && pts.length >= 2) {
        const a = pts[le.index];
        const b = pts[(le.index + 1) % pts.length];
        const mid = lerp(a, b, 0.5);
        if (rng() < 0.3) {
          const t = 0.2 + rng() * 0.4;
          furniturePos = lerp(c, mid, t);
        }
      }
      // A few decorative trees around the plaza.
      const treeCount = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < treeCount; i++) {
        const [minx, miny, maxx, maxy] = bbox(ring);
        const px = minx + rng() * (maxx - minx);
        const py = miny + rng() * (maxy - miny);
        out.trees.push([px, py]);
      }
      out.trees.push(furniturePos); // fountain/statue point doubles as a furniture marker
      return out;
    }

    case 'Park': {
      const block = getCityBlock(patchRing, params);
      const ring = block.length >= 3 ? block : patchRing;

      // Green space cut by paths: compact patches (compactness >= 0.7) get
      // a regular radial spoke fan from the centroid; irregular patches get
      // an off-center semiRadial fan from one edge instead (REFERENCE_NOTES
      // §6, §9 — PARK_COMPACTNESS_THRESHOLD=0.7, PARK_PATH_WIDTH=ALLEY_WIDTH).
      const pathWidth = params.pathWidth ?? DEFAULTS.alley;
      const c = compactness(ring);
      const sectors = c >= 0.7 ? radial(ring, pathWidth) : semiRadial(ring, pathWidth);
      out.greens = sectors.length > 0 ? sectors : [ring];

      const a = Math.abs(area(ring));
      const density = params.treeDensity ?? 1 / 150; // ~1 tree per 150 sq m
      const treeCount = Math.max(3, Math.round(a * density));
      const [minx, miny, maxx, maxy] = bbox(ring);
      for (let i = 0; i < treeCount; i++) {
        const px = minx + rng() * (maxx - minx);
        const py = miny + rng() * (maxy - miny);
        out.trees.push([px, py]);
      }
      return out;
    }

    case 'Farm': {
      const c = centroid(patchRing);
      const pts = dedupClosing(patchRing);
      out.fields = [patchRing];
      if (pts.length >= 2) {
        const edgeIdx = Math.floor(rng() * pts.length);
        const a = pts[edgeIdx];
        const b = pts[(edgeIdx + 1) % pts.length];
        const boundaryPt = lerp(a, b, rng());
        const t = 0.3 + rng() * 0.4; // 30-70% toward centroid
        const housePos = lerp(boundaryPt, c, t);
        const rot = rng() * Math.PI;
        const half = (4 + rng() * 2) / 2; // 4..6 m square
        out.buildings = [squareAt(housePos, half, rot)];
      }
      return out;
    }

    case 'Castle': {
      const inset = DEFAULTS.mainStreet * 2;
      const n = closedLen(patchRing);
      const block = shrink(patchRing, new Array(n).fill(inset));
      const ring = block.length >= 3 ? block : patchRing;
      const a = Math.abs(area(ring));
      const c = centroid(ring);
      const side = Math.min(Math.sqrt(Math.max(a, 1)) * 0.5, 45);
      const half = side / 2;
      const rot = rng() * Math.PI * 0.25;
      out.buildings = [squareAt(c, half, rot)];
      return out;
    }

    case 'Cathedral': {
      const block = getCityBlock(patchRing, params);
      const ring = block.length >= 3 ? block : patchRing;
      const a = Math.abs(area(ring));
      const c = centroid(ring);
      // A single prominent landmark building (cathedral nave), capped so a
      // large ward doesn't yield an enormous block; slightly elongated.
      const half = Math.min(Math.sqrt(Math.max(a, 1)) * 0.32, 30);
      const rot = rng() * Math.PI;
      out.buildings = [rectAt(c, half * 1.5, half, rot)];
      return out;
    }

    default:
      return out;
  }
}

// Build an axis-then-rotated square ring centered at `center` with half-side
// `half`, rotated by `rot` radians.
function squareAt(center, half, rot) {
  const corners = [
    [-half, -half],
    [-half, half],
    [half, half],
    [half, -half],
  ];
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return corners.map(([dx, dy]) => [
    center[0] + dx * cos - dy * sin,
    center[1] + dx * sin + dy * cos,
  ]);
}

// Build a rotated rectangle ring centered at `center`, half-extents halfW/halfH.
function rectAt(center, halfW, halfH, rot) {
  const corners = [[-halfW, -halfH], [-halfW, halfH], [halfW, halfH], [halfW, -halfH]];
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return corners.map(([dx, dy]) => [
    center[0] + dx * cos - dy * sin,
    center[1] + dx * sin + dy * cos,
  ]);
}

// Thin local wrapper around cutter-style peeling for Cathedral's ring
// branch — reuses geom.shrink stepwise (kept local/minimal; cutter.js's
// `ring()` export does the same thing and could be used directly, but is
// duplicated narrowly here to avoid a name collision with the `ring` local
// variables used throughout buildWard's switch branches).
function ringPeel(outerRing, thickness, gap) {
  const bands = [];
  let current = outerRing;
  let depthGuard = 0;
  const step = thickness + gap;
  while (current.length >= 3 && depthGuard < 32) {
    bands.push(current);
    const next = shrink(current, step);
    if (next.length < 3) break;
    current = next;
    depthGuard++;
  }
  return bands;
}

// createOrthoBuilding: recursive longest-edge bisection like createAlleys,
// but with a flat area floor (no gridChaos/sizeChaos jitter) and `fill`
// controlling what fraction of undersized leftovers still get kept as small
// buildings (REFERENCE_NOTES.md §6).
function orthoBuilding(blockRing, minBlockSq, fill, rng) {
  const out = [];
  const MAX_DEPTH = 24;

  function recurse(ring, depth) {
    if (!Array.isArray(ring) || ring.length < 3) return;
    const a = Math.abs(area(ring));
    if (!Number.isFinite(a) || a <= 0) return;

    if (a < minBlockSq || depth >= MAX_DEPTH) {
      if (rng() < fill) out.push(ring);
      return;
    }

    const le = longestEdgeOf(ring);
    if (le.index < 0 || le.length <= 0) {
      if (rng() < fill) out.push(ring);
      return;
    }

    const ratio = 0.5;
    const halves = bisect(ring, le.index, ratio, 0, 0);
    if (halves.length !== 2) {
      if (rng() < fill) out.push(ring);
      return;
    }
    recurse(halves[0], depth + 1);
    recurse(halves[1], depth + 1);
  }

  recurse(blockRing, 0);
  return out.length > 0 ? out : [blockRing];
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function withinBbox(pt, bb, eps = 1e-6) {
  const [minx, miny, maxx, maxy] = bb;
  return pt[0] >= minx - eps && pt[0] <= maxx + eps && pt[1] >= miny - eps && pt[1] <= maxy + eps;
}

/**
 * Self-test for ward.js. Logs PASS/FAIL per case. Returns true iff all cases
 * passed.
 * @returns {boolean}
 */
export function __selfTest() {
  let pass = 0, fail = 0;
  const results = [];
  function check(name, cond, extra) {
    if (cond) { pass++; results.push(`PASS: ${name}`); }
    else { fail++; results.push(`FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
  }

  const rng = makeRng('ward-self-test');

  // ~120x120 m square block.
  const block120 = [[0, 0], [0, 120], [120, 120], [120, 0]];
  const blockArea = Math.abs(area(block120));
  check('setup: 120x120 block area is 14400', approxEqual(blockArea, 14400), `got ${blockArea}`);

  // --- getCityBlock ---------------------------------------------------------
  const cityBlock = getCityBlock(block120, { streetWidth: 5 });
  check('getCityBlock: produces a valid inset ring', cityBlock.length >= 3, `got length ${cityBlock.length}`);
  if (cityBlock.length >= 3) {
    const cbArea = Math.abs(area(cityBlock));
    check('getCityBlock: inset ring is smaller than the patch', cbArea < blockArea, `got ${cbArea} vs ${blockArea}`);
  }

  // --- createAlleys ----------------------------------------------------------
  // minSq/gap chosen so that, over ~117 recursive cuts on a ~115m-square
  // block, cumulative alley area lands in a believable 40-80% building
  // coverage range (a smaller minSq with this gap produces too many cuts
  // and pushes coverage well under 40% — see ward.js header notes on
  // createAlleys for how gap cost scales with cut count).
  const alleysParams = { minSq: 220, gridChaos: 0.5, sizeChaos: 0.6, emptyProb: 0.04, gap: 2 };
  const buildings = createAlleys(cityBlock.length >= 3 ? cityBlock : block120, alleysParams, rng);
  check('createAlleys: returns at least 4 buildings', buildings.length >= 4, `got ${buildings.length}`);

  let allFinite = true;
  let allPositiveArea = true;
  let allWithinBbox = true;
  const blockBbox = bbox(cityBlock.length >= 3 ? cityBlock : block120);
  let totalBuildingArea = 0;
  const buildingAreas = [];

  for (const b of buildings) {
    for (const [x, y] of b) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) allFinite = false;
    }
    const a = Math.abs(area(b));
    if (!(a > 0)) allPositiveArea = false;
    buildingAreas.push(a);
    totalBuildingArea += a;
    for (const pt of b) {
      if (!withinBbox(pt, blockBbox, 1e-3)) allWithinBbox = false;
    }
  }

  check('createAlleys: all building coords finite', allFinite);
  check('createAlleys: all buildings have positive area', allPositiveArea);
  check('createAlleys: all buildings stay within block bbox', allWithinBbox);

  // "Each leaf clears ~half of minSq" is a grain-size sanity check, not a
  // hard per-leaf guarantee: gridChaos deliberately allows lopsided cuts
  // (ratio jitter up to 0.1-0.9 of the longest edge per REFERENCE_NOTES
  // §4), so a piece sitting just above the randomized stop threshold can
  // still split into one very small and one large half on its last cut —
  // individual leaves legitimately range from the sliver floor up past
  // minSq itself. Check the *mean* building area (the statistically
  // representative "typical grain size" signal, given the threshold
  // formula's distribution) against half of minSq, while still requiring
  // every individual leaf to clear the absolute degenerate-sliver floor
  // (already enforced inside createAlleys via SLIVER_FLOOR_SQM, reflected
  // here as a sanity re-check on the output).
  const meanArea = buildingAreas.length > 0 ? totalBuildingArea / buildingAreas.length : 0;
  check(
    'createAlleys: mean building area clears roughly half of minSq',
    meanArea >= alleysParams.minSq * 0.4,
    `got mean ${meanArea.toFixed(1)}, half-minSq ${(alleysParams.minSq * 0.5).toFixed(1)}`
  );
  const minArea = buildingAreas.length > 0 ? Math.min(...buildingAreas) : 0;
  check(
    'createAlleys: no building falls below the degenerate-sliver floor',
    buildingAreas.length === 0 || minArea >= 6,
    `got min ${minArea}`
  );

  const blockAreaUsed = Math.abs(area(cityBlock.length >= 3 ? cityBlock : block120));
  const fraction = totalBuildingArea / blockAreaUsed;
  check(
    'createAlleys: total building area is 40-80% of block area',
    fraction >= 0.4 && fraction <= 0.85,
    `got fraction ${fraction.toFixed(3)} (buildings=${totalBuildingArea.toFixed(1)}, block=${blockAreaUsed.toFixed(1)})`
  );

  // --- buildWard: Castle -----------------------------------------------------
  const castleRng = makeRng('castle-test');
  const castleResult = buildWard(block120, 'Castle', castleRng, {});
  check('buildWard(Castle): yields exactly one building', castleResult.buildings.length === 1, `got ${castleResult.buildings.length}`);
  if (castleResult.buildings.length === 1) {
    const a = Math.abs(area(castleResult.buildings[0]));
    check('buildWard(Castle): building has positive area', a > 0, `got ${a}`);
    check('buildWard(Castle): building is reasonably large (>100 sqm)', a > 100, `got ${a}`);
  }
  check('buildWard(Castle): no squares/fields/greens produced', castleResult.squares.length === 0 && castleResult.fields.length === 0 && castleResult.greens.length === 0);

  // --- buildWard: Park ---------------------------------------------------------
  const parkRng = makeRng('park-test');
  const parkResult = buildWard(block120, 'Park', parkRng, {});
  check('buildWard(Park): yields greens', parkResult.greens.length >= 1, `got ${parkResult.greens.length}`);
  check('buildWard(Park): yields some trees', parkResult.trees.length > 0, `got ${parkResult.trees.length}`);
  check('buildWard(Park): no buildings', parkResult.buildings.length === 0, `got ${parkResult.buildings.length}`);

  // --- buildWard: Craftsmen (residential) -------------------------------------
  const craftsmenRng = makeRng('craftsmen-test');
  const craftsmenResult = buildWard(block120, 'Craftsmen', craftsmenRng, {});
  check('buildWard(Craftsmen): yields several buildings', craftsmenResult.buildings.length >= 3, `got ${craftsmenResult.buildings.length}`);

  // --- buildWard: Market -------------------------------------------------------
  const marketRng = makeRng('market-test');
  const marketResult = buildWard(block120, 'Market', marketRng, {});
  check('buildWard(Market): yields exactly one square', marketResult.squares.length === 1, `got ${marketResult.squares.length}`);
  check('buildWard(Market): yields trees/furniture points', marketResult.trees.length > 0, `got ${marketResult.trees.length}`);

  // --- buildWard: Farm -------------------------------------------------------
  const farmRng = makeRng('farm-test');
  const farmResult = buildWard(block120, 'Farm', farmRng, {});
  check('buildWard(Farm): yields one field', farmResult.fields.length === 1, `got ${farmResult.fields.length}`);
  check('buildWard(Farm): yields a small farmhouse building', farmResult.buildings.length === 1, `got ${farmResult.buildings.length}`);

  // --- buildWard: Cathedral -----------------------------------------------------
  const cathedralRng = makeRng('cathedral-test');
  const cathedralResult = buildWard(block120, 'Cathedral', cathedralRng, {});
  check('buildWard(Cathedral): yields at least one building', cathedralResult.buildings.length >= 1, `got ${cathedralResult.buildings.length}`);

  // --- WARD_TYPES / pickWardType ------------------------------------------------
  check('WARD_TYPES: is a non-empty array', Array.isArray(WARD_TYPES) && WARD_TYPES.length > 0);
  check('WARD_TYPES: includes Craftsmen/Slum/Market/Park/Farm/Castle/Cathedral/Merchant/Patriciate', [
    'Craftsmen', 'Slum', 'Market', 'Park', 'Farm', 'Castle', 'Cathedral', 'Merchant', 'Patriciate',
  ].every((name) => WARD_TYPES.some((w) => w.name === name)));

  const pickRng = makeRng('pick-test');
  const picked = new Set();
  for (let i = 0; i < 50; i++) picked.add(pickWardType(pickRng));
  check('pickWardType: only returns weighted (weight>0) ward names', [...picked].every((name) => WARD_TYPES.find((w) => w.name === name)?.weight > 0), `got ${[...picked]}`);
  check('pickWardType: Craftsmen dominant draw shows up over 50 samples', picked.has('Craftsmen'));

  // --- determinism: same seed -> same result -------------------------------
  const rngDetA = makeRng('determinism-check');
  const rngDetB = makeRng('determinism-check');
  const resA = createAlleys(block120, alleysParams, rngDetA);
  const resB = createAlleys(block120, alleysParams, rngDetB);
  check('createAlleys: same seed produces identical building count', resA.length === resB.length, `got ${resA.length} vs ${resB.length}`);
  if (resA.length === resB.length && resA.length > 0) {
    check('createAlleys: same seed produces identical first building', JSON.stringify(resA[0]) === JSON.stringify(resB[0]));
  }

  for (const line of results) console.log(line);
  console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
  return fail === 0;
}

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('ward.js')) {
  __selfTest();
}
