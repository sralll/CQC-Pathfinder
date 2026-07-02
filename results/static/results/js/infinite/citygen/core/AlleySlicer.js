// AlleySlicer — port of com.watabou.mfcg.utils.Bisector (class `ji`) plus
// com.watabou.mfcg.model.wards.WardGroup's `semiSmooth` / `getCircle` / `getArc`.
//
// Where Cutter.bisect / Polygon.cut slice a block with a SINGLE straight line, the
// reference's Bisector cuts along a 3-point "elbow" polyline (entry -> bend -> exit),
// and `semiSmooth` replaces that elbow with a circular ARC that is tangent to both
// segments at the endpoints. That is what makes ward alleys curve instead of running
// straight. The block is then split along the resulting (possibly curved) polyline.
//
// Faithful behaviours kept verbatim from the Haxe source:
//  - makeCut uses the OBB long axis + centroid projection to choose a cut axis, then
//    looks for an elbow whose two segments are perpendicular to the two polygon edges
//    they meet (so the alley meets the block boundary at a right angle).
//  - If the two crossed edges are nearly parallel the cut degenerates to a straight
//    line; a straight cut that would be too unbalanced falls through to the elbow path.
//  - Area-balance check (ratio < 2*variance) retries with a randomly rotated OBB.
//  - `semiSmooth` randomly keeps the elbow, straightens it, or fits a tangent arc.
//
// Deviation: the reference insets the alley gap with a polygon boolean (stripe + AND).
// We instead inset only the cut-chain edges of each half via Polygon.buffer (the same
// mechanism Polygon.cut uses via `peel`, generalised to a multi-segment chain). This
// matches the local code's gap philosophy and avoids porting a full boolean clipper.
//
// NOTE: `Random` call ordering here differs from the legacy straight createAlleys, so
// downstream RNG state changes for a given seed — but results stay deterministic.

import { Point } from './Point.js';
import { Polygon } from './Polygon.js';
import { GeomUtils } from './GeomUtils.js';
import { Random } from './Random.js';
import { recordRemovedTriangle } from './features.js';

// --- small geometry helpers (ports of Gb / Sa / wd / Yc / I used by the Bisector) ---

class Circle {
	constructor(c, r) {
		this.c = c;
		this.r = r;
	}
}

// I.polar
function polar(r, angle) {
	return new Point(r * Math.cos(angle), r * Math.sin(angle));
}

// wd.project(v, p): scalar projection of p onto v (v not necessarily unit).
function project(v, p) {
	const l2 = v.x * v.x + v.y * v.y;
	return l2 === 0 ? 0 : (v.x * p.x + v.y * p.y) / l2;
}

// Yc.rotateYX: return rotated copies. b=sin, c=cos, x' = x*c - y*b ; y' = y*c + x*b.
function rotateYX(pts, b, c) {
	const out = [];
	for (const p of pts) out.push(new Point(p.x * c - p.y * b, p.y * c + p.x * b));
	return out;
}

// Andrew's monotone-chain convex hull — geometrically identical to Gb.convexHull,
// returns vertices in CCW order. (The exact hull routine doesn't affect OBB output.)
function convexHull(pts) {
	const p = pts.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
	if (p.length < 3) return p.slice();
	const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const lower = [];
	for (const pt of p) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
		lower.push(pt);
	}
	const upper = [];
	for (let i = p.length - 1; i >= 0; i--) {
		const pt = p[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
		upper.push(pt);
	}
	upper.pop();
	lower.pop();
	return lower.concat(upper);
}

// Gb.aabb: axis-aligned bounding box as 4 corners (BL, BR, TR, TL).
function aabb(pts) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of pts) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return [new Point(minX, minY), new Point(maxX, minY), new Point(maxX, maxY), new Point(minX, maxY)];
}

// Gb.obb: minimum-area oriented bounding box (rotating calipers over the convex hull).
// Returns 4 corner points in the polygon's original orientation.
function obb(poly) {
	const hull = convexHull(poly);
	if (hull == null || hull.length < 3) return aabb(poly);
	let bestArea = Infinity;
	let best = null;
	let bestDir = null;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i];
		const b = hull[(i + 1) % hull.length];
		if (a.x === b.x && a.y === b.y) continue;
		const dir = b.subtract(a);
		dir.normalize(1);
		const cos = dir.x;
		const sin = dir.y;
		// rotate hull so this edge is axis-aligned: l = x*cos + y*sin, m = y*cos - x*sin
		let minL = Infinity;
		let maxL = -Infinity;
		let minM = Infinity;
		let maxM = -Infinity;
		for (const p of hull) {
			const l = p.x * cos + p.y * sin;
			const m = p.y * cos - p.x * sin;
			if (l < minL) minL = l;
			if (l > maxL) maxL = l;
			if (m < minM) minM = m;
			if (m > maxM) maxM = m;
		}
		const area = (maxL - minL) * (maxM - minM);
		if (area < bestArea) {
			bestArea = area;
			best = [new Point(minL, minM), new Point(maxL, minM), new Point(maxL, maxM), new Point(minL, maxM)];
			bestDir = dir;
		}
	}
	// rotate back by +theta (asRotateYX(best, sin, cos)): x = l*cos - m*sin ; y = m*cos + l*sin
	const cos = bestDir.x;
	const sin = bestDir.y;
	return best.map((p) => new Point(p.x * cos - p.y * sin, p.y * cos + p.x * sin));
}

// Gb.containsPoint: even-odd ray cast (default c=false => strict interior test).
function containsPoint(poly, pt) {
	let inside = false;
	const n = poly.length;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const a = poly[j];
		const b = poly[i];
		if ((a.y > pt.y) !== (b.y > pt.y)) {
			const xCross = a.x + ((pt.y - a.y) * (b.x - a.x)) / (b.y - a.y);
			if (pt.x < xCross) inside = !inside;
		}
	}
	return inside;
}

// Signed area of a triangle [a,b,c] (== Sa.area on a 3-gon).
function triArea(tri) {
	const a = tri[0];
	const b = tri[1];
	const c = tri[2];
	return 0.5 * ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

// Qe.getCircle(a, b, c, d): circle tangent to direction `b` at point `a` AND to
// direction `d` at point `c`. Centre = a + perp(b)*t, radius = |b|*t, where t is the
// signed distance along the normal at `a` to the normal-line through `c`.
function getCircle(a, b, c, d) {
	const t = GeomUtils.intersectLines(a.x, a.y, -b.y, b.x, c.x, c.y, -d.y, d.x);
	if (t == null) return null;
	const center = new Point(a.x - b.y * t.x, a.y + b.x * t.x);
	const radius = b.length * t.x;
	return new Circle(center, radius);
}

// Qe.getArc(circle, a0, a1, minSeg): sample the shorter arc between angles a0..a1 with
// roughly minSeg-length segments. Returns null if the arc is too short to subdivide.
function getArc(circle, a0, a1, minSeg) {
	if (a0 - a1 > Math.PI) a0 -= 2 * Math.PI;
	else if (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
	const r = Math.abs(circle.r);
	let count = Math.floor((Math.abs(a0 - a1) * r) / minSeg);
	if (count >= 2) {
		const pts = [];
		for (let k = 0; k < count; k++) {
			const t = k / (count - 1);
			pts.push(new Point(circle.c.x + r * Math.cos(a0 + (a1 - a0) * t), circle.c.y + r * Math.sin(a0 + (a1 - a0) * t)));
		}
		return pts;
	}
	return null;
}

// Fit a tangent arc to the elbow [b, c, d]. Returns the arc points (including b and d)
// or null if no valid arc can be fit. Shared by both keepElbow and straighten branches.
function fitArc(b, c, d, v1, v2, n, p, minFront) {
	if (n < p) {
		const r = n / p;
		const c2 = new Point(c.x + v2.x * r, c.y + v2.y * r);
		const circ = getCircle(b, v1, c2, v2);
		if (!circ) return null;
		const a0 = Math.atan2(b.y - circ.c.y, b.x - circ.c.x);
		const a1 = Math.atan2(c2.y - circ.c.y, c2.x - circ.c.x);
		const arc = getArc(circ, a0, a1, minFront);
		if (arc != null) {
			arc.push(d);
			return arc;
		}
		return null;
	} else {
		const r = -p / n;
		const c2 = new Point(c.x + v1.x * r, c.y + v1.y * r);
		const circ = getCircle(c2, v1, d, v2);
		if (!circ) return null;
		const a0 = Math.atan2(c2.y - circ.c.y, c2.x - circ.c.x);
		const a1 = Math.atan2(d.y - circ.c.y, d.x - circ.c.x);
		const arc = getArc(circ, a0, a1, minFront);
		if (arc != null) {
			arc.unshift(b);
			return arc;
		}
		return null;
	}
}

// Qe.semiSmooth(tri): tri = [b, c, d] — entry, elbow, exit of a bent cut. Either keep the
// elbow, straighten it to [b, d], or replace it with a circular arc tangent to segment
// b->c at b and to c->d at d (c adjusted so the two tangent lengths match the arc).
function semiSmooth(tri, minFront) {
	const b = tri[0];
	const c = tri[1];
	const d = tri[2];
	const chord = Point.distance(b, d);
	if (chord < 1e-10) return [b, d];

	const v1 = c.subtract(b); // b -> c
	const v2 = d.subtract(c); // c -> d
	const n = v1.length;
	const p = v2.length;
	if (n < 1e-10 || p < 1e-10) return [b, d];
	const f = minFront;

	// Always try the ARC first. If it fits, use it — arcs produce the interesting
	// curved building shapes. If it doesn't fit, keep the raw 3-point elbow (never
	// straighten to [b, d], since the elbow already has a bend by construction).
	const arc = fitArc(b, c, d, v1, v2, n, p, f);
	if (arc) return arc;

	// Arc didn't fit — keep the elbow as-is (it's still a bent cut, just not a
	// smooth arc). This is much more interesting than a straight line.
	return tri;
}

// Replace the elbow [b, c, d] with a quadratic Bezier curve from entry b to exit d that
// bulges toward the bend c, sampled into a smooth polyline. This is the "walkway" cut used by
// parks: a true bezier spline alternative to semiSmooth's tangent circular arc.
function bezierSmooth(tri, minSeg) {
	const b = tri[0];
	const c = tri[1];
	const d = tri[2];
	const chord = Point.distance(b, d);
	if (chord < 1e-10) return [b, d];
	const approxLen = Point.distance(b, c) + Point.distance(c, d);
	const step = Math.max(minSeg * 0.4, 1e-3);
	let count = Math.round(approxLen / step);
	if (count < 4) count = 4;
	if (count > 24) count = 24;
	const pts = [];
	for (let i = 0; i < count; i++) {
		const t = i / (count - 1);
		const mt = 1 - t;
		pts.push(new Point(
			mt * mt * b.x + 2 * mt * t * c.x + t * t * d.x,
			mt * mt * b.y + 2 * mt * t * c.y + t * t * d.y
		));
	}
	return pts;
}

// ji.detectStraight: default processCut — straighten a nearly-flat elbow.
function detectStraight(tri, minTurnOffset) {
	if (minTurnOffset > 0) {
		const b = tri[0];
		const d = tri[2];
		if (Math.abs(triArea(tri)) / Point.distance(b, d) < minTurnOffset) return [b, d];
	}
	return tri;
}

// Split `poly` along a cut polyline. The cut enters edge `e1` at `cut[0]` and exits edge
// `e2` at `cut[cut.length-1]`. Returns the two boundary halves plus, for each half, the
// index range of the edges that lie along the cut polyline (those get the alley gap).
// Port of ji.split, but builds the halves geometrically and tracks the cut-chain range.
function splitAlong(poly, e1, e2, cut) {
	const n = poly.length;
	const en = cut[0];
	const ex = cut[cut.length - 1];
	const cutN = cut.length - 1; // number of cut segments (== cut edges per half)
	const interior = cut.slice(1, cut.length - 1); // [c1 .. c_{N-1}]
	const interiorRev = interior.slice().reverse();

	// Original-vertex arc from just after e1 up to e2 (en ... ex).
	const arcF = [];
	for (let i = (e1 + 1) % n; ; i = (i + 1) % n) {
		arcF.push(poly[i]);
		if (i === e2) break;
	}
	// Complementary arc from just after e2 up to e1 (ex ... en).
	const arcB = [];
	for (let i = (e2 + 1) % n; ; i = (i + 1) % n) {
		arcB.push(poly[i]);
		if (i === e1) break;
	}

	// Each half's boundary = one original arc + the cut polyline (reversed in one half).
	// The cut-chain occupies vertex indices [arc.length+1 .. half.length-1] inclusive,
	// i.e. cut edges with start-vertex index in [arc.length+1, arc.length+cutN].
	const half1 = new Polygon([en, ...arcF, ex, ...interiorRev]);
	const half2 = new Polygon([ex, ...arcB, en, ...interior]);
	const ranges = [
		{ start: arcF.length + 1, count: cutN },
		{ start: arcB.length + 1, count: cutN },
	];
	return { halves: [half1, half2], ranges };
}

// Inset only the cut-chain edges of a half by gap/2 (the alley gap), leaving the original
// block boundary untouched. Uses peel per cut edge (the same mechanism as Polygon.cut's gap
// param), which insets each edge inward as a parallel line — no diagonal "step" artifacts.
function insetCutChainEdges(half, start, count, gap) {
	if (!half || half.length < 3 || !(gap > 0) || count <= 0) return half;
	const n = half.length;
	const area0 = Math.abs(half.square);
	let result = half;
	try {
		for (let j = 0; j < count; j++) {
			const idx = (start + j) % result.length;
			result = result.peel(result[idx], gap / 2);
			if (!result || result.length < 3) return half;
		}
	} catch (e) {
		return half;
	}
	if (!result || result.length < 3 || Math.abs(result.square) < area0 * 0.15) return half;
	return result;
}

function offsetCutChainEdges(half, start, count, gap) {
	if (!half || half.length < 3 || !(gap > 0) || count <= 0) return half;
	const n = half.length;
	const area0 = Math.abs(half.square);
	const rotated = half.slice(start).concat(half.slice(0, start));
	if (count >= rotated.length) return half;

	const d = gap / 2;
	const areaSign = half.square >= 0 ? 1 : -1;
	const lines = [];
	for (let i = 0; i < count; i++) {
		const a = rotated[i];
		const b = rotated[i + 1];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		if (len < 1e-9) return half;
		const nx = (-dy / len) * d * areaSign;
		const ny = (dx / len) * d * areaSign;
		lines.push({ p: new Point(a.x + nx, a.y + ny), dx, dy, nx, ny });
	}

	const boundaryIntersection = (line, a, b, fallback) => {
		const edge = b.subtract(a);
		if (edge.length < 1e-9) return fallback;
		const hit = GeomUtils.intersectLines(line.p.x, line.p.y, line.dx, line.dy, a.x, a.y, edge.x, edge.y);
		if (!hit || hit.y < -1e-5 || hit.y > 1 + 1e-5) return fallback;
		const p = new Point(a.x + edge.x * hit.y, a.y + edge.y * hit.y);
		return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : fallback;
	};

	const startFallback = new Point(rotated[0].x + lines[0].nx, rotated[0].y + lines[0].ny);
	const offset = [boundaryIntersection(lines[0], rotated[rotated.length - 1], rotated[0], startFallback)];
	for (let i = 1; i < count; i++) {
		const prev = lines[i - 1];
		const next = lines[i];
		const hit = GeomUtils.intersectLines(prev.p.x, prev.p.y, prev.dx, prev.dy, next.p.x, next.p.y, next.dx, next.dy);
		const original = rotated[i];
		let p = hit ? new Point(prev.p.x + prev.dx * hit.x, prev.p.y + prev.dy * hit.x) : null;
		if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Point.distance(original, p) > gap * 3) {
			p = new Point(
				original.x + (prev.nx + next.nx) / 2,
				original.y + (prev.ny + next.ny) / 2
			);
		}
		offset.push(p);
	}
	const last = lines[lines.length - 1];
	const endFallback = new Point(rotated[count].x + last.nx, rotated[count].y + last.ny);
	offset.push(boundaryIntersection(last, rotated[count], rotated[count + 1], endFallback));

	const result = new Polygon(offset.concat(rotated.slice(count + 1)));
	if (
		!result ||
		result.length < 3 ||
		!result.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ||
		Math.abs(result.square) < area0 * 0.15
	) return half;
	return result;
}

export function slicePolygonAlongElbow(poly, entryEdge, exitEdge, cut, gap = 0) {
	if (!poly || poly.length < 3 || !cut || cut.length < 2) return { lots: poly ? [new Polygon(poly)] : [], alley: cut || [] };
	if (entryEdge === exitEdge || entryEdge < 0 || exitEdge < 0 || entryEdge >= poly.length || exitEdge >= poly.length)
		return { lots: [new Polygon(poly)], alley: cut };

	const split = splitAlong(poly, entryEdge, exitEdge, cut);
	let lots = split.halves;
	if (gap > 0) {
		lots = lots.map((lot, i) => offsetCutChainEdges(lot, split.ranges[i].start, split.ranges[i].count, gap));
	}
	return { lots: lots.filter((lot) => lot && lot.length >= 3), alley: cut };
}

// OBB for a given unit direction: axis-aligned bounding box in the h/k frame, returned
// as 4 world-space corners (BL, BR, TR, TL) — same format as Gb.obb/aabb.
function orientedAABB(pts, hDir) {
	const kDir = new Point(-hDir.y, hDir.x);
	let minH = Infinity;
	let maxH = -Infinity;
	let minK = Infinity;
	let maxK = -Infinity;
	for (const v of pts) {
		const ph = v.x * hDir.x + v.y * hDir.y;
		const pk = v.x * kDir.x + v.y * kDir.y;
		if (ph < minH) minH = ph;
		if (ph > maxH) maxH = ph;
		if (pk < minK) minK = pk;
		if (pk > maxK) maxK = pk;
	}
	const bl = new Point(minH * hDir.x + minK * kDir.x, minH * hDir.y + minK * kDir.y);
	const br = new Point(maxH * hDir.x + minK * kDir.x, maxH * hDir.y + minK * kDir.y);
	const tr = new Point(maxH * hDir.x + maxK * kDir.x, maxH * hDir.y + maxK * kDir.y);
	const tl = new Point(minH * hDir.x + maxK * kDir.x, minH * hDir.y + maxK * kDir.y);
	return [bl, br, tr, tl];
}

// --- Bisector: recursive curved partitioner (port of com.watabou.mfcg.utils.Bisector) ---

export class Bisector {
	constructor(poly, minArea, variance = 10) {
		this.cuts = []; // collected alley centerlines (arrays of Points)
		this.minTurnOffset = 1;
		this.shape = poly;
		this.minArea = minArea;
		this.variance = variance;
		this.minOffset = Math.sqrt(minArea);
		this.processCut = (tri) => detectStraight(tri, this.minTurnOffset);
		this.isAtomic = (p) => this.isSmallEnough(p);
		this.getGap = null;
		this.primaryDir = null;
		this.directionJitter = 0.35;
		this.preserveElbowPocket = false;
		this.elbowAngleMin = Math.PI / 9;
		this.elbowAngleMax = Math.PI / 2;
	}

	partition() {
		return this.subdivide(this.shape, 0);
	}

	subdivide(a, depth) {
		if (depth > 30) return [a];
		if (this.isAtomic(a)) return [a];
		const parts = this.makeCut(a, 0);
		if (parts.length < 2) return [a];
		let out = [];
		for (const p of parts) out = out.concat(this.subdivide(p, depth + 1));
		return out;
	}

	isSmallEnough(a) {
		const jitter = Math.abs((Random.float() + Random.float() + Random.float() + Random.float()) / 2 - 1);
		return Math.abs(a.square) < this.minArea * Math.pow(this.variance, jitter);
	}

	// makeCut: split polygon `a` with an arc cut. Uses the OBB long axis to pick the cut
	// direction, finds an entry/exit pair of edges, then makes a 3-point elbow cut whose
	// middle point is offset from the straight line — semiSmooth then replaces it with a
	// tangent arc. Retries with rotated orientations if the cut is too unbalanced.
	makeCut(a, attempt = 0) {
		if (attempt > 10) return [a];
		if (Math.abs(a.square) < 1e-9) return [a];
		const c = a.length;

		// Cut axis: OBB on the first attempt, rotated AABB on retries.
		let corners;
		if (this.primaryDir) {
			const base = Math.atan2(this.primaryDir.y, this.primaryDir.x);
			const jitter = (Random.float() - 0.5) * this.directionJitter + attempt * 0.17;
			const dir = polar(1, base + jitter);
			corners = orientedAABB(a, dir);
		} else if (attempt > 0) {
			const dir = polar(1, (attempt / 10) * Math.PI * 2);
			const rot = rotateYX(a, dir.y, dir.x);
			corners = rotateYX(aabb(rot), -dir.y, dir.x);
		} else {
			corners = obb(a);
		}
		const corner0 = corners[0];
		let h = corners[1].subtract(corner0);
		let k = corners[3].subtract(corner0);
		if (h.length < k.length) { const t = h; h = k; k = t; }

		// Cut origin: centroid projected onto the long axis, jittered.
		let cen = a.centroid;
		if (!(isFinite(cen.x) && isFinite(cen.y))) cen = a.center;
		let f = project(h, cen.subtract(corner0));
		f = (f + Random.normal()) / 2;
		const p = new Point(corner0.x + h.x * f, corner0.y + h.y * f);

		// Entry edge: most-aligned-with-h edge crossed by the line p + t*k.
		let edge1 = -1;
		let entryPt = null;
		let entryDir = null;
		let bestAlign = 0;
		for (let r = 0; r < c; r++) {
			const l = a[r];
			const nx = a[(r + 1) % c];
			const ev = nx.subtract(l);
			if (ev.length < 1e-10) continue;
			const hit = GeomUtils.intersectLines(p.x, p.y, k.x, k.y, l.x, l.y, ev.x, ev.y);
			if (hit != null && hit.y > 0 && hit.y < 1) {
				const w = ev.norm(1);
				const align = Math.abs(h.x * w.x + h.y * w.y);
				if (align > bestAlign) {
					bestAlign = align;
					edge1 = r;
					entryPt = new Point(l.x + ev.x * hit.y, l.y + ev.y * hit.y);
					entryDir = w;
				}
			}
		}
		if (edge1 === -1) return [a];

		// Cut direction g = perpendicular to the entry edge.
		const g = new Point(-entryDir.y, entryDir.x);

		// Exit edge: closest edge crossed by g from entryPt.
		let edge2 = -1;
		let exitDir = null;
		let bestParam = Infinity;
		for (let r = 0; r < c; r++) {
			if (r === edge1) continue;
			const l = a[r];
			const nx = a[(r + 1) % c];
			const ev = nx.subtract(l);
			if (ev.length < 1e-10) continue;
			const hit = GeomUtils.intersectLines(entryPt.x, entryPt.y, g.x, g.y, l.x, l.y, ev.x, ev.y);
			if (hit != null && hit.x > 0 && hit.x < bestParam && hit.y > 0 && hit.y < 1) {
				bestParam = hit.x;
				exitDir = ev;
				edge2 = r;
			}
		}
		if (edge2 === -1) return [a];

		// Elbow cut: step along g from entryPt, then find a third edge to bend toward.
		let off = this.minOffset / bestParam;
		off = off > 0.5 ? 0.5 : off + (1 - 2 * off) * Random.normal();
		const offDist = bestParam * off;
		const elbow = new Point(entryPt.x + g.x * offDist, entryPt.y + g.y * offDist);

		let edge3 = -1;
		let exitPt = null;
		let bestW = -Infinity;
		for (let r = 0; r < c; r++) {
			if (r === edge1) continue;
			const l = a[r];
			const nx = a[(r + 1) % c];
			const ev = nx.subtract(l);
			const D = ev.length;
			if (D < 1e-10) continue;
			const hit = GeomUtils.intersectLines(elbow.x, elbow.y, ev.y, -ev.x, l.x, l.y, ev.x, ev.y);
			if (hit == null || !(hit.x > 0) || !(hit.y > 0 && hit.y < 1)) continue;
			const w = (g.x * ev.y - g.y * ev.x) / D;
			if (!(w > bestW)) continue;
			let clear = true;
			for (let y = 0; y < c && clear; y++) {
				if (y === r || y === edge1) continue;
				const l2 = a[y];
				const e2 = a[(y + 1) % c].subtract(l2);
				if (e2.length < 1e-10) continue;
				const h2 = GeomUtils.intersectLines(elbow.x, elbow.y, ev.y, -ev.x, l2.x, l2.y, e2.x, e2.y);
				if (h2 != null && h2.x >= 0 && h2.x <= 1 && h2.y >= 0 && h2.y <= 1) clear = false;
			}
			if (clear) {
				bestW = w;
				edge3 = r;
				exitPt = new Point(l.x + ev.x * hit.y, l.y + ev.y * hit.y);
			}
		}

		if (exitPt != null) {
			const tri = [entryPt, this.variedElbow(entryPt, elbow, exitPt, a), exitPt];
			let cut = this.processCut(tri); // semiSmooth: always tries arc first
			// validate arc interior points lie inside the polygon
			for (let m = 1; m < cut.length - 1; m++) {
				if (!containsPoint(a, cut[m])) { cut = tri; break; }
			}
			const splitCut = this.preserveElbowPocket ? [entryPt, exitPt] : cut;
			const sp = splitAlong(a, edge1, edge3, splitCut);
			const a0 = Math.abs(sp.halves[0].square);
			const a1 = Math.abs(sp.halves[1].square);
			if (a0 < 1e-9 || a1 < 1e-9 || Math.max(a0 / a1, a1 / a0) > 2 * this.variance) {
				return this.makeCut(a, attempt + 1);
			}
			return this.acceptCut(a, sp.halves, sp.ranges, cut, attempt);
		}

		// Fallback: straight cut if no elbow exit found.
		const exit = new Point(entryPt.x + g.x * bestParam, entryPt.y + g.y * bestParam);
		const cut = [entryPt, exit];
		const sp = splitAlong(a, edge1, edge2, cut);
		const a0 = Math.abs(sp.halves[0].square);
		const a1 = Math.abs(sp.halves[1].square);
		if (a0 > 1e-9 && a1 > 1e-9 && Math.max(a0 / a1, a1 / a0) < 2 * this.variance) {
			return this.acceptCut(a, sp.halves, sp.ranges, cut, attempt);
		}

		return this.makeCut(a, attempt + 1);
	}

	variedElbow(entry, fallback, exit, poly) {
		const chord = exit.subtract(entry);
		const len = chord.length;
		if (len < 1e-6) return fallback;
		const mid = new Point((entry.x + exit.x) / 2, (entry.y + exit.y) / 2);
		const n = new Point(-chord.y / len, chord.x / len);
		const side = Math.sign((fallback.x - entry.x) * chord.y - (fallback.y - entry.y) * chord.x) || (Random.bool() ? 1 : -1);
		const turn = this.elbowAngleMin + Random.float() * (this.elbowAngleMax - this.elbowAngleMin);
		const height = Math.tan(turn / 2) * len * 0.5;
		for (const s of [side, -side]) {
			for (const scale of [1, 0.75, 0.5, 0.3]) {
				const p = new Point(mid.x + n.x * height * scale * s, mid.y + n.y * height * scale * s);
				if (containsPoint(poly, p)) return p;
			}
		}
		return fallback;
	}

	acceptCut(source, halves, ranges, cut, attempt) {
		if (this.validateCut && !this.validateCut(source, halves, ranges, cut)) {
			return this.makeCut(source, attempt + 1);
		}
		this.cuts.push(cut);
		return halves;
	}
}

// One-shot arc-cut ward subdivision.
// 1. Partition the block with arc cuts (Bisector + semiSmooth) — no gap during cutting.
// 2. Uniformly shrink each final lot by gap/2 to create the alley gap between buildings.
//
// params: { minSq, blockSize, gridChaos, sizeChaos, gap, emptyProb? }
export function sliceWard(block, params) {
	const minSq = params.minSq;
	const blockSize = params.blockSize;
	const gridChaos = params.gridChaos;
	const sizeChaos = params.sizeChaos;
	const gap = params.gap;
	const emptyProb = params.emptyProb != null ? params.emptyProb : 0;

	const minArea = minSq * blockSize;
	const variance = 16 * gridChaos;
	const minFront = Math.sqrt(minSq);

	const bisector = new Bisector(block, minArea, variance);
	bisector.processCut = (tri) =>
		params.bezierCuts ? bezierSmooth(tri, minFront)
			: params.elbowOnly ? tri
				: semiSmooth(tri, minFront);
	bisector.getGap = null;
	if (params.primaryDir) {
		bisector.primaryDir = params.primaryDir;
		bisector.directionJitter = params.directionJitter != null ? params.directionJitter : 0.35;
	}
	bisector.preserveElbowPocket = !!params.preserveElbowPocket;
	if (params.elbowAngleMin != null) bisector.elbowAngleMin = params.elbowAngleMin;
	if (params.elbowAngleMax != null) bisector.elbowAngleMax = params.elbowAngleMax;
	bisector.isAtomic = (p) => Math.abs(p.square) < minSq * Math.pow(2, 4 * sizeChaos * (Random.float() - 0.5));
	const minLotWidth = gap > 0 ? 2 * gap : 0;
	// Reject/remove lots that pinch to a thin neck (a waist OBB min-width can't see). The
	// cutter validates full-size lots, which lose ~gap of neck to the later shrink(gap/2),
	// so it uses the larger budget `neckFloor + gap`; `neckFloor` is the post-shrink floor.
	const neckFloor = params.minLotNeck != null ? params.minLotNeck : (gap > 0 ? gap * 1.2 : 0);
	const cutNeck = neckFloor > 0 ? neckFloor + gap : 0;
	if (params.minLotArea != null || minLotWidth > 0 || cutNeck > 0 || params.minLotAngle != null) {
		bisector.validateCut = (source, halves, ranges) => {
			for (let i = 0; i < halves.length; i++) {
				const lot = halves[i];
				if (!lot || lot.length < 3) return false;
				if (minLotWidth > 0 && lotMinWidth(lot) < minLotWidth) return false;
				if (params.minLotArea != null && Math.abs(lot.square) < params.minLotArea) return false;
				if (params.minLotAngle != null && minAngle(lot) < params.minLotAngle) return false;
				if (cutNeck > 0 && nonLocalMinNeckWidth(lot, cutNeck * 1.35) < cutNeck) return false;
			}
			return true;
		};
	}

	let lots = params.maxCuts === 1 ? bisector.makeCut(block, 0) : bisector.partition();

	// Shrink each final lot by gap/2 to create the alley gap between adjacent buildings.
	if (gap > 0) {
		lots = lots.map((lot) => {
			if (!lot || lot.length < 3) return lot;
			const area0 = Math.abs(lot.square);
			try {
				const shrunk = lot.shrinkRobust(gap / 2);
				if (shrunk && shrunk.length >= 3 && Math.abs(shrunk.square) > area0 * 0.2) return shrunk;
			} catch (e) { /* fall back to full-size lot */ }
			return lot;
		});
	}

	// TEMP: keep lots even when the variable one-sided setback makes a thin neck. Re-enable once
	// setback-aware validation can distinguish ugly geometry from whole missing buildings.
	// if (neckFloor > 0) lots = lots.filter((lot) => lot && lot.length >= 3 && minNeckWidth(lot) >= neckFloor);

	// Post-process: chamfer corners sharper than chamferAngle (default 30°). Sharp slivers
	// fall out of the arc cuts; bevel them so buildings don't end in needle points.
	if (params.chamfer !== false) {
		const chamferAngle = params.chamferAngle != null ? params.chamferAngle : Math.PI / 6;
		const chamferSize = params.chamferSize != null ? params.chamferSize : (gap > 0 ? gap : minFront * 0.5);
		lots = chamferLots(lots, chamferAngle, chamferSize, params.chamferEdgeFrac);
	}

	if (emptyProb > 0) lots = lots.filter(() => Random.bool(1 - emptyProb));
	return { lots, alleys: bisector.cuts };
}

export function lotMinWidth(poly) {
	if (!poly || poly.length < 3) return 0;
	const corners = obb(poly);
	const w = Point.distance(corners[0], corners[1]);
	const h = Point.distance(corners[1], corners[2]);
	return Math.min(w, h);
}

function weightedRandomEdgeIndex(poly) {
	let total = 0;
	const weights = [];
	for (let i = 0; i < poly.length; i++) {
		const len = Point.distance(poly[i], poly[(i + 1) % poly.length]);
		const w = len * len;
		weights.push(w);
		total += w;
	}
	let r = Random.float() * total;
	for (let i = 0; i < poly.length; i++) {
		r -= weights[i];
		if (r <= 0) return i;
	}
	return poly.length - 1;
}

function inwardNormal(poly, edgeIndex) {
	const a = poly[edgeIndex];
	const b = poly[(edgeIndex + 1) % poly.length];
	const edge = b.subtract(a);
	if (edge.length < 1e-6) return new Point(0, 0);
	let n = edge.rotate90().norm(1);
	const mid = new Point((a.x + b.x) / 2, (a.y + b.y) / 2);
	const probe = mid.add(n.scale(0.5));
	if (!containsPoint(poly, probe)) n = n.scale(-1);
	return n;
}

function rotateDir(v, angle) {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return new Point(v.x * c - v.y * s, v.x * s + v.y * c);
}

function rayExit(poly, origin, dir, skipEdge = -1, minT = 1e-5) {
	let best = null;
	for (let i = 0; i < poly.length; i++) {
		if (i === skipEdge) continue;
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const ev = b.subtract(a);
		if (ev.length < 1e-10) continue;
		const hit = GeomUtils.intersectLines(origin.x, origin.y, dir.x, dir.y, a.x, a.y, ev.x, ev.y);
		if (hit && hit.x > minT && hit.y > 1e-5 && hit.y < 1 - 1e-5) {
			if (!best || hit.x < best.t) {
				best = {
					t: hit.x,
					edge: i,
					point: new Point(origin.x + dir.x * hit.x, origin.y + dir.y * hit.x),
				};
			}
		}
	}
	return best;
}

function minAngle(poly) {
	if (!poly || poly.length < 3) return 0;
	let best = Infinity;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[(i + poly.length - 1) % poly.length];
		const b = poly[i];
		const c = poly[(i + 1) % poly.length];
		const u = a.subtract(b);
		const v = c.subtract(b);
		if (u.length < 1e-6 || v.length < 1e-6) return 0;
		const cos = Math.max(-1, Math.min(1, u.dot(v) / (u.length * v.length)));
		best = Math.min(best, Math.acos(cos));
	}
	return best;
}

// Chamfer (bevel off) any corner whose interior angle is below `minAngle`. The sharp tip
// is replaced by two vertices, each moved back along an adjacent edge by `size`. The cut is
// clamped per-corner to `edgeFrac` of the SHORTER adjacent edge, so a chamfer never overruns
// a short edge nor collides with the chamfer of an adjacent sharp corner (2*edgeFrac < 1).
// New vertices are computed from the original geometry, so adjacent corners don't interfere.
function chamferSharpCorners(poly, minAngle, size, edgeFrac = 0.4) {
	if (!poly || poly.length < 3 || !(size > 0)) return poly;
	const n = poly.length;
	const out = [];
	let changed = false;
	for (let i = 0; i < n; i++) {
		const v = poly[i];
		const prev = poly[(i + n - 1) % n];
		const next = poly[(i + 1) % n];
		const u = prev.subtract(v); // v -> prev
		const w = next.subtract(v); // v -> next
		const lu = u.length;
		const lw = w.length;
		if (lu < 1e-9 || lw < 1e-9) { out.push(v); continue; }
		const cos = Math.max(-1, Math.min(1, u.dot(w) / (lu * lw)));
		if (Math.acos(cos) >= minAngle) { out.push(v); continue; }
		const d = Math.min(size, Math.min(lu, lw) * edgeFrac);
		if (!(d > 1e-9)) { out.push(v); continue; }
		const p1 = v.add(u.norm(d)); // back toward prev
		const p2 = v.add(w.norm(d)); // back toward next
		out.push(p1);
		out.push(p2);
		// The beveled-off sharp tip (v, p1, p2) becomes a tree/fountain.
		recordRemovedTriangle(v, p1, p2);
		changed = true;
	}
	return changed ? new Polygon(out) : poly;
}

// Apply chamferSharpCorners to every lot, falling back to the original lot on any failure.
function chamferLots(lots, minAngle, size, edgeFrac) {
	if (!(size > 0)) return lots;
	return lots.map((lot) => {
		if (!lot || lot.length < 3) return lot;
		try {
			const c = chamferSharpCorners(lot, minAngle, size, edgeFrac);
			if (c && c.length >= 3) return c;
		} catch (e) { /* fall back to un-chamfered lot */ }
		return lot;
	});
}

// In ~`prob` of lots, set back ONE side deeper than the rest: clip a single random edge inward
// by an extra normal-random amount, scaled to up to double the usual gap/2 inset (mean ~the
// usual, ranging 0..~gap). If that would leave a tiny remnant, keep the uniformly-shrunk lot.
function isConvexInsetCorner(poly, i) {
	if (!poly || poly.length < 3) return false;
	const n = poly.length;
	const prev = poly[(i + n - 1) % n];
	const cur = poly[i];
	const next = poly[(i + 1) % n];
	const ux = cur.x - prev.x;
	const uy = cur.y - prev.y;
	const vx = next.x - cur.x;
	const vy = next.y - cur.y;
	const turn = ux * vy - uy * vx;
	const sign = poly.square >= 0 ? 1 : -1;
	return turn * sign > 1e-7;
}

function shuffledEdgeIndices(count) {
	const out = [];
	for (let i = 0; i < count; i++) out.push(i);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Random.int(0, i + 1);
		const t = out[i];
		out[i] = out[j];
		out[j] = t;
	}
	return out;
}

function setbackTouchesOnlyChosenSide(parts, edgeIndex, vertexCount) {
	if (!parts || parts.crossings !== 2) return false;
	const nextIndex = (edgeIndex + 1) % vertexCount;
	const allowed = new Set([edgeIndex, nextIndex]);
	if (!parts.removedOriginalIndices || parts.removedOriginalIndices.length !== 2) return false;
	for (const i of parts.removedOriginalIndices) if (!allowed.has(i)) return false;
	return allowed.has(parts.removedOriginalIndices[0]) && allowed.has(parts.removedOriginalIndices[1]);
}

function shrinkOneSideDeeper(lot, gap, prob, minArea = 0, minNeck = 0, minNeckLocalSkip = 0) {
	if (!lot || lot.length < 3 || !(gap > 0) || !(prob > 0)) return lot;
	if (!Random.bool(prob)) return lot;
	const extra = Random.normal() * gap; // mean ~gap/2 (the usual distance), up to ~gap (double)
	if (!(extra > 1e-6)) return lot;
	const area0 = Math.abs(lot.square);
	const width0 = lotMinWidth(lot);
	if (!(width0 > gap * 1.5)) return lot;
	const distance = Math.min(extra, width0 * 0.22);
	if (!(distance > 1e-6)) return lot;

	for (const idx of shuffledEdgeIndices(lot.length)) {
		const nextIndex = (idx + 1) % lot.length;
		if (!isConvexInsetCorner(lot, idx) || !isConvexInsetCorner(lot, nextIndex)) continue;
		try {
			const clippedParts = splitOneSideInset(lot, idx, distance);
			if (!setbackTouchesOnlyChosenSide(clippedParts, idx, lot.length)) continue;
			const clipped = clippedParts ? clippedParts.kept : null;
			if (
				clipped &&
				clipped.length >= 3 &&
				clipped.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) &&
				Math.abs(clipped.square) > Math.max(area0 * 0.72, minArea > 0 ? minArea * 0.75 : 0) &&
				lotMinWidth(clipped) > Math.max(gap * 0.55, width0 * 0.45) &&
				(minNeck <= 0 || nonLocalMinNeckWidth(clipped, minNeckLocalSkip) >= minNeck)
			) return clipped;
		} catch (e) {
			// Try another edge; if none work, keep the uniformly-shrunk lot.
		}
	}
	return lot;
}

function compactInsetPoints(points) {
	const out = [];
	for (const p of points) {
		if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
		const last = out[out.length - 1];
		if (!last || Point.distance(last, p) > 1e-6) out.push(p);
	}
	if (out.length > 1 && Point.distance(out[0], out[out.length - 1]) <= 1e-6) out.pop();
	return out;
}

function splitOneSideInset(lot, edgeIndex, distance) {
	const n = lot.length;
	if (n < 3 || !(distance > 0)) return null;
	const a = lot[edgeIndex];
	const b = lot[(edgeIndex + 1) % n];
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	const areaSign = lot.square >= 0 ? 1 : -1;
	if (len < 1e-9) return null;

	const ax = a.x + (-dy / len) * distance * areaSign;
	const ay = a.y + (dx / len) * distance * areaSign;
	const signed = (p) => (dx * (p.y - ay) - dy * (p.x - ax)) * areaSign;
	const intersect = (p, q) => {
		const sx = q.x - p.x;
		const sy = q.y - p.y;
		const t = GeomUtils.intersectLines(ax, ay, dx, dy, p.x, p.y, sx, sy);
		if (!t) return p;
		return new Point(p.x + sx * t.y, p.y + sy * t.y);
	};

	const kept = [];
	const removed = [];
	const removedOriginalIndices = [];
	let crossings = 0;
	let prev = lot[n - 1];
	let prevD = signed(prev);
	let prevInside = prevD >= -1e-7;
	for (let i = 0; i < n; i++) {
		const cur = lot[i];
		const curD = signed(cur);
		const curInside = curD >= -1e-7;
		const curRemoved = curD <= 1e-7;
		if (curInside !== prevInside) {
			crossings++;
			const hit = intersect(prev, cur);
			kept.push(hit);
			removed.push(hit);
		}
		if (curInside) kept.push(cur);
		if (curRemoved) {
			removed.push(cur);
			removedOriginalIndices.push(i);
		}
		prev = cur;
		prevD = curD;
		prevInside = curInside;
	}
	return {
		kept: new Polygon(compactInsetPoints(kept)),
		removed: new Polygon(compactInsetPoints(removed)),
		removedOriginalIndices,
		crossings,
	};
}

// Distance from point p to segment [a, b].
function pointSegmentDistance(p, a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const l2 = dx * dx + dy * dy;
	if (l2 < 1e-12) return Point.distance(p, a);
	let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

// Minimum "neck" width: the smallest distance from any vertex to any edge NOT incident to
// it. For a convex or uniformly-thin lot this is ~its width; for a pinched/waisted lot it
// collapses to the width of the constriction. This catches thin necks (an lot that is wide
// overall but joined through a hairline) that OBB min-width — lotMinWidth — cannot see.
// O(n^2), but lots have a handful of vertices. Triangles can't pinch, so they return Inf.
function minNeckWidth(poly) {
	if (!poly || poly.length < 4) return Infinity;
	const n = poly.length;
	let best = Infinity;
	for (let i = 0; i < n; i++) {
		const v = poly[i];
		for (let j = 0; j < n; j++) {
			if (j === i || j === (i + n - 1) % n) continue; // skip the two edges touching v
			const d = pointSegmentDistance(v, poly[j], poly[(j + 1) % n]);
			if (d < best) best = d;
		}
	}
	return best;
}

function boundaryIndexDistance(prefix, perimeter, a, b) {
	const d = Math.abs(prefix[a] - prefix[b]);
	return Math.min(d, perimeter - d);
}

// Like minNeckWidth, but ignores vertex/edge pairs that are close along the polygon boundary.
// This keeps tiny local stair-steps and chamfer artifacts from vetoing otherwise healthy lots,
// while still catching real waists where two distant boundary runs nearly touch.
export function nonLocalMinNeckWidth(poly, localBoundarySkip = 0) {
	if (!poly || poly.length < 4) return Infinity;
	const n = poly.length;
	const prefix = [0];
	for (let i = 0; i < n; i++) {
		prefix.push(prefix[i] + Point.distance(poly[i], poly[(i + 1) % n]));
	}
	const perimeter = prefix[n];
	if (perimeter <= 1e-6) return Infinity;

	let best = Infinity;
	for (let i = 0; i < n; i++) {
		const v = poly[i];
		for (let j = 0; j < n; j++) {
			if (j === i || j === (i + n - 1) % n) continue;
			if (localBoundarySkip > 0) {
				const d0 = boundaryIndexDistance(prefix, perimeter, i, j);
				const d1 = boundaryIndexDistance(prefix, perimeter, i, (j + 1) % n);
				if (Math.min(d0, d1) < localBoundarySkip) continue;
			}
			const d = pointSegmentDistance(v, poly[j], poly[(j + 1) % n]);
			if (d < best) best = d;
		}
	}
	return best;
}

function validElbowLots(halves, ranges, gap, minLotArea, minLotAngle, minLotWidth, minLotNeck = 0, minLotNeckLocalSkip = 0) {
	const lots = [];
	for (let i = 0; i < halves.length; i++) {
		let lot = halves[i];
		if (minLotWidth > 0 && lotMinWidth(lot) < minLotWidth) return null;
		if (gap > 0) lot = insetCutChainEdges(lot, ranges[i].start, ranges[i].count, gap);
		if (!lot || lot.length < 3) return null;
		if (Math.abs(lot.square) < minLotArea) return null;
		if (minAngle(lot) < minLotAngle) return null;
		if (minLotNeck > 0 && nonLocalMinNeckWidth(lot, minLotNeckLocalSkip) < minLotNeck) return null;
		lots.push(lot);
	}
	return lots;
}

// Two random exit directions for the elbow's second leg (the legacy behaviour): a random
// turn off `inward` to each side, within [angleMin, angleMax].
function randomTurnDirs(inward, angleMin, angleMax) {
	const signs = Random.bool() ? [1, -1] : [-1, 1];
	const out = [];
	for (const s of signs) out.push(rotateDir(inward, s * (angleMin + Random.float() * (angleMax - angleMin))));
	return out;
}

// Exit directions that ALIGN the elbow's second leg to the block geometry instead of turning
// by a random amount. For each block edge we take both:
//   - its NORMAL  → a cut perpendicular to that edge (meets the boundary squarely), and
//   - its TANGENT → a cut parallel to that edge, i.e. parallel to a previous slice (earlier
//                   cuts become block edges), so adjacent lots line up into a grid.
// Only directions whose turn off `inward` is a sensible elbow angle ([angleMin, angleMax]) are
// kept; the list is shuffled so we don't bias toward edge 0.
function wardEdgeAlignedDirs(poly, entryEdge, inward, angleMin, angleMax) {
	const out = [];
	const n = poly.length;
	for (let i = 0; i < n; i++) {
		if (i === entryEdge) continue;
		const edge = poly[(i + 1) % n].subtract(poly[i]);
		if (edge.length < 1e-6) continue;
		const nrm = inwardNormal(poly, i);
		const tan = edge.norm(1);
		for (const dir of [nrm, nrm.scale(-1), tan, tan.scale(-1)]) {
			if (dir.length < 1e-6) continue;
			const dot = Math.max(-1, Math.min(1, inward.x * dir.x + inward.y * dir.y));
			const turn = Math.acos(dot);
			if (turn >= angleMin && turn <= angleMax) out.push(dir);
		}
	}
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Random.float() * (i + 1));
		const t = out[i]; out[i] = out[j]; out[j] = t;
	}
	return out;
}

function makeEdgeElbowCut(poly, params) {
	if (!poly || poly.length < 3) return null;
	const minLotArea = params.minLotArea || 40;
	const minLotAngle = params.minLotAngle || Math.PI / 9;
	const gap = params.gap || 0;
	const minLotWidth = params.minLotWidth || 0;
	const minLotNeck = params.minLotNeck || 0;
	const minLotNeckLocalSkip = params.minLotNeckLocalSkip || 0;
	const angleMin = params.elbowAngleMin || Math.PI / 9;
	const angleMax = params.elbowAngleMax || Math.PI / 2;
	// Probability the elbow's second leg is aligned to a block edge — normal (perpendicular) OR
	// tangent (parallel to a previous slice) — vs a random turn. TUNE THIS RATIO via
	// params.elbowAlignProb — wards.js sets it (see createCommonWardGeometry).
	const elbowAlignProb = params.elbowAlignProb != null ? params.elbowAlignProb : 0.7;

	for (let attempt = 0; attempt < (params.attempts || 14); attempt++) {
		const edgeIndex = weightedRandomEdgeIndex(poly);
		const a = poly[edgeIndex];
		const b = poly[(edgeIndex + 1) % poly.length];
		const edge = b.subtract(a);
		const edgeLen = edge.length;
		if (edgeLen < 1e-6) continue;
		const inward = inwardNormal(poly, edgeIndex);
		if (inward.length < 1e-6) continue;
		const slotCount = params.maxCuts || 2;
		const slot = attempt % Math.max(1, slotCount);
		const baseT = (slot + 1) / (slotCount + 1);
		const jitter = (Random.float() - 0.5) * (0.55 / (slotCount + 1));
		const t = Math.max(0.12, Math.min(0.88, baseT + jitter));
		const entry = new Point(a.x + edge.x * t, a.y + edge.y * t);
		const inwardExit = rayExit(poly, entry, inward, edgeIndex);
		if (!inwardExit || inwardExit.t < Math.sqrt(minLotArea) * 1.5) continue;

		const firstLen = inwardExit.t * (0.28 + Random.float() * 0.38);
		const elbow = new Point(entry.x + inward.x * firstLen, entry.y + inward.y * firstLen);
		if (!containsPoint(poly, elbow)) continue;

		// 70% (default): align the second leg to a block edge — perpendicular (normal) OR
		// parallel to a previous slice (tangent) — so lots line up into a grid; 30%: a random
		// turn as before. Fall back to random if no block edge yields a usable elbow angle.
		let dirs = Random.bool(elbowAlignProb) ? wardEdgeAlignedDirs(poly, edgeIndex, inward, angleMin, angleMax) : [];
		if (dirs.length === 0) dirs = randomTurnDirs(inward, angleMin, angleMax);
		for (const dir of dirs) {
			const exit = rayExit(poly, elbow, dir, edgeIndex);
			if (!exit || exit.edge === edgeIndex || exit.t < Math.sqrt(minLotArea)) continue;
			const cut = [entry, elbow, exit.point];
			const split = splitAlong(poly, edgeIndex, exit.edge, cut);
			const lots = validElbowLots(split.halves, split.ranges, gap, minLotArea, minLotAngle, minLotWidth, minLotNeck, minLotNeckLocalSkip);
			if (lots) return { lots, alley: cut };
		}
	}
	return null;
}

function makeEdgeStraightCut(poly, params) {
	if (!poly || poly.length < 3) return null;
	const minLotArea = params.minLotArea || 40;
	const minLotAngle = params.minLotAngle || Math.PI / 9;
	const gap = params.gap || 0;
	const minLotWidth = params.minLotWidth || 0;
	const minLotNeck = params.minLotNeck || 0;
	const minLotNeckLocalSkip = params.minLotNeckLocalSkip || 0;

	for (let attempt = 0; attempt < (params.attempts || 14); attempt++) {
		const edgeIndex = weightedRandomEdgeIndex(poly);
		const a = poly[edgeIndex];
		const b = poly[(edgeIndex + 1) % poly.length];
		const edge = b.subtract(a);
		const edgeLen = edge.length;
		if (edgeLen < 1e-6) continue;
		const inward = inwardNormal(poly, edgeIndex);
		if (inward.length < 1e-6) continue;
		const t = Math.max(0.12, Math.min(0.88, 0.5 + (Random.float() - 0.5) * 0.62));
		const entry = new Point(a.x + edge.x * t, a.y + edge.y * t);
		const exit = rayExit(poly, entry, inward, edgeIndex);
		if (!exit || exit.t < Math.sqrt(minLotArea) * 2) continue;
		const cut = [entry, exit.point];
		const split = splitAlong(poly, edgeIndex, exit.edge, cut);
		const lots = validElbowLots(split.halves, split.ranges, gap, minLotArea, minLotAngle, minLotWidth, minLotNeck, minLotNeckLocalSkip);
		if (lots) return { lots, alley: cut };
	}
	return null;
}

export function sliceWardEdgeElbows(block, params = {}) {
	const gap = params.gap || 0;
	const widthFloor = params.minLotWidth != null ? params.minLotWidth : (gap > 0 ? 2 * gap : 0);
	const neckFloor = params.minLotNeck != null ? params.minLotNeck : 0;
	// Validate the full-size child lots before accepting a cut. They later lose about `gap` of
	// total width to the alley setback, so pad the requested final floors here and retry elsewhere
	// when a candidate split would make a skinny building.
	const cutWidth = gap > 0 ? widthFloor + gap : widthFloor;
	const cutNeck = gap > 0 && neckFloor > 0 ? neckFloor + gap : neckFloor;
	const cutParams = {
		...params,
		gap: 0,
		minLotWidth: cutWidth,
		minLotNeck: cutNeck,
		minLotNeckLocalSkip: params.minLotNeckLocalSkip != null
			? params.minLotNeckLocalSkip
			: (cutNeck > 0 ? cutNeck * 1.35 : 0),
	};
	const schedule = params.schedule || ['elbow', 'straight', 'elbow'];
	const maxFailedInRow = params.maxFailedInRow != null ? params.maxFailedInRow : 3;
	let lots = [block];
	const alleys = [];
	let failedInRow = 0;
	for (let i = 0; i < schedule.length; i++) {
		let targetIndex = -1;
		let targetArea = -Infinity;
		for (let j = 0; j < lots.length; j++) {
			const area = Math.abs(lots[j].square);
			if (area > targetArea) {
				targetArea = area;
				targetIndex = j;
			}
		}
		if (targetIndex === -1 || targetArea < (params.minLotArea || 40) * 2.6) break;
		const cut = schedule[i] === 'straight'
			? makeEdgeStraightCut(lots[targetIndex], cutParams)
			: makeEdgeElbowCut(lots[targetIndex], cutParams);
		if (!cut) {
			failedInRow++;
			if (failedInRow >= maxFailedInRow) break;
			i--;
			continue;
		}
		lots.splice(targetIndex, 1, ...cut.lots);
		alleys.push(cut.alley);
		failedInRow = 0;
	}

	if (gap > 0) {
		const oneSideProb = params.oneSideSetbackProb != null ? params.oneSideSetbackProb : 0.5;
		const saved = Random.getSeed();
		lots = lots.map((lot) => {
			if (!lot || lot.length < 3) return lot;
			const area0 = Math.abs(lot.square);
			let shrunkLot = lot;
			try {
				const shrunk = lot.shrinkRobust(gap / 2);
				if (shrunk && shrunk.length >= 3 && Math.abs(shrunk.square) > area0 * 0.15) shrunkLot = shrunk;
			} catch (e) { /* fall back to full-size lot */ }
			return shrinkOneSideDeeper(
				shrunkLot,
				gap,
				oneSideProb,
				params.minLotArea || 0,
				neckFloor,
				cutParams.minLotNeckLocalSkip
			);
		});
		// Variable setbacks are a local shape detail; they must not change the random stream for
		// later wards, or unrelated alley cuts can differ and appear as missing lots.
		Random.reset(saved);
	}

	// TEMP: keep lots even when the variable one-sided setback makes a thin neck. Re-enable once
	// setback-aware validation can distinguish ugly geometry from whole missing buildings.

	// Post-process: chamfer corners sharper than chamferAngle (default 30°).
	if (params.chamfer !== false) {
		const chamferAngle = params.chamferAngle != null ? params.chamferAngle : Math.PI / 6;
		const charLen = Math.sqrt(params.minLotArea || 40);
		const chamferSize = params.chamferSize != null ? params.chamferSize : (gap > 0 ? gap : charLen * 0.5);
		lots = chamferLots(lots, chamferAngle, chamferSize, params.chamferEdgeFrac);
	}

	if (params.emptyProb > 0) lots = lots.filter(() => Random.bool(1 - params.emptyProb));
	return { lots, alleys };
}

export { semiSmooth, bezierSmooth, detectStraight, getCircle, getArc, obb, aabb, convexHull, containsPoint, minNeckWidth };
