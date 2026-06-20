// Worker entry point. Receives the mask once per map load, caches grid +
// labels per (filename, mask hash, blockedTerrain hash) so subsequent CP
// auto-fires pay only A* + θ* — same caching policy as pathing/theta.py.

import { labelConnected } from './labels.js';
import { runPipeline, liftToEditorPolyline, applyBlockedTerrain, TRAIN_SCALE_VALUE } from './pipeline.js';
import { routeDistinct } from './distinct.js';

const LOG_PREFIX = 'theta-client';

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
