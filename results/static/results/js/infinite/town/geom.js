// geom.js — load-bearing geometry primitives for the infinite-mode town generator.
// Vanilla ES module. No dependencies, no build step, DOM-free.
//
// Coordinate convention (per CONTRACTS.md §1): planar metres, +x right, +y down
// (SVG-friendly, like screen/canvas coordinates — y grows downward).
//
// AREA / WINDING CONVENTION:
//   area(ring) uses the standard shoelace sum  sum(x_i * y_{i+1} - x_{i+1} * y_i) / 2.
//   Under a +x-right/+y-down axis system (SVG-style), a ring that looks
//   counter-clockwise *on screen* is traversed clockwise in the underlying
//   (x,y) math sense relative to a normal +x-right/+y-up frame, which flips
//   the usual shoelace sign. To keep `area(ring) > 0` mean "counter-clockwise
//   as drawn on screen" (the convention CONTRACTS.md §3 states: ">0 == CCW"),
//   we negate the raw shoelace sum. Concretely: walking a ring that visits
//   (0,0) -> (1,0) -> (1,1) -> (0,1) -> back to (0,0) goes clockwise on a
//   +y-down screen (right, then down, then left, then up) and area() returns
//   a NEGATIVE value for it; the screen-CCW square (0,0)->(0,1)->(1,1)->(1,0)
//   returns POSITIVE. All other functions in this module (shrink/buffer inward
//   direction, etc.) derive "inward" from the sign of area() so they stay
//   correct regardless of input winding.

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

// xmur3 string hash -> 32-bit seed generator. Standard public-domain algorithm
// (Jenkins-style mix), reimplemented from scratch (clean-room).
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// mulberry32 PRNG -> deterministic float generator in [0,1). Standard public
// public-domain algorithm, reimplemented from scratch (clean-room).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic seeded PRNG. Accepts a string or numeric seed (numbers are
 * stringified) so the same seed always reproduces the same sequence.
 * @param {string|number} seed
 * @returns {() => number} function returning floats in [0,1)
 */
export function makeRng(seed) {
  const seedStr = String(seed);
  const hash = xmur3(seedStr);
  return mulberry32(hash());
}

// ---------------------------------------------------------------------------
// Ring helpers
// ---------------------------------------------------------------------------

// Returns the ring's points without a trailing duplicate of the first vertex
// (rings "may or may not repeat the first vertex" per CONTRACTS.md §1).
function dedupClosing(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return ring ? ring.slice() : [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return ring.slice(0, -1);
  }
  return ring.slice();
}

/**
 * Signed polygon area. See module header for the sign convention:
 * positive == counter-clockwise as drawn on a +x-right/+y-down screen.
 * Degenerate (<3 points) rings return 0.
 * @param {Array<[number,number]>} ring
 * @returns {number}
 */
export function area(ring) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  // Negate: see module header comment on the +y-down screen convention.
  return -sum / 2;
}

/**
 * Area-weighted centroid. Falls back to the plain vertex average for
 * degenerate rings (zero/near-zero area, or <3 points).
 * @param {Array<[number,number]>} ring
 * @returns {[number,number]}
 */
export function centroid(ring) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n === 0) return [0, 0];
  if (n < 3) {
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    return [sx / n, sy / n];
  }
  let a6 = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    a6 += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  const a = a6 / 2;
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    return [sx / n, sy / n];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * Total perimeter length of the ring (sum of edge lengths, implicitly closed).
 * @param {Array<[number,number]>} ring
 * @returns {number}
 */
export function perimeter(ring) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}

/**
 * Axis-aligned bounding box of the ring.
 * @param {Array<[number,number]>} ring
 * @returns {[number,number,number,number]} [minx,miny,maxx,maxy]
 */
export function bbox(ring) {
  const pts = dedupClosing(ring);
  if (pts.length === 0) return [0, 0, 0, 0];
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of pts) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}

/**
 * Linear interpolation between two points.
 * @param {[number,number]} a
 * @param {[number,number]} b
 * @param {number} t
 * @returns {[number,number]}
 */
export function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Rotate a point by `angle` radians around `origin` (default [0,0]).
 * @param {[number,number]} p
 * @param {number} angle radians
 * @param {[number,number]} [origin]
 * @returns {[number,number]}
 */
export function rotate(p, angle, origin = [0, 0]) {
  const dx = p[0] - origin[0];
  const dy = p[1] - origin[1];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [origin[0] + dx * cos - dy * sin, origin[1] + dx * sin + dy * cos];
}

/**
 * Find the longest edge of the ring.
 * @param {Array<[number,number]>} ring
 * @returns {{index:number, a:[number,number], b:[number,number], length:number}}
 */
export function longestEdge(ring) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 2) {
    return { index: -1, a: null, b: null, length: 0 };
  }
  let bestIdx = 0, bestLen = -1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > bestLen) {
      bestLen = len;
      bestIdx = i;
    }
  }
  return { index: bestIdx, a: pts[bestIdx], b: pts[(bestIdx + 1) % n], length: bestLen };
}

// ---------------------------------------------------------------------------
// cut()
// ---------------------------------------------------------------------------

const EPS = 1e-9;

// Signed perpendicular distance-like value (cross product) of point p
// relative to the infinite line through p1->p2. Sign tells which side.
function sideOf(p, p1, dir) {
  return (p[0] - p1[0]) * dir[1] - (p[1] - p1[1]) * dir[0];
}

/**
 * Split a simple ring by the infinite line through p1->p2 into two rings.
 * Classifies vertices by side-of-line sign, walks the ring emitting vertices
 * plus intersection points at sign-crossing edges, and groups the resulting
 * boundary loop into the two sub-polygons (the two faces separated by the
 * cut introduces exactly one cut-chord pair, walked in opposite directions
 * by each sub-polygon).
 *
 * If `gap > 0`, each resulting sub-polygon is translated away from the cut
 * line by gap/2 along the line's normal, separating the two halves (creates
 * an alley).
 *
 * @param {Array<[number,number]>} ring
 * @param {[number,number]} p1
 * @param {[number,number]} p2
 * @param {number} [gap]
 * @returns {Array<Array<[number,number]>>} [] if the line doesn't split the
 *   polygon, else [ringA, ringB]
 */
export function cut(ring, p1, p2, gap = 0) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 3) return [];

  const dir = [p2[0] - p1[0], p2[1] - p1[1]];
  const dirLen = Math.hypot(dir[0], dir[1]);
  if (dirLen < EPS) return []; // degenerate cut line

  // Per-vertex signed side; snap near-zero to exactly 0 to treat on-line
  // vertices gracefully.
  const sides = pts.map((p) => {
    const s = sideOf(p, p1, dir);
    return Math.abs(s) < EPS ? 0 : s;
  });

  const hasPos = sides.some((s) => s > 0);
  const hasNeg = sides.some((s) => s < 0);
  if (!hasPos || !hasNeg) {
    // All vertices on one side (or exactly on the line) — no split.
    return [];
  }

  // Walk the ring, emitting original vertices and inserting intersection
  // points wherever consecutive non-zero-sign vertices differ in sign (or a
  // zero-sign vertex sits between, it's emitted as-is and acts as its own
  // crossing point). Each emitted point is tagged `onLine` so that, when
  // gap>0, we can translate ONLY the cut-line vertices (the chord shared by
  // both sub-polygons) and leave the rest of each ring fixed in place — that
  // is what actually carves a gap-wide sliver out of each half rather than
  // rigidly translating (which would preserve area and the relative
  // position of the two halves' far sides).
  const sideA = []; // side > 0 polygon's vertex loop: {p, onLine}
  const sideB = []; // side < 0 polygon's vertex loop: {p, onLine}

  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const curSide = sides[i];
    const next = pts[(i + 1) % n];
    const nextSide = sides[(i + 1) % n];

    if (curSide >= 0) sideA.push({ p: cur, onLine: curSide === 0 });
    if (curSide <= 0) sideB.push({ p: cur, onLine: curSide === 0 });

    // Only compute an intersection when both endpoints are strictly
    // non-zero and on opposite sides (a true crossing). If either endpoint
    // is exactly on the line, that endpoint itself is the crossing point
    // and is already shared by both loops above.
    if (curSide !== 0 && nextSide !== 0 && Math.sign(curSide) !== Math.sign(nextSide)) {
      const t = curSide / (curSide - nextSide);
      const ix = cur[0] + (next[0] - cur[0]) * t;
      const iy = cur[1] + (next[1] - cur[1]) * t;
      const ipt = [ix, iy];
      sideA.push({ p: ipt, onLine: true });
      sideB.push({ p: ipt, onLine: true });
    }
  }

  if (sideA.length < 3 || sideB.length < 3) return [];

  let tagsA = dedupCollinearAdjacent(sideA);
  let tagsB = dedupCollinearAdjacent(sideB);

  if (tagsA.length < 3 || tagsB.length < 3) return [];

  if (gap > 0) {
    // Unit normal to the cut line.
    const nx = -dir[1] / dirLen;
    const ny = dir[0] / dirLen;
    const half = gap / 2;
    // Determine which physical normal direction corresponds to the
    // side>0 half, so each half's cut-line vertices move away from the
    // other half (not into it).
    const testSide = sideOf([p1[0] + nx, p1[1] + ny], p1, dir);
    const aSign = testSide > 0 ? 1 : -1;
    tagsA = tagsA.map(({ p, onLine }) =>
      onLine ? [p[0] + nx * half * aSign, p[1] + ny * half * aSign] : p
    );
    tagsB = tagsB.map(({ p, onLine }) =>
      onLine ? [p[0] - nx * half * aSign, p[1] - ny * half * aSign] : p
    );
  } else {
    tagsA = tagsA.map(({ p }) => p);
    tagsB = tagsB.map(({ p }) => p);
  }

  if (tagsA.length < 3 || tagsB.length < 3) return [];

  return [tagsA, tagsB];
}

// Remove duplicate-adjacent points (within EPS) that can arise when a
// vertex lies exactly on the cut line (it gets pushed into both loops and
// may sit immediately next to the same point). Operates on {p, onLine}
// tagged points, keyed by point coordinates.
function dedupCollinearAdjacent(tagged) {
  const out = [];
  for (let i = 0; i < tagged.length; i++) {
    const cur = tagged[i];
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(cur.p[0] - prev.p[0], cur.p[1] - prev.p[1]) > EPS) {
      out.push(cur);
    }
  }
  // Drop closing duplicate if the walk wrapped onto its start.
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.p[0] - last.p[0], first.p[1] - last.p[1]) <= EPS) {
      out.pop();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// shrink() / buffer()
// ---------------------------------------------------------------------------

// Intersection of two infinite lines, each given as a point + direction
// vector. Returns null if parallel (no unique intersection).
function lineLineIntersect(p1, d1, p2, d2) {
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(cross) < EPS) return null;
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / cross;
  return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
}

/**
 * Inset (shrink) a ring inward by `dist` metres (uniform), or per-edge if
 * `dist` is a number[] (one inset per edge, in the same order as edges:
 * edge i runs from ring[i] to ring[i+1]). Positive = inward. Determines
 * "inward" from the ring's actual winding (sign of area()), so it works
 * regardless of input orientation. Tolerates mildly concave rings. Returns
 * [] if the ring is degenerate or the result collapses/inverts.
 * @param {Array<[number,number]>} ring
 * @param {number|number[]} dist
 * @returns {Array<[number,number]>}
 */
export function shrink(ring, dist) {
  const pts = dedupClosing(ring);
  const n = pts.length;
  if (n < 3) return [];

  const origArea = area(pts);
  if (Math.abs(origArea) < EPS) return [];

  const dists = Array.isArray(dist) ? dist : new Array(n).fill(dist);
  if (dists.length !== n) return []; // per-edge array must match edge count

  // Orientation sign: +1 if pts is CCW under area()'s convention, else -1.
  const orientSign = origArea > 0 ? 1 : -1;

  // Build each edge's offset line: point + direction, offset inward by its
  // distance along the inward normal.
  const edgeLines = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const elen = Math.hypot(ex, ey);
    if (elen < EPS) {
      // Zero-length edge: fall back to a degenerate line at the point;
      // skip offsetting (treat as no inset for this edge) to stay robust.
      edgeLines.push({ p: a, d: [ex, ey], len: elen, a, b });
      continue;
    }
    const dx = ex / elen;
    const dy = ey / elen;
    // Inward normal: rotate direction so it points into the polygon.
    // For a CCW ring (orientSign=+1) under this module's area() convention
    // (CCW == screen-CCW, +y-down), the inward normal is (dy, -dx).
    // For CW rings, flip it.
    let nx = dy * orientSign;
    let ny = -dx * orientSign;
    const inset = dists[i] || 0;
    const offP = [a[0] + nx * inset, a[1] + ny * inset];
    edgeLines.push({ p: offP, d: [dx, dy], len: elen, a, b });
  }

  // Intersect consecutive offset edge-lines to find new vertices.
  const newPts = [];
  for (let i = 0; i < n; i++) {
    const prev = edgeLines[(i - 1 + n) % n];
    const cur = edgeLines[i];
    if (prev.len < EPS || cur.len < EPS) {
      // One of the adjacent edges is degenerate; just keep the offset
      // start point of the current edge as a fallback.
      newPts.push(cur.p);
      continue;
    }
    const ipt = lineLineIntersect(prev.p, prev.d, cur.p, cur.d);
    if (ipt === null) {
      // Parallel edges (straight-through vertex) — offset point is just
      // the current edge's offset start (same as prev's offset end).
      newPts.push(cur.p);
    } else {
      newPts.push(ipt);
    }
  }

  if (newPts.length < 3) return [];

  // Validate: result must not collapse to zero/near-zero area or flip
  // orientation relative to the original (which would indicate the inset
  // exceeded the polygon's local width).
  const newArea = area(newPts);
  if (Math.abs(newArea) < EPS) return [];
  if (Math.sign(newArea) !== Math.sign(origArea)) return [];

  // The following sanity checks only make sense for a genuine inward shrink
  // (all per-edge distances >= 0); buffer() reuses this function with
  // negated (outward, i.e. negative) distances, where area legitimately
  // grows and new vertices legitimately fall outside the original edges.
  const allNonNegative = dists.every((d) => (d || 0) >= 0);
  if (allNonNegative) {
    if (Math.abs(newArea) > Math.abs(origArea)) return []; // shrink must not grow

    // Edge-direction-reversal check: newPts[i] is the intersection of
    // edgeLines[i-1] and edgeLines[i], so the new edge running from
    // newPts[i] to newPts[(i+1)%n] lies along edgeLines[i] — the offset
    // counterpart of the *original* edge i. If the requested inset for
    // edge i exceeds the polygon's local available width, the offset line
    // for edge i gets pushed past the opposite side and the new edge ends
    // up tracing BACKWARDS relative to the original edge's direction (dot
    // product of the new edge vector with the original edge direction
    // turns negative). This is a robust, scale-covariant collapse signal:
    // it catches degenerate folds even when the folded polygon happens to
    // retain plausible area/sign/bbox (e.g. insetting a square by exactly
    // its half-width reconstructs a same-size, same-sign square via
    // crossed offset lines — area/sign/bbox checks alone miss this, but
    // every edge there is found running backwards).
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const elen = Math.hypot(ex, ey);
      if (elen < EPS) continue;
      if ((dists[i] || 0) <= EPS) continue; // no inset on this edge — nothing to check
      const newA = newPts[i];
      const newB = newPts[(i + 1) % n];
      const newEx = newB[0] - newA[0];
      const newEy = newB[1] - newA[1];
      const dot = newEx * ex + newEy * ey;
      if (dot < -EPS) return []; // new edge runs backwards — collapsed/folded
    }
  }

  // Guard against self-intersection blowing the shape up disproportionately
  // (cheap heuristic: any NaN/Infinity coordinate means a numerical failure).
  for (const [x, y] of newPts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  }

  return newPts;
}

/**
 * Outward offset (buffer) of a ring. Positive `dist` = outward. Implemented
 * by negating the inset passed to shrink()'s inward-offset math.
 * @param {Array<[number,number]>} ring
 * @param {number|number[]} dist
 * @returns {Array<[number,number]>}
 */
export function buffer(ring, dist) {
  if (Array.isArray(dist)) {
    return shrink(ring, dist.map((d) => -d));
  }
  return shrink(ring, -dist);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

/**
 * Runs a battery of self-tests covering area sign, cut(), shrink(), and
 * buffer(). Logs PASS/FAIL per case and a summary line. Returns true iff
 * every case passed.
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

  // --- area sign --------------------------------------------------------
  // Screen-CCW square (right, up, left, down as drawn): (0,0)->(0,1)->(1,1)->(1,0)
  const ccwSquare = [[0, 0], [0, 1], [1, 1], [1, 0]];
  const ccwArea = area(ccwSquare);
  check('area: screen-CCW square is positive', ccwArea > 0, `got ${ccwArea}`);
  check('area: screen-CCW unit square magnitude is 1', approxEqual(Math.abs(ccwArea), 1), `got ${ccwArea}`);

  const cwSquare = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const cwArea = area(cwSquare);
  check('area: screen-CW square is negative', cwArea < 0, `got ${cwArea}`);
  check('area: reversing winding flips sign', Math.sign(cwArea) === -Math.sign(ccwArea));

  // --- degenerate input never throws ------------------------------------
  try {
    check('area: degenerate (<3 pts) returns 0', area([[0, 0], [1, 1]]) === 0);
    check('centroid: degenerate falls back to vertex avg', Array.isArray(centroid([[0, 0], [2, 2]])));
    check('bbox: empty ring returns sane default', Array.isArray(bbox([])));
    check('longestEdge: degenerate returns index -1', longestEdge([[0, 0]]).index === -1);
    check('shrink: degenerate (<3 pts) returns []', shrink([[0, 0], [1, 1]], 1).length === 0);
    check('cut: degenerate (<3 pts) returns []', cut([[0, 0], [1, 1]], [0, 0], [1, 1]).length === 0);
  } catch (e) {
    fail++;
    results.push(`FAIL: degenerate-input block threw — ${e.message}`);
  }

  // --- cut(): unit square by vertical midline, gap=0 ---------------------
  const unitSquare = [[0, 0], [10, 0], [10, 10], [0, 10]]; // screen-CW per above test; let's use CCW instead
  const square10 = [[0, 0], [0, 10], [10, 10], [10, 0]]; // screen-CCW, area=100
  const origSqArea = area(square10);
  check('setup: square10 area is 100', approxEqual(Math.abs(origSqArea), 100), `got ${origSqArea}`);

  const cutNoGap = cut(square10, [5, 0], [5, 10], 0);
  check('cut: vertical midline splits square into two rings', cutNoGap.length === 2);
  if (cutNoGap.length === 2) {
    const a1 = Math.abs(area(cutNoGap[0]));
    const a2 = Math.abs(area(cutNoGap[1]));
    check('cut: gap=0 areas sum to original', approxEqual(a1 + a2, Math.abs(origSqArea), 1e-6), `got ${a1}+${a2}=${a1 + a2}`);
    check('cut: gap=0 each half ~50', approxEqual(a1, 50, 1e-6) && approxEqual(a2, 50, 1e-6), `got ${a1}, ${a2}`);
  }

  // cut with gap>0: total area should shrink by approximately gap * height
  const gapVal = 2;
  const height = 10;
  const cutWithGap = cut(square10, [5, 0], [5, 10], gapVal);
  check('cut: gap>0 splits square into two rings', cutWithGap.length === 2);
  if (cutWithGap.length === 2) {
    const a1 = Math.abs(area(cutWithGap[0]));
    const a2 = Math.abs(area(cutWithGap[1]));
    const expected = Math.abs(origSqArea) - gapVal * height;
    check(
      'cut: gap>0 areas sum to original minus gap*height',
      approxEqual(a1 + a2, expected, 1e-6),
      `got ${a1 + a2}, expected ${expected}`
    );
  }

  // cut: line missing the polygon entirely returns []
  const cutMiss = cut(square10, [100, 0], [100, 10], 0);
  check('cut: line outside polygon returns []', cutMiss.length === 0);

  // cut: line exactly on an edge / all vertices one side
  const cutAllOneSide = cut(square10, [-5, 0], [-5, 10], 0);
  check('cut: line entirely outside (all vertices same side) returns []', cutAllOneSide.length === 0);

  // --- shrink(): 10x10 square inset by 1 -> 8x8 (area 64) -----------------
  const shrunk = shrink(square10, 1);
  check('shrink: 10x10 inset by 1 produces a ring', shrunk.length >= 3, `got length ${shrunk.length}`);
  if (shrunk.length >= 3) {
    const shrunkArea = Math.abs(area(shrunk));
    check('shrink: 10x10 inset by 1 has area ~64', approxEqual(shrunkArea, 64, 1e-6), `got ${shrunkArea}`);
    const [minx, miny, maxx, maxy] = bbox(shrunk);
    check(
      'shrink: 10x10 inset by 1 has bbox [1,1,9,9]',
      approxEqual(minx, 1) && approxEqual(miny, 1) && approxEqual(maxx, 9) && approxEqual(maxy, 9),
      `got [${minx},${miny},${maxx},${maxy}]`
    );
  }

  // shrink: also test with a CW-wound square (winding-independence)
  const shrunkCW = shrink(cwSquare.map(([x, y]) => [x * 10, y * 10]), 1);
  check('shrink: works on CW-wound square too', shrunkCW.length >= 3, `got length ${shrunkCW.length}`);
  if (shrunkCW.length >= 3) {
    const a = Math.abs(area(shrunkCW));
    check('shrink: CW-wound 10x10 inset by 1 has area ~64', approxEqual(a, 64, 1e-6), `got ${a}`);
  }

  // shrink: inset larger than half the polygon collapses -> []
  const overShrink = shrink(square10, 10);
  check('shrink: inset >= half-width collapses to []', overShrink.length === 0, `got length ${overShrink.length}`);

  // --- buffer(): 10x10 square outward by 1 -> ~12x12 ----------------------
  const buffered = buffer(square10, 1);
  check('buffer: 10x10 outward by 1 produces a ring', buffered.length >= 3, `got length ${buffered.length}`);
  if (buffered.length >= 3) {
    const buffArea = Math.abs(area(buffered));
    check('buffer: 10x10 outward by 1 has area ~144', approxEqual(buffArea, 144, 1e-6), `got ${buffArea}`);
    const [minx, miny, maxx, maxy] = bbox(buffered);
    check(
      'buffer: 10x10 outward by 1 has bbox [-1,-1,11,11]',
      approxEqual(minx, -1) && approxEqual(miny, -1) && approxEqual(maxx, 11) && approxEqual(maxy, 11),
      `got [${minx},${miny},${maxx},${maxy}]`
    );
  }

  // --- per-edge shrink with mixed distances doesn't throw ----------------
  let mixedShrink;
  try {
    // square10 edges in order: (0,0)->(0,10), (0,10)->(10,10), (10,10)->(10,0), (10,0)->(0,0)
    mixedShrink = shrink(square10, [1, 2, 0.5, 3]);
    check('shrink: per-edge mixed distances does not throw', true);
    check('shrink: per-edge mixed distances returns array', Array.isArray(mixedShrink));
  } catch (e) {
    check('shrink: per-edge mixed distances does not throw', false, e.message);
  }

  // per-edge length mismatch should fail gracefully, not throw
  try {
    const mismatched = shrink(square10, [1, 2]);
    check('shrink: per-edge length mismatch returns [] (no throw)', mismatched.length === 0);
  } catch (e) {
    check('shrink: per-edge length mismatch returns [] (no throw)', false, e.message);
  }

  // --- mildly concave ring tolerance --------------------------------------
  // An L-shaped (concave) polygon, screen-CCW winding.
  const lshape = [[0, 0], [0, 10], [4, 10], [4, 4], [10, 4], [10, 0]];
  check('setup: L-shape area positive (CCW)', area(lshape) > 0, `got ${area(lshape)}`);
  let lshapeShrink;
  try {
    lshapeShrink = shrink(lshape, 0.5);
    check('shrink: concave L-shape does not throw', true);
    check('shrink: concave L-shape returns a usable ring or []', Array.isArray(lshapeShrink));
  } catch (e) {
    check('shrink: concave L-shape does not throw', false, e.message);
  }

  // --- other primitives ----------------------------------------------------
  check('lerp: midpoint of (0,0)-(10,10) at t=0.5 is (5,5)', JSON.stringify(lerp([0, 0], [10, 10], 0.5)) === JSON.stringify([5, 5]));
  const rotated = rotate([1, 0], Math.PI / 2, [0, 0]);
  check('rotate: (1,0) by 90deg around origin ~ (0,1)', approxEqual(rotated[0], 0) && approxEqual(rotated[1], 1), `got ${rotated}`);

  const perim = perimeter(square10);
  check('perimeter: 10x10 square perimeter is 40', approxEqual(perim, 40), `got ${perim}`);

  const le = longestEdge(lshape);
  check('longestEdge: returns a positive length for valid ring', le.length > 0, `got ${le.length}`);

  const c = centroid(square10);
  check('centroid: 10x10 square centred at (5,5)', approxEqual(c[0], 5) && approxEqual(c[1], 5), `got ${c}`);

  const rngA = makeRng('seed-1');
  const rngB = makeRng('seed-1');
  const seqA = [rngA(), rngA(), rngA()];
  const seqB = [rngB(), rngB(), rngB()];
  check('makeRng: same string seed reproduces exact sequence', JSON.stringify(seqA) === JSON.stringify(seqB));
  check('makeRng: values fall within [0,1)', seqA.every((v) => v >= 0 && v < 1), `got ${seqA}`);

  const rngNum = makeRng(42);
  const rngNum2 = makeRng(42);
  check('makeRng: numeric seed reproduces exact sequence', rngNum() === rngNum2());

  // --- report --------------------------------------------------------------
  for (const line of results) {
    console.log(line);
  }
  console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
  return fail === 0;
}

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('geom.js')) {
  __selfTest();
}
