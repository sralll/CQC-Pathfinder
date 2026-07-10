// =============================================================================
// navgraph_harness.mjs — headless (Node) validation/re-baseline harness for
// infinity-on-real-masks.
//
// WP 5.1 de-drift: this file no longer carries its own copies of the pipeline
// (artifact parse, sampler/graph state, A*, barriers, selection, refinement).
// Those live in the single source of truth, project/static/project/js/pathing/
// navgraph_router.js (Node-clean by design), and the shared weighted selection
// lives in results/static/results/js/infinite/route_pair_selection.js. This
// harness only adds the Node-specific bits the browser worker doesn't need:
//   - loadArtifact(binPath) — read the .navgraph.bin off disk, parse via router
//   - loadMask()            — decode a mask PNG to grayscale via `sharp`
//   - generatePairs()       — batch loop that calls the exact worker function
//                             `generateOnePair` (selection injected) `count`
//                             times, aggregating stats + the rejection taxonomy
//   - renderPairPNG()       — visual spot-check of an accepted pair
//   - CLI
//
// Because generatePairs() now drives the real generateOnePair, the batch
// exercises the shared weighted selection, per-route time budgets + timeout
// kicks, refined-gap re-check and balance-reject exactly as the browser worker
// does — so re-baselining here reflects served behaviour, not a drifted copy.
//
// Cost model is identical to project/static/project/js/pathing/astar.js and
// project/navgraph.py: step = hypot(dx,dy) * (255 - value); value 0 impassable.
//
// CLI:
//   node scripts/navgraph_harness.mjs --mask media/masks/<name>.png \
//        [--count 100] [--max-attempts 4000] [--seed 1] [--render 6] \
//        [--out scratch/harness]
//   node scripts/navgraph_harness.mjs --all-demo   # runs 3 bundled sample masks
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

import {
	IMPASSABLE, SUPPORTED_VERSION, DEFAULT_CONFIG,
	loadArtifact as parseArtifact, buildState, makeRng,
	generateOnePair, refineRouteLegal, countLegalityViolations, routePathLength,
} from '../project/static/project/js/pathing/navgraph_router.js';
import * as routePairSelection from '../results/static/results/js/infinite/route_pair_selection.js';

// Re-export the pure pipeline from the single source of truth so downstream
// scripts (scripts/navgraph_batch.mjs) can keep importing them from here.
export {
	IMPASSABLE, SUPPORTED_VERSION, DEFAULT_CONFIG,
	buildState, makeRng, refineRouteLegal, countLegalityViolations,
} from '../project/static/project/js/pathing/navgraph_router.js';

// Full rejection taxonomy (mask analogue of the city batch rejectionCounts).
const REJECTION_KEYS = [
	'empty', 'distance', 'obstacle', 'snap', 'unreachable', 'distinct',
	'runtime', 'side', 'routeside', 'lateral', 'timeout', 'runtime_refined', 'balanced',
];

// =============================================================================
// Node-specific loaders
// =============================================================================

/** Parse a `.navgraph.bin` off disk (delegates to the router's byte parser). */
export function loadArtifact(binPath) {
	return parseArtifact(fs.readFileSync(binPath));
}

/** Decode a mask PNG to a full-res 8-bit grayscale Uint8Array (row-major). */
export async function loadMask(maskPath) {
	const { data, info } = await sharp(maskPath, { limitInputPixels: false })
		.greyscale().raw().toBuffer({ resolveWithObject: true });
	return { mask: new Uint8Array(data.buffer, data.byteOffset, data.length), H: info.height, W: info.width };
}

// =============================================================================
// Batch loop — repeatedly call the real generateOnePair (worker parity)
// =============================================================================

/**
 * Generate up to `count` valid pairs by calling generateOnePair() with a shared
 * seeded rng (so the whole batch stays reproducible for a given seed). Returns
 * { pairs, attempts, stats }:
 *  - pairs[i].routes = [{ path, run_time }, { path, run_time }] — already refined
 *    to legal full-res polylines (ordered L→R), so no further refinement needed.
 *  - attempts = one record per accepted pair (+ a terminal failed record if the
 *    attempt budget is exhausted). Per-reject records are no longer emitted;
 *    the rejection breakdown is aggregated in stats.reasons instead.
 */
export function generatePairs(state, { count = 100, maxAttempts = 4000, rng, selection } = {}) {
	rng = rng || makeRng(1);
	const selectionModule = selection || routePairSelection;
	const pairs = [];
	const attempts = [];
	const rejectionCounts = Object.fromEntries(REJECTION_KEYS.map((k) => [k, 0]));
	let internalAttempts = 0;

	while (pairs.length < count && internalAttempts < maxAttempts) {
		const remaining = maxAttempts - internalAttempts;
		const t0 = performance.now();
		const res = generateOnePair(state, { rng, maxAttempts: remaining, selection: selectionModule });
		const ms = performance.now() - t0;
		internalAttempts += res.meta?.attempts || 0;
		const rc = res.meta?.rejectionCounts;
		if (rc) for (const k of REJECTION_KEYS) rejectionCounts[k] += rc[k] || 0;

		if (!res.ok) {
			attempts.push({ ok: false, reason: res.reason, retries: res.meta?.retries ?? 0, msTotal: +ms.toFixed(2) });
			break; // attempt budget exhausted without a pair
		}

		const dist = Math.hypot(res.goal.x - res.start.x, res.goal.y - res.start.y);
		const routes = [
			{ path: res.routes[0], run_time: res.runtimes[0] },
			{ path: res.routes[1], run_time: res.runtimes[1] },
		];
		pairs.push({ start: res.start, goal: res.goal, routes, runtimes: res.runtimes, skippedBarriers: res.skippedBarriers, dist, meta: res.meta });
		const tm = res.meta.timings;
		attempts.push({
			ok: true, reason: 'ok', retries: res.meta.retries, dist,
			relGap: res.meta.relGap ?? null, sideGap: res.meta.sideGap ?? null,
			rt1: +res.runtimes[0].toFixed(0), rt2: +res.runtimes[1].toFixed(0),
			len1: +routePathLength(res.routes[0]).toFixed(1), len2: +routePathLength(res.routes[1]).toFixed(1),
			msSample: tm.sample, msSnap: tm.snap, msRoute: tm.route, msRefine: tm.refine,
			msTotal: +ms.toFixed(2),
		});
	}

	return { pairs, attempts, stats: summarize(attempts, pairs, rejectionCounts, internalAttempts) };
}

const GAP_BUCKETS = [0.05, 0.10, 0.15, 0.20, 0.30, 0.40, Infinity];

function summarize(attempts, pairs, rejectionCounts, internalAttempts) {
	const validAttempts = attempts.filter((a) => a.ok);
	const retrySamples = validAttempts.map((a) => a.retries).sort((x, y) => x - y);
	const totalRetries = retrySamples.reduce((s, v) => s + v, 0);
	const p90 = retrySamples.length ? retrySamples[Math.min(retrySamples.length - 1, Math.floor(retrySamples.length * 0.9))] : 0;
	const msValid = validAttempts.map((a) => a.msTotal);

	// Relative-gap distribution (served pairs).
	const relGaps = validAttempts.map((a) => a.relGap).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
	const gapHist = Object.fromEntries(GAP_BUCKETS.map((b) => [b === Infinity ? '>=0.40' : `<${b.toFixed(2)}`, 0]));
	const gapKeys = Object.keys(gapHist);
	for (const g of relGaps) {
		let placed = false;
		for (let i = 0; i < GAP_BUCKETS.length; i++) {
			if (g < GAP_BUCKETS[i]) { gapHist[gapKeys[i]]++; placed = true; break; }
		}
		if (!placed) gapHist[gapKeys[gapKeys.length - 1]]++;
	}
	const meanRelGap = relGaps.length ? relGaps.reduce((s, v) => s + v, 0) / relGaps.length : null;
	const medianRelGap = relGaps.length ? relGaps[Math.floor((relGaps.length - 1) / 2)] : null;

	// `reasons` is the full rejection taxonomy (used by navgraph_batch for the
	// top-reasons table); it excludes the accepted pairs.
	const reasons = { ...rejectionCounts };

	return {
		attempts: internalAttempts,
		valid: pairs.length,
		validRate: internalAttempts ? +(pairs.length / internalAttempts).toFixed(4) : 0,
		meanRetries: pairs.length ? +(totalRetries / pairs.length).toFixed(2) : null,
		p90Retries: p90,
		meanMsPerValid: msValid.length ? +(msValid.reduce((s, v) => s + v, 0) / msValid.length).toFixed(1) : null,
		meanRelGap: meanRelGap != null ? +meanRelGap.toFixed(4) : null,
		medianRelGap: medianRelGap != null ? +medianRelGap.toFixed(4) : null,
		gapHist,
		reasons,
	};
}

// =============================================================================
// PNG rendering of an accepted pair (visual spot-check)
// =============================================================================

function drawLine(rgb, w, h, x0, y0, x1, y1, r, g, b) {
	let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
	let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
	let err = dx - dy, x = x0, y = y0;
	for (;;) {
		for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
			const px = x + ox, py = y + oy;
			if (px >= 0 && py >= 0 && px < w && py < h) { const i = (py * w + px) * 3; rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b; }
		}
		if (x === x1 && y === y1) break;
		const e2 = 2 * err;
		if (e2 > -dy) { err -= dy; x += sx; }
		if (e2 < dx) { err += dx; y += sy; }
	}
}

/**
 * Render an accepted pair to a PNG (cropped to the pair bbox). Routes drawn
 * red/blue, endpoints green, skipped barriers orange over gray terrain.
 */
export async function renderPairPNG(state, pair, outPath, refinedRoutes) {
	const { mask, artifact } = state;
	const { W, H } = artifact;
	const xs = [pair.start.x, pair.goal.x], ys = [pair.start.y, pair.goal.y];
	for (const rt of refinedRoutes) for (const p of rt) { xs.push(p.x); ys.push(p.y); }
	const pad = 40;
	const x0 = Math.max(0, Math.min(...xs) - pad), y0 = Math.max(0, Math.min(...ys) - pad);
	const x1 = Math.min(W, Math.max(...xs) + pad), y1 = Math.min(H, Math.max(...ys) + pad);
	const w = x1 - x0, h = y1 - y0;
	const rgb = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const v = mask[(y0 + y) * W + (x0 + x)];
			const g = v === IMPASSABLE ? 20 : Math.min(255, 120 + (v >> 1));
			const i = (y * w + x) * 3; rgb[i] = g; rgb[i + 1] = g; rgb[i + 2] = g;
		}
	}
	// Skipped barriers (WP 5.3 will draw these in play) — orange, for the check.
	for (const b of pair.skippedBarriers || [])
		drawLine(rgb, w, h, (b.ax - x0) | 0, (b.ay - y0) | 0, (b.bx - x0) | 0, (b.by - y0) | 0, 240, 150, 30);
	const colors = [[220, 40, 40], [40, 80, 220]];
	refinedRoutes.forEach((rt, ri) => {
		const [r, g, b] = colors[ri % 2];
		for (let i = 1; i < rt.length; i++)
			drawLine(rgb, w, h, (rt[i - 1].x - x0) | 0, (rt[i - 1].y - y0) | 0, (rt[i].x - x0) | 0, (rt[i].y - y0) | 0, r, g, b);
	});
	for (const pt of [pair.start, pair.goal])
		drawLine(rgb, w, h, (pt.x - x0) | 0, (pt.y - y0) | 0, (pt.x - x0) | 0, (pt.y - y0) | 0, 30, 200, 30);
	await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toFile(outPath);
}

// =============================================================================
// CLI
// =============================================================================

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

function csvRow(vals) { return vals.map((v) => (v === null || v === undefined ? '' : v)).join(','); }

async function runOne(maskPath, outDir, { count, maxAttempts, seed, render }) {
	const binPath = maskPath.replace(/\.png$/i, '.navgraph.bin');
	if (!fs.existsSync(binPath)) { console.error(`  skip: no artifact ${path.basename(binPath)}`); return null; }
	const name = path.basename(maskPath).replace(/\.png$/i, '');
	const t0 = performance.now();
	let artifact;
	try { artifact = loadArtifact(binPath); }
	catch (e) { console.error(`  skip: ${e.message}`); return null; }
	const { mask } = await loadMask(maskPath);
	const state = buildState(artifact, mask);
	const buildMs = performance.now() - t0;

	const { pairs, attempts, stats } = generatePairs(state, { count, maxAttempts, rng: makeRng(seed) });

	// CSV — one row per accepted pair (rejects are aggregated in stats.reasons).
	fs.mkdirSync(outDir, { recursive: true });
	const header = ['mask', 'pair', 'retries', 'dist', 'relGap', 'sideGap',
		'len1', 'len2', 'rt1', 'rt2', 'msSample', 'msSnap', 'msRoute', 'msRefine', 'msTotal'];
	const lines = [header.join(',')];
	let pi = 0;
	attempts.filter((a) => a.ok).forEach((a) => lines.push(csvRow([name, pi++, a.retries, a.dist ? a.dist.toFixed(0) : '',
		a.relGap != null ? a.relGap.toFixed(3) : '', a.sideGap != null ? a.sideGap.toFixed(1) : '',
		a.len1 ?? '', a.len2 ?? '', a.rt1 ?? '', a.rt2 ?? '',
		a.msSample ?? '', a.msSnap ?? '', a.msRoute ?? '', a.msRefine ?? '', a.msTotal ?? ''])));
	const csvPath = path.join(outDir, `${name}.pairs.csv`);
	fs.writeFileSync(csvPath, lines.join('\n'));

	// Render a few accepted pairs + assert legality on their (already-refined) routes.
	let legalityViolations = 0;
	const nRender = Math.min(render, pairs.length);
	for (let i = 0; i < nRender; i++) {
		const pr = pairs[i];
		const refined = pr.routes.map((r) => r.path);
		for (const rf of refined) legalityViolations += countLegalityViolations(state, rf);
		await renderPairPNG(state, pr, path.join(outDir, `${name}.pair${i}.png`), refined);
	}

	console.log(`  ${name}: ${stats.valid}/${stats.attempts} valid (rate ${(stats.validRate * 100).toFixed(0)}%), ` +
		`meanRetries ${stats.meanRetries}, meanMs/valid ${stats.meanMsPerValid}, medRelGap ${stats.medianRelGap}, ` +
		`nodes ${artifact.N} edges ${artifact.E}, build ${buildMs.toFixed(0)}ms, ` +
		`rendered ${nRender} (legality hits ${legalityViolations})`);
	console.log(`    reasons: ${JSON.stringify(stats.reasons)}`);
	console.log(`    gapHist: ${JSON.stringify(stats.gapHist)}`);
	console.log(`    csv: ${path.relative(process.cwd(), csvPath)}`);
	return { name, stats };
}

// Size-varied v2 artifacts (v1 artifacts predate coarse_hitzone — rebuild them
// with `build_navgraph --force` before use).
const DEMO_MASKS = [
	'media/masks/mask_20250602_081036.png',   // small  (~1.2 Mpx)
	'media/masks/mask_20250715_092410.png',   // mid    (~5.7 Mpx)
	'media/masks/mask_20260422_134232.png',   // 75 Mpx outlier
];

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const count = args.count ? parseInt(args.count, 10) : 100;
	const maxAttempts = args['max-attempts'] ? parseInt(args['max-attempts'], 10) : Math.max(4000, count * 40);
	const seed = args.seed ? parseInt(args.seed, 10) : 1;
	const render = args.render !== undefined ? parseInt(args.render, 10) : 6;
	const outDir = args.out ? String(args.out) : 'scratch/harness';

	let masks;
	if (args['all-demo'] || (!args.mask)) masks = DEMO_MASKS;
	else masks = [String(args.mask)];

	console.log(`navgraph harness: ${masks.length} mask(s), count=${count}, maxAttempts=${maxAttempts}, seed=${seed}, out=${outDir}`);
	for (const m of masks) {
		console.log(`- ${m}`);
		await runOne(m, outDir, { count, maxAttempts, seed, render });
	}
}

// Run as CLI only when invoked directly (not on import).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => { console.error(e); process.exit(1); });
}
