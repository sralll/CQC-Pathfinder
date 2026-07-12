import { extractObstacles } from './Obstacles.js';
import { buildVisibilityGraph } from './VisibilityGraph.js';
import {
	selectWeightedRoutePair,
	skippedBarriersForSelection,
} from '../../route_pair_selection.js';
import { dhypot } from './dmath.js';

export const ROUTE_VISIBILITY_GRAPH_OPTIONS = {
	// Physical runner clearance: routes keep this far from every wall.
	clearance: 0.3,
	// Lazy visibility graph expansion radius. Keep this aligned with stress tests.
	neighborRing: 8,
};

// Rendered stroke width of blocking bars (scene units). Single source: the
// play renderer draws bars this wide and the visibility graph blocks the
// full drawn rectangle, so visuals and routing cannot drift apart.
export const ROUTE_BARRIER_DRAW_WIDTH = 1;
const ROUTE_BARRIER_SLIDE_FRACTION = 0.05;
const ROUTE_INSIGNIFICANT_BARRIER_KINDS = new Set(['hedge']);

const ROUTE_LATERAL_ASTAR_OPTIONS = { maxStartGoalPerpendicularFactor: 1 };
const ROUTE_ASTAR_OPTIONS = ROUTE_LATERAL_ASTAR_OPTIONS;
const ROUTE_MANUAL_ASTAR_OPTIONS = ROUTE_LATERAL_ASTAR_OPTIONS;

export const ROUTE_STRESS_ALTERNATE_ATTEMPTS = 4;
const ROUTE_MANUAL_ALTERNATE_ATTEMPTS = 3;
const ROUTE_PAIR_MIN_SIDE_GAP = 10;
const ROUTE_PAIR_MAX_RELATIVE_GAP = 0.40;

export const emptyRouteSlots = () => [null, null, null, null, null];

export function buildRouteVisibilityGraph(data, options = ROUTE_VISIBILITY_GRAPH_OPTIONS) {
	return buildVisibilityGraph(extractObstacles(data), options);
}

export function routePathLength(path) {
	let len = 0;
	for (let i = 1; i < path.length; i++)
		len += dhypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
	return len;
}

function routePointInFlatPolygon(px, py, poly) {
	let inside = false;
	const n = poly.length;
	for (let i = 0, j = n - 2; i < n; i += 2, j = i - 2) {
		const ax = poly[j], ay = poly[j + 1];
		const bx = poly[i], by = poly[i + 1];
		if ((ay > py) !== (by > py)) {
			const xInt = ax + (py - ay) * (bx - ax) / (by - ay);
			if (px < xInt) inside = !inside;
		}
	}
	return inside;
}

function routePointInSignificantRawObstacle(px, py, visGraph) {
	if (visGraph._inPortal && visGraph._inPortal(px, py)) return false;
	const grid = visGraph.rawPolyGrid;
	if (!grid || !visGraph.rawPolygons || !visGraph.rawPolyBboxes || !visGraph.rawKinds)
		return visGraph._inRawObstacle(px, py);
	const arr = grid.bins[grid.key(grid.col(px), grid.row(py))];
	if (!arr) return false;
	for (let a = 0; a < arr.length; a++) {
		const pi = arr[a];
		if (ROUTE_INSIGNIFICANT_BARRIER_KINDS.has(visGraph.rawKinds[pi])) continue;
		const b = visGraph.rawPolyBboxes[pi];
		if (px < b.minX || px > b.maxX || py < b.minY || py > b.maxY) continue;
		if (routePointInFlatPolygon(px, py, visGraph.rawPolygons[pi])) return true;
	}
	return false;
}

function findSmartBarrier(path, visGraph) {
	const total = routePathLength(path);
	if (total < 1e-6) return null;
	const MAX_HALF = 12;
	const STEP = 0.25;
	const MARGIN = 1.0;
	const CENTER_FRACTION = 0.5;
	const SLIDE_SAMPLES = 32;
	const FALLBACK_SAMPLES = 30;

	const probe = (frac) => {
		const targetLen = total * frac;
		let accum = 0;
		for (let i = 1; i < path.length; i++) {
			const segLen = dhypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
			if (accum + segLen >= targetLen) {
				const t = (targetLen - accum) / (segLen || 1);
				const mx = path[i - 1].x + (path[i].x - path[i - 1].x) * t;
				const my = path[i - 1].y + (path[i].y - path[i - 1].y) * t;
				const norm = segLen || 1;
				const px = -(path[i].y - path[i - 1].y) / norm;
				const py = (path[i].x - path[i - 1].x) / norm;
				const distFromPrev = targetLen - accum;
				const distToNext = accum + segLen - targetLen;
				let leftDist = MAX_HALF, rightDist = MAX_HALF;
				let leftHit = false, rightHit = false;
				for (let d = STEP; d <= MAX_HALF; d += STEP) {
					if (routePointInSignificantRawObstacle(mx + px * d, my + py * d, visGraph)) { leftDist = d; leftHit = true; break; }
				}
				for (let d = STEP; d <= MAX_HALF; d += STEP) {
					if (routePointInSignificantRawObstacle(mx - px * d, my - py * d, visGraph)) { rightDist = d; rightHit = true; break; }
				}
				return { frac, mx, my, px, py, leftDist, rightDist, leftHit, rightHit, distFromPrev, distToNext };
			}
			accum += segLen;
		}
		return null;
	};
	// Build the final wall from the winning probe. Ends that stopped in open
	// space (no obstacle hit within MAX_HALF) are extended along the same
	// direction until they anchor inside an obstacle, so the drawn bar
	// connects two closed features instead of dangling. Runs only for the one
	// chosen probe, and only for its open ends — a few extra point tests.
	const EXTEND_MAX_HALF = 24;
	const extendToObstacle = (p, sign, dist, hit) => {
		if (hit) return dist;
		for (let d = dist + STEP; d <= EXTEND_MAX_HALF; d += STEP) {
			if (routePointInSignificantRawObstacle(p.mx + sign * p.px * d, p.my + sign * p.py * d, visGraph)) return d;
		}
		return dist;
	};
	const wallAt = (p) => {
		const leftDist = extendToObstacle(p, 1, p.leftDist, p.leftHit);
		const rightDist = extendToObstacle(p, -1, p.rightDist, p.rightHit);
		return {
			mx: p.mx, my: p.my,
			ax: p.mx + p.px * (leftDist + MARGIN), ay: p.my + p.py * (leftDist + MARGIN),
			bx: p.mx - p.px * (rightDist + MARGIN), by: p.my - p.py * (rightDist + MARGIN),
			len: leftDist + rightDist + MARGIN * 2,
		};
	};
	const isClearOfRouteNodes = (p) =>
		Math.min(p.distFromPrev, p.distToNext) >= ROUTE_BARRIER_DRAW_WIDTH;

	let bestClearEnclosed = null, bestClearScore = Infinity;
	let bestEnclosed = null, bestEnclosedScore = Infinity;
	let bestFallback = null, bestFallbackScore = Infinity;
	const minFrac = Math.max(0, CENTER_FRACTION - ROUTE_BARRIER_SLIDE_FRACTION);
	const maxFrac = Math.min(1, CENTER_FRACTION + ROUTE_BARRIER_SLIDE_FRACTION);
	for (let s = 0; s <= SLIDE_SAMPLES; s++) {
		const frac = minFrac + (maxFrac - minFrac) * (s / SLIDE_SAMPLES);
		const p = probe(frac);
		if (!p) continue;
		const width = p.leftDist + p.rightDist;
		const centerPenalty = Math.abs(frac - CENTER_FRACTION) * 1e-3;
		if (p.leftHit && p.rightHit) {
			const score = width + centerPenalty;
			if (isClearOfRouteNodes(p) && score < bestClearScore) {
				bestClearScore = score;
				bestClearEnclosed = p;
			}
			if (score < bestEnclosedScore) {
				bestEnclosedScore = score;
				bestEnclosed = p;
			}
		}
		if (width + centerPenalty < bestFallbackScore) {
			bestFallbackScore = width + centerPenalty;
			bestFallback = p;
		}
	}
	if (bestClearEnclosed || bestEnclosed) return wallAt(bestClearEnclosed || bestEnclosed);

	let broadEnclosed = null, broadEnclosedScore = Infinity;
	let broadFallback = null, broadFallbackScore = Infinity;
	for (let s = 0; s <= FALLBACK_SAMPLES; s++) {
		const frac = 0.25 + 0.5 * (s / FALLBACK_SAMPLES);
		const p = probe(frac);
		if (!p) continue;
		const width = p.leftDist + p.rightDist;
		if (p.leftHit && p.rightHit) {
			const score = Math.abs(frac - CENTER_FRACTION);
			if (score < broadEnclosedScore) { broadEnclosedScore = score; broadEnclosed = p; }
		}
		if (width < broadFallbackScore) { broadFallbackScore = width; broadFallback = p; }
	}
	const pick = broadEnclosed || bestFallback || broadFallback;
	return pick ? wallAt(pick) : null;
}

function routePathSignature(path) {
	return path.map((p) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`).join('|');
}

function routeSlotsFor(paths) {
	const routeLengthSlots = emptyRouteSlots();
	const routeSideSlots = emptyRouteSlots();
	const routeSideLabelSlots = emptyRouteSlots();
	for (const p of paths) {
		routeLengthSlots[p.routeIndex - 1] = p.len;
		routeSideSlots[p.routeIndex - 1] = p.side;
		routeSideLabelSlots[p.routeIndex - 1] = p.sideLabel;
	}
	return { routeLengthSlots, routeSideSlots, routeSideLabelSlots };
}

function failedRoute(reason, paths, selected, extras) {
	const slots = routeSlotsFor(paths);
	return {
		ok: false,
		reason,
		paths,
		selected,
		...slots,
		routeIndexes: selected ? selected.map((p) => p.routeIndex) : [],
		blockFastest: false,
		...extras,
	};
}

export function computeRouteOptions(startPt, goalPt, visGraph, options = {}) {
	// How many routes to explore (each after the first is forced around the
	// previous route's barrier). Defaults to the production value.
	const maxRoutes = Number.isFinite(options.maxRoutes) && options.maxRoutes > 0
		? Math.trunc(options.maxRoutes)
		: ROUTE_STRESS_ALTERNATE_ATTEMPTS;
	// A* time budgets. A route whose search exceeds its budget times out and is
	// dropped ("kicked"). `null` = no budget (current default for the first two
	// routes). Extras default to 200ms, matching current production.
	const primaryBudgetMs = Number.isFinite(options.primaryBudgetMs) ? options.primaryBudgetMs : null;
	const extraBudgetMs = Number.isFinite(options.extraBudgetMs) ? options.extraBudgetMs : 200;
	const t0 = performance.now();
	if (!visGraph) return {
		ok: false,
		reason: 'side',
		paths: [],
		selected: null,
		routeLengthSlots: emptyRouteSlots(),
		routeSideSlots: emptyRouteSlots(),
		routeSideLabelSlots: emptyRouteSlots(),
		routeIndexes: [],
		blockFastest: false,
		barriers: [],
		skippedBarriers: [],
		dt: 0,
		timeout: false,
	};
	if (visGraph.clearTempBlockers) visGraph.clearTempBlockers();

	let paths = [];
	const barriers = [];
	let timeout = false;
	let lateralRejected = false;

	for (let attempt = 0; attempt < maxRoutes; attempt++) {
		// First two routes get the primary budget; every extra route gets the
		// smaller one.
		const budgetMs = attempt < 2 ? primaryBudgetMs : extraBudgetMs;
		const astarOptions = budgetMs != null
			? { ...ROUTE_ASTAR_OPTIONS, timeBudgetMs: budgetMs }
			: ROUTE_ASTAR_OPTIONS;
		const result = visGraph.astar(startPt, goalPt, astarOptions);
		if (visGraph.lastAstarTimedOut) timeout = true;
		if (!result && visGraph.lastAstarRejectedByLateralLimit) lateralRejected = true;
		if (!result || result.path.length < 2) break;
		const path = result.path;
		const len = routePathLength(path);
		const pathRecord = { path, len, routeIndex: attempt + 1, attemptIndex: attempt + 1, barrier: null };
		paths.push(pathRecord);
		if (attempt >= maxRoutes - 1) break;
		const barrier = findSmartBarrier(path, visGraph);
		if (!barrier) break;
		barrier.attemptIndex = attempt + 1;
		pathRecord.barrier = barrier;
		barriers.push(barrier);
		visGraph.addTempBlocker(barrier.ax, barrier.ay, barrier.bx, barrier.by, ROUTE_BARRIER_DRAW_WIDTH / 2);
	}

	if (visGraph.clearTempBlockers) visGraph.clearTempBlockers();
	const dt = performance.now() - t0;
	const baseExtras = { barriers, skippedBarriers: [], dt, timeout };

	if (paths.length === 0)
		return failedRoute(lateralRejected ? 'side' : 'timeout', paths, null, baseExtras);
	if (paths.length === 1)
		return failedRoute(timeout ? 'timeout' : 'distinct', paths, null, { ...baseExtras, routeIndexes: [1] });

	const sgDx = goalPt.x - startPt.x, sgDy = goalPt.y - startPt.y;
	const sgLen = dhypot(sgDx, sgDy) || 1;
	for (const p of paths) {
		let sum = 0;
		for (const pt of p.path) sum += sgDx * (pt.y - startPt.y) - sgDy * (pt.x - startPt.x);
		p.side = (sum / p.path.length) / sgLen;
		p.sideLabel = p.side > 0 ? 'R' : p.side < 0 ? 'L' : 'C';
		p.run_time = p.len;
	}

	const seenPathSignatures = new Set();
	paths = paths.filter((p) => {
		const sig = routePathSignature(p.path);
		if (seenPathSignatures.has(sig)) return false;
		seenPathSignatures.add(sig);
		return true;
	});
	if (paths.length < 2)
		return failedRoute('distinct', paths, null, baseExtras);

	const pick = selectWeightedRoutePair(paths, {
		start: startPt,
		goal: goalPt,
		config: {
			minSideGap: ROUTE_PAIR_MIN_SIDE_GAP,
			maxRelativeGap: ROUTE_PAIR_MAX_RELATIVE_GAP,
		},
	});
	if (!pick.ok)
		return failedRoute(pick.reason === 'runtime' ? 'distance' : pick.reason, paths, null, baseExtras);

	const selected = pick.selected;
	const skippedBarriers = skippedBarriersForSelection(paths, selected);
	const blockFastest = skippedBarriers.length > 0;

	const routeLengthSlots = emptyRouteSlots();
	const routeSideSlots = emptyRouteSlots();
	const routeSideLabelSlots = emptyRouteSlots();
	for (const p of selected) routeLengthSlots[p.routeIndex - 1] = p.len;
	for (const p of paths) {
		routeSideSlots[p.routeIndex - 1] = p.side;
		routeSideLabelSlots[p.routeIndex - 1] = p.sideLabel;
	}
	return {
		ok: true,
		reason: 'ok',
		paths,
		selected,
		routeLengthSlots,
		routeSideSlots,
		routeSideLabelSlots,
		routeIndexes: selected.map((p) => p.routeIndex),
		blockFastest,
		barriers,
		skippedBarriers,
		relativeGap: pick.relativeGap,
		sideGap: pick.sideGap,
		pairCandidates: pick.candidates.length,
		dt,
		timeout,
	};
}

export function computeManualSingleRoute(startPt, goalPt, visGraph) {
	if (!visGraph) return { result: null, candidates: [], dt: 0 };
	if (visGraph.clearTempBlockers) visGraph.clearTempBlockers();
	const t0 = performance.now();
	const candidates = [];
	for (let attempt = 0; attempt < ROUTE_MANUAL_ALTERNATE_ATTEMPTS; attempt++) {
		const candidate = visGraph.astar(startPt, goalPt, ROUTE_MANUAL_ASTAR_OPTIONS);
		if (!candidate || !candidate.path || candidate.path.length < 2) break;
		candidates.push({
			result: candidate,
			len: routePathLength(candidate.path),
		});
		const barrier = findSmartBarrier(candidate.path, visGraph);
		if (!barrier) break;
		visGraph.addTempBlocker(barrier.ax, barrier.ay, barrier.bx, barrier.by, ROUTE_BARRIER_DRAW_WIDTH / 2);
	}
	if (visGraph.clearTempBlockers) visGraph.clearTempBlockers();
	const dt = performance.now() - t0;
	candidates.sort((a, b) => a.len - b.len);
	const result = candidates.length ? candidates[0].result : null;
	return { result, candidates, dt };
}
