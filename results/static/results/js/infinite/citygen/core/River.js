// River.js — the river/canal, ported from the compiled reference (Canal.createRiver /
// regularRiver / deltaRiver / validateCourse) and the shore smoothing from buildDomains.
//
// The river is an A* path along (non-water) cell EDGES, so it runs along ward boundaries — highly
// integrated, not an overlay. With a coast it's a `deltaRiver` (sea mouth -> inland source); with
// no coast a `regularRiver` (one horizon vertex, through the centre, to the opposite horizon).

import { Random } from './Random.js';
import { Point } from './Point.js';
import { Graph } from './Graph.js';

function norm(x, y) {
	const l = Math.hypot(x, y) || 1;
	return { x: x / l, y: y / l };
}

// directed edges a->b over a set of cells (cells are Polygons / arrays of shared Point vertices)
function directedEdges(cells) {
	const dir = new Map();
	for (const cell of cells)
		for (let i = 0; i < cell.length; i++) {
			const a = cell[i];
			const b = cell[(i + 1) % cell.length];
			let set = dir.get(a);
			if (!set) dir.set(a, (set = new Set()));
			set.add(b);
		}
	return dir;
}

function cellsByVertexMap(cells) {
	const m = new Map();
	for (const cell of cells)
		for (const v of cell) {
			let arr = m.get(v);
			if (!arr) m.set(v, (arr = []));
			arr.push(cell);
		}
	return m;
}

// graph over the edges of `landCells`; A* runs on it
function buildTopology(landCells) {
	const graph = new Graph();
	const node = new Map();
	const node2pt = new Map();
	const getN = (v) => {
		let n = node.get(v);
		if (!n) {
			n = graph.add();
			node.set(v, n);
			node2pt.set(n, v);
		}
		return n;
	};
	for (const cell of landCells)
		for (let i = 0; i < cell.length; i++) {
			const v0 = cell[i];
			const v1 = cell[(i + 1) % cell.length];
			getN(v0).link(getN(v1), Point.distance(v0, v1));
		}
	return { graph, node, node2pt };
}

// buildPath(from, to) -> array of Points (aStar returns goal-first, i.e. [to, …, from])
function makePath(topo) {
	return (from, to) => {
		const a = topo.node.get(from);
		const b = topo.node.get(to);
		if (!a || !b) return null;
		const p = topo.graph.aStar(a, b);
		return p ? p.map((n) => topo.node2pt.get(n)) : null;
	};
}

// vertices on the outer boundary of `cells` (edges with no reverse twin)
function boundaryVertices(dir) {
	const out = new Set();
	for (const [a, set] of dir)
		for (const b of set) {
			if (!(dir.get(b) && dir.get(b).has(a))) {
				out.add(a);
				out.add(b);
			}
		}
	return out;
}

// land-side shore edges (land edge a->b whose twin b->a is a water cell) chained into ordered runs
function shoreChains(dirLand, dirWater) {
	const next = new Map();
	for (const [a, set] of dirLand)
		for (const b of set) if (dirWater.get(b) && dirWater.get(b).has(a)) next.set(a, b);

	const incoming = new Set();
	for (const b of next.values()) incoming.add(b);

	const chains = [];
	const visited = new Set();
	const walk = (start) => {
		const chain = [];
		let cur = start;
		let guard = 0;
		while (cur != null && !visited.has(cur) && guard++ < 100000) {
			chain.push(cur);
			visited.add(cur);
			cur = next.get(cur);
		}
		if (cur != null) chain.push(cur); // closing endpoint
		if (chain.length > 1) chains.push(chain);
	};
	for (const a of next.keys()) if (!incoming.has(a) && !visited.has(a)) walk(a); // open chains first
	for (const a of next.keys()) if (!visited.has(a)) walk(a); // any remaining loops
	return chains;
}

// land cells' boundary vertices that are NOT coast (no twin at all) = the inland horizon
function landHorizonVertices(dirLand) {
	const out = new Set();
	for (const [a, set] of dirLand)
		for (const b of set) if (!(dirLand.get(b) && dirLand.get(b).has(a))) {
			out.add(a);
			out.add(b);
		}
	return out;
}

function validateCourse(course, minLen, shoreSet) {
	if (!course || course.length < minLen) return false;
	if (shoreSet) for (let i = 1; i < course.length - 1; i++) if (shoreSet.has(course[i])) return false;
	return true;
}

// one open-polyline smoothing pass repeated `iterations` times (reference uc.smoothOpen): each
// interior point -> (midpoint(prev,next) + p)/2. Returns NEW {x,y} points.
function smoothCourse(pts, iterations) {
	let a = pts.map((p) => ({ x: p.x, y: p.y }));
	for (let it = 0; it < iterations; it++) {
		a = a.map((g, i) => {
			if (i === 0 || i === a.length - 1) return { x: g.x, y: g.y };
			const p = a[i - 1];
			const n = a[i + 1];
			return { x: ((p.x + n.x) / 2 + g.x) / 2, y: ((p.y + n.y) / 2 + g.y) / 2 };
		});
	}
	return a;
}

// Reference: Sa.set(polyline, uc.smoothOpen(polyline, null, 1)). The course vertices are shared
// with ward polygons, so this pass intentionally mutates the map: wards bend with the canal.
function smoothCourseInPlace(course, iterations) {
	const smoothed = smoothCourse(course, iterations);
	for (let i = 0; i < course.length; i++) course[i].set(smoothed[i]);
}

function regularRiver(cells, center, topo, cbv) {
	const path = makePath(topo);
	const dirAll = directedEdges(cells);
	const horizon = [...boundaryVertices(dirAll)].filter((v) => (cbv.get(v) || []).length > 1);
	const minLen = Math.max(5, Math.floor(horizon.length / 5));

	let candidates = horizon.slice();
	const cnode = topo.node.get(center);
	if (!cnode) return null;

	let guard = 0;
	while (candidates.length > 1 && guard++ < 200) {
		const k = candidates[Math.floor(Random.float() * candidates.length)];
		const kn = norm(k.x, k.y);
		let opp = null;
		let best = Infinity;
		for (const h of candidates) {
			const hn = norm(h.x, h.y);
			const dot = kn.x * hn.x + kn.y * hn.y;
			if (dot < best) {
				best = dot;
				opp = h;
			}
		}
		const neighbours = [...cnode.links.keys()];
		const cn = neighbours.length ? topo.node2pt.get(neighbours[Math.floor(Random.float() * neighbours.length)]) : null;
		if (cn && opp && opp !== k) {
			const a = path(opp, cn); // [cn, …, opp]
			const b = a ? path(cn, k) : null; // [k, …, cn]
			if (a && b) {
				const course = b.concat(a.slice(1)); // [k, …, cn, …, opp]
				if (validateCourse(course, minLen, null)) return { course };
			}
		}
		candidates = candidates.filter((v) => v !== k && v !== opp);
	}
	return null;
}

function deltaRiver(cells, land, topo, cbv) {
	const path = makePath(topo);
	const dirLand = directedEdges(land);
	const dirWater = directedEdges(cells.filter((c) => c.water));

	const chains = shoreChains(dirLand, dirWater);
	if (chains.length === 0) return null;
	const shore = chains.reduce((a, b) => (b.length > a.length ? b : a));
	const shoreSet = new Set(shore);
	const minLen = Math.max(5, Math.floor(shore.length / 2));

	// mouth candidates: interior shore vertices with >1 non-water cell, nearest to centre first
	const mouths = [];
	for (let i = 1; i < shore.length - 1; i++) {
		const v = shore[i];
		if ((cbv.get(v) || []).filter((c) => !c.water).length > 1) mouths.push(i);
	}
	mouths.sort((a, b) => shore[a].length - shore[b].length);

	const sources = [...landHorizonVertices(dirLand)].filter((v) => (cbv.get(v) || []).length > 1);
	if (sources.length === 0) return null;

	for (const ci of mouths) {
		const mouth = shore[ci];
		const t = norm(shore[ci + 1].x - shore[ci - 1].x, shore[ci + 1].y - shore[ci - 1].y);
		const inland = { x: -t.y, y: t.x }; // perpendicular to the shore = inland direction
		let src = null;
		let best = -Infinity;
		for (const h of sources) {
			const d = norm(h.x - mouth.x, h.y - mouth.y);
			const al = inland.x * d.x + inland.y * d.y;
			if (al > best) {
				best = al;
				src = h;
			}
		}
		if (!src) continue;
		const p = path(src, mouth); // [mouth, …, src]
		if (p) {
			if (validateCourse(p, minLen, shoreSet)) return { course: p, mouthIdx: ci, shore };
		}
	}
	return null;
}

function mid(a, b) {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function lerp(a, b, t = 0.5) {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Reference: Canal.new nudges the mouth and the adjacent shore points before smoothing the course.
function shapeDeltaMouthInPlace(course, shore, mouthIdx) {
	if (!course || course.length < 2 || !shore || mouthIdx == null) return;

	const mouth = course[0];
	mouth.set(lerp(mouth, course[1]));

	if (mouthIdx >= 2) {
		const prev = shore[mouthIdx - 1];
		prev.set(lerp(prev, lerp(shore[mouthIdx - 2], mouth)));
	}
	if (mouthIdx < shore.length - 2) {
		const next = shore[mouthIdx + 1];
		next.set(lerp(next, lerp(shore[mouthIdx + 2], mouth)));
	}
}

// Build the delta-mouth geometry (reference: drawMouth). Returns cubic Bézier control
// points for the widening funnel where the river meets the shore.
function buildDelta(course, shore, mouthIdx, width) {
	if (!course || course.length < 2 || !shore || mouthIdx == null) return null;

	const mouth = course[0];
	const next = course[1];

	const dx = next.x - mouth.x;
	const dy = next.y - mouth.y;

	// perpendicular at the MOUTH (not midpoint) — the delta's narrow base must connect
	// to the river stroke's endpoint for a seamless join (no visible step).
	const len = Math.hypot(dx, dy) || 1;
	const hw = width / 2;
	const nx = (-dy / len) * hw;
	const ny = (dx / len) * hw;

	const right = { x: mouth.x + nx, y: mouth.y + ny };
	const left = { x: mouth.x - nx, y: mouth.y - ny };

	// adjacent shore points, lerped toward mouth (reference: qa.lerp(shore[h±1], mouth))
	const sLen = shore.length;
	const prevShore = mid(shore[(mouthIdx + sLen - 1) % sLen], mouth);
	const nextShore = mid(shore[(mouthIdx + 1) % sLen], mouth);

	// Bézier control points — handles extend back along the river direction so the delta's
	// narrow end blends into the river stroke (reference: drawMouth).
	const rightCtrl1 = { x: right.x - dx, y: right.y - dy };
	const rightCtrl2 = mid(prevShore, mouth); // 3/4 toward mouth

	const leftCtrl1 = mid(nextShore, mouth);
	const leftCtrl2 = { x: left.x - dx, y: left.y - dy };

	// convexity at mouth (reference: kf.isConvexVertexi)
	const v0 = shore[(mouthIdx + sLen - 1) % sLen];
	const v1 = shore[mouthIdx];
	const v2 = shore[(mouthIdx + 1) % sLen];
	const isConvex = (v1.x - v0.x) * (v2.y - v1.y) - (v1.y - v0.y) * (v2.x - v1.x) > 0;

	return {
		right, rightCtrl1, rightCtrl2,
		prevShore,
		isConvex,
		mouth: { x: mouth.x, y: mouth.y },
		nextShore,
		leftCtrl1, leftCtrl2,
		left,
	};
}

// public: build the river course for the given cells, or null. `center` is the
// city-centre Point (a land-cell vertex).
//
// Reference pipeline (Canal constructor + updateState):
//   1.  A* along land-cell edges (deltaRiver / regularRiver)
//   2.  Width: (3 + innerCount/5) * (0.8 + rng*0.4) * (rural ? 1.5 : 1)
//   3.  Delta mouth shaping (coastal rivers only)
//   4.  Structural smoothing: smoothCourseInPlace(course, 1)   (= Sa.set + uc.smoothOpen 1 iter)
//   5.  Visual smoothing: Chaikin 3 iter (done by renderer, not here)
//
// Pass opts.innerCells (the city cells) so the width formula can determine
// whether the river is rural (no city-cell vertices on the course).
export function buildRiver(cells, center, opts = {}) {
	const land = cells.filter((c) => !c.water);
	if (land.length < 6 || !center) return null;
	const hasCoast = cells.length !== land.length;

	const topo = buildTopology(land);
	if (!topo.node.get(center)) return null;
	const cbv = cellsByVertexMap(cells);

	const result = hasCoast ? deltaRiver(cells, land, topo, cbv) : regularRiver(cells, center, topo, cbv);
	if (!result) return null;

	// Width — reference: Canal.updateState
	const innerCells = opts.innerCells || [];
	const innerVerts = new Set();
	for (const c of innerCells) for (const v of c) innerVerts.add(v);
	const rural = !result.course.some((v) => innerVerts.has(v));
	const width =
		opts.width != null
			? opts.width
			: (3 + innerCells.length / 5) * (0.8 + Random.float() * 0.4) * (rural ? 1.5 : 1);

	if (result.shore) shapeDeltaMouthInPlace(result.course, result.shore, result.mouthIdx);

	// Structural smoothing — reference: Sa.set(c, smoothOpen(c, null, 1)). This mutates the shared
	// vertices, so the neighbouring ward polygons curve along the river instead of being overlaid.
	smoothCourseInPlace(result.course, 1);

	const delta = result.shore ? buildDelta(result.course, result.shore, result.mouthIdx, width) : null;

	return { course: result.course, width, delta };
}

// ---- shore smoothing (reference buildDomains: Sa.set(waterEdge, uc.smooth(waterEdge,…))) ----
// Smooth the water/land boundary IN PLACE (moves the shared vertices, so both water and land cells
// follow), curving the coastline. Endpoints of each chain are kept fixed.
export function smoothShore(cells, iterations = 2) {
	const dirLand = directedEdges(cells.filter((c) => !c.water));
	const dirWater = directedEdges(cells.filter((c) => c.water));
	const chains = shoreChains(dirLand, dirWater);
	for (const chain of chains) {
		if (chain.length < 4) continue;
		for (let it = 0; it < iterations; it++) {
			const pos = chain.map((g, i) => {
				if (i === 0 || i === chain.length - 1) return { x: g.x, y: g.y };
				const p = chain[i - 1];
				const n = chain[i + 1];
				return { x: ((p.x + n.x) / 2 + g.x) / 2, y: ((p.y + n.y) / 2 + g.y) / 2 };
			});
			for (let i = 0; i < chain.length; i++) {
				chain[i].x = pos[i].x;
				chain[i].y = pos[i].y;
			}
		}
	}
}
