// model.js — top-level orchestrator for the infinite-mode procedural town
// generator. Vanilla ES module. No dependencies, DOM-free.
//
// Ties together geom.js / voronoi.js / cutter.js / ward.js into one
// `generateTown(opts)` call returning a TownModel exactly per CONTRACTS.md
// §2. See REFERENCE_NOTES.md for the pipeline this is a pragmatic port of.
//
// Clean-room implementation — see CONTRACTS.md header for the no-GPL-source
// policy; only the public module APIs above are used here.

import { makeRng, area, centroid, bbox as bboxOf, buffer } from './geom.js';
import { generatePatches } from './voronoi.js';
import { WARD_TYPES, pickWardType, getCityBlock, buildWard } from './ward.js';

// ---------------------------------------------------------------------------
// Defaults (CONTRACTS.md §6 + REFERENCE_NOTES.md §9)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  sizeM: 1000,
  lloyd: 2,
  water: false, // a later task adds water; leave the layer empty for now
  wall: true,
  minSq: undefined, // ward.js picks per-ward defaults; not overridden here
  gap: 3, // ALLEY_WIDTH
  gridChaos: undefined,
  sizeChaos: undefined,
  emptyProb: undefined,
  treeDensity: 1 / 150,
  largeBuildingProb: 0.5,
  roadWidth: 8,
  wallThickness: 3,
  towerRadius: 5,
  riverWidth: 18,
  mainStreet: 22,
  regularStreet: 12,
  alley: 3,
  innerFrac: 0.6, // fraction of (most-central) patches forming the town core; rest = countryside
};

// Ward types that form a solid building BLOCK (the impassable mass a route must
// go around). Market = open plaza, Park = greens, Castle/Cathedral = a single
// landmark building — none of those are residential blocks.
const RESIDENTIAL_WARDS = new Set([
  'Craftsmen', 'Slum', 'Merchant', 'Patriciate', 'Administration', 'Military', 'Generic',
]);

function randomSeed(rng) {
  // Generate a random-looking string seed without touching Math.random.
  return 's' + Math.floor(rng() * 1e9).toString(36);
}

// ---------------------------------------------------------------------------
// Small geometry helpers local to the orchestrator
// ---------------------------------------------------------------------------

function dedupClosing(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return ring ? ring.slice() : [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring.slice();
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Convex hull (monotone chain). Input: array of [x,y]. Output: hull ring,
// screen-CCW per geom.js's area() convention (positive area).
function convexHull(points) {
  const pts = points
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length < 3) return pts.slice();

  // Remove exact duplicates.
  const uniq = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p);
  }
  if (uniq.length < 3) return uniq;

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper);

  // This builds the hull in the standard math (x-right, y-up) CCW sense via
  // the cross-product sign above; under geom.js's +y-down screen convention
  // that is screen-CW, which area() reports as negative. Reverse so the
  // returned ring matches geom.js's ">0 == screen-CCW" convention used
  // throughout the rest of this codebase.
  hull.reverse();
  return hull;
}

// Point-in-polygon (ray casting, even-odd rule). `ring` need not be closed
// (dedupClosing-style open rings are fine — we wrap with modulo below).
function pointInPolygon(pt, ring) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 3) return false;
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (
      yi !== yj &&
      ((y >= yi && y < yj) || (y >= yj && y < yi)) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// Distance from point p to the nearest point on segment a->b.
function pointToSegmentDist(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS_LOCAL) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Distance from point p to the nearest point on a polyline (chain of segments).
function pointToPolylineDist(p, polyline) {
  let best = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentDist(p, polyline[i], polyline[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

const EPS_LOCAL = 1e-9;

// Build a ribbon (strip) polygon of constant half-width `halfWidth` around an
// open polyline, by offsetting each side along each segment's normal and
// capping the ends with the segment's own direction (simple "sausage" outline
// — not mitred at joints, which is fine for a meandering river at this
// width/scale; small overlaps at joints don't visually matter for a filled
// blue ribbon).
function polylineRibbon(polyline, halfWidth) {
  const pts = polyline.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return [];
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    let nx = 0, ny = 0;
    if (len > EPS_LOCAL) {
      nx = -dy / len;
      ny = dx / len;
    }
    const p = pts[i];
    left.push([p[0] + nx * halfWidth, p[1] + ny * halfWidth]);
    right.push([p[0] - nx * halfWidth, p[1] - ny * halfWidth]);
  }
  // Ring: left side forward, right side backward.
  return left.concat(right.slice().reverse());
}

// Merge two bboxes.
function unionBbox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

// Compute the bbox covering every coordinate in every layer + meta fallback.
function computeBbox(layers, fallback) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  let found = false;

  function visitPt(p) {
    if (!Array.isArray(p) || p.length < 2) return;
    const [x, y] = p;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    found = true;
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }

  for (const key of Object.keys(layers)) {
    const list = layers[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!Array.isArray(item)) continue;
      // Pt (LineString point) vs Ring vs Polygon (Ring[])
      if (typeof item[0] === 'number') {
        visitPt(item); // Pt directly in a Pt[] layer (trees)
      } else if (Array.isArray(item[0]) && typeof item[0][0] === 'number') {
        // Ring (LineString) or flat Ring used as Polygon-without-wrapper
        for (const p of item) visitPt(p);
      } else if (Array.isArray(item[0]) && Array.isArray(item[0][0])) {
        // Polygon = Ring[]
        for (const ring of item) {
          for (const p of ring) visitPt(p);
        }
      }
    }
  }

  if (!found) return fallback;
  return [minx, miny, maxx, maxy];
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

function patchCentroid(ring) {
  return centroid(ring);
}

// ---------------------------------------------------------------------------
// generateTown()
// ---------------------------------------------------------------------------

/**
 * Generate one procedural TownModel (CONTRACTS.md §2).
 * @param {object} [opts]
 * @returns {object} TownModel
 */
export function generateTown(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sizeM = o.sizeM;
  const rng = makeRng(o.seed !== undefined ? o.seed : randomSeed(makeRng(Date.now())));
  const seed = o.seed !== undefined ? o.seed : o.__derivedSeed; // seed used is whatever was passed; see below

  // Resolve a concrete seed string (so meta.seed always reflects what's used).
  let usedSeed = o.seed;
  let genRng = rng;
  if (usedSeed === undefined) {
    // No seed given: derive one randomly but deterministically reproducible
    // from a single internal RNG bootstrap (acceptable since this branch is
    // explicitly the "caller didn't ask for determinism" path).
    const bootstrap = makeRng(`bootstrap-${Date.now()}-${Math.random()}`);
    usedSeed = randomSeed(bootstrap);
    genRng = makeRng(usedSeed);
  }

  const half = sizeM / 2;
  const worldBbox = [-half, -half, half, half];
  const center = [0, 0];

  const patchCount = Math.max(4, Math.round(o.patchCount ?? sizeM / 20));
  const lloyd = o.lloyd;

  // Layer accumulators -------------------------------------------------------
  const layers = {
    earth: [],
    districts: [],
    blocks: [],
    buildings: [],
    prisms: [],
    walls: [],
    squares: [],
    greens: [],
    fields: [],
    water: [],
    roads: [],
    rivers: [],
    planks: [],
    trees: [],
    towers: [],
  };

  // 1. Voronoi patches --------------------------------------------------------
  let patches = [];
  try {
    patches = generatePatches(genRng, worldBbox, patchCount, lloyd);
  } catch (e) {
    patches = [];
  }
  // Defensive: drop any non-ring junk.
  patches = patches.filter((p) => Array.isArray(p) && p.length >= 3);

  if (patches.length === 0) {
    // Nothing to build — return a minimal-but-schema-valid empty town.
    return {
      meta: {
        sizeM,
        seed: usedSeed,
        bbox: worldBbox,
        roadWidth: o.roadWidth,
        wallThickness: o.wallThickness,
        towerRadius: o.towerRadius,
        riverWidth: o.riverWidth,
        version: 'infinite-gen-1',
      },
      layers,
    };
  }

  // 2. Inner / outer split -----------------------------------------------------
  // Inner = the most-central FRACTION of patches (a consistent, compact town
  // regardless of how Lloyd relaxation placed centroids). A pure radius cut
  // gave wildly varying inner counts — sometimes just 3 giant wards that
  // sprawled to the map corners and subdivided into sliver noise. A fixed
  // fraction keeps wards small and the town clustered in the centre.
  const patchInfo = patches.map((ring) => {
    const c = patchCentroid(ring);
    return { ring, centroid: c, d: dist(c, center) };
  });
  patchInfo.sort((a, b) => a.d - b.d);

  const innerCount = Math.max(3, Math.round(patchInfo.length * o.innerFrac));
  const innerInfo = patchInfo.slice(0, innerCount);
  const innerSet = new Set(innerInfo);
  const outerInfo = patchInfo.filter((p) => !innerSet.has(p));

  const innerPatches = innerInfo.map((p) => p.ring);
  const outerPatches = outerInfo.map((p) => p.ring);

  // 3. earth layer: hull of inner patch vertices (+ a touch of outer patches
  //    immediately around it, so the base isn't a hard knife-edge at the
  //    inner/outer boundary), buffered out slightly. -----------------------
  const innerVerts = [];
  for (const ring of innerPatches) for (const p of dedupClosing(ring)) innerVerts.push(p);
  let earthHull = convexHull(innerVerts);
  if (earthHull.length >= 3) {
    const buffered = buffer(earthHull, Math.max(5, o.gap));
    if (buffered.length >= 3) earthHull = buffered;
    layers.earth.push([earthHull]);
  }

  // Outer patches contribute a broader "earth" footprint too (countryside
  // ground), via their own hull unioned in as a second polygon entry — kept
  // simple (no boolean union) since earth is purely a base-fill visual and
  // multiple overlapping polygons render fine.
  if (outerPatches.length > 0) {
    const outerVerts = [];
    for (const ring of outerPatches) for (const p of dedupClosing(ring)) outerVerts.push(p);
    const outerHull = convexHull(outerVerts);
    if (outerHull.length >= 3) layers.earth.push([outerHull]);
  }

  // 4. Curtain wall (optional) --------------------------------------------------
  const wallOn = typeof o.wall === 'number' ? genRng() < o.wall : !!o.wall;
  let wallRing = null;
  if (wallOn && innerVerts.length >= 3) {
    const hullForWall = convexHull(innerVerts);
    if (hullForWall.length >= 3) {
      // Smooth/round small towns more (REFERENCE_NOTES §2): factor
      // min(1, 40/numPatches). Approximate via a light buffer outward by a
      // few metres (keeps the wall hugging the inner core without touching
      // building footprints) instead of true corner-smoothing.
      const smoothed = buffer(hullForWall, Math.max(2, o.wallThickness));
      wallRing = smoothed.length >= 3 ? smoothed : hullForWall;

      // Gates: cut 1-3 small gaps into the wall ring by simply *not* adding
      // a continuous polygon — we approximate gates by splitting the ring
      // into 1-3 separate open arcs (LineString-shaped gaps) is overkill for
      // Phase 1's "single wall ring polygon is acceptable" allowance
      // (REFERENCE_NOTES.md / CONTRACTS task brief). We keep the wall as one
      // ring polygon (acceptable per task brief) but still record gate
      // points for road routing below.
      layers.walls.push([wallRing]);
    }
  }

  // Gate points: pick 1-3 wall-ring vertices spread around the perimeter to
  // anchor streets toward (used whether or not a physical gate gap is cut).
  const gateCount = wallRing ? 1 + Math.floor(genRng() * 3) : 0; // 1..3
  const gatePoints = [];
  if (wallRing && wallRing.length >= 3) {
    const ringPts = dedupClosing(wallRing);
    const n = ringPts.length;
    const used = new Set();
    for (let i = 0; i < gateCount; i++) {
      let idx = Math.floor(genRng() * n);
      let guard = 0;
      while (used.has(idx) && guard < n) {
        idx = (idx + 1) % n;
        guard++;
      }
      used.add(idx);
      gatePoints.push(ringPts[idx]);
    }
  }

  // Wall towers: a black bastion at a subset of wall-ring vertices (an iconic
  // Watabou touch). Stored as points, rendered as filled circles of
  // meta.towerRadius.
  if (wallRing && wallRing.length >= 3) {
    const ringPts = dedupClosing(wallRing);
    const step = Math.max(1, Math.round(ringPts.length / 12)); // up to ~12 towers
    for (let i = 0; i < ringPts.length; i += step) {
      layers.towers.push(ringPts[i]);
    }
  }

  // 5. Ward assignment ----------------------------------------------------------
  // Find the most-central inner patch -> Market. A second, reasonably large
  // and central patch (if available) -> Castle or Cathedral.
  const sortedByCentrality = [...innerInfo].sort((a, b) => a.d - b.d);
  const marketInfo = sortedByCentrality[0];
  const castleCandidates = sortedByCentrality.slice(1, 4);
  let castleInfo = null;
  if (castleCandidates.length > 0) {
    castleInfo = castleCandidates[Math.floor(genRng() * castleCandidates.length)];
  }
  const useCathedralInsteadOfCastle = genRng() < 0.5;

  const wardAssignment = new Map(); // patchInfo entry -> ward type name

  for (const info of innerInfo) {
    if (info === marketInfo) {
      wardAssignment.set(info, 'Market');
    } else if (castleInfo && info === castleInfo) {
      wardAssignment.set(info, useCathedralInsteadOfCastle ? 'Cathedral' : 'Castle');
    }
  }

  for (const info of innerInfo) {
    if (wardAssignment.has(info)) continue;
    wardAssignment.set(info, pickWardType(genRng));
  }

  // 6. Streets (roads layer) -----------------------------------------------------
  // A modest set of main streets: from each gate point toward the market
  // patch centroid, plus 1-2 cross streets linking the market to the next
  // most central wards. Keep the count small (like starhill's ~4).
  const marketCentroid = marketInfo ? marketInfo.centroid : center;
  for (const gate of gatePoints) {
    layers.roads.push([gate, marketCentroid]);
  }
  // (Cross streets from market to other patch centroids were removed — drawn as
  // straight centroid-to-centroid lines they cut diagonally across building
  // blocks. Inter-ward gaps from getCityBlock already read as the street grid.)

  // 7. Per-patch ward geometry -----------------------------------------------------
  const edgeStreetWidthFor = (count) => (count <= 6 ? o.regularStreet : o.mainStreet);

  for (const info of innerInfo) {
    const ring = info.ring;
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const a = Math.abs(area(ring));
    if (!Number.isFinite(a) || a <= 0) continue;

    layers.districts.push([dedupClosing(ring)]);

    const wardType = wardAssignment.get(info) || 'Generic';
    const streetWidth = wardType === 'Market' || wardType === 'Castle' || wardType === 'Cathedral'
      ? o.mainStreet
      : o.regularStreet;

    // Solid BLOCK obstacle for residential wards: the inset city-block outline
    // is the impassable mass the route goes AROUND. Individual buildings are
    // drawn on top for detail only — they are NOT separate obstacles, so a
    // runner can't thread between every house (which would defeat the route
    // choice). Streets are the gaps between blocks.
    if (RESIDENTIAL_WARDS.has(wardType)) {
      const blockRing = getCityBlock(ring, { streetWidth });
      if (Array.isArray(blockRing) && blockRing.length >= 3) {
        layers.blocks.push([dedupClosing(blockRing)]);
      }
    }

    let result;
    try {
      result = buildWard(ring, wardType, genRng, { streetWidth });
    } catch (e) {
      result = null;
    }
    if (!result) continue;

    mergeWardResult(layers, result, wardType, o);
  }

  // 8. Outer patches -> fields/greens, sparse buildings -----------------------
  for (const info of outerInfo) {
    const ring = info.ring;
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const a = Math.abs(area(ring));
    if (!Number.isFinite(a) || a <= 0) continue;

    // 20% Farm (open field + a single small farmhouse), else plain open
    // countryside (field only — NO building scatter; a speckle of houses all
    // over the rural fringe is the main thing that broke realism before).
    const makeFarm = genRng() < 0.2;
    if (makeFarm) {
      let result = null;
      try {
        result = buildWard(ring, 'Farm', genRng, { streetWidth: o.alley });
      } catch (e) {
        result = null;
      }
      if (result) {
        layers.fields.push(...result.fields.map((r) => [dedupClosing(r)]));
        layers.buildings.push(...result.buildings.map((r) => [dedupClosing(r)]));
      } else {
        layers.fields.push([dedupClosing(ring)]);
      }
    } else {
      layers.fields.push([dedupClosing(ring)]);
    }
  }

  // 9. Trees: scatter a few extra into greens/fields per treeDensity --------
  // (buildWard already adds some trees for Park/Market; this just respects
  // opts.treeDensity as a global multiplier by doing nothing extra when 0.)
  if (o.treeDensity <= 0) {
    layers.trees = [];
  }

  // 10. prisms: promote dominant large building(s) (castle/cathedral) ----------
  // Already pushed directly during ward merge below when wardType is Castle
  // or Cathedral (see mergeWardResult). Nothing further needed here.

  // 11. Water: rivers, ponds, planks (CONTRACTS.md §2; REFERENCE_NOTES.md §8) ---
  // Resolve the water option: boolean -> on/off, number -> probability,
  // default off (matches DEFAULTS.water = false).
  const waterRoll = genRng();
  const waterOn = typeof o.water === 'number' ? waterRoll < o.water : !!o.water;

  if (waterOn) {
    const riverWidth = o.riverWidth;
    const halfRiver = riverWidth / 2;

    // 60% chance of a river crossing the whole town, else (or additionally,
    // 25% of the time) a standalone pond blob. This keeps "water:true" towns
    // visually varied rather than always drawing the same river shape.
    const wantsRiver = genRng() < 0.6;
    const wantsPond = !wantsRiver || genRng() < 0.25;

    let riverPolyline = null;

    if (wantsRiver) {
      // Pick two opposite-ish edges of the world bbox to enter/exit from, so
      // the river crosses the whole modeled area (REFERENCE_NOTES §8).
      const edgeNames = ['N', 'S', 'E', 'W'];
      const entryEdge = edgeNames[Math.floor(genRng() * 4)];
      const oppositeOf = { N: 'S', S: 'N', E: 'W', W: 'E' };
      // Exit edge: usually the opposite edge (crosses the whole town), but
      // occasionally an adjacent edge for variety (river bends out a side).
      const exitEdge = genRng() < 0.75
        ? oppositeOf[entryEdge]
        : edgeNames.filter((e) => e !== entryEdge && e !== oppositeOf[entryEdge])[Math.floor(genRng() * 2)];

      const edgePoint = (edge, t) => {
        // t in [0,1] parametrizes position along that edge.
        switch (edge) {
          case 'N': return [-half + t * sizeM, -half];
          case 'S': return [-half + t * sizeM, half];
          case 'E': return [half, -half + t * sizeM];
          case 'W': return [-half, -half + t * sizeM];
          default: return [0, 0];
        }
      };

      const entryT = 0.25 + genRng() * 0.5; // avoid corners
      const exitT = 0.25 + genRng() * 0.5;
      const entryPt = edgePoint(entryEdge, entryT);
      const exitPt = edgePoint(exitEdge, exitT);

      // Build a gentle meander: a handful of control points between entry and
      // exit, each nudged laterally (perpendicular to the entry->exit chord)
      // by the rng so the river isn't a straight line, then connected with
      // straight segments (sufficient at this scale/zoom for a "continuous
      // water" read — no need for spline smoothing).
      const chordDx = exitPt[0] - entryPt[0];
      const chordDy = exitPt[1] - entryPt[1];
      const chordLen = Math.hypot(chordDx, chordDy) || 1;
      const perpX = -chordDy / chordLen;
      const perpY = chordDx / chordLen;

      const controlCount = 3 + Math.floor(genRng() * 3); // 3..5 interior points
      const maxLateral = sizeM * 0.12; // gentle meander, not chaotic zigzag
      riverPolyline = [entryPt];
      for (let i = 1; i <= controlCount; i++) {
        const t = i / (controlCount + 1);
        const baseX = entryPt[0] + chordDx * t;
        const baseY = entryPt[1] + chordDy * t;
        const lateral = (genRng() * 2 - 1) * maxLateral;
        riverPolyline.push([baseX + perpX * lateral, baseY + perpY * lateral]);
      }
      riverPolyline.push(exitPt);

      layers.rivers.push(riverPolyline);

      // Carve the river's footprint as a buffered ribbon strip -> water layer,
      // so it renders as a continuous blue body (CONTRACTS.md §2/§4).
      const ribbon = polylineRibbon(riverPolyline, halfRiver);
      if (ribbon.length >= 3) {
        layers.water.push([ribbon]);
      }

      // Planks: 1-3 short crossings near the town centre, perpendicular to
      // the river's local direction at the crossing point, length ≈
      // riverWidth (REFERENCE_NOTES §8/§9: plankLength ≈ riverWidth + 0-2 m).
      const plankCount = 1 + Math.floor(genRng() * 3); // 1..3
      const plankMargin = genRng() * 2; // 0-2 m
      const plankHalfLen = (riverWidth + plankMargin) / 2;

      // Sample candidate crossing points along the polyline segments nearest
      // the town centre first (so planks cluster near where roads/the market
      // are, per the task brief), then spread out if more are needed.
      const segMidpoints = [];
      for (let i = 0; i < riverPolyline.length - 1; i++) {
        const a = riverPolyline[i];
        const b = riverPolyline[i + 1];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        segMidpoints.push({ a, b, mid, d: dist(mid, center) });
      }
      segMidpoints.sort((s1, s2) => s1.d - s2.d);

      const usedSegs = new Set();
      for (let i = 0; i < plankCount && i < segMidpoints.length; i++) {
        // Spread planks across distinct segments where possible; fall back to
        // reusing segments (offset along it) once distinct ones run out.
        let segIdx = i;
        if (segIdx >= segMidpoints.length) segIdx = segMidpoints.length - 1;
        const seg = segMidpoints[segIdx];
        usedSegs.add(segIdx);

        const dx = seg.b[0] - seg.a[0];
        const dy = seg.b[1] - seg.a[1];
        const segLen = Math.hypot(dx, dy);
        if (segLen < EPS_LOCAL) continue;
        const dirX = dx / segLen;
        const dirY = dy / segLen;
        // Perpendicular to the river's local direction.
        const perpX2 = -dirY;
        const perpY2 = dirX;

        // Jitter the crossing point a little along the segment so multiple
        // planks on the same segment don't perfectly overlap.
        const along = 0.3 + genRng() * 0.4;
        const crossX = seg.a[0] + dx * along;
        const crossY = seg.a[1] + dy * along;

        const plankLine = [
          [crossX - perpX2 * plankHalfLen, crossY - perpY2 * plankHalfLen],
          [crossX + perpX2 * plankHalfLen, crossY + perpY2 * plankHalfLen],
        ];
        layers.planks.push(plankLine);
      }
    }

    if (wantsPond) {
      // Standalone blob pond: a jittered circle placed away from the town
      // centre (favour outer/countryside-ish placement per REFERENCE_NOTES
      // §8), radius per §9 suggested range (15-60 m), clamped to fit sizeM.
      const minR = Math.max(8, Math.min(15, sizeM * 0.03));
      const maxR = Math.max(minR + 5, Math.min(60, sizeM * 0.08));
      const pondR = minR + genRng() * (maxR - minR);

      // Place within the inner play area but not dead-centre (avoid the
      // market/castle core); pick a random angle + radius offset from centre.
      const placeAngle = genRng() * Math.PI * 2;
      const placeDist = (sizeM * 0.15) + genRng() * (sizeM * 0.25);
      const pondCenter = [Math.cos(placeAngle) * placeDist, Math.sin(placeAngle) * placeDist];

      const pondVerts = 9 + Math.floor(genRng() * 5); // 9..13 verts
      const pondRing = [];
      for (let i = 0; i < pondVerts; i++) {
        const a = (i / pondVerts) * Math.PI * 2;
        const jitter = 0.8 + genRng() * 0.4; // +-20% radius jitter per vertex
        pondRing.push([
          pondCenter[0] + Math.cos(a) * pondR * jitter,
          pondCenter[1] + Math.sin(a) * pondR * jitter,
        ]);
      }
      layers.water.push([pondRing]);
    }

    // Carve space for water: drop buildings/prisms/trees that fall in water
    // or within ~riverWidth/2 of the river polyline (REFERENCE_NOTES §8 —
    // "leave a bank margin"). Sample-checked by the self-test below.
    const waterPolys = layers.water; // Polygon[] = Ring[][], single-ring here
    const inWater = (pt) => {
      for (const poly of waterPolys) {
        const outer = poly[0];
        if (outer && pointInPolygon(pt, outer)) return true;
      }
      if (riverPolyline && pointToPolylineDist(pt, riverPolyline) <= halfRiver) return true;
      return false;
    };

    const filterByCentroid = (polyList) => polyList.filter((poly) => {
      const outer = poly[0];
      if (!outer || outer.length < 3) return true;
      const c = centroid(outer);
      return !inWater(c);
    });

    layers.buildings = filterByCentroid(layers.buildings);
    layers.prisms = filterByCentroid(layers.prisms);
    layers.trees = layers.trees.filter((pt) => !inWater(pt));
  }

  // Assemble meta --------------------------------------------------------------
  const fallbackBbox = worldBbox;
  const finalBbox = computeBbox(layers, fallbackBbox);

  return {
    meta: {
      sizeM,
      seed: usedSeed,
      bbox: finalBbox,
      roadWidth: o.roadWidth,
      wallThickness: o.wallThickness,
      towerRadius: o.towerRadius,
      riverWidth: o.riverWidth,
      version: 'infinite-gen-1',
    },
    layers,
  };
}

// Merge one buildWard() result into the TownModel's accumulator layers,
// wrapping each Ring as a single-ring Polygon ([ring]) per CONTRACTS.md §2.
// Castle/Cathedral's single dominant building is additionally promoted into
// `prisms` (kept in `buildings` too is unnecessary — prisms IS the landmark
// layer, "treat as building" per CONTRACTS.md §2 comment) so it renders as
// the one standout structure.
function mergeWardResult(layers, result, wardType, o) {
  const toPoly = (ring) => [dedupClosing(ring)];

  if (wardType === 'Castle' || wardType === 'Cathedral') {
    for (const b of result.buildings || []) {
      layers.prisms.push(toPoly(b));
    }
  } else {
    for (const b of result.buildings || []) {
      layers.buildings.push(toPoly(b));
    }
  }

  for (const s of result.squares || []) layers.squares.push(toPoly(s));
  for (const f of result.fields || []) layers.fields.push(toPoly(f));
  for (const g of result.greens || []) layers.greens.push(toPoly(g));
  for (const t of result.trees || []) {
    if (Array.isArray(t) && t.length === 2 && typeof t[0] === 'number') {
      layers.trees.push(t);
    }
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function isFiniteRing(ring) {
  if (!Array.isArray(ring)) return false;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) return false;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
  }
  return true;
}

function allCoordsFinite(layers) {
  for (const key of Object.keys(layers)) {
    const list = layers[key];
    if (!Array.isArray(list)) return false;
    for (const item of list) {
      if (!Array.isArray(item)) return false;
      if (item.length === 2 && typeof item[0] === 'number') {
        // Pt (trees)
        if (!Number.isFinite(item[0]) || !Number.isFinite(item[1])) return false;
        continue;
      }
      if (typeof item[0] === 'number') {
        // shouldn't happen outside trees, but guard anyway
        if (!item.every((v) => Number.isFinite(v))) return false;
        continue;
      }
      if (Array.isArray(item[0]) && typeof item[0][0] === 'number') {
        // LineString (roads/rivers/planks)
        if (!isFiniteRing(item)) return false;
        continue;
      }
      if (Array.isArray(item[0]) && Array.isArray(item[0][0])) {
        // Polygon = Ring[]
        for (const ring of item) {
          if (!isFiniteRing(ring)) return false;
        }
        continue;
      }
    }
  }
  return true;
}

const REQUIRED_LAYER_KEYS = [
  'earth', 'districts', 'blocks', 'buildings', 'prisms', 'walls', 'squares',
  'greens', 'fields', 'water', 'roads', 'rivers', 'planks', 'trees', 'towers',
];

/**
 * Self-test for model.js. Logs PASS/FAIL per case plus a summary and the
 * sizeM=1000 generation time. Returns true iff every case passed.
 * @returns {boolean}
 */
export function __selfTest() {
  let pass = 0, fail = 0;
  const results = [];
  function check(name, cond, extra) {
    if (cond) { pass++; results.push(`PASS: ${name}`); }
    else { fail++; results.push(`FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
  }

  const t0 = Date.now();
  const town = generateTown({ seed: 'test-1', sizeM: 1000 });
  const elapsedMs = Date.now() - t0;

  // --- schema shape ---------------------------------------------------------
  check('generateTown: returns an object with meta + layers', town && typeof town === 'object' && town.meta && town.layers);

  for (const key of REQUIRED_LAYER_KEYS) {
    check(`layers.${key} exists and is an array`, Array.isArray(town.layers?.[key]), `got ${typeof town.layers?.[key]}`);
  }

  // --- meta.bbox finite -------------------------------------------------------
  const bb = town.meta?.bbox;
  check(
    'meta.bbox is a finite 4-tuple',
    Array.isArray(bb) && bb.length === 4 && bb.every((v) => Number.isFinite(v)),
    `got ${JSON.stringify(bb)}`
  );

  // --- meta fields present -----------------------------------------------------
  check('meta.sizeM === 1000', town.meta?.sizeM === 1000, `got ${town.meta?.sizeM}`);
  check('meta.seed === "test-1"', town.meta?.seed === 'test-1', `got ${town.meta?.seed}`);
  check('meta.version is set', typeof town.meta?.version === 'string' && town.meta.version.length > 0);
  check('meta.roadWidth/wallThickness/towerRadius/riverWidth are numbers', [
    town.meta?.roadWidth, town.meta?.wallThickness, town.meta?.towerRadius, town.meta?.riverWidth,
  ].every((v) => typeof v === 'number' && Number.isFinite(v)));

  // --- buildings count --------------------------------------------------------
  const buildingCount = town.layers?.buildings?.length ?? 0;
  check('buildings.length >= 20', buildingCount >= 20, `got ${buildingCount}`);

  // --- no NaN/Infinity anywhere ------------------------------------------------
  check('all layer coordinates are finite (no NaN/Infinity)', allCoordsFinite(town.layers));

  // --- determinism: same seed -> identical output -----------------------------
  const townAgain = generateTown({ seed: 'test-1', sizeM: 1000 });
  check(
    'determinism: same seed produces identical buildings.length',
    townAgain.layers.buildings.length === town.layers.buildings.length,
    `got ${townAgain.layers.buildings.length} vs ${town.layers.buildings.length}`
  );
  check(
    'determinism: same seed produces identical first building ring',
    JSON.stringify(townAgain.layers.buildings[0]) === JSON.stringify(town.layers.buildings[0])
  );
  check(
    'determinism: same seed produces fully identical buildings array',
    JSON.stringify(townAgain.layers.buildings) === JSON.stringify(town.layers.buildings)
  );

  // --- different seed -> different output --------------------------------------
  const townOther = generateTown({ seed: 'test-2', sizeM: 1000 });
  check(
    'different seed produces different output',
    JSON.stringify(townOther.layers.buildings) !== JSON.stringify(town.layers.buildings)
    || townOther.layers.buildings.length !== town.layers.buildings.length
  );

  // --- robustness: tiny / unusual opts don't throw ------------------------------
  try {
    const tiny = generateTown({ seed: 'tiny-1', sizeM: 100, patchCount: 4 });
    check('tiny town (sizeM=100) does not throw and has valid schema', REQUIRED_LAYER_KEYS.every((k) => Array.isArray(tiny.layers[k])));
  } catch (e) {
    check('tiny town (sizeM=100) does not throw and has valid schema', false, e.message);
  }

  try {
    const noWall = generateTown({ seed: 'nowall-1', sizeM: 800, wall: false });
    check('wall:false produces an empty walls layer', noWall.layers.walls.length === 0, `got ${noWall.layers.walls.length}`);
  } catch (e) {
    check('wall:false produces an empty walls layer', false, e.message);
  }

  // --- water: rivers/ponds/planks (additive — does not touch the checks above) --
  let waterTown = null;
  let waterElapsedMs = null;
  try {
    const tw0 = Date.now();
    waterTown = generateTown({ seed: 'water-1', sizeM: 1000, water: true });
    waterElapsedMs = Date.now() - tw0;
    check('water:true town does not throw and has valid schema', REQUIRED_LAYER_KEYS.every((k) => Array.isArray(waterTown.layers[k])));
  } catch (e) {
    check('water:true town does not throw and has valid schema', false, e.message);
  }

  if (waterTown) {
    const riverCount = waterTown.layers.rivers.length;
    const waterCount = waterTown.layers.water.length;
    const plankCount = waterTown.layers.planks.length;

    check(
      'water:true produces at least one rivers OR water entry',
      riverCount > 0 || waterCount > 0,
      `rivers=${riverCount}, water=${waterCount}`
    );
    check(
      'water:true with a river placed produces at least one plank',
      riverCount === 0 || plankCount > 0,
      `rivers=${riverCount}, planks=${plankCount}`
    );

    // Sample-check: no building centroid lies inside any water polygon.
    let buildingInWater = null;
    for (const poly of waterTown.layers.buildings) {
      const outer = poly[0];
      if (!outer || outer.length < 3) continue;
      const c = centroid(outer);
      for (const wpoly of waterTown.layers.water) {
        const wouter = wpoly[0];
        if (wouter && pointInPolygon(c, wouter)) {
          buildingInWater = c;
          break;
        }
      }
      if (buildingInWater) break;
    }
    check(
      'water:true — no building centroid lies inside a water polygon',
      buildingInWater === null,
      `found building centroid ${JSON.stringify(buildingInWater)} inside water`
    );

    // Re-run the full battery of seeds across several water seeds to make
    // sure nothing throws regardless of which random river/pond branch is
    // taken (entry/exit edges, meander, pond-only, river-only, both).
    let multiSeedOk = true;
    let multiSeedErr = '';
    for (const s of ['water-2', 'water-3', 'water-4', 'water-5', 'water-6']) {
      try {
        const t = generateTown({ seed: s, sizeM: 1000, water: true });
        if (!REQUIRED_LAYER_KEYS.every((k) => Array.isArray(t.layers[k]))) {
          multiSeedOk = false;
          multiSeedErr = `seed ${s}: missing layer key`;
          break;
        }
      } catch (e) {
        multiSeedOk = false;
        multiSeedErr = `seed ${s}: ${e.message}`;
        break;
      }
    }
    check('water:true across multiple seeds does not throw', multiSeedOk, multiSeedErr);

    // water as a probability (number) should also not throw.
    try {
      const probTown = generateTown({ seed: 'water-prob-1', sizeM: 1000, water: 0.5 });
      check('water as a 0..1 probability does not throw', REQUIRED_LAYER_KEYS.every((k) => Array.isArray(probTown.layers[k])));
    } catch (e) {
      check('water as a 0..1 probability does not throw', false, e.message);
    }
  }

  // --- summary -------------------------------------------------------------
  for (const line of results) console.log(line);
  console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log(`\nGeneration time (sizeM=1000): ${elapsedMs} ms`);
  console.log('Per-layer counts (test town, seed="test-1", sizeM=1000):');
  for (const key of REQUIRED_LAYER_KEYS) {
    console.log(`  ${key}: ${town.layers[key].length}`);
  }
  if (waterTown) {
    console.log(`\nGeneration time (water:true, sizeM=1000): ${waterElapsedMs} ms`);
    console.log('Per-layer counts (water town, seed="water-1", sizeM=1000):');
    for (const key of REQUIRED_LAYER_KEYS) {
      console.log(`  ${key}: ${waterTown.layers[key].length}`);
    }
  }

  return fail === 0;
}

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('model.js')) {
  __selfTest();
}
