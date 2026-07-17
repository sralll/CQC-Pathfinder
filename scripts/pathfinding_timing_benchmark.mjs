// Measure wall time until production Infinity route pairs are ready.
// Runs the real generateOnePair path and writes a per-pair CSV plus summary.

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

import {
	attachSerializedPassages,
	buildState,
	generateOnePair,
	loadArtifact,
	makeRng,
	routePathLength,
} from '../project/static/project/js/pathing/navgraph_router.js';
import * as routePairSelection from '../results/static/results/js/infinite/route_pair_selection.js';

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith('--')) throw new Error(`unknown argument: ${token}`);
		const key = token.slice(2);
		const value = argv[++i];
		if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
		args[key] = value;
	}
	return args;
}

async function loadMask(maskPath) {
	const { data, info } = await sharp(maskPath, { limitInputPixels: false })
		.greyscale().raw().toBuffer({ resolveWithObject: true });
	return {
		mask: new Uint8Array(data.buffer, data.byteOffset, data.length),
		width: info.width,
		height: info.height,
	};
}

function buildBenchmarkState(artifact, mask, passagesPath) {
	const state = buildState(artifact, mask);
	if (passagesPath) {
		const document = JSON.parse(fs.readFileSync(passagesPath, 'utf8').replace(/^\uFEFF/, ''));
		const items = Array.isArray(document) ? document : document?.items;
		if (!Array.isArray(items)) throw new Error(`passage file must contain an array: ${passagesPath}`);
		attachSerializedPassages(state, items);
	} else if (artifact.baseNodeCount < artifact.N) {
		throw new Error('artifact contains passage nodes; pass --passages <level-passages.json>');
	}
	return state;
}

function quantile(sorted, q) {
	if (!sorted.length) return null;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
	return sorted[index];
}

function average(rows, field) {
	const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.mask) {
		throw new Error('usage: node scripts/pathfinding_timing_benchmark.mjs --mask <mask.png> [--count 100] [--seed 1] [--out <dir>] [--passages <json>]');
	}
	const maskPath = path.resolve(args.mask);
	const binPath = maskPath.replace(/\.png$/i, '.navgraph.bin');
	if (binPath === maskPath || !fs.existsSync(binPath)) throw new Error(`no navgraph beside mask: ${binPath}`);
	const count = args.count === undefined ? 100 : Number(args.count);
	const seed = args.seed === undefined ? 1 : Number(args.seed);
	const maxAttempts = args['max-attempts'] === undefined
		? Math.max(20000, count * 60)
		: Number(args['max-attempts']);
	if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
	if (!Number.isFinite(seed)) throw new Error('--seed must be finite');
	if (!Number.isInteger(maxAttempts) || maxAttempts < count) throw new Error('--max-attempts must be an integer >= count');

	const artifact = loadArtifact(fs.readFileSync(binPath));
	const loadedMask = await loadMask(maskPath);
	if (loadedMask.width !== artifact.W || loadedMask.height !== artifact.H) {
		throw new Error('mask dimensions differ from navgraph dimensions');
	}
	const state = buildBenchmarkState(artifact, loadedMask.mask, args.passages || null);
	const rng = makeRng(seed);
	const rows = [];
	let internalAttempts = 0;

	console.log(`timing ${path.basename(maskPath)}: ${count} pairs, seed ${seed}, nodes ${artifact.N}, edges ${artifact.E}`);
	const runStarted = performance.now();
	while (rows.length < count && internalAttempts < maxAttempts) {
		const started = performance.now();
		const result = generateOnePair(state, {
			rng,
			maxAttempts: maxAttempts - internalAttempts,
			selection: routePairSelection,
		});
		const wallMs = performance.now() - started;
		internalAttempts += result.meta?.attempts || 0;
		if (!result.ok) throw new Error(`pair generation stopped: ${result.reason}`);
		const timings = result.meta.timings || {};
		rows.push({
			index: rows.length,
			startX: result.start.x,
			startY: result.start.y,
			goalX: result.goal.x,
			goalY: result.goal.y,
			directDistance: Math.hypot(result.goal.x - result.start.x, result.goal.y - result.start.y),
			retries: result.meta.retries,
			wallMs,
			sampleMs: timings.sample || 0,
			snapMs: timings.snap || 0,
			routeMs: timings.route || 0,
			legalSpineMs: timings.refine || 0,
			thetaMs: timings.theta || 0,
			relativeGap: result.meta.relGap,
			sideGap: result.meta.sideGap,
			runtimeA: result.runtimes[0],
			runtimeB: result.runtimes[1],
			lengthA: routePathLength(result.routes[0]),
			lengthB: routePathLength(result.routes[1]),
		});
	}
	const totalWallMs = performance.now() - runStarted;

	const outDir = path.resolve(args.out || 'scratch/pathfinding/timing');
	fs.mkdirSync(outDir, { recursive: true });
	const name = path.basename(maskPath).replace(/\.png$/i, '');
	const fields = Object.keys(rows[0]);
	const csv = [fields.join(','), ...rows.map((row) => fields.map((field) => {
		const value = row[field];
		return Number.isFinite(value) ? Number(value).toFixed(3) : '';
	}).join(','))].join('\n');
	const csvPath = path.join(outDir, `${name}.timing.csv`);
	fs.writeFileSync(csvPath, `${csv}\n`);

	const wall = rows.map((row) => row.wallMs).sort((a, b) => a - b);
	const summary = [
		`mask: ${name} (${artifact.W}x${artifact.H}, nodes ${artifact.N}, edges ${artifact.E})`,
		`served pairs: ${rows.length}/${count}`,
		`internal attempts: ${internalAttempts}`,
		'',
		'wall time until served pair (ms):',
		`  mean   ${average(rows, 'wallMs').toFixed(1)}`,
		`  median ${quantile(wall, 0.5).toFixed(1)}`,
		`  p90    ${quantile(wall, 0.9).toFixed(1)}`,
		`  p99    ${quantile(wall, 0.99).toFixed(1)}`,
		`  max    ${wall[wall.length - 1].toFixed(1)}`,
		'',
		'average stage time (ms):',
		`  route       ${average(rows, 'routeMs').toFixed(1)}`,
		`  legal spine ${average(rows, 'legalSpineMs').toFixed(1)}`,
		`  theta       ${average(rows, 'thetaMs').toFixed(1)}`,
		`  retries     ${average(rows, 'retries').toFixed(2)}`,
		'',
		`total benchmark wall time: ${(totalWallMs / 1000).toFixed(1)}s`,
	].join('\n');
	const summaryPath = path.join(outDir, `${name}.timing.txt`);
	fs.writeFileSync(summaryPath, `${summary}\n`);
	console.log(summary);
	console.log(`wrote ${path.relative(process.cwd(), csvPath)} and ${path.relative(process.cwd(), summaryPath)}`);
}

main().catch((error) => {
	console.error(error.message || error);
	process.exitCode = 1;
});
