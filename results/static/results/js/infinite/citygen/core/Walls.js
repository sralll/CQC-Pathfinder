// Walls.js — preview-friendly port of mfcg CurtainWall for CityGen.js.
// It operates on shared Polygon vertices, so smoothing the wall also reshapes adjacent wards.

import { Point } from './Point.js';
import { Polygon } from './Polygon.js';
import { Random } from './Random.js';
import { difference, replace } from './arrays.js';

function addEdge(map, a, b) {
	let s = map.get(a);
	if (!s) map.set(a, (s = new Set()));
	s.add(b);
}

function directedEdges(cells) {
	const dir = new Map();
	for (const cell of cells)
		for (let i = 0; i < cell.length; i++) addEdge(dir, cell[i], cell[(i + 1) % cell.length]);
	return dir;
}

function edgeKey(a, b) {
	return `${a.x},${a.y}|${b.x},${b.y}`;
}

function boundaryEdges(patches) {
	const dir = directedEdges(patches);
	const out = [];
	for (const cell of patches)
		for (let i = 0; i < cell.length; i++) {
			const a = cell[i];
			const b = cell[(i + 1) % cell.length];
			if (!(dir.get(b) && dir.get(b).has(a))) out.push({ origin: a, end: b });
		}
	return out;
}

function chainEdges(edges) {
	if (edges.length === 0) return [];
	const unused = edges.slice();
	const chain = [unused.shift()];
	while (unused.length > 0) {
		const end = chain[chain.length - 1].end;
		const i = unused.findIndex((e) => e.origin === end);
		if (i === -1) break;
		chain.push(unused.splice(i, 1)[0]);
		if (chain[chain.length - 1].end === chain[0].origin) break;
	}
	return chain;
}

function cellsByVertex(cells, v) {
	return cells.filter((c) => c.includes(v));
}

function smoothClosedInPlace(shape, reserved, iterations) {
	for (let it = 0; it < iterations; it++) {
		const smoothed = shape.map((v) => (reserved.includes(v) ? v : shape.smoothVertex(v)));
		shape.set(smoothed);
	}
}

function weightedIndex(weights) {
	const total = weights.reduce((a, b) => a + b, 0);
	if (total <= 0) return -1;
	let r = Random.float() * total;
	for (let i = 0; i < weights.length; i++) {
		r -= weights[i];
		if (r <= 0) return i;
	}
	return 0;
}

function copyCellFlags(src, dst) {
	dst.water = !!src.water;
	dst.withinCity = !!src.withinCity;
	dst.withinWalls = !!src.withinWalls;
	return dst;
}

function splitOuterWardAtGate(cells, inner, shape, gate, reserved) {
	const outer = cellsByVertex(cells, gate).filter((c) => !inner.includes(c));
	if (outer.length !== 1 || outer[0].length <= 3) return;

	const cell = outer[0];
	let candidates = difference(cell, reserved);
	candidates = difference(candidates, shape);
	if (candidates.length === 0) return;

	const prev = shape.prev(gate);
	const next = shape.next(gate);
	const outward = gate.subtract({ x: (prev.x + next.x) / 2, y: (prev.y + next.y) / 2 });
	const farthest = candidates.reduce((best, v) => {
		const dir = v.subtract(gate);
		const score = dir.length > 0 ? dir.dot(outward) / dir.length : Number.NEGATIVE_INFINITY;
		return score > best.score ? { v, score } : best;
	}, { v: candidates[0], score: Number.NEGATIVE_INFINITY }).v;

	const halves = cell.split(gate, farthest).map((h) => copyCellFlags(cell, new Polygon(h)));
	replace(cells, cell, halves);
}

function shoreVertices(cells) {
	const out = [];
	const byVertex = new Map();
	for (const cell of cells)
		for (const v of cell) {
			let a = byVertex.get(v);
			if (!a) byVertex.set(v, (a = []));
			a.push(cell);
		}
	for (const [v, touched] of byVertex) if (touched.some((c) => c.water) && touched.some((c) => !c.water)) out.push(v);
	return out;
}

function markCoastSegments(wall, cells) {
	const landDir = directedEdges(cells.filter((c) => !c.water));
	const waterDir = directedEdges(cells.filter((c) => c.water));
	for (let i = 0; i < wall.edges.length; i++) {
		const a = wall.edges[i].origin;
		const b = wall.edges[i].end;
		if (waterDir.get(b) && waterDir.get(b).has(a) && landDir.get(a) && landDir.get(a).has(b)) wall.segments[i] = false;
	}
}

function rebuildTowers(wall) {
	const builtSegmentCount = (i) => {
		const prev = wall.segments[(i + wall.shape.length - 1) % wall.shape.length];
		const next = wall.segments[i];
		return (prev ? 1 : 0) + (next ? 1 : 0);
	};
	const gateSet = new Set(wall.gates.filter((gate) => builtSegmentCount(wall.shape.indexOf(gate)) === 2));
	wall.gates = wall.gates.filter((gate) => gateSet.has(gate));
	if (wall.crossingGates) wall.crossingGates = wall.crossingGates.filter((gate) => gateSet.has(gate));
	wall.gateTowers = wall.gates.slice();
	wall.towers = [];
	// Place a tower if at least one adjacent segment is active (OR logic). Towers at
	// water/river endpoints are offset inland by the renderer so they sit fully on land.
	for (let i = 0; i < wall.shape.length; i++) {
		if (!gateSet.has(wall.shape[i]) && builtSegmentCount(i) > 0) wall.towers.push(wall.shape[i]);
	}
}

// Replace tower / gate-tower references with NEW point objects pulled back from
// the original shape vertex along the active wall segment, by the same halfRiver
// the renderer uses. Mirrors the pull-back logic in generator.html `drawWall` so
// the data position agrees with what's drawn. We allocate new {x,y} objects (not
// mutate the shape vertices, which are shared with adjacent wards).
//
// Rules per shape vertex i:
//   prev = segments[i-1], next = segments[i]
//   if (!prev && next)  -> at start of next segment, pull toward shape[i+1]
//   if (prev && !next)  -> at   end of prev segment, pull toward shape[i-1]
//   else                -> no displacement (interior junction or no tower at all)
export function displaceWallTowers(wall, river) {
	if (!wall || !wall.shape || !wall.segments || !river || !(river.width > 0)) return;
	const halfRiver = river.width / 2;
	const n = wall.shape.length;
	const segs = wall.segments;
	const displaced = new Map();
	for (let i = 0; i < n; i++) {
		const prev = segs[(i + n - 1) % n];
		const next = segs[i];
		let neighbour = null;
		if (!prev && next) neighbour = wall.shape[(i + 1) % n];
		else if (prev && !next) neighbour = wall.shape[(i + n - 1) % n];
		else continue;
		const v = wall.shape[i];
		const dx = neighbour.x - v.x, dy = neighbour.y - v.y;
		const len = Math.hypot(dx, dy) || 1;
		displaced.set(v, { x: v.x + (dx / len) * halfRiver, y: v.y + (dy / len) * halfRiver });
	}
	const remap = (arr) => arr.map((t) => displaced.get(t) || t);
	if (wall.towers) wall.towers = remap(wall.towers);
	if (wall.gateTowers) wall.gateTowers = remap(wall.gateTowers);
}

export function suppressWallSegmentsOnRiver(wall, river) {
	if (!wall || !river || !river.course || river.course.length < 2) return;
	const edges = new Map();
	for (let i = 0; i < river.course.length - 1; i++) {
		addEdge(edges, river.course[i], river.course[i + 1]);
		addEdge(edges, river.course[i + 1], river.course[i]);
	}
	// Only suppress segments that ARE river edges (run along the river course). Segments
	// that merely TOUCH a river node are kept — the renderer pulls their river-node
	// endpoint back by half the river width so the wall extends toward the water but
	// stops at the riverbank, not inside it.
	for (let i = 0; i < wall.edges.length; i++) {
		const a = wall.edges[i].origin;
		const b = wall.edges[i].end;
		if (edges.get(a) && edges.get(a).has(b)) wall.segments[i] = false;
	}
}

function connectionCounts(cells) {
	const counts = new Map();
	for (const cell of cells)
		for (let i = 0; i < cell.length; i++) {
			const v = cell[i];
			let neighbours = counts.get(v);
			if (!neighbours) counts.set(v, (neighbours = new Set()));
			neighbours.add(cell[(i + cell.length - 1) % cell.length]);
			neighbours.add(cell[(i + 1) % cell.length]);
		}
	return counts;
}

function crossingConnection(neighbours, v, prev, next) {
	if (!neighbours || neighbours.size < 4 || !prev || !next) return null;
	const tx = next.x - prev.x;
	const ty = next.y - prev.y;
	if (Math.hypot(tx, ty) < 1e-6) return null;

	const sides = { negative: null, positive: null };
	for (const n of neighbours) {
		if (n === prev || n === next) continue;
		const side = tx * (n.y - v.y) - ty * (n.x - v.x);
		if (Math.abs(side) < 1e-6) continue;
		const distance = Point.distance(v, n) || 1;
		const candidate = { point: n, score: Math.abs(side) / distance };
		if (side < 0) {
			if (!sides.negative || candidate.score > sides.negative.score) sides.negative = candidate;
		} else if (!sides.positive || candidate.score > sides.positive.score) sides.positive = candidate;
	}
	return sides.negative && sides.positive ? { negative: sides.negative.point, positive: sides.positive.point } : null;
}

function hasOppositeSideConnections(neighbours, v, prev, next) {
	return !!crossingConnection(neighbours, v, prev, next);
}

function riverIndexAt(river, v) {
	if (!river || !river.course) return -1;
	return river.course.indexOf(v);
}

function bridgeAcrossRiverConnection(counts, river, v) {
	const i = riverIndexAt(river, v);
	if (i <= 0 || i >= river.course.length - 1) return null;
	return crossingConnection(counts.get(v), v, river.course[i - 1], river.course[i + 1]);
}

export function addObstacleCrossings(cells, wall, river) {
	const crossings = { bridges: [] };
	const counts = connectionCounts(cells.filter((c) => !c.water));
	const riverNodes = new Set(river && river.course ? river.course : []);
	const wallNodes = new Set(wall && wall.shape ? wall.shape : []);

	if (wall) {
		wall.crossingGates = [];
		for (let i = 0; i < wall.shape.length; i++) {
			const v = wall.shape[i];
			const prev = wall.shape[(i + wall.shape.length - 1) % wall.shape.length];
			const next = wall.shape[(i + 1) % wall.shape.length];
			if (riverNodes.has(v)) {
				// River treatment wins: don't place a gate or crossing-gate at a river node.
				// If the node was a gate, turn it into a bridge across the river and drop the gate.
				if (wall.gates.includes(v)) {
					wall.gates = wall.gates.filter((g) => g !== v);
					if (river && river.course) {
						const connection = bridgeAcrossRiverConnection(counts, river, v);
						crossings.bridges.push(
							connection
								? { point: v, from: connection.negative, to: connection.positive }
								: { point: v }
						);
					}
				}
				// Always split the wall at a river crossing — gate or not. Suppressing both
				// adjacent segments stops the wall at the riverbank on each side, so the renderer
				// places two towers at the riverbank ends instead of running a single tower out
				// into the water.
				if (wall.segments) {
					wall.segments[(i + wall.shape.length - 1) % wall.shape.length] = false;
					wall.segments[i] = false;
				}
				continue;
			}
			if (hasOppositeSideConnections(counts.get(v), v, prev, next)) {
				if (!wall.gates.includes(v)) wall.gates.push(v);
				if (!wall.crossingGates.includes(v)) wall.crossingGates.push(v);
			}
		}
		rebuildTowers(wall);
	}

	if (river && river.course) {
		for (let i = 1; i < river.course.length - 1; i++) {
			const v = river.course[i];
			if (wallNodes.has(v)) continue;
			const connection = crossingConnection(counts.get(v), v, river.course[i - 1], river.course[i + 1]);
			if (connection && !crossings.bridges.some((b) => b.point === v)) crossings.bridges.push({ point: v, from: connection.negative, to: connection.positive });
		}

		if (river.course.length >= 4 && crossings.bridges.length < 2) {
			const bridgePoints = new Set(crossings.bridges.map((b) => b.point));
			while (crossings.bridges.length < 2) {
				let bestV = null;
				let bestIdx = -1;
				let bestScore = -Infinity;
				for (let i = 1; i < river.course.length - 1; i++) {
					const v = river.course[i];
					if (bridgePoints.has(v) || wallNodes.has(v)) continue;
					const score =
						crossings.bridges.length > 0
							? Math.min(...crossings.bridges.map((b) => Point.distance(b.point, v)))
							: -Math.abs(i - river.course.length / 2);
					if (score > bestScore) {
						bestScore = score;
						bestV = v;
						bestIdx = i;
					}
				}
				if (!bestV) break;
				crossings.bridges.push({ point: bestV });
				bridgePoints.add(bestV);
			}
		}

		river.bridges = crossings.bridges;
	}

	return crossings;
}

export function buildCityWall(cells, inner, opts = {}) {
	if (!inner || inner.length === 0) return null;

	const reserved = opts.reserved || shoreVertices(cells);
	let edges = chainEdges(boundaryEdges(inner));
	if (edges.length < 3) return null;
	const shape = new Polygon(edges.map((e) => e.origin));

	if (opts.real !== false && inner.length > 1) smoothClosedInPlace(shape, reserved, 3);

	const weights = edges.map((e) => (reserved.includes(e.origin) || cellsByVertex(cells, e.origin).filter((c) => inner.includes(c)).length < 2 ? 0 : 1));
	if (weights.reduce((a, b) => a + b, 0) === 0) return null;

	const gateTarget =
		opts.gates != null && opts.gates >= 0
			? opts.gates
			: opts.hub
				? shape.length
				: 2 + Math.trunc(inner.length / 12 * (reserved.length > 0 ? 0.75 : 1));
	const gates = [];
	while (gates.length < gateTarget && weights.reduce((a, b) => a + b, 0) > 0) {
		const index = weightedIndex(weights);
		if (index === -1) break;
		const gate = edges[index].origin;
		gates.push(gate);

		if (opts.real !== false) splitOuterWardAtGate(cells, inner, shape, gate, reserved);

		for (let i = 0; i < weights.length; i++) {
			let d = Math.abs(i - index);
			if (d > weights.length / 2) d = weights.length - d;
			weights[i] *= d <= 1 ? 0 : d - 1;
		}
	}
	if (gates.length === 0 && gateTarget > 0) return null;

	if (opts.real !== false) for (const gate of gates) gate.set(shape.smoothVertex(gate));

	// Splitting outer wards can change cell topology, but the wall ring itself stays the same.
	edges = shape.map((origin, i) => ({ origin, end: shape[(i + 1) % shape.length] }));
	const wall = { shape, edges, gates, towers: [], segments: shape.map(() => true) };
	markCoastSegments(wall, cells);
	rebuildTowers(wall);
	return wall;
}
