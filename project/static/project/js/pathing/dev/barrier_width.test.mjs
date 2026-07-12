// Mask blocker geometry must use the same finite butt-capped rectangle that
// the player draws, including fractional per-map widths.

import assert from 'node:assert/strict';
import { blockedByBarriers } from '../navgraph_router.js';
import { countBarrierViolations } from '../refine_theta.js';

const artifact = {
    E: 1,
    edges: Int32Array.from([0, 1]),
    // This edge runs parallel to the blocker centreline, one pixel away.
    nodes: Int32Array.from([0, 1, 10, 1]),
    edgeKinds: null,
    edgePassage: null,
};
const barrier = { ax: 0, ay: 0, bx: 10, by: 0, surface: 'base' };

const wideState = { artifact, cfg: { barrierWidthPx: 3.7 } };
assert.ok(blockedByBarriers(wideState, [barrier]).has(0),
    'an edge inside the visible stroke must be blocked even without crossing its centreline');

const narrowState = { artifact, cfg: { barrierWidthPx: 1 } };
assert.equal(blockedByBarriers(narrowState, [barrier]).size, 0,
    'an edge outside the visible stroke must remain available');

const parallelPath = [{ x: 0, y: 1 }, { x: 10, y: 1 }];
assert.ok(countBarrierViolations(parallelPath, [barrier], 3.7) > 0);
assert.equal(countBarrierViolations(parallelPath, [barrier], 1), 0);

const beyondButtCap = [{ x: -2, y: -0.25 }, { x: -2, y: 0.25 }];
assert.equal(countBarrierViolations(beyondButtCap, [barrier], 3.7), 0,
    'routing must not invent a round-cap extension beyond the drawn line');

console.log('mask barrier width matches the visible butt-capped stroke');
