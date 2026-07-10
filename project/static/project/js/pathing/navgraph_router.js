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

// refine_theta.js is same-dir (works in Node + worker). The import is circular
// (refine_theta imports refineRouteLegal/countLegalityViolations/lineCost from
// here) but only used inside function bodies, so ES-module live bindings resolve
// it lazily at call time — safe in both Node and the browser.
import { refineRouteTheta, countBarrierViolations } from './refine_theta.js';
import { guidedThetaStar } from './theta_star.js';
import { corridorMask, applyCorridor } from './preprocess.js';
import { simplifyAStarSameTerrainPath, simplifyThetaPath } from './simplify.js';
import { normalizePassagesForRuntime } from './passage_geometry.js';
import {
	buildPassageOverlay, blockedDynamicEdges, nodePathToTypedRoute,
	overlayNodeCoord, passageRevision,
} from './navgraph_passage_overlay.js';

// ------------------------------------------------------------------ constants
export const IMPASSABLE = 0;
export const SUPPORTED_VERSION = 2; // .bin layout with coarse_hitzone (navgraph.py NAVGRAPH_VERSION)
const SQRT2 = Math.SQRT2;

// Shared barrier ENFORCEMENT width in mask px (WP 5.2/5.3 single source of
// truth). Used by (a) refine_theta's subgrid rasterisation, (b) the
// countBarrierViolations legality band and (c) the isClearOfRouteNodes gate in
// findBarrier. The purple bar the player sees is drawn separately by
// drawRouteBlocks at BLOCKING_STROKE_WIDTH.
//
// Normal play draws blocking marks 5 editor px wide. At the pathing mask's
// 0.710 lift scale that is round(5 / 0.710) = 7 full-resolution mask px. This
// is also safely above the minimum watertight stamp width of 3 measured during
// WP 5.3. Defined here because refine_theta imports and re-exports it.
export const BARRIER_DRAW_WIDTH_MASK_PX = 7;

// Default tuning config. Every threshold that Phase 5 may tune lives here so
// callers can override with a single object. Distances are full-res px unless
// noted. Values mirror the harness DEFAULT_CONFIG verbatim.
export const DEFAULT_CONFIG = Object.freeze({
	// --- endpoint cell prefilters (evaluated once when indexing sample cells) --
	clearanceMinPx: 12,        // require coarse_clear >= this (≈3 coarse px)
	terrainMinValue: 200,      // start/goal pixels must be on bright terrain (grayscale >= 200)
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
	barrierSlideSamples: 32,        // == city SLIDE_SAMPLES (narrow center window)
	barrierSlideFraction: 0.05,     // == city ROUTE_BARRIER_SLIDE_FRACTION
	barrierFallbackSamples: 30,     // == city FALLBACK_SAMPLES (broad 0.25..0.75 window)
	// Obstacle-significance test (WP 5.3 item 2 — the "no clean vis graph" answer).
	// A barrier only anchors in a *significant* impassable component (the mask
	// analogue of the city's "hedges excluded" rule): area ≥ barrierAnchorMinAreaPx
	// OR elongated (max(bboxW,bboxH)² / area ≥ barrierElongationRatio — thin
	// walls/fences are significant at any area). Small compact blobs (trees,
	// map-symbol specks) stay barrier-invisible. The component is bounded
	// flood-filled to barrierFloodCapPx and memoized per pixel.
	barrierAnchorMinAreaPx: 60,
	barrierElongationRatio: 8,
	barrierFloodCapPx: 250,
	// isClearOfRouteNodes gate: the probe midpoint must sit this far (px) from the
	// adjacent route vertices. City uses ROUTE_BARRIER_DRAW_WIDTH (1); the mask
	// equivalent is the enforcement width BARRIER_DRAW_WIDTH_MASK_PX (7).
	barrierClearNodeDistPx: BARRIER_DRAW_WIDTH_MASK_PX,
	// --- selection (shared route_pair_selection.js, injected) ----------------
	sideGapMinPx: 40,          // minSideGap in px (side is normalized to px on masks)
	maxRelativeGap: 0.40,      // ROUTE_PAIR_MAX_RELATIVE_GAP (shared weighted picker)
	routeAttempts: 5,          // == city selectionConfig.maxRoutes (deeper exploration for highRouteIndexBias)
	// --- per-route A* time budgets + timeout kicks (RoutePlanner parity) ------
	// Routes 1–2 get primaryBudgetMs, routes 3+ extraBudgetMs. The budget covers
	// the whole per-route step (graph A* + route 1's snap stubs). A route whose
	// search exceeds its deadline is dropped; if that leaves < 2 routes the
	// attempt fails with reason `timeout`. Mirrors RoutePlanner.computeRouteOptions.
	primaryBudgetMs: 400,
	extraBudgetMs: 200,
	// --- balance reject (route-choice difficulty tuning) ---------------------
	// The two served routes are the closest pair in runtime; when they are too
	// close the choice is a coin-flip and does not train route selection. With
	// `balanceRejectProbability` we reject a problem whose (refined) runtime
	// relative gap is within `balanceRejectMaxRelativeGap` and retry, skewing the
	// served distribution toward clearer decisions. Set probability 0 to disable,
	// 1 to remove the band entirely. Mirrors balanceRejectConfig in the city
	// batch worker (results/.../infinite_batch_worker.js) — keep the two in sync.
	balanceRejectMaxRelativeGap: 0.05,
	balanceRejectProbability: 0.8,
	// --- corridor + guided θ* refinement of the served pair (WP 5.2) ----------
	// Applied to the accepted pair's two routes only (outside the retry loop).
	// The legal spine (refineRouteLegal) is the waypoint chain; a `corridorRadius`
	// tube is carved around it and guidedThetaStar produces the smooth any-angle
	// polyline. `refineBudgetMs` bounds θ* per route; on timeout/failure the
	// policy decides what to serve.
	corridorRadius: 24,          // mask px; tube radius around the legal spine (editor uses 24 @ scale 0.5)
	refineBudgetMs: 600,         // per-route θ* budget; exceeded → legal-spine fallback
	// 'fallback': θ* fail/timeout on EITHER route → serve BOTH as refineRouteLegal
	//   output (keeps the two runtimes on the same cost basis; only rejects the
	//   pair as `timeout` if a legal spine itself is unusable).
	// 'reject':   the strict city-style behaviour — any θ* miss rejects the pair
	//   as `timeout`. One flag away for Phase 6.
	refineTimeoutPolicy: 'fallback',
	// Dynamic passage overlay: entrance pixels are sampled deterministically
	// across the cap. The count scales with width and is bounded in the overlay.
	passageCorridorRadius: 24,
});

// Module-level monotonic clock. `performance` is a global in both Node (>=16)
// and browser workers, so this stays Node-clean (no DOM / no `self`).
const nowMs = (typeof performance !== 'undefined' && performance.now)
	? () => performance.now()
	: () => Date.now();

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
 * `deadlineMs` (absolute `nowMs()` timestamp, optional) aborts the search
 * (returns null) when exceeded — checked every ~1024 expansions.
 */
export function astarSubgrid(mask, W, subX0, subY0, subW, subH, sx, sy, gx, gy, wantPath = false, maxExpansions = 200000, deadlineMs = null) {
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
		if (deadlineMs !== null && (expansions & 1023) === 0 && nowMs() > deadlineMs) return null;
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

	// Sampleable coarse cells (store as flat index into ch*cw grid). coarseMinval
	// is a block minimum, so a value below the endpoint threshold does not prove
	// that the whole cell is too dark. Keep mixed cells when at least one exact
	// full-res pixel is eligible; pixelInCell applies the same threshold again.
	const sampleCells = [];
	for (let cy = 0; cy < ch; cy++) {
		for (let cx = 0; cx < cw; cx++) {
			const ci = cy * cw + cx;
			if (coarseLabels[ci] !== mainComp) continue;
			if (coarseClear[ci] < cfg.clearanceMinPx) continue;
			if (coarseMinval[ci] < cfg.terrainMinValue) {
				let hasEligiblePixel = false;
				const x0 = cx * coarseScale, y0 = cy * coarseScale;
				for (let dy = 0; dy < coarseScale && y0 + dy < artifact.H && !hasEligiblePixel; dy++) {
					for (let dx = 0; dx < coarseScale && x0 + dx < artifact.W; dx++) {
						if (mask[(y0 + dy) * artifact.W + x0 + dx] >= cfg.terrainMinValue) {
							hasEligiblePixel = true;
							break;
						}
					}
				}
				if (!hasEligiblePixel) continue;
			}
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
		// Per-pixel memo for inSignificantObstacle (WP 5.3). Sparse Map keyed by
		// flat pixel index — only probed components are stored, each bounded to
		// cfg.barrierFloodCapPx, so memory stays tiny even on the 75 Mpx mask.
		sigMemo: new Map(),
	};
}

/**
 * Replace only the dynamic passage overlay on an already parsed base navgraph.
 * The base artifact, sampler, CSR arrays, and mask are retained verbatim.
 */
export function attachLevelPassages(state, documentOrItems) {
	const { W, H } = state.artifact;
	const revision = passageRevision(documentOrItems, W, H);
	const normalized = normalizePassagesForRuntime(documentOrItems, { mapWidth: W, mapHeight: H });
	state.passageOverlay = buildPassageOverlay(state, normalized.passages, {
		snapEndpoint,
		astarSubgrid,
	});
	state.passageRevision = revision;
	state.passageDiagnostics = normalized.diagnostics;
	return {
		revision,
		diagnostics: normalized.diagnostics,
		...state.passageOverlay.stats,
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

/** Random endpoint-eligible full-res pixel inside coarse cell `ci`, or null. */
function pixelInCell(state, ci, rng) {
	const { artifact, mask, cfg } = state;
	const { cw, coarseScale, W, H } = artifact;
	const cx = ci % cw, cy = (ci - cx) / cw;
	const x0 = cx * coarseScale, y0 = cy * coarseScale;
	// Try a few random pixels; fall back to a scan for a passable one.
	for (let t = 0; t < 6; t++) {
		const px = Math.min(W - 1, x0 + (rng() * coarseScale | 0));
		const py = Math.min(H - 1, y0 + (rng() * coarseScale | 0));
		if (mask[py * W + px] >= cfg.terrainMinValue) return { x: px, y: py };
	}
	for (let dy = 0; dy < coarseScale; dy++) {
		for (let dx = 0; dx < coarseScale; dx++) {
			const px = x0 + dx, py = y0 + dy;
			if (px < W && py < H && mask[py * W + px] >= cfg.terrainMinValue) return { x: px, y: py };
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
 * treats as an un-snappable endpoint). `deadline` (optional absolute `nowMs()`
 * timestamp) bounds the A* stubs (route 1's budget covers snapping on masks).
 */
export function snapEndpoint(state, pt, deadline = null) {
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
			const res = astarSubgrid(mask, W, x0, y0, x1 - x0, y1 - y0, pt.x, pt.y, nx, ny, false, 200000, deadline);
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
 * or null. Virtual ids: start = N, goal = N+1. `deadline` (optional absolute
 * `nowMs()` timestamp) aborts the search (returns null) when exceeded.
 */
export function graphAstar(state, goalPt, startSnap, goalSnap, blockedEdges, deadline = null) {
	const { artifact, adjStart, adjTo, adjW, adjEdge } = state;
	const { N, nodes, minCostPerPx } = artifact;
	const GRAPH_N = state.passageOverlay?.totalNodeCount || N;
	const START = GRAPH_N, GOAL = GRAPH_N + 1, TOTAL = GRAPH_N + 2;
	const blockedBase = blockedEdges?.baseEdges || blockedEdges;
	const blockedDynamic = blockedEdges?.dynamicEdges || null;
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
	const heuristicCostPerPx = state.passageOverlay?.minCostPerPx ?? minCostPerPx;
	const hEuclid = (nx, ny) => Math.hypot(goalX - nx, goalY - ny) * heuristicCostPerPx;
	let popCount = 0;
	while (heap.size > 0) {
		// Budget check: at pop 0 and every 512 pops thereafter. Pop-0 catches the
		// case where snapping already consumed the (tiny) budget before A* starts.
		if (deadline !== null && (popCount++ & 511) === 0 && nowMs() > deadline) return null;
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
			// Real base node: serialized CSR neighbours. Overlay portal nodes have
			// only dynamic adjacency and therefore never index the base CSR arrays.
			if (cur < N) {
				const s0 = adjStart[cur], s1 = adjStart[cur + 1];
				for (let e = s0; e < s1; e++) {
					if (blockedBase && blockedBase.has(adjEdge[e])) continue;
					relax(adjTo[e], gc + adjW[e], cur);
				}
			}
			for (const edge of state.passageOverlay?.adjacency?.get(cur) || []) {
				if (blockedDynamic?.has(edge.id)) continue;
				relax(edge.to, gc + edge.weight, cur);
			}
			if (goalFrom.has(cur)) relax(GOAL, gc + goalFrom.get(cur), cur);
		}
	}
	return null;

	function relax(to, tentative, from) {
		if (closed[to] || tentative >= g[to]) return;
		g[to] = tentative; parent[to] = from;
		let hx = 0;
		if (to !== GOAL) {
			const point = to < N
				? { x: nodes[2 * to], y: nodes[2 * to + 1] }
				: overlayNodeCoord(state, to);
			hx = hEuclid(point.x, point.y);
		}
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

/**
 * Obstacle-significance test (WP 5.3 item 2 — the "no clean vis graph" answer).
 * A probe point is a valid barrier anchor only if it lies in a *significant*
 * impassable component — the mask analogue of the city's "hedges excluded" rule.
 * Off-mask counts as a wall (significant), matching the old raw impassable probe.
 * A passable pixel is never an anchor.
 *
 * On an impassable hit we bounded-flood-fill (8-connected, capped at
 * cfg.barrierFloodCapPx ≈ 250) the component and accept iff its area ≥
 * cfg.barrierAnchorMinAreaPx (60) OR it is elongated
 * (max(bboxW,bboxH)² / area ≥ cfg.barrierElongationRatio — thin walls/fences are
 * significant at any area; reuses the retired blob-prefilter elongation idea).
 * A component that hits the flood cap is by definition large → significant.
 * Every visited pixel is memoized (state.sigMemo) so repeated probes over the
 * same speck/wall are O(1). Small compact blobs (trees, symbol specks) remain
 * barrier-invisible exactly like city hedges.
 */
export function inSignificantObstacle(state, x, y) {
	const { mask, artifact, cfg, sigMemo } = state;
	const { W, H } = artifact;
	const xi = Math.round(x), yi = Math.round(y);
	if (xi < 0 || yi < 0 || xi >= W || yi >= H) return true; // off-mask == wall
	const idx = yi * W + xi;
	if (mask[idx] !== IMPASSABLE) return false;
	const cached = sigMemo.get(idx);
	if (cached !== undefined) return cached === 1;

	const cap = cfg.barrierFloodCapPx > 0 ? cfg.barrierFloodCapPx : 250;
	const minArea = cfg.barrierAnchorMinAreaPx, elong = cfg.barrierElongationRatio;
	// Bounded 8-connected flood fill of the impassable component.
	const stack = [idx], visited = [idx], seen = new Set([idx]);
	let minX = xi, maxX = xi, minY = yi, maxY = yi, area = 0, capped = false;
	while (stack.length) {
		const p = stack.pop();
		area++;
		const px = p % W, py = (p - px) / W;
		if (px < minX) minX = px; if (px > maxX) maxX = px;
		if (py < minY) minY = py; if (py > maxY) maxY = py;
		if (area >= cap) { capped = true; break; }
		for (let dy = -1; dy <= 1; dy++) {
			const ny = py + dy;
			if (ny < 0 || ny >= H) continue;
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const nx = px + dx;
				if (nx < 0 || nx >= W) continue;
				const q = ny * W + nx;
				if (seen.has(q) || mask[q] !== IMPASSABLE) continue;
				seen.add(q); visited.push(q); stack.push(q);
			}
		}
	}
	let significant;
	if (capped) significant = true; // large component
	else {
		const maxDim = Math.max(maxX - minX + 1, maxY - minY + 1);
		significant = area >= minArea || (maxDim * maxDim) / area >= elong;
	}
	const val = significant ? 1 : 0;
	for (const q of visited) sigMemo.set(q, val);
	return significant;
}


/** Number of route-polyline edges crossed by a proposed barrier. */
function barrierRouteCrossingCount(wall, path) {
	let hits = 0;
	for (let i = 1; i < path.length; i++) {
		if (segIntersect(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y,
			wall.ax, wall.ay, wall.bx, wall.by)) hits++;
	}
	return hits;
}

/**
 * Find a perpendicular barrier near the route midpoint, anchored in *significant*
 * obstacles on both sides and guaranteed to cross the route. Faithful re-port of
 * the current city-gen findSmartBarrier (RoutePlanner.js) — its bestClearEnclosed
 * (isClearOfRouteNodes) / bestEnclosed / broad tiers — with px-scaled constants,
 * inSignificantObstacle probing instead of polygon obstacles, and two mask-mode
 * additions the vis-graph city doesn't need:
 *   - Anchoring (WP 5.3 item 2): every returned end is anchored in a significant
 *     obstacle (open ends are extended toward one; a still-open end fails the
 *     candidate). Without a vis graph, an unanchored bar would render as a purple
 *     line floating in open ground — the acceptance forbids it.
 *   - Effectiveness (WP 5.3 item 3): the wall must cross ≥1 edge of THIS route's
 *     node polyline, else it blocks nothing and the reroute silently dedupes to
 *     `distinct`. We slide the probe window (narrow center, then the broad
 *     0.25..0.75 window) until an anchored, route-crossing wall is found, else
 *     return null (attempt ends with the routes found so far).
 *
 * DEVIATION from the city port (documented): the city keeps a purely
 * width-minimising, possibly-unanchored fallback wall (bestFallback/broadFallback
 * dangling in open space). On masks we require both ends anchored, so those
 * unanchored fallbacks are dropped — the broad pass instead slides across every
 * probe looking for an anchored + crossing one.
 *
 * Returns { ax, ay, bx, by, enclosed } (mask px) or null.
 */
export function findBarrier(state, path) {
	const { mask, artifact, cfg } = state;
	const { W, H } = artifact;
	const total = routePathLength(path);
	if (total < 1e-6) return null;
	const MAX_HALF = cfg.barrierMaxHalfPx, STEP = cfg.barrierStepPx;
	const MARGIN = cfg.barrierMarginPx, EXTEND_MAX_HALF = cfg.barrierExtendMaxHalfPx;
	const CENTER = 0.5;
	const sig = (x, y) => inSignificantObstacle(state, x, y);

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
				const distFromPrev = targetLen - accum;
				const distToNext = accum + segLen - targetLen;
				let leftDist = MAX_HALF, rightDist = MAX_HALF, leftHit = false, rightHit = false;
				for (let d = STEP; d <= MAX_HALF; d += STEP)
					if (sig(mx + px * d, my + py * d)) { leftDist = d; leftHit = true; break; }
				for (let d = STEP; d <= MAX_HALF; d += STEP)
					if (sig(mx - px * d, my - py * d)) { rightDist = d; rightHit = true; break; }
				return { frac, mx, my, px, py, leftDist, rightDist, leftHit, rightHit, distFromPrev, distToNext };
			}
			accum += segLen;
		}
		return null;
	};
	// Extend an open end toward a significant obstacle; report whether anchored.
	const extend = (p, sign, dist, hit) => {
		if (hit) return { dist, anchored: true };
		for (let d = dist + STEP; d <= EXTEND_MAX_HALF; d += STEP)
			if (sig(p.mx + sign * p.px * d, p.my + sign * p.py * d)) return { dist: d, anchored: true };
		return { dist, anchored: false };
	};
	const wallAt = (p) => {
		const l = extend(p, 1, p.leftDist, p.leftHit), r = extend(p, -1, p.rightDist, p.rightHit);
		// `barrierMarginPx` normally pushes the visible endpoint farther into the
		// obstacle.  A thin fence can be narrower than that margin, though, which
		// would put the endpoint back in open terrain.  Walk back to the first
		// significant pixel in that case: both returned endpoints are therefore
		// genuinely anchored, not merely derived from an anchored probe.
		const anchoredEnd = (sign, info) => {
			if (!info.anchored) return null;
			for (let extra = MARGIN; extra >= -1e-9; extra -= STEP) {
				const x = p.mx + sign * p.px * (info.dist + extra);
				const y = p.my + sign * p.py * (info.dist + extra);
				if (sig(x, y)) return { x, y };
			}
			return null;
		};
		const a = anchoredEnd(1, l), b = anchoredEnd(-1, r);
		if (!a || !b) return null;
		return {
			ax: a.x, ay: a.y, bx: b.x, by: b.y,
			enclosed: true,
		};
	};
	const isClearOfRouteNodes = (p) =>
		Math.min(p.distFromPrev, p.distToNext) >= cfg.barrierClearNodeDistPx;
	// A candidate is usable iff anchored on both ends AND it crosses this route.
	const effective = (p) => {
		if (!p) return null;
		const wall = wallAt(p);
		if (!wall || !wall.enclosed) return null;
		// Keep the count on the emitted audit record.  It is cheap (the current
		// node path is normally ≤40 edges) and lets the Node acceptance harness
		// prove that no placed bar was a no-op.
		wall.routeEdgeCrossings = barrierRouteCrossingCount(wall, path);
		if (wall.routeEdgeCrossings < 1) return null;
		return wall;
	};

	// Narrow slide window (center ± slideFraction): prefer an enclosed probe that
	// is also clear of route nodes (bestClearEnclosed), else any enclosed
	// (bestEnclosed) — the two city tiers.
	let bestClearEnclosed = null, bestClearScore = Infinity;
	let bestEnclosed = null, bestEnclosedScore = Infinity;
	const minFrac = Math.max(0, CENTER - cfg.barrierSlideFraction);
	const maxFrac = Math.min(1, CENTER + cfg.barrierSlideFraction);
	for (let s = 0; s <= cfg.barrierSlideSamples; s++) {
		const frac = minFrac + (maxFrac - minFrac) * (s / cfg.barrierSlideSamples);
		const p = probe(frac);
		if (!p || !p.leftHit || !p.rightHit) continue;
		const score = (p.leftDist + p.rightDist) + Math.abs(frac - CENTER) * 1e-3;
		if (isClearOfRouteNodes(p) && score < bestClearScore) { bestClearScore = score; bestClearEnclosed = p; }
		if (score < bestEnclosedScore) { bestEnclosedScore = score; bestEnclosed = p; }
	}
	let wall = effective(bestClearEnclosed) || effective(bestEnclosed);
	if (wall) return wall;

	// Broad fallback window (0.25..0.75): slide until a probe yields an effective
	// (anchored + route-crossing) wall — enclosed probes first (nearest-center),
	// then any probe (narrowest first).
	const broadProbes = [];
	for (let s = 0; s <= cfg.barrierFallbackSamples; s++) {
		const p = probe(0.25 + 0.5 * (s / cfg.barrierFallbackSamples));
		if (p) broadProbes.push(p);
	}
	const enclosed = broadProbes.filter((p) => p.leftHit && p.rightHit)
		.sort((a, b) => Math.abs(a.frac - CENTER) - Math.abs(b.frac - CENTER));
	for (const p of enclosed) { const w = effective(p); if (w) return w; }
	const rest = broadProbes.slice()
		.sort((a, b) => (a.leftDist + a.rightDist) - (b.leftDist + b.rightDist));
	for (const p of rest) { const w = effective(p); if (w) return w; }
	return null;
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
			if (b.surface && b.surface !== 'base') continue;
			if (segIntersect(ux, uy, vx, vy, b.ax, b.ay, b.bx, b.by)) { blocked.add(e); break; }
		}
	}
	if (!state.passageOverlay?.nodeCount) return blocked;
	return {
		baseEdges: blocked,
		dynamicEdges: blockedDynamicEdges(state, barriers, segIntersect),
	};
}

function barrierSurfaceForTypedRoute(wall, typedLegs) {
	for (const leg of typedLegs || []) {
		for (let i = 1; i < leg.points.length; i++) {
			const a = leg.points[i - 1], b = leg.points[i];
			if (segIntersect(a.x, a.y, b.x, b.y, wall.ax, wall.ay, wall.bx, wall.by)) {
				return leg.surface;
			}
		}
	}
	return 'base';
}

// =============================================================================
// computeRouteOptions — up to cfg.routeAttempts routes with barrier-forced
// alternates + per-route time budgets (RoutePlanner parity)
// =============================================================================

/** Signature to dedupe identical node paths. */
function pathSignature(nodePath) { return nodePath.join(','); }

/**
 * Produce up to cfg.routeAttempts routes for a snapped pair. Each route record
 * carries the city-shape fields the shared selection module expects:
 * `routeIndex` (attempt+1), `run_time` (graph cost), `barrier` (the barrier
 * placed *after* this route, RoutePlanner convention), plus `path`/`nodePath`/
 * `len`/`cost`. Dedupe by node-path signature.
 *
 * Routes 1–2 get cfg.primaryBudgetMs, routes 3+ cfg.extraBudgetMs. A route whose
 * graph A* exceeds its deadline is dropped (loop breaks); `opts.startTime`
 * (absolute `nowMs()` timestamp, when snapping began) anchors route 1's deadline
 * so its budget also covers the snap stubs. Returns
 * { paths, barriers, reason, timedOut } with reason ∈ {ok, unreachable,
 * distinct, timeout} — `timeout` when a drop left < 2 routes.
 */
export function computeRouteOptions(state, start, goal, startSnap, goalSnap, opts = {}) {
	const { cfg, artifact, mask } = state;
	const { W, H } = artifact;
	const startTime = Number.isFinite(opts.startTime) ? opts.startTime : nowMs();
	const barriers = [];
	const paths = [];
	const seen = new Set();
	let timedOut = false;
	for (let attempt = 0; attempt < cfg.routeAttempts; attempt++) {
		const budgetMs = attempt < 2 ? cfg.primaryBudgetMs : cfg.extraBudgetMs;
		const base = attempt === 0 ? startTime : nowMs();
		const deadline = Number.isFinite(budgetMs) ? base + budgetMs : null;
		const blocked = blockedByBarriers(state, barriers);
		const res = graphAstar(state, goal, startSnap, goalSnap, blocked, deadline);
		if (!res) {
			// Distinguish a timeout kick from a genuine dead end.
			if (deadline !== null && nowMs() > deadline) timedOut = true;
			break;
		}
		if (res.nodePath.length < 2) break;
		const sig = pathSignature(res.nodePath);
		if (seen.has(sig)) break; // barrier didn't change the route
		seen.add(sig);
		const typed = state.passageOverlay?.nodeCount
			? nodePathToTypedRoute(state, res.nodePath, start, goal)
			: { path: nodePathToCoords(state, res.nodePath, start, goal), legs: null };
		const coords = typed.path;
		const rec = {
			path: coords, nodePath: res.nodePath, len: routePathLength(coords),
			cost: res.cost, run_time: res.cost, routeIndex: attempt + 1, barrier: null,
			typedLegs: typed.legs,
		};
		paths.push(rec);
		if (attempt >= cfg.routeAttempts - 1) break;
		const barrier = findBarrier(state, coords);
		if (!barrier) break;
		if (typed.legs) barrier.surface = barrierSurfaceForTypedRoute(barrier, typed.legs);
		// attemptIndex = the routeIndex of the route this barrier was placed
		// *after* (RoutePlanner convention). A later route with routeIndex R was
		// computed with every barrier of attemptIndex < R blocking, so WP 5.2
		// stamps exactly those into that route's refinement subgrid.
		barrier.attemptIndex = rec.routeIndex;
		rec.barrier = barrier;
		barriers.push(barrier);
	}
	let reason = 'ok';
	if (paths.length === 0) reason = timedOut ? 'timeout' : 'unreachable';
	else if (paths.length === 1) reason = timedOut ? 'timeout' : 'distinct';
	return { paths, barriers, reason, timedOut };
}

// =============================================================================
// Selection is the shared, dependency-injected route_pair_selection.js
// (weighted pair choice, lateral/routeside/side rejects, skippedBarriers). The
// old local `selectRuntimeRouteOptions` port was removed in WP 5.1 — callers
// pass the module in via `generateOnePair(state, { selection })`.
// =============================================================================

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

function passagePolylineCost(passage, path) {
	let cost = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i];
		const segment = lineCost(
			passage.grid, passage.localWidth,
			a.x - passage.originX, a.y - passage.originY,
			b.x - passage.originX, b.y - passage.originY,
		);
		if (segment === null) return null;
		cost += segment;
	}
	return cost;
}

function refinePassageLeg(state, leg) {
	const passage = state.passageOverlay?.passageById?.get(String(leg.passageId));
	if (!passage || !leg.points?.length) return { mode: 'unusable', tTheta: 0 };
	const legalPath = leg.points.map((point) => ({ x: point.x, y: point.y }));
	const legalCost = passagePolylineCost(passage, legalPath);
	if (legalCost === null) return { mode: 'unusable', legalPath, legalCost: Infinity, tTheta: 0 };

	const dense = [];
	for (const point of legalPath) dense.push(point.x - passage.originX, point.y - passage.originY);
	const start = { x: dense[0], y: dense[1] };
	const goal = { x: dense[dense.length - 2], y: dense[dense.length - 1] };
	const t0 = nowMs();
	let theta = null;
	try {
		const waypoints = simplifyAStarSameTerrainPath(dense, passage.grid,
			passage.localWidth, passage.localHeight, 10);
		const corridor = corridorMask(waypoints, passage.localWidth, passage.localHeight,
			state.cfg.passageCorridorRadius || state.cfg.corridorRadius || 24);
		const constrained = applyCorridor(passage.grid, corridor);
		theta = guidedThetaStar(constrained, passage.localWidth, passage.localHeight,
			start, goal, waypoints, 10);
		if (theta) theta = simplifyThetaPath(theta, 10, 5);
	} catch (_) {
		theta = null;
	}
	const tTheta = nowMs() - t0;
	if (!theta || theta.length < 4) {
		return { mode: 'legal-fallback', legalPath, legalCost, path: legalPath, cost: legalCost, tTheta };
	}
	theta[0] = start.x; theta[1] = start.y;
	theta[theta.length - 2] = goal.x; theta[theta.length - 1] = goal.y;
	const path = [];
	for (let i = 0; i < theta.length; i += 2) {
		path.push({ x: theta[i] + passage.originX, y: theta[i + 1] + passage.originY });
	}
	const cost = passagePolylineCost(passage, path);
	if (cost === null) {
		return { mode: 'legal-fallback', legalPath, legalCost, path: legalPath, cost: legalCost, tTheta };
	}
	return { mode: 'theta', legalPath, legalCost, path, cost, thetaCost: cost, tTheta };
}

function flattenTypedLegs(legs) {
	const path = [];
	const passageSpans = [];
	for (const leg of legs || []) {
		const fromIndex = path.length ? path.length - 1 : 0;
		for (const point of leg.points || []) {
			const previous = path[path.length - 1];
			if (!previous || previous.x !== point.x || previous.y !== point.y) path.push({ x: point.x, y: point.y });
		}
		if (leg.surface !== 'base') {
			passageSpans.push({ passageId: leg.passageId, fromIndex, toIndex: path.length - 1 });
		}
	}
	return { path, passageSpans };
}

function activeSurfaceBarriers(barriers, routeIndex, surface) {
	return (barriers || []).filter((barrier) => {
		const attemptIndex = Number.isFinite(barrier.attemptIndex) ? barrier.attemptIndex : -Infinity;
		return attemptIndex < routeIndex && (barrier.surface || 'base') === surface;
	});
}

/** Surface-aware legal/Theta refinement for a navgraph route with passage legs. */
export function refineTypedNavgraphRoute(state, route, barriers, opts = {}) {
	if (!route?.typedLegs) return refineRouteTheta(state, route.path, barriers, opts);
	const routeIndex = Number.isFinite(opts.routeIndex) ? opts.routeIndex : Infinity;
	const selectedLegs = [];
	const legalLegs = [];
	let selectedCost = 0;
	let legalCost = 0;
	let tRefine = 0;
	let tTheta = 0;
	let fallback = false;
	for (const leg of route.typedLegs) {
		let refined;
		if (leg.surface === 'base') {
			const surfaceBarriers = (barriers || []).filter((barrier) => !barrier.surface || barrier.surface === 'base');
			refined = refineRouteTheta(state, leg.points, surfaceBarriers, opts);
			tRefine += refined.tRefine || 0;
		} else {
			refined = refinePassageLeg(state, leg);
		}
		tTheta += refined.tTheta || 0;
		if (refined.mode === 'unusable') {
			return { path: route.path, cost: route.cost, mode: 'unusable', legalPath: route.path,
				legalCost: route.cost, tRefine, tTheta, activeBarriers: [], routeIndex };
		}
		if (refined.mode !== 'theta') fallback = true;
		selectedCost += refined.cost;
		legalCost += refined.legalCost;
		selectedLegs.push({ ...leg, points: refined.path });
		legalLegs.push({ ...leg, points: refined.legalPath });
	}
	const selected = flattenTypedLegs(selectedLegs);
	const legal = flattenTypedLegs(legalLegs);
	const activeBarriers = (barriers || []).filter((barrier) => {
		const attemptIndex = Number.isFinite(barrier.attemptIndex) ? barrier.attemptIndex : -Infinity;
		return attemptIndex < routeIndex;
	});
	return {
		path: selected.path,
		cost: selectedCost,
		mode: fallback ? 'legal-fallback' : 'theta',
		legalPath: legal.path,
		legalCost,
		thetaCost: fallback ? null : selectedCost,
		thetaFail: fallback ? 'surface-leg' : null,
		tRefine,
		tTheta,
		activeBarriers,
		routeIndex,
		typedLegs: selectedLegs,
		legalTypedLegs: legalLegs,
		passageSpans: selected.passageSpans,
		legalPassageSpans: legal.passageSpans,
	};
}

export function countTypedLegalityViolations(state, typedLegs) {
	let hits = 0;
	for (const leg of typedLegs || []) {
		if (leg.surface === 'base') {
			hits += countLegalityViolations(state, leg.points);
		} else {
			const passage = state.passageOverlay?.passageById?.get(String(leg.passageId));
			if (!passage || passagePolylineCost(passage, leg.points) === null) hits++;
		}
	}
	return hits;
}

function countTypedBarrierViolations(refined) {
	if (!refined.typedLegs) return countBarrierViolations(refined.path, refined.activeBarriers);
	let hits = 0;
	for (const leg of refined.typedLegs) {
		hits += countBarrierViolations(
			leg.points,
			activeSurfaceBarriers(refined.activeBarriers, refined.routeIndex, leg.surface),
		);
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
 * @param {object}   opts.selection    injected route_pair_selection.js module
 *                                     ({ selectWeightedRoutePair,
 *                                     skippedBarriersForSelection,
 *                                     DEFAULT_ROUTE_PAIR_SELECTION }). Required —
 *                                     the module is cross-app and cannot be
 *                                     imported here without breaking Node/worker
 *                                     portability, so callers inject it.
 * @param {Function} [opts.now]        clock (defaults to module nowMs)
 * @returns {{
 *   ok: boolean,
 *   start?: {x,y}, goal?: {x,y},
 *   routes?: [Array<{x,y}>, Array<{x,y}>],   // refined, ordered by side (L then R)
 *   runtimes?: [number, number],             // refined terrain-weighted costs
 *   skippedBarriers?: Array<{ax,ay,bx,by}>,  // barriers of skipped lower-index routes (WP 5.3)
 *   meta?: { retries, attempts, sideGap, relGap, legality, rejectionCounts, timings },
 *   reason?: string
 * }}
 */
export function generateOnePair(state, { rng, maxAttempts = 4000, now, selection } = {}) {
	if (!selection || typeof selection.selectWeightedRoutePair !== 'function')
		throw new Error('generateOnePair requires an injected `selection` module (route_pair_selection.js)');
	rng = rng || makeRng((Math.random() * 0xffffffff) >>> 0);
	const clock = now || nowMs;
	const cfg = state.cfg;
	const selectionDefaults = selection.DEFAULT_ROUTE_PAIR_SELECTION || {};
	let attempts = 0;
	let retries = 0; // consecutive non-accepted attempts before the accepted one
	let lastReason = 'none';
	const timings = { sample: 0, snap: 0, route: 0, refine: 0, theta: 0 };
	// Per-call rejection taxonomy (mask analogue of the city batch rejectionCounts).
	const rejectionCounts = {
		empty: 0, distance: 0, obstacle: 0, snap: 0, unreachable: 0, distinct: 0,
		runtime: 0, side: 0, routeside: 0, lateral: 0, timeout: 0,
		runtime_refined: 0, balanced: 0,
	};
	const bump = (reason) => { if (reason in rejectionCounts) rejectionCounts[reason]++; };

	for (; attempts < maxAttempts; attempts++) {
		const t0 = clock();
		const sp = samplePair(state, rng);
		if (sp.reason) { timings.sample += clock() - t0; bump(sp.reason); lastReason = sp.reason; retries++; continue; }
		const tSample = clock(); timings.sample += tSample - t0;

		// Route 1's budget covers the snap stubs → anchor the snap deadline at the
		// start of this attempt's route step (tSample).
		const snapDeadline = Number.isFinite(cfg.primaryBudgetMs) ? tSample + cfg.primaryBudgetMs : null;
		const startSnap = snapEndpoint(state, sp.start, snapDeadline);
		const goalSnap = snapEndpoint(state, sp.goal, snapDeadline);
		const tSnap = clock(); timings.snap += tSnap - tSample;
		if (!startSnap.length || !goalSnap.length) { bump('snap'); lastReason = 'snap'; retries++; continue; }

		const routeResult = computeRouteOptions(state, sp.start, sp.goal, startSnap, goalSnap, { startTime: tSample });
		const tRoute = clock(); timings.route += tRoute - tSnap;
		if (routeResult.paths.length < 2) { bump(routeResult.reason); lastReason = routeResult.reason; retries++; continue; }

		const sel = selection.selectWeightedRoutePair(routeResult.paths, {
			start: sp.start,
			goal: sp.goal,
			config: { ...selectionDefaults, minSideGap: cfg.sideGapMinPx, maxRelativeGap: cfg.maxRelativeGap },
			rng,
		});
		if (!sel.ok) { bump(sel.reason); lastReason = sel.reason; retries++; continue; }

		// Barriers of faster lower-index routes that were skipped by the pick —
		// WP 5.3 draws + enforces these at full resolution.
		const skippedBarriers = selection.skippedBarriersForSelection(routeResult.paths, sel.selected);

		// Order the two selected routes by side (L negative first, R positive).
		const ordered = sel.selected.slice().sort((x, y) => x.side - y.side);
		// WP 5.2: corridor + guided θ* refinement of the accepted pair. Each
		// route gets its legal spine + a θ* pass around it, with active
		// barriers (attemptIndex < routeIndex) stamped into its subgrid.
		const refA = ordered[0].typedLegs
			? refineTypedNavgraphRoute(state, ordered[0], routeResult.barriers,
				{ routeIndex: ordered[0].routeIndex, now: clock })
			: refineRouteTheta(state, ordered[0].path, routeResult.barriers,
				{ routeIndex: ordered[0].routeIndex, now: clock });
		const refB = ordered[1].typedLegs
			? refineTypedNavgraphRoute(state, ordered[1], routeResult.barriers,
				{ routeIndex: ordered[1].routeIndex, now: clock })
			: refineRouteTheta(state, ordered[1].path, routeResult.barriers,
				{ routeIndex: ordered[1].routeIndex, now: clock });
		timings.refine += refA.tRefine + refB.tRefine;
		timings.theta += refA.tTheta + refB.tTheta;

		// Timeout/failure policy (cfg.refineTimeoutPolicy).
		if (refA.mode === 'unusable' || refB.mode === 'unusable') {
			// Even the legal spine is unusable → the pair rejects.
			bump('timeout'); lastReason = 'timeout'; retries++; continue;
		}
		let pathA = refA.path, costA = refA.cost, modeA = refA.mode;
		let pathB = refB.path, costB = refB.cost, modeB = refB.mode;
		let typedA = refA.typedLegs || null, typedB = refB.typedLegs || null;
		let passageSpansA = refA.passageSpans || [], passageSpansB = refB.passageSpans || [];
		let refineFallback = 0;
		if (cfg.refineTimeoutPolicy === 'reject') {
			if (modeA !== 'theta' || modeB !== 'theta') {
				bump('timeout'); lastReason = 'timeout'; retries++; continue;
			}
		} else if (modeA === 'legal-fallback' || modeB === 'legal-fallback') {
			// Serve BOTH as the legal spine so the two runtimes share a cost
			// basis (θ* paths are systematically slightly cheaper; mixing bases
			// would bias the gap).
			pathA = refA.legalPath; costA = refA.legalCost; modeA = 'legal-fallback';
			pathB = refB.legalPath; costB = refB.legalCost; modeB = 'legal-fallback';
			typedA = refA.legalTypedLegs || typedA;
			typedB = refB.legalTypedLegs || typedB;
			passageSpansA = refA.legalPassageSpans || passageSpansA;
			passageSpansB = refB.legalPassageSpans || passageSpansB;
			refineFallback = 1;
		}

		// Barrier legality: a served route must not cross any of its active
		// barriers. θ* routes are barrier-clean by construction (validated on the
		// stamped subgrid); a legal-spine fallback is barrier-unaware, so guard it
		// here — if it crosses, the pair can't be served (reuse `timeout`: the
		// refinement failed to produce a barrier-clean route in budget).
		const barrierRefA = { ...refA, path: pathA, typedLegs: typedA };
		const barrierRefB = { ...refB, path: pathB, typedLegs: typedB };
		if (countTypedBarrierViolations(barrierRefA)
			+ countTypedBarrierViolations(barrierRefB) > 0) {
			bump('timeout'); lastReason = 'timeout'; retries++; continue;
		}

		// Re-check the relative gap on the θ*-refined runtimes (plan.md).
		const rtA = costA, rtB = costB;
		const faster = Math.min(rtA, rtB), slower = Math.max(rtA, rtB);
		const relGap = faster > 0 ? (slower - faster) / faster : Infinity;
		if (relGap > cfg.maxRelativeGap) { bump('runtime_refined'); lastReason = 'runtime_refined'; retries++; continue; }

		// Balance reject (post-refinement): too-close routes are a coin-flip
		// choice — drop them with cfg.balanceRejectProbability and retry.
		if (relGap <= cfg.balanceRejectMaxRelativeGap && rng() < cfg.balanceRejectProbability) {
			bump('balanced'); lastReason = 'balanced'; retries++; continue;
		}

		const legality = typedA || typedB
			? countTypedLegalityViolations(state, typedA || [{ surface: 'base', points: pathA }])
				+ countTypedLegalityViolations(state, typedB || [{ surface: 'base', points: pathB }])
			: countLegalityViolations(state, pathA) + countLegalityViolations(state, pathB);

		return {
			ok: true,
			start: sp.start,
			goal: sp.goal,
			routes: [pathA, pathB],
			runtimes: [rtA, rtB],
			passageSpans: [passageSpansA, passageSpansB],
			// All bars placed while exploring alternates.  The scene uses the
			// skipped subset for rendering; retaining the full set makes the worker
			// result auditable and lets verification assert every placement.
			barriers: routeResult.barriers,
			skippedBarriers,
			meta: {
				retries,
				attempts: attempts + 1,
				sideGap: sel.sideGap,
				relGap,
				legality,
				passageRevision: state.passageRevision || null,
				rejectionCounts,
				// WP 5.2 refinement outcome (WP 5.4 threads these to stats).
				refineMode: modeA,           // both routes share a basis after coordination
				refineFallback,              // 1 if the pair fell back to legal spines
				refine: [
					{ mode: refA.mode, thetaCost: refA.thetaCost, legalCost: refA.legalCost,
						thetaFail: refA.thetaFail, routeIndex: refA.routeIndex, activeBarriers: refA.activeBarriers },
					{ mode: refB.mode, thetaCost: refB.thetaCost, legalCost: refB.legalCost,
						thetaFail: refB.thetaFail, routeIndex: refB.routeIndex, activeBarriers: refB.activeBarriers },
				],
				timings: {
					sample: +timings.sample.toFixed(2),
					snap: +timings.snap.toFixed(2),
					route: +timings.route.toFixed(2),
					refine: +timings.refine.toFixed(2),
					theta: +timings.theta.toFixed(2),
				},
			},
		};
	}
	return { ok: false, reason: lastReason, meta: { retries, attempts, rejectionCounts } };
}
