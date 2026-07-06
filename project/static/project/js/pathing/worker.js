// Worker entry point. Receives the mask once per map load, caches grid +
// labels per (filename, mask hash, blockedTerrain hash) so subsequent CP
// auto-fires pay only A* + θ* — same caching policy as pathing/theta.py.

import { labelConnected } from './labels.js';
import { runPipeline, liftToEditorPolyline, applyBlockedTerrain, TRAIN_SCALE_VALUE } from './pipeline.js';
import { routeDistinct } from './distinct.js';
import { loadArtifact, buildState, makeRng, generateOnePair } from './navgraph_router.js';

const LOG_PREFIX = 'theta-client';

// --- infinity-on-masks (WP 3.2) navgraph cache -----------------------------
// Parallel to `active` (the editor mask cache) — a per-map navgraph "scene
// provider" state, built once from the .navgraph.bin artifact + full-res mask
// and reused across generatePair calls. Keyed by mapId (falls back to
// filename) exactly like the grid cache keys on filename above.
let navgraph = null;
// navgraph = {
//   key,          // mapId ?? filename
//   filename,
//   w, h,
//   state,        // buildState(artifact, mask) — sampler + graph + CSR adjacency
// };

// it as a PNG Blob. Pixel value 0 → transparent black so the impassable
// Active mask state. Only one mask in memory at a time — the editor has one
// active map per session, and switching maps invalidates everything.
let active = null;
// active = {
//   filename, w, h,
//   raw,   // Uint8Array greyscale of the unmodified mask
//   grid,  // Uint8Array greyscale after blockedTerrain overlay
//   labels, ncomp,
//   blockedKey, // JSON-string hash of blockedTerrain at grid/labels build time
// }

function blockedKey(blocked) {
    if (!blocked) return '';
    const lines = blocked.lines || [];
    const areas = blocked.areas || [];
    if (lines.length === 0 && areas.length === 0) return '';
    try {
        return JSON.stringify({ lines, areas });
    } catch (e) {
        return String(Date.now()); // forces miss
    }
}

function ensureGridAndLabels(blocked) {
    if (!active) return { ok: false, cached: false, error: 'no mask loaded' };
    const key = blockedKey(blocked);
    if (active.blockedKey === key && active.grid && active.labels) {
        return { ok: true, cached: true };
    }
    const t0 = performance.now();
    const grid = applyBlockedTerrain(active.raw, active.w, active.h, blocked);
    const { labels, ncomp } = labelConnected(grid, active.w, active.h);
    active.grid = grid;
    active.labels = labels;
    active.ncomp = ncomp;
    active.blockedKey = key;
    const dt = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[${LOG_PREFIX}] grid+labels rebuild: ${ncomp} components (${Math.round(dt)}ms)`);
    return { ok: true, cached: false };
}

function routesToGrid(existingRoutes) {
    const out = [];
    for (const route of existingRoutes || []) {
        const pts = (route?.rP || []).map(p => ({
            x: Math.round(Number(p?.x) / TRAIN_SCALE_VALUE),
            y: Math.round(Number(p?.y) / TRAIN_SCALE_VALUE),
        })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (pts.length >= 2) out.push(pts);
    }
    return out;
}

self.addEventListener('message', async (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'maskReady') {
        // Buffer transferred from main thread (zero-copy).
        const raw = new Uint8Array(msg.buffer);
        active = {
            filename: msg.filename,
            w: msg.width,
            h: msg.height,
            raw,
            grid: null,
            labels: null,
            ncomp: 0,
            blockedKey: null,
        };
        // eslint-disable-next-line no-console
        console.log(`[${LOG_PREFIX}] mask received: ${msg.filename} ${msg.width}x${msg.height}`);
        return;
    }

    if (msg.type === 'maskDiff') {
        if (!active || active.filename !== msg.filename || !msg.indices || !msg.values) return;
        const indices = new Uint32Array(msg.indices);
        const values = new Uint8Array(msg.values);
        const n = Math.min(indices.length, values.length);
        for (let i = 0; i < n; i++) {
            const idx = indices[i];
            if (idx < active.raw.length) active.raw[idx] = values[i];
        }
        active.grid = null;
        active.labels = null;
        active.ncomp = 0;
        active.blockedKey = null;
        // eslint-disable-next-line no-console
        console.log(`[${LOG_PREFIX}] mask diff applied: ${n} px`);
        return;
    }

    if (msg.type === 'invalidate') {
        active = null;
        if (!msg.keepNavgraph) navgraph = null;
        return;
    }

    // -------------------------------------------------------------- navgraph
    // Main thread transfers the artifact + the full-res greyscale mask (both as
    // zero-copy ArrayBuffers). Parse + build sampler/graph state once, cache it.
    if (msg.type === 'navgraphReady') {
        const key = msg.mapId != null ? String(msg.mapId) : String(msg.filename || '');
        // Fast path: same map already built → ignore (main thread can skip the
        // re-transfer, but if it does re-send we don't rebuild needlessly).
        if (navgraph && navgraph.key === key) {
            // eslint-disable-next-line no-console
            console.log(`[${LOG_PREFIX}] navgraph already cached for ${key}`);
            return;
        }
        try {
            const t0 = performance.now();
            const artifact = loadArtifact(msg.binBuffer);
            // Prefer the transferred mask; else reuse the editor's active raw
            // mask if it's the same map (avoids a second transfer).
            let mask;
            if (msg.maskBuffer) {
                mask = new Uint8Array(msg.maskBuffer);
            } else if (active && active.raw && active.filename === msg.filename) {
                mask = active.raw;
            } else {
                self.postMessage({ type: 'navgraph', mapId: msg.mapId, error: 'no mask bytes for navgraph' });
                return;
            }
            if (artifact.W !== msg.width || artifact.H !== msg.height) {
                // eslint-disable-next-line no-console
                console.log(`[${LOG_PREFIX}] navgraph dims ${artifact.W}x${artifact.H} != mask ${msg.width}x${msg.height}`);
            }
            const state = buildState(artifact, mask);
            navgraph = { key, filename: msg.filename, w: artifact.W, h: artifact.H, state };
            const dt = performance.now() - t0;
            // eslint-disable-next-line no-console
            console.log(`[${LOG_PREFIX}] navgraph built for ${key}: ${artifact.N} nodes, ${artifact.E} edges, ` +
                `${state.sampleCells.length} sample cells (${Math.round(dt)}ms)`);
            self.postMessage({ type: 'navgraph', mapId: msg.mapId, ready: true, nodes: artifact.N, edges: artifact.E, sampleCells: state.sampleCells.length });
        } catch (err) {
            navgraph = null;
            // eslint-disable-next-line no-console
            console.log(`[${LOG_PREFIX}] navgraph build failed: ${String(err && err.message || err)}`);
            self.postMessage({ type: 'navgraph', mapId: msg.mapId, error: String(err && err.message || err) });
        }
        return;
    }

    if (msg.type === 'generatePair') {
        const { msgId } = msg;
        if (!navgraph || !navgraph.state) {
            self.postMessage({ type: 'pair', msgId, error: 'no navgraph loaded' });
            return;
        }
        // If a mapId is supplied it must match the cached scene.
        if (msg.mapId != null && navgraph.key !== String(msg.mapId)) {
            self.postMessage({ type: 'pair', msgId, error: `navgraph mismatch (have ${navgraph.key})` });
            return;
        }
        const maxAttempts = Number.isFinite(msg.maxAttempts) ? msg.maxAttempts : 4000;
        const rng = Number.isFinite(msg.seed) ? makeRng(msg.seed >>> 0) : undefined;
        const t0 = performance.now();
        let res;
        try {
            res = generateOnePair(navgraph.state, { rng, maxAttempts });
        } catch (err) {
            self.postMessage({ type: 'pair', msgId, error: String(err && err.message || err) });
            return;
        }
        const dt = performance.now() - t0;
        if (!res.ok) {
            // eslint-disable-next-line no-console
            console.log(`[${LOG_PREFIX}] generatePair FAILED (${res.reason}) after ${res.meta?.attempts} attempts (${Math.round(dt)}ms)`);
            self.postMessage({ type: 'pair', msgId, error: `no pair: ${res.reason}`, meta: res.meta });
            return;
        }
        const tm = res.meta.timings;
        // eslint-disable-next-line no-console
        console.log(`[${LOG_PREFIX}] generatePair OK: retries=${res.meta.retries} attempts=${res.meta.attempts} ` +
            `sideGap=${res.meta.sideGap?.toFixed?.(1)} relGap=${res.meta.relGap?.toFixed?.(3)} legality=${res.meta.legality} ` +
            `[sample ${Math.round(tm.sample)}ms, snap ${Math.round(tm.snap)}ms, route ${Math.round(tm.route)}ms, refine ${Math.round(tm.refine)}ms] total ${Math.round(dt)}ms`);
        self.postMessage({
            type: 'pair',
            msgId,
            start: res.start,
            goal: res.goal,
            routes: res.routes,
            runtimes: res.runtimes,
            meta: res.meta,
        });
        return;
    }

    if (msg.type === 'pathfind') {
        const { msgId, start, ziel, blockedTerrain, mapScale, existingRoutes, blockedRoutes } = msg;
        if (!active) {
            self.postMessage({ type: 'path', msgId, error: 'no mask loaded' });
            return;
        }
        const cacheRes = ensureGridAndLabels(blockedTerrain);
        if (!cacheRes.ok) {
            self.postMessage({ type: 'path', msgId, error: cacheRes.error });
            return;
        }
        // mask-grid coords (editor sends start/ziel in *map* pixels)
        const startGrid = { x: Math.round(start.x / TRAIN_SCALE_VALUE), y: Math.round(start.y / TRAIN_SCALE_VALUE) };
        const zielGrid  = { x: Math.round(ziel.x  / TRAIN_SCALE_VALUE), y: Math.round(ziel.y  / TRAIN_SCALE_VALUE) };
        const acceptedRoutesGrid = routesToGrid(existingRoutes);
        const temporaryRoutesGrid = routesToGrid(blockedRoutes);
        const routesGrid = acceptedRoutesGrid.concat(temporaryRoutesGrid);
        let result;
        try {
            result = runPipeline(active.grid, active.labels, active.w, active.h,
                                 startGrid, zielGrid, cacheRes.cached, LOG_PREFIX, mapScale, routesGrid);
        } catch (err) {
            self.postMessage({ type: 'path', msgId, error: String(err && err.message || err) });
            return;
        }
        const polyline = result.path
            ? liftToEditorPolyline(result.path, start, ziel)
            : null;
        const tDistinct = performance.now();
        const distinct = result.path
            ? routeDistinct(result.path, acceptedRoutesGrid, active.grid, active.w, active.h)
            : { distinct: false, reason: result.error || 'no path', comparedRoutes: acceptedRoutesGrid.length };
        const distinctMs = performance.now() - tDistinct;
        if (acceptedRoutesGrid.length && result.path) {
            // eslint-disable-next-line no-console
            console.log(`[${LOG_PREFIX}] route distinct: ${distinct.distinct ? 'yes' : 'no'} (${distinct.reason}, ${Math.round(distinctMs)}ms)`);
        }
        const message = {
            type: 'path',
            msgId,
            error: result.path ? null : (result.error || 'no path'),
            path: polyline,
            distinct: distinct.distinct,
            distinctReason: distinct.reason,
            distinctStats: distinct,
            timings: result.timings,
        };
        self.postMessage(message);
        return;
    }
});
