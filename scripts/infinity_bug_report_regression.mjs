// Headless reproduction for the 2026-07-13 /debug/infinity reports 4, 5 and 7.
// It intentionally uses the production artifact, passage document, snapping,
// alternate barriers and full-resolution refinement. Keep this small fixture as
// a regression probe when route selection/refinement changes.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
    loadArtifact, loadMask,
} from './navgraph_harness.mjs';
import {
    attachSerializedPassages, buildState, computeRouteOptions,
    generateOnePair, makeRng, refineTypedNavgraphRoute, routePathLength, snapEndpoint,
} from '../project/static/project/js/pathing/navgraph_router.js';
import { refineRouteTheta } from '../project/static/project/js/pathing/refine_theta.js';
import * as routePairSelection from '../results/static/results/js/infinite/route_pair_selection.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASK = path.join(ROOT, 'media', 'masks', 'mask_20260105_085438.png');
const BIN = MASK.replace(/\.png$/i, '.navgraph.bin');
const MAP_UNIT_SCALE = 0.71;

const passageDocument = {
    version: 1,
    items: [
        { id: '9e29517e-366b-4857-801d-e010c23dae66', width: 11, points: [[829.3646294451462, 1385.7576078944444], [815.8082914169771, 1361.1097205705007]] },
        { id: '4086bf05-856a-4e13-b6b7-d860b87588aa', width: 43, points: [[887.4144908755792, 1355.918513888249], [853.0672705317205, 1311.3744625048073]] },
        { id: '64eb81a2-7083-4284-b922-03bfc2149135', width: 47, points: [[1376.400398678854, 1109.7830245244197], [1360.8780485550774, 1082.7440920507445]] },
        { id: '45fa0b73-4d8d-42c0-a731-3d12d69e6e9a', width: 54, points: [[1615.7413517396199, 987.8253633894891], [1603.627525225829, 960.4648241945475]] },
        { id: 'ef7b4c76-6eec-415f-bb6d-593330c32c7d', width: 53, points: [[583.1365403312917, 1565.6142282626283], [538.383531323045, 1530.0830514136567]] },
        { id: 'c5fd8584-716e-4316-bf3e-9f93bff0b666', width: 24, points: [[446.40142698353566, 1765.2246116375886], [389.3591734624089, 1736.1753158629408]] },
    ],
};

const reports = [
    { id: 4, start: [325.89, 1004.65], goal: [477.83, 1079.91], selected: [3, 5] },
    { id: 5, start: [865.49, 1057.9], goal: [910.22, 881.82], selected: [4, 2] },
    { id: 7, start: [1536.44, 1708.97], goal: [1458.34, 1753.7], selected: [2, 4] },
];
const expectedAdjacent = new Map([[4, [3, 4]], [5, [2, 3]], [7, [2, 3]]]);

const artifact = loadArtifact(BIN);
const { mask } = await loadMask(MASK);
const state = buildState(artifact, mask, {
    primaryBudgetMs: Infinity,
    extraBudgetMs: Infinity,
    refineBudgetMs: Infinity,
    barrierWidthPx: 5 * 0.34360302625994477 / MAP_UNIT_SCALE,
    barrierClearNodeDistPx: 5 * 0.34360302625994477 / MAP_UNIT_SCALE,
	sideGapMinPx: 12 / (0.48 * MAP_UNIT_SCALE),
	distMinPx: 40 / (0.48 * MAP_UNIT_SCALE),
	distMaxPx: 120 / (0.48 * MAP_UNIT_SCALE),
});
attachSerializedPassages(state, passageDocument.items);

if (process.argv[2] === 'sample') {
	const radius = Number(process.argv[3] || state.cfg.finalCorridorRadius);
	const count = Math.max(1, Number(process.argv[4] || 1));
	state.cfg.finalCorridorRadius = radius;
	const samples = [];
	for (let seed = 1; seed <= count; seed++) {
		const started = performance.now();
		const sample = generateOnePair(state, {
			rng: makeRng(seed), maxAttempts: 200, selection: routePairSelection,
		});
		samples.push({
			ok: sample.ok,
			reason: sample.reason || 'ok',
			ms: +(performance.now() - started).toFixed(2),
			attempts: sample.meta?.attempts,
			routeIndexes: sample.routeIndexes || null,
			refineMode: sample.meta?.refineMode || null,
			legality: sample.meta?.legality ?? null,
			timings: sample.meta?.timings || null,
		});
	}
	const successful = samples.filter((sample) => sample.ok);
	const values = successful.map((sample) => sample.ms).sort((a, b) => a - b);
	console.log(JSON.stringify({
		radius,
		count,
		successes: successful.length,
		meanMs: values.length
			? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)
			: null,
		medianMs: values.length ? values[Math.floor(values.length / 2)] : null,
		maxMs: values.length ? values.at(-1) : null,
		samples,
	}, null, 2));
	process.exit(successful.length === count ? 0 : 1);
}

const requestedReport = Number(process.argv[2]);
for (const report of reports.filter((item) => !Number.isFinite(requestedReport) || item.id === requestedReport)) {
    const start = { x: report.start[0] / MAP_UNIT_SCALE, y: report.start[1] / MAP_UNIT_SCALE };
    const goal = { x: report.goal[0] / MAP_UNIT_SCALE, y: report.goal[1] / MAP_UNIT_SCALE };
    const startSnap = snapEndpoint(state, start);
    const goalSnap = snapEndpoint(state, goal);
    const result = computeRouteOptions(state, start, goal, startSnap, goalSnap);
	const refinedRecords = result.paths.map((route) => {
        const refined = route.typedLegs
            ? refineTypedNavgraphRoute(state, route, result.barriers, { routeIndex: route.routeIndex, budgetMs: Infinity })
            : refineRouteTheta(state, route.path, result.barriers, { routeIndex: route.routeIndex, budgetMs: Infinity });
		return {
			record: {
				...route,
				path: refined.path,
				run_time: refined.cost,
				cost: refined.cost,
				typedLegs: refined.typedLegs || route.typedLegs,
			},
			refined,
		};
	});
	const routes = refinedRecords.map(({ record: route, refined }) => ({
            routeIndex: route.routeIndex,
			graphCost: +result.paths[route.routeIndex - 1].cost.toFixed(2),
            refinedCost: +refined.cost.toFixed(2),
            graphLength: +routePathLength(route.path).toFixed(2),
            refinedLength: +routePathLength(refined.path).toFixed(2),
            mode: refined.mode,
			thetaFail: refined.thetaFail || null,
            legOutcomes: refined.legOutcomes || null,
			legInputs: (route.typedLegs || []).map((leg) => ({
				surface: leg.surface,
				points: leg.points.length,
				first: leg.points[0],
				last: leg.points.at(-1),
			})),
            passages: (route.typedLegs || []).filter((leg) => leg.surface !== 'base').map((leg) => leg.passageId),
            portalOptimization: refined.portalOptimization || null,
        }));
	const selection = routePairSelection.selectWeightedRoutePair(
		result.paths,
		{
			start, goal,
			config: {
				minSideGap: state.cfg.sideGapMinPx,
				maxRelativeGap: state.cfg.maxRelativeGap,
				maxRouteIndexGap: 1,
			},
			rng: () => 0.5,
		},
	);
	let finalSelection = null;
	if (selection.ok) {
		const skipped = routePairSelection.skippedBarriersForSelection(result.paths, selection.selected);
		finalSelection = selection.selected.map((route) => {
			const refined = route.typedLegs
				? refineTypedNavgraphRoute(state, route, skipped, {
					routeIndex: Infinity,
					corridorRadius: state.cfg.finalCorridorRadius,
					budgetMs: state.cfg.finalRefineBudgetMs,
				})
				: refineRouteTheta(state, route.path, skipped, {
					routeIndex: Infinity,
					corridorRadius: state.cfg.finalCorridorRadius,
					budgetMs: state.cfg.finalRefineBudgetMs,
				});
			return {
				routeIndex: route.routeIndex,
				mode: refined.mode,
				cost: +refined.cost.toFixed(2),
				length: +routePathLength(refined.path).toFixed(2),
				passages: (refined.typedLegs || []).filter((leg) => leg.surface !== 'base').map((leg) => leg.passageId),
				portalOptimization: refined.portalOptimization || null,
			};
		});
	}
	assert.equal(selection.ok, true, `report ${report.id} has no adjacent route pair`);
	assert.deepEqual(
		selection.selected.map((route) => route.routeIndex),
		expectedAdjacent.get(report.id),
		`report ${report.id} selected a cumulative ghost-barrier route`,
	);
	assert.ok(finalSelection.every((route) => route.mode === 'theta'),
		`report ${report.id} fell back instead of running any-angle refinement`);
	if (report.id === 4) {
		const passageBarrier = result.barriers[0];
		assert.ok(Math.hypot(
			passageBarrier.bx - passageBarrier.ax,
			passageBarrier.by - passageBarrier.ay,
		) + 1e-6 >= passageBarrier.passageWidthPx + 4);
		assert.ok(finalSelection[1].passages.includes('c5fd8584-716e-4316-bf3e-9f93bff0b666'),
			'report 4 did not retain the available second passage');
	}
	if (report.id === 7) {
		assert.ok(Math.max(...finalSelection.map((route) => route.length)) < 600,
			'report 7 retained the unnecessary route-4 detour');
	}
    console.log(JSON.stringify({
        report: report.id,
        expectedSelected: report.selected,
        optionCount: routes.length,
        reason: result.reason,
		adjacentSelection: selection.ok ? {
			selected: selection.selected.map((route) => route.routeIndex),
			candidates: selection.candidates.map((pair) => [
				refinedRecords[pair.i].record.routeIndex,
				refinedRecords[pair.j].record.routeIndex,
			]),
		} : { reason: selection.reason },
		finalSelection,
        barriers: result.barriers.map((barrier) => ({
            attemptIndex: barrier.attemptIndex,
            surface: barrier.surface,
            length: +Math.hypot(barrier.bx - barrier.ax, barrier.by - barrier.ay).toFixed(2),
            passageWidthPx: barrier.passageWidthPx || null,
        })),
        routes,
    }, null, 2));
}
