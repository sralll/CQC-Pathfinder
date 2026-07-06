// =============================================================================
// balance_harness.mjs — measure the route-choice difficulty distribution of
// CITY-mode infinite play, and the effect of the balance-reject.
//
// A "control pair" here is one served route-choice problem (a start/goal with
// its two selected routes). For each accepted problem we compute the runtime
// relative gap between the two served routes — exactly the quantity the balance
// reject acts on and the same difference you can recompute from the
// infinity_choices / ControlPair rows in the DB. We bucket that gap into
//   <=5%  |  5-10%  |  >10%
// and report the distribution, plus how many problems the balance reject threw
// back.
//
// It drives the real city generator headlessly (no browser, no DB, no Django) —
// zero impact on the staging server. Runs a BASELINE pass (reject disabled) and
// a TREATMENT pass (reject enabled) over the *same* city seeds so the two are
// directly comparable.
//
// CLI:
//   node scripts/balance_harness.mjs                       # 1000 pairs, prob 0.5
//   node scripts/balance_harness.mjs --count 1000 --prob 0.5 --threshold 0.05
//   node scripts/balance_harness.mjs --pairs 5 --seed 1
//
// Flags:
//   --count      number of accepted control pairs to measure per pass (1000)
//   --pairs      control pairs generated per city batch (5, matches production)
//   --prob       balance-reject probability for the treatment pass (0.5)
//   --threshold  balance-reject relative-gap band, e.g. 0.05 = 5% (0.05)
//   --seed       base seed for the reproducible city-seed sequence (1)
// =============================================================================

import {
	generateSceneBatch,
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

// mulberry32 — a reproducible sequence of city seeds so BASELINE and TREATMENT
// generate the identical set of cities.
function makeSeedRng(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function bucketFor(relGap) {
	if (relGap <= 0.05) return '<=5%';
	if (relGap <= 0.10) return '5-10%';
	return '>10%';
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

// Run one pass: keep generating city batches (using the shared seed sequence)
// until `count` accepted control pairs have been measured.
function runPass(label, { count, pairs, seedRng }) {
	const buckets = { '<=5%': 0, '5-10%': 0, '>10%': 0 };
	const gaps = [];
	const rejections = {};
	let accepted = 0;
	let batches = 0;
	let failures = 0;

	while (accepted < count) {
		const seed = (seedRng() * 2147483646 | 0) + 1;
		let batch;
		try {
			batch = generateSceneBatch(pairs, { seed, settings: { seed } });
		} catch (err) {
			// City that couldn't yield `pairs` valid problems (more likely with a
			// high reject probability). Skip it; count it so the two passes stay
			// honest about how much harder generation got.
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
			accepted++;
		}
	}

	gaps.sort((a, b) => a - b);
	const mean = gaps.reduce((s, v) => s + v, 0) / (gaps.length || 1);
	const median = gaps.length ? gaps[gaps.length >> 1] : 0;
	const balanced = rejections.balanced || 0;
	// Reject rate = balanced rejects / (balanced rejects + accepted problems):
	// the share of otherwise-servable balanced problems that got thrown back.
	const rejectRate = balanced + accepted > 0 ? balanced / (balanced + accepted) : 0;

	return {
		label, accepted, batches, failures, buckets, gaps,
		mean, median, balanced, rejectRate, rejections,
	};
}

function pct(n, total) {
	return total ? `${(100 * n / total).toFixed(1)}%` : '0.0%';
}

function printPass(r) {
	const t = r.accepted;
	console.log(`\n== ${r.label} ==`);
	console.log(`  control pairs measured : ${r.accepted}  (from ${r.batches} city batches, ${r.failures} unusable cities)`);
	console.log(`  runtime gap buckets    :`);
	console.log(`      <= 5%  : ${String(r.buckets['<=5%']).padStart(5)}  (${pct(r.buckets['<=5%'], t)})`);
	console.log(`      5-10%  : ${String(r.buckets['5-10%']).padStart(5)}  (${pct(r.buckets['5-10%'], t)})`);
	console.log(`      > 10%  : ${String(r.buckets['>10%']).padStart(5)}  (${pct(r.buckets['>10%'], t)})`);
	console.log(`  mean / median gap      : ${(100 * r.mean).toFixed(2)}% / ${(100 * r.median).toFixed(2)}%`);
	console.log(`  balanced rejects        : ${r.balanced}  (reject rate ${(100 * r.rejectRate).toFixed(1)}% of servable problems)`);
	console.log(`  all rejection reasons   : ${JSON.stringify(r.rejections)}`);
}

// ------------------------------------------------------------------------ main

function main() {
	const args = parseArgs(process.argv.slice(2));
	const count = args.count ? parseInt(args.count, 10) : 1000;
	const pairs = args.pairs ? parseInt(args.pairs, 10) : 5;
	const prob = args.prob !== undefined ? parseFloat(args.prob) : 0.5;
	const threshold = args.threshold !== undefined ? parseFloat(args.threshold) : 0.05;
	const baseSeed = args.seed ? parseInt(args.seed, 10) : 1;

	console.log(`balance harness: count=${count}, pairs/batch=${pairs}, treatment prob=${prob}, threshold=${threshold}, seed=${baseSeed}`);
	console.log('(buckets are ALWAYS the fixed <=5% / 5-10% / >10% bands; --threshold only moves the reject band)');

	// BASELINE — reject disabled.
	balanceRejectConfig.maxRelativeGap = threshold;
	balanceRejectConfig.probability = 0;
	const baseline = runPass('BASELINE (reject off)', { count, pairs, seedRng: makeSeedRng(baseSeed) });

	// TREATMENT — reject enabled, identical seed sequence.
	balanceRejectConfig.maxRelativeGap = threshold;
	balanceRejectConfig.probability = prob;
	const treatment = runPass(`TREATMENT (reject p=${prob} within ${(100 * threshold).toFixed(0)}%)`,
		{ count, pairs, seedRng: makeSeedRng(baseSeed) });

	printPass(baseline);
	printPass(treatment);

	// Shift summary.
	const share = (r) => 100 * (r.buckets['5-10%'] + r.buckets['>10%']) / (r.accepted || 1);
	console.log('\n== SHIFT (>5% share = "trainable" decisions) ==');
	console.log(`  baseline  >5% share : ${share(baseline).toFixed(1)}%`);
	console.log(`  treatment >5% share : ${share(treatment).toFixed(1)}%`);
	console.log(`  delta               : +${(share(treatment) - share(baseline)).toFixed(1)} pts`);
}

main();
