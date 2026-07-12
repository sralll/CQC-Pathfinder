import assert from 'node:assert/strict';

import {
    skippedBarriersForSelection,
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

console.log('route_pair_selection tests passed');
