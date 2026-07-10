// =============================================================================
// refine_theta.js — corridor + guided θ* refinement of a served mask route
// (Phase 5, WP 5.2). The full-quality, any-angle, terrain-weighted refinement
// the editor pipeline (pipeline.js `runPipeline`) applies, layered on top of an
// accepted navgraph route — reusing the editor modules (preprocess / theta_star
// / simplify) verbatim.
//
// Same-dir relative imports work unchanged in Node (harness) and in the browser
// worker. Nothing here touches the DOM, `self`, or the network.
//
// Public entry point:
//   refineRouteTheta(state, path, barriers, opts) -> { path, cost, mode, ... }
//
// The refinement of one route (mirrors the tail of runPipeline):
//   1. legal spine  = refineRouteLegal(path)   — plays the `wps` role; the
//      corridor is built around it so it always contains ≥1 legal path (itself).
//      Raw graph node chains are NOT fed to the corridor (long builder-A*
//      detour edges can stray far from the node-node straight line and a
//      radius-24 corridor would sever them).
//   2. subgrid      = bbox(spine) + (corridorRadius + 8) margin, from the true
//      full-res mask (no margin-growth loop — the spine tells us the region).
//   3. barriers     = every barrier with attemptIndex < routeIndex stamped into
//      the subgrid as impassable thick lines (the mask-mode analogue of the
//      editor's applyBlockedTerrain overlay). Single width constant
//      BARRIER_DRAW_WIDTH_MASK_PX (WP 5.3's shared source of truth).
//   4. corridorMask -> applyCorridor -> guidedThetaStar (switch radius 10, with
//      an optional deadline) -> simplifyThetaPath (10°, 5 px).
//   5. runtime      = Σ lineCost over the FINAL polyline on the TRUE mask (bars
//      are virtual fences — terrain cost is real).
//   6. timeout/failure -> `legal-fallback` (serve the legal spine); the pair
//      only rejects (`timeout`) if the legal spine itself is unusable. The
//      fallback/reject policy is coordinated by the caller (generateOnePair)
//      via `refineTimeoutPolicy`; this function reports the per-route outcome.
// =============================================================================

import { refineRouteLegal, countLegalityViolations, lineCost, BARRIER_DRAW_WIDTH_MASK_PX } from './navgraph_router.js';
import { corridorMask, applyCorridor, snapToFree } from './preprocess.js';
import { guidedThetaStar } from './theta_star.js';
import { simplifyThetaPath } from './simplify.js';
import { bresenhamPoints } from './bresenham.js';

// θ* / simplify defaults — identical to pipeline.js so the refined polyline
// mirrors the editor's output.
const THETA_SWITCH_RADIUS = 10;
const SIMPLIFY_ANGLE_DEG = 10.0;
const SIMPLIFY_DIST_PX = 5.0;
const IMPASSABLE = 0;

// Shared barrier enforcement width (WP 5.2/5.3 interface). ONE source of truth
// used by (a) the subgrid rasterisation here, (b) the refined-route barrier
// legality band (countBarrierViolations below) and (c) findBarrier's
// isClearOfRouteNodes gate. The constant is DEFINED in navgraph_router.js (the
// dependency root of the circular pair — defining it here would put the
// router's module-init reference in the ESM temporal dead zone when this file
// is the import entry); re-exported so WP 5.2 consumers keep their import path.
// Rationale for the value (=3, not the naive round(BLOCKING_STROKE_WIDTH /
// TRAIN_SCALE_VALUE)=1) is documented at the definition.
export { BARRIER_DRAW_WIDTH_MASK_PX };

// Module-level monotonic clock (Node >=16 + browser workers both expose
// `performance`). Keeps the module Node-clean (no DOM / no `self`).
const nowMs = (typeof performance !== 'undefined' && performance.now)
	? () => performance.now()
	: () => Date.now();

// -----------------------------------------------------------------------------
// Barrier rasterisation (WP 5.3 interface — stamping is live now even though
// nothing places barriers into refinement until 5.3).
// -----------------------------------------------------------------------------

/**
 * Stamp a thick impassable line (value 0) into a subgrid, `width` px wide.
 * Mirrors preprocess.js drawThickLine (PIL ImageDraw.line(fill=0)) but writes
 * into the caller's local subgrid coordinate frame.
 */
function stampBarrierLine(sub, sw, sh, x0, y0, x1, y1, width) {
	const pts = bresenhamPoints(x0 | 0, y0 | 0, x1 | 0, y1 | 0);
	const r = Math.max(0, Math.floor((width - 1) / 2));
	for (let i = 0; i < pts.length; i += 2) {
		const cx = pts[i], cy = pts[i + 1];
		for (let dy = -r; dy <= r; dy++) {
			const yy = cy + dy;
			if (yy < 0 || yy >= sh) continue;
			const dxMax = Math.floor(Math.sqrt(r * r - dy * dy + 1e-9));
			const base = yy * sw;
			const lo = Math.max(0, cx - dxMax);
			const hi = Math.min(sw - 1, cx + dxMax);
			for (let xx = lo; xx <= hi; xx++) sub[base + xx] = IMPASSABLE;
		}
	}
}

/** Barriers active for a route: attemptIndex strictly below its routeIndex. */
export function activeBarriersFor(barriers, routeIndex) {
	if (!barriers || !barriers.length) return [];
	const R = Number.isFinite(routeIndex) ? routeIndex : Infinity;
	const out = [];
	for (const b of barriers) {
		const ai = Number.isFinite(b.attemptIndex) ? b.attemptIndex : -Infinity;
		if (ai < R) out.push(b);
	}
	return out;
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
function pointSegDist2(px, py, ax, ay, bx, by) {
	const dx = bx - ax, dy = by - ay;
	const l2 = dx * dx + dy * dy;
	let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const cx = ax + t * dx, cy = ay + t * dy;
	const ex = px - cx, ey = py - cy;
	return ex * ex + ey * ey;
}

/**
 * Count how many ~1 px samples of a full-res `path` fall within the stamped band
 * of any `barriers` (width BARRIER_DRAW_WIDTH_MASK_PX). This is the barrier
 * analogue of countLegalityViolations and the shared invariant WP 5.3 extends:
 * "the drawn bar is blocked — visuals and routing cannot drift apart." A served
 * route must have zero of these against its active barriers.
 *
 * @param {Array<{x,y}>} path
 * @param {Array<{ax,ay,bx,by}>} barriers
 * @param {number} [width=BARRIER_DRAW_WIDTH_MASK_PX]
 */
export function countBarrierViolations(path, barriers, width = BARRIER_DRAW_WIDTH_MASK_PX) {
	if (!barriers || !barriers.length || !path || path.length < 2) return 0;
	const r = Math.max(0, Math.floor((width - 1) / 2));
	const thr = (r + 0.5) * (r + 0.5); // within the stamped disk radius (+ pixel rounding)
	let hits = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1], b = path[i];
		const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) | 0;
		for (let k = 0; k <= steps; k++) {
			const t = steps ? k / steps : 0;
			const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
			for (const bar of barriers) {
				if (pointSegDist2(px, py, bar.ax, bar.ay, bar.bx, bar.by) <= thr) { hits++; break; }
			}
		}
	}
	return hits;
}

// -----------------------------------------------------------------------------
// Small geometry / cost helpers
// -----------------------------------------------------------------------------

/** Σ terrain-weighted lineCost over a polyline (true mask); null if any segment
 *  crosses impassable. */
function polylineCost(mask, W, pts) {
	let cost = 0;
	for (let i = 1; i < pts.length; i++) {
		const c = lineCost(mask, W, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
		if (c === null) return null;
		cost += c;
	}
	return cost;
}

/** Count impassable hits when a polyline (subgrid-local coords) is sampled at
 *  ~1 px against `sub`. Catches both terrain clips AND barrier clips that the
 *  angle/distance simplifier may have introduced across a corner. */
function countSubgridViolations(sub, sw, sh, pts) {
	let hits = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1], b = pts[i];
		const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) | 0;
		for (let k = 0; k <= steps; k++) {
			const t = steps ? k / steps : 0;
			const xi = Math.round(a.x + (b.x - a.x) * t);
			const yi = Math.round(a.y + (b.y - a.y) * t);
			if (xi < 0 || yi < 0 || xi >= sw || yi >= sh || sub[yi * sw + xi] === IMPASSABLE) hits++;
		}
	}
	return hits;
}

/**
 * Is the straight segment clean under the SAME linear-interpolation sampling as
 * countLegalityViolations / countSubgridViolations? θ*'s in-loop test is
 * Bresenham LOS, which disagrees with the linear round-sampling at corners — the
 * refined polyline must be clean under the sampling the legality assertion uses,
 * not θ*'s, so we test with this one.
 */
function segLinearClean(grid, sw, sh, ax, ay, bx, by) {
	const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) | 0;
	for (let k = 0; k <= steps; k++) {
		const t = steps ? k / steps : 0;
		const xi = Math.round(ax + (bx - ax) * t);
		const yi = Math.round(ay + (by - ay) * t);
		if (xi < 0 || yi < 0 || xi >= sw || yi >= sh || grid[yi * sw + xi] === IMPASSABLE) return false;
	}
	return true;
}

/** Append the Bresenham pixel walk pa→pb (excluding pa) to `out`; each step is
 *  ≤1 px so every emitted segment is linear-clean. Returns false if any pixel is
 *  blocked (θ* guarantees the raw LOS jumps are clear, so this ~never trips). */
function pushDense(out, grid, sw, sh, ax, ay, bx, by) {
	const pts = bresenhamPoints(ax | 0, ay | 0, bx | 0, by | 0);
	for (let i = 0; i < pts.length; i += 2) {
		const xx = pts[i], yy = pts[i + 1];
		if (xx < 0 || yy < 0 || xx >= sw || yy >= sh || grid[yy * sw + xx] === IMPASSABLE) return false;
		if (i > 0) out.push({ x: xx, y: yy });
	}
	return true;
}

/**
 * Build a smooth-but-linearly-legal polyline from the simplified θ* path.
 * simplifyThetaPath keeps a subsequence of the raw θ* vertices; its shortcuts
 * are kept wherever the straight line is linear-clean, otherwise the segment is
 * re-expanded to its raw θ* sub-path, and any raw sub-segment that is still
 * linear-dirty (long LOS jump) is densified to adjacent Bresenham pixels
 * (trivially linear-clean). Result: mostly smooth any-angle, dense only across
 * the handful of clipped corners. Returns the point list, or null if the
 * coordinate mapping breaks (caller then uses the raw θ* path).
 */
function losRepair(grid, sw, sh, rawPts, simpPts) {
	const idx = [];
	let r = 0;
	for (let s = 0; s < simpPts.length; s++) {
		while (r < rawPts.length && (rawPts[r].x !== simpPts[s].x || rawPts[r].y !== simpPts[s].y)) r++;
		if (r >= rawPts.length) return null;
		idx.push(r);
	}
	const out = [rawPts[idx[0]]];
	for (let s = 1; s < simpPts.length; s++) {
		const a = simpPts[s - 1], b = simpPts[s];
		if (segLinearClean(grid, sw, sh, a.x, a.y, b.x, b.y)) {
			out.push(b);
			continue;
		}
		// Re-expand to the raw θ* sub-path, densifying dirty sub-segments.
		for (let k = idx[s - 1] + 1; k <= idx[s]; k++) {
			const pa = rawPts[k - 1], pb = rawPts[k];
			if (segLinearClean(grid, sw, sh, pa.x, pa.y, pb.x, pb.y)) out.push(pb);
			else if (!pushDense(out, grid, sw, sh, pa.x, pa.y, pb.x, pb.y)) return null;
		}
	}
	return out;
}

// -----------------------------------------------------------------------------
// The θ* attempt (returns a legal, barrier-respecting full-res polyline or null)
// -----------------------------------------------------------------------------

function tryTheta(state, spine, activeBarriers, corridorRadius, deadline, diag = {}) {
	const { mask, artifact } = state;
	const { W, H } = artifact;
	const first = spine[0], last = spine[spine.length - 1];
	const fail = (r) => { diag.reason = r; return null; };

	// 2. Subgrid = bbox of the legal spine + (corridorRadius + 8) margin.
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of spine) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const margin = corridorRadius + 8;
	const x0 = Math.max(0, Math.floor(minX) - margin);
	const y0 = Math.max(0, Math.floor(minY) - margin);
	const x1 = Math.min(W - 1, Math.ceil(maxX) + margin);
	const y1 = Math.min(H - 1, Math.ceil(maxY) + margin);
	const sw = x1 - x0 + 1, sh = y1 - y0 + 1;
	if (sw < 3 || sh < 3) return fail('tiny');

	// Extract the true-mask window, then zero the 1 px border (parity with
	// extractSubgrid — theta*/snap can't escape the window). The corridor
	// (radius ≤ margin−8) stays clear of the border.
	const sub = new Uint8Array(sw * sh);
	for (let y = 0; y < sh; y++) {
		const srcBase = (y0 + y) * W + x0;
		sub.set(mask.subarray(srcBase, srcBase + sw), y * sw);
	}
	for (let x = 0; x < sw; x++) { sub[x] = IMPASSABLE; sub[(sh - 1) * sw + x] = IMPASSABLE; }
	for (let y = 0; y < sh; y++) { sub[y * sw] = IMPASSABLE; sub[y * sw + sw - 1] = IMPASSABLE; }

	// 3. Stamp active barriers as impassable thick lines (local coords).
	for (const b of activeBarriers) {
		stampBarrierLine(sub, sw, sh,
			b.ax - x0, b.ay - y0, b.bx - x0, b.by - y0,
			BARRIER_DRAW_WIDTH_MASK_PX);
	}

	// Spine in local flat form for the corridor + θ* guidance.
	const spineFlat = new Array(spine.length * 2);
	for (let i = 0; i < spine.length; i++) {
		spineFlat[2 * i] = spine[i].x - x0;
		spineFlat[2 * i + 1] = spine[i].y - y0;
	}

	// 4. Corridor + θ*. Confine the terrain (incl. stamped bars) to the tube,
	// then snap endpoints to free inside the constrained grid.
	const corridor = corridorMask(spineFlat, sw, sh, corridorRadius);
	const constrained = applyCorridor(sub, corridor);
	const startSub = snapToFree(constrained, sw, sh, (first.x - x0) | 0, (first.y - y0) | 0);
	const goalSub = snapToFree(constrained, sw, sh, (last.x - x0) | 0, (last.y - y0) | 0);
	if (!startSub || !goalSub) return fail('snap');
	if (deadline !== null && nowMs() > deadline) return fail('timeout');

	const thetaFlat = guidedThetaStar(constrained, sw, sh, startSub, goalSub, spineFlat, THETA_SWITCH_RADIUS, deadline);
	if (!thetaFlat || thetaFlat.length < 4) return fail(deadline !== null && nowMs() > deadline ? 'timeout' : 'nopath');

	// Simplify (10°, 5 px) then LOS-repair over-shortcut segments so the served
	// polyline is smooth AND legal (no fallback to the legal spine for the common
	// corner-clip case).
	const rawPts = [];
	for (let i = 0; i < thetaFlat.length; i += 2) rawPts.push({ x: thetaFlat[i], y: thetaFlat[i + 1] });
	const simpFlat = simplifyThetaPath(thetaFlat, SIMPLIFY_ANGLE_DEG, SIMPLIFY_DIST_PX);
	const simpPts = [];
	for (let i = 0; i < simpFlat.length; i += 2) simpPts.push({ x: simpFlat[i], y: simpFlat[i + 1] });
	const local = losRepair(constrained, sw, sh, rawPts, simpPts) || rawPts.slice();

	// Pin the true endpoints (θ* used snapped ones) if the connecting stub is legal.
	const trueStart = { x: first.x - x0, y: first.y - y0 };
	const trueGoal = { x: last.x - x0, y: last.y - y0 };
	if ((local[0].x !== trueStart.x || local[0].y !== trueStart.y)
		&& lineCost(sub, sw, trueStart.x, trueStart.y, local[0].x, local[0].y) !== null) {
		local.unshift(trueStart);
	}
	const le = local[local.length - 1];
	if ((le.x !== trueGoal.x || le.y !== trueGoal.y)
		&& lineCost(sub, sw, le.x, le.y, trueGoal.x, trueGoal.y) !== null) {
		local.push(trueGoal);
	}

	// The simplifier can clip a corner θ*'s in-loop LOS respected — validate the
	// final polyline against the stamped subgrid (terrain + bars in one pass).
	if (countSubgridViolations(sub, sw, sh, local) > 0) return fail('clip');

	// Lift to full-res.
	const full = local.map((p) => ({ x: p.x + x0, y: p.y + y0 }));
	// Belt-and-suspenders on the true mask (barriers removed): must be legal.
	if (countLegalityViolations(state, full) > 0) return fail('truemask');

	// 5. Runtime = Σ lineCost over the FINAL polyline on the TRUE mask.
	const cost = polylineCost(mask, W, full);
	if (cost === null) return fail('cost');
	return { path: full, cost };
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Refine one accepted navgraph route to a smooth, terrain-hugging, any-angle
 * polyline. Always computes the legal spine first; attempts θ* on top; on θ*
 * failure/timeout returns the legal spine (mode `legal-fallback`).
 *
 * @param {object} state  from buildState() — { mask, artifact, cfg }
 * @param {Array<{x,y}>} path  the selected route's coord polyline (graph chain)
 * @param {Array<{ax,ay,bx,by,attemptIndex?}>} barriers  all placed barriers;
 *        those with attemptIndex < opts.routeIndex are stamped impassable.
 * @param {object} opts
 * @param {number} [opts.routeIndex=Infinity]  filters active barriers
 * @param {number} [opts.corridorRadius]       default state.cfg.corridorRadius (24)
 * @param {number} [opts.budgetMs]             default state.cfg.refineBudgetMs (600)
 * @param {Function} [opts.now]                clock (defaults to module nowMs)
 * @returns {{
 *   path: Array<{x,y}>,       // served polyline (θ* on success, legal on fallback)
 *   cost: number,             // Σ lineCost of `path` on the true mask
 *   mode: 'theta'|'legal-fallback'|'unusable',
 *   legalPath: Array<{x,y}>,  // the legal spine (always present)
 *   legalCost: number,        // Σ lineCost of the legal spine
 *   thetaCost: number|null,   // raw θ* cost (null if θ* failed) — for metrics
 *   activeBarriers: Array<{ax,ay,bx,by}>,  // barriers stamped for this route
 *   routeIndex: number,
 *   tRefine: number,          // ms spent on the legal spine
 *   tTheta: number            // ms spent on corridor + θ*
 * }}
 */
export function refineRouteTheta(state, path, barriers, opts = {}) {
	const { cfg } = state;
	const clock = opts.now || nowMs;
	const routeIndex = Number.isFinite(opts.routeIndex) ? opts.routeIndex : Infinity;
	const corridorRadius = Number.isFinite(opts.corridorRadius)
		? opts.corridorRadius
		: (Number.isFinite(cfg?.corridorRadius) ? cfg.corridorRadius : 24);
	const budgetMs = Number.isFinite(opts.budgetMs)
		? opts.budgetMs
		: (Number.isFinite(cfg?.refineBudgetMs) ? cfg.refineBudgetMs : 600);

	// 1. Legal spine (Phase-2 validated, guaranteed-legal waypoint chain).
	// refineRouteLegal already returns its terrain-weighted cost on the same
	// Σ-lineCost basis (straight segs via lineCost, detours via A*), so use it
	// directly rather than re-summing over the (often dense) polyline.
	const tR0 = clock();
	const legal = refineRouteLegal(state, path);
	const tRefine = clock() - tR0;
	const legalCost = legal.cost;
	const legalPath = legal.path;
	const activeBarriers = activeBarriersFor(barriers, routeIndex);

	const base = {
		legalPath, legalCost, activeBarriers, routeIndex, tRefine,
	};

	// If the legal spine itself is illegal, the route is unusable (pair should
	// reject under either policy). Should not happen (Phase-2 validated).
	if (countLegalityViolations(state, legalPath) > 0) {
		return { ...base, path: legalPath, cost: legalCost, mode: 'unusable', thetaCost: null, tTheta: 0 };
	}

	// 2–5. θ* attempt under a per-route budget.
	const tT0 = clock();
	const deadline = Number.isFinite(budgetMs) ? tT0 + budgetMs : null;
	const diag = { reason: null };
	let theta = null;
	try {
		theta = tryTheta(state, legalPath, activeBarriers, corridorRadius, deadline, diag);
	} catch (e) {
		diag.reason = 'error';
		theta = null;
	}
	const tTheta = clock() - tT0;

	if (!theta) {
		return { ...base, path: legalPath, cost: legalCost, mode: 'legal-fallback', thetaCost: null, thetaFail: diag.reason, tTheta };
	}
	return { ...base, path: theta.path, cost: theta.cost, mode: 'theta', thetaCost: theta.cost, thetaFail: null, tTheta };
}
