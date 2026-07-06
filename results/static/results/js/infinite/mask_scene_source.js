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

// Keep at least this many validated pairs ready. WP 3.3 requires ≥ 2 so the
// user never waits when advancing at the ~2 s play cadence.
const PREFETCH_TARGET = 3;   // one served + ≥2 buffered
const PAIR_TIMEOUT_MS = 20000;

export { TRAIN_SCALE_VALUE };

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
    constructor({ fileId, filename, buildScene, mapUnitScale = TRAIN_SCALE_VALUE }) {
        this.fileId = fileId;
        this.filename = filename;
        this.mapId = String(fileId);
        this.buildScene = buildScene;
        this.mapUnitScale = mapUnitScale;
        this.mapImageUrl = `/editor/map/${filename}`;

        this.worker = null;
        this.width = 0;
        this.height = 0;
        this.navReady = null;      // Promise resolved once navgraph ack arrives
        this._msgId = 1;
        this._pendingPairs = new Map();  // msgId → {resolve, reject, timer}
        this.buffer = [];          // validated scenes ready to serve
        this._inFlight = 0;        // outstanding generatePair requests
        this._refillScheduled = false;
        this._destroyed = false;
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

        const [binBuffer, mask] = await Promise.all([
            fetchArrayBuffer(`/editor/navgraph/${this.fileId}/`),
            decodeMaskGreyscale(`/editor/mask/${this.fileId}/`),
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
        }, [binBuffer, mask.greys.buffer]);

        const ack = await ackPromise;
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
            else this._navAck.resolve({ nodes: msg.nodes, edges: msg.edges, sampleCells: msg.sampleCells });
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
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingPairs.delete(msgId);
                reject(new Error('generatePair timeout'));
            }, PAIR_TIMEOUT_MS);
            this._pendingPairs.set(msgId, { resolve, reject, timer });
        });
        this.worker.postMessage({ type: 'generatePair', msgId, mapId: this.mapId });
        return promise.finally(() => { this._inFlight--; });
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
        const routes = (pairMsg.routes || []).map((poly, i) => ({
            index: i,
            points: (poly || []).map(toMapUnits),
            runtime: pairMsg.runtimes?.[i] ?? null,
        }));
        if (routes.length < 2 || routes.some((r) => r.points.length < 2)) return null;
        return this.buildScene({
            start,
            goal,
            routes,
            runtimes: pairMsg.runtimes || [],
            meta: pairMsg.meta || {},
            source: this,
        });
    }

    /** Pull a validated scene; awaits (buffering more) if none is ready yet. */
    async takeScene() {
        await this.ready();
        if (this.buffer.length) {
            const scene = this.buffer.shift();
            this._scheduleRefill();
            return scene;
        }
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
