// Dev benchmark + equivalence harness for the pathing pipeline.
//
// The pathing modules are plain ES modules with no DOM dependency (they run in
// a Web Worker in production). This harness drives them from Node so an agent
// can capture before/after route polylines and per-stage timings without a
// browser.
//
// Usage:
//   node bench.mjs              # run all scenarios, print timings + output hashes
//   node bench.mjs --baseline   # write baseline JSON to ./bench-baseline.json
//   node bench.mjs --check      # compare current output against baseline (byte/JSON identical)
//   node bench.mjs --json       # dump full result JSON to stdout
//
// The baseline file is intentionally NOT committed (it is a per-run artifact);
// commit only this script so future agents regenerate baselines on demand.

import { runPipeline } from '../pipeline.js';
import { labelConnected } from '../labels.js';
import { simplifyAStarSameTerrainPath } from '../simplify.js';
import { astar } from '../astar.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, 'bench-baseline.json');

// Silence the pipeline's console.log spam unless --verbose is passed.
if (!process.argv.includes('--verbose')) {
    // eslint-disable-next-line no-console
    console.log = () => {};
}

// ---------------------------------------------------------------------------
// Synthetic grid builders. Grid is a Uint8Array where value 0 = impassable and
// 1..255 = passable with a per-pixel speed factor (higher = faster/cheaper).
// ---------------------------------------------------------------------------

function makeOpenField(w, h, val = 255) {
    const g = new Uint8Array(w * h);
    g.fill(val);
    return g;
}

// Vertical walls with a gap in each, forcing a serpentine route.
function makeWallsWithGaps(w, h) {
    const g = makeOpenField(w, h);
    const nWalls = 6;
    for (let k = 1; k <= nWalls; k++) {
        const wx = Math.floor((w * k) / (nWalls + 1));
        // gap alternates top/bottom
        const gapCenter = (k % 2 === 0) ? Math.floor(h * 0.2) : Math.floor(h * 0.8);
        const gapHalf = Math.max(6, Math.floor(h * 0.06));
        for (let y = 0; y < h; y++) {
            if (Math.abs(y - gapCenter) <= gapHalf) continue;
            for (let t = -2; t <= 2; t++) {
                const x = wx + t;
                if (x >= 0 && x < w) g[y * w + x] = 0;
            }
        }
    }
    return g;
}

// Multiple terrain grey values in horizontal bands (tests same-terrain logic).
function makeTerrainBands(w, h) {
    const g = new Uint8Array(w * h);
    const greys = [255, 200, 150, 100, 220, 180];
    for (let y = 0; y < h; y++) {
        const band = Math.floor((y / h) * greys.length) % greys.length;
        const val = greys[band];
        const base = y * w;
        for (let x = 0; x < w; x++) g[base + x] = val;
    }
    // a couple of impassable blobs
    stampRect(g, w, h, Math.floor(w * 0.3), Math.floor(h * 0.3), Math.floor(w * 0.1), Math.floor(h * 0.1), 0);
    stampRect(g, w, h, Math.floor(w * 0.6), Math.floor(h * 0.55), Math.floor(w * 0.12), Math.floor(h * 0.08), 0);
    return g;
}

// Grid of walls with generous gaps. Wide gaps guarantee the free space stays
// one connected component (so A* finds a serpentine route) while still forcing
// many turns — a good stress case for the same-terrain simplifier.
function makeMaze(w, h, cell = 40) {
    const g = makeOpenField(w, h);
    const wt = 3; // wall thickness
    const gapHalf = Math.max(cell * 0.5, 12); // wide gaps -> stays connected
    // vertical walls
    let vi = 0;
    for (let gx = cell; gx < w - cell; gx += cell) {
        const gapY = (vi % 2 === 0) ? Math.floor(h * 0.25) : Math.floor(h * 0.75);
        vi++;
        for (let y = 0; y < h; y++) {
            if (Math.abs(y - gapY) < gapHalf) continue;
            for (let t = 0; t < wt; t++) if (gx + t < w) g[y * w + gx + t] = 0;
        }
    }
    return g;
}

function stampRect(g, w, h, x0, y0, rw, rh, val) {
    for (let y = y0; y < y0 + rh && y < h; y++) {
        for (let x = x0; x < x0 + rw && x < w; x++) {
            if (x >= 0 && y >= 0) g[y * w + x] = val;
        }
    }
}

// A complex blocked-area polygon (concave, many vertices) for scanline-fill
// profiling (task 3.4). Returns a blockedTerrain-shaped object in *map* pixels
// (harness multiplies by TRAIN_SCALE inverse inside applyBlockedTerrain).
function makeComplexBlockedArea(w, h) {
    const TRAIN_SCALE = 0.710;
    const cx = w * 0.5, cy = h * 0.5;
    const pts = [];
    const spikes = 40;
    for (let i = 0; i < spikes * 2; i++) {
        const ang = (i / (spikes * 2)) * Math.PI * 2;
        const r = (i % 2 === 0) ? Math.min(w, h) * 0.35 : Math.min(w, h) * 0.18;
        // convert grid coords -> map coords (map = grid * TRAIN_SCALE)
        pts.push({ x: (cx + Math.cos(ang) * r) * TRAIN_SCALE, y: (cy + Math.sin(ang) * r) * TRAIN_SCALE });
    }
    return { lines: [], areas: [{ points: pts }] };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function buildScenarios() {
    const S = [];
    const sizes = [
        { tag: '500', w: 500, h: 500 },
        { tag: '1500', w: 1500, h: 1500 },
    ];
    for (const { tag, w, h } of sizes) {
        const m = 8; // keep start/goal off the blocked border
        S.push({ name: `open_${tag}`, w, h, grid: makeOpenField(w, h),
                 start: { x: m + 2, y: m + 2 }, ziel: { x: w - m - 3, y: h - m - 3 } });
        S.push({ name: `walls_${tag}`, w, h, grid: makeWallsWithGaps(w, h),
                 start: { x: 10, y: Math.floor(h / 2) }, ziel: { x: w - 11, y: Math.floor(h / 2) } });
        S.push({ name: `terrain_${tag}`, w, h, grid: makeTerrainBands(w, h),
                 start: { x: 12, y: 12 }, ziel: { x: w - 13, y: h - 13 } });
        S.push({ name: `maze_${tag}`, w, h, grid: makeMaze(w, h, tag === '500' ? 40 : 90),
                 start: { x: 6, y: 6 }, ziel: { x: w - 7, y: h - 7 } });
    }
    return S;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runScenario(sc) {
    const { grid, w, h, start, ziel } = sc;
    const { labels } = labelConnected(grid, w, h);

    // Warm up once (JIT), then time.
    const t0 = performance.now();
    const res = runPipeline(grid, labels, w, h, start, ziel, false, 'bench', null, []);
    const wall = performance.now() - t0;

    // Also directly exercise astar+simplify on the same grid so 3.1's target
    // is covered even when the pipeline short-circuits.
    return {
        name: sc.name,
        w, h,
        error: res.error || null,
        pathLen: res.path ? res.path.length : 0,
        // Round-trip path through JSON so float formatting is stable for diffing.
        path: res.path || null,
        timings: res.timings,
        wallMs: wall,
    };
}

// Direct simplify equivalence probe (task 3.1). Builds a few dense A* paths and
// records the exact simplified output.
function runSimplifyProbes() {
    const probes = [];
    const cases = [
        { name: 'probe_walls_600', grid: makeWallsWithGaps(600, 600), w: 600, h: 600,
          s: { x: 10, y: 300 }, g: { x: 589, y: 300 } },
        { name: 'probe_terrain_400', grid: makeTerrainBands(400, 400), w: 400, h: 400,
          s: { x: 12, y: 12 }, g: { x: 387, y: 387 } },
        { name: 'probe_maze_500', grid: makeMaze(500, 500, 40), w: 500, h: 500,
          s: { x: 6, y: 125 }, g: { x: 493, y: 375 } },
        { name: 'probe_open_800', grid: makeOpenField(800, 300), w: 800, h: 300,
          s: { x: 5, y: 150 }, g: { x: 794, y: 150 } },
    ];
    for (const c of cases) {
        const ap = astar(c.grid, c.w, c.h, c.s, c.g);
        if (!ap) { probes.push({ name: c.name, error: 'no astar path' }); continue; }
        const reps = 25;
        let best = Infinity;
        let out = null;
        for (let r = 0; r < reps; r++) {
            const t = performance.now();
            out = simplifyAStarSameTerrainPath(ap, c.grid, c.w, c.h, 10);
            const dt = performance.now() - t;
            if (dt < best) best = dt;
        }
        probes.push({
            name: c.name,
            astarPts: ap.length / 2,
            simplifiedPts: out.length / 2,
            simplified: Array.from(out),
            simplifyMsBest: best,
        });
    }
    return probes;
}

function main() {
    const scenarios = buildScenarios();
    const results = scenarios.map(runScenario);
    const probes = runSimplifyProbes();

    const payload = { results, probes };

    if (process.argv.includes('--baseline')) {
        writeFileSync(BASELINE_PATH, JSON.stringify(payload, stripTimings, 2));
        console.error(`baseline written to ${BASELINE_PATH}`);
    }

    if (process.argv.includes('--check')) {
        if (!existsSync(BASELINE_PATH)) {
            console.error('NO BASELINE FILE — run --baseline first');
            process.exit(2);
        }
        const base = readFileSync(BASELINE_PATH, 'utf8');
        const cur = JSON.stringify(payload, stripTimings, 2);
        if (base === cur) {
            console.error('EQUIVALENCE: IDENTICAL ✓');
        } else {
            console.error('EQUIVALENCE: CHANGED ✗');
            // find first differing scenario/probe
            reportDiff(JSON.parse(base), payload);
            process.exit(1);
        }
    }

    if (process.argv.includes('--json')) {
        process.stdout.write(JSON.stringify(payload, null, 2));
        return;
    }

    // Human-readable timing table (always, unless --json).
    console.error('\n=== Pipeline scenarios ===');
    for (const r of results) {
        const t = r.timings || {};
        console.error(
            `${r.name.padEnd(16)} wall=${fmt(r.wallMs)}ms ` +
            `astar=${fmt(t.a_star)} simpST=${fmt(t.simplify_astar_same_terrain)} ` +
            `corridor=${fmt(t.corridor)} theta=${fmt(t.theta_star)} ` +
            `total=${fmt(t.total)} pts=${r.pathLen / 2}${r.error ? ' ERR:' + r.error : ''}`,
        );
    }
    console.error('\n=== simplify probes (task 3.1 target) ===');
    for (const p of probes) {
        if (p.error) { console.error(`${p.name}: ${p.error}`); continue; }
        console.error(
            `${p.name.padEnd(18)} astarPts=${String(p.astarPts).padEnd(6)} ` +
            `-> ${String(p.simplifiedPts).padEnd(4)} simplify=${fmt(p.simplifyMsBest)}ms (best of 25)`,
        );
    }
}

// When writing/comparing the baseline we strip timing numbers (non-deterministic)
// but KEEP all output geometry (paths, simplified polylines, pt counts, errors).
function stripTimings(key, value) {
    if (key === 'timings' || key === 'wallMs' || key === 'simplifyMsBest') return undefined;
    return value;
}

function reportDiff(base, cur) {
    const bResults = base.results || [];
    const cResults = cur.results || [];
    for (let i = 0; i < cResults.length; i++) {
        const a = JSON.stringify(bResults[i], stripTimings);
        const b = JSON.stringify(cResults[i], stripTimings);
        if (a !== b) console.error(`  scenario differs: ${cResults[i].name}`);
    }
    const bP = base.probes || [];
    const cP = cur.probes || [];
    for (let i = 0; i < cP.length; i++) {
        const a = JSON.stringify(bP[i], stripTimings);
        const b = JSON.stringify(cP[i], stripTimings);
        if (a !== b) console.error(`  probe differs: ${cP[i].name}`);
    }
}

function fmt(n) {
    if (n === undefined || n === null) return '  -  ';
    return n.toFixed(2).padStart(7);
}

main();
