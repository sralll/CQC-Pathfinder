import assert from 'node:assert/strict';

import {
    skippedBarriersForSelection,
	selectWeightedRoutePair,
} from '../../../../../../results/static/results/js/infinite/route_pair_selection.js';


const paths = Array.from({ length: 5 }, (_, offset) => ({
    routeIndex: offset + 1,
    barrier: { attemptIndex: offset + 1 },
}));

assert.deepEqual(
    skippedBarriersForSelection(paths, [paths[0], paths[4]]),
    [],
    'routes 1 + 5 must not render barriers created after route 1',
);

assert.deepEqual(
    skippedBarriersForSelection(paths, [paths[2], paths[4]]).map((barrier) => barrier.attemptIndex),
    [1, 2],
    'routes 3 + 5 may render only barriers that both routes avoided',
);

assert.deepEqual(
    skippedBarriersForSelection(paths, [paths[1], paths[4]]).map((barrier) => barrier.attemptIndex),
    [1],
    'the common-active cutoff is the lower selected route index',
);

assert.deepEqual(skippedBarriersForSelection(paths, []), []);

const route = (routeIndex, y, run_time) => ({
	routeIndex, run_time,
	path: [{ x: 0, y: 0 }, { x: 5, y }, { x: 10, y: 0 }],
});
const selectionArgs = {
	start: { x: 0, y: 0 }, goal: { x: 10, y: 0 },
	config: { minSideGap: 1, maxRelativeGap: 0.4, maxRouteIndexGap: 1 },
	rng: () => 0,
};
assert.equal(
	selectWeightedRoutePair([route(1, -5, 100), route(3, 5, 105)], selectionArgs).ok,
	false,
	'non-adjacent cumulative routes depend on invisible intermediate blockers',
);
assert.deepEqual(
	selectWeightedRoutePair([route(2, -5, 100), route(3, 5, 105)], selectionArgs)
		.selected.map((item) => item.routeIndex),
	[2, 3],
	'adjacent cumulative alternatives remain selectable',
);

console.log('route_pair_selection tests passed');
