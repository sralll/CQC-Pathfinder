// =============================================================================
// navgraph_batch.mjs — WP 2.2 batch driver.
//
// Runs generatePairs() from navgraph_harness.mjs over every current-version
// .navgraph.bin
// artifact under media/masks/, computes per-map + aggregate stats, asserts
// zero legality violations across every accepted pair (not just a rendered
// sample), and writes a markdown summary to scratch/wp2_2_summary.md.
//
// Usage:
//   node --max-old-space-size=4096 scripts/navgraph_batch.mjs \
//        [--count 100] [--seed 1] [--out scratch/wp2_2_summary.md] \
//        [--json scratch/wp2_2_results.json] [--side-gap 40]
//        [--passages-dir scratch/passage-documents]
//
// Does not modify navgraph_harness.mjs / project/navgraph.py; only imports.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
	loadArtifact, loadMask, buildBenchmarkState, generatePairs, makeRng,
	countLegalityViolations, DEFAULT_CONFIG, SUPPORTED_VERSION,
} from './navgraph_harness.mjs';

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) args[key] = true;
			else { args[key] = next; i++; }
		}
	}
	return args;
}

function isCurrentArtifact(binPath) {
	try {
		const fd = fs.openSync(binPath, 'r');
		const buf = Buffer.alloc(8);
		fs.readSync(fd, buf, 0, 8, 0);
		fs.closeSync(fd);
		if (buf.toString('latin1', 0, 4) !== 'NVG1') return false;
		return buf.readUInt32LE(4) === SUPPORTED_VERSION;
	} catch { return false; }
}

function listCurrentMasks(masksDir) {
	const names = fs.readdirSync(masksDir)
		.filter((f) => f.startsWith('mask_') && f.toLowerCase().endsWith('.png') && !f.includes('.navgraph.'));
	const out = [];
	for (const n of names) {
		const maskPath = path.join(masksDir, n);
		const binPath = maskPath.replace(/\.png$/i, '.navgraph.bin');
		if (fs.existsSync(binPath) && isCurrentArtifact(binPath)) out.push(maskPath);
	}
	return out;
}

function percentile(sortedArr, p) {
	if (!sortedArr.length) return null;
	const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
	return sortedArr[idx];
}

function median(sortedArr) {
	if (!sortedArr.length) return null;
	const n = sortedArr.length;
	return n % 2 ? sortedArr[(n - 1) / 2] : (sortedArr[n / 2 - 1] + sortedArr[n / 2]) / 2;
}

async function runMap(maskPath, {
	count, maxAttempts, seed, sideGapMinPx, passagesDir,
}) {
	const binPath = maskPath.replace(/\.png$/i, '.navgraph.bin');
	const name = path.basename(maskPath).replace(/\.png$/i, '');
	const artifact = loadArtifact(binPath);
	const { mask } = await loadMask(maskPath);
	const mpx = +(artifact.H * artifact.W / 1e6).toFixed(2);
	const cfg = sideGapMinPx != null ? { ...DEFAULT_CONFIG, sideGapMinPx } : DEFAULT_CONFIG;
	let passagesPath = null;
	if (passagesDir) {
		const candidate = path.join(passagesDir, `${name}.passages.json`);
		if (fs.existsSync(candidate)) passagesPath = candidate;
	}
	const state = buildBenchmarkState(artifact, mask, cfg, passagesPath);

	// Reduce pair count for extreme outlier masks so the whole batch stays
	// tractable; noted explicitly in the summary when triggered.
	let effCount = count;
	let note = null;
	if (mpx > 60) { effCount = Math.max(20, Math.round(count * 0.3)); note = `reduced count ${count}->${effCount} (${mpx} Mpx outlier)`; }
	else if (mpx > 35) { effCount = Math.max(30, Math.round(count * 0.5)); note = `reduced count ${count}->${effCount} (${mpx} Mpx large map)`; }

	const t0 = performance.now();
	const { pairs, attempts, stats } = generatePairs(state, {
		count: effCount, maxAttempts: Math.max(maxAttempts, effCount * 40), rng: makeRng(seed),
	});
	const wallMs = performance.now() - t0;

	// Mandatory legality assertion over EVERY accepted pair's two routes.
	// generatePairs already returns routes refined to legal full-res polylines
	// (generateOnePair refines the served pair), so we assert on them directly.
	let legalityViolations = 0;
	const violationDetails = [];
	for (let i = 0; i < pairs.length; i++) {
		const pr = pairs[i];
		for (let ri = 0; ri < pr.routes.length; ri++) {
			const hits = countLegalityViolations(state, pr.routes[ri].path);
			if (hits > 0) {
				legalityViolations += hits;
				violationDetails.push({ mask: name, pairIndex: i, routeIndex: ri, hits });
			}
		}
	}

	const retries = attempts.filter((a) => a.ok).map((a) => a.retries).sort((a, b) => a - b);
	const msValid = attempts.filter((a) => a.ok).map((a) => a.msTotal).sort((a, b) => a - b);
	const meanRetries = stats.meanRetries;
	const medianRetries = median(retries);
	const p90Retries = percentile(retries, 0.9);
	const meanMsPerValid = stats.meanMsPerValid;

	const reasonCounts = { ...stats.reasons };
	const topReasons = Object.entries(reasonCounts)
		.filter(([k]) => k !== 'ok')
		.sort((a, b) => b[1] - a[1]);

	return {
		name, mpx, nodes: artifact.N, edges: artifact.E,
		count: effCount, countRequested: count, note,
		attempts: stats.attempts, valid: stats.valid, validRate: stats.validRate,
		meanRetries, medianRetries, p90Retries, meanMsPerValid,
		meanRelGap: stats.meanRelGap, medianRelGap: stats.medianRelGap, gapHist: stats.gapHist,
		reasonCounts, topReasons, legalityViolations, violationDetails,
		wallMs: +wallMs.toFixed(0),
		meetsGate: meanRetries != null && meanRetries <= 5 && meanMsPerValid != null && meanMsPerValid <= 1000,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const count = args.count ? parseInt(args.count, 10) : 100;
	const maxAttempts = args['max-attempts'] ? parseInt(args['max-attempts'], 10) : count * 40;
	const seed = args.seed ? parseInt(args.seed, 10) : 1;
	const sideGapMinPx = args['side-gap'] ? parseFloat(args['side-gap']) : null;
	const outPath = args.out ? String(args.out) : 'scratch/wp2_2_summary.md';
	const jsonPath = args.json ? String(args.json) : null;
	const masksDir = args['masks-dir'] ? String(args['masks-dir']) : 'media/masks';
	const passagesDir = args['passages-dir'] ? String(args['passages-dir']) : null;
	const label = args.label ? String(args.label) : 'primary';

	const masks = listCurrentMasks(masksDir);
	console.log(`Found ${masks.length} current-version masks under ${masksDir}`);
	if (masks.length < 20) console.warn(`WARNING: fewer than 20 current masks (${masks.length}) — build more with build_navgraph.`);

	const results = [];
	for (const m of masks) {
		process.stdout.write(`- ${path.basename(m)} ... `);
		try {
			const r = await runMap(m, {
				count, maxAttempts, seed, sideGapMinPx, passagesDir,
			});
			results.push(r);
			console.log(`${r.valid}/${r.attempts} valid, meanRetries=${r.meanRetries}, meanMs=${r.meanMsPerValid}, legalityHits=${r.legalityViolations}${r.note ? ` [${r.note}]` : ''}`);
		} catch (e) {
			console.log(`ERROR: ${e.message}`);
			results.push({ name: path.basename(m), error: e.message });
		}
	}

	const ok = results.filter((r) => !r.error);
	const failed = results.filter((r) => r.error);

	// Aggregate.
	const totalAttempts = ok.reduce((s, r) => s + r.attempts, 0);
	const totalValid = ok.reduce((s, r) => s + r.valid, 0);
	const aggValidRate = totalAttempts ? totalValid / totalAttempts : 0;
	const meanOfMeans = (key) => {
		const vals = ok.map((r) => r[key]).filter((v) => v != null);
		return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
	};
	const aggMeanRetries = meanOfMeans('meanRetries');
	const aggMeanMs = meanOfMeans('meanMsPerValid');
	const gatePassCount = ok.filter((r) => r.meetsGate).length;
	const gatePassPct = ok.length ? (gatePassCount / ok.length) * 100 : 0;
	const totalLegalityViolations = ok.reduce((s, r) => s + r.legalityViolations, 0);

	// Aggregate rejection reasons across all maps.
	const aggReasons = {};
	for (const r of ok) for (const [k, v] of Object.entries(r.reasonCounts)) aggReasons[k] = (aggReasons[k] || 0) + v;

	// Aggregate served relative-gap distribution across all maps.
	const aggGapHist = {};
	for (const r of ok) for (const [k, v] of Object.entries(r.gapHist || {})) aggGapHist[k] = (aggGapHist[k] || 0) + v;
	const aggMeanRelGap = meanOfMeans('meanRelGap');
	const aggMedianRelGap = meanOfMeans('medianRelGap');

	const goNoGo = (gatePassPct >= 70) && (totalLegalityViolations === 0);

	// -------------------------------------------------------------- markdown
	const lines = [];
	lines.push(`# WP 2.2 — Navgraph pair-generation batch summary`);
	lines.push('');
	lines.push(`Run label: \`${label}\`  |  count/map target: ${count}  |  seed: ${seed}` +
		(sideGapMinPx != null ? `  |  sideGapMinPx override: ${sideGapMinPx}` : ''));
	lines.push('');
	lines.push(`Maps tested: **${ok.length}**` + (failed.length ? ` (${failed.length} failed to load — see below)` : ''));
	lines.push('');
	lines.push('## Per-map results');
	lines.push('');
	lines.push('| mask | Mpx | nodes | edges | n | valid-rate | mean retries | median retries | p90 retries | mean ms/valid | gate | top rejection reasons |');
	lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|---|');
	for (const r of ok) {
		const topR = r.topReasons.slice(0, 3).map(([k, v]) => `${k}:${v}`).join(', ');
		lines.push(`| ${r.name} | ${r.mpx} | ${r.nodes} | ${r.edges} | ${r.count}${r.note ? '*' : ''} | ` +
			`${(r.validRate * 100).toFixed(0)}% | ${r.meanRetries ?? '-'} | ${r.medianRetries ?? '-'} | ${r.p90Retries ?? '-'} | ` +
			`${r.meanMsPerValid ?? '-'} | ${r.meetsGate ? 'PASS' : 'fail'} | ${topR} |`);
	}
	lines.push('');
	if (ok.some((r) => r.note)) {
		lines.push('\\* count reduced for this map (large/outlier mask) — see per-map note.');
		for (const r of ok.filter((r) => r.note)) lines.push(`- ${r.name}: ${r.note}`);
		lines.push('');
	}
	if (failed.length) {
		lines.push('## Load failures');
		for (const r of failed) lines.push(`- ${r.name}: ${r.error}`);
		lines.push('');
	}

	lines.push('## Aggregate');
	lines.push('');
	lines.push(`- Total attempts: ${totalAttempts}, total valid pairs: ${totalValid}`);
	lines.push(`- Aggregate valid-rate: **${(aggValidRate * 100).toFixed(1)}%**`);
	lines.push(`- Mean of per-map mean-retries: **${aggMeanRetries != null ? aggMeanRetries.toFixed(2) : '-'}**`);
	lines.push(`- Mean of per-map mean-ms/valid: **${aggMeanMs != null ? aggMeanMs.toFixed(1) : '-'} ms**`);
	lines.push(`- Maps meeting gate (mean retries <= 5 AND mean ms/valid <= 1000): **${gatePassCount}/${ok.length} (${gatePassPct.toFixed(1)}%)**`);
	lines.push(`- Aggregate rejection reasons: ${JSON.stringify(aggReasons)}`);
	lines.push('');
	lines.push('## Served relative-gap distribution');
	lines.push('');
	lines.push(`- Mean of per-map mean relative gap: **${aggMeanRelGap != null ? aggMeanRelGap.toFixed(4) : '-'}**` +
		`  |  mean of per-map median: **${aggMedianRelGap != null ? aggMedianRelGap.toFixed(4) : '-'}**`);
	lines.push(`- Aggregate gap histogram (served pairs): ${JSON.stringify(aggGapHist)}`);
	lines.push('');

	lines.push('## Legality assertion (mandatory)');
	lines.push('');
	lines.push(`Total legality violations across all accepted pairs, both routes, on ALL maps: **${totalLegalityViolations}**`);
	if (totalLegalityViolations > 0) {
		lines.push('');
		lines.push('Violations found (mask / pair index / route index / hit count):');
		for (const r of ok) for (const v of r.violationDetails)
			lines.push(`- ${v.mask} pair#${v.pairIndex} route${v.routeIndex}: ${v.hits} impassable-pixel hits`);
	} else {
		lines.push('');
		lines.push('Zero violations confirmed — every accepted pair, both routes, refined to a legal full-res polyline.');
	}
	lines.push('');

	lines.push('## GO / NO-GO verdict');
	lines.push('');
	lines.push(`**${goNoGo ? 'GO' : 'NO-GO'}**`);
	lines.push('');
	lines.push('Acceptance criteria (plan.md WP 2.2):');
	lines.push(`- mean retries <= ~5 AND mean time-to-valid-pair <= ~1s on >=70% of urban maps: ` +
		`${gatePassPct.toFixed(1)}% of maps passed -> ${gatePassPct >= 70 ? 'MET' : 'NOT MET'}`);
	lines.push(`- zero legality violations: ${totalLegalityViolations === 0 ? 'MET' : 'NOT MET'} (${totalLegalityViolations} found)`);
	lines.push('');

	// Side-rejection / tuning commentary.
	const sideCount = aggReasons.side || 0;
	const sideShare = totalAttempts ? sideCount / totalAttempts : 0;
	lines.push('## Rejection-reason commentary & tuning notes');
	lines.push('');
	if (sideShare > 0.15) {
		lines.push(`\`side\` rejections dominate (${sideCount} of ${totalAttempts} attempts, ${(sideShare * 100).toFixed(1)}%), ` +
			`consistent with the city-gen reference run where \`side\` was also the top rejection reason. This is the ` +
			`selectRuntimeRouteOptions() opposite-side + sideGap>=sideGapMinPx filter (DEFAULT_CONFIG.sideGapMinPx=${DEFAULT_CONFIG.sideGapMinPx}) ` +
			`rejecting route pairs that go the same way around obstacles.`);
		lines.push('');
		lines.push('Suggested tuning directions for a later WP (NOT applied here — this run uses DEFAULT_CONFIG unless a --side-gap override is noted above):');
		lines.push(`- Lower \`sideGapMinPx\` (currently ${DEFAULT_CONFIG.sideGapMinPx}px) to accept more near-parallel route pairs — trades visual distinctness for retry rate.`);
		lines.push(`- Widen \`distMinPx\`/\`distMaxPx\` (currently ${DEFAULT_CONFIG.distMinPx}/${DEFAULT_CONFIG.distMaxPx}px) so more sampled pairs naturally have route options that diverge around different obstacles.`);
		lines.push(`- Increase \`obstacleMinRunPx\` (currently ${DEFAULT_CONFIG.obstacleMinRunPx}px) so only pairs with a meaningfully large obstacle between them are accepted at prefilter time, which correlates with wider route divergence downstream.`);
		lines.push(`- Increase \`routeAttempts\` (currently ${DEFAULT_CONFIG.routeAttempts}) so more barrier-forced alternates are tried before giving up on a pair.`);
	} else {
		lines.push(`\`side\` rejections were not dominant this run (${sideCount} of ${totalAttempts} attempts, ${(sideShare * 100).toFixed(1)}%).`);
	}
	lines.push('');

	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, lines.join('\n'));
	console.log(`\nWrote summary: ${outPath}`);

	if (jsonPath) {
		fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
		fs.writeFileSync(jsonPath, JSON.stringify({ label, count, seed, sideGapMinPx, results, aggregate: {
			totalAttempts, totalValid, aggValidRate, aggMeanRetries, aggMeanMs, gatePassCount, gatePassPct,
			totalLegalityViolations, aggReasons, aggGapHist, aggMeanRelGap, aggMedianRelGap, goNoGo,
		} }, null, 2));
		console.log(`Wrote json: ${jsonPath}`);
	}

	console.log(`\n${goNoGo ? 'GO' : 'NO-GO'} — gate ${gatePassPct.toFixed(1)}% (need >=70%), legality violations ${totalLegalityViolations} (need 0)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
