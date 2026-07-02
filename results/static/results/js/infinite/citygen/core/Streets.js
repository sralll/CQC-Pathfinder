// Streets.js — preview port of mfcg City.buildStreets + tidyUpRoads.
// Builds gate-to-center streets, outside roads, merges them into arteries, then smooths the
// resulting arteries in-place with the same open smoothing rule as the reference.

import { Point } from './Point.js';
import { Polygon } from './Polygon.js';
import { Graph } from './Graph.js';
import { addUnique } from './arrays.js';

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

function landHorizonExits(cells) {
	const land = cells.filter((c) => !c.water);
	const waterDir = directedEdges(cells.filter((c) => c.water));
	const landDir = directedEdges(land);
	const exits = [];
	for (const [a, set] of landDir)
		for (const b of set) {
			const reverseLand = landDir.get(b) && landDir.get(b).has(a);
			const reverseWater = waterDir.get(b) && waterDir.get(b).has(a);
			if (!reverseLand && !reverseWater) {
				addUnique(exits, a);
				addUnique(exits, b);
			}
		}
	return exits;
}

class RoadTopology {
	constructor(cells, blocked = []) {
		this.graph = new Graph();
		this.pt2node = new Map();
		this.node2pt = new Map();
		this.blocked = blocked;

		for (const cell of cells) {
			if (cell.water) continue;
			let v1 = cell[cell.length - 1];
			let n1 = this.process(v1);
			for (let i = 0; i < cell.length; i++) {
				const v0 = v1;
				v1 = cell[i];
				const n0 = n1;
				n1 = this.process(v1);
				if (n0 && n1) n0.link(n1, Point.distance(v0, v1));
			}
		}
	}

	process(v) {
		let n = this.pt2node.get(v);
		if (!n) {
			n = this.graph.add();
			this.pt2node.set(v, n);
			this.node2pt.set(n, v);
		}
		return this.blocked.includes(v) ? null : n;
	}

	buildPath(from, to) {
		const a = this.pt2node.get(from);
		const b = this.pt2node.get(to);
		if (!a || !b) return null;
		const path = this.graph.aStar(a, b);
		return path ? path.map((n) => this.node2pt.get(n)) : null;
	}
}

function smoothOpenInPlace(path, pinned, iterations) {
	for (let it = 0; it < iterations; it++) {
		const out = path.map((p, i) => {
			if (i === 0 || i === path.length - 1 || pinned.includes(p)) return p;
			const prev = path[i - 1];
			const next = path[i + 1];
			return { x: (prev.x + p.x * 2 + next.x) / 4, y: (prev.y + p.y * 2 + next.y) / 4 };
		});
		for (let i = 1; i < path.length - 1; i++) if (!pinned.includes(path[i])) path[i].set(out[i]);
	}
}

function tidyUpRoads(streets, roads, plaza) {
	const segments = [];
	const cut = (street) => {
		let v1 = street[0];
		for (let i = 1; i < street.length; i++) {
			const v0 = v1;
			v1 = street[i];
			if (plaza && plaza.includes(v0) && plaza.includes(v1)) continue;
			if (!segments.some((s) => s.start === v0 && s.end === v1)) segments.push({ start: v0, end: v1 });
		}
	};
	for (const s of streets) cut(s);
	for (const r of roads) cut(r);

	const arteries = [];
	while (segments.length > 0) {
		const seg = segments.pop();
		let attached = false;
		for (const a of arteries) {
			if (a[0] === seg.end) {
				a.unshift(seg.start);
				attached = true;
				break;
			} else if (a[a.length - 1] === seg.start) {
				a.push(seg.end);
				attached = true;
				break;
			}
		}
		if (!attached) arteries.push(new Polygon([seg.start, seg.end]));
	}
	return arteries;
}

export function buildStreets(cells, inner, center, wall, opts = {}) {
	const out = { streets: [], roads: [], arteries: [], shoreVertices: shoreVertices(cells) };
	if (!wall || !wall.gates || wall.gates.length === 0 || !center) return out;

	const gates = wall.gates;
	const roadsPerGate = Math.max(1, Math.trunc(opts.roadsPerGate || 1));
	const extraInner = Math.max(0, Math.trunc(opts.extraInner || 0));
	const blocked = wall.shape.concat(out.shoreVertices).filter((v) => !gates.includes(v));
	const innerTopo = new RoadTopology(inner, blocked);
	const outerTopo = new RoadTopology(cells.filter((c) => !c.withinCity && !c.water), blocked);
	const exits = landHorizonExits(cells);
	const plaza = opts.plazaCell || null;
	const endFor = (from) => plaza ? plaza.reduce((best, v) => (Point.distance(v, from) < Point.distance(best, from) ? v : best), plaza[0]) : center;

	for (const gate of gates) {
		const end = endFor(gate);
		const street = innerTopo.buildPath(gate, end);
		if (street) {
			out.streets.push(street);
			if (exits.length > 0) {
				const sorted = exits
					.filter((v) => outerTopo.pt2node.has(v))
					.sort((a, b) => (b.x * gate.x + b.y * gate.y) / (b.length || 1) - (a.x * gate.x + a.y * gate.y) / (a.length || 1));
				let added = 0;
				for (const ex of sorted) {
					const road = outerTopo.buildPath(ex, gate);
					if (road) {
						out.roads.push(road);
						if (++added >= roadsPerGate) break;
					}
				}
			}
		}
	}

	if (extraInner > 0) {
		const candidates = [];
		for (const [v, node] of innerTopo.pt2node) {
			if (blocked.includes(v) || gates.includes(v)) continue;
			if (node.links.size >= 3) candidates.push(v);
		}
		candidates.sort((a, b) => b.length - a.length);
		for (const v of candidates) {
			if (out.streets.length >= gates.length + extraInner) break;
			const path = innerTopo.buildPath(v, endFor(v));
			if (path && path.length > 2) out.streets.push(path);
		}
	}

	out.arteries = tidyUpRoads(out.streets, out.roads, plaza);
	for (const artery of out.arteries) smoothOpenInPlace(artery, gates, 2);
	return out;
}
