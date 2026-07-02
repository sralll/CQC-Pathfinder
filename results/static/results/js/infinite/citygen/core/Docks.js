import { Point } from './Point.js';
import { Random } from './Random.js';

function addCellEdge(map, a, b, cell) {
	let out = map.get(a);
	if (!out) map.set(a, (out = new Map()));
	out.set(b, cell);
}

function directedCellEdges(cells) {
	const out = new Map();
	for (const cell of cells)
		for (let i = 0; i < cell.length; i++) addCellEdge(out, cell[i], cell[(i + 1) % cell.length], cell);
	return out;
}

function addEdge(map, a, b) {
	let out = map.get(a);
	if (!out) map.set(a, (out = new Set()));
	out.add(b);
}

function riverEdges(river) {
	const out = new Map();
	if (!river || !river.course) return out;
	for (let i = 0; i < river.course.length - 1; i++) {
		addEdge(out, river.course[i], river.course[i + 1]);
		addEdge(out, river.course[i + 1], river.course[i]);
	}
	return out;
}

function hasRiverEdge(cell, edges) {
	for (let i = 0; i < cell.length; i++) {
		const a = cell[i];
		const b = cell[(i + 1) % cell.length];
		if (edges.get(a)?.has(b)) return true;
	}
	return false;
}

function shoreEdges(cell, waterEdges) {
	const edges = [];
	for (let i = 0; i < cell.length; i++) {
		const a = cell[i];
		const b = cell[(i + 1) % cell.length];
		const water = waterEdges.get(b)?.get(a);
		if (water) edges.push({ a, b, water });
	}
	return edges;
}

function lerp(a, b, t) {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function evenlySpaced(items, count) {
	if (count <= 0) return [];
	if (count >= items.length) return items.slice();
	const out = [];
	const step = items.length / count;
	for (let i = 0; i < count; i++) out.push(items[Math.floor((i + 0.5) * step)]);
	return out;
}

function outwardNormal(edge) {
	const length = Point.distance(edge.a, edge.b);
	if (length < 1e-6) return null;
	const midpoint = lerp(edge.a, edge.b, 0.5);
	const waterCenter = edge.water.centroid;
	const dx = edge.b.x - edge.a.x;
	const dy = edge.b.y - edge.a.y;
	let nx = -dy / length;
	let ny = dx / length;
	if (nx * (waterCenter.x - midpoint.x) + ny * (waterCenter.y - midpoint.y) < 0) {
		nx = -nx;
		ny = -ny;
	}
	return { nx, ny, tx: dx / length, ty: dy / length, length };
}

function pierSegments(edge) {
	const n = outwardNormal(edge);
	if (!n || n.length < 3) return [];

	const count = Math.max(1, Math.floor(n.length / 6));
	const start = count === 1 ? 0.5 : (1 - (6 * (count - 1)) / n.length) / 2;
	const step = count === 1 ? 0 : 6 / n.length;
	const piers = [];
	for (let i = 0; i < count; i++) {
		const from = lerp(edge.a, edge.b, start + step * i);
		piers.push({ from, to: { x: from.x + n.nx * 8, y: from.y + n.ny * 8 } });
	}
	return piers;
}

function largePierSegments(edge) {
	const n = outwardNormal(edge);
	if (!n || n.length < 5) return [];

	const mid = lerp(edge.a, edge.b, 0.5);
	const reach = Math.min(16.5, n.length * 1.05);
	const end = { x: mid.x + n.nx * reach, y: mid.y + n.ny * reach };
	const armLength = Math.min(10, n.length * 0.7);
	const side = Random.float() < 0.5 ? 1 : -1;

	return [
		{ from: { x: mid.x, y: mid.y }, to: end },
		{ from: end,
		  to: { x: end.x + n.tx * armLength * side, y: end.y + n.ty * armLength * side } },
	];
}

export function buildDocks(cells, inner, opts = {}) {
	const docks = [];
	if (!inner || inner.length === 0 || !cells.some((c) => c.water)) return docks;

	const waterEdges = directedCellEdges(cells.filter((c) => c.water));
	const blockedRiverEdges = riverEdges(opts.river);
	const riverVerts = new Set(opts.river && opts.river.course ? opts.river.course : []);
	const dockRatio = opts.ratio != null ? opts.ratio : 0.5;
	const maxDocks = opts.maxDocks != null ? opts.maxDocks : Math.floor(Math.sqrt(inner.length / 2)) + (opts.river ? 2 : 0);
	if (maxDocks <= 0 || dockRatio <= 0) return docks;

	const eligible = [];
	for (const cell of inner) {
		if (hasRiverEdge(cell, blockedRiverEdges)) continue;
		if (cell.some((v) => riverVerts.has(v))) continue;
		const edges = shoreEdges(cell, waterEdges);
		if (edges.length === 0) continue;
		eligible.push({ cell, edges });
	}

	const target = Math.min(maxDocks, Math.round(eligible.length * dockRatio));
	for (const { cell, edges } of evenlySpaced(eligible, target)) {
		cell.landing = true;

		const edge = edges.reduce((best, e) => (Point.distance(e.a, e.b) > Point.distance(best.a, best.b) ? e : best), edges[0]);
		const piers = pierSegments(edge);
		if (piers.length > 0) docks.push({ cell, shore: { from: edge.a, to: edge.b }, piers, large: false });
	}

	return docks;
}
