// =============================================================================
// infinity_endpoint_heatmap.mjs — headless (Node) distribution + timing probe
// for the user-uploaded infinity-mode play style (plan.md Phase 3+).
//
// What it does, per the request:
//   1. Repeatedly generates a start/goal + candidate routes exactly as the served
//      pipeline does (drives the REAL generateOnePair from navgraph_router.js:
//      sampling + prefilters + graph A* + barrier alternates + weighted selection
//      + θ* refinement + balance reject). Only pairs that would actually be served
//      come back, so every logged pair is a "would-be-served" control pair.
//   2. Logs each served start/goal (full-res mask px) to a CSV.
//   3. Times how long each served control pair takes to find its full (refined)
//      routes — msTotal is the wall time to produce that one served pair
//      (including the rejected sampling attempts before it) plus the per-stage
//      breakdown (sample / snap / graph-route / legal-refine / θ*).
//   4. Renders an endpoint-density HEATMAP composited over the dimmed mask so you
//      can see the spatial distribution of served start & goal points.
//
// It reuses the harness helpers (which themselves import navgraph_router.js — the
// single source of truth), so this stays in lock-step with what the browser
// worker serves. No pipeline logic is duplicated here.
//
// CLI:
//   node scripts/infinity_endpoint_heatmap.mjs --mask media/masks/<name>.png \
//        [--count 1000] [--seed 1] [--out scratch/endpoint_heatmap] \
//        [--passages scratch/<name>.passages.json] [--max-out 1600] \
//        [--sigma 6] [--percentile 99.5]
//
// Requires a v4 .navgraph.bin next to the mask (build_navgraph). Output:
//   <out>/<name>.endpoints.csv        one row per served control pair
//   <out>/<name>.timing.txt           timing + distribution summary
//   <out>/<name>.heatmap.png          combined start+goal density over the mask
//   <out>/<name>.heatmap.starts.png   starts only
//   <out>/<name>.heatmap.goals.png    goals only
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

import {
	IMPASSABLE, loadArtifact, loadMask, buildBenchmarkState, makeRng, generatePairs,
} from './navgraph_harness.mjs';

// -----------------------------------------------------------------------------
// arg parsing
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// separable gaussian blur on a float grid (approx via 3 box passes)
// -----------------------------------------------------------------------------
function boxBlurPass(src, w, h, r) {
	if (r < 1) return src;
	const tmp = new Float32Array(w * h);
	const norm = 1 / (2 * r + 1);
	// horizontal
	for (let y = 0; y < h; y++) {
		const row = y * w;
		let acc = 0;
		for (let x = -r; x <= r; x++) acc += src[row + Math.max(0, Math.min(w - 1, x))];
		for (let x = 0; x < w; x++) {
			tmp[row + x] = acc * norm;
			const add = src[row + Math.min(w - 1, x + r + 1)];
			const sub = src[row + Math.max(0, x - r)];
			acc += add - sub;
		}
	}
	const out = new Float32Array(w * h);
	// vertical
	for (let x = 0; x < w; x++) {
		let acc = 0;
		for (let y = -r; y <= r; y++) acc += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
		for (let y = 0; y < h; y++) {
			out[y * w + x] = acc * norm;
			const add = tmp[Math.min(h - 1, y + r + 1) * w + x];
			const sub = tmp[Math.max(0, y - r) * w + x];
			acc += add - sub;
		}
	}
	return out;
}

function gaussianBlur(src, w, h, sigma) {
	if (sigma <= 0) return src;
	const r = Math.max(1, Math.round(sigma));
	let g = src;
	for (let i = 0; i < 3; i++) g = boxBlurPass(g, w, h, r);
	return g;
}

// turbo-ish 5-stop colormap; t in [0,1] -> [r,g,b]
const STOPS = [
	[0.00, [40, 20, 120]],
	[0.25, [0, 140, 255]],
	[0.50, [0, 220, 120]],
	[0.75, [255, 220, 0]],
	[1.00, [255, 40, 0]],
];
function colormap(t) {
	t = Math.max(0, Math.min(1, t));
	for (let i = 1; i < STOPS.length; i++) {
		if (t <= STOPS[i][0]) {
			const [t0, c0] = STOPS[i - 1];
			const [t1, c1] = STOPS[i];
			const f = (t - t0) / (t1 - t0 || 1);
			return [
				c0[0] + (c1[0] - c0[0]) * f,
				c0[1] + (c1[1] - c0[1]) * f,
				c0[2] + (c1[2] - c0[2]) * f,
			];
		}
	}
	return STOPS[STOPS.length - 1][1];
}

// percentile of nonzero values (for robust normalization)
function nonzeroPercentile(grid, p) {
	const vals = [];
	for (let i = 0; i < grid.length; i++) if (grid[i] > 0) vals.push(grid[i]);
	if (!vals.length) return 1;
	vals.sort((a, b) => a - b);
	const idx = Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))));
	return vals[idx] || 1;
}

// -----------------------------------------------------------------------------
// render a heatmap grid composited over the dimmed, downscaled mask
// -----------------------------------------------------------------------------
async function renderHeatmap(state, points, outPath, { maxOut, sigma, percentile }) {
	const { mask, artifact } = state;
	const { W, H, coarseHitzone, hitzoneScale, hw, hh } = artifact;
	const outScale = Math.max(1, Math.ceil(Math.max(W, H) / maxOut));
	const ow = Math.ceil(W / outScale);
	const oh = Math.ceil(H / outScale);

	// accumulate endpoints into the output grid
	const grid = new Float32Array(ow * oh);
	for (const pt of points) {
		const gx = Math.min(ow - 1, (pt.x / outScale) | 0);
		const gy = Math.min(oh - 1, (pt.y / outScale) | 0);
		grid[gy * ow + gx] += 1;
	}
	const blurred = gaussianBlur(grid, ow, oh, sigma);
	const norm = nonzeroPercentile(blurred, percentile);

	const rgb = Buffer.alloc(ow * oh * 3);
	for (let y = 0; y < oh; y++) {
		for (let x = 0; x < ow; x++) {
			// dimmed background from the mask (impassable dark, passable muted)
			const mv = mask[Math.min(H - 1, y * outScale) * W + Math.min(W - 1, x * outScale)];
			let bg = mv === IMPASSABLE ? 12 : 45 + (mv >> 3);
			// darken outside the coach region so the served distribution reads clearly
			if (coarseHitzone && hitzoneScale) {
				const hx = Math.min(hw - 1, ((x * outScale) / hitzoneScale) | 0);
				const hy = Math.min(hh - 1, ((y * outScale) / hitzoneScale) | 0);
				if (!coarseHitzone[hy * hw + hx]) bg = (bg * 0.55) | 0;
			}

			const t = blurred[y * ow + x] / norm;
			const a = t <= 0 ? 0 : Math.min(1, Math.pow(t, 0.6) * 1.1);
			const i = (y * ow + x) * 3;
			if (a <= 0) { rgb[i] = bg; rgb[i + 1] = bg; rgb[i + 2] = bg; continue; }
			const [r, g, b] = colormap(Math.min(1, t));
			rgb[i] = (bg * (1 - a) + r * a) | 0;
			rgb[i + 1] = (bg * (1 - a) + g * a) | 0;
			rgb[i + 2] = (bg * (1 - a) + b * a) | 0;
		}
	}
	await sharp(rgb, { raw: { width: ow, height: oh, channels: 3 } }).png().toFile(outPath);
	return { ow, oh, outScale };
}

// -----------------------------------------------------------------------------
// stats helpers
// -----------------------------------------------------------------------------
function quantile(sorted, q) {
	if (!sorted.length) return null;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
	return sorted[idx];
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------
async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.mask) {
		console.error('usage: node scripts/infinity_endpoint_heatmap.mjs --mask media/masks/<name>.png [--passages <document.json>] [--count 1000] [--seed 1] [--out scratch/endpoint_heatmap]');
		process.exit(1);
	}
	const maskPath = String(args.mask);
	const count = args.count ? parseInt(args.count, 10) : 1000;
	const seed = args.seed ? parseInt(args.seed, 10) : 1;
	const maxAttempts = args['max-attempts'] ? parseInt(args['max-attempts'], 10) : Math.max(20000, count * 60);
	const outDir = args.out ? String(args.out) : 'scratch/endpoint_heatmap';
	const maxOut = args['max-out'] ? parseInt(args['max-out'], 10) : 1600;
	const sigma = args.sigma !== undefined ? parseFloat(args.sigma) : 6;
	const percentile = args.percentile !== undefined ? parseFloat(args.percentile) : 99.5;
	const passagesPath = args.passages ? String(args.passages) : null;

	const binPath = maskPath.replace(/\.png$/i, '.navgraph.bin');
	if (!fs.existsSync(binPath)) {
		console.error(`no artifact next to mask: ${binPath} (run: python manage.py build_navgraph --file ${maskPath})`);
		process.exit(1);
	}
	const name = path.basename(maskPath).replace(/\.png$/i, '');
	fs.mkdirSync(outDir, { recursive: true });

	console.log(`infinity endpoint heatmap: ${name}, count=${count}, seed=${seed}, maxAttempts=${maxAttempts}`);
	const artifact = loadArtifact(binPath);
	const { mask } = await loadMask(maskPath);
	const state = buildBenchmarkState(artifact, mask, undefined, passagesPath);
	console.log(`  nodes ${artifact.N} edges ${artifact.E}  ${artifact.W}x${artifact.H}px`);

	const tWall = performance.now();
	const { pairs, attempts } = generatePairs(state, { count, maxAttempts, rng: makeRng(seed) });
	const wallMs = performance.now() - tWall;
	const ok = attempts.filter((a) => a.ok);
	const failed = attempts.find((a) => !a.ok);

	// CSV: one row per served control pair
	const header = ['idx', 'startX', 'startY', 'goalX', 'goalY', 'dist',
		'retries', 'msTotal', 'msSample', 'msSnap', 'msRoute', 'msRefine', 'msTheta',
		'relGap', 'sideGap', 'rt1', 'rt2', 'len1', 'len2'];
	const lines = [header.join(',')];
	const startPts = [];
	const goalPts = [];
	for (let i = 0; i < pairs.length; i++) {
		const p = pairs[i];
		const a = ok[i] || {};
		const tm = p.meta?.timings || {};
		startPts.push(p.start);
		goalPts.push(p.goal);
		lines.push([
			i, p.start.x | 0, p.start.y | 0, p.goal.x | 0, p.goal.y | 0, (p.dist || 0).toFixed(0),
			a.retries ?? '', a.msTotal ?? '', tm.sample ?? '', tm.snap ?? '', tm.route ?? '',
			tm.refine ?? '', tm.theta ?? '',
			a.relGap != null ? a.relGap.toFixed(3) : '', a.sideGap != null ? a.sideGap.toFixed(1) : '',
			a.rt1 ?? '', a.rt2 ?? '', a.len1 ?? '', a.len2 ?? '',
		].join(','));
	}
	const csvPath = path.join(outDir, `${name}.endpoints.csv`);
	fs.writeFileSync(csvPath, lines.join('\n'));

	// timing distribution over served control pairs
	const msSorted = ok.map((a) => a.msTotal).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
	const sum = msSorted.reduce((s, v) => s + v, 0);
	const summary = [
		`mask: ${name}  (${artifact.W}x${artifact.H}px, nodes ${artifact.N}, edges ${artifact.E})`,
		`served control pairs: ${pairs.length} / requested ${count}`,
		failed ? `stopped early: attempt budget exhausted (${maxAttempts}); last reject reason "${failed.reason}"` : `all ${count} pairs served`,
		`total internal sampling attempts: ${attempts.reduce((s, a) => s + (a.retries ?? 0), 0) + pairs.length} (approx)`,
		'',
		'time to find full routes per served control pair (ms):',
		`  mean   ${msSorted.length ? (sum / msSorted.length).toFixed(1) : '-'}`,
		`  median ${quantile(msSorted, 0.5)?.toFixed(1) ?? '-'}`,
		`  p90    ${quantile(msSorted, 0.9)?.toFixed(1) ?? '-'}`,
		`  p99    ${quantile(msSorted, 0.99)?.toFixed(1) ?? '-'}`,
		`  max    ${msSorted.length ? msSorted[msSorted.length - 1].toFixed(1) : '-'}`,
		`  total wall time for the run: ${(wallMs / 1000).toFixed(1)}s`,
		'',
		'(msTotal = wall time to produce that served pair, including rejected',
		' sampling attempts before it + θ* refinement of the two served routes.',
		' Per-stage columns in the CSV break it into sample/snap/route/refine/theta.)',
	].join('\n');
	const timingPath = path.join(outDir, `${name}.timing.txt`);
	fs.writeFileSync(timingPath, summary + '\n');
	console.log(summary);

	// heatmaps
	const combined = startPts.concat(goalPts);
	const hp = path.join(outDir, `${name}.heatmap.png`);
	await renderHeatmap(state, combined, hp, { maxOut, sigma, percentile });
	await renderHeatmap(state, startPts, path.join(outDir, `${name}.heatmap.starts.png`), { maxOut, sigma, percentile });
	await renderHeatmap(state, goalPts, path.join(outDir, `${name}.heatmap.goals.png`), { maxOut, sigma, percentile });

	console.log(`\nwrote:\n  ${path.relative(process.cwd(), csvPath)}\n  ${path.relative(process.cwd(), timingPath)}\n  ${path.relative(process.cwd(), hp)} (+ .starts / .goals)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
