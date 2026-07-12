// Obstacle-density preference for infinity-mask endpoints.
// Usage: node project/static/project/js/pathing/dev/navgraph_endpoint_density.test.mjs

import assert from 'node:assert/strict';
import { buildState, makeRng, samplePair } from '../navgraph_router.js';

const W = 240, H = 80, coarseScale = 8;
const cw = W / coarseScale, ch = H / coarseScale;
const mask = new Uint8Array(W * H).fill(230);

// A large obstacle-rich district sits below the endpoint strip on the right.
// Its black pixels fall inside the sampler's 100 px neighbourhood without
// making the eligible endpoint pixels themselves impassable.
for (let y = 36; y < H; y++) {
	for (let x = 140; x < 220; x++) mask[y * W + x] = 0;
}

const clear = new Float32Array(ch * cw);
for (let cy = 0; cy < 4; cy++) clear.fill(20, cy * cw, (cy + 1) * cw);
const artifact = {
	W, H, N: 0, E: 0, baseNodeCount: 0, minCostPerPx: 1,
	nodes: new Uint32Array(), edges: new Uint32Array(), weights: new Float32Array(),
	coarseScale, ch, cw,
	coarseLabels: new Int32Array(ch * cw).fill(1),
	coarseMinval: new Uint8Array(ch * cw).fill(230),
	coarseClear: clear,
	hitzoneScale: coarseScale, hh: ch, hw: cw,
	coarseHitzone: new Uint8Array(ch * cw).fill(1),
};

const state = buildState(artifact, mask, {
	distMinPx: 1,
	distMaxPx: 1000,
	obstacleMinRunPx: 0,
});
assert.ok(state.endpointDensityTotal > 0, 'black-pixel density scores should be indexed');

const rng = makeRng(17);
let obstacleRichStarts = 0;
const trials = 1000;
for (let i = 0; i < trials; i++) {
	const pair = samplePair(state, rng);
	assert.equal(pair.reason, undefined);
	if (pair.start.x >= 90) obstacleRichStarts++;
}

// Uniform sampling puts 62.5% of this strip at x>=90. The density preference
// should push that materially higher while the 15% uniform branch still keeps
// the open left side reachable.
assert.ok(obstacleRichStarts / trials > 0.82,
	`expected obstacle-rich preference, got ${obstacleRichStarts}/${trials}`);
assert.ok(obstacleRichStarts < trials,
	'uniform mixture should preserve occasional open-space endpoints');

// On an obstacle-free elongated region, only starts should receive the center
// bias. Goals remain uniform, which keeps routes reaching across the region.
const whiteMask = new Uint8Array(W * H).fill(230);
const centerState = buildState({
	...artifact,
	coarseClear: new Float32Array(ch * cw).fill(20),
}, whiteMask, {
	distMinPx: 1,
	distMaxPx: 1000,
	obstacleMinRunPx: 0,
});
assert.deepEqual(centerState.endpointRegionCenter, { x: W / 2, y: H / 2 });

const centerRng = makeRng(23);
let centralStarts = 0, centralGoals = 0, centerTrials = 2000;
for (let i = 0; i < centerTrials; i++) {
	const pair = samplePair(centerState, centerRng);
	assert.equal(pair.reason, undefined);
	if (pair.start.x >= 80 && pair.start.x < 160) centralStarts++;
	if (pair.goal.x >= 80 && pair.goal.x < 160) centralGoals++;
}
assert.ok(centralStarts / centerTrials > 0.38,
	`expected center-biased starts, got ${centralStarts}/${centerTrials}`);
assert.ok(centralGoals / centerTrials > 0.28 && centralGoals / centerTrials < 0.39,
	`goals should remain approximately uniform, got ${centralGoals}/${centerTrials}`);

console.log('navgraph endpoint density tests passed');
