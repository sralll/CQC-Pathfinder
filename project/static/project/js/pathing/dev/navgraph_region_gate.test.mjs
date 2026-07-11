// Region-gate verification: a served Infinity route may never touch a graph
// node outside the stored region hit zone (the coach-drawn polygon), even
// when those nodes offer the only graph connection between two in-region
// endpoints. Endpoint sampling was always region-gated; this locks the same
// authority onto snapping and graph A* expansion.
// Usage: node project/static/project/js/pathing/dev/navgraph_region_gate.test.mjs

import assert from 'node:assert/strict';
import { buildState, snapEndpoint, graphAstar } from '../navgraph_router.js';

const W = 24, H = 16, coarseScale = 4;

// Fully passable mask except a vertical wall splitting the in-region half.
const mask = new Uint8Array(W * H).fill(200);
for (let y = 0; y < 8; y++) { mask[y * W + 11] = 0; mask[y * W + 12] = 0; }

// Nodes: two in-region (top half), two outside (bottom half). The only graph
// connection between the in-region nodes runs through the outside pair.
const nodes = Int32Array.from([
    4, 4,     // n0 in region, left of the wall
    20, 4,    // n1 in region, right of the wall
    4, 12,    // n2 outside
    20, 12,   // n3 outside
]);
const edges = Int32Array.from([0, 2, 2, 3, 3, 1]);
const weights = Float32Array.from([10, 10, 10]);

function makeArtifact(hitzoneRow) {
    return {
        W, H, N: 4, E: 3, minCostPerPx: 1,
        nodes, edges, weights,
        coarseScale, ch: 4, cw: 6,
        coarseLabels: Int32Array.from(new Array(24).fill(1)),
        coarseMinval: Uint8Array.from(new Array(24).fill(200)),
        coarseClear: Float32Array.from(new Array(24).fill(20)),
        hitzoneScale: coarseScale, hh: 4, hw: 6,
        // Row pattern per coarse row: [top, top, bottom, bottom].
        coarseHitzone: Uint8Array.from([
            ...new Array(12).fill(hitzoneRow.top),
            ...new Array(12).fill(hitzoneRow.bottom),
        ]),
    };
}

// snapMaxDistPx is small so each endpoint can only anchor to its own nearest
// node — the production 200 px radius would let a stub bypass the graph
// entirely on this miniature map.
const cfg = { distMinPx: 0, distMaxPx: 100, obstacleMinRunPx: 0, snapMaxDistPx: 8 };
const start = { x: 2, y: 4 };
const goal = { x: 22, y: 4 };

// Control: with the whole map inside the region, the detour through n2/n3 is
// the served route.
{
    const state = buildState(makeArtifact({ top: 1, bottom: 1 }), mask, cfg);
    assert.deepEqual(Array.from(state.nodeInRegion), [1, 1, 1, 1]);
    const res = graphAstar(
        state, goal, snapEndpoint(state, start), snapEndpoint(state, goal), null,
    );
    assert.ok(res, 'in-region control route must exist');
    assert.deepEqual(res.nodePath, [4, 0, 2, 3, 1, 5]);
}

// Gate: with only the top half inside the region, the outside detour is
// forbidden — no route at all rather than a route touching outside nodes.
{
    const state = buildState(makeArtifact({ top: 1, bottom: 0 }), mask, cfg);
    assert.deepEqual(Array.from(state.nodeInRegion), [1, 1, 0, 0]);
    // Snapping never anchors to outside nodes either.
    const outsideSnap = snapEndpoint(state, { x: 5, y: 12 });
    assert.ok(outsideSnap.every(s => state.nodeInRegion[s.node] === 1),
        'snap stubs must not anchor outside the region');
    const res = graphAstar(
        state, goal, snapEndpoint(state, start), snapEndpoint(state, goal), null,
    );
    assert.equal(res, null, 'a route through outside nodes must be rejected');
}

console.log('navgraph region gate: outside nodes excluded from snapping and A* expansion passed');
