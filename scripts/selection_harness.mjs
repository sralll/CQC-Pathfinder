// =============================================================================
// selection_harness.mjs - measure CITY-mode infinite-play route-pair selection.
//
// It drives the real city generator headlessly: no browser, DB, or Django.
// The run compares:
//   LEGACY   - old closest-runtime selector, 4 routes, no balance reject.
//   WEIGHTED - current selector, broad 10%-target scoring, 400ms budget for
//              the first two routes and 200ms for later routes.
//
// CLI:
//   node scripts/selection_harness.mjs --count 1000
//   node scripts/selection_harness.mjs --count 2000 --routes 5 --target 0.10 --cap 0.40
//
// Flags:
//   --count       accepted control pairs to measure per pass (1000)
//   --pairs       control pairs generated per city batch (5, production-like)
//   --routes      routes explored per problem in the weighted pass (5)
//   --cap         weighted hard runtime-gap cap, e.g. 0.40 = 40% (0.40)
//   --target      weighted distribution peak, e.g. 0.10 = 10% (0.10)
//   --stddev      weighted distribution width (0.06)
//   --uniform     baseline probability mass for edge diversity (0.10)
//   --index-bias  extra weight for higher route indexes (1.25)
//   --seed        base seed for the reproducible city-seed sequence (1)
// =============================================================================

import {
	generateSceneBatch,
	selectionConfig,
	balanceRejectConfig,
} from '../results/static/results/js/infinite/infinite_batch_worker.js';

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) args[key] = true;
		else { args[key] = next; i++; }
	}
	return args;
}

function makeSeedRng(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const BUCKETS = ['<=2%', '2-5%', '5-10%', '10-15%', '15-25%', '25-35%', '35-40%', '>=40%'];

function bucketFor(relGap) {
	if (relGap <= 0.02) return '<=2%';
	if (relGap <= 0.05) return '2-5%';
	if (relGap <= 0.10) return '5-10%';
	if (relGap <= 0.15) return '10-15%';
	if (relGap <= 0.25) return '15-25%';
	if (relGap <= 0.35) return '25-35%';
	if (relGap < 0.40) return '35-40%';
	return '>=40%';
}

function sceneRelGap(scene) {
	const rts = (scene.routes || [])
		.map((r) => r.run_time)
		.filter((v) => Number.isFinite(v) && v > 0)
		.sort((x, y) => x - y);
	if (rts.length < 2) return null;
	return (rts[rts.length - 1] - rts[0]) / rts[0];
}

function sceneExploredRoutes(scene) {
	return (scene.routeResult?.paths || []).length;
}

function sceneMaxRouteIndex(scene) {
	const indexes = scene.routeResult?.routeIndexes || [];
	return indexes.length ? Math.max(...indexes) : null;
}

function runPass(label, cfg, { count, pairs, seedRng }) {
	Object.assign(selectionConfig, cfg.selection);
	balanceRejectConfig.probability = cfg.balanceProbability;

	const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
	const gaps = [];
	const rejections = {};
	let accepted = 0;
	let batches = 0;
	let failures = 0;
	let exploredTotal = 0;
	let routeMsTotal = 0;
	let retryTotal = 0;
	let maxRouteIndexTotal = 0;
	let maxRouteIndexSamples = 0;

	while (accepted < count) {
		const seed = (seedRng() * 2147483646 | 0) + 1;
		let batch;
		try {
			batch = generateSceneBatch(pairs, { seed, settings: { seed } });
		} catch {
			failures++;
			continue;
		}
		batches++;
		for (const [k, v] of Object.entries(batch.meta.rejectionCounts || {})) {
			rejections[k] = (rejections[k] || 0) + v;
		}
		for (const scene of batch.scenes) {
			if (accepted >= count) break;
			const relGap = sceneRelGap(scene);
			if (relGap == null) continue;
			gaps.push(relGap);
			buckets[bucketFor(relGap)]++;
			exploredTotal += sceneExploredRoutes(scene);
			routeMsTotal += Number(scene.meta?.routeMs) || 0;
			retryTotal += Number(scene.meta?.retries) || 0;
			const maxIdx = sceneMaxRouteIndex(scene);
			if (maxIdx != null) {
				maxRouteIndexTotal += maxIdx;
				maxRouteIndexSamples++;
			}
			accepted++;
		}
	}

	gaps.sort((a, b) => a - b);
	const mean = gaps.reduce((s, v) => s + v, 0) / (gaps.length || 1);
	const median = gaps.length ? gaps[gaps.length >> 1] : 0;
	const totalRejects = Object.values(rejections).reduce((s, v) => s + v, 0);
	const rejectRate = totalRejects + accepted > 0 ? totalRejects / (totalRejects + accepted) : 0;

	return {
		label,
		accepted,
		batches,
		failures,
		buckets,
		gaps,
		mean,
		median,
		rejections,
		totalRejects,
		rejectRate,
		avgExplored: accepted ? exploredTotal / accepted : 0,
		avgRouteMs: accepted ? routeMsTotal / accepted : 0,
		avgRetries: accepted ? retryTotal / accepted : 0,
		avgMaxRouteIndex: maxRouteIndexSamples ? maxRouteIndexTotal / maxRouteIndexSamples : 0,
	};
}

function pct(n, total) {
	return total ? `${(100 * n / total).toFixed(1)}%` : '0.0%';
}

function printPass(r) {
	const t = r.accepted;
	console.log(`\n== ${r.label} ==`);
	console.log(`  control pairs measured : ${r.accepted}  (from ${r.batches} city batches, ${r.failures} unusable cities)`);
	console.log(`  avg routes explored    : ${r.avgExplored.toFixed(2)} per served problem`);
	console.log(`  avg pathfinding time   : ${r.avgRouteMs.toFixed(1)} ms per served problem`);
	console.log(`  avg coordinate retries : ${r.avgRetries.toFixed(2)} before each served problem`);
	console.log(`  avg max chosen index   : ${r.avgMaxRouteIndex.toFixed(2)} (higher means later barrier-forced routes are used)`);
	console.log(`  runtime gap buckets    :`);
	for (const b of BUCKETS) console.log(`      ${b.padEnd(6)} : ${String(r.buckets[b]).padStart(5)}  (${pct(r.buckets[b], t)})`);
	console.log(`  mean / median gap      : ${(100 * r.mean).toFixed(2)}% / ${(100 * r.median).toFixed(2)}%`);
	console.log(`  reject rate            : ${(100 * r.rejectRate).toFixed(1)}%  (${r.totalRejects} rejected / ${r.accepted} served)`);
	console.log(`  all rejection reasons  : ${JSON.stringify(r.rejections)}`);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const count = args.count ? parseInt(args.count, 10) : 1000;
	const pairs = args.pairs ? parseInt(args.pairs, 10) : 5;
	const routes = args.routes ? parseInt(args.routes, 10) : 5;
	const cap = args.cap !== undefined ? parseFloat(args.cap) : 0.40;
	const target = args.target !== undefined ? parseFloat(args.target) : 0.10;
	const stddev = args.stddev !== undefined ? parseFloat(args.stddev) : 0.06;
	const uniform = args.uniform !== undefined ? parseFloat(args.uniform) : 0.10;
	const indexBias = args['index-bias'] !== undefined ? parseFloat(args['index-bias']) : 1.25;
	const baseSeed = args.seed ? parseInt(args.seed, 10) : 1;

	console.log(`selection harness: count=${count}, pairs/batch=${pairs}, routes(weighted)=${routes}, cap=${cap}, target=${target}, stddev=${stddev}, uniform=${uniform}, indexBias=${indexBias}, seed=${baseSeed}`);

	const baseline = runPass('LEGACY (closest, 4 routes, no balance reject)', {
		selection: { strategy: 'closest', maxRoutes: 4, primaryRouteBudgetMs: null, extraRouteBudgetMs: 200 },
		balanceProbability: 0,
	}, { count, pairs, seedRng: makeSeedRng(baseSeed) });

	const treatment = runPass(`WEIGHTED (${routes} routes, target ${(100 * target).toFixed(0)}%, cap ${(100 * cap).toFixed(0)}%)`, {
		selection: {
			strategy: 'weighted',
			maxRoutes: routes,
			primaryRouteBudgetMs: 400,
			extraRouteBudgetMs: 200,
			weighted: {
				minSideGap: 10,
				maxRelativeGap: cap,
				targetRelativeGap: target,
				relativeGapStdDev: stddev,
				uniformPairWeight: uniform,
				highRouteIndexBias: indexBias,
			},
		},
		balanceProbability: 0,
	}, { count, pairs, seedRng: makeSeedRng(baseSeed) });

	printPass(baseline);
	printPass(treatment);

	const usefulBand = (r) => 100 * (r.buckets['5-10%'] + r.buckets['10-15%']) / (r.accepted || 1);
	console.log('\n== SHIFT (5-15% share = target training band) ==');
	console.log(`  legacy   5-15% share : ${usefulBand(baseline).toFixed(1)}%`);
	console.log(`  weighted 5-15% share : ${usefulBand(treatment).toFixed(1)}%`);
	console.log(`  delta                : ${(usefulBand(treatment) - usefulBand(baseline) >= 0 ? '+' : '')}${(usefulBand(treatment) - usefulBand(baseline)).toFixed(1)} pts`);
}

main();
