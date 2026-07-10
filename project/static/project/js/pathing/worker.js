// Worker entry point. Receives the mask once per map load, caches grid +
// labels per (filename, mask hash, blockedTerrain hash) so subsequent CP
// auto-fires pay only A* + θ* — same caching policy as pathing/theta.py.

import { labelConnected } from './labels.js';
import { runPipeline, liftToEditorPolyline, applyBlockedTerrain, TRAIN_SCALE_VALUE } from './pipeline.js';
import { runLayeredPipeline } from './layered_pipeline.js';
import { normalizePassagesForRuntime } from './passage_geometry.js';
import { routeDistinct } from './distinct.js';
import { layeredRouteDistinct } from './layered_distinct.js';
import { loadArtifact, buildState, attachLevelPassages, makeRng, generateOnePair } from './navgraph_router.js';
import { passageRevision } from './navgraph_passage_overlay.js';
// route_pair_selection.js is a pure, dependency-free module in the results app.
// navgraph_router.js must stay importable in Node (harness) too, so it cannot
// import across apps — the worker (browser-only) injects the module instead.
// Absolute `/static/…` specifiers are the established cross-app worker pattern
// (see results/static/results/js/infinite/mask_scene_source.js).
import * as routePairSelection from '/static/results/js/infinite/route_pair_selection.js';

const LOG_PREFIX = 'theta-client';
const PAIR_WARN_MS = 5000;

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

function passageKey(document) {
    try {
        return JSON.stringify(document || null);
    } catch (_) {
        return '';
    }
}

function ensurePassages(document) {
    if (!active) return { passages: [], diagnostics: [] };
    const key = passageKey(document);
    if (active.passageKey === key && active.passages) {
        return { passages: active.passages, diagnostics: active.passageDiagnostics || [] };
    }
    const normalized = normalizePassagesForRuntime(document, {
        mapWidth: active.w,
        mapHeight: active.h,
    });
    active.passageKey = key;
    active.passages = normalized.passages;
    active.passageDiagnostics = normalized.diagnostics;
    if (normalized.diagnostics.length) {
        // Developer diagnostics only; invalid objects are skipped safely.
        console.warn(`[${LOG_PREFIX}] skipped invalid passages`, normalized.diagnostics);
    }
    return { passages: active.passages, diagnostics: active.passageDiagnostics };
}

// Compact "reason:count" string of the non-zero rejection counters, for the
// generatePair log line (dev diagnostics only — not user-facing).
function rejectionSummary(counts) {
    return Object.entries(counts || {})
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
}

function routesToGrid(existingRoutes) {
    const out = [];
    for (const route of existingRoutes || []) {
        const pts = (route?.rP || []).map(p => ({
            x: Math.round(Number(p?.x) / TRAIN_SCALE_VALUE),
            y: Math.round(Number(p?.y) / TRAIN_SCALE_VALUE),
        })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (pts.length >= 2) {
            if (Object.prototype.hasOwnProperty.call(route, 'passageSpans')
                    && Array.isArray(route.passageSpans)) {
                // Worker-only identity attached to an otherwise ordinary point
                // array. Legacy consumers still see the exact array shape.
                pts.passageSpans = route.passageSpans.map((span) => ({
                    passageId: String(span.passageId),
                    fromIndex: Number(span.fromIndex),
                    toIndex: Number(span.toIndex),
                }));
            }
            out.push(pts);
        }
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
            passageKey: null,
            passages: null,
            passageDiagnostics: [],
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
        const revision = passageRevision(
            msg.levelPassages,
            navgraph?.key === key ? navgraph.w : msg.width,
            navgraph?.key === key ? navgraph.h : msg.height,
        );
        // Fast path: same map already built → ignore (main thread can skip the
        // re-transfer, but if it does re-send we don't rebuild needlessly).
        if (navgraph && navgraph.key === key && navgraph.passageRevision === revision) {
            // eslint-disable-next-line no-console
            console.log(`[${LOG_PREFIX}] navgraph already cached for ${key}`);
            self.postMessage({
                type: 'navgraph', mapId: msg.mapId, ready: true,
                nodes: navgraph.state.artifact.N, edges: navgraph.state.artifact.E,
                sampleCells: navgraph.state.sampleCells.length,
                passageRevision: revision,
                passageOverlay: navgraph.state.passageOverlay?.stats || null,
                cached: true,
            });
            return;
        }
        try {
            const t0 = performance.now();
            if (navgraph && navgraph.key === key
                && navgraph.w === msg.width && navgraph.h === msg.height) {
                const passageStats = attachLevelPassages(navgraph.state, msg.levelPassages);
                navgraph.passageRevision = passageStats.revision;
                const dt = performance.now() - t0;
                console.log(`[${LOG_PREFIX}] navgraph passage overlay rebuilt for ${key}: ` +
                    `${passageStats.passageCount} passages, ${passageStats.portalCount} portals (${Math.round(dt)}ms)`);
                self.postMessage({
                    type: 'navgraph', mapId: msg.mapId, ready: true,
                    nodes: navgraph.state.artifact.N, edges: navgraph.state.artifact.E,
                    sampleCells: navgraph.state.sampleCells.length,
                    passageRevision: passageStats.revision,
                    passageOverlay: navgraph.state.passageOverlay?.stats || null,
                    cachedBase: true,
                });
                return;
            }
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
            const state = buildState(artifact, mask, msg.config);
            const passageStats = attachLevelPassages(state, msg.levelPassages);
            navgraph = {
                key, filename: msg.filename, w: artifact.W, h: artifact.H, state,
                passageRevision: passageStats.revision,
            };
            const dt = performance.now() - t0;
            // eslint-disable-next-line no-console
            console.log(`[${LOG_PREFIX}] navgraph built for ${key}: ${artifact.N} nodes, ${artifact.E} edges, ` +
                `${state.sampleCells.length} sample cells (${Math.round(dt)}ms)`);
            self.postMessage({
                type: 'navgraph', mapId: msg.mapId, ready: true,
                nodes: artifact.N, edges: artifact.E, sampleCells: state.sampleCells.length,
                passageRevision: passageStats.revision,
                passageOverlay: state.passageOverlay?.stats || null,
            });
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
        if (msg.passageRevision && msg.passageRevision !== navgraph.passageRevision) {
            self.postMessage({
                type: 'pair', msgId,
                error: `passage revision mismatch (have ${navgraph.passageRevision})`,
                passageRevision: navgraph.passageRevision,
            });
            return;
        }
        const maxAttempts = Number.isFinite(msg.maxAttempts) ? msg.maxAttempts : 4000;
        const rng = Number.isFinite(msg.seed) ? makeRng(msg.seed >>> 0) : undefined;
        const t0 = performance.now();
        let res;
        try {
            res = generateOnePair(navgraph.state, { rng, maxAttempts, selection: routePairSelection });
        } catch (err) {
            self.postMessage({ type: 'pair', msgId, error: String(err && err.message || err) });
            return;
        }
        const dt = performance.now() - t0;
        if (dt > PAIR_WARN_MS) {
            console.warn(`[${LOG_PREFIX}] generatePair slow: ${Math.round(dt)}ms (guard 20000ms)`);
        }
        const rejectStr = res.meta?.rejectionCounts ? rejectionSummary(res.meta.rejectionCounts) : '';
        if (!res.ok) {
            // eslint-disable-next-line no-console
            console.log(`[${LOG_PREFIX}] generatePair FAILED (${res.reason}) after ${res.meta?.attempts} attempts (${Math.round(dt)}ms) rejects={${rejectStr}}`);
            self.postMessage({
                type: 'pair', msgId, error: `no pair: ${res.reason}`,
                meta: res.meta, passageRevision: navgraph.passageRevision,
            });
            return;
        }
        const tm = res.meta.timings;
        res.meta.workerMs = +dt.toFixed(2);
        // eslint-disable-next-line no-console
        console.log(`[${LOG_PREFIX}] generatePair OK: retries=${res.meta.retries} attempts=${res.meta.attempts} ` +
            `sideGap=${res.meta.sideGap?.toFixed?.(1)} relGap=${res.meta.relGap?.toFixed?.(3)} legality=${res.meta.legality} ` +
            `rejects={${rejectStr}} ` +
            `refine=${res.meta.refineMode}${res.meta.refineFallback ? '(fallback)' : ''} ` +
            `[sample ${Math.round(tm.sample)}ms, snap ${Math.round(tm.snap)}ms, route ${Math.round(tm.route)}ms, refine ${Math.round(tm.refine)}ms, theta ${Math.round(tm.theta || 0)}ms] total ${Math.round(dt)}ms`);
        self.postMessage({
            type: 'pair',
            msgId,
            start: res.start,
            goal: res.goal,
            routes: res.routes,
            runtimes: res.runtimes,
            passageSpans: res.passageSpans || [[], []],
            passageRevision: navgraph.passageRevision,
            barriers: res.barriers,
            skippedBarriers: res.skippedBarriers,
            meta: res.meta,
        });
        return;
    }

    if (msg.type === 'pathfind') {
        const { msgId, start, ziel, blockedTerrain, mapScale, existingRoutes, blockedRoutes, levelPassages } = msg;
        if (!active) {
            self.postMessage({ type: 'path', msgId, error: 'no mask loaded' });
            return;
        }
        let cacheRes;
        let startGrid;
        let zielGrid;
        let acceptedRoutesGrid;
        let routesGrid;
        let passageState;
        let result;
        try {
            cacheRes = ensureGridAndLabels(blockedTerrain);
            if (!cacheRes.ok) {
                self.postMessage({ type: 'path', msgId, error: cacheRes.error });
                return;
            }
            // mask-grid coords (editor sends start/ziel in *map* pixels)
            startGrid = { x: Math.round(start.x / TRAIN_SCALE_VALUE), y: Math.round(start.y / TRAIN_SCALE_VALUE) };
            zielGrid = { x: Math.round(ziel.x / TRAIN_SCALE_VALUE), y: Math.round(ziel.y / TRAIN_SCALE_VALUE) };
            acceptedRoutesGrid = routesToGrid(existingRoutes);
            const temporaryRoutesGrid = routesToGrid(blockedRoutes);
            routesGrid = acceptedRoutesGrid.concat(temporaryRoutesGrid);
            passageState = ensurePassages(levelPassages);
            if (passageState.passages.length) {
                result = runLayeredPipeline(
                    active.grid, active.w, active.h,
                    startGrid, zielGrid, passageState.passages,
                    LOG_PREFIX, mapScale, routesGrid,
                );
            } else {
                result = runPipeline(active.grid, active.labels, active.w, active.h,
                                     startGrid, zielGrid, cacheRes.cached, LOG_PREFIX, mapScale, routesGrid);
            }
        } catch (err) {
            self.postMessage({ type: 'path', msgId, error: String(err && err.message || err) });
            return;
        }
        const polyline = result.path
            ? liftToEditorPolyline(result.path, start, ziel)
            : null;
        const tDistinct = performance.now();
        if (result.path && Array.isArray(result.passageSpans)) {
            result.path.passageSpans = result.passageSpans;
        }
        const distinct = result.path
            ? (passageState.passages.length
                ? layeredRouteDistinct(
                    result.path, acceptedRoutesGrid,
                    active.grid, active.w, active.h,
                    passageState.passages,
                )
                : routeDistinct(result.path, acceptedRoutesGrid, active.grid, active.w, active.h))
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
            passageSpans: result.passageSpans || [],
            layeredStats: result.layeredStats || null,
        };
        self.postMessage(message);
        return;
    }
});
