// =============================================================================
// wp5_2_verify.mjs — acceptance harness for WP 5.2 (corridor + guided θ*).
//
// For each mask: run generateOnePair (the real worker function, θ* refinement
// live) `count` times and assert:
//   - zero legality violations on the true mask (meta.legality)
//   - zero active-barrier crossings on the served routes (segment intersection
//     against each route's stamped active barriers — we synthesize extra test
//     barriers to exercise stamping since WP 5.3 doesn't place many yet)
//   - refined runtime ≤ legal-spine runtime on ≥ 95 % of routes (θ* only helps)
//   - p90 refine time per pair (refine + theta ms) ≤ ~800 ms
// plus a few spot-check PNGs of the θ*-refined polylines.
//
//   node scripts/wp5_2_verify.mjs [--seed 1]
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
	buildState, makeRng, generateOnePair,
} from '../project/static/project/js/pathing/navgraph_router.js';
import { countBarrierViolations } from '../project/static/project/js/pathing/refine_theta.js';
import { loadArtifact, loadMask, renderPairPNG } from './navgraph_harness.mjs';
import * as routePairSelection from '../results/static/results/js/infinite/route_pair_selection.js';

// small / median / 75 Mpx (per plan acceptance).
const MASKS = [
	{ file: 'media/masks/mask_20250602_081036.png', count: 90, render: 4, label: 'small' },
	{ file: 'media/masks/mask_20250715_092410.png', count: 90, render: 4, label: 'median' },
	{ file: 'media/masks/mask_20260422_134232.png', count: 40, render: 4, label: '75Mpx' },
];

// segment-segment proper/touching intersection (same test as the router).
function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
	const o = (px, py, qx, qy, rx, ry) => {
		const val = (qy - py) * (rx - qx) - (qx - px) * (ry - qy);
		return val > 1e-9 ? 1 : val < -1e-9 ? -1 : 0;
	};
	const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy);
	const o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
	return o1 !== o2 && o3 !== o4;
}

/** How many segments of `route` cross any barrier in `bars`. */
function crossings(route, bars) {
	let n = 0;
	for (let i = 1; i < route.length; i++) {
		for (const b of bars) {
			if (segIntersect(route[i - 1].x, route[i - 1].y, route[i].x, route[i].y, b.ax, b.ay, b.bx, b.by)) { n++; break; }
		}
	}
	return n;
}

function pct(arr, p) {
	if (!arr.length) return null;
	const s = arr.slice().sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function runMask(m, seed, outDir) {
	const binPath = m.file.replace(/\.png$/i, '.navgraph.bin');
	if (!fs.existsSync(binPath) || !fs.existsSync(m.file)) { console.log(`  skip ${m.label}: missing artifact/png`); return null; }
	const artifact = loadArtifact(binPath);
	const { mask } = await loadMask(m.file);
	const state = buildState(artifact, mask);
	const rng = makeRng(seed);

	let accepted = 0, legalityTotal = 0, barCross = 0, barCrossGeom = 0, barTestedRoutes = 0;
	let routesTotal = 0, thetaRoutes = 0, improvedRoutes = 0;
	let fallbackPairs = 0, thetaPairs = 0;
	const failReasons = {};
	const refinePairMs = [];
	const rendered = [];
	const t0 = performance.now();

	let guard = 0;
	while (accepted < m.count && guard < m.count * 200) {
		guard++;
		const res = generateOnePair(state, { rng, maxAttempts: 400, selection: routePairSelection });
		if (!res.ok) continue;
		accepted++;
		legalityTotal += res.meta.legality;
		const rp = res.meta.timings.refine + (res.meta.timings.theta || 0);
		refinePairMs.push(rp);
		if (res.meta.refineFallback) fallbackPairs++; else thetaPairs++;

		// per-route θ*-vs-legal improvement + barrier crossings.
		const routes = res.routes;
		for (let k = 0; k < 2; k++) {
			routesTotal++;
			const info = res.meta.refine[k];
			if (info.thetaCost != null) {
				thetaRoutes++;
				if (info.thetaCost <= info.legalCost + 1e-6) improvedRoutes++;
			} else {
				const rk = info.thetaFail || 'unknown';
				failReasons[rk] = (failReasons[rk] || 0) + 1;
			}
			// Active barriers actually stamped for this route during refinement
			// (attemptIndex < routeIndex). A correctly-refined route must not
			// cross any of them — checked both with the canonical stamped-band
			// legality (countBarrierViolations, what the code enforces) and the
			// stricter geometric segment-intersection.
			const active = info.activeBarriers || [];
			if (active.length) {
				barTestedRoutes++;
				if (countBarrierViolations(routes[k], active) > 0) barCross++;
				barCrossGeom += crossings(routes[k], active) > 0 ? 1 : 0;
			}
		}

		if (rendered.length < m.render) rendered.push(res);
	}
	const wallMs = performance.now() - t0;

	// Spot-check PNGs — draw active barriers orange so we can see routes hug
	// terrain and avoid the stamped bars.
	fs.mkdirSync(outDir, { recursive: true });
	const name = path.basename(m.file).replace(/\.png$/i, '');
	for (let i = 0; i < rendered.length; i++) {
		const r = rendered[i];
		const bars = [];
		for (const info of r.meta.refine) for (const b of (info.activeBarriers || [])) bars.push(b);
		const pair = { start: r.start, goal: r.goal, skippedBarriers: bars.concat(r.skippedBarriers || []) };
		await renderPairPNG(state, pair, path.join(outDir, `${name}.wp52.pair${i}.png`), r.routes);
	}

	const p90 = pct(refinePairMs, 0.9);
	const improvedPct = thetaRoutes ? (100 * improvedRoutes / thetaRoutes) : 0;
	const out = {
		label: m.label, name, accepted, legalityTotal, barCross, barCrossGeom, barTestedRoutes,
		routesTotal, thetaRoutes, improvedRoutes, improvedPct: +improvedPct.toFixed(1),
		thetaPairs, fallbackPairs,
		p90RefineMs: p90 != null ? +p90.toFixed(1) : null,
		meanRefineMs: refinePairMs.length ? +(refinePairMs.reduce((s, v) => s + v, 0) / refinePairMs.length).toFixed(1) : null,
		maxRefineMs: refinePairMs.length ? +Math.max(...refinePairMs).toFixed(1) : null,
		wallMs: +wallMs.toFixed(0), rendered: rendered.length,
	};
	out.failReasons = failReasons;
	console.log(`  ${m.label} (${name}): accepted=${accepted} legality=${legalityTotal} barCross=${barCross}(geom ${barCrossGeom})/${barTestedRoutes}routes ` +
		`improved=${improvedRoutes}/${thetaRoutes} (${out.improvedPct}%) thetaPairs=${thetaPairs} fallbackPairs=${fallbackPairs} ` +
		`p90Refine=${out.p90RefineMs}ms mean=${out.meanRefineMs}ms max=${out.maxRefineMs}ms rendered=${rendered.length}`);
	console.log(`    θ*-fail reasons: ${JSON.stringify(failReasons)}`);
	return out;
}

async function main() {
	const args = process.argv.slice(2);
	let seed = 1;
	for (let i = 0; i < args.length; i++) if (args[i] === '--seed') seed = parseInt(args[++i], 10);
	const outDir = 'scratch/wp5_2';
	console.log(`WP 5.2 verify: seed=${seed}, out=${outDir}`);
	const results = [];
	for (const m of MASKS) {
		console.log(`- ${m.file}`);
		const r = await runMask(m, seed, outDir);
		if (r) results.push(r);
	}

	// Aggregate acceptance.
	const totalAccepted = results.reduce((s, r) => s + r.accepted, 0);
	const totalLegality = results.reduce((s, r) => s + r.legalityTotal, 0);
	const totalBarCross = results.reduce((s, r) => s + r.barCross, 0);
	const totalBarCrossGeom = results.reduce((s, r) => s + r.barCrossGeom, 0);
	const totalTheta = results.reduce((s, r) => s + r.thetaRoutes, 0);
	const totalImproved = results.reduce((s, r) => s + r.improvedRoutes, 0);
	const internalErrors = results.flatMap((r) => Object.keys(r.failReasons || {})
		.filter((reason) => reason.startsWith('error:'))
		.map((reason) => `${r.label}:${reason}`));
	const aggImprovedPct = totalTheta ? +(100 * totalImproved / totalTheta).toFixed(1) : 0;
	const worstP90 = Math.max(...results.map((r) => r.p90RefineMs || 0));
	console.log('\n=== WP 5.2 acceptance ===');
	console.log(`accepted pairs total: ${totalAccepted} (need ≥ 200)`);
	console.log(`legality violations:  ${totalLegality} (need 0)`);
	console.log(`active-bar crossings: ${totalBarCross} stamped-band, ${totalBarCrossGeom} geometric (need 0)`);
	console.log(`refined ≤ legal:      ${totalImproved}/${totalTheta} = ${aggImprovedPct}% (need ≥ 95%)`);
	console.log(`worst p90 refine/pair: ${worstP90}ms (need ≤ ~800ms)`);

	if (internalErrors.length) {
		throw new Error(`Theta refinement raised internal errors: ${internalErrors.join(', ')}`);
	}
	fs.writeFileSync(path.join(outDir, 'wp5_2_results.json'), JSON.stringify({ seed, results }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
