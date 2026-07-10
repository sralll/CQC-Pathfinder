// Infinity-mask endpoint terrain verification.
// Usage: node project/static/project/js/pathing/dev/navgraph_endpoint_terrain.test.mjs

import assert from 'node:assert/strict';
import { buildState, samplePair } from '../navgraph_router.js';

const W = 12, H = 4, coarseScale = 4;
const mask = new Uint8Array(W * H).fill(150);

// Cell 0 is entirely dark, cell 1 is mixed with one eligible pixel, and cell 2
// is entirely bright. Mixed cells must remain sampleable, but their exact
// endpoint must land on the >= 200 pixel.
mask[3 * W + 7] = 200;
for (let y = 0; y < H; y++) {
	for (let x = 8; x < W; x++) mask[y * W + x] = 230;
}

const artifact = {
	W, H, N: 0, E: 0, minCostPerPx: 1,
	nodes: new Uint32Array(), edges: new Uint32Array(), weights: new Float32Array(),
	coarseScale, ch: 1, cw: 3,
	coarseLabels: Int32Array.from([1, 1, 1]),
	coarseMinval: Uint8Array.from([150, 150, 230]),
	coarseClear: Float32Array.from([20, 20, 20]),
	hitzoneScale: coarseScale, hh: 1, hw: 3,
	coarseHitzone: Uint8Array.from([1, 1, 1]),
};

const state = buildState(artifact, mask, {
	distMinPx: 0,
	distMaxPx: 100,
	obstacleMinRunPx: 0,
});
assert.deepEqual(state.sampleCells, [1, 2], 'dark-only cells must not be sampled');

// Pick mixed cell 1 for the start. Six random probes deliberately hit its dark
// corner, exercising pixelInCell's fallback scan. Then pick bright cell 2.
const values = [0, ...new Array(12).fill(0), 0.999, 0.999, 0.999];
let cursor = 0;
const pair = samplePair(state, () => values[cursor++] ?? 0.999);
assert.equal(pair.reason, undefined);
assert.ok(mask[pair.start.y * W + pair.start.x] >= 200);
assert.ok(mask[pair.goal.y * W + pair.goal.x] >= 200);

console.log('navgraph endpoint terrain tests passed');
