// Runtime half of the WP 6.3 A/B benchmark.
// Loads a temporary artifact with the production Node router and reports
// state-build, snap, route-search, and heap measurements as JSON.

import { performance } from 'node:perf_hooks';
import { loadMask, loadArtifact } from './navgraph_harness.mjs';
import {
	buildState, snapEndpoint, graphAstar,
} from '../project/static/project/js/pathing/navgraph_router.js';

function arg(name, fallback = null) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function percentile(values, p) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
}

const maskPath = arg('mask');
const binPath = arg('bin');
const count = Number(arg('count', '20'));
if (!maskPath || !binPath) throw new Error('usage: --mask PNG --bin BIN [--count N]');

const beforeHeap = process.memoryUsage().heapUsed;
const t0 = performance.now();
const [{ mask, W, H }, artifact] = await Promise.all([
	loadMask(maskPath),
	Promise.resolve(loadArtifact(binPath)),
]);
const t1 = performance.now();
const state = buildState(artifact, mask);
const stateBuildMs = performance.now() - t1;
const inRegion = [];
for (let i = 0; i < artifact.N; i++) {
	if (!state.nodeInRegion || state.nodeInRegion[i]) inRegion.push(i);
}
const snap = [], route = [], total = [];
let pairs = 0;
const probeCount = Math.min(count, 20);
for (let k = 0; k < probeCount && inRegion.length >= 2; k++) {
	const si = inRegion[Math.floor((k + 1) * inRegion.length / (probeCount + 1))];
	const gi = inRegion[inRegion.length - 1 - Math.floor((k + 1) * inRegion.length / (probeCount + 1))];
	const start = { x: artifact.nodes[2 * si], y: artifact.nodes[2 * si + 1] };
	const goal = { x: artifact.nodes[2 * gi], y: artifact.nodes[2 * gi + 1] };
	const pairStart = performance.now();
	const snapStart = performance.now();
	const startSnap = snapEndpoint(state, start, performance.now() + 500);
	const goalSnap = snapEndpoint(state, goal, performance.now() + 500);
	snap.push(performance.now() - snapStart);
	if (!startSnap.length || !goalSnap.length) continue;
	const routeStart = performance.now();
	const result = graphAstar(
		state, goal, startSnap, goalSnap, null, performance.now() + 1000);
	route.push(performance.now() - routeStart);
	if (result) { pairs++; total.push(performance.now() - pairStart); }
}
const afterHeap = process.memoryUsage().heapUsed;

console.log(JSON.stringify({
	mask: maskPath,
	artifactNodes: artifact.N,
	artifactEdges: artifact.E,
	loadMs: +(t1 - t0).toFixed(2),
	stateBuildMs: +stateBuildMs.toFixed(2),
	pairs,
	attempts: inRegion.length >= 2 ? probeCount : 0,
	validRate: inRegion.length >= 2 && probeCount ? +(pairs / probeCount).toFixed(4) : 0,
	method: 'deterministic in-region node pairs; snapEndpoint + graphAstar',
	snapP50Ms: percentile(snap, 0.50),
	snapP90Ms: percentile(snap, 0.90),
	routeP50Ms: percentile(route, 0.50),
	routeP90Ms: percentile(route, 0.90),
	totalP50Ms: percentile(total, 0.50),
	totalP90Ms: percentile(total, 0.90),
	heapBeforeBytes: beforeHeap,
	heapAfterBytes: afterHeap,
	heapDeltaBytes: afterHeap - beforeHeap,
	environment: { node: process.version, cpuThrottle: 'none' },
}));
