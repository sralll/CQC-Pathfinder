// Obstacles.js — classifies the output of generateWards() into impassable shapes
// for routing. Pure data; no DOM. Outputs:
//   polygons: closed impassable rings (water wards, river strip, river delta,
//             buildings, gardens, wall-tower discs)
//   lines:    impassable polylines + intended thickness (city wall segments,
//             hedges) — kept as polylines because callers may want to (a) inflate
//             them by a runner clearance, or (b) thicken+inflate in one offset
//             pass when building the visibility graph.
//   portals:  passable crossings overlaid on otherwise-impassable shapes — used
//             later to punch openings into obstacle unions (bridges across the
//             river, light-grey gate towers in the city wall, dock landings).
//
// The river polyline is pre-smoothed here with the same Chaikin (3 iterations)
// the renderer uses, so the obstacle aligns with what the eye sees. That ~8×
// densifies the river vertex set, but the absolute count stays small (one
// river, ~10–15 raw points → ~100 after smoothing) and the visibility-graph
// builder can decimate further if needed.

import { dcos, dhypot, dsin } from './dmath.js';

const IMPASSABLE_BUILDING_CLASSES = new Set([
	'building',
	'cathedral',
	'plazaBuilding',
	'highrise',
	'outerHouse',
	'outerGarden',
]);

const PASSABLE_BUILDING_CLASSES = new Set([
	'park',
	'outerHighrisePark',
	'outerHighrisePath',
	'largestLotInset',
	'housingEntranceFill',
	'cathedralGround',
	'outerGardenOutline',
]);

export const WALL_THICKNESS = 1.9;
export const HEDGE_THICKNESS = 0.45;
export const CATHEDRAL_HEDGE_THICKNESS = 0.6;
// Dark-grey wall tower as rendered: map wall width 1.8 × scale 2 / 2 = 1.8m radius.
export const WALL_TOWER_RENDER_RADIUS = 1.8;
export const RIVER_SMOOTH_ITERATIONS = 3;
// Routing-only river simplification. The visible river still uses the full
// smoothed curve; this trims redundant centerline vertices before thickening
// the river obstacle so the visibility graph has fewer river nodes. Set to 0
// to remove this experiment.
export const RIVER_OBSTACLE_SIMPLIFY_TOLERANCE = 0.1;
// Routing-only approximation for dark wall-tower discs. The rendered towers
// stay circular; fewer obstacle vertices keep the visibility graph lighter.
const CIRCLE_OBSTACLE_SEGMENTS = 8;
// An octagon with circumradius r has flat sides at r*cos(pi/8). Inflate the
// routing polygon so its flat sides still cover the rendered circular tower.
export const WALL_TOWER_RADIUS = WALL_TOWER_RENDER_RADIUS / dcos(Math.PI / CIRCLE_OBSTACLE_SEGMENTS);
// Bridge / pier deck constants — kept in sync with the renderer (generator.html
// drawBridges / drawDocks) so the green overlay polygon matches the brown deck.
const BRIDGE_FILL_WIDTH = 1.6;
const WATER_OUTLINE_WIDTH = 0.2;
const RIVER_ROUTE_BANK_MARGIN = 0.8;
const BRIDGE_DECK_BLEED = WATER_OUTLINE_WIDTH * 1.5 + 0.05;
const PIER_FILL_WIDTH = 1.6;

export function extractObstacles(data) {
	const polygons = [];
	const lines = [];
	const portals = [];

	if (!data) return { polygons, lines, portals };

	for (const w of data.wards || [])
		if (w.water && w.polygon && w.polygon.length >= 3)
			polygons.push({ polygon: w.polygon, kind: 'water' });

	for (const b of data.buildings || []) {
		if (!b || !b.polygon || b.polygon.length < 3) continue;
		const cls = b.class || 'building';
		if (PASSABLE_BUILDING_CLASSES.has(cls)) continue;
		// Default-to-impassable so any future building class doesn't silently leak.
		if (IMPASSABLE_BUILDING_CLASSES.has(cls) || cls === 'building')
			polygons.push({ polygon: b.polygon, kind: cls === 'outerGarden' ? 'garden' : 'building', cls });
	}

	if (data.wall && data.wall.shape && data.wall.shape.length >= 2) {
		const shape = data.wall.shape;
		const segs = data.wall.segments || [];
		const n = shape.length;
		// Mirror generator.html's drawWall: pull a segment endpoint back along the
		// wall axis by half the river width when its adjacent segment is suppressed
		// (coast, river-edge, or crossing) or the endpoint itself sits on the river
		// course. Without this the obstacle wall runs to the river centre / shore
		// vertex instead of stopping at the riverbank as it does visually.
		const halfRiver = data.river && data.river.width > 0 ? data.river.width / 2 : 0;
		for (const polyline of wallObstaclePolylines(data.wall, data.river)) {
			lines.push({
				polyline,
				thickness: WALL_THICKNESS,
				kind: 'wall',
			});
		}
		// Dark-grey wall towers — impassable round obstacles at every shape vertex
		// that owns at least one active segment. We approximate the disc by a
		// polygon so the visibility graph stays uniform-shape.
		for (const t of data.wall.towers || []) {
			if (!t || !Number.isFinite(t.x)) continue;
			polygons.push({ polygon: circlePolygon(t, WALL_TOWER_RADIUS), kind: 'tower' });
		}
		// Light-grey gate towers — passable. Expose as portals with the same radius
		// so the visibility-graph builder can carve a matching opening.
		for (const g of data.wall.gateTowers || data.wall.gates || []) {
			if (!g || !Number.isFinite(g.x)) continue;
			portals.push({ kind: 'gate', center: { x: g.x, y: g.y }, radius: WALL_TOWER_RENDER_RADIUS });
		}
	}

	for (const h of data.hedges || [])
		if (h && h.length >= 2) lines.push({ polyline: h, thickness: HEDGE_THICKNESS, kind: 'hedge' });

	for (const h of data.cathedralHedges || [])
		if (h && h.length >= 2) lines.push({ polyline: h, thickness: CATHEDRAL_HEDGE_THICKNESS, kind: 'cathedralHedge' });

	if (data.river && data.river.course && data.river.course.length >= 2) {
		// Match the renderer: collapse the first two course points to their midpoint
		// when the river ends in a delta, then Chaikin-smooth before thickening.
		const raw = data.river.course;
		const seed = data.river.delta
			? [{ x: (raw[0].x + raw[1].x) / 2, y: (raw[0].y + raw[1].y) / 2 }, ...raw.slice(1)]
			: raw.map((p) => ({ x: p.x, y: p.y }));
		const smoothed = chaikinSmooth(seed, RIVER_SMOOTH_ITERATIONS);
		const riverWidth = data.river.width || 5;
		const routeRiverWidth = riverWidth + RIVER_ROUTE_BANK_MARGIN * 2;
		const riverKeep = riverSimplifyKeepIndices(smoothed, data.river.bridges || [], riverWidth);
		const obstacleCourse = RIVER_OBSTACLE_SIMPLIFY_TOLERANCE > 0
			? simplifyPolyline(smoothed, RIVER_OBSTACLE_SIMPLIFY_TOLERANCE, riverKeep)
			: smoothed;
		lines.push({ polyline: obstacleCourse, thickness: routeRiverWidth, kind: 'river' });

		// Delta fan = the river mouth where it meets the sea. The renderer builds it
		// from data.river.delta + the smoothed course; sample the two cubic beziers
		// into a closed polygon so the mouth is treated as water, not as a gap.
		if (data.river.delta) {
			const deltaPoly = buildDeltaPolygon(data.river.delta, smoothed, routeRiverWidth);
			if (deltaPoly && deltaPoly.length >= 3)
				polygons.push({ polygon: deltaPoly, kind: 'delta' });
		}

		// Bridges = passable polygons overlaid on the river strip. The deck geometry
		// is reproduced from the renderer (drawBridges) so the green polygon lines
		// up exactly with the brown bridge fill; the visibility graph can then take
		// the deck as the carved opening through the river polygon.
		for (const b of data.river.bridges || []) {
			const deck = buildBridgeDeck(b, data.river.course, smoothed, routeRiverWidth);
			if (deck && deck.length >= 3)
				portals.push({ kind: 'bridge', polygon: deck, a: b.from || null, b: b.to || null });
		}
	}

	for (const dock of data.docks || []) {
		if (!dock || !dock.piers) continue;
		for (const pier of dock.piers) {
			const deck = buildPierDeck(pier, !!dock.large);
			if (deck && deck.length >= 3)
				portals.push({
					kind: 'dock',
					polygon: deck,
					a: { x: pier.from.x, y: pier.from.y },
					b: { x: pier.to.x, y: pier.to.y },
					large: !!dock.large,
				});
		}
	}

	return { polygons, lines, portals };
}

function wallObstaclePolylines(wall, river) {
	const shape = wall && wall.shape;
	if (!shape || shape.length < 2) return [];
	const n = shape.length;
	const segs = wall.segments || [];
	const active = new Array(n);
	for (let i = 0; i < n; i++) active[i] = segs[i] !== false;

	const halfRiver = river && river.width > 0 ? river.width / 2 : 0;
	const riverNodes = new Set();
	if (halfRiver > 0 && river.course) for (const v of river.course) riverNodes.add(coordKey(v));

	const endpoints = new Array(n);
	for (let i = 0; i < n; i++) {
		if (!active[i]) continue;
		let a = shape[i];
		let b = shape[(i + 1) % n];
		if (halfRiver > 0) {
			const dx = b.x - a.x, dy = b.y - a.y;
			const len = dhypot(dx, dy) || 1;
			const ux = dx / len, uy = dy / len;
			let ax = a.x, ay = a.y, bx = b.x, by = b.y;
			if (!active[(i + n - 1) % n] || riverNodes.has(coordKey(a))) {
				ax = a.x + ux * halfRiver;
				ay = a.y + uy * halfRiver;
			}
			if (!active[(i + 1) % n] || riverNodes.has(coordKey(b))) {
				bx = b.x - ux * halfRiver;
				by = b.y - uy * halfRiver;
			}
			a = { x: ax, y: ay };
			b = { x: bx, y: by };
		}
		endpoints[i] = { a, b };
	}

	const gateVertices = new Set();
	for (const g of wall.gates || []) gateVertices.add(coordKey(g));
	const joinsAcrossVertex = (vertexIndex) => {
		if (!active[(vertexIndex + n - 1) % n] || !active[vertexIndex]) return false;
		return !gateVertices.has(coordKey(shape[vertexIndex]));
	};

	const activeCount = active.reduce((sum, isActive) => sum + (isActive ? 1 : 0), 0);
	if (activeCount === 0) return [];
	const allJoined = active.every((isActive, i) => isActive && joinsAcrossVertex(i));
	if (allJoined) return [cleanupPolyline(endpoints.map((seg) => seg.a).concat([endpoints[0].a]))];

	const starts = [];
	for (let i = 0; i < n; i++) {
		if (active[i] && !joinsAcrossVertex(i)) starts.push(i);
	}

	const out = [];
	const visited = new Array(n).fill(false);
	for (const start of starts) {
		if (visited[start]) continue;
		const polyline = [endpoints[start].a, endpoints[start].b];
		visited[start] = true;
		let i = (start + 1) % n;
		while (active[i] && joinsAcrossVertex(i) && !visited[i]) {
			polyline.push(endpoints[i].b);
			visited[i] = true;
			i = (i + 1) % n;
		}
		const cleaned = cleanupPolyline(polyline);
		if (cleaned.length >= 2) out.push(cleaned);
	}

	return out;
}

function coordKey(p) {
	return `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`;
}

function cleanupPolyline(polyline) {
	const out = [];
	for (const p of polyline) {
		const prev = out[out.length - 1];
		if (!prev || dhypot(prev.x - p.x, prev.y - p.y) > 1e-9) out.push(p);
	}
	return out;
}

export function thickenPolyline(polyline, thickness) {
	if (!polyline || polyline.length < 2 || !(thickness > 0)) return null;
	const half = thickness / 2;
	const left = [];
	const right = [];
	for (let i = 0; i < polyline.length; i++) {
		const prev = polyline[i - 1];
		const cur = polyline[i];
		const next = polyline[i + 1];
		let sumNx = 0, sumNy = 0;
		if (prev) {
			const dx = cur.x - prev.x, dy = cur.y - prev.y;
			const l = dhypot(dx, dy) || 1;
			sumNx += -dy / l; sumNy += dx / l;
		}
		if (next) {
			const dx = next.x - cur.x, dy = next.y - cur.y;
			const l = dhypot(dx, dy) || 1;
			sumNx += -dy / l; sumNy += dx / l;
		}
		const nl = dhypot(sumNx, sumNy) || 1;
		const nx = sumNx / nl;
		const ny = sumNy / nl;
		left.push({ x: cur.x + nx * half, y: cur.y + ny * half });
		right.push({ x: cur.x - nx * half, y: cur.y - ny * half });
	}
	return left.concat(right.reverse());
}

function circlePolygon(center, radius, segments = CIRCLE_OBSTACLE_SEGMENTS) {
	const out = [];
	for (let i = 0; i < segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		out.push({ x: center.x + dcos(a) * radius, y: center.y + dsin(a) * radius });
	}
	return out;
}

function chaikinSmooth(pts, iterations) {
	if (!pts || pts.length < 3) return pts || [];
	let a = pts;
	for (let it = 0; it < iterations; it++) {
		const h = [a[0]];
		for (let i = 1, n = a.length - 1; i < n; i++) {
			const g = a[i], p = a[i - 1], nx = a[i + 1];
			h.push({ x: g.x * 0.75 + p.x * 0.25, y: g.y * 0.75 + p.y * 0.25 });
			h.push({ x: g.x * 0.75 + nx.x * 0.25, y: g.y * 0.75 + nx.y * 0.25 });
		}
		h.push(a[a.length - 1]);
		a = h;
	}
	return a;
}

function riverSimplifyKeepIndices(pts, bridges, riverWidth) {
	const keep = new Set([0, pts.length - 1]);
	if (!pts || !bridges || bridges.length === 0) return keep;
	const radius = Math.max(2, riverWidth * 1.25);
	const radius2 = radius * radius;
	for (const b of bridges) {
		if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
		for (let i = 0; i < pts.length; i++) {
			const dx = pts[i].x - b.x, dy = pts[i].y - b.y;
			if (dx * dx + dy * dy <= radius2) keep.add(i);
		}
	}
	return keep;
}

function simplifyPolyline(pts, tolerance, forceKeep = null) {
	if (!pts || pts.length <= 2 || !(tolerance > 0)) return pts || [];
	const keep = new Uint8Array(pts.length);
	const tol2 = tolerance * tolerance;
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	if (forceKeep) {
		for (const i of forceKeep)
			if (i >= 0 && i < pts.length) keep[i] = 1;
	}
	const breaks = [];
	for (let i = 0; i < pts.length; i++)
		if (keep[i]) breaks.push(i);
	const stack = [];
	for (let i = 1; i < breaks.length; i++)
		if (breaks[i] > breaks[i - 1] + 1) stack.push([breaks[i - 1], breaks[i]]);
	while (stack.length > 0) {
		const [start, end] = stack.pop();
		let best = -1;
		let bestDist = tol2;
		for (let i = start + 1; i < end; i++) {
			const d = pointSegmentDistanceSq(pts[i], pts[start], pts[end]);
			if (d > bestDist) {
				bestDist = d;
				best = i;
			}
		}
		if (best >= 0) {
			keep[best] = 1;
			stack.push([start, best], [best, end]);
		}
	}
	const out = [];
	for (let i = 0; i < pts.length; i++)
		if (keep[i]) out.push(pts[i]);
	return out;
}

function pointSegmentDistanceSq(p, a, b) {
	const dx = b.x - a.x, dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	if (len2 <= 1e-12) {
		const ex = p.x - a.x, ey = p.y - a.y;
		return ex * ex + ey * ey;
	}
	let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
	if (t < 0) t = 0;
	else if (t > 1) t = 1;
	const qx = a.x + dx * t, qy = a.y + dy * t;
	const ex = p.x - qx, ey = p.y - qy;
	return ex * ex + ey * ey;
}

// Sample one cubic bezier between P0 and P3 with controls C1, C2 into `steps`+1
// points (excluding the start so adjacent samplings concatenate cleanly).
function sampleBezier(P0, C1, C2, P3, steps) {
	const out = [];
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		const x = u * u * u * P0.x + 3 * u * u * t * C1.x + 3 * u * t * t * C2.x + t * t * t * P3.x;
		const y = u * u * u * P0.y + 3 * u * u * t * C1.y + 3 * u * t * t * C2.y + t * t * t * P3.y;
		out.push({ x, y });
	}
	return out;
}

// Ported from generator.html drawBridges: the deck is a 4-vertex polygon spanning
// from one shore to the other along the bridge axis. We rebuild the same axis +
// shore intersections so the green obstacle-overlay polygon matches the brown
// deck on screen. Steps:
//   1. axis = direction from bridge.from→bridge.to if available, else perpendicular
//      to the river tangent at the bridge point;
//   2. shift two parallel lines ±halfDeck along the sideNormal (perpendicular to
//      the axis); from each line's crossing with the smoothed centerline, walk
//      outward along the axis to where the line leaves the water band (distance
//      to the centerline ≥ shoreHalfWidth) — that is the shore landing;
//   3. bleed each corner outward by BRIDGE_DECK_BLEED so the deck overlaps the
//      water-outline stroke, leaving no hairline gap.
function buildBridgeDeck(bridge, course, smoothed, riverWidth) {
	if (!bridge || !course || course.length < 3 || !smoothed || smoothed.length < 2) return null;
	const i = course.findIndex((p) => Math.abs(p.x - bridge.x) < 1e-6 && Math.abs(p.y - bridge.y) < 1e-6);
	if (i <= 0 || i >= course.length - 1) return null;
	let axis = null;
	if (bridge.from && bridge.to) {
		const dx = bridge.to.x - bridge.from.x, dy = bridge.to.y - bridge.from.y;
		const len = dhypot(dx, dy) || 1;
		axis = { x: dx / len, y: dy / len };
	} else {
		const crossing = closestPointOnPath({ x: bridge.x, y: bridge.y }, smoothed);
		if (!crossing) return null;
		const tangent = riverTangentAt(smoothed, crossing.segment);
		axis = { x: -tangent.y, y: tangent.x };
	}
	const centerCrossing = visualRiverCrossing({ x: bridge.x, y: bridge.y }, axis, smoothed, true);
	if (!centerCrossing) return null;
	const sideNormal = { x: -axis.y, y: axis.x };
	// WIDE_MAIN_ROADS_50_FLAG: road-connected bridges carry a serialized 50%-wider deck width.
	const deckWidth = Number.isFinite(bridge.width) ? bridge.width : BRIDGE_FILL_WIDTH;
	const halfDeck = deckWidth / 2;
	const shoreHalfWidth = (riverWidth || 5) / 2 + WATER_OUTLINE_WIDTH;
	const leftOrigin = {
		x: centerCrossing.point.x + sideNormal.x * halfDeck,
		y: centerCrossing.point.y + sideNormal.y * halfDeck,
	};
	const rightOrigin = {
		x: centerCrossing.point.x - sideNormal.x * halfDeck,
		y: centerCrossing.point.y - sideNormal.y * halfDeck,
	};
	const left = bridgeSideShorePoints(leftOrigin, axis, smoothed, shoreHalfWidth);
	const right = bridgeSideShorePoints(rightOrigin, axis, smoothed, shoreHalfWidth);
	if (!left || !right) return null;
	return [
		bleedPoint(left.center, left.minus, BRIDGE_DECK_BLEED),
		bleedPoint(left.center, left.plus, BRIDGE_DECK_BLEED),
		bleedPoint(right.center, right.plus, BRIDGE_DECK_BLEED),
		bleedPoint(right.center, right.minus, BRIDGE_DECK_BLEED),
	];
}

// Pier deck = thin rectangle along `from→to` with rendered fillWidth (×2 large).
function buildPierDeck(pier, large) {
	if (!pier || !pier.from || !pier.to) return null;
	const dx = pier.to.x - pier.from.x, dy = pier.to.y - pier.from.y;
	const len = dhypot(dx, dy);
	if (!(len > 1e-6)) return null;
	const ux = dx / len, uy = dy / len;
	const half = (large ? PIER_FILL_WIDTH * 2 : PIER_FILL_WIDTH) / 2;
	const nx = -uy, ny = ux;
	return [
		{ x: pier.from.x + nx * half, y: pier.from.y + ny * half },
		{ x: pier.to.x + nx * half, y: pier.to.y + ny * half },
		{ x: pier.to.x - nx * half, y: pier.to.y - ny * half },
		{ x: pier.from.x - nx * half, y: pier.from.y - ny * half },
	];
}

function closestPointOnSegment(p, a, b) {
	const dx = b.x - a.x, dy = b.y - a.y;
	const l2 = dx * dx + dy * dy || 1;
	let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
	t = Math.max(0, Math.min(1, t));
	const px = a.x + dx * t, py = a.y + dy * t;
	return { x: px, y: py, distance: dhypot(p.x - px, p.y - py) };
}

function closestPointOnPath(p, path) {
	let best = null;
	for (let i = 0; i < path.length - 1; i++) {
		const q = closestPointOnSegment(p, path[i], path[i + 1]);
		if (!best || q.distance < best.distance) best = { ...q, segment: i };
	}
	return best;
}

function visualRiverCrossing(origin, axis, path, allowFallback) {
	let best = null;
	for (let i = 0; i < path.length - 1; i++) {
		const a = path[i], b = path[i + 1];
		const sx = b.x - a.x, sy = b.y - a.y;
		const denom = axis.x * sy - axis.y * sx;
		if (Math.abs(denom) < 1e-8) continue;
		const ox = a.x - origin.x, oy = a.y - origin.y;
		const t = (ox * sy - oy * sx) / denom;
		const u = (ox * axis.y - oy * axis.x) / denom;
		if (u < -1e-6 || u > 1 + 1e-6) continue;
		const point = { x: origin.x + axis.x * t, y: origin.y + axis.y * t };
		const score = Math.abs(t);
		if (!best || score < best.score) best = { point, segment: i, score };
	}
	if (best) return best;
	if (!allowFallback) return null;
	const closest = closestPointOnPath(origin, path);
	return closest ? { point: { x: closest.x, y: closest.y }, segment: closest.segment } : null;
}

function riverTangentAt(path, segment) {
	const a = path[Math.max(0, Math.min(segment, path.length - 2))];
	const b = path[Math.max(1, Math.min(segment + 1, path.length - 1))];
	const dx = b.x - a.x, dy = b.y - a.y;
	const len = dhypot(dx, dy) || 1;
	return { x: dx / len, y: dy / len };
}

function distanceToPath(p, path) {
	let best = Infinity;
	for (let i = 0; i < path.length - 1; i++) {
		const d = pointSegmentDistanceSq(p, path[i], path[i + 1]);
		if (d < best) best = d;
	}
	return Math.sqrt(best);
}

// The rendered river is a round-join stroke along the smoothed centerline, so
// water is exactly the set of points within `radius` of that polyline. March
// along `dir` from a point on the centerline until the ray first leaves the
// water band, then bisect the exact shore distance. A tangent projection
// (span = shoreHalfWidth / axis·normal) assumes a locally straight river and
// misses the real shore wherever the river bends sharply near the bridge.
function shoreExitAlongRay(start, dir, path, radius) {
	const step = Math.max(0.4, radius * 0.2);
	const maxSpan = radius * 12;
	let inside = 0;
	let outside = -1;
	for (let s = step; s <= maxSpan; s += step) {
		if (distanceToPath({ x: start.x + dir.x * s, y: start.y + dir.y * s }, path) >= radius) {
			outside = s;
			break;
		}
		inside = s;
	}
	if (outside < 0) return null;
	for (let k = 0; k < 20; k++) {
		const mid = (inside + outside) / 2;
		if (distanceToPath({ x: start.x + dir.x * mid, y: start.y + dir.y * mid }, path) >= radius) outside = mid;
		else inside = mid;
	}
	return { x: start.x + dir.x * outside, y: start.y + dir.y * outside };
}

function bridgeSideShorePoints(origin, axis, path, shoreHalfWidth) {
	const crossing = visualRiverCrossing(origin, axis, path, false);
	if (!crossing) return null;
	const plus = shoreExitAlongRay(crossing.point, axis, path, shoreHalfWidth);
	const minus = shoreExitAlongRay(crossing.point, { x: -axis.x, y: -axis.y }, path, shoreHalfWidth);
	if (!plus || !minus) return null;
	return { minus, plus, center: crossing.point };
}

function bleedPoint(center, point, bleed) {
	const dx = point.x - center.x, dy = point.y - center.y;
	const len = dhypot(dx, dy);
	if (len < 1e-6) return point;
	return { x: point.x + (dx / len) * bleed, y: point.y + (dy / len) * bleed };
}

// Mirror generator.html's previewDeltaFromPath: re-pin the delta's `left`/`right`
// shoulders to the smoothed river head so the polygon stays attached to the
// river strip we just thickened. Then walk the same outline the renderer draws:
//   right → C(rightCtrl1, rightCtrl2, prevShore) → [mouth?] → nextShore →
//   C(leftCtrl1, leftCtrl2, left) → close.
function buildDeltaPolygon(delta, smoothedCourse, riverWidth) {
	if (!delta || !smoothedCourse || smoothedCourse.length < 2) return null;
	const p0 = smoothedCourse[0];
	const p1 = smoothedCourse[1];
	const dx = p1.x - p0.x, dy = p1.y - p0.y;
	const len = dhypot(dx, dy) || 1;
	const tx = dx / len, ty = dy / len;
	const hw = (riverWidth || 5) / 2;
	const a = { x: p0.x - ty * hw, y: p0.y + tx * hw };
	const b = { x: p0.x + ty * hw, y: p0.y - tx * hw };
	const aRight = dhypot(a.x - delta.right.x, a.y - delta.right.y);
	const bRight = dhypot(b.x - delta.right.x, b.y - delta.right.y);
	const right = aRight <= bRight ? a : b;
	const left = right === a ? b : a;
	const ctrlLen = Math.max(
		dhypot(delta.right.x - delta.rightCtrl1.x, delta.right.y - delta.rightCtrl1.y),
		len * 0.5,
	);
	const rightCtrl1 = { x: right.x - tx * ctrlLen, y: right.y - ty * ctrlLen };
	const leftCtrl2 = { x: left.x - tx * ctrlLen, y: left.y - ty * ctrlLen };

	const steps = 12;
	const poly = [right];
	poly.push(...sampleBezier(right, rightCtrl1, delta.rightCtrl2, delta.prevShore, steps));
	if (delta.isConvex && delta.mouth) poly.push({ x: delta.mouth.x, y: delta.mouth.y });
	poly.push({ x: delta.nextShore.x, y: delta.nextShore.y });
	poly.push(...sampleBezier(delta.nextShore, delta.leftCtrl1, leftCtrl2, left, steps));
	return poly;
}
