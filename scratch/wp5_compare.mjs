// WP 5.1 acceptance harness (scratch): fair pre/post comparison of the SERVED
// pipeline (generateOnePair, which always included refinement), reproducibility,
// and the forced-tiny-budget timeout test. Not shipped; lives in scratch/.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import * as HEAD from './navgraph_router_HEAD.mjs';           // pre-change router (self-contained)
import * as NEW from '../project/static/project/js/pathing/navgraph_router.js';
import { loadMask } from '../scripts/navgraph_harness.mjs';
import * as selection from '../results/static/results/js/infinite/route_pair_selection.js';

const MASKS = fs.readdirSync('scratch/wp5_masks').filter((f) => f.endsWith('.png'))
	.map((f) => path.join('scratch/wp5_masks', f));
const SEED = 1;
const COUNT = 60;
const MAX_ATTEMPTS = COUNT * 60;

function runBatch(mod, state, { selection: sel } = {}) {
	const rng = mod.makeRng(SEED);
	const pairs = [];
	let internal = 0, legality = 0;
	const rej = {};
	let wall = 0;
	while (pairs.length < COUNT && internal < MAX_ATTEMPTS) {
		const t0 = performance.now();
		const res = mod.generateOnePair(state, { rng, maxAttempts: MAX_ATTEMPTS - internal, selection: sel });
		wall += performance.now() - t0;
		internal += res.meta?.attempts || 0;
		if (res.meta?.rejectionCounts) for (const k in res.meta.rejectionCounts) rej[k] = (rej[k] || 0) + res.meta.rejectionCounts[k];
		if (!res.ok) break;
		legality += res.meta.legality;
		pairs.push(res);
	}
	return { valid: pairs.length, internal, wallMsPerValid: pairs.length ? +(wall / pairs.length).toFixed(1) : null, legality, rej, pairs };
}

console.log(`Masks: ${MASKS.length}, count=${COUNT}, seed=${SEED}\n`);
let sumHead = 0, sumNew = 0, nHead = 0, nNew = 0, totLegNew = 0;
const aggRej = {};
for (const maskPath of MASKS) {
	const bin = maskPath.replace(/\.png$/i, '.navgraph.bin');
	const name = path.basename(maskPath, '.png');
	const { mask } = await loadMask(maskPath);
	const artHead = HEAD.loadArtifact(fs.readFileSync(bin));
	const artNew = NEW.loadArtifact(fs.readFileSync(bin));
	const stHead = HEAD.buildState(artHead, mask);
	const stNew = NEW.buildState(artNew, mask);
	const rH = runBatch(HEAD, stHead, {});
	const rN = runBatch(NEW, stNew, { selection });
	for (const k in rN.rej) aggRej[k] = (aggRej[k] || 0) + rN.rej[k];
	totLegNew += rN.legality;
	if (rH.wallMsPerValid != null) { sumHead += rH.wallMsPerValid; nHead++; }
	if (rN.wallMsPerValid != null) { sumNew += rN.wallMsPerValid; nNew++; }
	const ratio = rH.wallMsPerValid ? (rN.wallMsPerValid / rH.wallMsPerValid).toFixed(2) : '-';
	console.log(`${name}: HEAD ${rH.valid}v ${rH.wallMsPerValid}ms/v | NEW ${rN.valid}v ${rN.wallMsPerValid}ms/v (x${ratio}) leg=${rN.legality}`);
}
const mHead = sumHead / nHead, mNew = sumNew / nNew;
console.log(`\nMean ms/valid: HEAD ${mHead.toFixed(1)} | NEW ${mNew.toFixed(1)} | ratio x${(mNew / mHead).toFixed(2)}`);
console.log(`NEW total legality violations: ${totLegNew}`);
console.log(`NEW aggregate rejections: ${JSON.stringify(aggRej)}`);

// --- reproducibility: same seed twice → identical served output --------------
{
	const maskPath = MASKS[0];
	const bin = maskPath.replace(/\.png$/i, '.navgraph.bin');
	const { mask } = await loadMask(maskPath);
	const st = NEW.buildState(NEW.loadArtifact(fs.readFileSync(bin)), mask);
	const a = runBatch(NEW, st, { selection });
	const st2 = NEW.buildState(NEW.loadArtifact(fs.readFileSync(bin)), mask);
	const b = runBatch(NEW, st2, { selection });
	const sig = (r) => JSON.stringify(r.pairs.map((p) => ({ s: p.start, g: p.goal, rt: p.runtimes, n: p.routes.map((x) => x.length) })));
	console.log(`\nReproducibility (${path.basename(maskPath, '.png')}): ${sig(a) === sig(b) ? 'IDENTICAL' : 'DIFFERENT'} (${a.pairs.length} vs ${b.pairs.length} pairs)`);
}

// --- forced tiny budget → timeout rejections, no hang ------------------------
{
	const maskPath = MASKS[0];
	const bin = maskPath.replace(/\.png$/i, '.navgraph.bin');
	const { mask } = await loadMask(maskPath);
	const st = NEW.buildState(NEW.loadArtifact(fs.readFileSync(bin)), mask, { primaryBudgetMs: 1, extraBudgetMs: 1 });
	const rng = NEW.makeRng(SEED);
	const t0 = performance.now();
	const res = NEW.generateOnePair(st, { rng, maxAttempts: 300, selection });
	const dt = performance.now() - t0;
	console.log(`\nTiny-budget (primaryBudgetMs:1): ok=${res.ok} reason=${res.reason} timeoutRejects=${res.meta?.rejectionCounts?.timeout} attempts=${res.meta?.attempts} (${dt.toFixed(0)}ms, no hang)`);
}
