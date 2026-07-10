// Deterministic WP 0.1 / 2.1 / 2.2 verification.
// Usage:
//   node project/static/project/js/pathing/dev/passage_geometry.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    PASSAGE_BOUNDARY_VALUE,
    PASSAGE_FAST_VALUE,
    entranceContainsLocalIndex,
    globalToPassageLocal,
    hitTestPassage,
    normalizePassagesForRuntime,
    passageGridValueAt,
    passageLocalIndex,
    passageLocalIndexToGlobal,
    passageLocalToGlobal,
} from '../passage_geometry.js';
import { classifyRoutePassages } from '../passage_classifier.js';
import {
    EXPECTED_PASSAGE_SEMANTICS,
    createPassageBenchmarkFixture,
    createPassageFixtures,
} from './passage_fixtures.mjs';

const fixtures = Object.fromEntries(createPassageFixtures().map((fixture) => [fixture.name, fixture]));

function normalizeFixture(fixture) {
    return normalizePassagesForRuntime(fixture.passages, {
        mapWidth: fixture.baseMask.width,
        mapHeight: fixture.baseMask.height,
    });
}

function hashTypedArrays(passage) {
    return createHash('sha256')
        .update(passage.grid)
        .update(new Uint8Array(passage.startEntrance.buffer))
        .update(new Uint8Array(passage.endEntrance.buffer))
        .digest('hex');
}

function assertConnectedPassable(passage) {
    const first = passage.grid.findIndex((value) => value !== 0);
    assert.notEqual(first, -1, `${passage.id} has no passable cells`);
    const seen = new Uint8Array(passage.grid.length);
    const queue = [first];
    seen[first] = 1;
    let reached = 0;
    for (let head = 0; head < queue.length; head++) {
        const index = queue[head];
        reached++;
        const x = index % passage.localWidth;
        const y = (index - x) / passage.localWidth;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= passage.localWidth || ny >= passage.localHeight) continue;
                const neighbour = ny * passage.localWidth + nx;
                if (!seen[neighbour] && passage.grid[neighbour] !== 0) {
                    seen[neighbour] = 1;
                    queue.push(neighbour);
                }
            }
        }
    }
    const expected = passage.grid.reduce((count, value) => count + (value !== 0 ? 1 : 0), 0);
    assert.equal(reached, expected, `${passage.id} raster has a disconnected hole/component`);
}

function reconstructFlat(legs) {
    const flat = [];
    for (const leg of legs) {
        const start = flat.length
            && flat[flat.length - 2] === leg.points[0]
            && flat[flat.length - 1] === leg.points[1] ? 2 : 0;
        flat.push(...leg.points.slice(start));
    }
    return flat;
}

function routeFlat(route) {
    return route.flatMap((point) => point);
}

// Runtime document/version normalization and invalid geometry diagnostics.
assert.deepEqual(normalizePassagesForRuntime(null).passages, []);
const future = normalizePassagesForRuntime({ version: 2, items: [] });
assert.equal(future.versionSupported, false);
assert.equal(future.passages.length, 0);
assert.equal(future.diagnostics[0].code, 'unsupported-version');

const invalidCaps = normalizeFixture(fixtures['overlapping-entrance-caps']);
assert.equal(invalidCaps.passages.length, 0);
assert.equal(invalidCaps.diagnostics[0].code, 'overlapping-entrances');

const duplicateAndInvalid = normalizePassagesForRuntime({
    version: 1,
    items: [
        { id: 'valid', points: [[2, 3], [2, 3], [12, 3]], width: 2 },
        { id: 'valid', points: [[1, 1], [15, 1]], width: 2 },
        { id: 'bad-width', points: [[1, 1], [15, 1]], width: 1 },
        { id: 'bad-points', points: [[1, 1], [1, 1]], width: 2 },
    ],
}, { mapWidth: 20, mapHeight: 20 });
assert.equal(duplicateAndInvalid.passages.length, 1);
assert.deepEqual(duplicateAndInvalid.passages[0].points, [[2, 3], [12, 3]]);
assert.deepEqual(duplicateAndInvalid.diagnostics.map((entry) => entry.code), [
    'duplicate-id', 'invalid-width', 'invalid-points',
]);

const selfIntersecting = normalizePassagesForRuntime({
    version: 1,
    items: [{
        id: 'figure-eight', width: 2,
        points: [[2, 2], [18, 18], [2, 18], [18, 2], [26, 10]],
    }],
}, { mapWidth: 32, mapHeight: 24 });
assert.equal(selfIntersecting.passages.length, 0);
assert.equal(selfIntersecting.diagnostics[0].code, 'self-overlapping-corridor');

const selfTouching = normalizePassagesForRuntime({
    version: 1,
    items: [{
        id: 'hairpin', width: 5,
        points: [[2, 2], [20, 2], [20, 12], [3, 12], [3, 6], [12, 6]],
    }],
}, { mapWidth: 30, mapHeight: 20 });
assert.equal(selfTouching.passages.length, 0);
assert.equal(selfTouching.diagnostics[0].code, 'self-overlapping-corridor');

const rasterBudget = normalizePassagesForRuntime({
    version: 1,
    items: [{ id: 'too-large', width: 6, points: [[2, 2], [28, 18]] }],
}, { mapWidth: 32, mapHeight: 24, maxRasterCells: 100 });
assert.equal(rasterBudget.passages.length, 0);
assert.equal(rasterBudget.diagnostics[0].code, 'raster-budget-exceeded');

const rasterWorkBudget = normalizePassagesForRuntime({
    version: 1,
    items: [{ id: 'too-much-work', width: 4, points: [[2, 2], [12, 2], [12, 12]] }],
}, { mapWidth: 20, mapHeight: 20, maxRasterCells: 1000, maxRasterWork: 20 });
assert.equal(rasterWorkBudget.passages.length, 0);
assert.equal(rasterWorkBudget.diagnostics[0].code, 'raster-work-budget-exceeded');

const totalRasterBudget = normalizePassagesForRuntime({
    version: 1,
    items: [
        { id: 'first-budget', width: 2, points: [[2, 3], [12, 3]] },
        { id: 'second-budget', width: 2, points: [[2, 10], [12, 10]] },
    ],
}, { mapWidth: 20, mapHeight: 16, maxRasterCells: 1000, maxTotalRasterCells: 100 });
assert.equal(totalRasterBudget.passages.length, 1);
assert.equal(totalRasterBudget.diagnostics.at(-1).code, 'total-raster-budget-exceeded');

const totalRasterWorkBudget = normalizePassagesForRuntime({
    version: 1,
    items: [
        { id: 'first-work', width: 2, points: [[2, 3], [12, 3]] },
        { id: 'second-work', width: 2, points: [[2, 10], [12, 10]] },
    ],
}, {
    mapWidth: 20, mapHeight: 16, maxRasterCells: 1000,
    maxTotalRasterCells: 1000, maxRasterWork: 1000, maxTotalRasterWork: 50,
});
assert.equal(totalRasterWorkBudget.passages.length, 1);
assert.equal(totalRasterWorkBudget.diagnostics.at(-1).code, 'total-raster-work-budget-exceeded');

// Horizontal/vertical/diagonal/bent/fractional raster rules and stable hashes.
const geometricCases = normalizePassagesForRuntime({
    version: 1,
    items: [
        { id: 'horizontal', points: [[4, 8], [25, 8]], width: 6 },
        { id: 'vertical', points: [[8, 4], [8, 25]], width: 6 },
        { id: 'diagonal', points: [[4.5, 4.25], [25.25, 24.75]], width: 7.5 },
        { id: 'sharp-bend', points: [[3, 22], [13, 22], [13, 12], [26, 12]], width: 6 },
        { id: 'short-first-last-segments', points: [[2, 16], [2.25, 16], [21.75, 16], [22, 16]], width: 2 },
    ],
}, { mapWidth: 32, mapHeight: 32 });
assert.equal(geometricCases.diagnostics.length, 0);
assert.equal(geometricCases.passages.length, 5);
for (const passage of geometricCases.passages) {
    assertConnectedPassable(passage);
    assert.ok(passage.grid.includes(PASSAGE_BOUNDARY_VALUE), `${passage.id} lacks a boundary cost band`);
    assert.ok(passage.startEntrance.length > 0 && passage.endEntrance.length > 0);
    assert.ok(passage.localWidth * passage.localHeight < 32 * 32, `${passage.id} was not cropped`);
}
const hashes = Object.fromEntries(geometricCases.passages.map((passage) => [passage.id, hashTypedArrays(passage)]));
assert.deepEqual(hashes, {
    horizontal: 'af84e8eb9e260a07520e9ccdf4523570d1c288c2136968c12afa1810bc11ac4d',
    vertical: '7b05dc3f89c6cad616a288f1f929a8ec93732f38fa883441e9b53339af01c672',
    diagonal: '34acd3ca76412b51cb60456bbb52bb5d7008467ad9c87112354a20f26687c9a4',
    'sharp-bend': '4fdeb2a3795f30ec449b4e9b6219da923ef075c212c9bcb1e9b7a2463c55af60',
    'short-first-last-segments': 'd4a61e4129696ae6f0557192b1f0b7c6f442b1c64d1c1aeec65c74538535e278',
});

const horizontal = geometricCases.passages[0];
assert.equal(passageGridValueAt(horizontal, 12, 8), PASSAGE_FAST_VALUE);
assert.equal(passageGridValueAt(horizontal, 12, 20), 0);
assert.equal(hitTestPassage(horizontal, 12, 11), true);
assert.equal(hitTestPassage(horizontal, 12, 11.1), false);
const local = globalToPassageLocal(horizontal, 12, 8);
assert.deepEqual(passageLocalToGlobal(horizontal, local.x, local.y), { x: 12, y: 8 });
const localIndex = passageLocalIndex(horizontal, 4, 8);
assert.deepEqual(passageLocalIndexToGlobal(horizontal, localIndex), { x: 4, y: 8 });
assert.equal(entranceContainsLocalIndex(horizontal.startEntrance, localIndex), true);

// Bbox allocation remains proportional to passage bbox, not the full mask.
const benchmark = createPassageBenchmarkFixture();
const normalizedBenchmark = normalizeFixture(benchmark);
assert.equal(normalizedBenchmark.passages.length, 4);
const passageCells = normalizedBenchmark.passages.reduce((sum, passage) => sum + passage.grid.length, 0);
assert.ok(passageCells < benchmark.baseMask.grid.length / 2);

// Critical crossing: a projected middle crossing remains base, while complete
// forward and reverse entrance-to-entrance paths classify identically.
const crossingFixture = fixtures['plus-crossing'];
const crossingPassage = normalizeFixture(crossingFixture).passages[0];
const baseCrossing = classifyRoutePassages(crossingFixture.routes.projectedBaseCrossing, [crossingPassage]);
assert.deepEqual(baseCrossing.passageSpans, []);
assert.deepEqual(baseCrossing.legs.map((leg) => leg.surface), ['base']);
assert.equal(baseCrossing.diagnostics.some((entry) => entry.code === 'middle-only'), true);

const forward = classifyRoutePassages(crossingFixture.routes.forwardPassage, [crossingPassage]);
assert.deepEqual(forward.passageSpans, [{ passageId: 'crossing-vertical', fromIndex: 1, toIndex: 5 }]);
assert.deepEqual(forward.legs.map((leg) => leg.surface), ['base', 'passage:crossing-vertical', 'base']);
assert.deepEqual(forward.legs, [
    { surface: 'base', points: [12, -2, 12, 2] },
    { surface: 'passage:crossing-vertical', points: [12, 2, 12, 7, 12, 12, 12, 17, 12, 22] },
    { surface: 'base', points: [12, 22, 12, 26] },
]);
assert.deepEqual(reconstructFlat(forward.legs), routeFlat(crossingFixture.routes.forwardPassage));

const reverse = classifyRoutePassages(crossingFixture.routes.reversePassage, [crossingPassage]);
assert.deepEqual(reverse.passageSpans, [{ passageId: 'crossing-vertical', fromIndex: 1, toIndex: 5 }]);
assert.deepEqual(reconstructFlat(reverse.legs), routeFlat(crossingFixture.routes.reversePassage));

const sameEntrance = classifyRoutePassages(crossingFixture.routes.sameEntranceReturn, [crossingPassage]);
assert.deepEqual(sameEntrance.passageSpans, []);
assert.equal(sameEntrance.diagnostics.some((entry) => entry.code === 'same-entrance-or-incomplete'), true);

const terminates = classifyRoutePassages(crossingFixture.routes.terminatesInside, [crossingPassage]);
assert.deepEqual(terminates.passageSpans, []);
assert.equal(terminates.diagnostics.some((entry) => entry.code === 'terminates-in-passage'), true);

const exitsSide = classifyRoutePassages(crossingFixture.routes.exitsSide, [crossingPassage]);
assert.deepEqual(exitsSide.passageSpans, []);
assert.equal(exitsSide.diagnostics.some((entry) => entry.code === 'rejected-complete-span'), true);

// Wide diagonal and bent routes are accepted only while the complete span is
// contained in the rounded corridor; routes are never reduced to centreline.
const wideFixture = fixtures['wide-diagonal'];
const widePassage = normalizeFixture(wideFixture).passages[0];
const wide = classifyRoutePassages(wideFixture.routes.offCentreDiagonal, [widePassage]);
assert.deepEqual(wide.passageSpans, [{ passageId: 'wide-horizontal', fromIndex: 1, toIndex: 3 }]);
assert.deepEqual(reconstructFlat(wide.legs), routeFlat(wideFixture.routes.offCentreDiagonal));

// A short sub-pixel excursion caused by route/raster rounding is tolerated;
// the longer side exit above is not.
const roundingExcursion = classifyRoutePassages([
    [3, 14], [8, 14], [19.5, 15], [20, 15.5], [20.5, 15], [32, 14], [37, 14],
], [widePassage]);
assert.deepEqual(roundingExcursion.passageSpans, [
    { passageId: 'wide-horizontal', fromIndex: 1, toIndex: 5 },
]);

const bentFixture = fixtures['bent-passage'];
const bentPassage = normalizeFixture(bentFixture).passages[0];
const legalBent = classifyRoutePassages(bentFixture.routes.legalInteriorCut, [bentPassage]);
assert.equal(legalBent.passageSpans.length, 1);
const illegalBent = classifyRoutePassages(bentFixture.routes.illegalCornerCut, [bentPassage]);
assert.equal(illegalBent.passageSpans.length, 0);

// Equal complete matches in overlapping footprints use stable passage-id order.
const overlapTie = normalizePassagesForRuntime({
    version: 1,
    items: [
        { id: 'z-identical', points: [[3, 10], [27, 10]], width: 6 },
        { id: 'a-identical', points: [[3, 10], [27, 10]], width: 6 },
    ],
}, { mapWidth: 32, mapHeight: 20 }).passages;
const tieRoute = [[-1, 10], [3, 10], [15, 10], [27, 10], [31, 10]];
const tie = classifyRoutePassages(tieRoute, overlapTie);
assert.deepEqual(tie.passageSpans, [{ passageId: 'a-identical', fromIndex: 1, toIndex: 3 }]);

const independentOverlapFixture = fixtures['overlapping-independent-passages'];
const independentOverlap = normalizeFixture(independentOverlapFixture).passages;
assert.equal(independentOverlap.length, 2);
assert.notEqual(`passage:${independentOverlap[0].id}`, `passage:${independentOverlap[1].id}`);
assert.notEqual(passageLocalIndex(independentOverlap[0], 15, 15), -1);
assert.notEqual(passageLocalIndex(independentOverlap[1], 15, 15), -1);

const baseOnlyFixture = fixtures['base-only-regression'];
const baseOnlyRoute = [[2, 4], [14, 10], [29, 20]];
const baseOnlyClassification = classifyRoutePassages(baseOnlyRoute, normalizeFixture(baseOnlyFixture).passages);
assert.deepEqual(baseOnlyClassification, {
    legs: [{ surface: 'base', points: routeFlat(baseOnlyRoute) }],
    passageSpans: [],
    diagnostics: [],
});

// A valid persisted passage can still have zero currently passable base portal
// cells. That is a layered-search diagnostic, not a geometry deletion.
const invalidEntrancesFixture = fixtures['invalid-base-entrances'];
const invalidEntrancePassage = normalizeFixture(invalidEntrancesFixture).passages[0];
for (const entrance of [invalidEntrancePassage.startEntrance, invalidEntrancePassage.endEntrance]) {
    const passable = Array.from(entrance).filter((index) => {
        const global = passageLocalIndexToGlobal(invalidEntrancePassage, index);
        return invalidEntrancesFixture.baseMask.grid[global.y * invalidEntrancesFixture.baseMask.width + global.x] !== 0;
    });
    assert.equal(passable.length, 0);
}

assert.match(EXPECTED_PASSAGE_SEMANTICS.controls, /base/);
assert.match(EXPECTED_PASSAGE_SEMANTICS.blockers, /base only/);
assert.match(EXPECTED_PASSAGE_SEMANTICS.routeReclassification, /opposite-entrance/);

console.log(`passage geometry/classifier: ${geometricCases.passages.length} raster cases, ${Object.keys(fixtures).length} topology fixtures, all checks passed`);
