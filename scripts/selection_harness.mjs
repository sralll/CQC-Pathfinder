// =============================================================================
// selection_harness.mjs — measure the "extremes" route-selection strategy for
// CITY-mode infinite play and compare it against current production.
//
// A "control pair" is one served route-choice problem (a start/goal with its two
// selected routes). For each accepted problem we compute the runtime relative
// gap between the two served routes — the same difference you can recompute from
// the infinity_choices / ControlPair rows — and bucket it into
//   <=5% | 5-10% | 10-20% | 20-30% | >30%
//
// It drives the real city generator headlessly (no browser, no DB, no Django) —
// zero impact on the staging server. Two passes over the *same* city seeds so
// they are directly comparable:
//   BASELINE  — current production: strategy 'closest', maxRoutes 4.
//   TREATMENT — the new approach:   strategy 'extremes', maxRoutes=--routes,
//               A* budgets 400ms (first two) / 200ms (extras), gap cap --cap.
//
// CLI:
//   node scripts/selection_harness.mjs --routes 4
//   node scripts/selection_harness.mjs --routes 5
//   node scripts/selection_harness.mjs --routes 5 --count 1000 --cap 0.30
//
// Flags:
//   --count      accepted control pairs to measure per pass (1000)
//   --pairs      control pairs generated per city batch (5, matches production)
//   --routes     routes explored per problem in the treatment (4)
//   --cap        extremes runtime-gap cap, e.g. 0.30 = 30% (0.30)
//   --seed       base seed for the reproducible city-seed sequence (1)
// =============================================================================

import {
	generateSceneBatch,
	selectionConfig,
	balanceRejectConfig,
} from '../results/static/results/js/infinite/infinite_batch_worker.js';

// --------------------------------------------------------------------- helpers

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

// mulberry32 — reproducible city-seed sequence so both passes see identical
// cities.
function makeSeedRng(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const BUCKETS = ['<=5%', '5-10%', '10-20%', '20-30%', '>30%'];
function bucketFor(relGap) {
	if (relGap <= 0.05) return '<=5%';
	if (relGap <= 0.10) return '5-10%';
	if (relGap <= 0.20) return '10-20%';
	if (relGap <= 0.30) return '20-30%';
	return '>30%';
}

// Runtime relative gap between the two served routes of a scene.
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

// Apply a strategy config, then run until `count` accepted pairs are measured.
function runPass(label, cfg, { count, pairs, seedRng }) {
	Object.assign(selectionConfig, cfg.selection);
	// The extremes strategy has its own acceptance rule; disable the balance
	// reject so it does not double-filter. The closest baseline keeps whatever
	// balanceRejectConfig is set to below.
	balanceRejectConfig.probability = cfg.balanceProbability;

	const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
	const gaps = [];
	const rejections = {};
	let accepted = 0;
	let batches = 0;
	let failures = 0;
	let exploredTotal = 0;

	while (accepted < count) {
		const seed = (seedRng() * 2147483646 | 0) + 1;
		let batch;
		try {
			batch = generateSceneBatch(pairs, { seed, settings: { seed } });
		} catch (err) {
			// City that could not yield `pairs` valid problems (more likely as
			// acceptance tightens). Skip it but count it so both passes stay honest
			// about how much harder generation got.
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
			accepted++;
		}
	}

	gaps.sort((a, b) => a - b);
	const mean = gaps.reduce((s, v) => s + v, 0) / (gaps.length || 1);
	const median = gaps.length ? gaps[gaps.length >> 1] : 0;
	const totalRejects = Object.values(rejections).reduce((s, v) => s + v, 0);
	// Reject rate = rejected problems / (rejected + accepted): the share of
	// generated problems thrown back before one was served.
	const rejectRate = totalRejects + accepted > 0 ? totalRejects / (totalRejects + accepted) : 0;

	return {
		label, accepted, batches, failures, buckets, gaps, mean, median,
		rejections, totalRejects, rejectRate,
		avgExplored: accepted ? exploredTotal / accepted : 0,
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
	console.log(`  runtime gap buckets    :`);
	for (const b of BUCKETS) console.log(`      ${b.padEnd(6)} : ${String(r.buckets[b]).padStart(5)}  (${pct(r.buckets[b], t)})`);
	console.log(`  mean / median gap      : ${(100 * r.mean).toFixed(2)}% / ${(100 * r.median).toFixed(2)}%`);
	console.log(`  reject rate            : ${(100 * r.rejectRate).toFixed(1)}%  (${r.totalRejects} rejected / ${r.accepted} served)`);
	console.log(`  all rejection reasons  : ${JSON.stringify(r.rejections)}`);
}

// ------------------------------------------------------------------------ main

function main() {
	const args = parseArgs(process.argv.slice(2));
	const count = args.count ? parseInt(args.count, 10) : 1000;
	const pairs = args.pairs ? parseInt(args.pairs, 10) : 5;
	const routes = args.routes ? parseInt(args.routes, 10) : 4;
	const cap = args.cap !== undefined ? parseFloat(args.cap) : 0.30;
	const baseSeed = args.seed ? parseInt(args.seed, 10) : 1;

	console.log(`selection harness: count=${count}, pairs/batch=${pairs}, routes(treatment)=${routes}, cap=${cap}, seed=${baseSeed}`);
	console.log('(">30%" only appears in the closest baseline; extremes is capped at --cap)');

	// BASELINE — current production: closest strategy, 4 routes, current budgets.
	const baseline = runPass('BASELINE (current: closest, 4 routes)', {
		selection: { strategy: 'closest', maxRoutes: 4, primaryRouteBudgetMs: null, extraRouteBudgetMs: 200 },
		balanceProbability: 0, // measure the raw closest distribution
	}, { count, pairs, seedRng: makeSeedRng(baseSeed) });

	// TREATMENT — new approach: extremes, --routes, 400/200 budgets, gap cap.
	const treatment = runPass(`TREATMENT (extremes, ${routes} routes, cap ${(100 * cap).toFixed(0)}%)`, {
		selection: {
			strategy: 'extremes', maxRoutes: routes,
			primaryRouteBudgetMs: 400, extraRouteBudgetMs: 200,
			extremesMaxRelativeGap: cap,
		},
		balanceProbability: 0,
	}, { count, pairs, seedRng: makeSeedRng(baseSeed) });

	printPass(baseline);
	printPass(treatment);

	// Shift summary: share of served pairs that are a "trainable" (>5%) decision.
	const trainable = (r) => 100 * (r.accepted - r.buckets['<=5%']) / (r.accepted || 1);
	console.log('\n== SHIFT (>5% share = "trainable" decisions) ==');
	console.log(`  baseline  >5% share : ${trainable(baseline).toFixed(1)}%`);
	console.log(`  treatment >5% share : ${trainable(treatment).toFixed(1)}%`);
	console.log(`  delta               : ${(trainable(treatment) - trainable(baseline) >= 0 ? '+' : '')}${(trainable(treatment) - trainable(baseline)).toFixed(1)} pts`);
}

main();
