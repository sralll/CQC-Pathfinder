// Lightweight WP 7.2 benchmark for sparse passage routing.
// Usage:
//   node project/static/project/js/pathing/dev/layered_bench.mjs

import { performance } from 'node:perf_hooks';
import { labelConnected } from '../labels.js';
import { runPipeline } from '../pipeline.js';
import { runLayeredPipeline } from '../layered_pipeline.js';
import { normalizePassagesForRuntime } from '../passage_geometry.js';
import { createPassageBenchmarkFixture } from './passage_fixtures.mjs';

const fixture = createPassageBenchmarkFixture();
const { width: w, height: h, grid } = fixture.baseMask;
const originalLog = console.log;
const maxPointPolyline = Array.from({ length: 256 }, (_, index) => [100 + index * 10, 220]);

function measure(fn, iterations) {
    const samples = [];
    let last;
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        last = fn();
        samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return {
        medianMs: samples[Math.floor(samples.length / 2)],
        minMs: samples[0],
        maxMs: samples[samples.length - 1],
        last,
    };
}

const normalization = measure(() => normalizePassagesForRuntime(fixture.passages, {
    mapWidth: w,
    mapHeight: h,
}), 5);
const maxPointNormalization = measure(() => normalizePassagesForRuntime({
    version: 1,
    items: [{ id: 'max-point-straight', points: maxPointPolyline, width: 64 }],
}, { mapWidth: 4096, mapHeight: 512 }), 3);
const passages = normalization.last.passages;
const passageCells = passages.reduce((sum, passage) => sum + passage.grid.length, 0);
const { labels } = labelConnected(grid, w, h);
const start = { x: fixture.start[0], y: fixture.start[1] };
const goal = { x: fixture.goal[0], y: fixture.goal[1] };

console.log = () => {};
const legacy = measure(() => runPipeline(
    grid, labels, w, h, start, goal, true, 'bench-legacy', null, [],
), 3);
const layered = measure(() => runLayeredPipeline(
    grid, w, h, start, goal, passages, 'bench-layered', null, [],
), 5);
console.log = originalLog;

originalLog(JSON.stringify({
    fixture: fixture.name,
    maskCells: w * h,
    passageCount: passages.length,
    croppedPassageCells: passageCells,
    directionalPassageStateCells: passageCells * 2,
    normalization: {
        medianMs: +normalization.medianMs.toFixed(2),
        minMs: +normalization.minMs.toFixed(2),
        maxMs: +normalization.maxMs.toFixed(2),
    },
    maxPointRasterization: {
        points: maxPointPolyline.length,
        croppedCells: maxPointNormalization.last.passages[0]?.grid.length || 0,
        medianMs: +maxPointNormalization.medianMs.toFixed(2),
        diagnostics: maxPointNormalization.last.diagnostics.map(item => item.code),
    },
    legacy: {
        medianMs: +legacy.medianMs.toFixed(2),
        pathPoints: legacy.last?.path?.length / 2 || 0,
    },
    layered: {
        medianMs: +layered.medianMs.toFixed(2),
        minMs: +layered.minMs.toFixed(2),
        maxMs: +layered.maxMs.toFixed(2),
        pathPoints: layered.last?.path?.length / 2 || 0,
        selectedPassages: layered.last?.layeredStats?.selectedPassages || 0,
        allocatedNodes: layered.last?.layeredStats?.allocatedNodes || 0,
    },
}, null, 2));
