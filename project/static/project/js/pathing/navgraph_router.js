// =============================================================================
// navgraph_router.js — browser/worker port of the WP 2.1 Node harness
// (scripts/navgraph_harness.mjs). Phase 3, WP 3.2.
//
// This is a *faithful* port of the harness's importable, pure functions:
// artifact parsing, sampler/graph state, pair sampling + prefilters, endpoint
// snapping, graph A*, barriers, route options, runtime selection, and
// legality refinement. The Node-specific bits (sharp / fs / node:* imports,
// PNG rendering, CLI/main) are dropped — mask bytes and artifact bytes arrive
// as Uint8Array / ArrayBuffer from the worker instead of the filesystem.
//
// The module is dependency-light and works unchanged in Node (import test) and
// in a browser Worker. Nothing here touches the DOM, `self`, or the network.
//
// Cost model is identical to project/static/project/js/pathing/astar.js and
// project/navgraph.py: step = hypot(dx,dy) * (255 - value); value 0 impassable.
//
// DEFAULT_CONFIG is exported so Phase 5 can tune every threshold in one place.
// =============================================================================

// ------------------------------------------------------------------ constants
export const IMPASSABLE = 0;
export const SUPPORTED_VERSION = 2; // .bin layout with coarse_hitzone (navgraph.py NAVGRAPH_VERSION)
const SQRT2 = Math.SQRT2;

// Default tuning config. Every threshold that Phase 5 may tune lives here so
// callers can override with a single object. Distances are full-res px unless
// noted. Values mirror the harness DEFAULT_CONFIG verbatim.
export const DEFAULT_CONFIG = Object.freeze({
	// --- endpoint cell prefilters (evaluated once when indexing sample cells) --
	clearanceMinPx: 12,        // require coarse_clear >= this (≈3 coarse px)
	terrainMinValue: 140,      // require coarse_minval >= this (excludes very_slow 135/100 + impassable)
	// --- pair prefilters -----------------------------------------------------
	distMinPx: 500,
	distMaxPx: 1500,
	goalSampleTries: 40,       // inner tries to land a goal inside the band
	obstacleMinRunPx: 8,       // straight line must cross this many contiguous impassable px
	// --- endpoint snapping ---------------------------------------------------
	snapMaxDistPx: 200,        // search radius for candidate graph nodes
	snapMaxTargets: 3,         // connect endpoint to at most this many nodes
	snapAstarMargin: 16,       // subgrid margin around the endpoint↔node bbox
	// --- barriers (findSmartBarrier port, scaled to px) ----------------------
	barrierMaxHalfPx: 60,
	barrierStepPx: 2,
	barrierExtendMaxHalfPx: 150,
	barrierMarginPx: 3,
	barrierSlideSamples: 16,
	barrierSlideFraction: 0.05,
	barrierFallbackSamples: 20,
	// --- selection (selectRuntimeRouteOptions port) --------------------------
	sideGapMinPx: 40,          // "sideGap >= 10" equivalent, scaled to px (tune in Phase 5)
	maxRelativeGap: 0.5,       // ROUTE_RUNTIME_MAX_RELATIVE_GAP
	routeAttempts: 4,          // ROUTE_STRESS_ALTERNATE_ATTEMPTS
	// --- balance reject (route-choice difficulty tuning) ---------------------
	// The two served routes are the closest pair in runtime; when they are too
	// close the choice is a coin-flip and does not train route selection. With
	// `balanceRejectProbability` we reject a problem whose (refined) runtime
	// relative gap is within `balanceRejectMaxRelativeGap` and retry, skewing the
	// served distribution toward clearer decisions. Set probability 0 to disable,
	// 1 to remove the band entirely. Mirrors balanceRejectConfig in the city
	// batch worker (results/.../infinite_batch_worker.js) — keep the two in sync.
	balanceRejectMaxRelativeGap: 0.05,
	balanceRejectProbability: 0.5,
});

// =============================================================================
// Artifact loading (browser/Node: from ArrayBuffer/Uint8Array, not fs)
// =============================================================================

/** Copy a little-endian slice of `buf` (Uint8Array) into a fresh (aligned) typed array. */
function sliceTyped(buf, offset, length, Ctor) {
	const bytes = length * Ctor.BYTES_PER_ELEMENT;
	const ab = new ArrayBuffer(bytes);
	new Uint8Array(ab).set(buf.subarray(offset, offset + bytes));
	return new Ctor(ab);
}

/** Read the 4-byte magic as latin1 without Node's Buffer.toString. */
function magic4(buf) {
	return String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
}

/**
 * Parse a `.navgraph.bin` (v2, magic `NVG1`, with `coarse_hitzone`) from an
 * ArrayBuffer or Uint8Array. Returns a plain object with typed arrays + scalar
 * header fields. Mirrors the harness `loadArtifact` parser exactly; rejects
 * non-v2 artifacts with a rebuild hint.
 *
 * @param {ArrayBuffer|Uint8Array} input  raw bytes of the .navgraph.bin
 */
export function loadArtifact(input) {
	const buf = input instanceof Uint8Array
		? input
		: new Uint8Array(input);
	if (buf.length < 52) throw new Error('navgraph artifact too small (truncated header)');
	const magic = magic4(buf);
	if (magic !== 'NVG1') throw new Error(`bad magic ${JSON.stringify(magic)} in navgraph artifact`);
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const version = dv.getUint32(4, true);
	if (version !== SUPPORTED_VERSION)
		throw new Error(`unsupported navgraph version ${version} ` +
			`(need v${SUPPORTED_VERSION}); rebuild with: python manage.py build_navgraph --file <mask> --force`);
	const H = dv.getInt32(8, true);
	const W = dv.getInt32(12, true);
	const minCostPerPx = dv.getFloat32(16, true);
	const N = dv.getUint32(20, true);
	const E = dv.getUint32(24, true);
	const coarseScale = dv.getInt32(28, true);
	const ch = dv.getInt32(32, true);
	const cw = dv.getInt32(36, true);
	const hitzoneScale = dv.getInt32(40, true);
	const hh = dv.getInt32(44, true);
	const hw = dv.getInt32(48, true);

	let off = 52;
	const nodes = sliceTyped(buf, off, N * 2, Int32Array); off += N * 2 * 4;
	const edges = sliceTyped(buf, off, E * 2, Int32Array); off += E * 2 * 4;
	const weights = sliceTyped(buf, off, E, Float32Array); off += E * 4;
	const components = sliceTyped(buf, off, N, Int32Array); off += N * 4;
	const coarseMinval = sliceTyped(buf, off, ch * cw, Uint8Array); off += ch * cw;
	const coarseClear = sliceTyped(buf, off, ch * cw, Uint8Array); off += ch * cw;
	const coarseLabels = sliceTyped(buf, off, ch * cw, Int32Array); off += ch * cw * 4;
	const coarseHitzone = sliceTyped(buf, off, hh * hw, Uint8Array); off += hh * hw;

	return {
		version, H, W, minCostPerPx, N, E,
		coarseScale, ch, cw, hitzoneScale, hh, hw,
		nodes, edges, weights, components,
		coarseMinval, coarseClear, coarseLabels, coarseHitzone,
	};
}

// =============================================================================
// Full-res weighted A* on a subgrid (port of navgraph.py _astar_subgrid)
// =============================================================================

// Reusable binary min-heap of (priority, payload) — small, allocation-light.
export class MinHeap {
	constructor() { this.k = []; this.v = []; }
	get size() { return this.k.length; }
	push(key, val) {
		const k = this.k, v = this.v;
		let i = k.length; k.push(key); v.push(val);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (k[p] <= k[i]) break;
			[k[p], k[i]] = [k[i], k[p]];
			[v[p], v[i]] = [v[i], v[p]];
			i = p;
		}
	}
	pop() {
		const k = this.k, v = this.v, n = k.length;
		const top = v[0];
		const lk = k.pop(), lv = v.pop();
		if (n > 1) {
			k[0] = lk; v[0] = lv;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1, r = l + 1;
				let m = i;
				if (l < k.length && k[l] < k[m]) m = l;
				if (r < k.length && k[r] < k[m]) m = r;
				if (m === i) break;
				[k[m], k[i]] = [k[i], k[m]];
				[v[m], v[i]] = [v[i], v[m]];
				i = m;
			}
		}
		return top;
	}
}

/**
 * Weighted 8-connected A* on a subgrid extracted from `mask`. Coordinates are
 * full-res. `subX0,subY0,subW,subH` describe the window (clamped by caller).
 * Returns { cost, geom, path } (path = [{x,y}...] full-res) or null.
 * `wantPath=false` skips reconstruction (snap cost queries).
 */
export function astarSubgrid(mask, W, subX0, subY0, subW, subH, sx, sy, gx, gy, wantPath = false, maxExpansions = 200000) {
	const lsx = sx - subX0, lsy = sy - subY0, lgx = gx - subX0, lgy = gy - subY0;
	if (lsx < 0 || lsy < 0 || lgx < 0 || lgy < 0 || lsx >= subW || lsy >= subH || lgx >= subW || lgy >= subH)
		return null;
	const at = (lx, ly) => mask[(subY0 + ly) * W + (subX0 + lx)];
	if (at(lsx, lsy) === IMPASSABLE || at(lgx, lgy) === IMPASSABLE) return null;
	const n = subW * subH;
	const g = new Float32Array(n).fill(Infinity);
	const parent = wantPath ? new Int32Array(n).fill(-1) : null;
	const closed = new Uint8Array(n);
	const startI = lsy * subW + lsx, goalI = lgy * subW + lgx;
	g[startI] = 0;
	const geom = new Float32Array(n);
	const heap = new MinHeap();
	heap.push(Math.hypot(lgx - lsx, lgy - lsy), startI);
	let expansions = 0;
	while (heap.size > 0) {
		const cur = heap.pop();
		if (closed[cur]) continue;
		closed[cur] = 1;
		if (cur === goalI) {
			let pathOut = null;
			if (wantPath) {
				const rev = [];
				let p = cur;
				while (p !== -1) { rev.push(p); if (p === startI) break; p = parent[p]; }
				pathOut = [];
				for (let i = rev.length - 1; i >= 0; i--) {
					const px = rev[i] % subW, py = (rev[i] - px) / subW;
					pathOut.push({ x: subX0 + px, y: subY0 + py });
				}
			}
			return { cost: g[cur], geom: geom[cur], path: pathOut };
		}
		if (++expansions > maxExpansions) return null;
		const cx = cur % subW, cy = (cur - cx) / subW;
		const gc = g[cur], gm = geom[cur];
		for (let d = 0; d < 8; d++) {
			const dx = (d < 3 ? -1 : d < 5 ? 0 : 1);
			const dy = [-1, 0, 1, -1, 1, -1, 0, 1][d];
			const nx = cx + dx, ny = cy + dy;
			if (nx < 0 || ny < 0 || nx >= subW || ny >= subH) continue;
			const ni = ny * subW + nx;
			if (closed[ni]) continue;
			const val = mask[(subY0 + ny) * W + (subX0 + nx)];
			if (val === IMPASSABLE) continue;
			const step = (dx !== 0 && dy !== 0) ? SQRT2 : 1;
			const tentative = gc + step * (255 - val);
			if (tentative < g[ni]) {
				g[ni] = tentative;
				geom[ni] = gm + step;
				if (parent) parent[ni] = cur;
				heap.push(tentative + Math.hypot(lgx - nx, lgy - ny), ni);
			}
		}
	}
	return null;
}

/** Terrain-weighted cost of the straight segment, or null if it crosses
 *  impassable. Also usable as a legality raycast (null == blocked). */
export function lineCost(mask, W, x0, y0, x1, y1) {
	const dx = x1 - x0, dy = y1 - y0;
	const steps = Math.max(Math.abs(dx), Math.abs(dy)) | 0;
	if (steps === 0) return 0;
	const seg = Math.hypot(dx, dy) / steps;
	const sx = dx / steps, sy = dy / steps;
	let cost = 0;
	for (let k = 1; k <= steps; k++) {
		const xi = Math.round(x0 + sx * k), yi = Math.round(y0 + sy * k);
		const val = mask[yi * W + xi];
		if (val === IMPASSABLE) return null;
		cost += seg * (255 - val);
	}
	return cost;
}

// =============================================================================
// Sampler / graph state (built once per mask)
// =============================================================================

/**
 * Precompute everything reused across attempts: main free component, the list
 * of sampleable coarse cells (inside the hit zone, on the main component, with
 * clearance/terrain ok), a node bucket grid for snapping, and CSR adjacency.
 */
export function buildState(artifact, mask, config = DEFAULT_CONFIG) {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const { N, E, ch, cw, coarseScale, hitzoneScale, coarseLabels, coarseMinval,
		coarseClear, coarseHitzone, hh, hw, nodes, edges, weights } = artifact;

	// Main free component = most frequent nonzero label in coarse_labels.
	let maxLabel = 0;
	for (let i = 0; i < coarseLabels.length; i++) if (coarseLabels[i] > maxLabel) maxLabel = coarseLabels[i];
	const counts = new Int32Array(maxLabel + 1);
	for (let i = 0; i < coarseLabels.length; i++) counts[coarseLabels[i]]++;
	let mainComp = 0, best = 0;
	for (let l = 1; l <= maxLabel; l++) if (counts[l] > best) { best = counts[l]; mainComp = l; }

	// Sampleable coarse cells (store as flat index into ch*cw grid).
	const sampleCells = [];
	for (let cy = 0; cy < ch; cy++) {
		for (let cx = 0; cx < cw; cx++) {
			const ci = cy * cw + cx;
			if (coarseLabels[ci] !== mainComp) continue;
			if (coarseClear[ci] < cfg.clearanceMinPx) continue;
			if (coarseMinval[ci] < cfg.terrainMinValue) continue;
			const hy = Math.floor((cy * coarseScale) / hitzoneScale);
			const hx = Math.floor((cx * coarseScale) / hitzoneScale);
			if (hy >= hh || hx >= hw || !coarseHitzone[hy * hw + hx]) continue;
			sampleCells.push(ci);
		}
	}

	// Node bucket grid for snapping (cell = snapMaxDistPx).
	const cell = Math.max(1, cfg.snapMaxDistPx);
	const buckets = new Map();
	for (let i = 0; i < N; i++) {
		const bx = Math.floor(nodes[2 * i] / cell), by = Math.floor(nodes[2 * i + 1] / cell);
		const key = bx * 100003 + by;
		let arr = buckets.get(key);
		if (!arr) { arr = []; buckets.set(key, arr); }
		arr.push(i);
	}

	// CSR adjacency (undirected).
	const deg = new Int32Array(N);
	for (let e = 0; e < E; e++) { deg[edges[2 * e]]++; deg[edges[2 * e + 1]]++; }
	const adjStart = new Int32Array(N + 1);
	for (let i = 0; i < N; i++) adjStart[i + 1] = adjStart[i] + deg[i];
	const adjTo = new Int32Array(adjStart[N]);
	const adjW = new Float32Array(adjStart[N]);
	const adjEdge = new Int32Array(adjStart[N]); // originating edge index (for barrier blocking)
	const fill = adjStart.slice(0, N);
	for (let e = 0; e < E; e++) {
		const u = edges[2 * e], v = edges[2 * e + 1], w = weights[e];
		adjTo[fill[u]] = v; adjW[fill[u]] = w; adjEdge[fill[u]] = e; fill[u]++;
		adjTo[fill[v]] = u; adjW[fill[v]] = w; adjEdge[fill[v]] = e; fill[v]++;
	}

	return {
		artifact, mask, cfg, mainComp, sampleCells,
		buckets, bucketCell: cell,
		adjStart, adjTo, adjW, adjEdge,
	};
}

// =============================================================================
// 1. Pair sampling + prefilters
// =============================================================================

/** mulberry32 seeded RNG → () => float in [0,1). */
export function makeRng(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Random passable full-res pixel inside coarse cell `ci`, or null. */
function pixelInCell(state, ci, rng) {
	const { artifact, mask } = state;
	const { cw, coarseScale, W, H } = artifact;
	const cx = ci % cw, cy = (ci - cx) / cw;
	const x0 = cx * coarseScale, y0 = cy * coarseScale;
	// Try a few random pixels; fall back to a scan for a passable one.
	for (let t = 0; t < 6; t++) {
		const px = Math.min(W - 1, x0 + (rng() * coarseScale | 0));
		const py = Math.min(H - 1, y0 + (rng() * coarseScale | 0));
		if (mask[py * W + px] !== IMPASSABLE) return { x: px, y: py };
	}
	for (let dy = 0; dy < coarseScale; dy++) {
		for (let dx = 0; dx < coarseScale; dx++) {
			const px = x0 + dx, py = y0 + dy;
			if (px < W && py < H && mask[py * W + px] !== IMPASSABLE) return { x: px, y: py };
		}
	}
	return null;
}

/** Straight line crosses a substantial obstacle? (max contiguous impassable run). */
export function crossesObstacle(mask, W, a, b, minRunPx) {
	const dx = b.x - a.x, dy = b.y - a.y;
	const steps = Math.max(Math.abs(dx), Math.abs(dy)) | 0;
	if (steps === 0) return false;
	const sx = dx / steps, sy = dy / steps;
	let run = 0, maxRun = 0;
	for (let k = 1; k <= steps; k++) {
		const xi = Math.round(a.x + sx * k), yi = Math.round(a.y + sy * k);
		if (mask[yi * W + xi] === IMPASSABLE) { if (++run > maxRun) maxRun = run; }
		else run = 0;
	}
	return maxRun >= minRunPx;
}

/**
 * Sample one endpoint pair. Returns { start, goal, dist } on success, or
 * { reason } ('empty' | 'distance' | 'obstacle') on a prefilter reject.
 */
export function samplePair(state, rng) {
	const { sampleCells, artifact, mask, cfg } = state;
	const { W } = artifact;
	if (sampleCells.length < 2) return { reason: 'empty' };
	const start = pixelInCell(state, sampleCells[(rng() * sampleCells.length) | 0], rng);
	if (!start) return { reason: 'empty' };
	// Sample a goal inside the distance band.
	let goal = null, dist = 0;
	for (let t = 0; t < cfg.goalSampleTries; t++) {
		const g = pixelInCell(state, sampleCells[(rng() * sampleCells.length) | 0], rng);
		if (!g) continue;
		const d = Math.hypot(g.x - start.x, g.y - start.y);
		if (d >= cfg.distMinPx && d <= cfg.distMaxPx) { goal = g; dist = d; break; }
	}
	if (!goal) return { reason: 'distance' };
	if (!crossesObstacle(mask, W, start, goal, cfg.obstacleMinRunPx)) return { reason: 'obstacle' };
	return { start, goal, dist };
}

// =============================================================================
// 2. Endpoint snapping
// =============================================================================

/**
 * Connect a full-res endpoint to <=snapMaxTargets nearest graph nodes via local
 * full-res weighted A* stubs. Returns [{ node, w }...] (may be empty → caller
 * treats as an un-snappable endpoint).
 */
export function snapEndpoint(state, pt) {
	const { artifact, mask, cfg, buckets, bucketCell } = state;
	const { nodes, W, H } = artifact;
	const bx = Math.floor(pt.x / bucketCell), by = Math.floor(pt.y / bucketCell);
	const cand = [];
	for (let gx = bx - 1; gx <= bx + 1; gx++) {
		for (let gy = by - 1; gy <= by + 1; gy++) {
			const arr = buckets.get(gx * 100003 + gy);
			if (!arr) continue;
			for (const ni of arr) {
				const nx = nodes[2 * ni], ny = nodes[2 * ni + 1];
				const d = Math.hypot(nx - pt.x, ny - pt.y);
				if (d <= cfg.snapMaxDistPx) cand.push({ node: ni, d });
			}
		}
	}
	cand.sort((p, q) => p.d - q.d);
	const out = [];
	for (const c of cand) {
		if (out.length >= cfg.snapMaxTargets) break;
		const nx = nodes[2 * c.node], ny = nodes[2 * c.node + 1];
		// Fast path: straight-line legal → use its cost directly.
		let cost = lineCost(mask, W, pt.x, pt.y, nx, ny);
		if (cost === null) {
			const m = cfg.snapAstarMargin;
			const x0 = Math.max(0, Math.min(pt.x, nx) - m), y0 = Math.max(0, Math.min(pt.y, ny) - m);
			const x1 = Math.min(W, Math.max(pt.x, nx) + m + 1), y1 = Math.min(H, Math.max(pt.y, ny) + m + 1);
			const res = astarSubgrid(mask, W, x0, y0, x1 - x0, y1 - y0, pt.x, pt.y, nx, ny, false);
			if (!res) continue;
			cost = res.cost;
		}
		out.push({ node: c.node, w: cost });
	}
	return out;
}

// =============================================================================
// 3. Graph A* (endpoints as virtual nodes N and N+1)
// =============================================================================

/**
 * A* over the navgraph. `goalPt` is the full-res goal coordinate (for the
 * euclidean heuristic). `startSnap`/`goalSnap` are [{node,w}...]. `blockedEdges`
 * (optional Set of edge indices) are skipped. Returns { nodePath:[ids...], cost }
 * or null. Virtual ids: start = N, goal = N+1.
 */
export function graphAstar(state, goalPt, startSnap, goalSnap, blockedEdges) {
	const { artifact, adjStart, adjTo, adjW, adjEdge } = state;
	const { N, nodes, minCostPerPx } = artifact;
	const START = N, GOAL = N + 1, TOTAL = N + 2;
	const goalX = goalPt.x, goalY = goalPt.y;
	const g = new Float32Array(TOTAL).fill(Infinity);
	const parent = new Int32Array(TOTAL).fill(-1);
	const closed = new Uint8Array(TOTAL);
	// Incoming goal edges: map node -> weight.
	const goalFrom = new Map();
	for (const s of goalSnap) goalFrom.set(s.node, s.w);
	const heap = new MinHeap();
	g[START] = 0;
	heap.push(0, START);
	const hEuclid = (nx, ny) => Math.hypot(goalX - nx, goalY - ny) * minCostPerPx;
	while (heap.size > 0) {
		const cur = heap.pop();
		if (closed[cur]) continue;
		closed[cur] = 1;
		if (cur === GOAL) {
			const nodePath = [];
			let p = cur;
			while (p !== -1) { nodePath.push(p); p = parent[p]; }
			nodePath.reverse();
			return { nodePath, cost: g[GOAL] };
		}
		const gc = g[cur];
		if (cur === START) {
			for (const s of startSnap) relax(s.node, gc + s.w, cur);
		} else {
			// real node: graph neighbours + optional goal edge
			const s0 = adjStart[cur], s1 = adjStart[cur + 1];
			for (let e = s0; e < s1; e++) {
				if (blockedEdges && blockedEdges.has(adjEdge[e])) continue;
				relax(adjTo[e], gc + adjW[e], cur);
			}
			if (goalFrom.has(cur)) relax(GOAL, gc + goalFrom.get(cur), cur);
		}
	}
	return null;

	function relax(to, tentative, from) {
		if (closed[to] || tentative >= g[to]) return;
		g[to] = tentative; parent[to] = from;
		let hx = 0;
		if (to !== GOAL) { hx = hEuclid(nodes[2 * to], nodes[2 * to + 1]); }
		heap.push(tentative + hx, to);
	}
}

/** Convert a node-id path (with virtual START/GOAL) to a coord polyline. */
function nodePathToCoords(state, nodePath, start, goal) {
	const { artifact } = state;
	const { N, nodes } = artifact;
	const pts = [];
	for (const id of nodePath) {
		if (id === N) pts.push({ x: start.x, y: start.y });
		else if (id === N + 1) pts.push({ x: goal.x, y: goal.y });
		else pts.push({ x: nodes[2 * id], y: nodes[2 * id + 1] });
	}
	return pts;
}

// =============================================================================
// 4. Barriers (port of RoutePlanner.findSmartBarrier, scaled to px)
// =============================================================================

export function routePathLength(path) {
	let len = 0;
	for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
	return len;
}

/** Impassable-pixel test at a real-valued point (rounded). */
function inObstacle(mask, W, H, x, y) {
	const xi = Math.round(x), yi = Math.round(y);
	if (xi < 0 || yi < 0 || xi >= W || yi >= H) return true; // off-mask == wall
	return mask[yi * W + xi] === IMPASSABLE;
}

/**
 * Find a perpendicular barrier near the route midpoint anchored in obstacles on
 * both sides. Returns { ax, ay, bx, by } (segment endpoints) or null. Faithful
 * port of the city-gen findSmartBarrier structure with px-scaled constants and
 * impassable-pixel probing instead of polygon obstacles.
 */
export function findBarrier(path, mask, W, H, cfg) {
	const total = routePathLength(path);
	if (total < 1e-6) return null;
	const MAX_HALF = cfg.barrierMaxHalfPx, STEP = cfg.barrierStepPx;
	const MARGIN = cfg.barrierMarginPx, EXTEND_MAX_HALF = cfg.barrierExtendMaxHalfPx;
	const CENTER = 0.5;

	const probe = (frac) => {
		const targetLen = total * frac;
		let accum = 0;
		for (let i = 1; i < path.length; i++) {
			const segLen = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
			if (accum + segLen >= targetLen) {
				const t = (targetLen - accum) / (segLen || 1);
				const mx = path[i - 1].x + (path[i].x - path[i - 1].x) * t;
				const my = path[i - 1].y + (path[i].y - path[i - 1].y) * t;
				const norm = segLen || 1;
				const px = -(path[i].y - path[i - 1].y) / norm;
				const py = (path[i].x - path[i - 1].x) / norm;
				let leftDist = MAX_HALF, rightDist = MAX_HALF, leftHit = false, rightHit = false;
				for (let d = STEP; d <= MAX_HALF; d += STEP)
					if (inObstacle(mask, W, H, mx + px * d, my + py * d)) { leftDist = d; leftHit = true; break; }
				for (let d = STEP; d <= MAX_HALF; d += STEP)
					if (inObstacle(mask, W, H, mx - px * d, my - py * d)) { rightDist = d; rightHit = true; break; }
				return { frac, mx, my, px, py, leftDist, rightDist, leftHit, rightHit };
			}
			accum += segLen;
		}
		return null;
	};
	const extend = (p, sign, dist, hit) => {
		if (hit) return dist;
		for (let d = dist + STEP; d <= EXTEND_MAX_HALF; d += STEP)
			if (inObstacle(mask, W, H, p.mx + sign * p.px * d, p.my + sign * p.py * d)) return d;
		return dist;
	};
	const wallAt = (p) => {
		const l = extend(p, 1, p.leftDist, p.leftHit), r = extend(p, -1, p.rightDist, p.rightHit);
		return {
			ax: p.mx + p.px * (l + MARGIN), ay: p.my + p.py * (l + MARGIN),
			bx: p.mx - p.px * (r + MARGIN), by: p.my - p.py * (r + MARGIN),
		};
	};

	let bestEnclosed = null, bestEnclosedScore = Infinity, bestFallback = null, bestFallbackScore = Infinity;
	const minFrac = Math.max(0, CENTER - cfg.barrierSlideFraction), maxFrac = Math.min(1, CENTER + cfg.barrierSlideFraction);
	for (let s = 0; s <= cfg.barrierSlideSamples; s++) {
		const frac = minFrac + (maxFrac - minFrac) * (s / cfg.barrierSlideSamples);
		const p = probe(frac);
		if (!p) continue;
		const width = p.leftDist + p.rightDist, pen = Math.abs(frac - CENTER) * 1e-3;
		if (p.leftHit && p.rightHit && width + pen < bestEnclosedScore) { bestEnclosedScore = width + pen; bestEnclosed = p; }
		if (width + pen < bestFallbackScore) { bestFallbackScore = width + pen; bestFallback = p; }
	}
	if (bestEnclosed) return wallAt(bestEnclosed);

	// Broader fallback window (0.25..0.75).
	let broad = null, broadScore = Infinity;
	for (let s = 0; s <= cfg.barrierFallbackSamples; s++) {
		const frac = 0.25 + 0.5 * (s / cfg.barrierFallbackSamples);
		const p = probe(frac);
		if (!p) continue;
		if (p.leftHit && p.rightHit) { const sc = Math.abs(frac - CENTER); if (sc < broadScore) { broadScore = sc; broad = p; } }
	}
	const pick = broad || bestFallback;
	return pick ? wallAt(pick) : null;
}

/** Segment-segment proper/touching intersection test. */
function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
	const o = (px, py, qx, qy, rx, ry) => {
		const val = (qy - py) * (rx - qx) - (qx - px) * (ry - qy);
		return val > 1e-9 ? 1 : val < -1e-9 ? -1 : 0;
	};
	const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy);
	const o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
	return o1 !== o2 && o3 !== o4;
}

/** Edge indices whose node-node segment crosses any active barrier. */
function blockedByBarriers(state, barriers) {
	const { artifact } = state;
	const { E, edges, nodes } = artifact;
	const blocked = new Set();
	if (!barriers.length) return blocked;
	for (let e = 0; e < E; e++) {
		const u = edges[2 * e], v = edges[2 * e + 1];
		const ux = nodes[2 * u], uy = nodes[2 * u + 1], vx = nodes[2 * v], vy = nodes[2 * v + 1];
		for (const b of barriers) {
			if (segIntersect(ux, uy, vx, vy, b.ax, b.ay, b.bx, b.by)) { blocked.add(e); break; }
		}
	}
	return blocked;
}

// =============================================================================
// computeRouteOptions — up to 4 routes with barrier-forced alternates
// =============================================================================

/** Signature to dedupe identical node paths. */
function pathSignature(nodePath) { return nodePath.join(','); }

/**
 * Produce up to cfg.routeAttempts routes for a snapped pair. Returns
 * { paths:[{path, nodePath, len, cost}], reason }. `paths` empty/1 → reason set.
 */
export function computeRouteOptions(state, start, goal, startSnap, goalSnap) {
	const { cfg, artifact, mask } = state;
	const { W, H } = artifact;
	const barriers = [];
	const paths = [];
	const seen = new Set();
	for (let attempt = 0; attempt < cfg.routeAttempts; attempt++) {
		const blocked = blockedByBarriers(state, barriers);
		const res = graphAstar(state, goal, startSnap, goalSnap, blocked);
		if (!res || res.nodePath.length < 2) break;
		const sig = pathSignature(res.nodePath);
		if (seen.has(sig)) break; // barrier didn't change the route
		seen.add(sig);
		const coords = nodePathToCoords(state, res.nodePath, start, goal);
		paths.push({ path: coords, nodePath: res.nodePath, len: routePathLength(coords), cost: res.cost });
		if (attempt >= cfg.routeAttempts - 1) break;
		const barrier = findBarrier(coords, mask, W, H, cfg);
		if (!barrier) break;
		barriers.push(barrier);
	}
	let reason = 'ok';
	if (paths.length === 0) reason = 'unreachable';
	else if (paths.length === 1) reason = 'distinct';
	return { paths, barriers, reason };
}

// =============================================================================
// 5. Selection (port of infinite_play.selectRuntimeRouteOptions)
// =============================================================================

/**
 * Select the two routes to serve. Graph cost is used directly as runtime
 * (no NoA). Returns { ok, reason, selected:[a,b]|null, paths, ... }.
 */
export function selectRuntimeRouteOptions(pair, routeResult, cfg = DEFAULT_CONFIG) {
	const paths = routeResult.paths.map((p) => ({ ...p, run_time: p.cost }));
	if (paths.length === 0) return { ok: false, reason: routeResult.reason || 'unreachable', paths };
	if (paths.length === 1) return { ok: false, reason: 'distinct', paths };

	const sgDx = pair.goal.x - pair.start.x, sgDy = pair.goal.y - pair.start.y;
	const sgLen = Math.hypot(sgDx, sgDy) || 1;
	for (const p of paths) {
		let sum = 0;
		for (const pt of p.path) sum += sgDx * (pt.y - pair.start.y) - sgDy * (pt.x - pair.start.x);
		p.side = (sum / p.path.length) / sgLen;
		p.sideLabel = p.side > 0 ? 'R' : p.side < 0 ? 'L' : 'C';
	}
	paths.sort((a, b) => a.run_time - b.run_time);

	const pairs = [];
	for (let i = 0; i < paths.length; i++) {
		for (let j = i + 1; j < paths.length; j++) {
			const a = paths[i], b = paths[j];
			const faster = Math.min(a.run_time, b.run_time), slower = Math.max(a.run_time, b.run_time);
			pairs.push({
				i, j,
				relativeGap: faster > 0 ? (slower - faster) / faster : Infinity,
				absGap: slower - faster,
				total: a.run_time + b.run_time,
				sideGap: Math.abs(a.side - b.side),
			});
		}
	}
	pairs.sort((a, b) => a.relativeGap - b.relativeGap || a.absGap - b.absGap || a.total - b.total);

	const sideValid = pairs.filter((p) => p.sideGap >= cfg.sideGapMinPx && paths[p.i].side * paths[p.j].side < 0);
	const bestPair = sideValid[0];
	if (!bestPair) return { ok: false, reason: 'side', paths };
	const selected = [paths[bestPair.i], paths[bestPair.j]];
	const routeSideMin = bestPair.sideGap / 4;
	if (selected.some((p) => Math.abs(p.side) < routeSideMin)) return { ok: false, reason: 'routeside', paths };
	if (bestPair.relativeGap > cfg.maxRelativeGap) return { ok: false, reason: 'runtime', paths };
	return { ok: true, reason: 'ok', selected, paths, relativeGap: bestPair.relativeGap, sideGap: bestPair.sideGap };
}

// =============================================================================
// Legality refinement — make a graph route's geometry a legal full-res polyline
// (harness stand-in for theta*; already validated in Phase 2, zero violations).
// =============================================================================

/**
 * Return a legal full-res polyline for a route: each straight node-node segment
 * that crosses impassable pixels is replaced by a local A* pixel walk. Segments
 * that are already straight-legal are kept as-is.
 *
 * Also returns the terrain-weighted cost of the refined polyline: for kept
 * straight segments the `lineCost`, for A*-refined segments the A* `cost`.
 * These per-segment costs are what the caller sums to recompute the served
 * runtime (plan.md requires the gap re-check against the refined route).
 *
 * @returns {{ path: Array<{x,y}>, cost: number }}
 */
export function refineRouteLegal(state, path) {
	const { mask, artifact } = state;
	const { W, H } = artifact;
	const out = [{ x: path[0].x, y: path[0].y }];
	let cost = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i];
		const straight = lineCost(mask, W, a.x, a.y, b.x, b.y);
		if (straight !== null) { out.push({ x: b.x, y: b.y }); cost += straight; continue; }
		// Margin grows with the segment span so long bridge edges have room to
		// detour; the floor (48) exceeds the builder's own skeleton-backbone A*
		// margin (EDGE_SKELETON_MARGIN=40 in navgraph.py) so any edge the builder
		// validated can be reproduced here — a smaller box would fail on a short
		// backbone edge and leave an illegal straight segment.
		const span = Math.hypot(b.x - a.x, b.y - a.y);
		const m = Math.min(160, Math.max(48, Math.round(0.75 * span)));
		const x0 = Math.max(0, Math.min(a.x, b.x) - m), y0 = Math.max(0, Math.min(a.y, b.y) - m);
		const x1 = Math.min(W, Math.max(a.x, b.x) + m + 1), y1 = Math.min(H, Math.max(a.y, b.y) + m + 1);
		const res = astarSubgrid(mask, W, x0, y0, x1 - x0, y1 - y0, a.x, a.y, b.x, b.y, true, 1500000);
		if (res && res.path) {
			for (let k = 1; k < res.path.length; k++) out.push(res.path[k]);
			cost += res.cost;
		} else {
			// Should not happen for graph edges; keep straight (legality flags it).
			out.push({ x: b.x, y: b.y });
			// Approximate cost so the runtime isn't understated on the (rare) fail.
			cost += span * 255;
		}
	}
	return { path: out, cost };
}

/** Sample a polyline at ~1px and count impassable hits (legality assertion). */
export function countLegalityViolations(state, path) {
	const { mask, artifact } = state;
	const { W } = artifact;
	let hits = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i];
		const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) | 0;
		for (let k = 0; k <= steps; k++) {
			const xi = Math.round(a.x + (b.x - a.x) * (k / (steps || 1)));
			const yi = Math.round(a.y + (b.y - a.y) * (k / (steps || 1)));
			if (mask[yi * W + xi] === IMPASSABLE) hits++;
		}
	}
	return hits;
}

// =============================================================================
// generateOnePair — bounded attempt loop returning the FIRST valid, refined
// pair (worker-facing; never hangs). This is the WP 3.2 analogue of the
// harness `generatePairs`, but stops at the first accepted pair, refines its
// two routes to legal full-res polylines, recomputes runtime from the refined
// geometry, and re-checks the relative gap (re-reject if now > maxRelativeGap).
// =============================================================================

/**
 * Attempt to produce one valid, refined pair.
 *
 * @param {object}   state  from buildState()
 * @param {object}   opts
 * @param {Function} opts.rng          seeded/unseeded () => [0,1)
 * @param {number}   opts.maxAttempts  hard cap so the worker never hangs
 * @param {Function} [opts.now]        clock (defaults to Date.now)
 * @returns {{
 *   ok: boolean,
 *   start?: {x,y}, goal?: {x,y},
 *   routes?: [Array<{x,y}>, Array<{x,y}>],   // refined, ordered by side (L then R)
 *   runtimes?: [number, number],             // refined terrain-weighted costs
 *   meta?: { retries, attempts, sideGap, relGap, legality, timings },
 *   reason?: string
 * }}
 */
export function generateOnePair(state, { rng, maxAttempts = 4000, now } = {}) {
	rng = rng || makeRng((Math.random() * 0xffffffff) >>> 0);
	const clock = now || (typeof performance !== 'undefined' && performance.now
		? () => performance.now()
		: () => Date.now());
	const cfg = state.cfg;
	let attempts = 0;
	let retries = 0; // consecutive non-accepted attempts before the accepted one
	let lastReason = 'none';
	const timings = { sample: 0, snap: 0, route: 0, refine: 0 };

	for (; attempts < maxAttempts; attempts++) {
		const t0 = clock();
		const sp = samplePair(state, rng);
		if (sp.reason) { timings.sample += clock() - t0; lastReason = sp.reason; retries++; continue; }
		const tSample = clock(); timings.sample += tSample - t0;

		const startSnap = snapEndpoint(state, sp.start);
		const goalSnap = snapEndpoint(state, sp.goal);
		const tSnap = clock(); timings.snap += tSnap - tSample;
		if (!startSnap.length || !goalSnap.length) { lastReason = 'snap'; retries++; continue; }

		const routeResult = computeRouteOptions(state, sp.start, sp.goal, startSnap, goalSnap);
		const sel = selectRuntimeRouteOptions(sp, routeResult, cfg);
		const tRoute = clock(); timings.route += tRoute - tSnap;
		if (!sel.ok) { lastReason = sel.reason; retries++; continue; }

		// Order the two selected routes by side (L negative first, R positive).
		const ordered = sel.selected.slice().sort((x, y) => x.side - y.side);
		// Refine both to legal full-res polylines + recompute runtime from them.
		const tRef0 = clock();
		const refA = refineRouteLegal(state, ordered[0].path);
		const refB = refineRouteLegal(state, ordered[1].path);
		timings.refine += clock() - tRef0;

		// Re-check the relative gap on the *refined* runtimes (plan.md).
		const rtA = refA.cost, rtB = refB.cost;
		const faster = Math.min(rtA, rtB), slower = Math.max(rtA, rtB);
		const relGap = faster > 0 ? (slower - faster) / faster : Infinity;
		if (relGap > cfg.maxRelativeGap) { lastReason = 'runtime_refined'; retries++; continue; }

		// Balance reject: too-close routes are a coin-flip choice — drop them
		// with cfg.balanceRejectProbability and retry (see DEFAULT_CONFIG).
		if (relGap <= cfg.balanceRejectMaxRelativeGap && rng() < cfg.balanceRejectProbability) {
			lastReason = 'balanced'; retries++; continue;
		}

		const legality = countLegalityViolations(state, refA.path) + countLegalityViolations(state, refB.path);

		return {
			ok: true,
			start: sp.start,
			goal: sp.goal,
			routes: [refA.path, refB.path],
			runtimes: [rtA, rtB],
			meta: {
				retries,
				attempts: attempts + 1,
				sideGap: sel.sideGap,
				relGap,
				legality,
				timings: {
					sample: +timings.sample.toFixed(2),
					snap: +timings.snap.toFixed(2),
					route: +timings.route.toFixed(2),
					refine: +timings.refine.toFixed(2),
				},
			},
		};
	}
	return { ok: false, reason: lastReason, meta: { retries, attempts } };
}
