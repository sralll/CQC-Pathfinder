// voronoi.js — Voronoi-patch generator for the infinite-mode town generator.
// Vanilla ES module. No dependencies, no build step, DOM-free.
//
// Algorithm (per CONTRACTS.md §3): scatter `count` seeds uniformly in `bbox`
// via the passed-in `rng`, build each Voronoi cell by O(n^2) half-plane
// clipping (Sutherland-Hodgman against the perpendicular bisector of every
// other seed pair), then run `lloyd` relaxation passes (reseed at each
// cell's centroid, recompute). This is robust at the ~10-40 seed scale this
// module targets and avoids Fortune's/Delaunay degeneracy edge cases.
//
// Coordinate convention (CONTRACTS.md §1): planar metres, +x right, +y down.
// Rings are plain Pt[] arrays ([x,y]), implicitly closed, no repeated first
// vertex required.

import { centroid, area, makeRng } from './geom.js';

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Half-plane clipping (Sutherland-Hodgman against a single half-plane)
// ---------------------------------------------------------------------------

// Clip `ring` to the half-plane { p : (p - linePoint) . lineNormal <= 0 },
// i.e. keep the side the normal points AWAY from (normal points toward the
// rejected side). Standard Sutherland-Hodgman against one infinite line.
// Returns a (possibly empty) ring.
function clipByHalfPlane(ring, linePoint, lineNormal) {
  const n = ring.length;
  if (n < 3) return [];

  const [lx, ly] = linePoint;
  const [nx, ny] = lineNormal;

  // Signed distance: <= 0 means "inside" (kept side).
  const side = (p) => (p[0] - lx) * nx + (p[1] - ly) * ny;

  const out = [];
  for (let i = 0; i < n; i++) {
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const curSide = side(cur);
    const nextSide = side(next);
    const curInside = curSide <= EPS;
    const nextInside = nextSide <= EPS;

    if (curInside) out.push(cur);

    if (curInside !== nextInside) {
      // Edge crosses the boundary line — interpolate the intersection.
      const denom = curSide - nextSide;
      if (Math.abs(denom) > EPS) {
        const t = curSide / denom;
        out.push([
          cur[0] + (next[0] - cur[0]) * t,
          cur[1] + (next[1] - cur[1]) * t,
        ]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Single-cell construction
// ---------------------------------------------------------------------------

// Build the Voronoi cell for seeds[i] by starting from the bbox rectangle
// and clipping against the perpendicular-bisector half-plane of every other
// seed (keep the side closer to seeds[i]).
function buildCell(seeds, i, boxRing) {
  let cell = boxRing;
  const [sx, sy] = seeds[i];

  for (let j = 0; j < seeds.length; j++) {
    if (j === i) continue;
    const [ox, oy] = seeds[j];

    const mx = (sx + ox) / 2;
    const my = (sy + oy) / 2;
    // Normal pointing from seed[i] toward seed[j] (the rejected side is the
    // half-plane closer to seed[j], i.e. the side the normal points into).
    let nx = ox - sx;
    let ny = oy - sy;
    const len = Math.hypot(nx, ny);
    if (len < EPS) continue; // coincident seeds — no bisector
    nx /= len;
    ny /= len;

    cell = clipByHalfPlane(cell, [mx, my], [nx, ny]);
    if (cell.length < 3) return [];
  }
  return cell;
}

function ringFromBbox(bb) {
  const [minx, miny, maxx, maxy] = bb;
  // Screen-CCW per geom.js convention (+x right, +y down):
  // (minx,miny) -> (minx,maxy) -> (maxx,maxy) -> (maxx,miny)
  return [
    [minx, miny],
    [minx, maxy],
    [maxx, maxy],
    [maxx, miny],
  ];
}

function scatterSeeds(rng, bb, count) {
  const [minx, miny, maxx, maxy] = bb;
  const w = maxx - minx;
  const h = maxy - miny;
  const seeds = [];
  for (let k = 0; k < count; k++) {
    seeds.push([minx + rng() * w, miny + rng() * h]);
  }
  return seeds;
}

function buildAllCells(seeds, boxRing) {
  const cells = [];
  for (let i = 0; i < seeds.length; i++) {
    cells.push(buildCell(seeds, i, boxRing));
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scatter `count` seed points uniformly in `bbox` via `rng`, build the
 * Voronoi diagram by half-plane clipping, run `lloyd` Lloyd-relaxation
 * passes (reseed at each cell's centroid and recompute), and return the
 * final cell polygons as rings tiling `bbox`.
 *
 * All randomness flows through `rng` — never Math.random — so the same rng
 * state reproduces the same patches.
 *
 * @param {() => number} rng seeded PRNG in [0,1), e.g. from geom.js makeRng
 * @param {[number,number,number,number]} bb [minx,miny,maxx,maxy]
 * @param {number} count number of seeds/cells to scatter
 * @param {number} [lloyd] number of Lloyd relaxation passes
 * @returns {Array<Array<[number,number]>>} cell rings (Pt[][])
 */
export function generatePatches(rng, bb, count, lloyd = 2) {
  if (count <= 0) return [];
  const boxRing = ringFromBbox(bb);
  const boxArea = Math.abs(area(boxRing));
  const minArea = boxArea * 1e-6; // drop near-zero-area slivers

  let seeds = scatterSeeds(rng, bb, count);

  let cells = buildAllCells(seeds, boxRing);

  for (let pass = 0; pass < lloyd; pass++) {
    const nextSeeds = [];
    for (let i = 0; i < seeds.length; i++) {
      const cell = cells[i];
      if (cell.length >= 3 && Math.abs(area(cell)) > minArea) {
        nextSeeds.push(centroid(cell));
      } else {
        // Degenerate cell — keep the old seed so we don't lose a point.
        nextSeeds.push(seeds[i]);
      }
    }
    seeds = nextSeeds;
    cells = buildAllCells(seeds, boxRing);
  }

  // Drop degenerate cells (< 3 points or ~zero area).
  return cells.filter((cell) => cell.length >= 3 && Math.abs(area(cell)) > minArea);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function approxEqual(a, b, eps) {
  return Math.abs(a - b) <= eps;
}

/**
 * Runs a battery of self-tests on generatePatches(). Logs PASS/FAIL per case
 * and a summary line. Returns true iff every case passed.
 * @returns {boolean}
 */
export function __selfTest() {
  let pass = 0;
  let fail = 0;
  const results = [];

  function check(name, cond, extra) {
    if (cond) {
      pass++;
      results.push(`PASS: ${name}`);
    } else {
      fail++;
      results.push(`FAIL: ${name}${extra ? ' — ' + extra : ''}`);
    }
  }

  const bb = [0, 0, 1000, 1000];
  const boxArea = (bb[2] - bb[0]) * (bb[3] - bb[1]); // 1,000,000
  const rng = makeRng('voronoi-self-test');
  const cells = generatePatches(rng, bb, 20, 2);

  check(
    'returns ~20 non-degenerate cells (allow a few dropped)',
    cells.length >= 16 && cells.length <= 20,
    `got ${cells.length}`
  );

  let allValid = true;
  let allFinite = true;
  let allPositiveArea = true;
  let allWithinBbox = true;
  let totalArea = 0;
  const eps = 1e-3; // small epsilon for bbox containment

  for (const cell of cells) {
    if (cell.length < 3) {
      allValid = false;
      continue;
    }
    for (const [x, y] of cell) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) allFinite = false;
      if (x < bb[0] - eps || x > bb[2] + eps || y < bb[1] - eps || y > bb[3] + eps) {
        allWithinBbox = false;
      }
    }
    const a = Math.abs(area(cell));
    if (!(a > 0)) allPositiveArea = false;
    totalArea += a;
  }

  check('every cell ring has >= 3 points', allValid);
  check('every cell has finite coordinates', allFinite);
  check('every cell has positive area magnitude', allPositiveArea);
  check('every cell stays within bbox (allow tiny epsilon)', allWithinBbox);

  const areaRatio = totalArea / boxArea;
  check(
    'total cell area ~= bbox area (tiles the box, no big gaps/overlaps)',
    approxEqual(areaRatio, 1, 0.03),
    `got ratio ${areaRatio} (total=${totalArea}, box=${boxArea})`
  );

  // Determinism: same seed -> same result.
  const rngA = makeRng('determinism-check');
  const rngB = makeRng('determinism-check');
  const cellsA = generatePatches(rngA, bb, 12, 1);
  const cellsB = generatePatches(rngB, bb, 12, 1);
  check(
    'determinism: same rng seed produces identical patches',
    JSON.stringify(cellsA) === JSON.stringify(cellsB)
  );

  // Edge case: lloyd=0 still produces a valid tiling.
  const rngC = makeRng('lloyd-zero');
  const cellsNoLloyd = generatePatches(rngC, bb, 10, 0);
  check(
    'lloyd=0 still returns non-degenerate cells',
    cellsNoLloyd.length >= 8 && cellsNoLloyd.length <= 10,
    `got ${cellsNoLloyd.length}`
  );

  // Edge case: count=0 returns [].
  check('count=0 returns empty array', generatePatches(makeRng('zero'), bb, 0, 2).length === 0);

  for (const line of results) {
    console.log(line);
  }
  console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
  return fail === 0;
}

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('voronoi.js')) {
  __selfTest();
}
