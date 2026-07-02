// CityGen.js — the FIRST part of the MFCG pipeline, ported faithfully from the compiled
// reference (reference/mfcg.js, City.buildPatches + City.optimizeJunctions), with the open-source
// Haxe (TownGeneratorOS) used only as a hint where the minified names are unclear.
//
// Scope: place seeds and build the ward cells. (Walls, streets, water, districts, buildings come
// later.) Output is plain JSON-serializable data so it can drive a renderer or a Django backend.
//
// Determinism: same `seed` -> same cities, because we reproduce the reference's PRNG call order
// exactly (Park–Miller LCG in Random.js: seed = 48271*seed % 2147483647).

import { Random } from './Random.js';
import { Point } from './Point.js';
import { Polygon } from './Polygon.js';
import { Voronoi } from './Voronoi.js';
import { makeFractal } from './Noise.js';
import { buildRiver, smoothShore } from './River.js';
import { addObstacleCrossings, buildCityWall, displaceWallTowers, suppressWallSegmentsOnRiver } from './Walls.js?v=2';
import { buildStreets } from './Streets.js';
import { buildDocks } from './Docks.js';
import { amin, remove } from './arrays.js';
import {
	cathedralRate,
	createCathedralGeometry,
	createCommonWardGeometry,
	createOuterGardenGeometry,
	createOuterHighriseGeometry,
	createParkGeometry,
	marketRate,
	OPEN_TYPES,
} from './wards.js';
import { clearFeatures, recordFeature, takeFeatures } from './features.js';

// reference constant: pc.LTOWER_RADIUS = 2.5 (used as the junction-merge floor 3*LTOWER_RADIUS)
const LTOWER_RADIUS = 2.5;

// TEMP PERF TEST: only build decoration wards this many shared-edge steps from
// the inner city. Set to null to restore full outer-ward generation.
const TEMP_OUTER_WARD_EDGE_LIMIT = 2;

function polar(r, a) {
	return new Point(r * Math.cos(a), r * Math.sin(a));
}

function serializePoint(p) {
	return p ? { x: p.x, y: p.y } : null;
}

function serializeBridge(bridge) {
	const point = bridge.point || bridge;
	return {
		...serializePoint(point),
		from: serializePoint(bridge.from),
		to: serializePoint(bridge.to),
		// WIDE_MAIN_ROADS_50_FLAG: expose road-connected bridge width for renderer/routing.
		roadConnected: !!bridge.roadConnected,
		width: Number.isFinite(bridge.width) ? bridge.width : undefined,
	};
}

function serializeDock(dock) {
	return {
		shore: {
			from: serializePoint(dock.shore.from),
			to: serializePoint(dock.shore.to),
		},
		piers: dock.piers.map((pier) => ({
			from: serializePoint(pier.from),
			to: serializePoint(pier.to),
		})),
		large: !!dock.large,
	};
}

function serializeBuilding(building) {
	return {
		polygon: Array.from(building, (v) => ({ x: v.x, y: v.y })),
		class: building.class || 'building',
	};
}

// ---- City.buildPatches (reference) ----
// seeds = origin + phyllotaxis spiral; optional plaza replaces the first 4 ring seeds with a
// diamond (RNG saved/restored so it doesn't shift the rest); Voronoi bounded by a hexagon at 2b;
// cells with any vertex farther than b are dropped; cells sorted by centroid distance.
function buildPatches(size, plazaNeeded, outerRatio = 8) {
	const sa = Random.float() * 2 * Math.PI;
	const points = [new Point(0, 0)];
	let b = 0;
	const seedCount = Math.max(6, Math.ceil(size * outerRatio));
	for (let k = 1; k < seedCount; k++) {
		const r = 10 + k * (2 + Random.float());
		points.push(polar(r, sa + 5 * Math.sqrt(k)));
		if (r > b) b = r;
	}

	if (plazaNeeded) {
		const saved = Random.getSeed();
		const f = 8 + Random.float() * 8;
		const h = f * (1 + Random.float());
		if (h > b) b = h;
		points[1] = polar(f, sa);
		points[2] = polar(h, sa + Math.PI / 2);
		points[3] = polar(f, sa + Math.PI);
		points[4] = polar(h, sa + (3 * Math.PI) / 2);
		Random.reset(saved); // restore RNG so the plaza doesn't perturb later generation
	}

	// Hexagon frame at radius 2b bounds the outer cells (reference: Qd.regular(6, 2*b)).
	const hex = [];
	for (let i = 0; i < 6; i++) hex.push(polar(2 * b, (i / 6) * 2 * Math.PI));

	const voronoi = Voronoi.build(points.concat(hex));
	const regions = voronoi.partioning();

	// cell polygon = the region's circumcenters (shared by reference between adjacent cells)
	let cells = regions.map((r) => new Polygon(r.vertices.map((t) => t.c)));

	// drop cells touching/leaving the seed disk of radius b, and any degenerate/NaN cells
	cells = cells.filter((c) => {
		if (c.length < 3) return false;
		for (const v of c) if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.length > b) return false;
		return true;
	});

	// order by centroid distance from the centre (city is taken from the middle out)
	cells.sort((A, B) => {
		const a = A.centroid;
		const c = B.centroid;
		return a.x * a.x + a.y * a.y - (c.x * c.x + c.y * c.y);
	});

	return { cells, b };
}

// ---- coast (reference: the coastNeeded block at the end of City.buildPatches) ----
// Rotate each cell's centroid by coastDir·π, then flag it as water if it falls inside a noisy
// circle (radius n at g) that opens into a half-plane channel for x>g.x. The RNG used here is
// saved/restored so the coast doesn't shift later generation. Returns the chosen coastDir.
function markCoast(cells, b, coastDir) {
	const saved = Random.getSeed();
	const fractal = makeFractal(6, () => Random.float());
	const f = 20 + Random.float() * 40;
	const k = 0.3 * b * (((Random.float() + Random.float() + Random.float()) / 3) * 2 - 1);
	const n = b * (0.2 + Math.abs((Random.float() + Random.float() + Random.float() + Random.float()) / 2 - 1));
	let dir = coastDir;
	if (dir == null || isNaN(dir)) dir = Math.floor(Random.float() * 20) / 10;
	Random.reset(saved); // restore — coast randomness must not perturb the rest

	const h = dir * Math.PI;
	const q = Math.cos(h);
	const m = Math.sin(h);
	const g = new Point(n + f, k);
	for (const c of cells) {
		const u0 = c.centroid;
		const rx = u0.x * q - u0.y * m;
		const ry = u0.y * q + u0.x * m;
		let u = Math.hypot(g.x - rx, g.y - ry) - n;
		if (rx > g.x) u = Math.min(u, Math.abs(ry - k) - n);
		const r2 = fractal.get((rx + b) / (2 * b), (ry + b) / (2 * b)) * n * Math.sqrt(Math.hypot(rx, ry) / b);
		if (u + r2 < 0) c.water = true;
	}
	return dir;
}

// city = the first `size` non-water cells (reference: the inner/withinCity selection that
// follows the coast block in buildPatches)
function selectCity(cells, size) {
	const inner = [];
	for (const c of cells) {
		if (c.water) continue;
		c.withinCity = true;
		inner.push(c);
		if (inner.length >= size) break;
	}
	return inner;
}

function limitOuterWardsByEdgeDistance(cells, inner, maxDistance) {
	if (!Number.isFinite(maxDistance) || maxDistance < 0 || !inner || inner.length === 0) return cells;

	const edgeCells = new Map();
	const addCellEdge = (a, b, cell) => {
		let byEnd = edgeCells.get(a);
		if (!byEnd) edgeCells.set(a, (byEnd = new Map()));
		let owners = byEnd.get(b);
		if (!owners) byEnd.set(b, (owners = []));
		owners.push(cell);
	};
	for (const cell of cells)
		for (let i = 0; i < cell.length; i++)
			addCellEdge(cell[i], cell[(i + 1) % cell.length], cell);

	const distances = new Map();
	const queue = [];
	for (const cell of inner) {
		distances.set(cell, 0);
		queue.push(cell);
	}

	for (let head = 0; head < queue.length; head++) {
		const cell = queue[head];
		const nextDistance = distances.get(cell) + 1;
		if (nextDistance > maxDistance) continue;
		for (let i = 0; i < cell.length; i++) {
			const reverse = edgeCells.get(cell[(i + 1) % cell.length]);
			const neighbours = reverse ? reverse.get(cell[i]) : null;
			if (!neighbours) continue;
			for (const candidate of neighbours) {
				if (distances.has(candidate) || candidate === cell) continue;
				distances.set(candidate, nextDistance);
				queue.push(candidate);
			}
		}
	}

	return cells.filter((cell) => distances.has(cell));
}

// ---- City.optimizeJunctions (reference) ----
// Collapse edges shorter than an adaptive threshold max(3*LTOWER_RADIUS, perimeter/n/3), only for
// faces with >4 vertices, skipping the outer boundary and tiny (<=4-vertex) neighbours. The
// reference uses a DCEL collapseEdge; here we merge the two shared vertices (vertices are shared
// Point instances, so the merge stays watertight across cells).
function vertexMap(cells) {
	const m = new Map();
	for (const cell of cells)
		for (const v of cell) {
			let arr = m.get(v);
			if (!arr) m.set(v, (arr = []));
			if (!arr.includes(cell)) arr.push(cell);
		}
	return m;
}

function dedupConsecutive(cell) {
	for (let i = cell.length - 1; i >= 0 && cell.length > 3; i--) if (cell[i] === cell[(i + 1) % cell.length]) cell.splice(i, 1);
}

function optimizeJunctions(cells) {
	const vmap = vertexMap(cells);

	let pass = 0;
	let changed = true;
	while (changed && pass++ < 40) {
		changed = false;
		for (const cell of cells) {
			if (cell.length <= 4) continue;
			const k = Math.max(3 * LTOWER_RADIUS, cell.perimeter / cell.length / 3);
			for (let i = 0; i < cell.length; i++) {
				const v0 = cell[i];
				const v1 = cell[(i + 1) % cell.length];
				if (v0 === v1 || Point.distance(v0, v1) >= k) continue;

				const nbrs = (vmap.get(v0) || []).filter((c) => c !== cell && c.includes(v1));
				if (nbrs.length === 0) continue; // boundary edge — keep the disk edge crisp
				if (nbrs.some((c) => c.length <= 4)) continue; // don't collapse into a tiny neighbour

				collapse(vmap, v0, v1);
				changed = true;
				break; // one collapse per face per pass (reference scans the rest of the faces)
			}
		}
	}

	for (const cell of cells) dedupConsecutive(cell);
	return cells;
}

// merge v1 into v0 (v0 moves to the midpoint); every cell referencing v1 now references v0
function collapse(vmap, v0, v1) {
	v0.x = (v0.x + v1.x) / 2;
	v0.y = (v0.y + v1.y) / 2;
	const affected = vmap.get(v1) || [];
	for (const cell of affected) {
		for (let i = 0; i < cell.length; i++) if (cell[i] === v1) cell[i] = v0;
		let arr = vmap.get(v0);
		if (!arr) vmap.set(v0, (arr = []));
		if (!arr.includes(cell)) arr.push(cell);
		dedupConsecutive(cell);
	}
	vmap.delete(v1);
}

// ---- available build-area computation (step 1: inset each ward by edge type) ----

const WALL_THICKNESS = 1.9; // pc.THICKNESS in reference
const DEFAULT_BLOCK_INSET = 0.6;
// WIDE_MAIN_ROADS_50_FLAG: set false to restore the previous 2.0-wide main roads.
const WIDE_MAIN_ROADS_50_FLAG = true;
const BASE_MAIN_ROAD_WIDTH = 2.0;
const MAIN_ROAD_WIDTH = BASE_MAIN_ROAD_WIDTH * (WIDE_MAIN_ROADS_50_FLAG ? 1.5 : 1.0);
const ROAD_BLOCK_INSET = MAIN_ROAD_WIDTH / 2;
const SHORE_PATH_INSET = BASE_MAIN_ROAD_WIDTH;
const WARD_GEOMETRY_WIDTHS = { main: MAIN_ROAD_WIDTH, regular: 1.0, alley: 0.8 };
const BASE_BRIDGE_FILL_WIDTH = 1.6;
const ROAD_CONNECTED_BRIDGE_WIDTH = BASE_BRIDGE_FILL_WIDTH * (WIDE_MAIN_ROADS_50_FLAG ? 1.5 : 1.0);
const RIVER_CLEARANCE_EPS = 0.25;
const PASSAGE_MARGIN = 1.2;
const PLAZA_RIVER_TREE_MARGIN = 1.0;
const WALL_TOWER_RADIUS = 1.8;
const WALL_TOWER_NODE_TOLERANCE = WARD_GEOMETRY_WIDTHS.alley;
const WALL_PASSAGE_CLEARANCE = WALL_THICKNESS + PASSAGE_MARGIN + WARD_GEOMETRY_WIDTHS.alley * 2;
const TOWER_CLEARANCE = WALL_TOWER_RADIUS + WALL_TOWER_NODE_TOLERANCE;

function addEdgeRef(map, a, b) {
	let s = map.get(a);
	if (!s) map.set(a, (s = new Set()));
	s.add(b);
}

function hasEdgeRef(map, a, b) {
	const s = map.get(a);
	return !!(s && s.has(b));
}

function buildShoreEdges(cells) {
	const waterEdges = new Map();
	for (const cell of cells) {
		if (!cell.water) continue;
		cell.forEdge((v0, v1) => addEdgeRef(waterEdges, v0, v1));
	}

	const shoreEdges = new Map();
	for (const cell of cells) {
		if (cell.water) continue;
		cell.forEdge((v0, v1) => {
			if (hasEdgeRef(waterEdges, v1, v0)) {
				addEdgeRef(shoreEdges, v0, v1);
				addEdgeRef(shoreEdges, v1, v0);
			}
		});
	}
	return shoreEdges;
}

function isActiveWallEdge(ctx, v0, v1) {
	if (!ctx.wallShape) return false;
	for (let i = 0; i < ctx.wallShape.length; i++) {
		const a = ctx.wallShape[i];
		const b = ctx.wallShape[(i + 1) % ctx.wallShape.length];
		if ((a === v0 && b === v1) || (a === v1 && b === v0)) return ctx.wallSegments == null || ctx.wallSegments[i] !== false;
	}
	return false;
}

function isActiveWallTowerVertex(ctx, v) {
	if (!ctx.wallShape) return false;
	const i = ctx.wallShape.indexOf(v);
	if (i === -1) return false;
	if (ctx.wallGates && ctx.wallGates.includes(v)) return false;
	if (ctx.wallTowers && ctx.wallTowers.includes(v)) return true;
	const prev = !ctx.wallSegments || ctx.wallSegments[(i + ctx.wallShape.length - 1) % ctx.wallShape.length] !== false;
	const next = !ctx.wallSegments || ctx.wallSegments[i] !== false;
	return prev || next;
}

function isActiveWallNode(ctx, v) {
	return isActiveWallTowerVertex(ctx, v);
}

function isSingleWallNodeCorner(ctx, sourceShape, v) {
	if (!isActiveWallNode(ctx, v)) return false;
	const idx = sourceShape.indexOf(v);
	if (idx === -1) return false;
	const prev = sourceShape[(idx + sourceShape.length - 1) % sourceShape.length];
	const next = sourceShape[(idx + 1) % sourceShape.length];
	return !isActiveWallEdge(ctx, prev, v) && !isActiveWallEdge(ctx, v, next);
}

function nearestSourceVertex(sourceShape, point, maxDistance = 1e-6) {
	let best = null;
	let bestDistance = maxDistance;
	for (const v of sourceShape) {
		const d = Point.distance(v, point);
		if (d <= bestDistance) {
			best = v;
			bestDistance = d;
		}
	}
	return best;
}

function nearestBuildableNodeInTower(poly, tower, radius) {
	if (!poly || !tower || !(radius > 0)) return null;
	let best = null;
	let bestDistance = radius;
	for (const v of poly) {
		const d = Point.distance(v, tower);
		if (d <= bestDistance) {
			best = v;
			bestDistance = d;
		}
	}
	return best;
}

function clippedTowerIntrusion(poly, tower, clearance, fallbackDir = null) {
	if (!poly || poly.length < 3 || !tower || !(clearance > 0)) return poly;
	const intruding = nearestBuildableNodeInTower(poly, tower, clearance);
	if (!intruding) return poly;

	let dir = intruding.subtract(tower);
	if (dir.length <= 1e-6 && fallbackDir) dir = fallbackDir.subtract(tower);
	if (dir.length <= 1e-6) dir = poly.centroid.subtract(tower);
	if (dir.length <= 1e-6) return poly;
	dir.normalize(1);

	const tangent = new Point(-dir.y, dir.x);
	const cutCenter = tower.add(dir.scale(clearance));
	const capped = clipToOffsetSide(poly, cutCenter.subtract(tangent), cutCenter.add(tangent), -1, 0);
	if (capped && capped.length >= 3 && Math.abs(capped.square) >= Math.abs(poly.square) * 0.01)
		return capped;
	return poly;
}

function clippedCorner(poly, sourceShape, corner, clearance, useRadialCap = true) {
	if (!poly || poly.length < 3 || !(clearance > 0)) return poly;

	const idx = sourceShape.indexOf(corner);
	if (idx === -1) return poly;
	const dir = sourceShape.centroid.subtract(corner);
	if (useRadialCap && dir.length > 1e-6) {
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

function clipObstacleCorners(poly, sourceShape, ctx) {
	if (!poly || poly.length < 3 || !ctx) return poly;
	let clipped = poly;

	// --- Wall tower corner chamfer ---
	// Edge clipping pushes buildable area away from straight wall segments. Only
	// add the tower-cap chamfer if the resulting buildable polygon still has a
	// node inside the rendered tower radius plus one alley-width tolerance.
	if (ctx.wallTowers) {
		const towerNodeRadius = WALL_TOWER_RADIUS + WALL_TOWER_NODE_TOLERANCE;
		for (const tower of ctx.wallTowers) {
			const corner = nearestSourceVertex(sourceShape, tower);
			if (!corner || !isActiveWallTowerVertex(ctx, corner)) continue;
			const next = clippedTowerIntrusion(clipped, tower, towerNodeRadius, corner);
			if (next === clipped) continue;
			if (next && next.length >= 3) {
				clipped = next;
			} else {
				return null;
			}
		}
	}

	// --- Single wall-node corner chamfer ---
	// Some outer wards touch the city wall at exactly one corner instead of
	// sharing a whole wall edge. Give that point the same runner passage as a
	// wall segment so the buildable tip does not pinch off the wall-side alley.
	for (const corner of sourceShape) {
		if (!isSingleWallNodeCorner(ctx, sourceShape, corner)) continue;
		const next = clippedCorner(clipped, sourceShape, corner, WALL_PASSAGE_CLEARANCE);
		if (next && next.length >= 3) clipped = next;
	}

	// --- River-mouth corner chamfer ---
	// Where the river enters the water: a ward corner that is both a river node and
	// touches a water ward (shore vertex). The sharp buildable-area tip there pokes
	// into the river/water junction; clip it by half the river width.
	if (ctx.riverData && ctx.riverData.course && ctx.shoreEdges && ctx.riverWidth > 0) {
		const riverSet = new Set(ctx.riverData.course);
		let riverCorner = null;
		let riverCount = 0;
		for (const v of sourceShape) {
			if (riverSet.has(v) && ctx.shoreEdges.has(v)) {
				riverCorner = v;
				riverCount++;
			}
		}
		if (riverCount === 1) {
			const riverClipped = clippedCorner(clipped, sourceShape, riverCorner, ctx.riverWidth / 2);
			if (riverClipped && riverClipped.length >= 3) clipped = riverClipped;
		}
	}

	return clipped;
}

function lineSignedDistance(a, b, p) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (!(len > 1e-6)) return 0;
	return ((dx * (p.y - a.y)) - (dy * (p.x - a.x))) / len;
}

function sideForCell(cell, a, b) {
	let side = lineSignedDistance(a, b, cell.centroid);
	if (Math.abs(side) < 1e-6) {
		for (const v of cell) {
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

function cutAwayFromSegment(poly, cell, a, b, clearance) {
	const clipped = clipToOffsetSide(poly, a, b, sideForCell(cell, a, b), clearance);
	if (!clipped || clipped.length < 3) return poly;
	if (Math.abs(clipped.square) < Math.abs(poly.square) * 0.01) return poly;
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

function segmentsIntersect(a, b, c, d) {
	const abx = b.x - a.x, aby = b.y - a.y;
	const cdx = d.x - c.x, cdy = d.y - c.y;
	const acx = c.x - a.x, acy = c.y - a.y;
	const denom = abx * cdy - aby * cdx;
	if (Math.abs(denom) < 1e-9) return false;
	const t = (acx * cdy - acy * cdx) / denom;
	const u = (acx * aby - acy * abx) / denom;
	return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9;
}

function segmentSegmentDistance(a, b, c, d) {
	if (segmentsIntersect(a, b, c, d)) return 0;
	return Math.min(
		pointSegmentDistance(a, c, d),
		pointSegmentDistance(b, c, d),
		pointSegmentDistance(c, a, b),
		pointSegmentDistance(d, a, b)
	);
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

function pointOnSegment(a, b, t) {
	return new Point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}

function polygonFitsInside(poly, candidate, step = 0.7, clearance = 0) {
	if (!poly || !candidate || candidate.length < 3) return false;
	const pointFits = (p) => pointInPolygon(p, poly) && (!(clearance > 0) || pointPolygonDistance(p, poly) >= clearance);
	for (const p of candidate) if (!pointFits(p)) return false;
	for (let i = 0; i < candidate.length; i++) {
		const a = candidate[i];
		const b = candidate[(i + 1) % candidate.length];
		const len = Point.distance(a, b);
		const samples = Math.max(1, Math.ceil(len / step));
		for (let j = 1; j < samples; j++) {
			if (!pointFits(pointOnSegment(a, b, j / samples))) return false;
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

function projectionExtents(poly, center, dir) {
	let min = Infinity;
	let max = -Infinity;
	for (const p of poly) {
		const t = (p.x - center.x) * dir.x + (p.y - center.y) * dir.y;
		if (t < min) min = t;
		if (t > max) max = t;
	}
	return { min, max };
}

function longestEdgeAxis(poly) {
	let best = null;
	let bestLen = -Infinity;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		if (len > bestLen) {
			bestLen = len;
			best = len > 1e-6 ? new Point(dx / len, dy / len) : null;
		}
	}
	return best;
}

function chaikinSmooth(pts, iterations) {
	if (!pts || pts.length < 3) return pts || [];
	let a = pts;
	for (let it = 0; it < iterations; it++) {
		const h = [a[0]];
		for (let i = 1, n = a.length - 1; i < n; i++) {
			const g = a[i], p = a[i - 1], nx = a[i + 1];
			h.push(new Point(g.x * 0.75 + p.x * 0.25, g.y * 0.75 + p.y * 0.25));
			h.push(new Point(g.x * 0.75 + nx.x * 0.25, g.y * 0.75 + nx.y * 0.25));
		}
		h.push(a[a.length - 1]);
		a = h;
	}
	return a;
}

function sampledRiverCourse(river) {
	if (!river || !river.course || river.course.length < 2) return [];
	const course = river.delta
		? [new Point((river.course[0].x + river.course[1].x) / 2, (river.course[0].y + river.course[1].y) / 2), ...river.course.slice(1)]
		: river.course;
	return chaikinSmooth(course, 3);
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

function renderedDeltaMouth(river, path) {
	if (!river || !river.delta || !path || path.length < 2) return null;
	const delta = river.delta;
	const p0 = path[0];
	const p1 = path[1];
	const dx = p1.x - p0.x;
	const dy = p1.y - p0.y;
	const len = Math.hypot(dx, dy) || 1;
	const tx = dx / len;
	const ty = dy / len;
	const hw = (river.width || 0) / 2;
	const a = new Point(p0.x - ty * hw, p0.y + tx * hw);
	const b = new Point(p0.x + ty * hw, p0.y - tx * hw);
	const right = Point.distance(a, delta.right) <= Point.distance(b, delta.right) ? a : b;
	const left = right === a ? b : a;
	const ctrlLen = Math.max(Point.distance(delta.right, delta.rightCtrl1), len * 0.5);
	return {
		...delta,
		right,
		rightCtrl1: new Point(right.x - tx * ctrlLen, right.y - ty * ctrlLen),
		leftCtrl2: new Point(left.x - tx * ctrlLen, left.y - ty * ctrlLen),
		left,
	};
}

function sampledDeltaMouthPolygon(river, samples = 18) {
	const path = sampledRiverCourse(river);
	const dl = renderedDeltaMouth(river, path);
	if (!dl) return null;
	const pts = [];
	const rightCtrl2 = new Point(dl.rightCtrl2.x, dl.rightCtrl2.y);
	const prevShore = new Point(dl.prevShore.x, dl.prevShore.y);
	for (let i = 0; i <= samples; i++)
		pts.push(cubicPoint(dl.right, dl.rightCtrl1, rightCtrl2, prevShore, i / samples));
	if (dl.isConvex) pts.push(new Point(dl.mouth.x, dl.mouth.y));
	const nextShore = new Point(dl.nextShore.x, dl.nextShore.y);
	pts.push(nextShore);
	const leftCtrl1 = new Point(dl.leftCtrl1.x, dl.leftCtrl1.y);
	for (let i = 1; i <= samples; i++)
		pts.push(cubicPoint(nextShore, leftCtrl1, dl.leftCtrl2, dl.left, i / samples));
	return new Polygon(pts);
}

function pathTouchesCell(path, cell, clearance) {
	for (const p of path)
		if (pointInPolygon(p, cell) || pointPolygonDistance(p, cell) <= clearance)
			return true;
	return false;
}

function minDistanceToPolyline(poly, path) {
	if (!poly || poly.length < 3 || !path || path.length < 2) return Infinity;
	let best = Infinity;
	for (const v of poly)
		for (let i = 0; i < path.length - 1; i++)
			best = Math.min(best, pointSegmentDistance(v, path[i], path[i + 1]));
	return best;
}

function nearestPolylineSegmentToPolygon(poly, path) {
	const best = { distance: Infinity, segment: -1, pathInside: false };
	if (!poly || poly.length < 3 || !path || path.length < 2) return best;

	for (let i = 0; i < path.length - 1; i++) {
		const a = path[i];
		const b = path[i + 1];
		const segmentInside = pointInPolygon(a, poly) || pointInPolygon(b, poly);
		if (segmentInside) {
			const d = Math.min(pointPolygonDistance(a, poly), pointPolygonDistance(b, poly));
			if (!best.pathInside || d < best.distance) {
				best.distance = d;
				best.segment = i;
				best.pathInside = true;
			}
		}
		poly.forEdge((v0, v1) => {
			const d = segmentSegmentDistance(v0, v1, a, b);
			if (!best.pathInside && d < best.distance) {
				best.distance = d;
				best.segment = i;
			}
		});
	}
	return best;
}

function nearestObstacleEdgeToPolygon(poly, obstacle) {
	const best = { distance: Infinity, edge: -1, intersects: false };
	if (!poly || poly.length < 3 || !obstacle || obstacle.length < 3) return best;

	for (const p of poly) {
		if (!pointInPolygon(p, obstacle)) continue;
		for (let i = 0; i < obstacle.length; i++) {
			const d = pointSegmentDistance(p, obstacle[i], obstacle[(i + 1) % obstacle.length]);
			if (d < best.distance) {
				best.distance = d;
				best.edge = i;
				best.intersects = true;
			}
		}
	}

	for (let i = 0; i < obstacle.length; i++) {
		const a = obstacle[i];
		const b = obstacle[(i + 1) % obstacle.length];
		if (pointInPolygon(a, poly)) {
			best.distance = 0;
			best.edge = i;
			best.intersects = true;
			return best;
		}
		poly.forEdge((v0, v1) => {
			const d = segmentSegmentDistance(v0, v1, a, b);
			if (d < best.distance) {
				best.distance = d;
				best.edge = i;
				best.intersects = best.intersects || d <= 1e-6;
			}
		});
	}
	return best;
}

function pointDistanceToPolyline(point, path) {
	if (!point || !path || path.length < 2) return Infinity;
	let best = Infinity;
	for (let i = 0; i < path.length - 1; i++)
		best = Math.min(best, pointSegmentDistance(point, path[i], path[i + 1]));
	return best;
}

function cellHasActiveWallEdge(cell, ctx) {
	if (!ctx || !ctx.wallShape) return false;
	let hasWall = false;
	cell.forEdge((v0, v1) => {
		if (isActiveWallEdge(ctx, v0, v1)) hasWall = true;
	});
	return hasWall;
}

function clipRiverObstacle(poly, cell, river, detectionExtra = 0) {
	const path = sampledRiverCourse(river);
	if (path.length < 2) return poly;
	const clearance = river.width / 2 + SHORE_PATH_INSET + RIVER_CLEARANCE_EPS;
	const detectionClearance = clearance + detectionExtra;
	const cellNear = nearestPolylineSegmentToPolygon(cell, path);
	const polyNear = nearestPolylineSegmentToPolygon(poly, path);
	if (
		!pathTouchesCell(path, cell, detectionClearance) &&
		!pathTouchesCell(path, poly, detectionClearance) &&
		!cellNear.pathInside &&
		!polyNear.pathInside &&
		cellNear.distance > detectionClearance &&
		polyNear.distance > detectionClearance
	)
		return poly;

	let clipped = poly;
	for (let pass = 0; pass < 24; pass++) {
		const nearest = nearestPolylineSegmentToPolygon(clipped, path);
		if ((!nearest.pathInside && nearest.distance >= clearance - 1e-6) || nearest.segment < 0) return clipped;
		const before = Math.abs(clipped.square);
		const next = cutAwayFromSegment(clipped, cell, path[nearest.segment], path[nearest.segment + 1], clearance);
		if (!next || next.length < 3) return null;
		if (Math.abs(before - Math.abs(next.square)) < 1e-6) break;
		clipped = next;
	}

	// If a tiny remnant still lies under the river/shore corridor itself, drop that remnant
	// rather than drawing a grey shard below the water stroke or its bank.
	const nearest = nearestPolylineSegmentToPolygon(clipped, path);
	return nearest.pathInside || nearest.distance < clearance - 0.05 ? null : clipped;
}

function clipRiverMouthObstacle(poly, cell, river) {
	if (!river || !river.delta || !poly || poly.length < 3) return poly;
	const mouth = sampledDeltaMouthPolygon(river);
	if (!mouth || mouth.length < 3) return poly;
	const clearance = SHORE_PATH_INSET + RIVER_CLEARANCE_EPS;
	let clipped = poly;

	for (let pass = 0; pass < 14; pass++) {
		const nearest = nearestObstacleEdgeToPolygon(clipped, mouth);
		if (!nearest.intersects && nearest.distance >= clearance - 1e-6) return clipped;
		if (nearest.edge < 0) return clipped;
		const before = Math.abs(clipped.square);
		const a = mouth[nearest.edge];
		const b = mouth[(nearest.edge + 1) % mouth.length];
		const next = cutAwayFromSegment(clipped, cell, a, b, clearance);
		if (!next || next.length < 3) return null;
		if (Math.abs(before - Math.abs(next.square)) < 1e-6) break;
		clipped = next;
	}

	const nearest = nearestObstacleEdgeToPolygon(clipped, mouth);
	return nearest.intersects || nearest.distance < clearance - 0.05 ? null : clipped;
}

function cleanupBuildablePolygon(poly) {
	if (!poly || poly.length < 3) return null;
	const cleaned = new Polygon(poly);
	const minArea = 2;
	for (let pass = 0; pass < 8 && cleaned.length > 3; pass++) {
		let removed = false;
		for (let i = 0; i < cleaned.length; i++) {
			const a = cleaned[(i + cleaned.length - 1) % cleaned.length];
			const b = cleaned[i];
			const c = cleaned[(i + 1) % cleaned.length];
			const prevLen = Point.distance(a, b);
			const nextLen = Point.distance(b, c);
			const base = Point.distance(a, c);
			const height = base > 1e-6 ? Math.abs((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / base : 0;
			const ux = a.x - b.x, uy = a.y - b.y;
			const vx = c.x - b.x, vy = c.y - b.y;
			const ul = Math.hypot(ux, uy), vl = Math.hypot(vx, vy);
			const cos = ul > 1e-6 && vl > 1e-6 ? (ux * vx + uy * vy) / (ul * vl) : -1;
			if (Math.min(prevLen, nextLen) < 1.2 || height < 1.0 || (cos > Math.cos(Math.PI / 3) && height < 2.0)) {
				cleaned.splice(i, 1);
				removed = true;
				break;
			}
		}
		if (!removed) break;
	}
	return cleaned.length >= 3 && Math.abs(cleaned.square) >= minArea ? cleaned : null;
}

function computeAvailableArea(cell, ctx) {
	const edgeInsets = [];
	cell.forEdge((v0, v1) => {
		let inset = DEFAULT_BLOCK_INSET;
		if (hasEdgeRef(ctx.riverEdges, v0, v1) || hasEdgeRef(ctx.riverEdges, v1, v0))
			inset = Math.max(inset, ctx.riverWidth / 2 + SHORE_PATH_INSET + RIVER_CLEARANCE_EPS);
		if (hasEdgeRef(ctx.shoreEdges, v0, v1) || hasEdgeRef(ctx.shoreEdges, v1, v0))
			inset = Math.max(inset, SHORE_PATH_INSET);
		if (isActiveWallEdge(ctx, v0, v1)) inset = Math.max(inset, WALL_PASSAGE_CLEARANCE);
		for (const road of ctx.roads) {
			if (road.includes(v0) && road.includes(v1)) {
				inset = Math.max(inset, ROAD_BLOCK_INSET);
				break;
			}
		}
		if (ctx.plazaCell && ctx.plazaCell.findEdge(v1, v0) !== -1) inset = Math.max(inset, ROAD_BLOCK_INSET);
		edgeInsets.push(inset);
	});
	try {
		const base = cell.isConvex() ? cell.shrink(edgeInsets) : cell.buffer(edgeInsets);
		const riverDetectionExtra = cellHasActiveWallEdge(cell, ctx) ? WALL_THICKNESS : 0;
		const riverClipped = clipRiverObstacle(base, cell, ctx.riverData, riverDetectionExtra);
		if (!riverClipped || riverClipped.length < 3) return null;
		const mouthClipped = clipRiverMouthObstacle(riverClipped, cell, ctx.riverData);
		if (!mouthClipped || mouthClipped.length < 3) return null;
		const cleaned = cleanupBuildablePolygon(clipObstacleCorners(mouthClipped, cell, ctx));
		if (!cleaned || cleaned.length < 3) return null;
		const cleanedRiverClipped = clipRiverObstacle(cleaned, cell, ctx.riverData, riverDetectionExtra);
		if (!cleanedRiverClipped || cleanedRiverClipped.length < 3) return null;
		return clipRiverMouthObstacle(cleanedRiverClipped, cell, ctx.riverData);
	} catch (e) { return null; }
}

function annotateRoadConnectedBridges(riverData, streetData) {
	if (!riverData || !riverData.bridges || !streetData) return;
	const paths = [
		...(streetData.streets || []),
		...(streetData.roads || []),
		...(streetData.arteries || []),
	];
	for (const bridge of riverData.bridges) {
		const point = bridge.point || bridge;
		const roadConnected = paths.some((path) => path && path.includes(point));
		// WIDE_MAIN_ROADS_50_FLAG: only bridges touched by generated road paths get the 50% deck bump.
		bridge.roadConnected = roadConnected;
		if (roadConnected) bridge.width = ROAD_CONNECTED_BRIDGE_WIDTH;
	}
}

function randomItems(items, count) {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Random.int(0, i + 1);
		const t = out[i];
		out[i] = out[j];
		out[j] = t;
	}
	return out.slice(0, Math.min(count, out.length));
}

function clipPlazaFromRiver(poly, cell, river) {
	const path = sampledRiverCourse(river);
	if (!poly || poly.length < 3 || path.length < 2) return poly;

	const clearance = (river.width || 0) / 2 + PLAZA_RIVER_TREE_MARGIN;
	if (!pathTouchesCell(path, cell, clearance) && !pathTouchesCell(path, poly, clearance)) return poly;

	let clipped = poly;
	for (let pass = 0; pass < 12; pass++) {
		const nearest = nearestPolylineSegmentToPolygon(clipped, path);
		if (!nearest.pathInside && nearest.distance >= clearance - 1e-6) return clipped;
		if (nearest.segment < 0) return clipped;
		const before = Math.abs(clipped.square);
		const next = cutAwayFromSegment(clipped, cell, path[nearest.segment], path[nearest.segment + 1], clearance);
		if (!next || next.length < 3) return null;
		if (Math.abs(before - Math.abs(next.square)) < 1e-6) break;
		clipped = next;
	}

	const nearest = nearestPolylineSegmentToPolygon(clipped, path);
	return nearest.pathInside || nearest.distance < clearance * 0.9 ? null : clipped;
}

// Reduce the plaza's buildable area by respecting the river: clip the plaza
// polygon away from the river course by half the river width plus a margin, so
// trees and the plaza building can be placed on the remainder without going
// into the water. Returns null when nothing buildable remains.
function reducePlazaForRiver(plaza, river) {
	if (!plaza || !plaza.shape || plaza.shape.length < 3) return null;
	const reduced = clipPlazaFromRiver(plaza.shape, plaza.shape, river);
	if (!reduced || reduced.length < 3) return null;
	return reduced;
}

function addPlazaTreeRings(plaza, riverData) {
	if (!plaza || !plaza.shape || plaza.shape.length < 3) return;
	const saved = Random.getSeed();
	const area = Math.abs(plaza.shape.square);
	const scale = Math.sqrt(area);
	// First reduce the plaza's buildable area by the river clearance (half river
	// width + margin), then shrink that reduced area for the tree ring frame.
	const reduced = reducePlazaForRiver(plaza, riverData);
	if (!reduced) {
		Random.reset(saved);
		return;
	}
	const inset = Math.max(1.4, Math.min(3.0, scale * 0.08));
	const frame = reduced.shrinkRobust(inset) || reduced.shrinkEq(inset);
	const riverPath = sampledRiverCourse(riverData);
	const riverClearance = riverPath.length >= 2 ? (riverData.width || 0) / 2 + PLAZA_RIVER_TREE_MARGIN : 0;
	if (!frame || frame.length < 3 || Math.abs(frame.square) < area * 0.25) {
		Random.reset(saved);
		return;
	}

	const edges = [];
	for (let i = 0; i < frame.length; i++) {
		const a = frame[i];
		const b = frame[(i + 1) % frame.length];
		const length = Point.distance(a, b);
		if (length >= 3.0) edges.push(i);
	}
	if (edges.length === 0) {
		Random.reset(saved);
		return;
	}

	const picked = randomItems(edges, 3);
	const spacing = Math.max(2.6, Math.min(3.8, scale * (0.17 + Random.float() * 0.03)));
	for (const i of picked) {
		const a = frame[i];
		const b = frame[(i + 1) % frame.length];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = Math.hypot(dx, dy);
		if (!(length > 1e-6)) continue;
		const margin = Math.min(spacing * 0.55, length * 0.32);
		const usable = Math.max(0, length - margin * 2);
		const count = Math.max(1, Math.floor(usable / spacing) + 1);
		for (let k = 0; k < count; k++) {
			const t = count === 1 ? 0.5 : (margin + (usable * k) / (count - 1)) / length;
			const point = new Point(a.x + dx * t, a.y + dy * t);
			if (riverClearance > 0 && pointDistanceToPolyline(point, riverPath) < riverClearance) continue;
			recordFeature(point.x, point.y, 'tree');
		}
	}
	Random.reset(saved);
}

function createPlazaBuilding(plaza, riverData) {
	if (!plaza || !plaza.shape || plaza.shape.length < 3) return null;
	const area = Math.abs(plaza.shape.square);
	if (!(area > 0)) return null;

	const axis = longestEdgeAxis(plaza.shape);
	if (!axis) return null;

	// Reduce the plaza's buildable area by the river clearance (half river width
	// + margin) before sizing the building, so it never sits in the water.
	const reduced = reducePlazaForRiver(plaza, riverData);
	if (!reduced || reduced.length < 3 || Math.abs(reduced.square) < area * 0.08) return null;

	const scale = Math.sqrt(area);
	const inset = Math.max(2.0, Math.min(4.0, scale * 0.13));
	const usable = reduced.shrinkRobust(inset) || reduced.shrinkEq(inset);
	if (!usable || usable.length < 3 || Math.abs(usable.square) < area * 0.08) return null;

	const plazaCenter = plaza.shape.centroid;
	let center = plazaCenter;
	if (!pointInPolygon(center, usable)) center = usable.centroid;
	if (!pointInPolygon(center, usable)) center = usable.center;
	if (!pointInPolygon(center, usable)) return null;

	const perp = new Point(-axis.y, axis.x);
	const along = projectionExtents(usable, center, axis);
	const across = projectionExtents(usable, center, perp);
	const halfAlong = Math.min(along.max, -along.min);
	const halfAcross = Math.min(across.max, -across.min);
	if (!(halfAlong > 0.9 && halfAcross > 0.45)) return null;

	let halfLen = Math.min(halfAlong * 0.42, scale * 0.17);
	let halfWid = Math.min(halfAcross * 0.38, scale * 0.065, halfLen * 0.42);
	for (let attempt = 0; attempt < 6; attempt++) {
		if (halfLen < 0.9 || halfWid < 0.38) break;
		const footprint = orientedRect(center, axis, halfLen, halfWid);
		if (polygonFitsInside(usable, footprint, 0.45)) {
			footprint.class = 'plazaBuilding';
			return footprint;
		}
		halfLen *= 0.86;
		halfWid *= 0.86;
	}

	return null;
}

function buildBuildings(cells, inner, center, wallData, streetData, riverData, plazaEnabled) {
	if (!inner || inner.length === 0 || !center) return { blocks: [], buildings: [], alleys: [], hedges: [], wardTypes: new Map() };

	// River edges map (shared Point identity)
	const riverEdges = new Map();
	if (riverData && riverData.course) {
		for (let i = 0; i < riverData.course.length - 1; i++) {
			const a = riverData.course[i], b = riverData.course[i + 1];
			addEdgeRef(riverEdges, a, b);
			addEdgeRef(riverEdges, b, a);
		}
	}
	const shoreEdges = buildShoreEdges(cells);

	const plazaCell = plazaEnabled && inner.length > 0 ? inner[0] : null;
	const arteries = (streetData && streetData.arteries) || [];

	// Lightweight model adapter for cathedralRate / marketRate
	const patchMap = new Map();
	const patches = [];
	for (const cell of cells) {
		const p = { shape: cell, type: null, withinCity: !!cell.withinCity, isWater: !!cell.water };
		patches.push(p);
		patchMap.set(cell, p);
	}
	const innerPatches = inner.map((c) => patchMap.get(c));
	const model = {
		center, inner: innerPatches, patches,
		plaza: plazaCell ? patchMap.get(plazaCell) : null,
		wall: wallData,
		water: riverData ? { riverPath: riverData.course } : null,
		riverWidth: riverData ? riverData.width : 0,
		arteries,
		gates: wallData ? wallData.gates : [],
		cityRadius: 1,
		patchByVertex: (v) => patches.filter((p) => p.shape.contains(v)),
		getNeighbours: (patch) => patches.filter((p) => p !== patch && p.shape.borders(patch.shape)),
	};
	model.getNeighbour = (patch, v) => {
		const next = patch.shape.next(v);
		return patches.find((p) => p !== patch && p.shape.findEdge(next, v) !== -1) || null;
	};
	model.isEnclosed = (patch) => patch.withinCity && model.getNeighbours(patch).every((p) => p.withinCity);

	// --- assign ward types ---
	if (model.plaza) model.plaza.type = 'plaza';
	const unassigned = innerPatches.filter((p) => p !== model.plaza);

	if (unassigned.length > 0) {
		const pick = amin(unassigned, (p) => cathedralRate(model, p));
		pick.type = 'cathedral';
		remove(unassigned, pick);
	}
	// The old "market squares" are now parks: open green wards filled with green patches and
	// split by bezier-spline walkways (see createParkGeometry / the geometry loop below).
	let squares = 2;
	while (squares-- > 0 && unassigned.length > 0) {
		const pick = amin(unassigned, (p) => marketRate(model, p));
		pick.type = 'park';
		remove(unassigned, pick);
	}
	if (wallData) {
		for (const gate of wallData.gates)
			for (const p of patches)
				if (p.withinCity && p.type == null && p.shape.contains(gate)) p.type = 'gate';
	}
	for (const p of unassigned) if (p.type == null) p.type = 'generic';
	for (const p of patches) {
		if (!p.withinCity && !p.isWater && p.type == null)
			p.type = p.shape.centroid.y < center.y ? 'outerGarden' : 'outerHighrise';
		if (p.type == null) p.type = 'generic';
	}
	for (const p of innerPatches)
		for (const v of p.shape)
			model.cityRadius = Math.max(model.cityRadius, Point.distance(v, center));

	addPlazaTreeRings(model.plaza, riverData);

	// --- compute available build areas (one inset polygon per ward) ---
	// Use pre-smoothed streets/roads for edge matching (shared Point identity);
	// smoothed arteries have new Point objects that won't match cell vertices.
	const rawRoads = [];
	if (streetData) {
		if (streetData.streets) rawRoads.push(...streetData.streets);
		if (streetData.roads) rawRoads.push(...streetData.roads);
	}

	const ctx = {
		riverEdges, riverWidth: riverData ? riverData.width : 0,
		riverData,
		shoreEdges,
		roads: rawRoads, plazaCell,
		wallShape: wallData ? wallData.shape : null,
		wallSegments: wallData ? wallData.segments : null,
		wallGates: wallData ? wallData.gates : null,
		wallTowers: wallData ? wallData.towers : null,
	};

	const blocks = [];
	const buildings = [];
	const alleys = [];
	const hedges = [];
	const cathedralHedges = [];
	for (const p of patches) {
		if (p.type === 'plaza' && p.withinCity) {
			const plazaBuilding = createPlazaBuilding(p, riverData);
			if (plazaBuilding) buildings.push(plazaBuilding);
		}
		if (OPEN_TYPES.has(p.type) || p.isWater) continue;
		const avail = computeAvailableArea(p.shape, ctx);
		if (avail && avail.length >= 3) {
			p.block = avail;
			blocks.push(avail);
			if ((p.type === 'generic' || p.type === 'gate') && p.withinCity) {
				for (const b of createCommonWardGeometry(model, p, WARD_GEOMETRY_WIDTHS)) buildings.push(b);
				if (p.alleys) alleys.push(...p.alleys);
			} else if (p.type === 'cathedral' && p.withinCity) {
				for (const b of createCathedralGeometry(model, p, WARD_GEOMETRY_WIDTHS)) buildings.push(b);
				if (p.alleys) alleys.push(...p.alleys);
				if (p.cathedralHedges) cathedralHedges.push(...p.cathedralHedges);
			} else if (p.type === 'park' && p.withinCity) {
				for (const b of createParkGeometry(model, p, WARD_GEOMETRY_WIDTHS)) buildings.push(b);
				if (p.hedges) hedges.push(...p.hedges);
			} else if (p.type === 'outerGarden' && !p.withinCity) {
				for (const b of createOuterGardenGeometry(model, p, WARD_GEOMETRY_WIDTHS)) buildings.push(b);
				if (p.hedges) hedges.push(...p.hedges);
				if (p.cathedralHedges) cathedralHedges.push(...p.cathedralHedges);
			} else if (p.type === 'outerHighrise' && !p.withinCity) {
				for (const b of createOuterHighriseGeometry(model, p, WARD_GEOMETRY_WIDTHS)) buildings.push(b);
				if (p.alleys) alleys.push(...p.alleys);
				if (p.hedges) hedges.push(...p.hedges);
				if (p.cathedralHedges) cathedralHedges.push(...p.cathedralHedges);
			}
		}
	}

	const wardTypes = new Map();
	for (const p of patches) wardTypes.set(p.shape, p.type);

	return { blocks, buildings, alleys, hedges, cathedralHedges, wardTypes };
}

// ---- public entry ----
export function generateWards(params = {}) {
	let seed = params.seed;
	if (!(seed > 0)) seed = Math.trunc(Date.now() % 2147483647) || 1;
	const size = params.size != null ? params.size : 15;
	const plaza = params.plaza !== false;
	const coast = params.coast !== false;
	const river = params.river !== false;
	const walls = params.walls !== false;
	const streets = params.streets !== false;
	const gateCount = Number.isFinite(params.gates) && params.gates >= 0 ? Math.trunc(params.gates) : null;
	const roadDensity = Number.isFinite(params.roadDensity) ? Math.max(0, params.roadDensity) : 1;
	const outerRatio = Number.isFinite(params.outerRatio) ? Math.max(4, params.outerRatio) : 8;
	const coastDir = params.coastDir; // number in [0,2) (×π); undefined -> random

	Random.reset(seed);

	let result = null;
	for (let attempt = 0; attempt < 20 && result == null; attempt++) {
		try {
			const { cells, b } = buildPatches(size, plaza, outerRatio);
			// coast (mark water cells) BEFORE city selection, then optimise junctions — order as
			// in the reference (coast + inner selection end buildPatches, optimizeJunctions next).
			if (coast) markCoast(cells, b, coastDir);
			const inner = selectCity(cells, size);
			optimizeJunctions(cells);
			if (coast) smoothShore(cells); // reference smooths the waterEdge in buildDomains
			const center = inner.length ? amin(inner[0], (v) => v.length) : null;
			const wallData = walls && inner.length ? buildCityWall(cells, inner, { real: true, gates: gateCount }) : null;
			const roadOpts = {
				plazaCell: plaza ? inner[0] : null,
				roadsPerGate: roadDensity >= 2.4 ? 3 : roadDensity >= 1.4 ? 2 : 1,
				extraInner: Math.round(size * Math.max(0, roadDensity - 1) * 0.35),
			};
			const streetData = streets && wallData && center && roadDensity > 0 ? buildStreets(cells, inner, center, wallData, roadOpts) : { streets: [], roads: [], arteries: [] };
			const riverData = river && center ? buildRiver(cells, center, { innerCells: inner }) : null;
			if (wallData && riverData) suppressWallSegmentsOnRiver(wallData, riverData);
			if (wallData || riverData) addObstacleCrossings(cells, wallData, riverData);
			annotateRoadConnectedBridges(riverData, streetData);
			if (wallData && riverData) displaceWallTowers(wallData, riverData);
			const dockData = buildDocks(cells, inner, { river: riverData });
			if (inner.length >= Math.min(size, 4)) result = { cells, b, inner, center, river: riverData, wall: wallData, streets: streetData, docks: dockData };
		} catch (e) {
			result = null; // degenerate Voronoi / coast -> retry (RNG advanced, like the reference)
		}
	}
	if (result == null) throw new Error('ward generation failed');

	// Collect chamfer "features" (trees/fountains dropped where corner triangles are cut
	// off) only from the surviving generation, not from any discarded retries above.
	clearFeatures();
	const visibleCells = limitOuterWardsByEdgeDistance(result.cells, result.inner, TEMP_OUTER_WARD_EDGE_LIMIT);
	const { blocks, buildings, alleys, hedges, cathedralHedges, wardTypes } = buildBuildings(
		visibleCells, result.inner, result.center,
		result.wall, result.streets, result.river, plaza
	);
	const features = takeFeatures();

	const wards = visibleCells.map((cell) => ({
		polygon: cell.map((v) => ({ x: v.x, y: v.y })),
		inner: !!cell.withinCity,
		water: !!cell.water,
		landing: !!cell.landing,
		type: wardTypes.get(cell) || 'generic',
	}));

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const w of wards)
		for (const p of w.polygon) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}

	return {
		seed,
		size,
		plaza,
		walls,
		streets,
		gates: gateCount,
		roadDensity,
		outerRatio,
		b: result.b,
		bounds: { minX, minY, maxX, maxY },
		wards,
		center: result.center ? { x: result.center.x, y: result.center.y } : null,
		river: result.river
			? {
					...result.river,
					bridges: (result.river.bridges || []).map(serializeBridge),
				}
			: null,
		wall: result.wall
			? {
					shape: result.wall.shape.map((v) => ({ x: v.x, y: v.y })),
					gates: result.wall.gates.map((v) => ({ x: v.x, y: v.y })),
					crossingGates: (result.wall.crossingGates || []).map((v) => ({ x: v.x, y: v.y })),
					towers: result.wall.towers.map((v) => ({ x: v.x, y: v.y })),
					gateTowers: (result.wall.gateTowers || []).map((v) => ({ x: v.x, y: v.y })),
					segments: result.wall.segments.slice(),
				}
			: null,
		roads: result.streets
			? {
					streets: result.streets.streets.map((road) => road.map((v) => ({ x: v.x, y: v.y }))),
					roads: result.streets.roads.map((road) => road.map((v) => ({ x: v.x, y: v.y }))),
					arteries: result.streets.arteries.map((road) => road.map((v) => ({ x: v.x, y: v.y }))),
				}
			: { streets: [], roads: [], arteries: [] },
		docks: (result.docks || []).map(serializeDock),
		blocks: blocks.map((b) => Array.from(b, (v) => ({ x: v.x, y: v.y }))),
		buildings: buildings.map(serializeBuilding),
		alleys: alleys.map((a) => Array.from(a, (v) => ({ x: v.x, y: v.y }))),
		hedges: hedges.map((h) => h.map((v) => ({ x: v.x, y: v.y }))),
		cathedralHedges: cathedralHedges.map((h) => h.map((v) => ({ x: v.x, y: v.y }))),
		features,
	};
}
