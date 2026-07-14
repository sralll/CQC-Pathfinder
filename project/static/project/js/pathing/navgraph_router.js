// =============================================================================
// navgraph_router.js — shared browser/worker router for uploaded-map infinity.
//
// Its importable, pure functions cover:
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
import { refineRouteTheta, countBarrierViolations, stampBarrierLine } from './refine_theta.js';
import { normalizePassagesForRuntime } from './passage_geometry.js';
import { layeredRouteDistinct } from './layered_distinct.js';
import {
	refineDenseLeg as refineEditorDenseLeg,
	optimizeRefinedPortalAnchors,
} from './layered_pipeline.js';
import {
	buildPassageOverlay, blockedDynamicEdges, nodePathToTypedRoute,
	overlayNodeCoord, passageRevision,
} from './navgraph_passage_overlay.js';

// ------------------------------------------------------------------ constants
export const IMPASSABLE = 0;
// Current typed-passage .bin layout (navgraph.py NAVGRAPH_VERSION). A legacy v2
// artifact (base-only, no passage section) is still parsed, but only a file with
// no passages may run on it — the caller compares passageRevision (CR 8.3/8.4).
export const SUPPORTED_VERSION = 4;
export const LEGACY_TYPED_VERSION = 3;
export const LEGACY_BASE_ONLY_VERSION = 2;
// Typed edge kinds (mirror navgraph.py EDGE_KIND_*).
export const EDGE_KIND_BASE = 0;
export const EDGE_KIND_PASSAGE = 1;
export const EDGE_KIND_TRANSITION = 2;
// Bounds cap for the serialized passage-revision string (mirror navgraph.py).
const NAVGRAPH_REVISION_MAX_LEN = 256;
const SQRT2 = Math.SQRT2;

// Default barrier width for editor/headless callers without rendered-map
// metadata. Infinite play overrides it per file with the exact mask-space
// projection of its unchanged SVG stroke.
export const BARRIER_DRAW_WIDTH_MASK_PX = 7;

// Default tuning config. Every threshold that Phase 5 may tune lives here so
// callers can override with a single object. Distances are full-res px unless
// noted. Values mirror the harness DEFAULT_CONFIG verbatim.
export const DEFAULT_CONFIG = Object.freeze({
	// --- endpoint cell prefilters (evaluated once when indexing sample cells) --
	clearanceMinPx: 12,        // require coarse_clear >= this (≈3 coarse px)
	terrainMinValue: 200,      // start/goal pixels must be on bright terrain (grayscale >= 200)
	// Sample endpoints in proportion to the local percentage of impassable
	// pixels. This approximates feature sampling: a narrow alley has much less
	// passable area than a plaza, but its larger obstacle-to-area ratio offsets
	// that disadvantage without concentrating on only the darkest districts.
	endpointObstacleWindowPx: 100,
	// Preserve some map-wide coverage so a plaza centre with no black pixel in
	// its local window is uncommon, not impossible. The other 70% follows the
	// direct obstacle-percentage acceptance distribution below.
	endpointUniformMix: 0.30,
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
	// Overridden for uploaded maps with the exact mask-space projection of the
	// existing player SVG stroke. Seven remains the editor/default fallback.
	barrierWidthPx: BARRIER_DRAW_WIDTH_MASK_PX,
	// Uploaded-map callers override this together with barrierWidthPx so
	// placement uses the same per-map stroke dimension.
	barrierClearNodeDistPx: BARRIER_DRAW_WIDTH_MASK_PX,
	// A blocker assigned to a passage is extended across the full passage
	// raster, with this much visible/enforced overhang on both sides. Otherwise
	// the centreline edge that happened to be crossed can produce a tiny bar in
	// a wide passage and look passable even though the graph edge is blocked.
	passageBarrierOverhangPx: 2,
	// --- selection (shared route_pair_selection.js, injected) ----------------
	sideGapMinPx: 40,          // minSideGap in px (side is normalized to px on masks)
	// Scale the geometric separation requirement with the direct start→goal
	// distance. The absolute value above remains a floor for shorter routes.
	sideGapMinDirectFraction: 0.12,
	maxRelativeGap: 0.40,      // ROUTE_PAIR_MAX_RELATIVE_GAP (shared weighted picker)
	routeAttempts: 5,          // == city selectionConfig.maxRoutes (deeper exploration for highRouteIndexBias)
	// Only adjacent cumulative alternates may form a pair. A wider index gap
	// means the later route avoided multiple barriers that cannot be rendered
	// because they would cross the earlier selected route ("ghost blockers").
	maxSelectedRouteIndexGap: 1,
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
	// After selection, re-optimize against only the blockers actually rendered.
	// Keep the established 24 px tube so the final Theta* pass stays within its
	// runtime budget while final side/distinctness checks preserve the route choice.
	finalCorridorRadius: 24,
	finalRefineBudgetMs: 1200,
	// 'reject': θ* fail/timeout on EITHER route rejects the pair as `timeout`.
	//   A legal spine is an internal corridor input, not a presentable route.
	// 'fallback': retain the diagnostic/benchmark option to serve BOTH legal
	//   spines on the same cost basis, but never use it in uploaded-map Infinity.
	refineTimeoutPolicy: 'reject',
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

const REBUILD_HINT =
	'rebuild with: python manage.py build_navgraph --file <mask> --force';

/** Reject a non-finite or out-of-range unsigned count. */
function requireCount(name, value, max) {
	if (!Number.isInteger(value) || value < 0 || value > max)
		throw new Error(`navgraph artifact has invalid ${name} (${value})`);
	return value;
}

/**
 * Parse a `.navgraph.bin` (magic `NVG1`) from an ArrayBuffer or Uint8Array.
 * Returns a plain object with typed arrays + scalar header fields, including the
 * v3 typed-passage topology (`baseNodeCount`, `passageCount`, `passageRevision`,
 * `edgeKinds`, `edgePassage`, `passageNodeStart`, `passageNodeCount`).
 *
 * v3 is the current typed format. A legacy v2 artifact (base-only, no passage
 * section) is still parsed for backward compatibility and reported as
 * `baseNodeCount === N`, zero passages, `passageRevision === null`; the caller
 * decides whether the served file may run on it (CR 8.3/8.4). Every count is
 * bounds-checked and the exact byte length is verified, so a truncated or
 * overflowing artifact is rejected rather than read as silent zeros.
 *
 * @param {ArrayBuffer|Uint8Array} input  raw bytes of the .navgraph.bin
 */
export function loadArtifact(input) {
	const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
	if (buf.length < 52) throw new Error('navgraph artifact too small (truncated header)');
	const magic = magic4(buf);
	if (magic !== 'NVG1') throw new Error(`bad magic ${JSON.stringify(magic)} in navgraph artifact`);
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const version = dv.getUint32(4, true);
	if (version !== SUPPORTED_VERSION && version !== LEGACY_TYPED_VERSION
		&& version !== LEGACY_BASE_ONLY_VERSION)
		throw new Error(`unsupported navgraph version ${version} ` +
			`(need v${SUPPORTED_VERSION}); ${REBUILD_HINT}`);
	const H = dv.getInt32(8, true);
	const W = dv.getInt32(12, true);
	const minCostPerPx = dv.getFloat32(16, true);
	const N = requireCount('node count', dv.getUint32(20, true), 0x7fffffff);
	const E = requireCount('edge count', dv.getUint32(24, true), 0x7fffffff);
	const coarseScale = dv.getInt32(28, true);
	const ch = requireCount('coarse height', dv.getInt32(32, true), 0x7fffffff);
	const cw = requireCount('coarse width', dv.getInt32(36, true), 0x7fffffff);
	const hitzoneScale = dv.getInt32(40, true);
	const hh = requireCount('hitzone height', dv.getInt32(44, true), 0x7fffffff);
	const hw = requireCount('hitzone width', dv.getInt32(48, true), 0x7fffffff);
	if (H <= 0 || W <= 0 || coarseScale <= 0 || hitzoneScale <= 0)
		throw new Error('navgraph artifact has invalid mask/scale dimensions');

	// --- passage section header (v3/v4) + cropped-grid origin (v4) ---
	let headerEnd = 52;
	let baseNodeCount = N;
	let passageCount = 0;
	let passageRevision = null;
	let coarseOriginX = 0, coarseOriginY = 0;
	const typedVersion = version === SUPPORTED_VERSION || version === LEGACY_TYPED_VERSION;
	if (typedVersion) {
		if (buf.length < 64) throw new Error('navgraph v3 artifact too small (truncated header)');
		baseNodeCount = requireCount('base node count', dv.getUint32(52, true), N);
		passageCount = requireCount('passage count', dv.getUint32(56, true), N);
		const revLen = requireCount('revision length', dv.getUint32(60, true), NAVGRAPH_REVISION_MAX_LEN);
		const fixedEnd = version === SUPPORTED_VERSION ? 72 : 64;
		if (buf.length < fixedEnd) throw new Error('navgraph v4 artifact too small (truncated header)');
		if (version === SUPPORTED_VERSION) {
			coarseOriginX = dv.getInt32(64, true);
			coarseOriginY = dv.getInt32(68, true);
		}
		if (fixedEnd + revLen > buf.length) throw new Error('navgraph artifact revision string overruns buffer');
		passageRevision = revLen ? new TextDecoder('ascii').decode(buf.subarray(fixedEnd, fixedEnd + revLen)) : '';
		headerEnd = fixedEnd + revLen;
	}
	const P = passageCount;

	// --- exact byte-length check (rejects truncation and overflow) ---
	const kindsBytes = typedVersion ? E : 0;
	const edgePassageBytes = typedVersion ? E * 4 : 0;
	const passageRangeBytes = typedVersion ? P * 4 * 2 : 0;
	const expected = headerEnd
		+ N * 2 * 4 + E * 2 * 4 + E * 4 + N * 4
		+ kindsBytes + edgePassageBytes + passageRangeBytes
		+ ch * cw + ch * cw + ch * cw * (version === SUPPORTED_VERSION ? 1 : 4) + hh * hw;
	if (expected !== buf.length)
		throw new Error(`navgraph artifact byte length ${buf.length} != expected ${expected} (corrupt/truncated); ${REBUILD_HINT}`);

	let off = headerEnd;
	const nodes = sliceTyped(buf, off, N * 2, Int32Array); off += N * 2 * 4;
	const edges = sliceTyped(buf, off, E * 2, Int32Array); off += E * 2 * 4;
	const weights = sliceTyped(buf, off, E, Float32Array); off += E * 4;
	const components = sliceTyped(buf, off, N, Int32Array); off += N * 4;
	let edgeKinds = null;
	let edgePassage = null;
	let passageNodeStart = new Int32Array(0);
	let passageNodeCount = new Int32Array(0);
	if (typedVersion) {
		edgeKinds = sliceTyped(buf, off, E, Uint8Array); off += E;
		edgePassage = sliceTyped(buf, off, E, Int32Array); off += E * 4;
		passageNodeStart = sliceTyped(buf, off, P, Int32Array); off += P * 4;
		passageNodeCount = sliceTyped(buf, off, P, Int32Array); off += P * 4;
	}
	const coarseMinval = sliceTyped(buf, off, ch * cw, Uint8Array); off += ch * cw;
	const coarseClear = sliceTyped(buf, off, ch * cw, Uint8Array); off += ch * cw;
	const coarseLabels = version === SUPPORTED_VERSION
		? sliceTyped(buf, off, ch * cw, Uint8Array)
		: sliceTyped(buf, off, ch * cw, Int32Array);
	off += ch * cw * (version === SUPPORTED_VERSION ? 1 : 4);
	const coarseHitzone = sliceTyped(buf, off, hh * hw, Uint8Array); off += hh * hw;

	if (typedVersion)
		validatePassageTopology(N, E, P, baseNodeCount, edges, edgeKinds, edgePassage,
			passageNodeStart, passageNodeCount);

	return {
		version, H, W, minCostPerPx, N, E,
		coarseScale, coarseOriginX, coarseOriginY, ch, cw, hitzoneScale, hh, hw,
		nodes, edges, weights, components,
		coarseMinval, coarseClear, coarseLabels, coarseHitzone,
		baseNodeCount, passageCount: P, passageRevision,
		edgeKinds, edgePassage, passageNodeStart, passageNodeCount,
	};
}

/**
 * Strict topology validation for a parsed v3 artifact: edge endpoints in range,
 * every edge kind known and its owning-passage ordinal consistent, and passage
 * node ranges contiguous, ordered, and covering exactly the tail `[baseNodeCount, N)`.
 * Throws on the first violation — a reader never invents a mid-passage transition
 * from corrupt data.
 */
function validatePassageTopology(N, E, P, baseNodeCount, edges, edgeKinds, edgePassage,
	passageNodeStart, passageNodeCount) {
	for (let e = 0; e < E; e++) {
		const u = edges[2 * e], v = edges[2 * e + 1];
		if (u < 0 || u >= N || v < 0 || v >= N)
			throw new Error(`navgraph edge ${e} endpoint out of range`);
		const kind = edgeKinds[e];
		const owner = edgePassage[e];
		if (kind === EDGE_KIND_BASE) {
			if (owner !== -1) throw new Error(`navgraph base edge ${e} must have passage ordinal -1`);
		} else if (kind === EDGE_KIND_PASSAGE || kind === EDGE_KIND_TRANSITION) {
			if (owner < 0 || owner >= P) throw new Error(`navgraph typed edge ${e} owner ${owner} out of range`);
		} else {
			throw new Error(`navgraph edge ${e} has unknown kind ${kind}`);
		}
	}
	let expected = baseNodeCount;
	for (let p = 0; p < P; p++) {
		const s = passageNodeStart[p], c = passageNodeCount[p];
		if (c < 1) throw new Error(`navgraph passage ${p} has non-positive node count ${c}`);
		if (s !== expected) throw new Error(`navgraph passage ${p} start ${s} not contiguous (expected ${expected})`);
		expected += c;
	}
	if (P > 0 && expected !== N)
		throw new Error(`navgraph passage node ranges end at ${expected}, expected N=${N}`);
	if (P === 0 && baseNodeCount !== N)
		throw new Error('navgraph has no passages but baseNodeCount != N');
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
export function astarSubgrid(mask, W, subX0, subY0, subW, subH, sx, sy, gx, gy, wantPath = false, maxExpansions = 200000, deadlineMs = null, regionAllowed = null) {
	const lsx = sx - subX0, lsy = sy - subY0, lgx = gx - subX0, lgy = gy - subY0;
	if (lsx < 0 || lsy < 0 || lgx < 0 || lgy < 0 || lsx >= subW || lsy >= subH || lgx >= subW || lgy >= subH)
		return null;
	const at = (lx, ly) => mask[(subY0 + ly) * W + (subX0 + lx)];
	if (at(lsx, lsy) === IMPASSABLE || at(lgx, lgy) === IMPASSABLE
		|| (regionAllowed && (!regionAllowed(sx, sy) || !regionAllowed(gx, gy)))) return null;
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
			if (regionAllowed && !regionAllowed(subX0 + nx, subY0 + ny)) continue;
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
export function lineCost(mask, W, x0, y0, x1, y1, regionAllowed = null) {
	const dx = x1 - x0, dy = y1 - y0;
	const steps = Math.max(Math.abs(dx), Math.abs(dy)) | 0;
	if (steps === 0) return 0;
	const seg = Math.hypot(dx, dy) / steps;
	const sx = dx / steps, sy = dy / steps;
	let cost = 0;
	for (let k = 1; k <= steps; k++) {
		const xi = Math.round(x0 + sx * k), yi = Math.round(y0 + sy * k);
		if (regionAllowed && !regionAllowed(xi, yi)) return null;
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
	const coarseOriginX = artifact.coarseOriginX || 0;
	const coarseOriginY = artifact.coarseOriginY || 0;

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
				const x0 = coarseOriginX + cx * coarseScale;
				const y0 = coarseOriginY + cy * coarseScale;
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
			const hy = Math.floor((coarseOriginY + cy * coarseScale) / hitzoneScale);
			const hx = Math.floor((coarseOriginX + cx * coarseScale) / hitzoneScale);
			if (hy >= hh || hx >= hw || !coarseHitzone[hy * hw + hx]) continue;
			sampleCells.push(ci);
		}
	}
	const endpointDensity = buildEndpointDensitySampler(artifact, mask, sampleCells, cfg);
	const regionAllowed = (x, y) => {
		const hx = Math.floor(x / hitzoneScale), hy = Math.floor(y / hitzoneScale);
		return hx >= 0 && hy >= 0 && hx < hw && hy < hh
			&& coarseHitzone[hy * hw + hx] !== 0;
	};

	// Region gate: the stored hit zone (the coach-drawn polygon when one was
	// supplied at build time) is authoritative for the WHOLE route, not only
	// its endpoints. Nodes outside it stay in the artifact for connectivity
	// history, but routing must never touch them.
	const nodeInRegion = new Uint8Array(N);
	for (let i = 0; i < N; i++) {
		const hy = Math.floor(nodes[2 * i + 1] / hitzoneScale);
		const hx = Math.floor(nodes[2 * i] / hitzoneScale);
		nodeInRegion[i] = (hy >= 0 && hx >= 0 && hy < hh && hx < hw
			&& coarseHitzone[hy * hw + hx]) ? 1 : 0;
	}
	// Serialized passage nodes (v3, indices [baseNodeCount, N)) were already
	// polygon-checked at build time; the coarse hit-zone raster can clip a node
	// that is legitimately inside the drawn region, so trust the build here and
	// keep every passage node routable (CR 8.3). Base-only artifacts have
	// baseNodeCount === N and this loop is empty.
	for (let i = artifact.baseNodeCount; i < N; i++) nodeInRegion[i] = 1;

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
		artifact, mask, cfg, mainComp, sampleCells, nodeInRegion,
		endpointDensityCumulative: endpointDensity.cumulative,
		endpointDensityTotal: endpointDensity.total,
		buckets, bucketCell: cell, regionAllowed,
		adjStart, adjTo, adjW, adjEdge,
		// Per-pixel memo for inSignificantObstacle (WP 5.3). Sparse Map keyed by
		// flat pixel index — only probed components are stored, each bounded to
		// cfg.barrierFloodCapPx, so memory stays tiny even on the 75 Mpx mask.
		sigMemo: new Map(),
	};
}

/**
 * Build cumulative obstacle-percentage scores for eligible endpoint cells.
 *
 * Picking from these scores is mathematically the accepted distribution of:
 * choose a cell uniformly, then retain it with probability
 * black-pixels / mapped-pixels in its neighbourhood. Using cumulative weights
 * avoids an unbounded rejection loop on sparse maps. A summed-area table on
 * the artifact's existing coarse grid keeps peak memory bounded. Window
 * boundaries are coarse-cell aligned; with the normal 4 px coarse scale this
 * approximates the configured 100 px square to within 4 px on each side.
 */
function buildEndpointDensitySampler(artifact, mask, sampleCells, cfg) {
	const { W, H, cw, ch, coarseScale, coarseHitzone, hw, hh, hitzoneScale } = artifact;
	const coarseOriginX = artifact.coarseOriginX || 0;
	const coarseOriginY = artifact.coarseOriginY || 0;
	const cumulative = new Float64Array(sampleCells.length);
	if (!sampleCells.length || cfg.endpointObstacleWindowPx <= 0)
		return { cumulative, total: 0 };

	const stride = cw + 1;
	const blackIntegral = new Uint32Array((ch + 1) * stride);
	const mappedIntegral = new Uint32Array((ch + 1) * stride);
	for (let cy = 0; cy < ch; cy++) {
		const y0 = coarseOriginY + cy * coarseScale, y1 = Math.min(H, y0 + coarseScale);
		let rowBlack = 0, rowMapped = 0;
		for (let cx = 0; cx < cw; cx++) {
			const x0 = coarseOriginX + cx * coarseScale, x1 = Math.min(W, x0 + coarseScale);
			let black = 0, mapped = 0;
			// Ignore black pixels outside the coach-drawn region. Otherwise the
			// unmapped exterior can look like an enormous "object" and attract
			// endpoints to precisely the region edge we want to de-emphasize. The
			// denominator uses the same mapped footprint so boundary cells are not
			// penalized merely because part of their window lies outside the region.
			const hy = Math.floor((y0 + (y1 - y0) / 2) / hitzoneScale);
			const hx = Math.floor((x0 + (x1 - x0) / 2) / hitzoneScale);
			if (hy >= 0 && hx >= 0 && hy < hh && hx < hw && coarseHitzone[hy * hw + hx]) {
				mapped = (x1 - x0) * (y1 - y0);
				for (let y = y0; y < y1; y++) {
					const row = y * W;
					for (let x = x0; x < x1; x++) if (mask[row + x] === IMPASSABLE) black++;
				}
			}
			rowBlack += black;
			rowMapped += mapped;
			blackIntegral[(cy + 1) * stride + cx + 1]
				= blackIntegral[cy * stride + cx + 1] + rowBlack;
			mappedIntegral[(cy + 1) * stride + cx + 1]
				= mappedIntegral[cy * stride + cx + 1] + rowMapped;
		}
	}

	const halfCells = Math.max(1, Math.ceil(cfg.endpointObstacleWindowPx / (2 * coarseScale)));
	let total = 0;
	for (let i = 0; i < sampleCells.length; i++) {
		const ci = sampleCells[i], cx = ci % cw, cy = (ci - cx) / cw;
		const x0 = Math.max(0, cx - halfCells), x1 = Math.min(cw, cx + halfCells + 1);
		const y0 = Math.max(0, cy - halfCells), y1 = Math.min(ch, cy + halfCells + 1);
		const blackCount = blackIntegral[y1 * stride + x1] - blackIntegral[y0 * stride + x1]
			- blackIntegral[y1 * stride + x0] + blackIntegral[y0 * stride + x0];
		const mappedCount = mappedIntegral[y1 * stride + x1] - mappedIntegral[y0 * stride + x1]
			- mappedIntegral[y1 * stride + x0] + mappedIntegral[y0 * stride + x0];
		const score = mappedCount > 0 ? blackCount / mappedCount : 0;
		total += score;
		cumulative[i] = total;
	}
	return { cumulative, total };
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

// -----------------------------------------------------------------------------
// CR 8.3 — consume the *serialized* v3 passage topology instead of a dynamic
// overlay. Passage nodes are already baked into the CSR (`[baseNodeCount, N)`);
// the only thing the runtime still needs from the canonical document is the
// per-passage raster (for surface-aware refinement, obstacle scoring, and
// layered distinctness). `attachSerializedPassages` verifies the fetched
// document against the artifact's baked revision (a mismatch is a stale build,
// never an empty-passage fallback) and indexes the rasters by passage id, using
// the same codepoint id sort as project/navgraph.py to map ordinal -> id.
// -----------------------------------------------------------------------------

/** Passage ids in the artifact's canonical ordinal order (codepoint id sort). */
function canonicalOrdinalIds(passages) {
	return passages
		.map((passage) => String(passage.id))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function attachSerializedPassages(state, documentOrItems) {
	const { artifact } = state;
	const { W, H, N } = artifact;
	if (artifact.version !== SUPPORTED_VERSION || !artifact.edgeKinds)
		throw new Error('serialized passages require a v3 navgraph artifact');
	const revision = passageRevision(documentOrItems, W, H);
	if (revision !== artifact.passageRevision)
		throw new Error(`passage document revision ${revision} != artifact ${artifact.passageRevision} `
			+ `(stale build); ${REBUILD_HINT}`);
	const normalized = normalizePassagesForRuntime(documentOrItems, { mapWidth: W, mapHeight: H });
	if (normalized.passages.length !== artifact.passageCount)
		throw new Error(`passage document has ${normalized.passages.length} runtime passages `
			+ `but artifact serialized ${artifact.passageCount}; ${REBUILD_HINT}`);

	const passageById = new Map();
	for (const passage of normalized.passages) passageById.set(String(passage.id), passage);
	// Ordinal p (0..P-1) is the p-th passage in codepoint id order — the exact
	// order project/navgraph.py appended passage node ranges and typed edges in.
	const ordinalIds = canonicalOrdinalIds(normalized.passages);

	// Per-node owning-passage ordinal (base nodes = -1). Drives typed-leg
	// classification and surface-aware barrier matching from the CSR alone.
	const nodeToOrdinal = new Int32Array(N).fill(-1);
	for (let p = 0; p < artifact.passageCount; p++) {
		const start = artifact.passageNodeStart[p];
		const count = artifact.passageNodeCount[p];
		for (let n = start; n < start + count; n++) nodeToOrdinal[n] = p;
	}

	// Cheapest per-pixel cost across base + every passage surface — keeps the
	// graph A* heuristic admissible now that passage edges are in the CSR.
	let minCostPerPx = Number.isFinite(artifact.minCostPerPx) ? artifact.minCostPerPx : 0;
	for (const passage of normalized.passages) {
		for (let i = 0; i < passage.grid.length; i++) {
			const value = passage.grid[i];
			if (value > 0) minCostPerPx = Math.min(minCostPerPx, 255 - value);
		}
	}

	state.serializedPassages = {
		passageById,
		ordinalIds,
		nodeToOrdinal,
		passages: normalized.passages,
		minCostPerPx,
		diagnostics: normalized.diagnostics,
	};
	// A serialized v3 artifact is the single source of passage topology — never
	// also run the dynamic overlay on the same state (CR 8.3).
	state.passageOverlay = null;
	state.passageRevision = revision;
	state.passageDiagnostics = normalized.diagnostics;
	return {
		revision,
		diagnostics: normalized.diagnostics,
		passageCount: artifact.passageCount,
		passageNodeCount: N - artifact.baseNodeCount,
		passageEdges: countEdgesOfKind(artifact, EDGE_KIND_PASSAGE),
		transitions: countEdgesOfKind(artifact, EDGE_KIND_TRANSITION),
	};
}

function countEdgesOfKind(artifact, kind) {
	if (!artifact.edgeKinds) return 0;
	let count = 0;
	for (let e = 0; e < artifact.E; e++) if (artifact.edgeKinds[e] === kind) count++;
	return count;
}

/** Runtime passage raster for a leg's passage id (serialized or dynamic overlay). */
function passageForId(state, passageId) {
	const key = String(passageId);
	return state.serializedPassages?.passageById?.get(key)
		|| state.passageOverlay?.passageById?.get(key)
		|| null;
}

/** Active runtime passages regardless of topology source. */
function activePassages(state) {
	return state.serializedPassages?.passages || state.passageOverlay?.passages || [];
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
	const x0 = (artifact.coarseOriginX || 0) + cx * coarseScale;
	const y0 = (artifact.coarseOriginY || 0) + cy * coarseScale;
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
	const start = pixelInCell(state, sampleEndpointCell(state, rng), rng);
	if (!start) return { reason: 'empty' };
	// Sample a goal inside the distance band.
	let goal = null, dist = 0;
	for (let t = 0; t < cfg.goalSampleTries; t++) {
		const g = pixelInCell(state, sampleEndpointCell(state, rng), rng);
		if (!g) continue;
		const d = Math.hypot(g.x - start.x, g.y - start.y);
		if (d >= cfg.distMinPx && d <= cfg.distMaxPx) { goal = g; dist = d; break; }
	}
	if (!goal) return { reason: 'distance' };
	if (!crossesObstacle(mask, W, start, goal, cfg.obstacleMinRunPx)) return { reason: 'obstacle' };
	return { start, goal, dist };
}

/** Absolute + proportional lateral-separation threshold for one route pair. */
export function routeSideGapMinimumPx(config, directDistancePx) {
	const floor = Number.isFinite(config?.sideGapMinPx) ? Math.max(0, config.sideGapMinPx) : 0;
	const fraction = Number.isFinite(config?.sideGapMinDirectFraction)
		? Math.max(0, config.sideGapMinDirectFraction)
		: 0;
	const distance = Number.isFinite(directDistancePx) ? Math.max(0, directDistancePx) : 0;
	return Math.max(floor, distance * fraction);
}

/** Choose an eligible coarse cell by local obstacle percentage. */
function sampleEndpointCell(state, rng) {
	const { sampleCells, cfg } = state;
	const cumulative = state.endpointDensityCumulative;
	const total = state.endpointDensityTotal;
	// Obstacle-free maps have no meaningful feature signal; remain usable by
	// falling back to uniform sampling instead of rejecting every endpoint.
	if (!(total > 0) || rng() < cfg.endpointUniformMix)
		return sampleCells[(rng() * sampleCells.length) | 0];
	const target = rng() * total;
	let lo = 0, hi = cumulative.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (target < cumulative[mid]) hi = mid;
		else lo = mid + 1;
	}
	return sampleCells[lo];
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
				// Control endpoints and sample targets snap to BASE nodes only —
				// a serialized passage node is reachable only by first traversing a
				// transition edge, never by a direct snap (CR 8.3). Base-only
				// artifacts have baseNodeCount === N, so this excludes nothing.
				if (ni >= artifact.baseNodeCount) continue;
				// Routes must never touch a node outside the stored region.
				if (state.nodeInRegion && !state.nodeInRegion[ni]) continue;
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
		let cost = lineCost(mask, W, pt.x, pt.y, nx, ny, state.regionAllowed);
		if (cost === null) {
			const m = cfg.snapAstarMargin;
			const x0 = Math.max(0, Math.min(pt.x, nx) - m), y0 = Math.max(0, Math.min(pt.y, ny) - m);
			const x1 = Math.min(W, Math.max(pt.x, nx) + m + 1), y1 = Math.min(H, Math.max(pt.y, ny) + m + 1);
			const res = astarSubgrid(mask, W, x0, y0, x1 - x0, y1 - y0, pt.x, pt.y, nx, ny, false, 200000, deadline, state.regionAllowed);
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
	const heuristicCostPerPx = state.serializedPassages?.minCostPerPx
		?? state.passageOverlay?.minCostPerPx ?? minCostPerPx;
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
		// The stored region hit zone is authoritative for the whole route: a
		// base node outside it may never appear on a served node path.
		if (to < N && state.nodeInRegion && !state.nodeInRegion[to]) return;
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

/** Append `path` to `legs`, merging into the trailing leg when identity matches. */
function appendTypedLeg(legs, surface, passageId, direction, path) {
	if (!path?.length) return;
	let leg = legs[legs.length - 1];
	if (!leg || leg.surface !== surface || (surface !== 'base' && leg.direction !== direction)) {
		leg = { surface, passageId, direction, points: [] };
		legs.push(leg);
	}
	for (const point of path) {
		const previous = leg.points[leg.points.length - 1];
		if (!previous || previous.x !== point.x || previous.y !== point.y) leg.points.push({ x: point.x, y: point.y });
	}
}

/**
 * Convert a serialized-topology node path (virtual START=N, GOAL=N+1) into
 * surface-typed legs directly from the baked node ordinals (CR 8.3). Consecutive
 * same-ordinal passage nodes form one `passage:<id>` leg; a transition edge
 * (base <-> passage endpoint) reads as base up to the shared endpoint coordinate,
 * so identity changes exactly at the serialized endpoint. Base edges that merely
 * cross a passage projection stay base.
 */
export function nodePathToTypedRouteSerialized(state, nodePath, start, goal) {
	const { artifact, serializedPassages } = state;
	const { N, nodes } = artifact;
	const { nodeToOrdinal, ordinalIds } = serializedPassages;
	const coordOf = (id) => (id === N ? { x: start.x, y: start.y }
		: id === N + 1 ? { x: goal.x, y: goal.y }
			: { x: nodes[2 * id], y: nodes[2 * id + 1] });
	const legs = [];
	for (let i = 1; i < nodePath.length; i++) {
		const from = nodePath[i - 1];
		const to = nodePath[i];
		let surface = 'base';
		let passageId = null;
		let direction = null;
		if (from < N && to < N) {
			const of = nodeToOrdinal[from];
			const ot = nodeToOrdinal[to];
			if (of >= 0 && of === ot) {
				passageId = ordinalIds[of];
				surface = `passage:${passageId}`;
				// Passage nodes are stored in centreline order, so a rising index
				// travels from the start endpoint toward the end endpoint.
				direction = from < to ? 'from-start' : 'from-end';
			}
		}
		appendTypedLeg(legs, surface, passageId, direction, [coordOf(from), coordOf(to)]);
	}
	const path = [];
	for (const leg of legs) {
		for (const point of leg.points) {
			const previous = path[path.length - 1];
			if (!previous || previous.x !== point.x || previous.y !== point.y) path.push({ x: point.x, y: point.y });
		}
	}
	return { path, legs };
}

/** Pick the typed-route builder for the active topology source (CR 8.3). */
function typedRouteFor(state, nodePath, start, goal) {
	if (state.serializedPassages?.passages?.length)
		return nodePathToTypedRouteSerialized(state, nodePath, start, goal);
	if (state.passageOverlay?.nodeCount)
		return nodePathToTypedRoute(state, nodePath, start, goal);
	return { path: nodePathToCoords(state, nodePath, start, goal), legs: null };
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

/**
 * Edge indices whose node-node segment crosses any active barrier, matched by
 * surface. A serialized base/transition edge is tested only against base
 * barriers; a serialized passage edge only against its own `passage:<id>`
 * barrier — so a projected base barrier never blocks the passage chain and a
 * passage barrier never blocks the underpass (CR 8.3). Legacy dynamic overlays
 * keep their separate dynamic-edge blocking.
 */
export function blockedByBarriers(state, barriers) {
	const { artifact, cfg } = state;
	const { E, edges, nodes, edgeKinds, edgePassage } = artifact;
	const ordinalIds = state.serializedPassages?.ordinalIds;
	const blocked = new Set();
	if (!barriers.length) {
		return state.passageOverlay?.nodeCount ? { baseEdges: blocked, dynamicEdges: new Set() } : blocked;
	}
	const width = Number.isFinite(cfg?.barrierWidthPx) && cfg.barrierWidthPx > 0
		? cfg.barrierWidthPx
		: BARRIER_DRAW_WIDTH_MASK_PX;
	const intersectsStroke = (x0, y0, x1, y1, b) => {
		const dx = b.bx - b.ax, dy = b.by - b.ay;
		const len = Math.hypot(dx, dy);
		if (len < 1e-9) return false;
		const ux = dx / len, uy = dy / len;
		const toLocal = (x, y) => {
			const rx = x - b.ax, ry = y - b.ay;
			return { x: rx * ux + ry * uy, y: -rx * uy + ry * ux };
		};
		const a = toLocal(x0, y0), c = toLocal(x1, y1);
		const half = width / 2;
		// Liang-Barsky segment-vs-rectangle test. The rectangle matches an SVG
		// line with stroke-linecap="butt": no hidden round-cap extension.
		let t0 = 0, t1 = 1;
		const clip = (p, q) => {
			if (Math.abs(p) < 1e-12) return q >= 0;
			const r = q / p;
			if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
			else { if (r < t0) return false; if (r < t1) t1 = r; }
			return true;
		};
		const ex = c.x - a.x, ey = c.y - a.y;
		return clip(-ex, a.x) && clip(ex, len - a.x)
			&& clip(-ey, a.y + half) && clip(ey, half - a.y);
	};
	for (let e = 0; e < E; e++) {
		const u = edges[2 * e], v = edges[2 * e + 1];
		const ux = nodes[2 * u], uy = nodes[2 * u + 1], vx = nodes[2 * v], vy = nodes[2 * v + 1];
		// A serialized passage edge lives on its passage surface; base and
		// transition (endpoint connector) edges are base terrain.
		let surface = 'base';
		if (edgeKinds && edgeKinds[e] === EDGE_KIND_PASSAGE && ordinalIds) {
			surface = `passage:${ordinalIds[edgePassage[e]]}`;
		}
		for (const b of barriers) {
			if ((b.surface || 'base') !== surface) continue;
			if (intersectsStroke(ux, uy, vx, vy, b)) { blocked.add(e); break; }
		}
	}
	if (!state.passageOverlay?.nodeCount) return blocked;
	return {
		baseEdges: blocked,
		dynamicEdges: blockedDynamicEdges(
			state,
			barriers,
			(x0, y0, x1, y1, ax, ay, bx, by) =>
				intersectsStroke(x0, y0, x1, y1, { ax, ay, bx, by }),
		),
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

/**
 * A passage route is represented in the sparse graph by a thin centreline.
 * `findBarrier()` therefore measures the obstacle gap around whichever single
 * centreline edge it crosses, which can be much shorter than the actual
 * passage width. Extend a passage-surface blocker symmetrically so the same
 * geometry used for rendering, graph blocking, and full-resolution refinement
 * closes the complete corridor plus a small overhang.
 */
export function widenPassageBarrier(state, barrier) {
	if (!barrier?.surface?.startsWith('passage:')) return barrier;
	const passageId = barrier.surface.slice('passage:'.length);
	const passage = passageForId(state, passageId);
	const passageWidth = Number(passage?.width);
	if (!(passageWidth > 0)) return barrier;
	const overhang = Number.isFinite(state.cfg?.passageBarrierOverhangPx)
		? Math.max(0, state.cfg.passageBarrierOverhangPx)
		: 2;
	const requiredLength = passageWidth + 2 * overhang;
	const dx = barrier.bx - barrier.ax, dy = barrier.by - barrier.ay;
	const length = Math.hypot(dx, dy);
	if (!(length > 1e-9) || length >= requiredLength) {
		barrier.passageWidthPx = passageWidth;
		return barrier;
	}
	const mx = (barrier.ax + barrier.bx) / 2;
	const my = (barrier.ay + barrier.by) / 2;
	const half = requiredLength / 2;
	const ux = dx / length, uy = dy / length;
	barrier.ax = mx - ux * half;
	barrier.ay = my - uy * half;
	barrier.bx = mx + ux * half;
	barrier.by = my + uy * half;
	barrier.passageWidthPx = passageWidth;
	barrier.passageBarrierOverhangPx = overhang;
	return barrier;
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
		const typed = typedRouteFor(state, res.nodePath, start, goal);
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
		widenPassageBarrier(state, barrier);
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
 * runtime used by the refined-route gap check.
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
		const straight = lineCost(mask, W, a.x, a.y, b.x, b.y, state.regionAllowed);
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
		const res = astarSubgrid(mask, W, x0, y0, x1 - x0, y1 - y0, a.x, a.y, b.x, b.y, true, 1500000, null, state.regionAllowed);
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
			if (mask[yi * W + xi] === IMPASSABLE
				|| (state.regionAllowed && !state.regionAllowed(xi, yi))) hits++;
		}
	}
	return hits;
}

// Keep the uploaded-map obstacle penalty identical to editor.js. The worker
// already owns the full-resolution mask, so calculate this before converting
// the served route to map units for rendering.
const ROUTE_OBSTACLE_THRESHOLD = 200;
const ROUTE_OBSTACLE_SECONDS_PER_ENTRY = 1;
const ROUTE_STAIR_VALUE = 242;
const ROUTE_STAIR_SECONDS_PER_ENTRY = 0.25;

export function calcRouteObstacle(mask, width, height, path, passageSpans = []) {
	if (!mask || !width || !height || !path || path.length < 2) return 0;

	let seconds = 0;
	let terrain = null;
	let lastX = null;
	let lastY = null;

	function visit(x, y) {
		if (x === lastX && y === lastY) return;
		lastX = x;
		lastY = y;
		if (x < 0 || x >= width || y < 0 || y >= height) {
			terrain = null;
			return;
		}
		const value = mask[y * width + x];
		const nextTerrain = value < ROUTE_OBSTACLE_THRESHOLD
			? 'obstacle'
			: value === ROUTE_STAIR_VALUE
				? 'stairs'
				: null;
		if (nextTerrain && nextTerrain !== terrain) {
			seconds += nextTerrain === 'stairs'
				? ROUTE_STAIR_SECONDS_PER_ENTRY
				: ROUTE_OBSTACLE_SECONDS_PER_ENTRY;
		}
		terrain = nextTerrain;
	}

	for (let i = 1; i < path.length; i++) {
		const onPassage = passageSpans.some((span) => (
			i - 1 >= Number(span?.fromIndex) && i <= Number(span?.toIndex)
		));
		if (onPassage) {
			terrain = null;
			lastX = null;
			lastY = null;
			continue;
		}

		let x0 = Math.round(Number(path[i - 1]?.x));
		let y0 = Math.round(Number(path[i - 1]?.y));
		const x1 = Math.round(Number(path[i]?.x));
		const y1 = Math.round(Number(path[i]?.y));
		if (![x0, y0, x1, y1].every(Number.isFinite)) continue;

		const dx = Math.abs(x1 - x0);
		const dy = Math.abs(y1 - y0);
		const sx = x0 < x1 ? 1 : -1;
		const sy = y0 < y1 ? 1 : -1;
		let err = dx - dy;
		while (true) {
			visit(x0, y0);
			if (x0 === x1 && y0 === y1) break;
			const e2 = 2 * err;
			if (e2 > -dy) { err -= dy; x0 += sx; }
			if (e2 < dx) { err += dx; y0 += sy; }
		}
	}

	// editor.js rounds the auto-detected value to one decimal before assigning
	// route.obstacle and calculating route.run_time. Return that route-level
	// value here as well so Infinity's total and its one-decimal breakdown agree.
	return Math.max(0, Math.round(seconds * 10) / 10);
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
	const passage = passageForId(state, leg.passageId);
	if (!passage || !leg.points?.length) return { mode: 'unusable', tTheta: 0 };
	const legalPath = leg.points.map((point) => ({ x: point.x, y: point.y }));
	const legalCost = passagePolylineCost(passage, legalPath);
	if (legalCost === null) return { mode: 'unusable', legalPath, legalCost: Infinity, tTheta: 0 };

	const denseGlobal = [];
	for (const point of legalPath) denseGlobal.push(point.x, point.y);
	const t0 = nowMs();
	let refinedFlat = null;
	try {
		// This is deliberately the editor's implementation, not a parallel
		// approximation. It searches the complete passage raster, integrates the
		// greyscale line cost, and applies the cost-aware simplifier before pinning
		// the (subsequently optimizable) portal anchors.
		refinedFlat = refineEditorDenseLeg(denseGlobal, {
			grid: passage.grid,
			w: passage.localWidth,
			h: passage.localHeight,
			originX: passage.originX,
			originY: passage.originY,
			refineFullRaster: true,
		}, state.cfg?.corridorRadius || 24);
	} catch (_) {
		refinedFlat = null;
	}
	const tTheta = nowMs() - t0;
	if (!refinedFlat || refinedFlat.length < 4) {
		return { mode: 'legal-fallback', legalPath, legalCost, path: legalPath, cost: legalCost, tTheta };
	}
	const path = [];
	for (let i = 0; i < refinedFlat.length; i += 2) {
		path.push({ x: refinedFlat[i], y: refinedFlat[i + 1] });
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

function basePolylineCost(state, points) {
	let cost = 0;
	for (let i = 1; i < points.length; i++) {
		const value = lineCost(
			state.mask, state.artifact.W,
			points[i - 1].x, points[i - 1].y, points[i].x, points[i].y,
			state.regionAllowed,
		);
		if (value === null) return null;
		cost += value;
	}
	return cost;
}

/**
 * Run the editor's post-refinement portal coordinate descent on an Infinity
 * typed route. The base surface is cropped around this route (rather than the
 * full map) and receives the route's active base barriers before optimization,
 * so sliding an anchor cannot reopen a blocked alternative or leave the saved
 * Infinity region.
 */
function optimizeInfinityPortalAnchors(state, legs, barriers, routeIndex) {
	if (!legs.some((leg) => leg.surface !== 'base')) return null;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	let maxPassageWidth = 0;
	for (const leg of legs) {
		for (const point of leg.points || []) {
			minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
			maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
		}
		if (leg.surface !== 'base') {
			maxPassageWidth = Math.max(maxPassageWidth, Number(passageForId(state, leg.passageId)?.width) || 0);
		}
	}
	if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
	const margin = Math.max(
		(Number.isFinite(state.cfg?.corridorRadius) ? state.cfg.corridorRadius : 24) + 8,
		Math.ceil(maxPassageWidth / 2) + 4,
	);
	const { W, H } = state.artifact;
	const x0 = Math.max(0, Math.floor(minX) - margin);
	const y0 = Math.max(0, Math.floor(minY) - margin);
	const x1 = Math.min(W - 1, Math.ceil(maxX) + margin);
	const y1 = Math.min(H - 1, Math.ceil(maxY) + margin);
	const w = x1 - x0 + 1, h = y1 - y0 + 1;
	if (w < 3 || h < 3) return null;
	const grid = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		const gy = y0 + y;
		for (let x = 0; x < w; x++) {
			const gx = x0 + x;
			grid[y * w + x] = state.regionAllowed && !state.regionAllowed(gx, gy)
				? IMPASSABLE
				: state.mask[gy * W + gx];
		}
	}
	const width = Number.isFinite(state.cfg?.barrierWidthPx)
		? state.cfg.barrierWidthPx
		: BARRIER_DRAW_WIDTH_MASK_PX;
	for (const barrier of activeSurfaceBarriers(barriers, routeIndex, 'base')) {
		stampBarrierLine(grid, w, h,
			barrier.ax - x0, barrier.ay - y0,
			barrier.bx - x0, barrier.by - y0, width);
	}

	const flatLegs = legs.map((leg) => ({
		...leg,
		points: (leg.points || []).flatMap((point) => [point.x, point.y]),
	}));
	const t0 = nowMs();
	let optimized;
	try {
		optimized = optimizeRefinedPortalAnchors(
			{ legs: flatLegs },
			{ grid, w, h, originX: x0, originY: y0 },
			activePassages(state),
			Number.isFinite(state.cfg?.corridorRadius) ? state.cfg.corridorRadius : 24,
		);
	} catch (_) {
		return null;
	}
	if (!optimized?.legs || !(optimized.portalOptimization?.accepted > 0)) return null;
	const optimizedLegs = optimized.legs.map((leg) => {
		const points = [];
		for (let i = 0; i < leg.points.length; i += 2) points.push({ x: leg.points[i], y: leg.points[i + 1] });
		return { ...leg, points };
	});
	let cost = 0;
	for (const leg of optimizedLegs) {
		const legCost = leg.surface === 'base'
			? basePolylineCost(state, leg.points)
			: passagePolylineCost(passageForId(state, leg.passageId), leg.points);
		if (legCost === null) return null;
		cost += legCost;
	}
	return {
		legs: optimizedLegs,
		cost,
		tTheta: nowMs() - t0,
		portalOptimization: optimized.portalOptimization,
	};
}

/** Surface-aware legal/Theta refinement for a navgraph route with passage legs. */
export function refineTypedNavgraphRoute(state, route, barriers, opts = {}) {
	if (!route?.typedLegs) return refineRouteTheta(state, route.path, barriers, opts);
	const routeIndex = Number.isFinite(opts.routeIndex) ? opts.routeIndex : Infinity;
	const selectedLegs = [];
	const legalLegs = [];
	const legOutcomes = [];
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
		legOutcomes.push({
			surface: leg.surface,
			mode: refined.mode,
			thetaFail: refined.thetaFail || null,
		});
		if (refined.mode === 'unusable') {
			return { path: route.path, cost: route.cost, mode: 'unusable', legalPath: route.path,
				legalCost: route.cost, tRefine, tTheta, activeBarriers: [], routeIndex,
				thetaFail: refined.thetaFail || 'unusable-leg', legOutcomes };
		}
		if (refined.mode !== 'theta') fallback = true;
		selectedCost += refined.cost;
		legalCost += refined.legalCost;
		selectedLegs.push({ ...leg, points: refined.path });
		legalLegs.push({ ...leg, points: refined.legalPath });
	}
	let portalOptimization = null;
	if (!fallback) {
		const optimized = optimizeInfinityPortalAnchors(
			state, selectedLegs, barriers, routeIndex,
		);
		if (optimized) {
			selectedLegs.splice(0, selectedLegs.length, ...optimized.legs);
			selectedCost = optimized.cost;
			tTheta += optimized.tTheta;
			portalOptimization = optimized.portalOptimization;
		}
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
		thetaFail: fallback
			? legOutcomes.filter((outcome) => outcome.mode !== 'theta')
				.map((outcome) => outcome.thetaFail || `${outcome.surface}-fallback`).join(',')
			: null,
		legOutcomes,
		tRefine,
		tTheta,
		activeBarriers,
		routeIndex,
		typedLegs: selectedLegs,
		legalTypedLegs: legalLegs,
		passageSpans: selected.passageSpans,
		legalPassageSpans: legal.passageSpans,
		portalOptimization,
	};
}

export function countTypedLegalityViolations(state, typedLegs) {
	let hits = 0;
	for (const leg of typedLegs || []) {
		if (leg.surface === 'base') {
			hits += countLegalityViolations(state, leg.points);
		} else {
			const passage = passageForId(state, leg.passageId);
			if (!passage || passagePolylineCost(passage, leg.points) === null) hits++;
		}
	}
	return hits;
}

function countTypedBarrierViolations(state, refined) {
	const width = Number.isFinite(state.cfg?.barrierWidthPx)
		? state.cfg.barrierWidthPx
		: BARRIER_DRAW_WIDTH_MASK_PX;
	if (!refined.typedLegs) return countBarrierViolations(refined.path, refined.activeBarriers, width);
	let hits = 0;
	for (const leg of refined.typedLegs) {
			hits += countBarrierViolations(
			leg.points,
			activeSurfaceBarriers(refined.activeBarriers, refined.routeIndex, leg.surface),
			width,
		);
	}
	return hits;
}

/**
 * Decide whether two final refinement outcomes may be exposed as a route pair.
 * `unusable` is never valid. Under the production `reject` policy both routes
 * must have completed the any-angle Theta* stage; the dense legal spine is
 * only an internal corridor input and a diagnostic fallback.
 */
export function refinementPairCanBeServed(policy, modeA, modeB) {
	if (modeA === 'unusable' || modeB === 'unusable') return false;
	return policy !== 'reject' || (modeA === 'theta' && modeB === 'theta');
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
 *   obstacles?: [number, number],            // editor-compatible entry penalties in seconds
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
		const sideGapMinPx = routeSideGapMinimumPx(cfg, sp.dist);
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
			config: {
				...selectionDefaults,
				minSideGap: sideGapMinPx,
				maxRelativeGap: cfg.maxRelativeGap,
				maxRouteIndexGap: cfg.maxSelectedRouteIndexGap,
			},
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
		// Candidate R was discovered with every cumulative barrier before R, but
		// only `skippedBarriers` exists in the final scene. Refine the accepted
		// geometry against exactly that set so invisible later barriers cannot
		// leave unexplained bends. Re-run the final refinement against the rendered
		// blocker set without changing passage surface identity.
		const finalRefineOpts = {
			routeIndex: Infinity,
			now: clock,
			corridorRadius: cfg.finalCorridorRadius,
			budgetMs: cfg.finalRefineBudgetMs,
		};
		const refA = ordered[0].typedLegs
			? refineTypedNavgraphRoute(state, ordered[0], skippedBarriers, finalRefineOpts)
			: refineRouteTheta(state, ordered[0].path, skippedBarriers, finalRefineOpts);
		const refB = ordered[1].typedLegs
			? refineTypedNavgraphRoute(state, ordered[1], skippedBarriers, finalRefineOpts)
			: refineRouteTheta(state, ordered[1].path, skippedBarriers, finalRefineOpts);
		timings.refine += (refA.tRefine || 0) + (refB.tRefine || 0);
		timings.theta += (refA.tTheta || 0) + (refB.tTheta || 0);

		// A final route is valid only when the configured refinement policy allows
		// both outcomes. Production uses `reject`, so any Theta* abort retries the
		// pair instead of exposing the dense legal spine.
		if (!refinementPairCanBeServed(cfg.refineTimeoutPolicy, refA.mode, refB.mode)) {
			bump('timeout'); lastReason = 'timeout'; retries++; continue;
		}
		let pathA = refA.path, costA = refA.cost, modeA = refA.mode;
		let pathB = refB.path, costB = refB.cost, modeB = refB.mode;
		let typedA = refA.typedLegs || null, typedB = refB.typedLegs || null;
		let passageSpansA = refA.passageSpans || [], passageSpansB = refB.passageSpans || [];
		let refineFallback = 0;
		let finalSideGap = sel.sideGap;
		if (modeA === 'legal-fallback' || modeB === 'legal-fallback') {
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

		// The wider rendered-barrier-only pass is allowed to shorten a homotopy,
		// but not to collapse the two alternatives onto one side. Re-run the same
		// side/centre/lateral gate on the geometry that will actually be served.
		const finalPairGate = selection.selectWeightedRoutePair([
			{ path: pathA, run_time: costA, routeIndex: ordered[0].routeIndex },
			{ path: pathB, run_time: costB, routeIndex: ordered[1].routeIndex },
		], {
			start: sp.start,
			goal: sp.goal,
			config: {
				...selectionDefaults,
				minSideGap: sideGapMinPx,
				maxRelativeGap: cfg.maxRelativeGap,
				maxRouteIndexGap: Infinity,
			},
			rng: () => 0,
		});
		if (!finalPairGate.ok) {
			bump(finalPairGate.reason); lastReason = finalPairGate.reason; retries++; continue;
		}
		finalSideGap = finalPairGate.sideGap;

		// Barrier legality: a served route must not cross any of its active
		// barriers. θ* routes are barrier-clean by construction (validated on the
		// stamped subgrid); a legal-spine fallback is barrier-unaware, so guard it
		// here — if it crosses, the pair can't be served (reuse `timeout`: the
		// refinement failed to produce a barrier-clean route in budget).
		const barrierRefA = { ...refA, path: pathA, typedLegs: typedA };
		const barrierRefB = { ...refB, path: pathB, typedLegs: typedB };
		if (countTypedBarrierViolations(state, barrierRefA)
			+ countTypedBarrierViolations(state, barrierRefB) > 0) {
			bump('timeout'); lastReason = 'timeout'; retries++; continue;
		}
		// The purple bars are scene-wide visual obstacles.  Keep an explicit
		// invariant against the exact rendered subset as defence in depth: both
		// selected routes must avoid every rendered barrier on the matching
		// surface, independent of their individual attempt histories.
		const renderedBarrierRefA = {
			...barrierRefA, activeBarriers: skippedBarriers, routeIndex: Infinity,
		};
		const renderedBarrierRefB = {
			...barrierRefB, activeBarriers: skippedBarriers, routeIndex: Infinity,
		};
		if (countTypedBarrierViolations(state, renderedBarrierRefA)
			+ countTypedBarrierViolations(state, renderedBarrierRefB) > 0) {
			bump('timeout'); lastReason = 'timeout'; retries++; continue;
		}

		// Re-check the relative gap on the θ*-refined runtimes.
		const rtA = costA, rtB = costB;
		const faster = Math.min(rtA, rtB), slower = Math.max(rtA, rtB);
		const relGap = faster > 0 ? (slower - faster) / faster : Infinity;
		if (relGap > cfg.maxRelativeGap) { bump('runtime_refined'); lastReason = 'runtime_refined'; retries++; continue; }

		// Balance reject (post-refinement): too-close routes are a coin-flip
		// choice — drop them with cfg.balanceRejectProbability and retry.
		if (relGap <= cfg.balanceRejectMaxRelativeGap && rng() < cfg.balanceRejectProbability) {
			bump('balanced'); lastReason = 'balanced'; retries++; continue;
		}

		// Surface-aware pair distinctness: two routes that share their passage
		// traversal are not a route choice even when a level-0 obstacle projected
		// underneath the passage technically separates the two lines. Reuse the
		// editor's layered distinctness on the refined pair; base-only pairs keep
		// the established selection tuning untouched.
		const layeredPassages = activePassages(state);
		if ((passageSpansA.length || passageSpansB.length) && layeredPassages.length) {
			const candidateRoute = pathA.slice();
			candidateRoute.passageSpans = passageSpansA;
			const existingRoute = pathB.slice();
			existingRoute.passageSpans = passageSpansB;
			const verdict = layeredRouteDistinct(
				candidateRoute, [existingRoute],
				state.mask, state.artifact.W, state.artifact.H,
				layeredPassages,
			);
			if (!verdict.distinct) { bump('distinct'); lastReason = 'distinct'; retries++; continue; }
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
			routeIndexes: [ordered[0].routeIndex, ordered[1].routeIndex],
			runtimes: [rtA, rtB],
			obstacles: [
				calcRouteObstacle(state.mask, state.artifact.W, state.artifact.H, pathA, passageSpansA),
				calcRouteObstacle(state.mask, state.artifact.W, state.artifact.H, pathB, passageSpansB),
			],
			passageSpans: [passageSpansA, passageSpansB],
			// All bars placed while exploring alternates.  The scene uses the
			// skipped subset for rendering; retaining the full set makes the worker
			// result auditable and lets verification assert every placement.
			barriers: routeResult.barriers,
			skippedBarriers,
			meta: {
				retries,
				attempts: attempts + 1,
				sideGap: finalSideGap,
				sideGapMin: sideGapMinPx,
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
