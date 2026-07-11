// Focused WP 4.3 verification.
// Usage:
//   node project/static/project/js/pathing/dev/layered_distinct.test.mjs

import assert from 'node:assert/strict';
import { routeDistinct } from '../distinct.js';
import { layeredRouteDistinct } from '../layered_distinct.js';
import { normalizePassagesForRuntime } from '../passage_geometry.js';

function openGrid(width, height) {
    return new Uint8Array(width * height).fill(241);
}

function flat(points) {
    return points.flatMap((point) => point);
}

const width = 80;
const height = 60;
const grid = openGrid(width, height);
const passages = normalizePassagesForRuntime({
    version: 1,
    items: [
        { id: 'wide-horizontal', points: [[15, 20], [65, 20]], width: 20 },
        { id: 'vertical-crossing', points: [[40, 5], [40, 45]], width: 8 },
    ],
}, { mapWidth: width, mapHeight: height }).passages;
assert.equal(passages.length, 2);

// Base-only behavior is byte-for-byte the legacy module result, even when a
// route crosses a passage footprint in the middle without traversing its caps.
const baseCandidate = flat([[2, 35], [25, 35], [55, 35], [77, 35]]);
const baseExisting = flat([[2, 36], [25, 36], [55, 36], [77, 36]]);
assert.deepEqual(
    layeredRouteDistinct(baseCandidate, [baseExisting], grid, width, height, passages),
    routeDistinct(baseCandidate, [baseExisting], grid, width, height),
);

const emptyPassages = [];
const wallGrid = openGrid(width, height);
for (let y = 15; y <= 45; y++) wallGrid[y * width + 40] = 0;
const upper = flat([[2, 10], [38, 10], [42, 10], [77, 10]]);
const lower = flat([[2, 50], [38, 50], [42, 50], [77, 50]]);
assert.deepEqual(
    layeredRouteDistinct(upper, [lower], wallGrid, width, height, emptyPassages, {
        sampleStepPx: 4,
        minSeparationPx: 10,
        minSeparatedSamples: 3,
        minObjectHits: 2,
    }),
    routeDistinct(upper, [lower], wallGrid, width, height, {
        sampleStepPx: 4,
        minSeparationPx: 10,
        minSeparatedSamples: 3,
        minObjectHits: 2,
    }),
);

// A complete passage traversal and a projected base crossing have different
// transient topology. Their projected intersection does not make them equal.
const over = flat([[40, 0], [40, 5], [40, 20], [40, 45], [40, 50]]);
const under = flat([[32, 20], [36, 20], [40, 20], [44, 20], [48, 20]]);
const overUnder = layeredRouteDistinct(over, [under], grid, width, height, passages);
assert.equal(overUnder.distinct, true);
assert.equal(overUnder.mode, 'layered');
assert.equal(overUnder.perRoute[0].strategy, 'surface-topology');
assert.deepEqual(overUnder.perRoute[0].candidatePassages, ['vertical-crossing']);
assert.deepEqual(overUnder.perRoute[0].existingPassages, []);

// Lines differing by only a few pixels on the same wide bridge are not a
// meaningful alternative in the absence of a separating base obstacle.
const bridgeNearA = flat([[5, 18], [15, 18], [30, 18], [50, 18], [65, 18], [75, 18]]);
const bridgeNearB = flat([[5, 19], [15, 19], [30, 19], [50, 19], [65, 19], [75, 19]]);
const near = layeredRouteDistinct(bridgeNearA, [bridgeNearB], grid, width, height, passages);
assert.equal(near.distinct, false);
assert.equal(near.reason, 'no meaningful separation on shared passage');
assert.equal(near.perRoute[0].strategy, 'same-passage-overlap');
assert.equal(near.perRoute[0].passageComparisons[0].meaningful, false);
assert.equal(near.perRoute[0].passageComparisons[0].thresholdPx, 5);

// The layered search's explicit empty classification is authoritative. Two
// routes with identical projected geometry can still be a legal over/under
// pair when one used the passage and the other deliberately stayed on base.
const coincidentPassage = bridgeNearA.slice();
coincidentPassage.passageSpans = [{
    passageId: 'wide-horizontal', fromIndex: 0, toIndex: coincidentPassage.length / 2 - 1,
}];
const coincidentBase = bridgeNearA.slice();
coincidentBase.passageSpans = [];
const coincidentSurfaces = layeredRouteDistinct(
    coincidentPassage, [coincidentBase], grid, width, height, passages,
);
assert.equal(coincidentSurfaces.distinct, true);
assert.equal(coincidentSurfaces.perRoute[0].strategy, 'surface-topology');

// Obstacles projected underneath a shared passage must not make nearby bridge
// lines distinct, even if a caller lowers the legacy base-route threshold.
const underBridgeObstacleGrid = openGrid(width, height);
for (let x = 15; x <= 65; x++) underBridgeObstacleGrid[18 * width + x] = 0;
const bridgeFourPxA = flat([[5, 16], [15, 16], [30, 16], [50, 16], [65, 16], [75, 16]]);
const bridgeFourPxB = flat([[5, 20], [15, 20], [30, 20], [50, 20], [65, 20], [75, 20]]);
const projectedObstacle = layeredRouteDistinct(
    bridgeFourPxA,
    [bridgeFourPxB],
    underBridgeObstacleGrid,
    width,
    height,
    passages,
    { sampleStepPx: 4, minSeparationPx: 2, minSeparatedSamples: 2, minObjectHits: 1 },
);
assert.equal(projectedObstacle.distinct, false);
assert.equal(projectedObstacle.perRoute[0].strategy, 'same-passage-overlap');
assert.equal(projectedObstacle.perRoute[0].legacy.distinct, true);
assert.equal(projectedObstacle.perRoute[0].surroundingBase.distinct, false);

// The Infinity pair gate (navgraph_router.generateOnePair) passes {x, y}
// object routes with authoritative spans: a pair that shares its passage
// traversal over a projected level-0 obstacle must not count as distinct.
function navgraphRoute(points, spans) {
    const route = points.map(([x, y]) => ({ x, y }));
    route.passageSpans = spans;
    return route;
}
const navPairA = navgraphRoute(
    [[5, 18], [15, 18], [40, 17], [65, 18], [75, 18]],
    [{ passageId: 'wide-horizontal', fromIndex: 1, toIndex: 3 }],
);
const navPairB = navgraphRoute(
    [[5, 20], [15, 20], [40, 21], [65, 20], [75, 20]],
    [{ passageId: 'wide-horizontal', fromIndex: 1, toIndex: 3 }],
);
const navPair = layeredRouteDistinct(
    navPairA, [navPairB], underBridgeObstacleGrid, width, height, passages,
);
assert.equal(navPair.distinct, false);
assert.equal(navPair.perRoute[0].strategy, 'same-passage-overlap');

// Two routes may share the same line through a passage yet remain distinct
// because a real base-surface obstacle separates their approach/exit legs.
const surroundingGrid = openGrid(width, height);
for (let x = 1; x < 15; x++) surroundingGrid[20 * width + x] = 0;
const surroundingUpper = flat([
    [0, 20], [5, 10], [15, 20], [40, 20], [65, 20], [75, 10], [79, 20],
]);
const surroundingLower = flat([
    [0, 20], [5, 30], [15, 20], [40, 20], [65, 20], [75, 30], [79, 20],
]);
const surrounding = layeredRouteDistinct(
    surroundingUpper,
    [surroundingLower],
    surroundingGrid,
    width,
    height,
    passages,
    {
        sampleStepPx: 1,
        minSeparationPx: 4,
        minSeparatedSamples: 2,
        minObjectHits: 1,
        endpointFraction: 0,
    },
);
assert.equal(surrounding.distinct, true);
assert.equal(surrounding.perRoute[0].strategy, 'legacy-surrounding');
assert.equal(surrounding.perRoute[0].surroundingBase.distinct, true);

// A sustained lateral choice across the same wide passage is meaningful. The
// symmetric point-to-polyline test avoids treating longitudinal resampling
// differences as lateral separation.
const bridgeUpper = flat([[5, 12], [15, 12], [30, 12], [50, 12], [65, 12], [75, 12]]);
const bridgeLower = flat([[5, 28], [15, 28], [30, 28], [50, 28], [65, 28], [75, 28]]);
const lateral = layeredRouteDistinct(bridgeUpper, [bridgeLower], grid, width, height, passages);
assert.equal(lateral.distinct, true);
assert.equal(lateral.perRoute[0].strategy, 'passage-lateral');
assert.equal(lateral.perRoute[0].passageComparisons[0].meaningful, true);
assert.ok(lateral.perRoute[0].passageComparisons[0].candidateToExisting.separatedFraction >= 0.35);

// Caller thresholds are honored and diagnostics retain transient classifier
// spans without adding anything to the route payload itself.
const forcedNear = layeredRouteDistinct(bridgeNearA, [bridgeNearB], grid, width, height, passages, {
    passageMinSeparationPx: 0.5,
});
assert.equal(forcedNear.distinct, true);
assert.equal(forcedNear.perRoute[0].strategy, 'passage-lateral');
assert.deepEqual(forcedNear.candidateClassification.passageSpans, [
    { passageId: 'wide-horizontal', fromIndex: 1, toIndex: 4 },
]);

// Multiple existing routes retain the legacy "must differ from every route"
// aggregation rule and report the original existing-route index.
const mixed = layeredRouteDistinct(bridgeUpper, [under, bridgeNearA], grid, width, height, passages);
assert.equal(mixed.distinct, true);
assert.equal(mixed.comparedRoutes, 2);
assert.deepEqual(mixed.perRoute.map((entry) => entry.routeIndex), [0, 1]);

assert.deepEqual(
    layeredRouteDistinct([], [baseExisting], grid, width, height, passages),
    { distinct: false, reason: 'empty candidate', comparedRoutes: 0 },
);
assert.deepEqual(
    layeredRouteDistinct(baseCandidate, [], grid, width, height, passages),
    { distinct: true, reason: 'first route', comparedRoutes: 0 },
);

console.log('layered distinctness: base regression, topology, lateral separation, and diagnostics passed');
