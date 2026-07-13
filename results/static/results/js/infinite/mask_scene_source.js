// Mask scene source (WP 3.3) — infinite play on real uploaded map masks.
//
// This is the mask-mode counterpart to the city generator. It owns the
// pathing worker (project/static/project/js/pathing/worker.js), loads the
// server-built navgraph + full-res mask for a chosen map (WP 3.1 endpoints),
// drives the WP 3.2 `generatePair` protocol, and keeps a prefetch buffer of
// validated pairs full so infinite_play can pull a ready scene with no visible
// wait at the ~2 s cadence.
//
// Coordinates from the worker are FULL-RES MASK PIXELS. infinite_play draws in
// "map units" (map-image pixels); mask-px × TRAIN_SCALE_VALUE = map px, exactly
// like the editor pathfind→editor lift (see pathing/worker.js pathfind branch).

import { TRAIN_SCALE_VALUE } from '/static/project/js/pathing/pipeline.js';

// Keep five future validated pairs ready. Generation runs entirely in the
// pathing Web Worker: takeScene() can return an already-buffered scene
// immediately while the worker continues replenishing later pairs. Counting
// in-flight jobs toward the target avoids an unbounded queue on slower phones.
const PREFETCH_TARGET = 5;
const PAIR_TIMEOUT_MS = 20000;
const PAIR_WARN_MS = 5000;
const REFERENCE_MAP_SCALE = 4000;
const EDITOR_PX_TO_METRES = 0.48;
// Existing player rendering contract: blockers are five source-map pixels
// wide, then scaled exactly like the uploaded map image.
export const MASK_BLOCKING_STROKE_SOURCE_PX = 5;

// Route-choice limits are real metres. Convert them to the full-resolution
// mask pixels consumed by navgraph_router using the normal editor/play scale.
const ROUTE_PICK_MIN_METRES = 40;
const ROUTE_PICK_MAX_METRES = 120;
const ROUTE_SIDE_MIN_METRES = 12;

export { TRAIN_SCALE_VALUE };

export function maskBarrierStrokeWidthMapUnits(mapScale = REFERENCE_MAP_SCALE, editorScale = 1) {
    const parsedMapScale = Number(mapScale);
    const safeMapScale = Number.isFinite(parsedMapScale) && parsedMapScale > 0
        ? parsedMapScale
        : REFERENCE_MAP_SCALE;
    const parsedEditorScale = Number(editorScale);
    const safeEditorScale = Number.isFinite(parsedEditorScale) && parsedEditorScale > 0
        ? parsedEditorScale
        : 1;
    return MASK_BLOCKING_STROKE_SOURCE_PX
        * (REFERENCE_MAP_SCALE / safeMapScale)
        * safeEditorScale;
}

export function maskBarrierStrokeWidthMaskPx(
    mapScale = REFERENCE_MAP_SCALE,
    editorScale = 1,
    mapUnitScale = TRAIN_SCALE_VALUE,
) {
    const safeMapUnitScale = Number.isFinite(Number(mapUnitScale)) && Number(mapUnitScale) > 0
        ? Number(mapUnitScale)
        : TRAIN_SCALE_VALUE;
    return maskBarrierStrokeWidthMapUnits(mapScale, editorScale) / safeMapUnitScale;
}

export function maskScaleForMap(mapScale = REFERENCE_MAP_SCALE, editorScale = 1) {
    const parsedScale = Number(mapScale);
    const safeMapScale = Number.isFinite(parsedScale) && parsedScale > 0
        ? parsedScale
        : REFERENCE_MAP_SCALE;
    const metresPerMapUnit = EDITOR_PX_TO_METRES * (safeMapScale / REFERENCE_MAP_SCALE);
    const metresPerMaskPixel = metresPerMapUnit * TRAIN_SCALE_VALUE;
    const barrierWidthPx = maskBarrierStrokeWidthMaskPx(safeMapScale, editorScale);
    return {
        mapScale: safeMapScale,
        metresPerMapUnit,
        metresPerMaskPixel,
        navConfig: {
            distMinPx: ROUTE_PICK_MIN_METRES / metresPerMaskPixel,
            distMaxPx: ROUTE_PICK_MAX_METRES / metresPerMaskPixel,
            sideGapMinPx: ROUTE_SIDE_MIN_METRES / metresPerMaskPixel,
            // The routing rectangle is the exact mask-space projection of the
            // unchanged SVG stroke used by infinite_play.
            barrierWidthPx,
            barrierClearNodeDistPx: barrierWidthPx,
        },
    };
}

// mask px → map units (same space the city scene uses for start/ziel/routes)
function toMapUnits(p) {
    return { x: p.x * TRAIN_SCALE_VALUE, y: p.y * TRAIN_SCALE_VALUE };
}

/**
 * Fetch a URL as an ArrayBuffer (authed same-origin; cookies ride along).
 */
async function fetchArrayBuffer(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.arrayBuffer();
}

async function fetchJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
}

/**
 * Decode a mask PNG (from /editor/mask/<id>/) into a greyscale Uint8Array,
 * one byte per pixel, taking channel 0 — mirrors the editor's
 * sendMaskToPathingWorker() decode. Uses createImageBitmap + OffscreenCanvas
 * (works on the main thread; the worker only wants the raw bytes).
 */
async function decodeMaskGreyscale(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const W = bitmap.width, H = bitmap.height;

    let ctx, data;
    if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(W, H);
        ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        data = ctx.getImageData(0, 0, W, H).data;
    } else {
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        data = ctx.getImageData(0, 0, W, H).data;
    }
    bitmap.close?.();

    const greys = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < greys.length; i++, j += 4) greys[i] = data[j];
    return { greys, width: W, height: H };
}

/**
 * Owns the pathing worker + prefetch buffer for ONE chosen map. Create with
 * `new MaskSceneSource({ fileId, filename, buildScene })`, call `await
 * ready()` once, then `await takeScene()` repeatedly.
 *
 * `buildScene(pair)` is supplied by infinite_play and turns a worker `pair`
 * message (map-unit coords) into a renderable scene of the same shape as a
 * city scene.
 */
export class MaskSceneSource {
    constructor({ fileId, filename, buildScene, mapScale = REFERENCE_MAP_SCALE, editorScale = 1, mapUnitScale = TRAIN_SCALE_VALUE }) {
        this.fileId = fileId;
        this.filename = filename;
        this.mapId = String(fileId);
        this.buildScene = buildScene;
        this.mapUnitScale = mapUnitScale;
        const parsedEditorScale = Number(editorScale);
        this.editorScale = Number.isFinite(parsedEditorScale) && parsedEditorScale > 0
            ? parsedEditorScale
            : 1;
        this.scale = maskScaleForMap(mapScale, this.editorScale);
        this.mapScale = this.scale.mapScale;
        this.metresPerMapUnit = this.scale.metresPerMapUnit;
        this.mapImageUrl = `/editor/map/${filename}`;

        this.worker = null;
        this.width = 0;
        this.height = 0;
        this.passageRevision = null;
        this.navReady = null;      // Promise resolved once navgraph ack arrives
        this._msgId = 1;
        this._pendingPairs = new Map();  // msgId → {resolve, reject, timer}
        this.buffer = [];          // validated scenes ready to serve
        this._inFlight = 0;        // outstanding generatePair requests
        this._refillScheduled = false;
        this._destroyed = false;
        this.metrics = { requested: 0, completed: 0, failed: 0, slow: 0, starved: 0, maxPairMs: 0 };
    }

    /** Full-res mask dimensions in map units (for background sizing). */
    get mapWidth() { return this.width * this.mapUnitScale; }
    get mapHeight() { return this.height * this.mapUnitScale; }

    async ready() {
        if (this.navReady) return this.navReady;
        this.navReady = this._boot();
        return this.navReady;
    }

    async _boot() {
        this.worker = new Worker(
            new URL('/static/project/js/pathing/worker.js', window.location.origin),
            { type: 'module' },
        );
        this.worker.addEventListener('message', (e) => this._onMessage(e.data));
        this.worker.addEventListener('error', (e) => {
            console.warn('[mask-source] worker error:', e.message || e);
        });

        const [binBuffer, mask, passageDocument] = await Promise.all([
            fetchArrayBuffer(`/editor/navgraph/${this.fileId}/`),
            decodeMaskGreyscale(`/editor/mask/${this.fileId}/`),
            fetchJson(`/editor/level-passages/${this.fileId}/`),
        ]);
        this.width = mask.width;
        this.height = mask.height;

        const ackPromise = new Promise((resolve, reject) => {
            this._navAck = { resolve, reject };
            this._navAckTimer = setTimeout(
                () => reject(new Error('navgraph ack timeout')), PAIR_TIMEOUT_MS);
        });

        this.worker.postMessage({
            type: 'navgraphReady',
            mapId: this.mapId,
            filename: this.filename,
            binBuffer,
            maskBuffer: mask.greys.buffer,
            width: mask.width,
            height: mask.height,
            config: this.scale.navConfig,
            levelPassages: passageDocument.items,
        }, [binBuffer, mask.greys.buffer]);

        const ack = await ackPromise;
        this.passageRevision = ack.passageRevision || null;
        // Kick off prefetch immediately so the buffer is warm before first take.
        this._scheduleRefill();
        return ack;
    }

    _onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'navgraph') {
            if (this._navAckTimer) { clearTimeout(this._navAckTimer); this._navAckTimer = null; }
            if (!this._navAck) return;
            if (msg.error) this._navAck.reject(new Error(msg.error));
            else this._navAck.resolve({
                nodes: msg.nodes,
                edges: msg.edges,
                sampleCells: msg.sampleCells,
                passageRevision: msg.passageRevision || null,
            });
            this._navAck = null;
            return;
        }
        if (msg.type === 'pair') {
            const pending = this._pendingPairs.get(msg.msgId);
            if (!pending) return;
            this._pendingPairs.delete(msg.msgId);
            if (pending.timer) clearTimeout(pending.timer);
            pending.resolve(msg);
            return;
        }
    }

    _requestPair() {
        const msgId = this._msgId++;
        this._inFlight++;
        this.metrics.requested++;
        const started = performance.now();
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingPairs.delete(msgId);
                reject(new Error('generatePair timeout'));
            }, PAIR_TIMEOUT_MS);
            this._pendingPairs.set(msgId, { resolve, reject, timer });
        });
        this.worker.postMessage({
            type: 'generatePair',
            msgId,
            mapId: this.mapId,
            passageRevision: this.passageRevision,
        });
        return promise.then((msg) => {
            const elapsed = performance.now() - started;
            this.metrics.completed++;
            this.metrics.maxPairMs = Math.max(this.metrics.maxPairMs, elapsed);
            if (elapsed > PAIR_WARN_MS) this.metrics.slow++;
            return msg;
        }).catch((err) => {
            this.metrics.failed++;
            throw err;
        }).finally(() => { this._inFlight--; });
    }

    /**
     * Keep issuing generatePair calls until buffer + in-flight ≥ target.
     * Each successful pair is wrapped into a scene and pushed to the buffer.
     */
    _scheduleRefill() {
        if (this._destroyed || this._refillScheduled) return;
        this._refillScheduled = true;
        Promise.resolve().then(() => this._refill());
    }

    async _refill() {
        this._refillScheduled = false;
        while (!this._destroyed && this.buffer.length + this._inFlight < PREFETCH_TARGET) {
            // Fire a request; when it resolves, wrap + buffer, then top up again.
            this._requestPair()
                .then((pairMsg) => {
                    if (this._destroyed) return;
                    if (pairMsg.error) {
                        console.warn('[mask-source] pair rejected:', pairMsg.error);
                    } else {
                        const scene = this._wrapPair(pairMsg);
                        if (scene) {
                            this.buffer.push(scene);
                            const waiter = this._sceneWaiter;
                            if (waiter) { this._sceneWaiter = null; waiter(this.buffer.shift()); }
                        }
                    }
                    this._scheduleRefill();
                })
                .catch((err) => {
                    console.warn('[mask-source] pair request failed:', err.message || err);
                    // Backoff a touch before retrying so a persistent failure
                    // (e.g. degenerate map) doesn't hot-loop the worker.
                    setTimeout(() => this._scheduleRefill(), 300);
                });
        }
    }

    /** Convert a worker `pair` message (mask px) into a scene (map units). */
    _wrapPair(pairMsg) {
        const start = toMapUnits(pairMsg.start);
        const goal = toMapUnits(pairMsg.goal);
        const toMapBarrier = (barrier) => ({
            ...barrier,
            ax: barrier.ax * TRAIN_SCALE_VALUE,
            ay: barrier.ay * TRAIN_SCALE_VALUE,
            bx: barrier.bx * TRAIN_SCALE_VALUE,
            by: barrier.by * TRAIN_SCALE_VALUE,
        });
        const routes = (pairMsg.routes || []).map((poly, i) => ({
            index: i,
            routeIndex: pairMsg.routeIndexes?.[i] ?? null,
            points: (poly || []).map(toMapUnits),
            runtime: pairMsg.runtimes?.[i] ?? null,
            obstacle: pairMsg.obstacles?.[i] ?? 0,
            passageSpans: pairMsg.passageSpans?.[i] || [],
        }));
        if (routes.length < 2 || routes.some((r) => r.points.length < 2)) return null;
        return this.buildScene({
            start,
            goal,
            routes,
            routeIndexes: pairMsg.routeIndexes || [],
            runtimes: pairMsg.runtimes || [],
            barriers: (pairMsg.barriers || []).map(toMapBarrier),
            skippedBarriers: (pairMsg.skippedBarriers || []).map(toMapBarrier),
            meta: pairMsg.meta || {},
            source: this,
        });
    }

    /** Pull a validated scene; awaits (buffering more) if none is ready yet. */
    async takeScene() {
        await this.ready();
        if (this.buffer.length) {
            const scene = this.buffer.shift();
            if (this.buffer.length < 2) {
                console.warn(`[mask-source] buffer low: ${this.buffer.length} ready, ${this._inFlight} in flight`);
            }
            this._scheduleRefill();
            return scene;
        }
        this.metrics.starved++;
        // Buffer empty (first take or a burst) — wait for the next produced scene.
        this._scheduleRefill();
        return new Promise((resolve, reject) => {
            this._sceneWaiter = resolve;
            setTimeout(() => {
                if (this._sceneWaiter === resolve) {
                    this._sceneWaiter = null;
                    reject(new Error('no mask scene available (buffer starved)'));
                }
            }, PAIR_TIMEOUT_MS);
        });
    }

    /** Number of validated scenes ready to serve right now. */
    get bufferedCount() { return this.buffer.length; }

    destroy() {
        this._destroyed = true;
        try { this.worker?.postMessage({ type: 'invalidate' }); } catch (_) {}
        try { this.worker?.terminate(); } catch (_) {}
        this.worker = null;
    }
}
