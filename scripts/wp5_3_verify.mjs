// =============================================================================
// wp5_3_verify.mjs — acceptance harness for WP 5.3 (mask barriers).
//
// Runs the real generateOnePair pipeline on small, median and 75 Mpx masks.
// For each served pair it proves:
//   - every placed and skipped bar endpoint is a significant obstacle anchor;
//   - every placed bar crossed >=1 edge of the route that created it;
//   - neither served refined route crosses a lower-attempt active bar.
//
//   node scripts/wp5_3_verify.mjs [--seed 1] [--count 100]
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildState, generateOnePair, inSignificantObstacle, makeRng } from '../project/static/project/js/pathing/navgraph_router.js';
import { countBarrierViolations } from '../project/static/project/js/pathing/refine_theta.js';
import { loadArtifact, loadMask } from './navgraph_harness.mjs';
import * as routePairSelection from '../results/static/results/js/infinite/route_pair_selection.js';

const MASKS = [
	{ file: 'media/masks/mask_20250602_081036.png', label: 'small' },
	{ file: 'media/masks/mask_20250715_092410.png', label: 'median' },
	{ file: 'media/masks/mask_20260422_134232.png', label: '75Mpx' },
];

function parseArgs(argv) {
	const args = { seed: 1, count: 100, mask: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--seed') args.seed = Number.parseInt(argv[++i], 10);
		if (argv[i] === '--count') args.count = Number.parseInt(argv[++i], 10);
		if (argv[i] === '--mask') args.mask = argv[++i];
	}
	return args;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function verifyMask(spec, { seed, count }) {
	const bin = spec.file.replace(/\.png$/i, '.navgraph.bin');
	assert(fs.existsSync(spec.file) && fs.existsSync(bin), `${spec.label}: missing mask or artifact`);
	const artifact = loadArtifact(bin);
	const { mask } = await loadMask(spec.file);
	const state = buildState(artifact, mask);
	const rng = makeRng(seed);
	const summary = {
		label: spec.label, mask: path.basename(spec.file), accepted: 0, calls: 0,
		placedBars: 0, skippedBars: 0, activeRouteBars: 0, legality: 0,
		barrierViolations: 0, anchorFailures: 0, ineffectiveBars: 0,
	};
	const started = performance.now();
	while (summary.accepted < count && summary.calls < count * 200) {
		summary.calls++;
		const res = generateOnePair(state, { rng, maxAttempts: 400, selection: routePairSelection });
		if (!res.ok) continue;
		summary.accepted++;
		summary.legality += res.meta.legality || 0;
		for (const bar of res.barriers || []) {
			summary.placedBars++;
			const anchored = inSignificantObstacle(state, bar.ax, bar.ay)
				&& inSignificantObstacle(state, bar.bx, bar.by);
			if (!anchored) summary.anchorFailures++;
			if (!(bar.routeEdgeCrossings >= 1)) summary.ineffectiveBars++;
		}
		for (const bar of res.skippedBarriers || []) {
			summary.skippedBars++;
			if (!inSignificantObstacle(state, bar.ax, bar.ay)
				|| !inSignificantObstacle(state, bar.bx, bar.by)) summary.anchorFailures++;
		}
		for (let i = 0; i < 2; i++) {
			const active = res.meta.refine[i].activeBarriers || [];
			summary.activeRouteBars += active.length;
			summary.barrierViolations += countBarrierViolations(res.routes[i], active);
		}
	}
	summary.ms = +(performance.now() - started).toFixed(0);
	assert(summary.accepted === count, `${spec.label}: only ${summary.accepted}/${count} accepted pairs`);
	assert(summary.legality === 0, `${spec.label}: ${summary.legality} true-mask legality violations`);
	assert(summary.anchorFailures === 0, `${spec.label}: ${summary.anchorFailures} unanchored bar ends`);
	assert(summary.ineffectiveBars === 0, `${spec.label}: ${summary.ineffectiveBars} no-op placed bars`);
	assert(summary.barrierViolations === 0, `${spec.label}: ${summary.barrierViolations} active-bar route crossings`);
	return summary;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	console.log(`WP 5.3 verify: ${args.count} pairs/mask, seed=${args.seed}`);
	const results = [];
	const masks = args.mask ? MASKS.filter((spec) => spec.label === args.mask) : MASKS;
	assert(masks.length > 0, `unknown --mask value ${args.mask}`);
	for (const spec of masks) {
		const result = await verifyMask(spec, args);
		results.push(result);
		console.log(`  ${result.label}: ${result.accepted} pairs; placed=${result.placedBars}, skipped=${result.skippedBars}, `
			+ `active-route-bars=${result.activeRouteBars}; legality=${result.legality}, bar-cross=${result.barrierViolations}; ${result.ms}ms`);
	}
	const total = results.reduce((out, r) => {
		for (const key of ['accepted', 'placedBars', 'skippedBars', 'activeRouteBars', 'legality', 'barrierViolations']) out[key] += r[key];
		return out;
	}, { accepted: 0, placedBars: 0, skippedBars: 0, activeRouteBars: 0, legality: 0, barrierViolations: 0 });
	console.log(`PASS: ${total.accepted} pairs, ${total.placedBars} placed bars, ${total.skippedBars} rendered skipped bars, `
		+ `${total.activeRouteBars} active-route bars, legality=${total.legality}, bar-cross=${total.barrierViolations}`);
	fs.mkdirSync('scratch/wp5_3', { recursive: true });
	fs.writeFileSync('scratch/wp5_3/wp5_3_results.json', JSON.stringify({ seed: args.seed, count: args.count, results, total }, null, 2));
}

main().catch((error) => { console.error(`FAIL: ${error.message}`); process.exit(1); });
