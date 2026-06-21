// cutter.js — line-construction helpers that build a cut line and hand it to
// geom.cut() to split a ring. Vanilla ES module. No dependencies, DOM-free.
//
// Clean-room implementation (see CONTRACTS.md + REFERENCE_NOTES.md §5). Builds
// on geom.js primitives only; does not reimplement ring-splitting math itself.

import { lerp, rotate, cut, shrink as geomShrink } from './geom.js';

// ---------------------------------------------------------------------------
// bisect()
// ---------------------------------------------------------------------------

/**
 * Bisect `ring` near `vertexIndex`: interpolate a point at `ratio` along the
 * edge running from that vertex to its successor, construct a cut line
 * through that point at `angle` radians relative to the edge direction
 * (angle=0 means the cut line is perpendicular to the edge — see step 3
 * below), and split the ring with `gap`.
 *
 * Construction (REFERENCE_NOTES.md §5):
 *   1. p1 = lerp(vertex, next, ratio)                         — point on edge
 *   2. d  = next - vertex, rotated by `angle`                 — (possibly
 *      angle-offset) edge direction
 *   3. p2 = p1 + rot90(d)                                      — step from p1
 *      perpendicular to the (angled) edge direction, giving the actual cut
 *      line p1->p2 (perpendicular to the edge when angle=0)
 *   4. cut(ring, p1, p2, gap)
 *
 * @param {Array<[number,number]>} ring
 * @param {number} vertexIndex index of the edge's start vertex
 * @param {number} [ratio=0.5] position along the edge in [0,1]
 * @param {number} [angle=0] radians, offset from perpendicular-to-edge
 * @param {number} [gap=0] alley width carved along the cut line
 * @returns {Array<Array<[number,number]>>} [ringA, ringB] or [] if no split
 */
export function bisect(ring, vertexIndex, ratio = 0.5, angle = 0, gap = 0) {
  if (!Array.isArray(ring) || ring.length < 3) return [];
  const pts = ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1] && ring.length > 3
    ? ring.slice(0, -1)
    : ring;
  const n = pts.length;
  if (n < 3) return [];

  const idx = ((vertexIndex % n) + n) % n;
  const vertex = pts[idx];
  const next = pts[(idx + 1) % n];

  // 1. Point on the edge at `ratio`.
  const p1 = lerp(vertex, next, ratio);

  // 2. Edge direction, rotated by `angle`.
  const edgeDir = [next[0] - vertex[0], next[1] - vertex[1]];
  const [vx, vy] = rotate(edgeDir, angle, [0, 0]);

  // 3. Rotate that (possibly angled) direction by +90 degrees and step from
  // p1 — this is the actual cut-line direction. Rotating [vx,vy] by +90deg
  // gives [-vy, vx]; per REFERENCE_NOTES §5 step 3 the step is
  // (p1.x - vy, p1.y + vx), i.e. direction (-vy, vx). Same thing.
  const p2 = [p1[0] - vy, p1[1] + vx];

  // 4. Cut.
  return cut(pts, p1, p2, gap);
}

// ---------------------------------------------------------------------------
// Optional helpers: radial / ring ("peel") cutters for plaza/castle wards.
// ---------------------------------------------------------------------------

/**
 * Radial ("pie slice") cut: connects the ring's centroid to each vertex,
 * producing one sector polygon per edge. Each sector is a triangle/quad
 * [centroid, vertex_i, vertex_{i+1}], inset slightly by `gap`/2 along the two
 * radial edges so a small wedge-shaped path separates neighboring sectors
 * (formal/compact park layouts, REFERENCE_NOTES.md §5).
 *
 * @param {Array<[number,number]>} ring
 * @param {number} [gap=0] visual path width between sectors
 * @returns {Array<Array<[number,number]>>} sector polygons
 */
export function radial(ring, gap = 0) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 3) return [];
  const c = centroidOf(pts);
  const half = gap / 2;
  const sectors = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (half > 0) {
      // Pull a/b slightly toward the edge midpoint, away from the radial
      // seam, so consecutive sectors don't share a zero-width edge.
      const aIn = pullToward(a, c, half);
      const bIn = pullToward(b, c, half);
      sectors.push([c, aIn, bIn]);
    } else {
      sectors.push([c, a, b]);
    }
  }
  return sectors;
}

/**
 * Semi-radial cut: like radial(), but rays originate from the two endpoints
 * of one chosen edge (default: the longest) rather than the true centroid —
 * used when the block is too irregular for a clean radial fan.
 *
 * @param {Array<[number,number]>} ring
 * @param {number} [gap=0]
 * @param {number} [edgeIndex] which edge to fan from (defaults to longest)
 * @returns {Array<Array<[number,number]>>}
 */
export function semiRadial(ring, gap = 0, edgeIndex) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 3) return [];
  let idx = edgeIndex;
  if (idx === undefined) {
    let bestLen = -1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > bestLen) { bestLen = len; idx = i; }
    }
  }
  const origin = lerp(pts[idx], pts[(idx + 1) % n], 0.5);
  const half = gap / 2;
  const sectors = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (half > 0) {
      const aIn = pullToward(a, origin, half);
      const bIn = pullToward(b, origin, half);
      sectors.push([origin, aIn, bIn]);
    } else {
      sectors.push([origin, a, b]);
    }
  }
  return sectors;
}

/**
 * Peel concentric rings inward from the boundary, each `thickness` wide,
 * separated by `gap`, until the remaining core is too small. Returns the
 * band polygons (each an annulus-like ring approximated via geom.shrink at
 * two depths) plus the final innermost core. Used for circular/courtyard
 * structures like a cathedral cloister ring.
 *
 * NOTE: bands are returned as their outer ring only (the caller treats each
 * returned ring as a "footprint at this depth"); true annulus-with-hole
 * geometry is out of scope for the Ring (no-holes-in-single-ring) primitive
 * used throughout this module.
 *
 * @param {Array<[number,number]>} ring
 * @param {number} thickness
 * @param {number} [gap=0]
 * @returns {Array<Array<[number,number]>>} band rings, outermost first
 */
export function ring(ring_, thickness, gap = 0) {
  // Lazy import to avoid a hard cycle at module-eval time in environments
  // that load cutter.js before geom.js finishes initializing; geom.js has no
  // such ordering requirement in practice, but keep this local for clarity.
  return ringImpl(ring_, thickness, gap);
}

function ringImpl(ring0, thickness, gap) {
  const bands = [];
  let current = dedupClosing(ring0);
  let depth = 0;
  const step = thickness + gap;
  while (current.length >= 3 && depth < 64) {
    bands.push(current);
    const next = shrinkLocal(current, step);
    if (next.length < 3) break;
    current = next;
    depth++;
  }
  return bands;
}

// --- small local helpers (kept private to this module; do not duplicate
// geom.js's public API, just enough glue for radial/semiRadial/ring) -------

function dedupClosing(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return ring ? ring.slice() : [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring.slice();
}

function centroidOf(pts) {
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
}

function pullToward(p, target, dist) {
  const dx = target[0] - p[0];
  const dy = target[1] - p[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return p;
  const t = Math.min(dist / len, 0.49);
  return [p[0] + dx * t, p[1] + dy * t];
}

// Minimal uniform shrink fallback local to this module (peel rings don't
// need per-edge widths, just a uniform inward step); reuses geom.js's robust
// implementation, per "don't reimplement geometry; build on these
// primitives."
function shrinkLocal(pts, dist) {
  return geomShrink(pts, dist);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function areaOf(ring) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return -sum / 2;
}

/**
 * Self-test for cutter.js. Logs PASS/FAIL per case. Returns true iff all
 * cases passed.
 * @returns {boolean}
 */
export function __selfTest() {
  let pass = 0, fail = 0;
  const results = [];
  function check(name, cond, extra) {
    if (cond) { pass++; results.push(`PASS: ${name}`); }
    else { fail++; results.push(`FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
  }

  const square10 = [[0, 0], [0, 10], [10, 10], [10, 0]]; // screen-CCW, area 100
  const origArea = Math.abs(areaOf(square10));
  check('setup: square10 area is 100', approxEqual(origArea, 100), `got ${origArea}`);

  // bisect at vertex 0 ([0,0] -> [0,10] edge), ratio 0.5, angle 0, gap 0:
  // p1 = (0,5); edge dir (0,10) rotated 0deg = (0,10); cut line direction
  // step (p1.x - vy, p1.y + vx) = (0 - 10, 5 + 0) = (-10, 5) -> p2=(-10,5).
  // Line through (0,5)->(-10,5) is horizontal y=5: splits square10 into two
  // 10x5 halves (area 50 each) when gap=0.
  const halves = bisect(square10, 0, 0.5, 0, 0);
  check('bisect: vertex0 ratio0.5 angle0 gap0 splits into two rings', halves.length === 2, `got ${halves.length}`);
  if (halves.length === 2) {
    const a1 = Math.abs(areaOf(halves[0]));
    const a2 = Math.abs(areaOf(halves[1]));
    check('bisect: gap=0 areas sum to original', approxEqual(a1 + a2, origArea, 1e-6), `got ${a1}+${a2}`);
    check('bisect: gap=0 each half ~50', approxEqual(a1, 50, 1e-6) && approxEqual(a2, 50, 1e-6), `got ${a1},${a2}`);
  }

  // Same bisect but with a gap: total area should shrink.
  const halvesGap = bisect(square10, 0, 0.5, 0, 2);
  check('bisect: gap>0 splits into two rings', halvesGap.length === 2, `got ${halvesGap.length}`);
  if (halvesGap.length === 2) {
    const a1 = Math.abs(areaOf(halvesGap[0]));
    const a2 = Math.abs(areaOf(halvesGap[1]));
    check('bisect: gap>0 total area less than original', a1 + a2 < origArea - 1e-6, `got ${a1 + a2} vs ${origArea}`);
  }

  // Ratio shifted: ratio=0.2 should bias the cut line toward y=2 (still
  // horizontal here since angle=0 and the chosen edge is vertical).
  const halvesRatio = bisect(square10, 0, 0.2, 0, 0);
  check('bisect: ratio=0.2 splits into two rings', halvesRatio.length === 2);
  if (halvesRatio.length === 2) {
    const a1 = Math.abs(areaOf(halvesRatio[0]));
    const a2 = Math.abs(areaOf(halvesRatio[1]));
    const smaller = Math.min(a1, a2);
    const larger = Math.max(a1, a2);
    check('bisect: ratio=0.2 produces an unequal split (~20/80)', approxEqual(smaller, 20, 1e-6) && approxEqual(larger, 80, 1e-6), `got ${a1},${a2}`);
  }

  // angle offset of 90deg rotates the cut line to be parallel to the edge
  // instead of perpendicular — with p1 on the edge itself, a line parallel
  // to (and passing through) that edge is collinear with the boundary and
  // should not produce a valid split (all vertices on one side or on-line).
  const halvesAngle90 = bisect(square10, 0, 0.5, Math.PI / 2, 0);
  check('bisect: angle=90deg (line collinear with edge) returns []', halvesAngle90.length === 0, `got ${halvesAngle90.length}`);

  // Out-of-range vertexIndex should wrap, not throw.
  let wrapped;
  try {
    wrapped = bisect(square10, 4, 0.5, 0, 0); // 4 % 4 === 0
    check('bisect: vertexIndex wraps modulo ring length, no throw', wrapped.length === 2, `got ${wrapped.length}`);
  } catch (e) {
    check('bisect: vertexIndex wraps modulo ring length, no throw', false, e.message);
  }

  // Degenerate ring input.
  check('bisect: <3 point ring returns []', bisect([[0, 0], [1, 1]], 0).length === 0);

  // --- radial() ------------------------------------------------------------
  const sectors = radial(square10, 0);
  check('radial: produces one sector per edge', sectors.length === 4, `got ${sectors.length}`);
  if (sectors.length === 4) {
    let totalArea = 0;
    let allValid = true;
    for (const s of sectors) {
      const a = Math.abs(areaOf(s));
      totalArea += a;
      if (!Number.isFinite(a) || a <= 0) allValid = false;
    }
    check('radial: sectors all have positive finite area', allValid);
    check('radial: sector areas sum to ~original (gap=0)', approxEqual(totalArea, origArea, 1e-3), `got ${totalArea}`);
  }

  const sectorsGap = radial(square10, 1);
  check('radial: gap>0 still produces sectors', sectorsGap.length === 4);
  if (sectorsGap.length === 4) {
    let totalArea = 0;
    for (const s of sectorsGap) totalArea += Math.abs(areaOf(s));
    check('radial: gap>0 reduces total covered area vs gap=0', totalArea < origArea, `got ${totalArea} vs ${origArea}`);
  }

  // --- semiRadial() ----------------------------------------------------------
  const semi = semiRadial(square10, 0);
  check('semiRadial: produces one sector per edge', semi.length === 4, `got ${semi.length}`);

  // --- ring() (peel) ---------------------------------------------------------
  const bands = ring(square10, 2, 1);
  check('ring: peels at least one band', bands.length >= 1, `got ${bands.length}`);
  if (bands.length >= 1) {
    check('ring: first band equals original boundary', approxEqual(Math.abs(areaOf(bands[0])), origArea, 1e-6));
    let shrinking = true;
    for (let i = 1; i < bands.length; i++) {
      if (Math.abs(areaOf(bands[i])) >= Math.abs(areaOf(bands[i - 1]))) shrinking = false;
    }
    check('ring: bands strictly shrink inward', shrinking);
  }

  for (const line of results) console.log(line);
  console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
  return fail === 0;
}

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('cutter.js')) {
  __selfTest();
}
