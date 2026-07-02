// wards.js — the part of the Ward hierarchy we need:
//  - getCityBlock(): shrink a patch into a block, leaving per-edge room for roads.
//  - placement heuristics for the cathedral and extra market squares.
//  - building subdivision (createAlleys / createOrthoBuilding + Cutter) that fills wards
//    with organic building lots, ported from Ward.hx / the ward subclasses.

import { Point } from './Point.js';
import { Polygon } from './Polygon.js';
import { GeomUtils } from './GeomUtils.js';
import { Random } from './Random.js';
import { Cutter } from './Cutter.js';
import { amin } from './arrays.js';
import { sliceWardEdgeElbows, sliceWard, minNeckWidth, nonLocalMinNeckWidth, lotMinWidth, slicePolygonAlongElbow } from './AlleySlicer.js';
import { recordFeature, recordRemovedTriangle } from './features.js';

// Open patch types are kept as open space (no shrunken block). 'water' included so water
// cells are never shrunk into blocks. 'park' is NOT open: it is filled with green patches
// (see createParkGeometry), so it gets a block and subdivision like a buildable ward.
export const OPEN_TYPES = new Set(['plaza', 'market', 'water']);

function hasRiverEdge(model, v0, v1) {
	const riverEdges = model.riverEdges;
	return !!(
		riverEdges &&
		((riverEdges.get(v0) && riverEdges.get(v0).has(v1)) || (riverEdges.get(v1) && riverEdges.get(v1).has(v0)))
	);
}

function isShoreEdge(model, v0, v1) {
	if (!model.patchByVertex) return false;
	const edgePatches = model.patchByVertex(v0).filter((p) => p.shape.findEdge(v0, v1) !== -1 || p.shape.findEdge(v1, v0) !== -1);
	return edgePatches.some((p) => p.isWater) && edgePatches.some((p) => !p.isWater);
}

function isShoreVertex(model, v) {
	if (!model.patchByVertex) return false;
	const patches = model.patchByVertex(v);
	return patches.some((p) => p.isWater) && patches.some((p) => !p.isWater);
}

// A ward corner that lands on the wall ring, where the wall is actually built (at least
// one adjacent segment active — same condition as tower placement in rebuildTowers). Plain
// wall vertices need a corner chamfer too, not just the edge-level wall clipping; otherwise a
// sharp ward tip pokes through the wall cap where no single ward edge runs along the wall.
function nodeClearance(model, v, widths) {
	const clearances = obstacleClearances(model, widths);
	let clearance = 0;
	if (model.water && model.water.riverPath && model.water.riverPath.includes(v))
		clearance = Math.max(clearance, clearances.river);
	if (isShoreVertex(model, v))
		clearance = Math.max(clearance, clearances.shore);
	if (model.wall && model.wall.towers && model.wall.towers.includes(v))
		clearance = Math.max(clearance, clearances.tower);
	if (model.citadelWall && model.citadelWall.towers && model.citadelWall.towers.includes(v))
		clearance = Math.max(clearance, clearances.tower);
	return clearance;
}

function clippedCorner(poly, sourceShape, corner, clearance) {
	if (!poly || poly.length < 3 || !(clearance > 0)) return poly;

	const idx = sourceShape.indexOf(corner);
	if (idx === -1) return poly;
	const dir = sourceShape.centroid.subtract(corner);
	if (dir.length > 1e-6) {
		dir.normalize(1);
		const n = new Point(-dir.y, dir.x);
		const cutCenter = corner.add(dir.scale(clearance));
		const capped = clipToOffsetSide(poly, cutCenter.subtract(n), cutCenter.add(n), -1, 0);
		if (capped && capped.length >= 3 && Math.abs(capped.square) >= Math.abs(poly.square) * 0.01)
			return capped;
	}

	const prev = sourceShape[(idx + sourceShape.length - 1) % sourceShape.length];
	const next = sourceShape[(idx + 1) % sourceShape.length];
	const prevLen = Point.distance(corner, prev);
	const nextLen = Point.distance(corner, next);
	if (prevLen < 1e-6 || nextLen < 1e-6) return poly;

	// Point obstacles (river nodes, shore corners, towers) need more than a token
	// chamfer, because the rendered river/wall cap can occupy the corner even when no
	// whole ward edge faces it.
	const reach = Math.min(clearance, prevLen * 0.65, nextLen * 0.65);
	if (!(reach > 1e-6)) return poly;

	const a = corner.add(prev.subtract(corner).norm(reach));
	const b = corner.add(next.subtract(corner).norm(reach));
	const halves = poly.cut(a, b);
	if (halves.length < 2) return poly;

	let best = poly;
	let bestDistance = -Infinity;
	const minKeptArea = Math.abs(poly.square) * 0.35;
	for (const half of halves) {
		if (!half || half.length < 3 || Math.abs(half.square) < minKeptArea) continue;
		const d = Point.distance(half.center, corner);
		if (d > bestDistance) {
			best = half;
			bestDistance = d;
		}
	}
	return best;
}

function clipObstacleCorners(poly, sourceShape, model, widths) {
	return poly;
}

function passageMargin(widths) {
	return Math.max(widths.regular || 0, (widths.main || 0) * 0.6, 0.8);
}

function obstacleClearances(model, widths) {
	const passage = passageMargin(widths);
	return {
		river: (model.riverWidth || 0) * 0.59 + passage,
		// Shore is one-sided: roads get their width from two blocks each inset by
		// regular/2, so the coast needs one full regular width for the same path.
		shore: Math.max(widths.regular || 0, 0.6),
		wall: Math.max((widths.main || 0) * 0.45, 0.6) + passage,
		tower: 1.75,
	};
}

function lineSignedDistance(a, b, p) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (!(len > 1e-6)) return 0;
	return ((dx * (p.y - a.y)) - (dy * (p.x - a.x))) / len;
}

function sideForShape(shape, a, b) {
	let side = lineSignedDistance(a, b, shape.centroid);
	if (Math.abs(side) < 1e-6) {
		for (const v of shape) {
			const d = lineSignedDistance(a, b, v);
			if (Math.abs(d) > Math.abs(side)) side = d;
		}
	}
	return side >= 0 ? 1 : -1;
}

function clipToOffsetSide(poly, a, b, side, clearance) {
	if (!poly || poly.length < 3 || clearance == null || clearance < 0) return poly;
	if (Point.distance(a, b) < 1e-6) return poly;

	const out = [];
	let prev = poly[poly.length - 1];
	let prevD = side * lineSignedDistance(a, b, prev);
	let prevInside = prevD >= clearance - 1e-6;

	for (const cur of poly) {
		const curD = side * lineSignedDistance(a, b, cur);
		const curInside = curD >= clearance - 1e-6;
		if (curInside !== prevInside) {
			const denom = curD - prevD;
			if (Math.abs(denom) > 1e-9) {
				const t = (clearance - prevD) / denom;
				out.push(new Point(prev.x + (cur.x - prev.x) * t, prev.y + (cur.y - prev.y) * t));
			}
		}
		if (curInside) out.push(cur);
		prev = cur;
		prevD = curD;
		prevInside = curInside;
	}

	const clipped = new Polygon(out);
	return clipped.length >= 3 && Math.abs(clipped.square) > 1e-6 ? clipped : null;
}

function cutAwayFromSegment(poly, sourceShape, a, b, clearance) {
	const clipped = clipToOffsetSide(poly, a, b, sideForShape(sourceShape, a, b), clearance);
	if (!clipped || clipped.length < 3) return poly;
	if (Math.abs(clipped.square) < Math.abs(poly.square) * 0.01) return poly;
	return clipped;
}

function cutAwayFromPoint(poly, sourceShape, point, clearance) {
	const dir = sourceShape.centroid.subtract(point);
	if (!poly || poly.length < 3 || !(clearance > 0) || dir.length < 1e-6) return poly;
	dir.normalize(1);
	const n = new Point(-dir.y, dir.x);
	const cutCenter = point.add(dir.scale(clearance));
	const clipped = clipToOffsetSide(poly, cutCenter.subtract(n), cutCenter.add(n), -1, 0);
	if (!clipped || clipped.length < 3) return poly;
	if (Math.abs(clipped.square) < Math.abs(poly.square) * 0.01) return poly;
	return clipped;
}

function norm(x, y) {
	const l = Math.hypot(x, y) || 1;
	return { x: x / l, y: y / l };
}

function cubicPoint(a, c1, c2, b, t) {
	const mt = 1 - t;
	const mt2 = mt * mt;
	const t2 = t * t;
	return new Point(
		a.x * mt2 * mt + 3 * c1.x * mt2 * t + 3 * c2.x * mt * t2 + b.x * t2 * t,
		a.y * mt2 * mt + 3 * c1.y * mt2 * t + 3 * c2.y * mt * t2 + b.y * t2 * t
	);
}

function smoothPathSegments(pts, samplesPerSegment = 16) {
	if (!pts || pts.length < 2) return [];
	if (pts.length === 2) return [{ from: pts[0], to: pts[1], samples: [pts[0], pts[1]] }];

	const extrap = (a, b, c) => {
		const ax = b.x - a.x;
		const ay = b.y - a.y;
		const bx = c.x - b.x;
		const by = c.y - b.y;
		const d = Math.hypot(ax, ay) * Math.hypot(bx, by) || 1;
		const sin = (ax * by - ay * bx) / d;
		const cos = (ax * bx + ay * by) / d;
		return new Point(c.x + (bx * cos - by * sin), c.y + (by * cos + bx * sin));
	};

	const a = [extrap(pts[2], pts[1], pts[0]), ...pts, extrap(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1])];
	const segments = [];
	for (let k = 1; k < a.length - 2; k++) {
		const g = a[k];
		const m = a[k + 1];
		const p = a[k + 2];
		const inD = norm(g.x - a[k - 1].x, g.y - a[k - 1].y);
		const segD = norm(m.x - g.x, m.y - g.y);
		const outD = norm(p.x - m.x, p.y - m.y);
		const tN = norm(inD.x + segD.x, inD.y + segD.y);
		const tP = norm(segD.x + outD.x, segD.y + outD.y);
		const len = Point.distance(g, m);
		let w = 1 / (1 + (tN.x * segD.x + tN.y * segD.y) + (tP.x * segD.x + tP.y * segD.y));
		if (!isFinite(w) || w < 0) w = 1 / 3;
		const q = len * Math.min(w, 1);
		const c1 = new Point(g.x + tN.x * q, g.y + tN.y * q);
		const c2 = new Point(m.x - tP.x * q, m.y - tP.y * q);
		const samples = [];
		for (let i = 0; i <= samplesPerSegment; i++) samples.push(cubicPoint(g, c1, c2, m, i / samplesPerSegment));
		segments.push({ from: g, to: m, samples });
	}
	return segments;
}

function pointInPolygon(point, poly) {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i];
		const b = poly[j];
		const crosses = (a.y > point.y) !== (b.y > point.y);
		if (crosses) {
			const x = ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x;
			if (point.x < x) inside = !inside;
		}
	}
	return inside;
}

function pointPolygonDistance(point, poly) {
	let best = Infinity;
	poly.forEdge((a, b) => {
		best = Math.min(best, pointSegmentDistance(point, a, b));
	});
	return best;
}

function pathSamplesTouchShape(samples, shape, clearance) {
	for (const p of samples)
		if (pointInPolygon(p, shape) || pointPolygonDistance(p, shape) <= clearance)
			return true;
	return false;
}

function clipFromPathObstacle(poly, sourceShape, path, clearance) {
	let clipped = poly;
	let touched = false;
	const sampledPath = [];
	for (const seg of smoothPathSegments(path)) {
		if (!pathSamplesTouchShape(seg.samples, sourceShape, clearance)) continue;
		touched = true;
		if (sampledPath.length === 0) sampledPath.push(seg.samples[0]);
		for (let i = 1; i < seg.samples.length; i++) sampledPath.push(seg.samples[i]);
		for (const p of seg.samples) clipped = cutAwayFromPoint(clipped, sourceShape, p, clearance);
		for (let i = 0; i < seg.samples.length - 1; i++)
			clipped = cutAwayFromSegment(clipped, sourceShape, seg.samples[i], seg.samples[i + 1], clearance);
	}
	if (touched && minDistanceToPolyline(clipped, sampledPath) < clearance * 0.9) return null;
	return clipped;
}

function pointSegmentDistance(p, a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const l2 = dx * dx + dy * dy || 1;
	let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function minDistanceToPolyline(poly, path) {
	if (!poly || poly.length < 3 || !path || path.length < 2) return Infinity;
	let best = Infinity;
	for (const v of poly)
		for (let i = 0; i < path.length - 1; i++)
			best = Math.min(best, pointSegmentDistance(v, path[i], path[i + 1]));
	return best;
}

function activeWallEdges(wall) {
	const out = [];
	if (!wall || !wall.shape) return out;
	for (let i = 0; i < wall.shape.length; i++) {
		if (wall.segments && wall.segments[i] === false) continue;
		out.push([wall.shape[i], wall.shape[(i + 1) % wall.shape.length]]);
	}
	return out;
}

function clipFromWallObstacle(poly, sourceShape, patch, wall, clearance) {
	if (!wall || !wall.shape) return poly;
	let clipped = poly;
	for (const [a, b] of activeWallEdges(wall)) {
		const bordersPatch =
			patch != null && typeof wall.bordersBy === 'function'
				? wall.bordersBy(patch, a, b) || wall.bordersBy(patch, b, a)
				: sourceShape.findEdge(a, b) !== -1 || sourceShape.findEdge(b, a) !== -1;
		if (bordersPatch) clipped = cutAwayFromSegment(clipped, sourceShape, a, b, clearance);
	}
	return clipped;
}

function clipFromShoreObstacle(poly, sourceShape, model, clearance) {
	if (!model || typeof model.patchByVertex !== 'function') return poly;
	let clipped = poly;
	sourceShape.forEdge((v0, v1) => {
		if (isShoreEdge(model, v0, v1)) clipped = cutAwayFromSegment(clipped, sourceShape, v0, v1, clearance);
	});
	return clipped;
}

function clipObstacleEdges(poly, sourceShape, model, widths, patch) {
	const clearance = obstacleClearances(model, widths);
	let clipped = poly;
	if (model.water && model.water.riverPath)
		clipped = clipFromPathObstacle(clipped, sourceShape, model.water.riverPath, clearance.river);
	if (!clipped || clipped.length < 3) return null;
	clipped = clipFromShoreObstacle(clipped, sourceShape, model, clearance.shore);
	clipped = clipFromWallObstacle(clipped, sourceShape, patch, model.wall, clearance.wall);
	clipped = clipFromWallObstacle(clipped, sourceShape, patch, model.citadelWall, clearance.wall);
	return clipped;
}

function triangleHeight(a, b, c) {
	const base = Point.distance(a, c);
	if (base < 1e-6) return 0;
	return Math.abs((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / base;
}

function cornerCos(a, b, c) {
	const ux = a.x - b.x;
	const uy = a.y - b.y;
	const vx = c.x - b.x;
	const vy = c.y - b.y;
	const ul = Math.hypot(ux, uy);
	const vl = Math.hypot(vx, vy);
	if (ul < 1e-6 || vl < 1e-6) return -1;
	return (ux * vx + uy * vy) / (ul * vl);
}

function cleanupBuildablePolygon(poly, widths) {
	if (!poly || poly.length < 3) return null;
	let cleaned = new Polygon(poly);
	const minEdge = Math.max((widths.alley || 0) * 0.6, 0.35);
	const maxTipHeight = Math.max((widths.regular || 0) * 0.45, 0.35);
	const acuteCos = Math.cos(Math.PI / 9); // 20 degrees

	for (let pass = 0; pass < 8 && cleaned.length > 3; pass++) {
		let removed = false;
		for (let i = 0; i < cleaned.length; i++) {
			const a = cleaned[(i + cleaned.length - 1) % cleaned.length];
			const b = cleaned[i];
			const c = cleaned[(i + 1) % cleaned.length];
			const prevLen = Point.distance(a, b);
			const nextLen = Point.distance(b, c);
			const height = triangleHeight(a, b, c);
			const sharp = cornerCos(a, b, c) > acuteCos;
			if ((sharp && height < maxTipHeight * 2.5) || Math.min(prevLen, nextLen) < minEdge || height < maxTipHeight) {
				cleaned.splice(i, 1);
				removed = true;
				break;
			}
		}
		if (!removed) break;
	}

	const area = Math.abs(cleaned.square);
	const minArea = Math.max(1, (widths.regular || 1) * (widths.regular || 1) * 2);
	if (cleaned.length < 3 || area < minArea) return null;
	if (cleaned.length === 3) {
		let minHeight = Infinity;
		for (let i = 0; i < 3; i++)
			minHeight = Math.min(minHeight, triangleHeight(cleaned[(i + 2) % 3], cleaned[i], cleaned[(i + 1) % 3]));
		if (minHeight < maxTipHeight || cleaned.compactness < 0.08) return null;
	}
	return cleaned;
}

// Port of Ward.getCityBlock (Ward.hx), adapted for obstacle-aware buildable areas.
// Every ward edge gets one fixed inset; rivers, shores, walls, towers, and occupied obstacle
// nodes then cut into that base block with their own clearance.
export function insetShape(model, shape, widths, withinWalls, patch = null) {
	const { regular, alley } = widths;
	const innerPatch = model.wall == null || withinWalls;
	const fixedInset = (innerPatch ? regular : alley) / 2;
	const insetDist = shape.map(() => fixedInset);

	const base = shape.isConvex() ? shape.shrink(insetDist) : shape.buffer(insetDist);
	const edgeClipped = clipObstacleEdges(base, shape, model, widths, patch);
	if (!edgeClipped || edgeClipped.length < 3) return null;
	return cleanupBuildablePolygon(clipObstacleCorners(edgeClipped, shape, model, widths), widths);
}

// Port of Ward.getCityBlock (Ward.hx): inset a single ward's shape.
export function getCityBlock(model, patch, widths) {
	return insetShape(model, patch.shape, widths, patch.withinWalls, patch);
}

// Port of Cathedral.rateLocation: prefer a patch overlooking the plaza, else closest to it.
export function cathedralRate(model, patch) {
	if (model.plaza != null && patch.shape.borders(model.plaza.shape)) return -1 / patch.shape.square;
	return patch.shape.distance(model.plaza != null ? model.plaza.shape.center : model.center) * patch.shape.square;
}

// Port of Market.rateLocation, repurposed to place park squares: no two parks adjacent; size
// relative to plaza, else distance to center.
export function marketRate(model, patch) {
	for (const p of model.inner)
		if (p.type === 'park' && p.shape.borders(patch.shape)) return Number.POSITIVE_INFINITY;
	return model.plaza != null ? patch.shape.square / model.plaza.shape.square : patch.shape.distance(model.center);
}

// --- building subdivision (port of Ward.createAlleys / createOrthoBuilding + ward subclasses) ---

// Recursively split a block into building lots along its longest edge (with alley gaps).
// `depth` guards against degenerate polygons that fail to cut (avoids infinite recursion).
export function createAlleys(p, minSq, gridChaos, sizeChaos, emptyProb = 0.04, split = true, alley = 0.6, depth = 0) {
	if (!p || p.length < 3) return [];

	// longest edge -> its first vertex
	let v = null;
	let length = -1;
	p.forEdge((p0, p1) => {
		const len = Point.distance(p0, p1);
		if (len > length) {
			length = len;
			v = p0;
		}
	});

	const spread = 0.8 * gridChaos;
	const ratio = (1 - spread) / 2 + Random.float() * spread;
	// keep lots rectangular even in chaotic wards
	const angleSpread = (Math.PI / 6) * gridChaos * (p.square < minSq * 4 ? 0.0 : 1);
	const b = (Random.float() - 0.5) * angleSpread;

	const halves = Cutter.bisect(p, v, ratio, b, split ? alley : 0.0);

	if (halves.length < 2 || depth > 24) {
		return Random.bool(emptyProb) ? [] : [p];
	}

	let buildings = [];
	for (const half of halves) {
		if (half.square < minSq * Math.pow(2, 4 * sizeChaos * (Random.float() - 0.5))) {
			if (!Random.bool(emptyProb)) buildings.push(half);
		} else {
			buildings = buildings.concat(
				createAlleys(half, minSq, gridChaos, sizeChaos, emptyProb, half.square > minSq / (Random.float() * Random.float()), alley, depth + 1)
			);
		}
	}
	return buildings;
}

function findLongestEdge(poly) {
	return amin(poly, (v) => -poly.vector(v).length);
}

// Subdivide into axis-aligned (relative to the longest edge) building lots.
export function createOrthoBuilding(poly, minBlockSq, fill) {
	function slice(p, c1, c2, depth) {
		const v0 = findLongestEdge(p);
		const v1 = p.next(v0);
		const v = v1.subtract(v0);

		const ratio = 0.4 + Random.float() * 0.2;
		const p1 = GeomUtils.interpolate(v0, v1, ratio);

		const c = Math.abs(GeomUtils.scalar(v.x, v.y, c1.x, c1.y)) < Math.abs(GeomUtils.scalar(v.x, v.y, c2.x, c2.y)) ? c1 : c2;

		const halves = p.cut(p1, p1.add(c));
		if (halves.length < 2 || depth > 24) return Random.bool(fill) ? [p] : [];

		let buildings = [];
		for (const half of halves) {
			if (half.square < minBlockSq * Math.pow(2, Random.normal() * 2 - 1)) {
				if (Random.bool(fill)) buildings.push(half);
			} else {
				buildings = buildings.concat(slice(half, c1, c2, depth + 1));
			}
		}
		return buildings;
	}

	if (!poly || poly.length < 3) return [];
	if (poly.square < minBlockSq) return [poly];

	const c1 = poly.vector(findLongestEdge(poly));
	const c2 = c1.rotate90();
	for (let attempt = 0; attempt < 40; attempt++) {
		const blocks = slice(poly, c1, c2, 0);
		if (blocks.length > 0) return blocks;
	}
	return [poly];
}

// Pick residential subdivision params by distance from centre -> concentric districts:
// large merchant blocks in the core, craftsmen mid-town, chaotic slums on the outskirts.
function wardStyle(model, patch) {
	const t = Point.distance(patch.shape.centroid, model.center) / (model.cityRadius || 1);
	if (t < 0.5) return [50 + 60 * Random.float() * Random.float(), 0.5 + Random.float() * 0.3, 0.7, 0.15];
	if (t < 1.1) return [10 + 80 * Random.float() * Random.float(), 0.5 + Random.float() * 0.2, 0.6, 0.04];
	return [10 + 30 * Random.float() * Random.float(), 0.6 + Random.float() * 0.4, 0.8, 0.03];
}

function translatedShape(shape, dx, dy) {
	return new Polygon(shape.map((p) => new Point(p.x + dx, p.y + dy)));
}

function segmentLineIntersection(p0, p1, a, b) {
	const seg = p1.subtract(p0);
	const edge = b.subtract(a);
	const hit = GeomUtils.intersectLines(p0.x, p0.y, seg.x, seg.y, a.x, a.y, edge.x, edge.y);
	if (hit == null || hit.x < -1e-6 || hit.x > 1 + 1e-6) return null;
	return new Point(p0.x + seg.x * hit.x, p0.y + seg.y * hit.x);
}

function clipPolygonToConvexShape(poly, clipShape) {
	if (!poly || poly.length < 3 || !clipShape || clipShape.length < 3) return null;
	let out = poly.map((p) => p);
	const orientation = clipShape.square >= 0 ? 1 : -1;

	for (let i = 0; i < clipShape.length && out.length >= 3; i++) {
		const a = clipShape[i];
		const b = clipShape[(i + 1) % clipShape.length];
		const inside = (p) => orientation * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= -1e-6;
		const input = out;
		out = [];
		let prev = input[input.length - 1];
		let prevInside = inside(prev);
		for (const cur of input) {
			const curInside = inside(cur);
			if (curInside !== prevInside) {
				const hit = segmentLineIntersection(prev, cur, a, b);
				if (hit) out.push(hit);
			}
			if (curInside) out.push(cur);
			prev = cur;
			prevInside = curInside;
		}
	}

	const clipped = new Polygon(out);
	return clipped.length >= 3 && Math.abs(clipped.square) > 1e-6 ? clipped : null;
}

function indentFronts(lots, block) {
	if (!block || block.length < 3) return lots;
	const blockCenter = block.centroid;
	return lots.map((lot) => {
		if (Random.float() >= 0.1) return lot;
		const area = Math.abs(lot.square);
		let inset = Math.min(Math.sqrt(area) / 3, 1.2) * Random.float();
		if (inset < 0.5) return lot;

		const lotCenter = lot.center;
		const dir = new Point(blockCenter.x - lotCenter.x, blockCenter.y - lotCenter.y);
		if (dir.length < 1e-6) return lot;
		dir.normalize(inset);

		const shiftedBlock = translatedShape(block, dir.x, dir.y);
		const clipped = clipPolygonToConvexShape(lot, shiftedBlock);
		if (!clipped || clipped.length < 3 || Math.abs(clipped.square) < area * 0.35) return lot;
		return clipped;
	});
}

function commonWardParams(model, patch) {
	// [minSq, gridChaos, sizeChaos, emptyProb, blockSize]
	// minSq: minimum lot area. blockSize: bisector recursion threshold (minArea = minSq*blockSize).
	// gridChaos: area-balance tolerance (variance = 16*gridChaos). sizeChaos: lot size jitter.
	return [80, 0.5, 0.45, 0, 16];
}

function modelIsEnclosed(model, patch) {
	return model && typeof model.isEnclosed === 'function' ? model.isEnclosed(patch) : true;
}

function filterOutskirts(model, patch, geometry) {
	if (!model || !patch || !patch.shape || !geometry || geometry.length === 0) return geometry;
	if (modelIsEnclosed(model, patch)) return geometry;

	const populatedEdges = [];
	const addEdge = (v1, v2, factor = 1.0) => {
		const dx = v2.x - v1.x;
		const dy = v2.y - v1.y;
		let maxVertex = null;
		let maxDist = -Infinity;
		for (const v of patch.shape) {
			const dist = (v !== v1 && v !== v2 ? GeomUtils.distance2line(v1.x, v1.y, dx, dy, v.x, v.y) : 0) * factor;
			if (dist > maxDist) {
				maxDist = dist;
				maxVertex = v;
			}
		}
		if (maxVertex != null && Math.abs(maxDist) > 1e-6) populatedEdges.push({ x: v1.x, y: v1.y, dx, dy, d: maxDist });
	};

	patch.shape.forEdge((v1, v2) => {
		let onRoad = false;
		for (const street of model.arteries || []) {
			if (street.contains(v1) && street.contains(v2)) {
				onRoad = true;
				break;
			}
		}

		if (onRoad) {
			addEdge(v1, v2, 1);
		} else if (typeof model.getNeighbour === 'function') {
			const n = model.getNeighbour(patch, v1);
			if (n && n.withinCity) addEdge(v1, v2, modelIsEnclosed(model, n) ? 1 : 0.4);
		}
	});
	if (populatedEdges.length === 0) return geometry;

	const gates = model.gates || [];
	const density = patch.shape.map((v) => {
		if (gates.includes(v)) return 1;
		const touched = typeof model.patchByVertex === 'function' ? model.patchByVertex(v) : [];
		return touched.length > 0 && touched.every((p) => p.withinCity) ? 2 * Random.float() : 0;
	});

		return geometry.filter((building) => {
		let minDist = 1.0;
		for (const edge of populatedEdges) {
			for (const v of building) {
				const d = GeomUtils.distance2line(edge.x, edge.y, edge.dx, edge.dy, v.x, v.y);
				const dist = d / edge.d;
				if (dist < minDist) minDist = dist;
			}
		}

		const weights = patch.shape.interpolate(building.center);
		let p = 0;
		for (let j = 0; j < weights.length; j++) p += density[j] * weights[j];
		if (p <= 1e-6) return false;
		minDist /= p;

		// Relaxed: keep buildings unless they're well beyond the populated edge threshold.
		// Random.fuzzy(1) averages ~0.5; requiring it > minDist means lots near the edge
		// (minDist small) are almost always kept, and only far-flung outliers are dropped.
		return Random.fuzzy(1) > minDist * 1.4;
	});
}

function isConvexCorner(poly, i) {
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

function edgeLengthExtremaIndices(poly) {
	const excluded = new Set();
	if (!poly || poly.length < 3) return excluded;
	let minLen = Infinity;
	let maxLen = -Infinity;
	const lengths = [];
	for (let i = 0; i < poly.length; i++) {
		const len = Point.distance(poly[i], poly[(i + 1) % poly.length]);
		lengths.push(len);
		if (len < minLen) minLen = len;
		if (len > maxLen) maxLen = len;
	}
	const eps = Math.max(1e-6, maxLen * 1e-6);
	for (let i = 0; i < lengths.length; i++) {
		if (Math.abs(lengths[i] - minLen) <= eps || Math.abs(lengths[i] - maxLen) <= eps) excluded.add(i);
	}
	return excluded;
}

function convexCornerEdgeIndices(poly, minLength = 1e-6, excludedEdges = null) {
	const edges = [];
	if (!poly || poly.length < 3) return edges;
	for (let i = 0; i < poly.length; i++) {
		if (excludedEdges && excludedEdges.has(i)) continue;
		if (!isConvexCorner(poly, i) || !isConvexCorner(poly, (i + 1) % poly.length)) continue;
		if (Point.distance(poly[i], poly[(i + 1) % poly.length]) < minLength) continue;
		edges.push(i);
	}
	for (let i = edges.length - 1; i > 0; i--) {
		const j = Random.int(0, i + 1);
		const t = edges[i];
		edges[i] = edges[j];
		edges[j] = t;
	}
	return edges;
}

function compactPolygonPoints(points) {
	const out = [];
	for (const p of points) {
		if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
		const last = out[out.length - 1];
		if (!last || Point.distance(last, p) > 1e-6) out.push(p);
	}
	if (out.length > 1 && Point.distance(out[0], out[out.length - 1]) <= 1e-6) out.pop();
	return out;
}

function clipOneSideWithInsetShape(lot, a, b, side, distance) {
	const n = lot.length;
	if (n < 3 || !(distance > 0)) return null;
	const signed = (p) => side * lineSignedDistance(a, b, p) - distance;
	const intersection = (p, q, dp, dq) => {
		const t = -dp / ((dq - dp) || 1e-12);
		return new Point(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t);
	};

	const kept = [];
	const removed = [];
	let prev = lot[n - 1];
	let prevD = signed(prev);
	let prevKept = prevD >= -1e-6;

	for (let i = 0; i < n; i++) {
		const cur = lot[i];
		const curD = signed(cur);
		const curKept = curD >= -1e-6;
		const curRemoved = curD <= 1e-6;
		if (curKept !== prevKept) {
			const hit = intersection(prev, cur, prevD, curD);
			kept.push(hit);
			removed.push(hit);
		}
		if (curKept) kept.push(cur);
		if (curRemoved) removed.push(cur);
		prev = cur;
		prevD = curD;
		prevKept = curKept;
	}

	const insetLot = new Polygon(compactPolygonPoints(kept));
	const insetShape = new Polygon(compactPolygonPoints(removed));
	if (insetLot.length < 3 || insetShape.length < 3) return null;
	return { insetLot, insetShape };
}

function markEntranceExcludedEdge(poly, sourceA, sourceB, side, distance) {
	if (!poly || poly.length < 3) return;
	let bestIndex = -1;
	let bestLen = -Infinity;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const da = Math.abs(side * lineSignedDistance(sourceA, sourceB, a) - distance);
		const db = Math.abs(side * lineSignedDistance(sourceA, sourceB, b) - distance);
		const len = Point.distance(a, b);
		if (da < 1e-5 && db < 1e-5 && len > bestLen) {
			bestIndex = i;
			bestLen = len;
		}
	}
	if (bestIndex !== -1) poly.noEntranceEdges = new Set([bestIndex]);
}

function entranceFillPolygon(p1, q1, q2, p2) {
	const fill = new Polygon([p1.clone(), q1.clone(), q2.clone(), p2.clone()]);
	fill.class = 'housingEntranceFill';
	return fill;
}

function entranceNotchFits(lot, p1, q1, q2, p2, alley) {
	const midInner = new Point((q1.x + q2.x) / 2, (q1.y + q2.y) / 2);
	const samples = [
		q1, q2, midInner,
		new Point((p1.x + q1.x) / 2, (p1.y + q1.y) / 2),
		new Point((p2.x + q2.x) / 2, (p2.y + q2.y) / 2),
	];
	for (const p of samples) {
		if (!pointInPolygon(p, lot)) return false;
		if (pointPolygonDistance(p, lot) < Math.max(0.04, alley * 0.05)) return false;
	}
	return true;
}

function passesLotShapeFloors(lot, opts = {}) {
	if (!lot || lot.length < 3) return false;
	const minLotWidth = opts.minLotWidth || 0;
	const minLotNeck = opts.minLotNeck || 0;
	const minLotNeckLocalSkip = opts.minLotNeckLocalSkip != null
		? opts.minLotNeckLocalSkip
		: (minLotNeck > 0 ? minLotNeck * 1.35 : 0);
	if (minLotWidth > 0 && lotMinWidth(lot) < minLotWidth) return false;
	if (minLotNeck > 0 && nonLocalMinNeckWidth(lot, minLotNeckLocalSkip) < minLotNeck) return false;
	return true;
}

function buildLotWithEntrancePlans(lot, plans, alley, area0, opts = {}) {
	const out = new Polygon();
	const byEdge = new Map();
	for (const plan of plans) {
		if (!byEdge.has(plan.edgeIndex)) byEdge.set(plan.edgeIndex, []);
		byEdge.get(plan.edgeIndex).push(plan);
	}
	for (const list of byEdge.values()) list.sort((a, b) => a.start - b.start);

	for (let i = 0; i < lot.length; i++) {
		out.push(lot[i]);
		const edgePlans = byEdge.get(i);
		if (edgePlans) {
			for (const plan of edgePlans) {
				out.push(plan.p1);
				out.push(plan.q1);
				out.push(plan.q2);
				out.push(plan.p2);
			}
		}
	}
	const cleaned = new Polygon(compactPolygonPoints(out));
	if (lot.class) cleaned.class = lot.class;
	if (lot.noEntranceEdges) cleaned.noEntranceEdges = new Set(Array.from(lot.noEntranceEdges));
	if (cleaned.length < lot.length + 2) return false;
	if (!cleaned.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
	if (Math.sign(cleaned.square) !== Math.sign(lot.square)) return false;
	if (Math.abs(cleaned.square) < area0 * 0.48) return false;
	if (minNeckWidth(cleaned) < Math.max(0.28, alley * 0.42)) return false;
	if (!passesLotShapeFloors(cleaned, opts)) return false;
	return cleaned;
}

function intervalOverlaps(intervals, lo, hi, gap) {
	for (const [a, b] of intervals) {
		if (lo < b + gap && hi > a - gap) return true;
	}
	return false;
}

function makeEntrancePlan(lot, edgeIndex, start, width, depth) {
	const a = lot[edgeIndex];
	const b = lot[(edgeIndex + 1) % lot.length];
	const edge = b.subtract(a);
	const len = edge.length;
	if (!(len > 1e-6)) return null;
	const u = edge.norm(1);
	const side = sideForShape(lot, a, b);
	const inward = new Point(-edge.y / len * side, edge.x / len * side);
	const p1 = a.add(u.scale(start - width / 2));
	const p2 = a.add(u.scale(start + width / 2));
	const q1 = p1.add(inward.scale(depth));
	const q2 = p2.add(inward.scale(depth));
	return { edgeIndex, start, width, depth, p1, q1, q2, p2 };
}

function addHousingEntrance(lot, alley, opts = {}) {
	if (!lot || lot.length < 3 || lot.class || !(alley > 0)) return { lot, fills: [] };
	const cutProb = opts.cutProb != null ? opts.cutProb : 0.75;
	const fillProb = opts.fillProb != null ? opts.fillProb : 0.3;
	const secondCutProb = opts.secondCutProb != null ? opts.secondCutProb : 0.85;
	const largeExtraCutProb = opts.largeExtraCutProb != null ? opts.largeExtraCutProb : 0.45;
	const sameEdgePairProb = opts.sameEdgePairProb != null ? opts.sameEdgePairProb : 0.12;
	if (!Random.bool(cutProb)) return { lot, fills: [] };
	const area0 = Math.abs(lot.square);
	if (area0 < alley * alley * 15) return { lot, fills: [] };

	const plans = [];
	const fills = [];
	const cornerClearance = alley * 3;
	const minSize = alley * 0.85;
	const maxDepth = alley * 2.0;
	const maxWidthSize = alley * 3.0;
	const minGap = alley * 2;
	let targetCount = 1;
	if (Random.bool(secondCutProb)) targetCount++;
	if (area0 > alley * alley * 70 && Random.bool(largeExtraCutProb)) targetCount++;

	const edgeIndices = [];
	for (let i = 0; i < lot.length; i++) {
		if (lot.noEntranceEdges && lot.noEntranceEdges.has(i)) continue;
		edgeIndices.push(i);
	}
	for (let i = edgeIndices.length - 1; i > 0; i--) {
		const j = Random.int(0, i + 1);
		const t = edgeIndices[i];
		edgeIndices[i] = edgeIndices[j];
		edgeIndices[j] = t;
	}

	for (const edgeIndex of edgeIndices) {
		if (plans.length >= targetCount) break;
		const a = lot[edgeIndex];
		const b = lot[(edgeIndex + 1) % lot.length];
		const len = Point.distance(a, b);
		if (len < cornerClearance * 2 + minSize) continue;

		const maxSlots = Math.min(4, Math.floor((len - cornerClearance * 2 + minGap) / (minSize + minGap)));
		if (maxSlots <= 0) continue;
		const target = Math.min(maxSlots, targetCount - plans.length, Random.bool(sameEdgePairProb) ? 2 : 1);
		const intervals = [];
		for (let attempt = 0; attempt < maxSlots * 8 && intervals.length < target; attempt++) {
			const depth = minSize + Random.float() * (maxDepth - minSize);
			const minWidth = Math.max(minSize, depth * 0.5);
			const maxWidth = Math.min(maxWidthSize, depth * 3);
			if (minWidth > maxWidth) continue;
			const width = minWidth + Random.float() * (maxWidth - minWidth);
			if (len < cornerClearance * 2 + width) continue;

			const minStart = cornerClearance + width / 2;
			const maxStart = len - cornerClearance - width / 2;
			if (minStart > maxStart) continue;
			const start = minStart + Random.float() * (maxStart - minStart);
			const lo = start - width / 2;
			const hi = start + width / 2;
			if (intervalOverlaps(intervals, lo, hi, minGap)) continue;

			const plan = makeEntrancePlan(lot, edgeIndex, start, width, depth);
			if (!plan || !entranceNotchFits(lot, plan.p1, plan.q1, plan.q2, plan.p2, alley)) continue;
			const tentativePlans = plans.concat(plan);
			const tentativeLot = buildLotWithEntrancePlans(lot, tentativePlans, alley, area0, opts);
			if (!tentativeLot) continue;
			intervals.push([lo, hi]);
			plans.push(plan);
			if (Random.bool(fillProb)) fills.push(entranceFillPolygon(plan.p1, plan.q1, plan.q2, plan.p2));
		}
	}

	if (plans.length === 0) return { lot, fills: [] };
	const cleaned = buildLotWithEntrancePlans(lot, plans, alley, area0, opts);
	if (!cleaned) return { lot, fills: [] };
	return { lot: cleaned, fills };
}

function addHousingEntrances(geometry, alley, opts = {}) {
	if (!geometry || geometry.length === 0) return geometry;
	const out = [];
	for (const lot of geometry) {
		const result = addHousingEntrance(lot, alley, opts);
		out.push(result.lot);
		out.push(...result.fills);
	}
	return out;
}

function addLargestLotInset(geometry, alley, opts = {}) {
	if (!geometry || geometry.length === 0 || !(alley > 0)) return geometry;

	let bestIndex = -1;
	let bestArea = 0;
	for (let i = 0; i < geometry.length; i++) {
		const lot = geometry[i];
		if (!lot || lot.length < 3) continue;
		const area = Math.abs(lot.square);
		if (area > bestArea) {
			bestArea = area;
			bestIndex = i;
		}
	}
	if (bestIndex === -1) return geometry;

	const lot = geometry[bestIndex];
	const minInsetLotWidth = opts.minLotWidth || alley;
	const minInsetLotNeck = opts.minLotNeck || minInsetLotWidth;
	const minInsetLotNeckLocalSkip = opts.minLotNeckLocalSkip != null
		? opts.minLotNeckLocalSkip
		: (minInsetLotNeck > 0 ? minInsetLotNeck * 1.35 : 0);
	const excludedInsetEdges = edgeLengthExtremaIndices(lot);
	for (const edgeIndex of convexCornerEdgeIndices(lot, alley * 0.75, excludedInsetEdges)) {
		const a = lot[edgeIndex];
		const b = lot[(edgeIndex + 1) % lot.length];
		const edge = b.subtract(a);
		const len = edge.length;
		if (!(len > 1e-6)) continue;

		for (let attempt = 0; attempt < 4; attempt++) {
			const distance = alley * (1 + Random.float() * 2);
			const side = sideForShape(lot, a, b);
			const clipped = clipOneSideWithInsetShape(lot, a, b, side, distance);
			if (!clipped) continue;
			const { insetLot, insetShape } = clipped;
			insetShape.class = 'largestLotInset';
			markEntranceExcludedEdge(insetLot, a, b, side, distance);

			if (
				!insetLot ||
				insetLot.length < 3 ||
				!insetLot.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ||
				lotMinWidth(insetLot) < minInsetLotWidth ||
				nonLocalMinNeckWidth(insetLot, minInsetLotNeckLocalSkip) < minInsetLotNeck ||
				Math.abs(insetLot.square) < bestArea * 0.35 ||
				Math.abs(insetShape.square) < 1e-6
			) continue;

			const out = geometry.slice();
			out[bestIndex] = insetLot;
			out.push(insetShape);
			return out;
		}
	}

	return geometry;
}

export function createCommonWardGeometry(model, patch, widths) {
	const block = patch.block;
	if (!block || block.length < 3) return [];

	const angleOf = (poly, i) => {
		const a = poly[(i + poly.length - 1) % poly.length];
		const b = poly[i];
		const c = poly[(i + 1) % poly.length];
		const u = a.subtract(b);
		const v = c.subtract(b);
		if (u.length < 1e-6 || v.length < 1e-6) return 0;
		return Math.acos(Math.max(-1, Math.min(1, u.dot(v) / (u.length * v.length))));
	};
	const minPolyAngle = (poly) => {
		let min = Infinity;
		for (let i = 0; i < poly.length; i++) min = Math.min(min, angleOf(poly, i));
		return min;
	};
	const roundedAcuteCorners = (poly, minAngle, depth = 0) => {
		if (!poly || poly.length < 3 || depth > 12) return poly;
		let worst = -1;
		let worstAngle = minAngle;
		for (let i = 0; i < poly.length; i++) {
			const a = angleOf(poly, i);
			if (a < worstAngle) {
				worstAngle = a;
				worst = i;
			}
		}
		if (worst === -1) return poly;
		const prev = poly[(worst + poly.length - 1) % poly.length];
		const corner = poly[worst];
		const next = poly[(worst + 1) % poly.length];
		const prevLen = Point.distance(corner, prev);
		const nextLen = Point.distance(corner, next);
		if (prevLen < 1e-6 || nextLen < 1e-6) return poly;
		const reach = Math.min(prevLen, nextLen) * 0.22;
		if (!(reach > 1e-6)) return poly;
		const a = corner.add(prev.subtract(corner).norm(reach));
		const b = corner.add(next.subtract(corner).norm(reach));
		const out = new Polygon();
		for (let i = 0; i < poly.length; i++) {
			if (i === worst) {
				out.push(a);
				out.push(b);
			} else {
				out.push(poly[i]);
			}
		}
		if (out.length < 3 || Math.abs(out.square) < Math.abs(poly.square) * 0.5) return poly;
		// The acute tip (corner, a, b) was beveled away — leave a tree/fountain behind.
		recordRemovedTriangle(corner, a, b);
		return roundedAcuteCorners(out, minAngle, depth + 1);
	};

	const axis = principalAxis(block);
	const radial = block.centroid.subtract(model.center || block.center);
	if (radial.length > 1e-6 && Math.abs(axis.dot(radial.norm(1))) > 0.92) {
		axis.set(new Point(-axis.y, axis.x));
	}
	if (Random.bool(0.35)) axis.set(new Point(-axis.y, axis.x));

	const area = Math.abs(block.square);
	const scale = Math.sqrt(area);
	const dense = patch.type === 'gate' || Point.distance(block.centroid, model.center || block.center) < (model.cityRadius || scale) * 0.55;
	const params = {
		minSq: dense ? 70 : 95,
		blockSize: dense ? 10 : 14,
		gridChaos: 0.45 + Random.float() * 0.25,
		sizeChaos: 0.35,
		gap: widths.alley || 0.8,
		emptyProb: 0,
		primaryDir: axis,
		directionJitter: 0.28 + Random.float() * 0.18,
		elbowAngleMin: Math.PI / 9,
		elbowAngleMax: Math.PI / 2,
		// Fraction of elbow cuts aligned to a block edge — normal (perpendicular) or parallel to
		// a previous slice — vs a random angle. TUNE HERE: raise toward 1 for more grid-aligned
		// lots, lower for more variety.
		elbowAlignProb: 0.7,
		// Minimum overall lot thickness. The slicer pads this by the alley gap while testing
		// candidate cuts, because each accepted lot is inset afterward.
		minLotWidth: widths.alley * 4,
		// Minimum building "waist": no lot may pinch thinner than this. Bounds the worst neck
		// in the ward. TUNE HERE (× widths.alley) — higher = thicker, chunkier buildings.
		minLotNeck: widths.alley * 3.5,
		schedule: ['elbow', 'straight', 'elbow'],
		maxFailedInRow: 6, // extra retries to recover the stricter thin-neck rejections
		attempts: 32,
		minLotArea: Math.max(45, widths.main * widths.main * 12),
		minLotAngle: Math.PI / 4,
	};
	const lotShapeGuards = {
		minLotWidth: params.minLotWidth,
		minLotNeck: params.minLotNeck,
		minLotNeckLocalSkip: params.minLotNeck * 1.35,
	};

	// Very small blocks are already navigation-relevant as courtyards; don't shred them — but a
	// thin block should still become a final lot instead of creating an empty patch.
	const preparedBlock = roundedAcuteCorners(block, params.minLotAngle);
	if (area < params.minSq * 2.5 || scale < widths.main * 5) {
		return [preparedBlock];
	}

	const { lots, alleys } = sliceWardEdgeElbows(preparedBlock, params);
	patch.alleys = alleys || [];
	let geometry = (lots && lots.length > 0 ? lots : [preparedBlock]).map((lot) => {
		const rounded = roundedAcuteCorners(lot, params.minLotAngle);
		return passesLotShapeFloors(rounded, lotShapeGuards) ? rounded : lot;
	});
	geometry = geometry.filter((lot) => lot && lot.length >= 3);
	geometry = addLargestLotInset(geometry, params.gap, lotShapeGuards);
	geometry = addHousingEntrances(geometry, params.gap, {
		fillProb: 0.67,
		...lotShapeGuards,
	});
	// Shape details above keep the original lot whenever their modification would violate the
	// width/neck floors, so stricter limits do not create empty gaps.
	return geometry;
}

function parkFeatureHash(x, y, salt = 0) {
	const h = (
		Math.imul(Math.round(x * 16) + salt * 101, 73856093) ^
		Math.imul(Math.round(y * 16) - salt * 127, 19349663)
	) >>> 0;
	return h / 0x100000000;
}

function recordParkPathTrees(alleys, block, gap) {
	if (!alleys || alleys.length === 0 || !block || block.length < 3) return;
	const spacing = Math.max(2.4, gap * 3);
	const offset = Math.max(1.2, gap * 1.45);
	const boundaryClearance = offset * 1.15;
	for (let ai = 0; ai < alleys.length; ai++) {
		const path = alleys[ai];
		if (!path || path.length < 2) continue;
		for (let i = 0; i < path.length - 1; i++) {
			const a = path[i];
			const b = path[i + 1];
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const len = Math.hypot(dx, dy);
			if (!(len > spacing * 0.8)) continue;
			const nx = -dy / len;
			const ny = dx / len;
			const count = Math.max(1, Math.floor(len / spacing));
			for (let k = 0; k < count; k++) {
				const t = (k + 0.5) / count;
				const base = new Point(a.x + dx * t, a.y + dy * t);
				for (const side of [-1, 1]) {
					if (parkFeatureHash(base.x, base.y, ai * 17 + k * 3 + (side > 0 ? 1 : 2)) > 0.62) continue;
					const p = new Point(base.x + nx * offset * side, base.y + ny * offset * side);
					if (pointInPolygon(p, block) && pointPolygonDistance(p, block) >= boundaryClearance)
						recordFeature(p.x, p.y, 'tree');
				}
			}
		}
	}
}

function recordParkPatchRings(lots) {
	if (!lots || lots.length === 0) return;
	for (let i = 0; i < lots.length; i++) {
		const lot = lots[i];
		if (!lot || lot.length < 3 || Math.abs(lot.square) < 10) continue;
		const c = lot.centroid;
		if (parkFeatureHash(c.x, c.y, i + 41) > 0.45) continue;
		recordFeature(c.x, c.y, parkFeatureHash(c.x, c.y, i + 83) < 0.5 ? 'fountain' : 'object');
	}
}

function pathLength(path) {
	if (!path || path.length < 2) return 0;
	let length = 0;
	for (let i = 0; i < path.length - 1; i++) length += Point.distance(path[i], path[i + 1]);
	return length;
}

function pathMidpoint(path) {
	if (!path || path.length === 0) return new Point(0, 0);
	if (path.length === 1) return path[0];
	const half = pathLength(path) / 2;
	let travelled = 0;
	for (let i = 0; i < path.length - 1; i++) {
		const a = path[i];
		const b = path[i + 1];
		const len = Point.distance(a, b);
		if (travelled + len >= half && len > 1e-6) {
			const t = (half - travelled) / len;
			return new Point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
		}
		travelled += len;
	}
	return path[path.length - 1];
}

function conceptualParkEdges(lot) {
	if (!lot || lot.length < 3) return [];
	const breaks = [];
	const maxSmoothTurn = Math.PI / 4;
	const n = lot.length;
	for (let i = 0; i < n; i++) {
		const prev = lot[(i + n - 1) % n];
		const curr = lot[i];
		const next = lot[(i + 1) % n];
		const incoming = curr.subtract(prev);
		const outgoing = next.subtract(curr);
		if (incoming.length < 1e-6 || outgoing.length < 1e-6) {
			breaks.push(i);
			continue;
		}
		const cos = Math.max(-1, Math.min(1, incoming.dot(outgoing) / (incoming.length * outgoing.length)));
		if (Math.acos(cos) > maxSmoothTurn) breaks.push(i);
	}
	if (breaks.length === 0) return [Array.from(lot).concat([lot[0]])];

	const edges = [];
	for (let bi = 0; bi < breaks.length; bi++) {
		const start = breaks[bi];
		const end = breaks[(bi + 1) % breaks.length];
		const path = [lot[start]];
		let i = start;
		do {
			i = (i + 1) % n;
			path.push(lot[i]);
		} while (i !== end);
		edges.push(path);
	}
	return edges;
}

function createParkHedges(lots) {
	const hedges = [];
	if (!lots || lots.length === 0) return hedges;
	for (let li = 0; li < lots.length; li++) {
		const lot = lots[li];
		if (!lot || lot.length < 3) continue;
		const edges = conceptualParkEdges(lot);
		for (let i = 0; i < edges.length; i++) {
			const edge = edges[i];
			if (pathLength(edge) < 1.2) continue;
			const mid = pathMidpoint(edge);
			if (parkFeatureHash(mid.x, mid.y, li * 31 + i) < 0.2) hedges.push(edge);
		}
	}
	return hedges;
}

// Park subdivision: fill the park block with green ('park'-class) patches using the same
// inset-block + slicer machinery as a buildable ward, but cut by true bezier-spline walkways
// (sliceWard with bezierCuts) instead of the elbow cuts used for building lots. The patches are
// the green lawn areas; the gaps the slicer leaves between them are the walkways.
export function createParkGeometry(model, patch, widths) {
	const block = patch.block;
	if (!block || block.length < 3) return [];
	const tagPark = (lot) => { if (lot) lot.class = 'park'; return lot; };

	const area = Math.abs(block.square);
	const scale = Math.sqrt(area);

	// One dominant orientation for the walkways, like a buildable ward's lot grid.
	const axis = principalAxis(block);
	if (Random.bool(0.5)) axis.set(new Point(-axis.y, axis.x));

	const alley = widths.alley || 0.8;
	const params = {
		// Smaller target patches than a building ward so even a modest park gets cut by at least
		// one walkway rather than rendering as a single undivided lawn.
		minSq: 45,
		blockSize: 8,
		gridChaos: 0.65 + Random.float() * 0.25,
		sizeChaos: 0.4,
		// Gap between patches = walkway width. A touch wider than a building alley so the paths read.
		gap: Math.max(alley, 0.9),
		emptyProb: 0,
		// Walkways are true bezier splines, not elbow/arc cuts.
		bezierCuts: true,
		primaryDir: axis,
		directionJitter: 0.45,
		minLotArea: Math.max(24, (widths.main || 2) * (widths.main || 2) * 5),
		minLotAngle: Math.PI / 7,
		minLotNeck: alley * 1.1,
	};

	// Only a park too small to hold a single patch + walkway stays one undivided lawn.
	if (area < params.minSq * 2 || scale < (widths.main || 2) * 3) {
		const geometry = [tagPark(new Polygon(block))];
		recordParkPatchRings(geometry);
		patch.hedges = createParkHedges(geometry);
		return geometry;
	}

	const { lots, alleys } = sliceWard(block, params);
	const geometry = (lots && lots.length > 0 ? lots : [new Polygon(block)]).filter((l) => l && l.length >= 3);
	recordParkPathTrees(alleys, block, params.gap);
	recordParkPatchRings(geometry);
	patch.hedges = createParkHedges(geometry);
	return geometry.map(tagPark);
}

function clonePolygon(poly, cls = null) {
	const out = new Polygon(Array.from(poly, (v) => new Point(v.x, v.y)));
	if (cls) out.class = cls;
	return out;
}

function polygonContainsAll(poly, points) {
	return points.every((p) => pointInPolygon(p, poly));
}

function pointOnSegment(a, b, t) {
	return new Point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}

function polygonFitsInside(poly, candidate, step = 0.9, clearance = 0) {
	if (!poly || !candidate || candidate.length < 3) return false;
	const pointFits = (p) => pointInPolygon(p, poly) && (!(clearance > 0) || pointPolygonDistance(p, poly) >= clearance);
	for (const p of candidate) if (!pointFits(p)) return false;
	for (let i = 0; i < candidate.length; i++) {
		const a = candidate[i];
		const b = candidate[(i + 1) % candidate.length];
		const len = Point.distance(a, b);
		const samples = Math.max(1, Math.ceil(len / step));
		for (let j = 1; j < samples; j++) {
			const p = pointOnSegment(a, b, j / samples);
			if (!pointFits(p)) return false;
		}
	}
	return true;
}

function orientedRect(center, axis, halfLen, halfWid) {
	const perp = new Point(-axis.y, axis.x);
	return new Polygon([
		new Point(center.x - axis.x * halfLen - perp.x * halfWid, center.y - axis.y * halfLen - perp.y * halfWid),
		new Point(center.x + axis.x * halfLen - perp.x * halfWid, center.y + axis.y * halfLen - perp.y * halfWid),
		new Point(center.x + axis.x * halfLen + perp.x * halfWid, center.y + axis.y * halfLen + perp.y * halfWid),
		new Point(center.x - axis.x * halfLen + perp.x * halfWid, center.y - axis.y * halfLen + perp.y * halfWid),
	]);
}

function orientedLShape(center, axis, halfLen, halfWid) {
	const perp = new Point(-axis.y, axis.x);
	const cutLen = halfLen * (0.35 + Random.float() * 0.2);
	const cutWid = halfWid * (0.35 + Random.float() * 0.25);
	const corner = Math.trunc(Random.float() * 4);
	let local;
	if (corner === 0) {
		local = [[-halfLen, -halfWid], [halfLen, -halfWid], [halfLen, halfWid - cutWid], [halfLen - cutLen, halfWid - cutWid], [halfLen - cutLen, halfWid], [-halfLen, halfWid]];
	} else if (corner === 1) {
		local = [[-halfLen, -halfWid], [halfLen, -halfWid], [halfLen, halfWid], [-halfLen + cutLen, halfWid], [-halfLen + cutLen, halfWid - cutWid], [-halfLen, halfWid - cutWid]];
	} else if (corner === 2) {
		local = [[-halfLen, -halfWid], [halfLen - cutLen, -halfWid], [halfLen - cutLen, -halfWid + cutWid], [halfLen, -halfWid + cutWid], [halfLen, halfWid], [-halfLen, halfWid]];
	} else {
		local = [[-halfLen + cutLen, -halfWid], [halfLen, -halfWid], [halfLen, halfWid], [-halfLen, halfWid], [-halfLen, -halfWid + cutWid], [-halfLen + cutLen, -halfWid + cutWid]];
	}
	return new Polygon(local.map(([u, v]) => new Point(center.x + axis.x * u + perp.x * v, center.y + axis.y * u + perp.y * v)));
}

function projectionExtents(poly, center, dir) {
	let min = Infinity;
	let max = -Infinity;
	for (const v of poly) {
		const pr = (v.x - center.x) * dir.x + (v.y - center.y) * dir.y;
		min = Math.min(min, pr);
		max = Math.max(max, pr);
	}
	return { min, max };
}

function placeSmallHouse(parcel, axis) {
	const yard = parcel.shrinkRobust ? parcel.shrinkRobust(0.75) : null;
	const base = yard && yard.length >= 3 && Math.abs(yard.square) > Math.abs(parcel.square) * 0.2 ? yard : parcel;
	let center = base.centroid;
	if (!pointInPolygon(center, base)) center = base.center;
	if (!pointInPolygon(center, base)) return null;

	const perp = new Point(-axis.y, axis.x);
	const along = projectionExtents(base, center, axis);
	const across = projectionExtents(base, center, perp);
	let halfLen = Math.max(0.6, Math.min(along.max, -along.min) * (0.34 + Random.float() * 0.14));
	let halfWid = Math.max(0.45, Math.min(across.max, -across.min) * (0.29 + Random.float() * 0.12));
	if (!(halfLen > 0.35 && halfWid > 0.26)) return null;

	for (let attempt = 0; attempt < 8; attempt++) {
		const rect = orientedRect(center, axis, halfLen, halfWid);
		if (polygonFitsInside(base, rect, 0.45)) {
			const lShape = Random.bool(0.35) && halfLen > 0.45 && halfWid > 0.35 ? orientedLShape(center, axis, halfLen, halfWid) : null;
			const house = lShape && polygonFitsInside(base, lShape, 0.45) ? lShape : rect;
			house.class = 'outerHouse';
			return house;
		}
		halfLen *= 0.82;
		halfWid *= 0.82;
	}
	return null;
}

function rotateUnit(dir, angle) {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return new Point(dir.x * c - dir.y * s, dir.x * s + dir.y * c);
}

function longestEdgeAxis(poly) {
	let best = null;
	let bestLen = -Infinity;
	if (!poly || poly.length < 2) return new Point(1, 0);
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const edge = b.subtract(a);
		const len = edge.length;
		if (len > bestLen) {
			bestLen = len;
			best = edge;
		}
	}
	return best && best.length > 1e-6 ? best.norm(1) : new Point(1, 0);
}

function parcelTargetCount(area) {
	let base;
	if (area < 1300) base = 4;
	else if (area < 2600) base = 8;
	else if (area < 4400) base = 12;
	else if (area < 6500) base = 16;
	else if (area < 9000) base = 20;
	else if (area < 12000) base = 24;
	else if (area < 15500) base = 28;
	else base = 32;
	if (base > 8 && Random.bool(0.25)) base -= 2;
	return base;
}

function cutSegmentForLine(poly, center, lineDir) {
	const hits = lineBoundaryIntersections(poly, center, lineDir);
	if (hits.length < 2) return null;
	return new Polygon([hits[0].point, hits[hits.length - 1].point]);
}

function trySplitParcel(parcel, axis, useAxis) {
	const baseDir = useAxis ? axis : new Point(-axis.y, axis.x);
	const splitDir = rotateUnit(baseDir, (Random.float() - 0.5) * 0.18);
	const lineDir = new Point(-splitDir.y, splitDir.x);
	const c = parcel.centroid;
	const ext = projectionExtents(parcel, c, splitDir);
	if (!(ext.max - ext.min > 2.2)) return null;

	for (let attempt = 0; attempt < 4; attempt++) {
		const ratio = 0.5 + (Random.float() - 0.5) * 0.18;
		const t = ext.min + (ext.max - ext.min) * ratio;
		const p1 = new Point(c.x + splitDir.x * t, c.y + splitDir.y * t);
		const halves = parcel.cut(p1, p1.add(lineDir), 0);
		if (halves.length < 2) continue;
		const a0 = Math.abs(parcel.square);
		const a1 = Math.abs(halves[0].square);
		const a2 = Math.abs(halves[1].square);
		if (a1 < a0 * 0.14 || a2 < a0 * 0.14 || a1 < 45 || a2 < 45) continue;
		const segment = cutSegmentForLine(parcel, p1, lineDir);
		return { halves, segment };
	}
	return null;
}

function orderedParcelSubdivision(block, axis) {
	const target = parcelTargetCount(Math.abs(block.square));
	const parcels = [new Polygon(block)];
	const cuts = [];
	const locked = new Set();

	for (let guard = 0; guard < target * 4 && parcels.length < target; guard++) {
		let bestIndex = -1;
		let bestArea = -Infinity;
		for (let i = 0; i < parcels.length; i++) {
			if (locked.has(parcels[i])) continue;
			const area = Math.abs(parcels[i].square);
			if (area > bestArea) {
				bestArea = area;
				bestIndex = i;
			}
		}
		if (bestIndex === -1) break;

		const parcel = parcels[bestIndex];
		const c = parcel.centroid;
		const along = projectionExtents(parcel, c, axis);
		const perp = projectionExtents(parcel, c, new Point(-axis.y, axis.x));
		const useAxis = (along.max - along.min) >= (perp.max - perp.min);
		const split = trySplitParcel(parcel, axis, useAxis);
		if (!split) {
			locked.add(parcel);
			continue;
		}
		parcels.splice(bestIndex, 1, split.halves[0], split.halves[1]);
		if (split.segment) cuts.push(split.segment);
	}

	return { lots: parcels.filter((lot) => lot && lot.length >= 3), cuts };
}

function splitParcelLines(cuts) {
	const hedges = [];
	const walls = [];
	for (const cut of cuts || []) {
		if (!cut || cut.length < 2) continue;
		if (Random.bool(0.28)) continue;
		(Random.bool(0.18) ? walls : hedges).push(new Polygon(cut.map((p) => new Point(p.x, p.y))));
	}
	return { hedges, walls };
}

export function createOuterGardenGeometry(model, patch, widths) {
	const block = patch.block;
	if (!block || block.length < 3) return [];

	const axis = longestEdgeAxis(patch.shape || block);
	const area = Math.abs(block.square);
	const { lots, cuts } = area > 700 ? orderedParcelSubdivision(block, axis) : { lots: [new Polygon(block)], cuts: [] };
	const parcels = (lots && lots.length > 0 ? lots : [new Polygon(block)]).filter((lot) => lot && lot.length >= 3);
	const geometry = [];
	for (const parcel of parcels) {
		const lawn = clonePolygon(parcel, 'outerGarden');
		geometry.push(lawn);
		const house = placeSmallHouse(parcel, axis);
		if (house) geometry.push(house);
	}
	geometry.push(clonePolygon(block, 'outerGardenOutline'));
	const lines = splitParcelLines(cuts);
	patch.hedges = lines.hedges;
	patch.cathedralHedges = lines.walls;
	return geometry;
}

function lineBoundaryIntersections(poly, center, dir) {
	const hits = [];
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const edge = b.subtract(a);
		const hit = GeomUtils.intersectLines(center.x, center.y, dir.x, dir.y, a.x, a.y, edge.x, edge.y);
		if (hit && hit.y >= -1e-6 && hit.y <= 1 + 1e-6) {
			hits.push({ t: hit.x, point: new Point(center.x + dir.x * hit.x, center.y + dir.y * hit.x) });
		}
	}
	hits.sort((a, b) => a.t - b.t);
	return hits;
}

function stairHighrise(center, axis, halfLen, halfWid, profile = {}) {
	const perp = new Point(-axis.y, axis.x);
	const steps = profile.steps || (3 + Math.trunc(Random.float() * 2));
	const stepLen = (halfLen * 2) / steps;
	const notchHalfWid = halfWid * (OUTER_HIGHRISE_NOTCH_WIDTH_SCALE / OUTER_HIGHRISE_WIDTH_SCALE);
	const maxSquareNotch = Math.min(notchHalfWid * 0.86, stepLen);
	const notchScale = profile.notchScale != null ? profile.notchScale : 0.46 + Random.float() * 0.26;
	const notch = Math.min(maxSquareNotch, notchHalfWid * notchScale);
	const sx = Random.bool() ? 1 : -1;
	const sy = Random.bool() ? 1 : -1;
	const top = [[-halfLen, halfWid]];
	let topY = halfWid;
	for (let i = 0; i < steps; i++) {
		const x = -halfLen + stepLen * (i + 1);
		top.push([x, topY]);
		if (i < steps - 1) {
			topY = i % 2 === 0 ? halfWid - notch : halfWid;
			top.push([x, topY]);
		}
	}
	const bottom = [[halfLen, -halfWid]];
	let bottomY = -halfWid;
	for (let i = steps - 1; i >= 0; i--) {
		const x = -halfLen + stepLen * i;
		bottom.push([x, bottomY]);
		if (i > 0) {
			bottomY = i % 2 === 0 ? -halfWid + notch : -halfWid;
			bottom.push([x, bottomY]);
		}
	}
	return new Polygon(top.concat(bottom).map(([u, v]) => new Point(
		center.x + axis.x * (u * sx) + perp.x * (v * sy),
		center.y + axis.y * (u * sx) + perp.y * (v * sy)
	)));
}

function ascendingStairHighrise(center, axis, halfLen, halfWid, profile = {}) {
	const perp = new Point(-axis.y, axis.x);
	const steps = profile.steps || (3 + Math.trunc(Random.float() * 2));
	const stepLen = (halfLen * 2) / steps;
	const riseScale = profile.riseScale != null ? profile.riseScale : 1.12 + Random.float() * 0.38;
	const bandScale = profile.bandScale != null ? profile.bandScale : 1.05 + Random.float() * 0.15;
	const stepRise = (halfWid * riseScale) / steps;
	const band = halfWid * bandScale;
	const sx = Random.bool() ? 1 : -1;
	const sy = Random.bool() ? 1 : -1;
	const bottom = [[-halfLen, -halfWid]];
	let y = -halfWid;
	for (let i = 0; i < steps; i++) {
		const x = -halfLen + stepLen * (i + 1);
		bottom.push([x, y]);
		if (i < steps - 1) {
			y += stepRise;
			bottom.push([x, y]);
		}
	}
	const top = [];
	for (let i = steps - 1; i >= 0; i--) {
		const x = -halfLen + stepLen * i;
		const upperY = -halfWid + stepRise * i + band;
		top.push([x + stepLen, upperY]);
		top.push([x, upperY]);
		if (i > 0) top.push([x, upperY - stepRise]);
	}
	return new Polygon(bottom.concat(top).map(([u, v]) => new Point(
		center.x + axis.x * (u * sx) + perp.x * (v * sy),
		center.y + axis.y * (u * sx) + perp.y * (v * sy)
	)));
}

function lShapeHighrise(center, axis, halfLen, halfWid, profile = {}) {
	const perp = new Point(-axis.y, axis.x);
	const cutAlongScale = profile.cutAlongScale != null ? profile.cutAlongScale : 0.36 + Random.float() * 0.24;
	const cutAcrossScale = profile.cutAcrossScale != null ? profile.cutAcrossScale : 0.34 + Random.float() * 0.26;
	const cutAlong = halfLen * cutAlongScale;
	const cutAcross = halfWid * cutAcrossScale;
	const xCut = halfLen - cutAlong;
	const yCut = halfWid - cutAcross;
	const sx = Random.bool() ? 1 : -1;
	const sy = Random.bool() ? 1 : -1;
	const local = [
		[-halfLen, -halfWid],
		[halfLen, -halfWid],
		[halfLen, yCut],
		[xCut, yCut],
		[xCut, halfWid],
		[-halfLen, halfWid],
	].map(([u, v]) => [u * sx, v * sy]);
	const poly = new Polygon(local.map(([u, v]) => new Point(center.x + axis.x * u + perp.x * v, center.y + axis.y * u + perp.y * v)));
	if (poly.square < 0) poly.reverse();
	return poly;
}

function highriseFootprint(center, axis, halfLen, halfWid, kind, profile = {}) {
	if (kind === 'stepped') return stairHighrise(center, axis, halfLen, halfWid, profile.stepped);
	if (kind === 'ascendingStair') return ascendingStairHighrise(center, axis, halfLen, halfWid, profile.ascendingStair);
	return lShapeHighrise(center, axis, halfLen, halfWid, profile.lShape);
}

function randomHighriseKind() {
	const r = Random.float();
	if (r < 0.46) return 'ascendingStair';
	if (r < 0.66) return 'stepped';
	return 'lShape';
}

const OUTER_HIGHRISE_WIDTH_SCALE = 0.65;
const OUTER_HIGHRISE_NOTCH_WIDTH_SCALE = 0.5;

function createHighriseWardProfile(length, width, target, minGap) {
	const rows = width >= 5.2 && target >= 2 ? 2 : 1;
	const slots = Math.max(1, Math.ceil(target / rows));
	const margin = Math.max(0.4, minGap * 0.7);
	const slotLen = Math.max(0, (length - (slots - 1) * minGap - 2 * margin) / slots);
	const slotWid = Math.max(0, (width - (rows - 1) * minGap - 2 * margin) / rows);
	const profile = {
		fixedSize: true,
		lShape: {
			baseLengthFill: 0.90 + Random.float() * 0.06,
			widthFill: 0.34 + Random.float() * 0.06,
			aspectDiv: 2.75 + Random.float() * 0.35,
			cutAlongScale: 0.40 + Random.float() * 0.16,
			cutAcrossScale: 0.38 + Random.float() * 0.16,
		},
		ascendingStair: {
			steps: 3 + Math.trunc(Random.float() * 2),
			baseLengthFill: 0.90 + Random.float() * 0.06,
			lengthScale: 1.22 + Random.float() * 0.08,
			widthFill: 0.94 + Random.float() * 0.08,
			aspectDiv: 1.22 + Random.float() * 0.22,
			riseScale: 1.18 + Random.float() * 0.24,
			bandScale: 1.08 + Random.float() * 0.10,
		},
		stepped: {
			steps: 3 + Math.trunc(Random.float() * 2),
			baseLengthFill: 0.90 + Random.float() * 0.06,
			lengthScale: 1.10 + Random.float() * 0.06,
			widthFill: 0.94 + Random.float() * 0.08,
			aspectDiv: 1.22 + Random.float() * 0.22,
			notchScale: 0.52 + Random.float() * 0.16,
		},
	};
	for (const kind of ['lShape', 'ascendingStair', 'stepped']) {
		const kindProfile = profile[kind];
		const minDims = highriseMinDims(kind);
		let halfLen = slotLen * 0.5 * (kindProfile.baseLengthFill || 0.92);
		let halfWid;
		if (kind === 'lShape') {
			halfWid = Math.min(slotWid * 0.5 * kindProfile.widthFill, halfLen / kindProfile.aspectDiv) * OUTER_HIGHRISE_WIDTH_SCALE;
		} else {
			halfLen *= kindProfile.lengthScale;
			halfWid = Math.min(slotWid * 0.5 * kindProfile.widthFill, halfLen / kindProfile.aspectDiv) * OUTER_HIGHRISE_WIDTH_SCALE;
		}
		kindProfile.halfLen = Math.max(halfLen, minDims.halfLen);
		kindProfile.halfWid = Math.max(halfWid, minDims.halfWid);
	}
	return profile;
}

function highriseMinDims(kind) {
	if (kind === 'lShape') return { halfLen: 6.80, halfWid: 3.85 * OUTER_HIGHRISE_WIDTH_SCALE };
	return kind === 'ascendingStair'
		? { halfLen: 7.30, halfWid: 4.95 * OUTER_HIGHRISE_WIDTH_SCALE }
		: { halfLen: 7.80, halfWid: 5.30 * OUTER_HIGHRISE_WIDTH_SCALE };
}

function buildHighriseAt(base, center, axis, halfLen, halfWid, kind, profile = {}) {
	const minDims = highriseMinDims(kind);
	for (let attempt = 0; attempt < 5; attempt++) {
		if (halfLen < minDims.halfLen || halfWid < minDims.halfWid) return null;
		const b = highriseFootprint(center, axis, halfLen, halfWid, kind, profile);
		if (polygonFitsInside(base, b, 0.6)) {
			b.class = 'highrise';
			return b;
		}
		if (profile.fixedSize) return null;
		halfLen *= 0.86;
		halfWid *= 0.86;
	}
	return null;
}

function segmentDistance(a, b, c, d) {
	const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	const overlaps = (p, q, r, s) =>
		Math.min(p.x, q.x) <= Math.max(r.x, s.x) + 1e-6 &&
		Math.min(r.x, s.x) <= Math.max(p.x, q.x) + 1e-6 &&
		Math.min(p.y, q.y) <= Math.max(r.y, s.y) + 1e-6 &&
		Math.min(r.y, s.y) <= Math.max(p.y, q.y) + 1e-6;
	if (overlaps(a, b, c, d) && cross(a, b, c) * cross(a, b, d) <= 1e-9 && cross(c, d, a) * cross(c, d, b) <= 1e-9) return 0;
	const pointSeg = (p, v, w) => {
		const dx = w.x - v.x;
		const dy = w.y - v.y;
		const len2 = dx * dx + dy * dy;
		if (len2 < 1e-9) return Point.distance(p, v);
		const t = Math.max(0, Math.min(1, ((p.x - v.x) * dx + (p.y - v.y) * dy) / len2));
		return Point.distance(p, new Point(v.x + dx * t, v.y + dy * t));
	};
	return Math.min(pointSeg(a, c, d), pointSeg(b, c, d), pointSeg(c, a, b), pointSeg(d, a, b));
}

function polygonDistance(a, b) {
	if (!a || !b || a.length < 3 || b.length < 3) return Infinity;
	if (a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))) return 0;
	let best = Infinity;
	for (let i = 0; i < a.length; i++) {
		const a0 = a[i];
		const a1 = a[(i + 1) % a.length];
		for (let j = 0; j < b.length; j++) {
			best = Math.min(best, segmentDistance(a0, a1, b[j], b[(j + 1) % b.length]));
			if (best <= 0) return 0;
		}
	}
	return best;
}

function finishHighriseParkPatches(block, pieces, gap) {
	const minArea = Math.max(1, gap * gap * 0.5);
	const ground = (pieces || []).filter((p) => p && p.length >= 3 && Math.abs(p.square) > minArea);
	return (ground.length > 0 ? ground : [new Polygon(block)]).map((p) => clonePolygon(p, 'outerHighrisePark'));
}

function highriseTargetCount(usable, axis) {
	const c = usable.centroid;
	const perp = new Point(-axis.y, axis.x);
	const along = projectionExtents(usable, c, axis);
	const across = projectionExtents(usable, c, perp);
	const length = along.max - along.min;
	const width = across.max - across.min;
	const area = Math.abs(usable.square);
	if (area < 850 || width < 3.9 || length < 5.0) return 1;
	if (area < 2000 || width < 6.0) return 3 + (length > 9 && width > 5.0 && Random.bool(0.45) ? 1 : 0);
	if (area < 4800 || width < 9.0) return 4 + (length > 10 && Random.bool(0.65) ? 1 : 0);
	return Math.min(9, 5 + (area > 6400 && width > 9.5 ? 1 : 0) + (area > 9000 && length > 12 ? 1 : 0) + (area > 13000 && Random.bool(0.65) ? 1 : 0));
}

// Place highrise buildings on a regular slot grid (slotCount along axis × rowCount across).
// Each slot fits one building scaled to most of its cell, so the ward fills evenly. Zig-zag
// kinds get a wider halfWid baseline so they read as larger, chunkier buildings.
function placeHighriseBuildingsSlotted(usable, axis, slotCount, rowCount, opts) {
	const { length, width, minGap, minHalfWid, maxAspect, profile, placementAttempts = 48 } = opts;
	if (slotCount < 1 || rowCount < 1) return [];
	const center = usable.centroid;
	const perp = new Point(-axis.y, axis.x);
	const margin = Math.max(0.4, minGap * 0.7);

	const usableLen = length - (slotCount - 1) * minGap - 2 * margin;
	if (!(usableLen >= slotCount * 1.6)) return [];
	const slotLen = usableLen / slotCount;

	const usableWid = width - (rowCount - 1) * minGap - 2 * margin;
	if (!(usableWid >= rowCount * 1.4)) return [];
	const slotWid = usableWid / rowCount;

	const startAlong = -length / 2 + margin + slotLen / 2;
	const startAcross = -width / 2 + margin + slotWid / 2;

	const buildings = [];
	for (let row = 0; row < rowCount; row++) {
		const acrossSlot = startAcross + row * (slotWid + minGap);
		for (let col = 0; col < slotCount; col++) {
			const alongSlot = startAlong + col * (slotLen + minGap);

			let placed = null;
			for (let attempt = 0; attempt < placementAttempts && !placed; attempt++) {
				const kind = randomHighriseKind();
				const kindProfile = (profile && profile[kind]) || {};
				let halfLen = kindProfile.halfLen;
				let halfWid = kindProfile.halfWid;
				if (!(halfLen > 0 && halfWid > 0)) {
					halfLen = slotLen * 0.5 * (kindProfile.baseLengthFill || 0.88);
					halfWid = slotWid * 0.5 * (kindProfile.widthFill || 0.7) * OUTER_HIGHRISE_WIDTH_SCALE;
				}
				const minDims = highriseMinDims(kind);
				halfLen = Math.max(halfLen, minDims.halfLen);
				halfWid = Math.max(Math.max(halfWid, minHalfWid), minDims.halfWid);
				if (halfLen / halfWid > maxAspect) halfLen = halfWid * maxAspect;
				if (halfWid < minHalfWid || halfLen < 1.65) continue;

				// Small jitter inside the slot so trials with the same grid produce variety.
				const alongJitter = (Random.float() - 0.5) * Math.max(minGap * 1.2, slotLen - 2 * halfLen) * 0.9;
				const acrossJitter = (Random.float() - 0.5) * Math.max(minGap * 1.0, slotWid - 2 * halfWid) * 0.65;
				const c = new Point(
					center.x + axis.x * (alongSlot + alongJitter) + perp.x * (acrossSlot + acrossJitter),
					center.y + axis.y * (alongSlot + alongJitter) + perp.y * (acrossSlot + acrossJitter)
				);
				const building = buildHighriseAt(usable, c, axis, halfLen, halfWid, kind, profile);
				if (!building) continue;
				if (buildings.some((other) => polygonDistance(building, other) < minGap)) continue;
				placed = building;
			}
			if (placed) buildings.push(placed);
		}
	}
	return buildings;
}

function createHighriseBuildings(block, axis) {
	const base = block.shrinkRobust ? block.shrinkRobust(0.9) : block;
	const usable = base && base.length >= 3 && Math.abs(base.square) > Math.abs(block.square) * 0.25 ? base : block;
	const center = usable.centroid;
	const perp = new Point(-axis.y, axis.x);
	const along = projectionExtents(usable, center, axis);
	const across = projectionExtents(usable, center, perp);
	const length = along.max - along.min;
	const width = across.max - across.min;
	if (length < 3.8 || width < 1.8) return [];

	const target = highriseTargetCount(usable, axis);
	const minGap = 0.55;
	const profile = createHighriseWardProfile(length, width, target, minGap);
	const opts = { length, width, minGap, minHalfWid: 0.70 * OUTER_HIGHRISE_WIDTH_SCALE, maxAspect: 4.2 / OUTER_HIGHRISE_WIDTH_SCALE, profile, placementAttempts: 72 };

	// Multiple slot/row layouts with repeated placement attempts; keep the densest result,
	// using area only as the tie-breaker. Stricter minimum footprints need the extra search.
	const trials = [];
	const addTrial = (slots, rows) => {
		slots = Math.max(1, slots);
		rows = Math.max(1, rows);
		if (!trials.some((t) => t.slots === slots && t.rows === rows)) trials.push({ slots, rows });
	};
	for (let slots = target - 1; slots <= target + 2; slots++) addTrial(slots, 1);
	if (width >= 5.2 && target >= 2) {
		for (let slots = Math.ceil((target - 1) / 2); slots <= Math.ceil((target + 3) / 2); slots++) addTrial(slots, 2);
	}

	let best = [];
	let bestArea = -1;
	for (const trial of trials) {
		for (let repeat = 0; repeat < 5; repeat++) {
			const buildings = placeHighriseBuildingsSlotted(usable, axis, trial.slots, trial.rows, opts);
			let area = 0;
			for (const b of buildings) area += Math.abs(b.square);
			if (buildings.length > best.length || (buildings.length === best.length && area > bestArea)) {
				bestArea = area;
				best = buildings;
			}
		}
	}

	if (best.length === 0) {
		const kind = width > 4.5 && length > 6.0 ? randomHighriseKind() : 'lShape';
		const minDims = highriseMinDims(kind);
		const kindProfile = profile[kind] || {};
		const halfWid = Math.max(minDims.halfWid, kindProfile.halfWid || 0);
		const halfLen = Math.max(minDims.halfLen, kindProfile.halfLen || 0);
		const b = buildHighriseAt(usable, center, axis, halfLen, halfWid, kind, profile);
		if (b) best = [b];
	}
	return best;
}

function pointInOrOnPolygon(p, poly) {
	return pointInPolygon(p, poly) || pointPolygonDistance(p, poly) < 1e-5;
}

function pathInsidePolygon(path, poly, step = 0.55) {
	if (!path || path.length < 2) return false;
	for (let i = 0; i < path.length - 1; i++) {
		const a = path[i];
		const b = path[i + 1];
		const len = Point.distance(a, b);
		const samples = Math.max(1, Math.ceil(len / step));
		for (let j = 0; j <= samples; j++) {
			const p = pointOnSegment(a, b, j / samples);
			if (!pointInOrOnPolygon(p, poly)) return false;
		}
	}
	return true;
}

function closestPointOnSegmentParam(p, a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const l2 = dx * dx + dy * dy;
	if (l2 < 1e-9) return { t: 0, point: a.clone(), distance: Point.distance(p, a) };
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
	const point = new Point(a.x + dx * t, a.y + dy * t);
	return { t, point, distance: Point.distance(p, point) };
}

function existingPathSegments(paths) {
	const out = [];
	for (const path of paths || []) {
		if (!path || path.length < 2) continue;
		for (let i = 0; i < path.length - 1; i++) {
			if (Point.distance(path[i], path[i + 1]) > 1e-6) out.push([path[i], path[i + 1]]);
		}
	}
	return out;
}

function highriseInwardNormal(poly, edgeIndex) {
	const a = poly[edgeIndex];
	const b = poly[(edgeIndex + 1) % poly.length];
	const edge = b.subtract(a);
	if (edge.length < 1e-6) return new Point(0, 0);
	let n = edge.rotate90().norm(1);
	const mid = pointOnSegment(a, b, 0.5);
	if (!pointInOrOnPolygon(mid.add(n.scale(0.35)), poly)) n = n.scale(-1);
	return n;
}

function rayToBlockEdge(poly, origin, dir, skipEdge = -1, minT = 1e-5) {
	let best = null;
	for (let i = 0; i < poly.length; i++) {
		if (i === skipEdge) continue;
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const edge = b.subtract(a);
		if (edge.length < 1e-10) continue;
		const hit = GeomUtils.intersectLines(origin.x, origin.y, dir.x, dir.y, a.x, a.y, edge.x, edge.y);
		if (!hit || hit.x <= minT || hit.y <= 1e-5 || hit.y >= 1 - 1e-5) continue;
		if (!best || hit.x < best.t) {
			best = {
				t: hit.x,
				edge: i,
				point: new Point(origin.x + dir.x * hit.x, origin.y + dir.y * hit.x),
			};
		}
	}
	return best;
}

function highriseBuildingElbowPath(block, building, buildings, existingPaths, gap) {
	if (!block || block.length < 3) return null;
	if (!building || building.length < 3) return null;
	const minLeg = Math.max(1.6, gap * 2.4);
	const target = building.centroid;
	const edgeOrder = [];
	for (let i = 0; i < block.length; i++) {
		const a = block[i];
		const b = block[(i + 1) % block.length];
		const hit = closestPointOnSegmentParam(target, a, b);
		const len = Point.distance(a, b);
		edgeOrder.push({ i, len, hit, rank: hit.distance * (0.85 + Random.float() * 0.3) });
	}
	edgeOrder.sort((a, b) => a.rank - b.rank);

	for (const { i: edgeIndex, len, hit } of edgeOrder) {
		if (len < minLeg * 1.25) continue;
		if (hit.t < 0.08 || hit.t > 0.92) continue;
		const a = block[edgeIndex];
		const b = block[(edgeIndex + 1) % block.length];
		const edge = b.subtract(a);
		if (edge.length < 1e-6) continue;
		const along = edge.norm(1);
		const inward = highriseInwardNormal(block, edgeIndex);
		if (inward.length < 1e-6) continue;
		const dirs = Random.bool(0.5) ? [along, along.scale(-1)] : [along.scale(-1), along];
		const entry = hit.point;
		const firstLeg = target.subtract(entry);
		if (firstLeg.length < minLeg) continue;
		if (firstLeg.dot(inward) <= minLeg * 0.55) continue;

		for (const dir of dirs) {
			const exit = rayToBlockEdge(block, target, dir, edgeIndex, minLeg);
			if (!exit || exit.edge === edgeIndex || exit.t < minLeg) continue;
			const path = new Polygon([entry, target, exit.point]);
			if (!pathInsidePolygon(path, block)) continue;
			if (pathTooCloseToExistingPaths(path, existingPaths, gap)) continue;
			if (pathTooCloseToOtherBuildings(path, building, buildings, gap)) continue;
			const sliced = slicePolygonAlongElbow(block, edgeIndex, exit.edge, path, gap);
			if (sliced.lots && sliced.lots.length > 1) return { path, entryEdge: edgeIndex, exitEdge: exit.edge };
		}
	}
	return null;
}

function pathTooCloseToExistingPaths(path, paths, clearance) {
	if (!path || path.length < 2 || !paths || paths.length === 0) return false;
	const minDist = clearance * 0.72;
	const segments = existingPathSegments(paths);
	for (let i = 0; i < path.length - 1; i++) {
		const a = path[i];
		const b = path[i + 1];
		const len = Point.distance(a, b);
		const samples = Math.max(2, Math.ceil(len / Math.max(0.3, clearance * 0.45)));
		for (let j = 1; j <= samples; j++) {
			if (i === 0 && j / samples < 0.24) continue;
			const p = pointOnSegment(a, b, j / samples);
			for (const [c, d] of segments) {
				if (pointSegmentDistance(p, c, d) < minDist) return true;
			}
		}
	}
	return false;
}

function pathTooCloseToOtherBuildings(path, targetBuilding, buildings, clearance) {
	if (!path || path.length < 2 || !buildings || buildings.length === 0) return false;
	const minDist = clearance * 0.42;
	for (let i = 0; i < path.length - 1; i++) {
		const a = path[i];
		const b = path[i + 1];
		const len = Point.distance(a, b);
		const samples = Math.max(2, Math.ceil(len / Math.max(0.25, clearance * 0.35)));
		for (let j = 0; j <= samples; j++) {
			if (i === path.length - 2 && j / samples > 0.72) continue;
			const p = pointOnSegment(a, b, j / samples);
			for (const building of buildings) {
				if (building === targetBuilding) continue;
				if (pointInPolygon(p, building) || pointPolygonDistance(p, building) < minDist) return true;
			}
		}
	}
	return false;
}

function edgeContainingPoint(poly, point, tolerance = 0.08) {
	if (!poly || poly.length < 3 || !point) return -1;
	let best = -1;
	let bestDistance = Infinity;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const hit = closestPointOnSegmentParam(point, a, b);
		if (hit.t <= 1e-5 || hit.t >= 1 - 1e-5) continue;
		if (hit.distance < bestDistance) {
			best = i;
			bestDistance = hit.distance;
		}
	}
	return bestDistance <= tolerance ? best : -1;
}

function cutCurrentHighrisePiece(pieces, cut, gap) {
	if (!cut || !cut.path || cut.path.length < 3) return null;
	const entry = cut.path[0];
	const exit = cut.path[cut.path.length - 1];
	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i];
		if (!piece || piece.length < 3) continue;
		if (!pathInsidePolygon(cut.path, piece, Math.max(0.3, gap * 0.45))) continue;
		const entryEdge = edgeContainingPoint(piece, entry, Math.max(0.08, gap * 0.2));
		if (entryEdge === -1) continue;
		const exitEdge = edgeContainingPoint(piece, exit, Math.max(0.08, gap * 0.2));
		if (exitEdge === -1 || exitEdge === entryEdge) continue;
		const sliced = slicePolygonAlongElbow(piece, entryEdge, exitEdge, cut.path, gap);
		if (!sliced.lots || sliced.lots.length < 2) continue;
		const minArea = Math.max(1, gap * gap * 0.5);
		const lots = sliced.lots.filter((p) => p && p.length >= 3 && Math.abs(p.square) > minArea);
		if (lots.length < 2) continue;
		const next = pieces.slice();
		next.splice(i, 1, ...lots);
		return next;
	}
	return null;
}

function createHighriseAccessGeometry(block, buildings, widths) {
	const gap = Math.max(0.7, (widths.alley || 0.8) * 0.95);
	const paths = [];
	let pieces = [new Polygon(block)];

	const candidates = (buildings || []).slice();
	for (let i = candidates.length - 1; i > 0; i--) {
		const j = Math.trunc(Random.float() * (i + 1));
		const t = candidates[i];
		candidates[i] = candidates[j];
		candidates[j] = t;
	}
	for (const building of candidates) {
		const cut = highriseBuildingElbowPath(block, building, buildings || [], paths, gap);
		if (!cut) continue;
		const nextPieces = cutCurrentHighrisePiece(pieces, cut, gap);
		if (!nextPieces) continue;
		pieces = nextPieces;
		paths.push(cut.path);
	}
	return { ground: finishHighriseParkPatches(block, pieces, gap), paths, pieces, gap };
}

function distanceToPaths(point, paths) {
	let best = Infinity;
	for (const path of paths || []) {
		if (!path || path.length < 2) continue;
		for (let i = 0; i < path.length - 1; i++) {
			best = Math.min(best, pointSegmentDistance(point, path[i], path[i + 1]));
		}
	}
	return best;
}

function hedgeClearOfBuildings(a, b, buildings, clearance) {
	if (!buildings || buildings.length === 0) return true;
	const len = Point.distance(a, b);
	const samples = Math.max(2, Math.ceil(len / 0.45));
	for (let i = 0; i <= samples; i++) {
		const p = pointOnSegment(a, b, i / samples);
		for (const building of buildings) {
			if (pointInPolygon(p, building) || pointPolygonDistance(p, building) < clearance) return false;
		}
	}
	return true;
}

function hedgeCrossesAlleyInterior(a, b, paths, clearance) {
	if (!paths || paths.length === 0) return false;
	const len = Point.distance(a, b);
	if (len < 1e-6) return true;
	const samples = Math.max(3, Math.ceil(len / Math.max(0.25, clearance * 0.5)));
	for (let i = 1; i < samples; i++) {
		const t = i / samples;
		if (t < 0.12 || t > 0.88) continue;
		if (distanceToPaths(pointOnSegment(a, b, t), paths) < clearance) return true;
	}
	return false;
}

function highriseHedgeEdgeKey(a, b) {
	const key = (p) => `${Math.round(p.x * 20)},${Math.round(p.y * 20)}`;
	const ka = key(a);
	const kb = key(b);
	return ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`;
}

function createOuterHighriseHedges(block, pieces, paths, buildings, gap, chance = 0.88) {
	const hedges = [];
	const walls = [];
	if (!block || block.length < 3 || !pieces || pieces.length === 0) return { hedges, walls };
	const candidates = [];
	const seen = new Set();
	const minLen = Math.max(0.8, gap * 0.9);
	const buildingClearance = Math.max(0.16, gap * 0.22);

	for (const piece of pieces) {
		if (!piece || piece.length < 3) continue;
		for (let i = 0; i < piece.length; i++) {
			const a = piece[i];
			const b = piece[(i + 1) % piece.length];
			const len = Point.distance(a, b);
			if (len < minLen) continue;
			const key = highriseHedgeEdgeKey(a, b);
			if (seen.has(key)) continue;
			seen.add(key);
			if (!hedgeClearOfBuildings(a, b, buildings, buildingClearance)) continue;

			const mid = pointOnSegment(a, b, 0.5);
			const pathDist = distanceToPaths(mid, paths);
			if (hedgeCrossesAlleyInterior(a, b, paths, gap * 0.18) || pathDist < gap * 0.24) continue;

			const onOuter = pointPolygonDistance(mid, block) < Math.max(0.08, gap * 0.1);
			const onAlleySide = pathDist < gap * 0.82;
			if (!onOuter && !onAlleySide) continue;
			const edgeChance = Math.max(0, Math.min(1, chance * (onAlleySide ? 1.2 : 1)));
			if (!Random.bool(edgeChance)) continue;
			candidates.push({ a, b });
		}
	}

	for (const c of candidates) {
		const line = new Polygon([new Point(c.a.x, c.a.y), new Point(c.b.x, c.b.y)]);
		(Random.bool(1 / 3) ? walls : hedges).push(line);
	}
	return { hedges, walls };
}

export function createOuterHighriseGeometry(model, patch, widths) {
	const block = patch.block;
	if (!block || block.length < 3) return [];

	const axis = longestEdgeAxis(patch.shape || block);
	const buildings = createHighriseBuildings(block, axis);
	const { ground: gold, paths, pieces, gap } = createHighriseAccessGeometry(block, buildings, widths);
	const hedgeLines = createOuterHighriseHedges(block, pieces, paths, buildings, gap, 0.8);
	patch.alleys = paths;
	patch.hedges = hedgeLines.hedges;
	patch.cathedralHedges = hedgeLines.walls;
	return [...gold, ...buildings];
}

// Cathedral ward: draw a walled precinct, then place a long church footprint inside it when
// the usable area is generous enough. Compact precincts stay open and get a small grove.
const CATHEDRAL_GATE_WIDTH = 1.2;

function findLongestAndShortestEdges(block) {
	const n = block.length;
	let longest = 0;
	let shortest = 0;
	let longestLen = -Infinity;
	let shortestLen = Infinity;
	for (let i = 0; i < n; i++) {
		const len = Point.distance(block[i], block[(i + 1) % n]);
		if (len > longestLen) {
			longestLen = len;
			longest = i;
		}
		if (len < shortestLen) {
			shortestLen = len;
			shortest = i;
		}
	}
	const gaps = new Set();
	gaps.add(longest);
	if (shortest !== longest) {
		gaps.add(shortest);
	} else if (n > 2) {
		// All edges are the same length: pick the edge farthest around the perimeter so the
		// two openings are still distinct.
		let best = -1;
		let bestDist = -Infinity;
		for (let i = 0; i < n; i++) {
			if (i === longest) continue;
			const dist = Math.min((i - longest + n) % n, (longest - i + n) % n);
			if (dist > bestDist) {
				bestDist = dist;
				best = i;
			}
		}
		if (best !== -1) gaps.add(best);
	}
	return gaps;
}

function createWallSegments(block, gapEdges, gapWidth = CATHEDRAL_GATE_WIDTH) {
	const n = block.length;
	if (n < 3) return [];
	if (gapEdges.size === 0) {
		const closed = Array.from(block, (v) => new Point(v.x, v.y));
		closed.push(new Point(block[0].x, block[0].y));
		return [new Polygon(closed)];
	}

	const subSegments = [];
	for (let i = 0; i < n; i++) {
		const v0 = block[i];
		const v1 = block[(i + 1) % n];
		if (gapEdges.has(i)) {
			const len = Point.distance(v0, v1);
			if (len > gapWidth + 1e-6) {
				const dx = v1.x - v0.x;
				const dy = v1.y - v0.y;
				const along = (len - gapWidth) / 2;
				const p1 = new Point(v0.x + dx * (along / len), v0.y + dy * (along / len));
				const p2 = new Point(v0.x + dx * ((len - along) / len), v0.y + dy * ((len - along) / len));
				subSegments.push([new Point(v0.x, v0.y), p1]);
				subSegments.push([p2, new Point(v1.x, v1.y)]);
			}
			// Edges too short for the gap are left completely open.
		} else {
			subSegments.push([new Point(v0.x, v0.y), new Point(v1.x, v1.y)]);
		}
	}

	if (subSegments.length === 0) return [];

	const merged = [];
	for (const seg of subSegments) {
		if (merged.length === 0) {
			merged.push(seg);
		} else {
			const last = merged[merged.length - 1];
			if (Point.distance(last[last.length - 1], seg[0]) < 1e-9) {
				merged[merged.length - 1] = last.concat(seg.slice(1));
			} else {
				merged.push(seg);
			}
		}
	}

	// Wrap-around: join the last segment to the first if they meet at a non-gap edge.
	if (merged.length > 1) {
		const first = merged[0];
		const last = merged[merged.length - 1];
		if (Point.distance(last[last.length - 1], first[0]) < 1e-9) {
			merged[0] = last.concat(first.slice(1));
			merged.pop();
		}
	}

	return merged.filter((s) => s.length >= 2).map((s) => new Polygon(s));
}

function orientedCross(center, axis, halfLen, halfWid, transeptHalfLen, transeptHalfWid, longSide = 1) {
	const perp = new Point(-axis.y, axis.x);
	const crossHalfLen = Math.min(halfLen * 0.22, Math.max(halfWid * 1.1, transeptHalfLen));
	const longLen = halfLen * 1.18;
	const shortLen = halfLen * 0.42;
	const left = longSide > 0 ? -shortLen : -longLen;
	const right = longSide > 0 ? longLen : shortLen;
	const local = [
		[left, -halfWid],
		[-crossHalfLen, -halfWid],
		[-crossHalfLen, -transeptHalfWid],
		[crossHalfLen, -transeptHalfWid],
		[crossHalfLen, -halfWid],
		[right, -halfWid],
		[right, halfWid],
		[crossHalfLen, halfWid],
		[crossHalfLen, transeptHalfWid],
		[-crossHalfLen, transeptHalfWid],
		[-crossHalfLen, halfWid],
		[left, halfWid],
	];
	return new Polygon(local.map(([u, v]) => new Point(center.x + axis.x * u + perp.x * v, center.y + axis.y * u + perp.y * v)));
}

function createCathedralFootprint(block, widths) {
	const clearance = Math.max((widths.alley || 0.8) * 1.15, (widths.regular || 1) * 0.9, 1.05);
	const yard = block.shrinkRobust ? block.shrinkRobust(clearance) : null;
	if (!yard || yard.length < 3 || Math.abs(yard.square) < Math.abs(block.square) * 0.08) return null;
	const usable = yard;
	let center = usable.centroid;
	if (!pointInPolygon(center, usable)) center = usable.center;
	if (!pointInPolygon(center, usable)) return null;

	const baseAxis = principalAxis(usable);
	const minHalfLen = Math.max(2.8, (widths.main || 2) * 1.45);
	const minHalfWid = Math.max(0.75, (widths.regular || 1) * 0.8);
	const wantsCross = Random.bool(0.55);
	const fitStep = Math.min(0.55, clearance / 2);
	let best = null;
	let bestArea = -Infinity;

	for (let angleIndex = 0; angleIndex < 10; angleIndex++) {
		const axis = rotateUnit(baseAxis, (Math.PI * angleIndex) / 10);
		const perp = new Point(-axis.y, axis.x);
		const along = projectionExtents(usable, center, axis);
		const across = projectionExtents(usable, center, perp);
		const halfAlong = Math.min(along.max, -along.min);
		const halfAcross = Math.min(across.max, -across.min);
		if (halfAlong < minHalfLen || halfAcross < minHalfWid) continue;

		let halfLen = halfAlong * 0.92;
		let halfWid = Math.min(halfAcross * 0.52, halfLen * 0.26);
		for (let scaleAttempt = 0; scaleAttempt < 5; scaleAttempt++) {
			if (halfLen < minHalfLen || halfWid < minHalfWid) break;
			const footprints = wantsCross && halfAcross > halfWid * 1.8 && halfLen > minHalfLen * 1.12
				? [
					orientedCross(center, axis, halfLen, halfWid, halfWid * 1.45, Math.min(halfAcross * 0.78, halfWid * 2.45), 1),
					orientedCross(center, axis, halfLen, halfWid, halfWid * 1.45, Math.min(halfAcross * 0.78, halfWid * 2.45), -1),
				]
				: [orientedRect(center, axis, halfLen, halfWid)];
			for (const footprint of footprints) {
				if (!polygonFitsInside(usable, footprint, fitStep)) continue;
				if (!polygonFitsInside(block, footprint, fitStep, clearance)) continue;
				const area = Math.abs(footprint.square);
				if (area > bestArea) {
					best = footprint;
					bestArea = area;
				}
			}
			halfLen *= 0.9;
			halfWid *= 0.9;
		}
	}

	if (!best) return null;
	best.class = 'cathedral';
	return best;
}

function cathedralGatePoints(block, gapEdges) {
	const gates = [];
	for (const edgeIndex of gapEdges) {
		const v0 = block[edgeIndex];
		const v1 = block[(edgeIndex + 1) % block.length];
		if (Point.distance(v0, v1) < 1e-6) continue;
		gates.push(pointOnSegment(v0, v1, 0.5));
	}
	return gates;
}

function createCathedralPaths(block, gapEdges) {
	const gates = cathedralGatePoints(block, gapEdges);
	if (gates.length < 2) return [];
	let center = block.centroid;
	if (!pointInPolygon(center, block)) center = block.center;
	return [new Polygon([gates[0], center, gates[1]])];
}

function createCathedralGround(block, gapEdges, widths, gateWidth = CATHEDRAL_GATE_WIDTH) {
	const path = createCathedralPaths(block, gapEdges)[0];
	if (!path || path.length < 3) return [clonePolygon(block, 'cathedralGround')];

	const edges = Array.from(gapEdges);
	if (edges.length < 2) return [clonePolygon(block, 'cathedralGround')];

	const gap = Math.max(gateWidth, (widths.alley || 0.8) * 0.95);
	const sliced = slicePolygonAlongElbow(block, edges[0], edges[1], path, gap);
	const pieces = sliced.lots && sliced.lots.length > 1 ? sliced.lots : [block];
	return pieces.map((p) => clonePolygon(p, 'cathedralGround'));
}

function cathedralFeatureKind(x, y, salt, index) {
	const band = Math.trunc(parkFeatureHash(x, y, salt) * 3);
	const cycle = (index + band) % 5;
	if (cycle === 1) return 'fountain';
	if (cycle === 3) return 'object';
	return 'tree';
}

function recordCathedralFeatures(ground, footprint, widths, gateWidth = CATHEDRAL_GATE_WIDTH) {
	if (!ground || ground.length === 0) return;
	const boundaryClearance = Math.max(0.75, gateWidth * 0.58, (widths.alley || 0.8) * 0.9);
	const buildingClearance = Math.max(0.9, (widths.regular || 1) * 0.9);
	const minSpacing = Math.max(1.25, gateWidth * 1.05);
	const placed = [];

	for (let gi = 0; gi < ground.length; gi++) {
		const piece = ground[gi];
		if (!piece || piece.length < 3) continue;
		const area = Math.abs(piece.square);
		if (area < 8) continue;
		const bounds = piece.getBounds();
		const target = Math.max(2, Math.min(18, Math.floor(area / 12)));
		const maxAttempts = target * 44;
		let made = 0;

		for (let i = 0; i < maxAttempts && made < target; i++) {
			const rx = parkFeatureHash(piece.centroid.x, piece.centroid.y, gi * 409 + i * 2 + 1);
			const ry = parkFeatureHash(piece.centroid.y, piece.centroid.x, gi * 409 + i * 2 + 2);
			const p = new Point(
				bounds.left + (bounds.right - bounds.left) * rx,
				bounds.top + (bounds.bottom - bounds.top) * ry
			);
			if (!pointInPolygon(p, piece)) continue;
			if (pointPolygonDistance(p, piece) < boundaryClearance) continue;
			if (footprint && (pointInPolygon(p, footprint) || pointPolygonDistance(p, footprint) < buildingClearance)) continue;
			if (placed.some((q) => Point.distance(p, q) < minSpacing)) continue;
			placed.push(p);
			recordFeature(p.x, p.y, cathedralFeatureKind(p.x, p.y, gi * 97 + i, made + gi));
			made++;
		}
	}
}

export function createCathedralGeometry(model, patch, widths) {
	const block = patch.block;
	if (!block || block.length < 3) return [];

	const footprint = createCathedralFootprint(block, widths);

	const gapEdges = findLongestAndShortestEdges(block);
	const ground = createCathedralGround(block, gapEdges, widths, CATHEDRAL_GATE_WIDTH);
	recordCathedralFeatures(ground, footprint, widths, CATHEDRAL_GATE_WIDTH);
	patch.cathedralHedges = createWallSegments(block, gapEdges, CATHEDRAL_GATE_WIDTH);
	patch.alleys = createCathedralPaths(block, gapEdges);

	return footprint ? [...ground, footprint] : ground;
}

// Dominant orientation (long axis) of a point cloud, via 2x2 covariance eigenvector.
// A whole district shares one axis so its wards' blocks line up across cell boundaries.
export function principalAxis(points) {
	let cx = 0;
	let cy = 0;
	for (const p of points) {
		cx += p.x;
		cy += p.y;
	}
	cx /= points.length;
	cy /= points.length;
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (const p of points) {
		const dx = p.x - cx;
		const dy = p.y - cy;
		sxx += dx * dx;
		sxy += dx * dy;
		syy += dy * dy;
	}
	const tr = (sxx + syy) / 2;
	const det = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
	const l1 = tr + det; // largest eigenvalue
	let ax;
	let ay;
	if (Math.abs(sxy) > 1e-9) {
		ax = l1 - syy;
		ay = sxy;
	} else if (sxx >= syy) {
		ax = 1;
		ay = 0;
	} else {
		ax = 0;
		ay = 1;
	}
	const len = Math.hypot(ax, ay) || 1;
	return new Point(ax / len, ay / len);
}

// Per-district subdivision params (ported from the reference's District.createParams).
export function districtAlleyParams() {
	const norm3 = () => (Random.float() + Random.float() + Random.float()) / 3;
	const fuzzy4 = () => Math.abs((Random.float() + Random.float() + Random.float() + Random.float()) / 2 - 1);
	return {
		minSq: 15 + 40 * fuzzy4(),
		gridChaos: 0.2 + norm3() * 0.8,
		sizeChaos: 0.4 + norm3() * 0.6,
		blockSize: 4 + 10 * norm3(),
	};
}

// Recursively cut a block into lots, alternating cuts along the district `axis` and its
// perpendicular -> a grid aligned to the whole district (the reference cuts perpendicular to
// the shape's OBB long axis). This is what makes neighbouring blocks relate.
export function subdivideAligned(poly, axis, minArea, sizeChaos, gridChaos, alley, depth = 0, useAxis = true) {
	if (!poly || poly.length < 3) return [];
	const area = Math.abs(poly.square);
	const stop = minArea * Math.pow(2, sizeChaos * (2 * Random.float() - 1));
	if (area < stop || depth > 20) return Random.bool(0.04) ? [] : [poly];

	const dir = useAxis ? axis : new Point(-axis.y, axis.x);
	const cutDir = new Point(-dir.y, dir.x);
	const c = poly.centroid;
	let mn = Infinity;
	let mx = -Infinity;
	for (const v of poly) {
		const pr = (v.x - c.x) * dir.x + (v.y - c.y) * dir.y;
		if (pr < mn) mn = pr;
		if (pr > mx) mx = pr;
	}
	const t = (mn + mx) / 2 + (Random.float() - 0.5) * (mx - mn) * 0.5 * gridChaos;
	const cp = new Point(c.x + dir.x * t, c.y + dir.y * t);
	const cp2 = new Point(cp.x + cutDir.x, cp.y + cutDir.y);

	const halves = poly.cut(cp, cp2, alley);
	if (halves.length < 2) return Random.bool(0.04) ? [] : [poly];

	let out = [];
	for (const h of halves) out = out.concat(subdivideAligned(h, axis, minArea, sizeChaos, gridChaos, alley, depth + 1, !useAxis));
	return out;
}

// Returns an array of building-lot polygons for a patch (empty for open/water types).
export function buildWardGeometry(model, patch, widths) {
	if (patch.isWater) return [];
	const block = patch.block;

	switch (patch.type) {
		case 'plaza':
		case 'market':
			return []; // open square

		case 'cathedral':
			if (!block || block.length < 3) return [];
			return createCathedralGeometry(model, patch, widths);

		case 'castle': {
			const b = patch.shape.shrinkEq(widths.main * 2);
			if (!b || b.length < 3) return [];
			return createOrthoBuilding(b, Math.sqrt(Math.abs(b.square)) * 4, 0.6);
		}

		case 'park':
			if (!block || block.length < 3) return [];
			return block.compactness >= 0.7
				? Cutter.radial(block, null, widths.alley)
				: Cutter.semiRadial(block, null, widths.alley);

		case 'farm':
			if (!block || block.length < 3) return [];
			return createAlleys(block, 60 + 40 * Random.float(), 0.3, 0.5, 0.0, true, widths.alley);

		default: {
			if (patch.type !== 'generic' && patch.type !== 'gate' && patch.type !== 'farm') return [];
			// All lots built up — including outskirts (no withinCity gate).
			return createCommonWardGeometry(model, patch, widths);
		}
	}
}
