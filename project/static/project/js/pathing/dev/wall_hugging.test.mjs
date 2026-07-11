// CR 6 wall-hugging investigation and regression suite.
// Usage: node project/static/project/js/pathing/dev/wall_hugging.test.mjs

import assert from 'node:assert/strict';
import { MinHeap } from '../heap.js';
import {
    distanceToPassage,
    normalizePassagesForRuntime,
    passageEntranceAt,
    passageGridValueAt,
} from '../passage_geometry.js';
import { classifyRoutePassages } from '../passage_classifier.js';
import { runLayeredPipeline } from '../layered_pipeline.js';
import {
    attachLevelPassages,
    buildState,
    countTypedLegalityViolations,
    graphAstar,
    refineTypedNavgraphRoute,
} from '../navgraph_router.js';
import { nodePathToTypedRoute } from '../navgraph_passage_overlay.js';
import { createWallHuggingFixtures } from './wall_hugging_fixtures.mjs';

const DXS = [-1, -1, -1, 0, 0, 1, 1, 1];
const DYS = [-1, 0, 1, -1, 1, -1, 0, 1];
const STEP = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

function discreteReferenceCost(grid, w, h, start, goal) {
    const source = start.y * w + start.x;
    const target = goal.y * w + goal.x;
    const costs = new Float64Array(grid.length);
    costs.fill(Infinity);
    costs[source] = 0;
    const open = new MinHeap();
    open.push(0, source);
    while (open.size) {
        const current = open.pop();
        if (current === target) return costs[current];
        const x = current % w;
        const y = (current - x) / w;
        for (let k = 0; k < 8; k++) {
            const nx = x + DXS[k], ny = y + DYS[k];
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const next = ny * w + nx;
            if (!grid[next]) continue;
            const candidate = costs[current] + STEP[k] * (255 - grid[next]);
            if (candidate < costs[next]) {
                costs[next] = candidate;
                open.push(candidate, next);
            }
        }
    }
    return Infinity;
}

function assertLegLegal(leg, passage) {
    for (let i = 2; i < leg.points.length; i += 2) {
        const ax = leg.points[i - 2], ay = leg.points[i - 1];
        const bx = leg.points[i], by = leg.points[i + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
        for (let step = 0; step <= steps; step++) {
            const t = step / steps;
            assert.ok(Number.isFinite(distanceToPassage(
                passage, ax + (bx - ax) * t, ay + (by - ay) * t,
            )), `${passage.id} simplified leg left its legal raster`);
            assert.notEqual(passageGridValueAt(
                passage,
                Math.round(ax + (bx - ax) * t),
                Math.round(ay + (by - ay) * t),
            ), 0, `${passage.id} simplified leg crossed a blocked raster cell`);
        }
    }
}

function wallClearances(passage, leg) {
    let minLeft = Infinity;
    let minRight = Infinity;
    const radius = passage.width / 2;
    for (let i = 0; i < leg.points.length; i += 2) {
        const px = leg.points[i], py = leg.points[i + 1];
        let nearest = null;
        for (let segment = 1; segment < passage.points.length; segment++) {
            const a = passage.points[segment - 1], b = passage.points[segment];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const lengthSquared = dx * dx + dy * dy;
            const t = Math.max(0, Math.min(1,
                ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSquared));
            const qx = a[0] + t * dx, qy = a[1] + t * dy;
            const distanceSquared = (px - qx) ** 2 + (py - qy) ** 2;
            if (!nearest || distanceSquared < nearest.distanceSquared) {
                const length = Math.sqrt(lengthSquared);
                nearest = {
                    distanceSquared,
                    signedOffset: (-(dy / length) * (px - qx))
                        + ((dx / length) * (py - qy)),
                };
            }
        }
        minLeft = Math.min(minLeft, radius - nearest.signedOffset);
        minRight = Math.min(minRight, radius + nearest.signedOffset);
    }
    return { minLeftWall: minLeft, minRightWall: minRight };
}

const records = [];
const fixtures = createWallHuggingFixtures();
for (const fixture of fixtures) {
    const normalized = normalizePassagesForRuntime(fixture.passageDocument, {
        mapWidth: fixture.mapWidth,
        mapHeight: fixture.mapHeight,
    });
    assert.deepEqual(normalized.diagnostics, [], fixture.name);
    const passage = normalized.passages[0];
    const result = runLayeredPipeline(
        fixture.grid, fixture.mapWidth, fixture.mapHeight,
        { x: fixture.start[0], y: fixture.start[1] },
        { x: fixture.goal[0], y: fixture.goal[1] },
        [passage], 'wall-hugging-test', null, [],
    );
    assert.ok(result.path, `${fixture.name}: ${result.error}`);
    assert.equal(result.typedLegs.length, 3, fixture.name);
    const leg = result.typedLegs[1];
    const expectedEntrances = leg.direction === 'from-start' ? [1, 2] : [2, 1];
    assert.equal(passageEntranceAt(
        passage, leg.points[0], leg.points[1],
    ), expectedEntrances[0]);
    assert.equal(passageEntranceAt(
        passage, leg.points.at(-2), leg.points.at(-1),
    ), expectedEntrances[1]);
    assertLegLegal(leg, passage);
    const classification = classifyRoutePassages(result.path, [passage]);
    assert.equal(classification.passageSpans.length, 1, fixture.name);

    const startLocal = {
        x: leg.points[0] - passage.originX,
        y: leg.points[1] - passage.originY,
    };
    const endLocal = {
        x: leg.points.at(-2) - passage.originX,
        y: leg.points.at(-1) - passage.originY,
    };
    const referenceCost = discreteReferenceCost(
        passage.grid, passage.localWidth, passage.localHeight, startLocal, endLocal,
    );
    assert.ok(Number.isFinite(referenceCost), fixture.name);

    // A corrected path changes lateral position throughout the passage. It
    // must not retain a wall-parallel dense spine and jump across only at an
    // endpoint. Two-point any-angle legs are the ideal gradual straight case.
    const dx = Math.abs(leg.points.at(-2) - leg.points[0]);
    const dy = Math.abs(leg.points.at(-1) - leg.points[1]);
    assert.ok(dx > 0 && dy > 0, `${fixture.name} did not make a gradual lateral change`);

    const diagnostics = result.refinementDiagnostics;
    assert.ok(diagnostics && diagnostics.portalCells.length === 1, fixture.name);
    const passageRefinedCost = diagnostics.legCosts[1].cost;
    assert.ok(
        passageRefinedCost <= referenceCost * 1.01,
        `${fixture.name} refined=${passageRefinedCost} reference=${referenceCost}`,
    );
    const clearances = wallClearances(passage, leg);
    records.push({
        fixture: fixture.name,
        width: passage.width,
        corridorRadiusComparison: passage.width > 48 ? 'above-2r' : 'below-2r',
        portals: diagnostics.portalCells[0],
        denseLayeredCost: +diagnostics.denseCost.toFixed(2),
        refinedCost: +diagnostics.refinedCost.toFixed(2),
        passageRefinedCost: +passageRefinedCost.toFixed(2),
        passageReferenceCost: +referenceCost.toFixed(2),
        minLeftWallDistance: +clearances.minLeftWall.toFixed(2),
        minRightWallDistance: +clearances.minRightWall.toFixed(2),
        passagePoints: leg.points.length / 2,
    });
}

// Infinity's dynamic passage edge used the same fixed-radius refinement and
// therefore receives the same full-raster correction. The base navgraph path
// remains disconnected; only flat portal nodes bridge the wall.
{
    const fixture = fixtures[0];
    const nodes = [8, 25, 30, 25, 100, 79, 124, 79];
    const edges = [0, 1, 2, 3];
    const weights = new Float32Array([22 * 14, 24 * 14]);
    const coarseScale = 10;
    const ch = Math.ceil(fixture.mapHeight / coarseScale);
    const cw = Math.ceil(fixture.mapWidth / coarseScale);
    const state = buildState({
        W: fixture.mapWidth,
        H: fixture.mapHeight,
        N: 4,
        E: 2,
        minCostPerPx: 14,
        nodes: Uint32Array.from(nodes),
        edges: Uint32Array.from(edges),
        weights,
        coarseScale,
        ch,
        cw,
        coarseLabels: new Int32Array(ch * cw).fill(1),
        coarseMinval: new Uint8Array(ch * cw).fill(241),
        coarseClear: new Float32Array(ch * cw).fill(40),
        hitzoneScale: coarseScale,
        hh: ch,
        hw: cw,
        coarseHitzone: new Uint8Array(ch * cw).fill(1),
    }, fixture.grid, {
        snapMaxDistPx: 40,
        snapMaxTargets: 2,
        corridorRadius: 24,
        passageCorridorRadius: 8,
        refineBudgetMs: Infinity,
    });
    attachLevelPassages(state, fixture.passageDocument.items);
    const found = graphAstar(
        state, { x: fixture.goal[0], y: fixture.goal[1] },
        [{ node: 0, w: 0 }], [{ node: 3, w: 0 }], null,
    );
    assert.ok(found, 'Infinity wide-passage route was not found');
    const typed = nodePathToTypedRoute(
        state, found.nodePath,
        { x: fixture.start[0], y: fixture.start[1] },
        { x: fixture.goal[0], y: fixture.goal[1] },
    );
    const refined = refineTypedNavgraphRoute(state, {
        path: typed.path,
        typedLegs: typed.legs,
        cost: found.cost,
    }, [], { routeIndex: 0 });
    assert.notEqual(refined.mode, 'unusable');
    assert.equal(countTypedLegalityViolations(state, refined.typedLegs), 0);
    const passageLeg = refined.typedLegs.find(leg => leg.surface !== 'base');
    assert.ok(passageLeg.points.at(-1).y !== passageLeg.points[0].y,
        'Infinity passage leg did not make a gradual lateral change');
}

console.log(JSON.stringify({ wallHuggingDiagnostics: records }, null, 2));
console.log('wall-hugging passage routes: full-raster gradual refinement and diagnostics passed');
