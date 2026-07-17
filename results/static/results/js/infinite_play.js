import {
    MaskSceneSource,
    maskBarrierStrokeWidthMapUnits,
} from './infinite/mask_scene_source.js';
import {
    cameraRotationForEndpoints,
    orientSceneForCamera,
} from './infinite/scene_orientation.js';

/* =========================================================
   INFINITE PLAY — procedurally-generated sprint route-choice
   problem. Uses IOF-style colours, compound obstacles,
   decorative obstacles, rotated camera (start at bottom),
   and the same dot-and-trail animation as play.js.

   Records each attempt to /play/infinity/submit-choice/ →
   InfiniteChoice DB model.
========================================================= */

/* ── Coordinate system & constants ────────────────────── */

const VB_W      = 1200;
const VB_H      = 800;
const RUN_SPEED = 4.75;   // m/s reference flat-ground speed
const ALT_FLAT_EQUIV_M    = 4;
const NOA_CLUSTER_WINDOW_M       = 20;
const NOA_COUNTER_TURN_WINDOW_M  = 10;
const NOA_ARTIFACT_WINDOW_M      = 5;
const NOA_MIN_SEGMENT_M          = 1.5;
const NOA_CORNER_DEG             = 90;
const NOA_EPSILON_DEG            = 2;
const NOA_MIN_EFFECT_DEG         = 45;
const NOA_COUNTER_MIN_DEG        = 45;
const ROUTE_RUNTIME_MAX_RELATIVE_GAP = 0.40;
const ROUTE_RUNTIME_MIN_SIDE_GAP = 12;
const MAX_CHOICE_TIME = 30;  // s; cap stored choice_time for stats

let generateWards = null;
let buildRouteVisibilityGraph = null;
let computeRouteOptions = null;
let ensureRouteSides = null;
let runtimeSlotsFor = null;
let selectWeightedRoutePair = null;
let skippedBarriersForSelection = null;
let _mainThreadGeneratorModulesPromise = null;

// Main-thread fallback selection config — must mirror selectionConfig in
// infinite/infinite_batch_worker.js (the worker path used in production).
const selectionConfig = {
    strategy: 'weighted',
    maxRoutes: 5,
    primaryRouteBudgetMs: 400,
    extraRouteBudgetMs: 200,
    extremesMaxRelativeGap: 0.30,
    weighted: null,
};

const ROUTE_COLORS  = ['#DD0011', '#CC6000'];   // play.js's first two route colours
const CONTROL_COLOR = '#a033f0';                // standard orienteering pink/purple
const PLAY_CONTROL_RADIUS = 25;
const PLAY_CONTROL_STROKE_WIDTH = 3;
const PLAY_BLOCKING_STROKE_WIDTH = 5;
const PLAY_CONTROL_WAVE_STROKE_WIDTH = 14;
const REFERENCE_MAP_SCALE = 4000;
const FOUNTAIN_RADIUS = 0.5;
const CONTROL_RADIUS = FOUNTAIN_RADIUS * 5;     // diameter is 5x the fountain diameter
const CONTROL_DIAMETER_M = 25;
const MAP_METRES_PER_UNIT = CONTROL_DIAMETER_M / (CONTROL_RADIUS * 2) / 2;
const PLAY_MAP_METRES_PER_UNIT = 0.48;
const CONTROL_SIZE_RATIO = CONTROL_RADIUS / PLAY_CONTROL_RADIUS;
const CONTROL_STROKE_WIDTH = PLAY_CONTROL_STROKE_WIDTH * CONTROL_SIZE_RATIO;
const BLOCKING_STROKE_WIDTH = PLAY_BLOCKING_STROKE_WIDTH * CONTROL_SIZE_RATIO * 2;
const CONTROL_WAVE_STROKE_WIDTH = PLAY_CONTROL_WAVE_STROKE_WIDTH * CONTROL_SIZE_RATIO;
const CONTROL_OPACITY = 0.8;
const ROUTE_BACKGROUND_STROKE_WIDTH = 3;
const ROUTE_FOREGROUND_STROKE_WIDTH = 1.5;
const ROUTE_DOT_SURFACE_RADIUS = 1;
const ROUTE_HIT_WIDTH = 40;
const CITY_FIT_PAD  = 0.08;
const GAP           = 8 * CONTROL_SIZE_RATIO;
const MIN_ZOOM      = 0.2;
const MAX_ZOOM      = 16;
const CAMERA_PAD    = 20;
const PAN_CLICK_SUPPRESS_MOVE = 6;
const PAN_CLICK_SUPPRESS_MS   = 350;
const STATS_TOGGLE_SUPPRESS_MS = 250;
const ROUTE_PICK_MIN_DIST = 40;
const ROUTE_PICK_MAX_DIST = 120;
const ROUTE_PICK_OUTSIDE_WALL_MAX_DIST = 12;
const ROUTE_PICK_POINT_POOL_SIZE = 64;
const ROUTE_PICK_INTERIOR_BIAS_POWER = 3;
const ROUTE_PICK_INTERIOR_BIAS_CAP = 12;
const ROUTE_PICK_INTERIOR_BIAS_EPS = 0.25;
const CITY_ROUTE_RETRIES = 240;
const CITY_SCENE_ATTEMPTS = 12;
const CONTROL_PAIRS_PER_MAP = 5;
const CONTROL_PAIR_ENDPOINT_MIN_GAP = 15;
const CITY_SETTINGS = {
    plaza: true,
    coast: true,
    river: true,
    walls: true,
    streets: true,
    outerRatio: 4,
    roadDensity: 5,
    gates: -1,
};

// City geometry uses compact generated coordinates. Uploaded-map symbols start
// with play.js's original pixel sizes, then convert those sizes to the map's
// editor coordinate space using the saved editor scale and map denominator.
function controlRadiusForScene(sc = scene) {
    return sc?.kind === 'mask'
        ? PLAY_CONTROL_RADIUS * maskVisualScaleForScene(sc)
        : CONTROL_RADIUS;
}

function controlGapForScene(sc = scene) {
    return sc?.kind === 'mask' ? 8 * maskVisualScaleForScene(sc) : GAP;
}

function controlStrokeWidthForScene(sc = scene) {
    return sc?.kind === 'mask'
        ? PLAY_CONTROL_STROKE_WIDTH * maskVisualScaleForScene(sc)
        : CONTROL_STROKE_WIDTH;
}

function blockingStrokeWidthForScene(sc = scene) {
    return sc?.kind === 'mask'
        ? maskBarrierStrokeWidthMapUnits(sc.mapScaleDenominator, sc.editorScale)
        : BLOCKING_STROKE_WIDTH;
}

function controlWaveStrokeWidthForScene(sc = scene) {
    return sc?.kind === 'mask'
        ? PLAY_CONTROL_WAVE_STROKE_WIDTH * maskVisualScaleForScene(sc)
        : CONTROL_WAVE_STROKE_WIDTH;
}

// The normal play symbols are sized in source-map pixels at the reference
// 1:4000 scale. Uploaded-map scene coordinates are source-map pixels multiplied
// by File.scale, while the map denominator changes the physical size represented
// by one map pixel. Keep these metadata values separate from scene.mapScale,
// which is the per-scene fit transform written by maskFitTransform().
function maskVisualScaleForScene(sc = scene) {
    if (sc?.kind !== 'mask') return 1;
    const mapScale = Number(sc.mapScaleDenominator);
    const editorScale = Number(sc.editorScale);
    const mapScaleFactor = Number.isFinite(mapScale) && mapScale > 0
        ? REFERENCE_MAP_SCALE / mapScale
        : 1;
    const editorScaleFactor = Number.isFinite(editorScale) && editorScale > 0
        ? editorScale
        : 1;
    return mapScaleFactor * editorScaleFactor;
}

function routeEquivalentPlayZoom(scale = cam.scale, sc = scene) {
    const cameraScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
    const sceneScale = Number.isFinite(Number(sc?.mapScale)) && Number(sc.mapScale) > 0
        ? Number(sc.mapScale)
        : 1;
    const renderedMapZoom = sceneScale * cameraScale;

    // Uploaded-map infinity scenes already use the editor/play coordinate
    // system, including File.scale, so no metadata multiplier belongs here.
    if (sc?.kind === 'mask') return renderedMapZoom;

    // Generated-city units are physically larger than normal play map pixels.
    // Convert their rendered scale to the equivalent 1:4000 play-map pixel
    // scale before applying the same adaptive curve.
    return renderedMapZoom * (PLAY_MAP_METRES_PER_UNIT / MAP_METRES_PER_UNIT);
}

function routeStrokeWidthForZoom(baseWidth, scale = cam.scale) {
    return RouteStrokeScale.attributeWidth(
        baseWidth,
        routeEquivalentPlayZoom(scale),
        cssCameraDeltaScale(scale),
    );
}

function setAdaptiveRouteStroke(el, baseWidth) {
    el.dataset.routeBaseStroke = String(baseWidth);
    el.setAttribute('stroke-width', routeStrokeWidthForZoom(baseWidth));
}

function updateRouteStrokeWidths() {
    document.querySelectorAll('#rp-route-layer [data-route-base-stroke]').forEach(el => {
        const baseWidth = parseFloat(el.dataset.routeBaseStroke);
        if (isFinite(baseWidth)) el.setAttribute('stroke-width', routeStrokeWidthForZoom(baseWidth));
    });
}

// IOF/OCAD-like sprint palette, sampled from the reference SVG exports.
const IOF = {
    open_yellow:   'rgb(255,204,54)',
    open_orange:   'rgb(255,194,54)',
    paved:         'rgb(205,205,205)',
    paved_dark:    'rgb(128,128,128)',
    forest_run:    'rgb(255,255,255)',
    veg_light:     'rgb(138,255,115)',
    veg_medium:    'rgb(74,255,23)',
    veg_slow:      'rgb(61,255,23)',
    veg_olive:     'rgb(158,186,0)',
    building:      'rgb(0,0,0)',
    pond:          'rgb(0,128,255)',
    pond_border:   'rgb(0,96,220)',
    stone_wall:    'rgb(0,0,0)',
    fence:         'rgb(0,0,0)',
    cliff:         'rgb(0,0,0)',
    contour:       'rgb(191,128,64)',
    uncrossable:   'rgb(102,102,102)',
    private_garden:'rgb(158,186,0)',
};

const NS    = 'http://www.w3.org/2000/svg';
const svgEl = (tag) => document.createElementNS(NS, tag);
const SVG   = (id)  => document.getElementById(id);

function cloneCameraState(state) {
    return { x: state.x, y: state.y, scale: state.scale, rot: state.rot };
}

function cameraMatrix(state) {
    const scale = Number.isFinite(state.scale) ? state.scale : 1;
    const rad = (Number.isFinite(state.rot) ? state.rot : 0) * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        a: cos * scale,
        b: sin * scale,
        c: -sin * scale,
        d: cos * scale,
        e: Number.isFinite(state.x) ? state.x : 0,
        f: Number.isFinite(state.y) ? state.y : 0,
    };
}

function multiplyMatrix(m1, m2) {
    return {
        a: m1.a * m2.a + m1.c * m2.b,
        b: m1.b * m2.a + m1.d * m2.b,
        c: m1.a * m2.c + m1.c * m2.d,
        d: m1.b * m2.c + m1.d * m2.d,
        e: m1.a * m2.e + m1.c * m2.f + m1.e,
        f: m1.b * m2.e + m1.d * m2.f + m1.f,
    };
}

function invertMatrix(m) {
    const det = m.a * m.d - m.b * m.c;
    if (Math.abs(det) < 1e-12) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return {
        a: m.d / det,
        b: -m.b / det,
        c: -m.c / det,
        d: m.a / det,
        e: (m.c * m.f - m.d * m.e) / det,
        f: (m.b * m.e - m.a * m.f) / det,
    };
}

function matrixString(m) {
    return `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
}

function cssCameraDeltaMatrix() {
    return multiplyMatrix(cameraMatrix(cam), invertMatrix(cameraMatrix(committedCam)));
}

function cssCameraDeltaScale(scale = cam.scale) {
    const committedScale = Math.max(Math.abs(committedCam.scale || 1), 1e-6);
    const currentScale = Math.max(Math.abs(scale || 1), 1e-6);
    return currentScale / committedScale;
}

/* ── State ────────────────────────────────────────────── */

let scene       = null;
let phase       = 'transition';   // 'transition' | 'choose' | 'reveal'
let choiceStartTime = null;
let lastChoiceTimes = null;
let statsVisible = false;
let cam = { x: 0, y: 0, scale: 1, rot: 0 };
let committedCam = { x: 0, y: 0, scale: 1, rot: 0 };
let camBounds = null;
let applyTransform = () => {};
let suppressMapClickUntil = 0;
let suppressStatsToggleUntil = 0;
let currentBatch = null;
let preparedBatch = null;
let preparingBatch = false;
let prepareTimer = null;
let _batchWorker = null;
let _batchWorkerMsgId = 1;
let _pendingBatchPromise = null;
let _streamingBatch = null;
let _prerenderTimer = null;
let _renderTarget = null;
let _cameraCommitTimer = null;
let reportingRoute = false;
let confirmingRouteReport = false;
let _routeAnim  = null;
let _camAnim    = null;
let stats       = loadStats();

/* ── Scene source (city vs mask) ──────────────────────────
   City mode is the default and leaves the existing code path fully intact.
   Mask mode (WP 3.3) draws problems from a real uploaded map's server-built
   navgraph via the pathing worker (see infinite/mask_scene_source.js). It is
   selected at play start with /play/<file_id>/infinity/. */
let sceneSource = 'city';           // 'city' | 'mask'
let maskSource  = null;             // MaskSceneSource instance (mask mode)
let maskSourceReady = null;         // Promise, resolves once navgraph is loaded
let suppressPlay = false;           // true while the map picker is open

function detectSceneSource() {
    try {
        const playWrap = document.getElementById('play-wrap');
        const routeFileId = playWrap?.dataset.infinityFileId;
        const routeFilename = playWrap?.dataset.infinityFilename || '';
        const routeMapScale = Number(playWrap?.dataset.infinityMapScale) || 4000;
        if (routeFileId) {
            sceneSource = 'mask';
            maskSource = new MaskSceneSource({
                fileId: routeFileId,
                filename: routeFilename,
                mapScale: routeMapScale,
                editorScale: Number(playWrap?.dataset.infinityEditorScale) || 1,
                buildScene: buildMaskScene,
            });
            maskSourceReady = maskSource.ready().catch(handleMaskSourceError);
            return;
        }
        const params = new URLSearchParams(window.location.search);
        if (params.get('source') !== 'mask') return;
        const fileId = params.get('file');
        const filename = params.get('filename') || '';
        const mapScale = Number(params.get('map_scale')) || 4000;
        const editorScale = Number(params.get('scale')) || 1;
        if (!fileId) {
            // ?source=mask without a chosen map → show the (temporary) picker.
            showMaskMapPicker();
            return;
        }
        sceneSource = 'mask';
        maskSource = new MaskSceneSource({
            fileId,
            filename,
            mapScale,
            editorScale,
            buildScene: buildMaskScene,
        });
        // Kick off the (async) navgraph + mask load right away so the buffer is
        // warm by the time the first scene is requested.
        maskSourceReady = maskSource.ready().catch(handleMaskSourceError);
    } catch (err) {
        console.warn('failed to detect scene source:', err);
    }
}

function handleMaskSourceError(err) {
    console.error('mask scene source failed to initialise; falling back to city:', err);
    const failedSource = maskSource;
    sceneSource = 'city';
    maskSource = null;
    failedSource?.destroy();
    return null;
}

// Map picker for mask-mode infinite play. Lists maps a coach has opted in to
// infinite play (File.infinite_enabled, set from the editor region panel —
// see WP 4.2) that also have a built .navgraph.bin artifact, via
// /play/infinity/mask-maps/ (results/play_views.py: infinite_mask_maps).
function showMaskMapPicker() {
    suppressPlay = true;
    hideMapSpinner();

    const hasGettext = typeof gettext === 'function';
    const chooseMapLabel = hasGettext ? gettext('Choose a map') : 'Choose a map';
    const loadingLabel = hasGettext ? gettext('Loading maps…') : 'Loading maps…';
    const emptyLabel = hasGettext
        ? gettext('No maps are enabled for infinite play yet.')
        : 'No maps are enabled for infinite play yet.';
    const errorLabel = hasGettext ? gettext('Error loading data') : 'Error loading data';

    const overlay = document.createElement('div');
    overlay.id = 'rp-mask-picker';
    overlay.className = 'rp-modal open';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'rp-modal-card';

    const title = document.createElement('h2');
    title.textContent = chooseMapLabel;
    card.appendChild(title);

    const status = document.createElement('p');
    status.textContent = loadingLabel;
    card.appendChild(status);

    const list = document.createElement('div');
    list.className = 'rp-mask-picker-list';
    card.appendChild(list);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    fetch('/play/infinity/mask-maps/', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        .then((data) => {
            const maps = data?.maps || [];
            if (!maps.length) {
                status.textContent = emptyLabel;
                return;
            }
            status.remove();
            for (const m of maps) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'rp-modal-btn rp-modal-btn-primary';
                btn.textContent = m.name || m.filename;
                btn.addEventListener('click', () => {
                    window.location.href = `/play/${m.id}/infinity/`;
                });
                list.appendChild(btn);
            }
        })
        .catch((err) => {
            status.textContent = `${errorLabel}: ${err.message || err}`;
        });
}

document.addEventListener('DOMContentLoaded', () => {
    SVG('rp-svg').setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
    SVG('rp-svg').setAttribute('preserveAspectRatio', 'none');
    document.body.classList.add('has-prior-results'); // grey progress bar (visual hint: no project)
    initCamera();
    detectSceneSource();
    showMapSpinner();
    requestAnimationFrame(() => requestAnimationFrame(next));
    initInput();
    initStatsPanel();
    initReportButton();
    renderHud();
    refreshInfiniteUserStats();
});

function initInput() {
    const container = SVG('map-container');

    document.addEventListener('keydown', e => {
        if (phase === 'choose') {
            if (e.key === 'ArrowLeft')  { e.preventDefault(); pickSide(0); }
            if (e.key === 'ArrowRight') { e.preventDefault(); pickSide(1); }
            return;
        }
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            tryAdvance();
        }
    });

    // Match normal play mode: a single map click does not advance. A deliberate
    // double-click / double-tap on the map advances after a choice is made.
    let lastAdvanceClick = 0;
    const DBL_WINDOW_MS = 400;
    container.addEventListener('click', () => {
        if (performance.now() < suppressMapClickUntil) return;
        if (phase !== 'reveal') { lastAdvanceClick = 0; return; }
        const now = performance.now();
        if (now - lastAdvanceClick < DBL_WINDOW_MS) {
            lastAdvanceClick = 0;
            tryAdvance();
        } else {
            lastAdvanceClick = now;
        }
    });

    // Match normal mobile play mode: a right-to-left swipe advances.
    let swipeStartX = null;
    let swipeStartY = null;
    const SWIPE_MIN_X = 60;
    const SWIPE_MAX_Y = 40;

    container.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) { swipeStartX = null; return; }
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
    }, { passive: true });

    container.addEventListener('touchend', e => {
        if (swipeStartX === null || !e.changedTouches.length) return;
        const dx = e.changedTouches[0].clientX - swipeStartX;
        const dy = e.changedTouches[0].clientY - swipeStartY;
        swipeStartX = null;
        if (dx < -SWIPE_MIN_X && Math.abs(dy) < SWIPE_MAX_Y) {
            tryAdvance();
        }
    }, { passive: true });
}

function tryAdvance() {
    if (phase !== 'reveal') return false;
    next();
    return true;
}

function selectVisibleRouteFromMap(routeIdx) {
    if (phase !== 'choose') return;
    pickSide(routeIdx);
}

function routeChoiceSuppressedByPan() {
    return performance.now() < suppressMapClickUntil;
}

function routesAtPoint(clientX, clientY) {
    const idxs = new Set();
    document.elementsFromPoint(clientX, clientY).forEach(el => {
        const idx = el.dataset?.routeIdx;
        if (idx !== undefined) idxs.add(idx);
    });
    return idxs;
}

function addRouteHitArea(layer, route, routeIdx) {
    const hit = createRoutePolyline(route, {
        stroke: 'transparent',
        strokeWidth: ROUTE_HIT_WIDTH,
        interactive: true,
    });
    if (!hit) return;
    hit.dataset.routeIdx = routeIdx;
    // Keep the hidden hit area from exposing route positions via cursor changes.
    hit.style.cursor = 'inherit';
    hit.addEventListener('click', e => {
        e.stopPropagation();
        if (routeChoiceSuppressedByPan()) return;
        if (routesAtPoint(e.clientX, e.clientY).size !== 1) return;
        selectVisibleRouteFromMap(routeIdx);
    });
    layer.appendChild(hit);
}

function suppressMapClickForPan() {
    suppressMapClickUntil = performance.now() + PAN_CLICK_SUPPRESS_MS;
}

function clampCam() {
    if (!camBounds) return;
    const container = SVG('map-container');
    const cw = container.clientWidth;
    const ch = container.clientHeight;

    cam.scale = Math.min(Math.max(cam.scale, camBounds.minScale), MAX_ZOOM);
    const s = cam.scale;

    const xHi = -camBounds.minRX * s;
    const xLo =  cw - camBounds.maxRX * s;
    cam.x = (xLo > xHi) ? (xLo + xHi) / 2 : Math.min(xHi, Math.max(xLo, cam.x));

    const yHi = -camBounds.minRY * s;
    const yLo =  ch - camBounds.maxRY * s;
    cam.y = (yLo > yHi) ? (yLo + yHi) / 2 : Math.min(yHi, Math.max(yLo, cam.y));
}

function initCamera() {
    const container = SVG('map-container');
    const camera = SVG('camera');
    let drag = null;
    let lastPinchDist = null;
    commitCameraTransform();

    applyTransform = () => {
        if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.scale) || !isFinite(cam.rot)) return;
        camera.style.transform = matrixString(cssCameraDeltaMatrix());
        updateRouteStrokeWidths();
    };

    container.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        drag = {
            startX: e.clientX - cam.x,
            startY: e.clientY - cam.y,
            downX: e.clientX,
            downY: e.clientY,
            moved: false,
        };
        container.classList.add('panning');
    });

    window.addEventListener('mousemove', e => {
        if (!drag) return;
        if (Math.abs(e.clientX - drag.downX) > PAN_CLICK_SUPPRESS_MOVE ||
            Math.abs(e.clientY - drag.downY) > PAN_CLICK_SUPPRESS_MOVE) {
            drag.moved = true;
        }
        cam.x = e.clientX - drag.startX;
        cam.y = e.clientY - drag.startY;
        clampCam();
        applyTransform();
    });

    window.addEventListener('mouseup', () => {
        if (drag?.moved) suppressMapClickForPan();
        if (drag?.moved) scheduleCameraCommit();
        drag = null;
        container.classList.remove('panning');
    });

    container.addEventListener('wheel', e => {
        e.preventDefault();
        const rawFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.scale * rawFactor));
        const factor = newScale / cam.scale;
        const rect = container.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        cam.x = mx - (mx - cam.x) * factor;
        cam.y = my - (my - cam.y) * factor;
        cam.scale = newScale;
        clampCam();
        applyTransform();
        scheduleCameraCommit();
    }, { passive: false });

    container.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
            drag = {
                startX: e.touches[0].clientX - cam.x,
                startY: e.touches[0].clientY - cam.y,
                downX: e.touches[0].clientX,
                downY: e.touches[0].clientY,
                moved: false,
            };
            lastPinchDist = null;
        } else if (e.touches.length === 2) {
            drag = null;
            lastPinchDist = pinchDist(e.touches);
            suppressMapClickForPan();
        }
    }, { passive: true });

    container.addEventListener('touchmove', e => {
        e.preventDefault();
        if (e.touches.length === 1 && drag) {
            if (Math.abs(e.touches[0].clientX - drag.downX) > PAN_CLICK_SUPPRESS_MOVE ||
                Math.abs(e.touches[0].clientY - drag.downY) > PAN_CLICK_SUPPRESS_MOVE) {
                drag.moved = true;
            }
            cam.x = e.touches[0].clientX - drag.startX;
            cam.y = e.touches[0].clientY - drag.startY;
        } else if (e.touches.length === 2 && lastPinchDist !== null) {
            suppressMapClickForPan();
            const dist = pinchDist(e.touches);
            const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.scale * dist / lastPinchDist));
            const factor = newScale / cam.scale;
            const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const rect = container.getBoundingClientRect();
            const cx = mx - rect.left;
            const cy = my - rect.top;
            cam.x = cx - (cx - cam.x) * factor;
            cam.y = cy - (cy - cam.y) * factor;
            cam.scale = newScale;
            lastPinchDist = dist;
        }
        clampCam();
        applyTransform();
    }, { passive: false });

    container.addEventListener('touchend', e => {
        if (e.touches.length < 2) lastPinchDist = null;
        if (e.touches.length === 0) {
            if (drag?.moved) suppressMapClickForPan();
            scheduleCameraCommit();
            drag = null;
            container.classList.remove('panning');
        }
    }, { passive: true });
}

function scheduleCameraCommit(delay = 100) {
    if (_cameraCommitTimer) window.clearTimeout(_cameraCommitTimer);
    _cameraCommitTimer = window.setTimeout(() => {
        _cameraCommitTimer = null;
        commitCameraTransform();
    }, delay);
}

function commitCameraTransform() {
    if (_cameraCommitTimer) {
        window.clearTimeout(_cameraCommitTimer);
        _cameraCommitTimer = null;
    }
    if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.scale) || !isFinite(cam.rot)) return;
    committedCam = cloneCameraState(cam);
    const cameraLayer = SVG('rp-camera-layer');
    if (cameraLayer) cameraLayer.setAttribute('transform', matrixString(cameraMatrix(committedCam)));
    const camera = SVG('camera');
    if (camera) camera.style.transform = 'none';
    updateRouteStrokeWidths();
}

function pinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
}

/* =========================================================
   MAP SPINNER
========================================================= */

function showMapSpinner() {
    hideMapSpinner();

    const container = SVG('map-container');
    if (!container) return;

    const overlay = document.createElementNS(NS, 'svg');
    overlay.id = 'rp-spinner-overlay';
    if (!scene) overlay.classList.add('rp-first-map-loading');
    overlay.setAttribute('overflow', 'visible');
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '5';

    const spinner = document.createElementNS(NS, 'g');
    spinner.id = 'map-spinner';

    const radii  = [64, 84, 104];
    const speeds = [1, 0.65, 0.38];
    const colors = ['#444', '#666', '#999'];
    const arcs   = [];

    const rect = container.getBoundingClientRect();
    const cx   = rect.width / 2;
    const cy   = rect.height / 2;

    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x',      -radii[2] - 12);
    bg.setAttribute('y',      -radii[2] - 12);
    bg.setAttribute('width',   2 * radii[2] + 24);
    bg.setAttribute('height',  2 * radii[2] + 24);
    bg.setAttribute('rx',      radii[2] + 10);
    bg.setAttribute('fill',   '#2a2a2a');
    spinner.appendChild(bg);

    radii.forEach((r, i) => {
        const circle = document.createElementNS(NS, 'circle');
        circle.setAttribute('cx', 0);
        circle.setAttribute('cy', 0);
        circle.setAttribute('r', r);
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', colors[i]);
        circle.setAttribute('stroke-width', '5');
        circle.setAttribute('stroke-linecap', 'round');
        circle.setAttribute('vector-effect', 'non-scaling-stroke');
        const circ = 2 * Math.PI * r;
        circle.setAttribute('stroke-dasharray', `${circ * 0.35} ${circ * 0.65}`);
        arcs.push({ el: circle, speed: speeds[i], offset: i * 0.8 });
        spinner.appendChild(circle);
    });

    spinner.setAttribute('transform', `translate(${cx}, ${cy})`);
    overlay.appendChild(spinner);
    container.appendChild(overlay);

    let start = null;
    function animate(ts) {
        if (!start) start = ts;
        const elapsed = (ts - start) / 1000;
        arcs.forEach(arc => {
            arc.el.setAttribute(
                'transform',
                `rotate(${(elapsed * arc.speed * 360 + arc.offset * 60) % 360})`
            );
        });
        if (document.getElementById('map-spinner')) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}

function hideMapSpinner() {
    document.getElementById('rp-spinner-overlay')?.remove();
}

/* =========================================================
   PROCEDURAL GENERATION
========================================================= */

async function next() {
    if (suppressPlay) return;   // map picker open — do not start play
    phase = 'transition';
    if (_routeAnim) { cancelAnimationFrame(_routeAnim); _routeAnim = null; }
    if (_camAnim) { cancelAnimationFrame(_camAnim); _camAnim = null; }
    hideStatsPanel();
    lastChoiceTimes = null;
    suppressStatsToggleUntil = 0;
    camBounds = null;
    updateReportButton();
    const ct = SVG('rp-choice-time');
    if (ct) ct.textContent = '';
    const bar = SVG('play-btn-bar');
    if (bar) bar.innerHTML = '';
    showMapSpinner();
    try {
        scene = await takeNextScene();
        // Reversing either kind of Infinity problem preserves its geometry and
        // route choice, but can avoid an unnecessary half-turn from the
        // previous camera heading. Only reverse when that direction is closer.
        orientSceneForCamera(scene, cam.rot);
    } catch (err) {
        console.error('failed to load infinite map:', err);
        window.setTimeout(next, 500);
        return;
    }
    hideMapSpinner();
    renderScene({
        cameraDuration: 1000,
        onCameraReady: beginChoice,
    });
    scheduleUpcomingScenePrerender();
    scheduleBatchPreparation();
}

function beginChoice() {
    if (!scene) return;
    phase = 'choose';
    renderChoiceButtons();
    updateReportButton();
    choiceStartTime = performance.now();
    // Clear the centre choice-time slot — fresh problem, no time to show yet
    const ct = SVG('rp-choice-time');
    if (ct) ct.textContent = '';
}

async function takeNextScene() {
    if (sceneSource === 'mask' && maskSource) {
        // Mask mode: the MaskSceneSource keeps five future validated pairs
        // prefetched in its Web Worker and returns a buffered scene immediately,
        // awaiting only if the buffer is momentarily starved (normally first load).
        if (maskSourceReady) { await maskSourceReady; maskSourceReady = null; }
        if (sceneSource === 'mask' && maskSource) {
            return maskSource.takeScene();
        }
        // else: init failed and fell back to city — drop through.
    }
    if (currentBatch && currentBatch.index >= currentBatch.scenes.length && currentBatch.donePromise && !currentBatch.done) {
        try {
            await currentBatch.donePromise;
        } catch (err) {
            console.warn('current infinite batch did not finish streaming:', err);
        }
    }
    if (!currentBatch || currentBatch.index >= currentBatch.scenes.length) {
        currentBatch = preparedBatch || await generateSceneBatchAsync();
        preparedBatch = null;
        currentBatch.index = 0;
    }
    const sceneForPair = currentBatch.scenes[currentBatch.index];
    sceneForPair.batch = currentBatch;
    sceneForPair.batchIndex = currentBatch.index;
    currentBatch.index++;
    return sceneForPair;
}

function scheduleBatchPreparation() {
    // Mask mode manages its own prefetch buffer inside MaskSceneSource.
    if (sceneSource === 'mask') return;
    if (preparedBatch || preparingBatch || prepareTimer) return;
    if (currentBatch?.donePromise && !currentBatch.done) {
        currentBatch.donePromise.finally(() => window.setTimeout(scheduleBatchPreparation, 0));
        return;
    }

    const run = async () => {
        prepareTimer = null;
        if (preparedBatch || preparingBatch) return;
        preparingBatch = true;
        try {
            const batch = await generateSceneBatchAsync();
            if (batch !== currentBatch) preparedBatch = batch;
            scheduleScenePrerender(preparedBatch?.scenes?.[0]);
        } catch (err) {
            console.warn('failed to prepare next infinite map:', err);
        } finally {
            preparingBatch = false;
            if (!preparedBatch) window.setTimeout(scheduleBatchPreparation, 500);
        }
    };

    if ('requestIdleCallback' in window) {
        prepareTimer = window.requestIdleCallback(run, { timeout: 1000 });
    } else {
        prepareTimer = window.setTimeout(run, 80);
    }
}

function ensureBatchWorker() {
    if (_batchWorker) return _batchWorker;
    if (!window.Worker) return null;
    try {
        _batchWorker = new Worker(new URL('./infinite/infinite_batch_worker.js', import.meta.url), { type: 'module' });
        _batchWorker.addEventListener('error', (event) => {
            console.warn('infinite batch worker error:', event.message || event);
            try { _batchWorker?.terminate(); } catch (_) {}
            _batchWorker = null;
        });
        return _batchWorker;
    } catch (err) {
        console.warn('infinite batch worker unavailable:', err);
        _batchWorker = null;
        return null;
    }
}

function ensureMainThreadGeneratorModules() {
    if (_mainThreadGeneratorModulesPromise) return _mainThreadGeneratorModulesPromise;
    _mainThreadGeneratorModulesPromise = Promise.all([
        import('./infinite/citygen/core/CityGen.js'),
        import('./infinite/citygen/core/RoutePlanner.js'),
        import('./infinite/route_pair_selection.js'),
    ]).then(([cityGen, routePlanner, routeSelection]) => {
        generateWards = cityGen.generateWards;
        buildRouteVisibilityGraph = routePlanner.buildRouteVisibilityGraph;
        computeRouteOptions = routePlanner.computeRouteOptions;
        ensureRouteSides = routeSelection.ensureRouteSides;
        runtimeSlotsFor = routeSelection.routeSlotsFor;
        selectWeightedRoutePair = routeSelection.selectWeightedRoutePair;
        skippedBarriersForSelection = routeSelection.skippedBarriersForSelection;
        selectionConfig.weighted = { ...routeSelection.DEFAULT_ROUTE_PAIR_SELECTION };
    }).catch((err) => {
        _mainThreadGeneratorModulesPromise = null;
        throw err;
    });
    return _mainThreadGeneratorModulesPromise;
}

async function generateSceneBatchFallback(pairCount = CONTROL_PAIRS_PER_MAP) {
    await ensureMainThreadGeneratorModules();
    return generateSceneBatch(pairCount);
}

function generateSceneBatchAsync(pairCount = CONTROL_PAIRS_PER_MAP) {
    if (_pendingBatchPromise) return _pendingBatchPromise;
    const worker = ensureBatchWorker();
    if (!worker) return generateSceneBatchFallback(pairCount);

    const msgId = _batchWorkerMsgId++;
    let streamedBatch = null;
    let resolveDone = null;
    let rejectDone = null;
    const donePromise = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });
    donePromise.catch(() => {});
    const finishBatch = (batch, batchMeta = null) => {
        if (!streamedBatch) {
            streamedBatch = batch || {
                kind: 'city-batch',
                city: null,
                scenes: [],
                index: 0,
                meta: batchMeta || {},
            };
            streamedBatch.donePromise = donePromise;
            streamedBatch.done = false;
        }
        if (batch) {
            streamedBatch.city = batch.city;
            streamedBatch.meta = batch.meta || streamedBatch.meta;
            streamedBatch.scenes = batch.scenes || streamedBatch.scenes;
            streamedBatch.index = streamedBatch.index || 0;
        } else if (batchMeta) {
            streamedBatch.meta = batchMeta;
        }
        for (let i = 0; i < streamedBatch.scenes.length; i++) {
            streamedBatch.scenes[i].batch = streamedBatch;
            streamedBatch.scenes[i].batchIndex = i;
        }
        return streamedBatch;
    };
    _pendingBatchPromise = new Promise((resolve, reject) => {
        let resolvedFirstScene = false;
        const cleanup = () => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onWorkerError);
            worker.removeEventListener('messageerror', onMessageError);
            _pendingBatchPromise = null;
            if (_streamingBatch === streamedBatch) _streamingBatch = null;
        };
        const onMessage = (event) => {
            const msg = event.data;
            if (!msg || msg.msgId !== msgId) return;
            if (msg.error) {
                const err = new Error(msg.error);
                cleanup();
                rejectDone(err);
                reject(err);
                return;
            }
            if (msg.type === 'scene') {
                const batch = finishBatch(null, msg.batchMeta);
                if (!batch.city && msg.scene?.city) batch.city = msg.scene.city;
                const sceneFromWorker = msg.scene;
                sceneFromWorker.batch = batch;
                sceneFromWorker.batchIndex = msg.index;
                batch.scenes[msg.index] = sceneFromWorker;
                _streamingBatch = batch;
                if (!resolvedFirstScene && msg.index === 0) {
                    resolvedFirstScene = true;
                    resolve(batch);
                }
                return;
            }
            if (msg.type === 'batch_done') {
                const batch = finishBatch(msg.batch);
                batch.done = true;
                cleanup();
                resolveDone(batch);
                if (!resolvedFirstScene) {
                    resolvedFirstScene = true;
                    resolve(batch);
                }
                return;
            }
            if (msg.type === 'batch') {
                const batch = finishBatch(msg.batch);
                batch.done = true;
                cleanup();
                resolveDone(batch);
                resolve(batch);
                return;
            }
        };
        const onMessageError = () => {
            const err = new Error('batch worker message error');
            cleanup();
            rejectDone(err);
            reject(err);
        };
        const onWorkerError = (event) => {
            const err = new Error(event.message || 'batch worker error');
            cleanup();
            rejectDone(err);
            reject(err);
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onWorkerError);
        worker.addEventListener('messageerror', onMessageError);
        worker.postMessage({ type: 'generateBatch', msgId, pairCount, stream: true });
    }).catch((err) => {
        console.warn('falling back to main-thread infinite generation:', err);
        try { _batchWorker?.terminate(); } catch (_) {}
        _batchWorker = null;
        _streamingBatch = null;
        return generateSceneBatchFallback(pairCount);
    });
    return _pendingBatchPromise;
}

function generateExperimentalScene() {
    let best = null;
    let bestDiff = -1;
    for (let i = 0; i < 8; i++) {
        const candidate = buildExperimentalSceneCandidate();
        const diff = Math.abs(candidate.routes[0].time - candidate.routes[1].time);
        if (diff > bestDiff) {
            best = candidate;
            bestDiff = diff;
        }
        if (diff >= 0.45) return candidate;
    }
    return best;
}

function buildExperimentalSceneCandidate() {
    // 1. Build a compound "primary" obstacle (1–3 connected shapes)
    const primary = generatePrimaryCompound();
    const cluster = generateBlockingCluster(primary.hull);
    primary.shapes = [...primary.shapes, ...cluster];
    primary.hull = convexHull(primary.shapes.flatMap(s => s.hull || []));

    // 2. Place start + ziel on opposite sides of the primary obstacle's hull
    let { start, ziel } = placeEndpoints(primary.hull);

    // 3. Compute the two routes around the primary hull
    let routes = tangentRoutes(start, ziel, primary.hull);

    // 4. Add decorative obstacles + map "texture" tiles that don't intersect routes
    const decor = generateDecoration(primary.hull, [routes[0].points, routes[1].points], start, ziel);

    // 5. Bake a rotation + translation into every coordinate so that start
    //    ends up at the bottom of the viewbox and ziel at the top. This way
    //    the SVG always renders upright without a runtime <g transform>.
    const angle = Math.atan2(ziel.y - start.y, ziel.x - start.x);
    const rot   = -Math.PI / 2 - angle;
    const mid   = { x: (start.x + ziel.x) / 2, y: (start.y + ziel.y) / 2 };
    const dst   = { x: VB_W / 2, y: VB_H / 2 };

    const transform = p => {
        const dx = p.x - mid.x, dy = p.y - mid.y;
        const ca = Math.cos(rot), sa = Math.sin(rot);
        return { x: dst.x + dx * ca - dy * sa, y: dst.y + dx * sa + dy * ca };
    };

    const start2 = transform(start);
    const ziel2  = transform(ziel);

    const primary2 = applyTransformToCompound(primary, transform);

    // Re-compute routes against the transformed hull so the route points
    // reference the new vertices (so the post-pick animation lines up)
    const routes2 = tangentRoutes(start2, ziel2, primary2.hull);

    const decor2 = decor.map(d => applyTransformToDecor(d, transform));

    return { primary: primary2, decor: decor2, start: start2, ziel: ziel2, routes: routes2 };
}

function applyTransformToCompound(primary, T) {
    const shapes = primary.shapes.map(s => applyTransformToShape(s, T));
    return { composition: primary.composition, shapes, hull: shapes.flatMap(s => s.hull) };
}

function applyTransformToShape(s, T) {
    const out = { ...s };
    if (s.polygon)  out.polygon  = s.polygon.map(T);
    if (s.polyline) out.polyline = s.polyline.map(T);
    if (s.hull)     out.hull     = s.hull.map(T);
    if (s.a)        out.a        = T(s.a);
    if (s.b)        out.b        = T(s.b);
    if (s.cx !== undefined && s.cy !== undefined) {
        const c = T({ x: s.cx, y: s.cy });
        out.cx = c.x; out.cy = c.y;
    }
    // For a wall, we need to recompute hull after a,b transform — but the
    // hull we have is already in world coords pre-transform, and we did
    // map it above. That's correct.
    return out;
}

function applyTransformToDecor(d, T) {
    if (d.kind === 'tile') {
        // Re-derive corners, transform them, then convert back to bb + rot
        // (drawing path uses x/y/w/h/rot of the original; simpler to just
        // transform all four corners and store them as a polygon override)
        const corners = [
            { x: d.x, y: d.y }, { x: d.x + d.w, y: d.y },
            { x: d.x + d.w, y: d.y + d.h }, { x: d.x, y: d.y + d.h },
        ].map(T);
        return { kind: 'tile_polygon', polygon: corners, color: d.color };
    }
    return applyTransformToShape(d, T);
}

/* ── Compound primary obstacle ────────────────────────── */

function generatePrimaryCompound() {
    const composition = pickWeighted([
        ['L_building',         5],
        ['T_building',         3],
        ['U_courtyard',        3],
        ['building_with_wing', 4],
        ['building_plus_wall', 4],
        ['building_plus_pond', 2],
        ['building_row',       3],
        ['pond_with_island',   1],
        ['fence_corridor',     3],
        ['hedge_bend',         2],
        ['cliff_arc',          2],
    ]);
    const cx = rand(VB_W * 0.35, VB_W * 0.65);
    const cy = rand(VB_H * 0.35, VB_H * 0.65);
    const baseAngle = rand(0, Math.PI * 2);

    let shapes = [];
    switch (composition) {
        case 'L_building': {
            const w = rand(180, 280), h = rand(120, 180);
            const armW = w * rand(0.40, 0.55), armH = rand(80, 140);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            // L-arm extending downward from one end
            const off = rotate({ x: w/2 - armW/2, y: -h/2 - armH/2 }, baseAngle);
            const b = rectAt(cx + off.x, cy + off.y, armW, armH, baseAngle, IOF.building, 'building');
            shapes = [a, b];
            break;
        }
        case 'T_building': {
            const w = rand(220, 320), h = rand(100, 140);
            const armW = rand(80, 130), armH = rand(150, 220);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            const off = rotate({ x: 0, y: (h + armH) / 2 - 4 }, baseAngle);
            const b = rectAt(cx + off.x, cy + off.y, armW, armH, baseAngle, IOF.building, 'building');
            shapes = [a, b];
            break;
        }
        case 'U_courtyard': {
            // Three rectangles forming a U with an open courtyard in the middle
            const w = rand(240, 320), h = rand(50, 90);   // base bar
            const armW = rand(50, 80), armH = rand(140, 200);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            const dxL = -(w - armW) / 2, dyL = -(h + armH) / 2 + 4;
            const oL  = rotate({ x: dxL, y: dyL }, baseAngle);
            const oR  = rotate({ x: -dxL, y: dyL }, baseAngle);
            shapes = [
                a,
                rectAt(cx + oL.x, cy + oL.y, armW, armH, baseAngle, IOF.building, 'building'),
                rectAt(cx + oR.x, cy + oR.y, armW, armH, baseAngle, IOF.building, 'building'),
            ];
            break;
        }
        case 'building_with_wing': {
            const w = rand(170, 240), h = rand(120, 180);
            const wing = rand(70, 120);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            const off = rotate({ x: w/2 + wing/2 - 2, y: rand(-h/4, h/4) }, baseAngle);
            const b = rectAt(cx + off.x, cy + off.y, wing, wing * rand(0.6, 0.9), baseAngle, IOF.building, 'building');
            shapes = [a, b];
            break;
        }
        case 'building_plus_wall': {
            const w = rand(160, 240), h = rand(110, 170);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            // Stone wall extending from the building edge
            const wallLen = rand(140, 220);
            const startEdge = rotate({ x: w/2, y: rand(-h/3, h/3) }, baseAngle);
            const wallAngle = baseAngle + rand(-0.6, 0.6);
            const wallEnd  = {
                x: cx + startEdge.x + Math.cos(wallAngle) * wallLen,
                y: cy + startEdge.y + Math.sin(wallAngle) * wallLen,
            };
            shapes = [a, wallShape({ x: cx + startEdge.x, y: cy + startEdge.y }, wallEnd, IOF.stone_wall, 8)];
            break;
        }
        case 'building_plus_pond': {
            const w = rand(160, 220), h = rand(120, 170);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            const off = rotate({ x: -(w/2 + rand(60, 90)), y: rand(-h/2, h/2) }, baseAngle);
            shapes = [a, blobShape(cx + off.x, cy + off.y, rand(55, 95), IOF.pond, IOF.pond_border, 'pond')];
            break;
        }
        case 'building_row': {
            // 2-3 small buildings in a row, narrow alleys between them
            const count = randInt(2, 3);
            const bw = rand(70, 110), bh = rand(70, 120);
            const gap = rand(8, 20);
            const total = count * bw + (count - 1) * gap;
            for (let i = 0; i < count; i++) {
                const dx = -total / 2 + bw / 2 + i * (bw + gap);
                const off = rotate({ x: dx, y: 0 }, baseAngle);
                shapes.push(rectAt(cx + off.x, cy + off.y, bw, bh, baseAngle, IOF.building, 'building'));
            }
            break;
        }
        case 'pond_with_island': {
            const r = rand(120, 170);
            shapes = [blobShape(cx, cy, r, IOF.pond, IOF.pond_border, 'pond')];
            // Tiny "island" (decorative — sits on top of the pond)
            const off = rotate({ x: rand(-r * 0.3, r * 0.3), y: rand(-r * 0.3, r * 0.3) }, 0);
            shapes.push(rectAt(cx + off.x, cy + off.y, rand(30, 50), rand(25, 45), baseAngle, IOF.building, 'building'));
            break;
        }
        case 'fence_corridor': {
            // Two parallel fences forming an impassable corridor
            const len = rand(220, 320);
            const gap = rand(50, 90);
            const angle = baseAngle;
            const nx = -Math.sin(angle), ny = Math.cos(angle);
            const dx = Math.cos(angle) * len / 2, dy = Math.sin(angle) * len / 2;
            shapes = [
                wallShape({ x: cx - dx + nx * gap, y: cy - dy + ny * gap },
                          { x: cx + dx + nx * gap, y: cy + dy + ny * gap }, IOF.fence, 4, true),
                wallShape({ x: cx - dx - nx * gap, y: cy - dy - ny * gap },
                          { x: cx + dx - nx * gap, y: cy + dy - ny * gap }, IOF.fence, 4, true),
            ];
            break;
        }
        case 'hedge_bend': {
            // A hedge with a kink → forms an L-shaped barrier
            const len1 = rand(140, 200), len2 = rand(120, 180);
            const a = { x: cx - Math.cos(baseAngle) * len1, y: cy - Math.sin(baseAngle) * len1 };
            const b = { x: cx, y: cy };
            const bendAngle = baseAngle + rand(0.7, 1.3) * pickRandom([-1, 1]);
            const c = { x: cx + Math.cos(bendAngle) * len2, y: cy + Math.sin(bendAngle) * len2 };
            shapes = [
                wallShape(a, b, IOF.veg_slow, 14),
                wallShape(b, c, IOF.veg_slow, 14),
            ];
            break;
        }
        case 'cliff_arc': {
            const segs = randInt(3, 5);
            const total = rand(220, 320);
            const segLen = total / segs;
            let cur = { x: cx - Math.cos(baseAngle) * total / 2, y: cy - Math.sin(baseAngle) * total / 2 };
            let angle = baseAngle;
            const pts = [cur];
            for (let i = 0; i < segs; i++) {
                angle += rand(-0.35, 0.35);
                cur = { x: cur.x + Math.cos(angle) * segLen, y: cur.y + Math.sin(angle) * segLen };
                pts.push(cur);
            }
            shapes = [{
                kind: 'cliff', polyline: pts,
                hull: inflatePolyline(pts, 12),
                color: IOF.cliff, stroke: IOF.cliff,
            }];
            break;
        }
    }

    // Combined convex hull of all shape hulls → routing target
    const allHullPoints = shapes.flatMap(s => s.hull);
    const hull = convexHull(allHullPoints);

    return { composition, shapes, hull };
}

/* ── Shape builders ───────────────────────────────────── */

function generateBlockingCluster(anchorHull) {
    const bb = boundingBox(anchorHull);
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    const radius = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
    const count = randInt(2, 5);
    const shapes = [];

    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + rand(-0.55, 0.55);
        const dist = radius * rand(0.45, 0.85);
        const x = clamp(cx + Math.cos(angle) * dist, 110, VB_W - 110);
        const y = clamp(cy + Math.sin(angle) * dist, 90, VB_H - 90);
        const rot = angle + rand(-0.8, 0.8);
        const item = pickWeighted([
            ['building', 5],
            ['wall',     3],
            ['fence',    2],
            ['hedge',    3],
            ['pond',     2],
        ]);

        if (item === 'building') {
            shapes.push(rectAt(x, y, rand(55, 135), rand(45, 115), rot, IOF.building, 'building'));
        } else if (item === 'wall' || item === 'fence' || item === 'hedge') {
            const len = rand(90, 190);
            const half = item === 'hedge' ? rand(9, 15) : item === 'wall' ? 6 : 4;
            const color = item === 'hedge' ? IOF.veg_slow : IOF.fence;
            const a = { x: x - Math.cos(rot) * len / 2, y: y - Math.sin(rot) * len / 2 };
            const b = { x: x + Math.cos(rot) * len / 2, y: y + Math.sin(rot) * len / 2 };
            shapes.push(wallShape(a, b, color, half, item === 'fence'));
        } else {
            shapes.push(blobShape(x, y, rand(35, 70), IOF.pond, IOF.pond_border, 'pond'));
        }
    }

    return shapes;
}

function rectAt(cx, cy, w, h, angle, fill, kind) {
    const polygon = kind && kind.includes('building')
        ? buildingFootprint(cx, cy, w, h, angle)
        : rectCorners(cx, cy, w, h, angle);
    return { kind, polygon, hull: convexHull(polygon), color: fill, stroke: '#000' };
}

function buildingFootprint(cx, cy, w, h, angle) {
    const hw = w / 2, hh = h / 2;
    const style = pickWeighted([['chamfer', 4], ['notch', 5], ['step', 3], ['plain', 2]]);
    let pts;

    if (style === 'chamfer') {
        const c = Math.min(w, h) * rand(0.10, 0.22);
        pts = [
            { x: -hw + c, y: -hh }, { x: hw - c, y: -hh },
            { x: hw, y: -hh + c }, { x: hw, y: hh - c },
            { x: hw - c, y: hh }, { x: -hw + c, y: hh },
            { x: -hw, y: hh - c }, { x: -hw, y: -hh + c },
        ];
    } else if (style === 'notch') {
        const nw = w * rand(0.20, 0.36);
        const nd = h * rand(0.15, 0.28);
        pts = [
            { x: -hw, y: -hh }, { x: -nw / 2, y: -hh },
            { x: -nw / 2, y: -hh + nd }, { x: nw / 2, y: -hh + nd },
            { x: nw / 2, y: -hh }, { x: hw, y: -hh },
            { x: hw, y: hh }, { x: -hw, y: hh },
        ];
    } else if (style === 'step') {
        const sx = w * rand(0.18, 0.34);
        const sy = h * rand(0.18, 0.34);
        pts = [
            { x: -hw, y: -hh }, { x: hw - sx, y: -hh },
            { x: hw - sx, y: -hh + sy }, { x: hw, y: -hh + sy },
            { x: hw, y: hh }, { x: -hw + sx, y: hh },
            { x: -hw + sx, y: hh - sy }, { x: -hw, y: hh - sy },
        ];
    } else {
        pts = [
            { x: -hw, y: -hh }, { x: hw, y: -hh },
            { x: hw, y: hh }, { x: -hw, y: hh },
        ];
    }

    const ca = Math.cos(angle), sa = Math.sin(angle);
    return pts.map(p => ({
        x: cx + p.x * ca - p.y * sa,
        y: cy + p.x * sa + p.y * ca,
    }));
}

function rectCorners(cx, cy, w, h, angle) {
    const hw = w/2, hh = h/2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    return [
        { x: -hw, y: -hh }, { x:  hw, y: -hh }, { x:  hw, y:  hh }, { x: -hw, y:  hh },
    ].map(p => ({
        x: cx + p.x * ca - p.y * sa,
        y: cy + p.x * sa + p.y * ca,
    }));
}

function rotate(p, angle) {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    return { x: p.x * ca - p.y * sa, y: p.x * sa + p.y * ca };
}

function blobShape(cx, cy, baseR, fill, stroke, kind) {
    const n = 16;
    const verts = [];
    let r = baseR;
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.04, 0.04);
        r = clamp(r + rand(-baseR * 0.08, baseR * 0.08), baseR * 0.7, baseR * 1.2);
        verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return { kind, polygon: verts, hull: convexHull(verts), color: fill, stroke };
}

function wallShape(a, b, color, half, ticked = false) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * half, ny = dx / len * half;
    const hull = [
        { x: a.x - nx, y: a.y - ny },
        { x: b.x - nx, y: b.y - ny },
        { x: b.x + nx, y: b.y + ny },
        { x: a.x + nx, y: a.y + ny },
    ];
    return { kind: 'wall', a, b, hull, color, stroke: color, half, ticked };
}

function inflatePolyline(pts, half) {
    if (pts.length < 2) return [];
    const top = [], bot = [];
    for (let i = 0; i < pts.length; i++) {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const dx = next.x - prev.x, dy = next.y - prev.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        top.push({ x: pts[i].x + nx * half, y: pts[i].y + ny * half });
        bot.push({ x: pts[i].x - nx * half, y: pts[i].y - ny * half });
    }
    return [...top, ...bot.reverse()];
}

/* ── Endpoint placement ───────────────────────────────── */

function placeEndpoints(hull) {
    const bb = boundingBox(hull);
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    const w  = bb.maxX - bb.minX;
    const h  = bb.maxY - bb.minY;

    const horizontal = h < w;
    const margin = rand(110, 170);
    let start, ziel;
    if (horizontal) {
        start = { x: cx + rand(-w * 0.30, w * 0.30), y: clamp(bb.minY - margin, 70, VB_H - 70) };
        ziel  = { x: cx + rand(-w * 0.30, w * 0.30), y: clamp(bb.maxY + margin, 70, VB_H - 70) };
    } else {
        start = { x: clamp(bb.minX - margin, 70, VB_W - 70), y: cy + rand(-h * 0.30, h * 0.30) };
        ziel  = { x: clamp(bb.maxX + margin, 70, VB_W - 70), y: cy + rand(-h * 0.30, h * 0.30) };
    }
    if (Math.random() < 0.5) [start, ziel] = [ziel, start];
    return { start, ziel };
}

/* ── Decoration: stuff around the main obstacle ──────── */

function generateDecoration(primaryHull, routePts, start, ziel) {
    const items = [];

    const terrainCount = randInt(7, 12);
    for (let i = 0; i < terrainCount; i++) {
        const kind = pickWeighted([
            ['open',       4],
            ['paved_area', 4],
            ['veg_light',  3],
            ['veg_medium', 2],
            ['olive',      1],
        ]);
        const color = {
            open: IOF.open_yellow,
            paved_area: pickRandom([IOF.paved, IOF.paved_dark]),
            veg_light: IOF.veg_light,
            veg_medium: IOF.veg_medium,
            olive: IOF.veg_olive,
        }[kind];
        items.push(areaPatch(
            rand(80, VB_W - 80),
            rand(65, VB_H - 65),
            rand(90, 260),
            rand(55, 190),
            rand(0, Math.PI * 2),
            color,
            kind
        ));
    }

    const roadCount = randInt(2, 4);
    for (let i = 0; i < roadCount; i++) {
        items.push(lineFeature(
            randomEdgePoint(),
            randomEdgePoint(),
            rand(18, 34),
            pickRandom([IOF.paved, IOF.paved_dark]),
            'road'
        ));
    }

    const contourCount = randInt(5, 9);
    for (let i = 0; i < contourCount; i++) {
        items.push(contourLine(rand(80, VB_W - 80), rand(70, VB_H - 70), rand(120, 320), rand(0, Math.PI * 2)));
    }

    const decorCount = randInt(9, 15);
    for (let i = 0; i < decorCount; i++) {
        let attempts = 20, placed = null;
        while (attempts-- > 0) {
            const cx = rand(50, VB_W - 50);
            const cy = rand(50, VB_H - 50);
            // Must not intersect the primary obstacle or the planned routes or the control circles
            if (pointInPolygon({x: cx, y: cy}, primaryHull)) continue;
            if (distToPolygon({x: cx, y: cy}, primaryHull) < 30) continue;
            if (Math.hypot(cx - start.x, cy - start.y) < 50) continue;
            if (Math.hypot(cx - ziel.x,  cy - ziel.y)  < 50) continue;
            // Far enough from the planned route paths (so the path doesn't cross decorations)
            const minRouteDist = Math.min(
                pathMinDistance({x: cx, y: cy}, routePts[0]),
                pathMinDistance({x: cx, y: cy}, routePts[1]),
            );
            if (minRouteDist < 35) continue;

            placed = generateDecorItem(cx, cy);
            break;
        }
        if (placed) items.push(placed);
    }

    return items;
}

function generateDecorItem(cx, cy) {
    const kind = pickWeighted([
        ['small_building', 3],
        ['vegetation',     6],
        ['short_fence',    3],
        ['boulder',        2],
        ['small_pond',     2],
        ['canopy',         2],
        ['path',           3],
    ]);
    const angle = rand(0, Math.PI * 2);
    switch (kind) {
        case 'small_building':
            return rectAt(cx, cy, rand(45, 90), rand(35, 80), angle, IOF.building, 'small_building');
        case 'vegetation':
            return blobShape(cx, cy, rand(25, 65), pickRandom([IOF.veg_light, IOF.veg_medium, IOF.veg_olive]), null, 'vegetation');
        case 'short_fence': {
            const len = rand(80, 150);
            const a = { x: cx - Math.cos(angle) * len / 2, y: cy - Math.sin(angle) * len / 2 };
            const b = { x: cx + Math.cos(angle) * len / 2, y: cy + Math.sin(angle) * len / 2 };
            return { kind: 'short_fence', a, b, color: IOF.fence };
        }
        case 'boulder':
            return { kind: 'boulder', cx, cy, r: rand(3, 6), color: IOF.cliff };
        case 'small_pond':
            return blobShape(cx, cy, rand(25, 45), IOF.pond, IOF.pond_border, 'small_pond');
        case 'canopy':
            return areaPatch(cx, cy, rand(50, 100), rand(35, 85), angle, IOF.open_orange, 'canopy');
        case 'path': {
            const len = rand(85, 180);
            const a = { x: cx - Math.cos(angle) * len / 2, y: cy - Math.sin(angle) * len / 2 };
            const b = { x: cx + Math.cos(angle) * len / 2, y: cy + Math.sin(angle) * len / 2 };
            return lineFeature(a, b, rand(4, 7), IOF.contour, 'path');
        }
    }
}

function areaPatch(cx, cy, w, h, angle, color, kind) {
    const n = randInt(9, 15);
    const pts = [];
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.11, 0.11);
        const rx = w / 2 * rand(0.78, 1.18);
        const ry = h / 2 * rand(0.78, 1.18);
        const lx = Math.cos(a) * rx;
        const ly = Math.sin(a) * ry;
        pts.push({
            x: cx + lx * ca - ly * sa,
            y: cy + lx * sa + ly * ca,
        });
    }
    return { kind, polygon: pts, hull: convexHull(pts), color };
}

function lineFeature(a, b, width, color, kind) {
    return {
        kind,
        a, b,
        width,
        color,
        hull: inflatePolyline([a, b], width / 2),
    };
}

function contourLine(cx, cy, length, angle) {
    const pts = [];
    const segs = randInt(4, 7);
    const step = length / segs;
    const normal = angle + Math.PI / 2;
    for (let i = 0; i <= segs; i++) {
        const along = (i - segs / 2) * step;
        const wave = Math.sin(i * rand(0.8, 1.25)) * rand(8, 18);
        pts.push({
            x: cx + Math.cos(angle) * along + Math.cos(normal) * wave,
            y: cy + Math.sin(angle) * along + Math.sin(normal) * wave,
        });
    }
    return { kind: 'contour', polyline: pts, hull: inflatePolyline(pts, 2), color: IOF.contour };
}

function randomEdgePoint() {
    const side = randInt(0, 3);
    if (side === 0) return { x: rand(0, VB_W), y: -30 };
    if (side === 1) return { x: VB_W + 30, y: rand(0, VB_H) };
    if (side === 2) return { x: rand(0, VB_W), y: VB_H + 30 };
    return { x: -30, y: rand(0, VB_H) };
}

/* =========================================================
   URBAN/PARK GENERATOR
   Paved base, blocky grass, buildings, private gardens and
   sensible walls/fences. These declarations intentionally replace
   the experimental terrain generator above.
========================================================= */

function generateScene() {
    return generateSceneBatch(1).scenes[0];
}

function generateSceneBatch(pairCount = CONTROL_PAIRS_PER_MAP) {
    let lastError = null;
    for (let i = 0; i < CITY_SCENE_ATTEMPTS; i++) {
        try {
            return buildSceneBatchCandidate(pairCount);
        } catch (err) {
            lastError = err;
            console.warn('infinite city batch candidate failed:', err);
        }
    }

    throw lastError || new Error('No routable city batch generated');
}

function buildSceneCandidate() {
    return buildSceneBatchCandidate(1).scenes[0];
}

function buildSceneBatchCandidate(pairCount = CONTROL_PAIRS_PER_MAP) {
    const seed = Math.floor(Math.random() * 2147483646) + 1;
    const settings = {
        ...CITY_SETTINGS,
        seed,
        size: randInt(25, 40),
        river: Math.random() >= 0.45,
        coast: Math.random() >= 0.45,
        walls: Math.random() >= 0.20,
    };

    const generationStart = performance.now();
    const city = generateWards(settings);
    const generationMs = performance.now() - generationStart;

    const graphStart = performance.now();
    const visibilityGraph = buildRouteVisibilityGraph(city);
    const graphMs = performance.now() - graphStart;

    const candidates = (city.wards || [])
        .filter((w) => !w.water && w.polygon && w.polygon.length >= 3)
        .map((ward) => ({ ward, bbox: routePickWardBbox(ward) }));
    if (candidates.length === 0) throw new Error('Generated city has no traversable wards');

    const rejectionCounts = { distinct: 0, distance: 0, side: 0, routeside: 0, lateral: 0, timeout: 0 };
    const scenes = [];
    const usedEndpoints = [];
    const maxRetries = CITY_ROUTE_RETRIES * pairCount;
    let retriesSinceAccepted = 0;

    for (let retries = 0; retries < maxRetries && scenes.length < pairCount; retries++) {
        const pair = routePickPair(candidates, visibilityGraph, city.wall);
        if (!pair) {
            rejectionCounts.distance++;
            retriesSinceAccepted++;
            continue;
        }
        if (routePairTooCloseToUsed(pair, usedEndpoints)) {
            rejectionCounts.distance++;
            retriesSinceAccepted++;
            continue;
        }
        const routeResult = computeRouteOptions(pair.start, pair.goal, visibilityGraph, {
            maxRoutes: selectionConfig.maxRoutes,
            primaryBudgetMs: selectionConfig.primaryRouteBudgetMs,
            extraBudgetMs: selectionConfig.extraRouteBudgetMs,
        });
        const runtimeResult = selectionConfig.strategy === 'extremes'
            ? selectExtremeRouteOptions(pair, routeResult)
            : selectRuntimeRouteOptions(pair, routeResult);
        if (runtimeResult.ok) {
            const scene = buildSceneFromRouteResult(city, visibilityGraph, pair, runtimeResult);
            scene.meta = {
                seed,
                settings,
                generationMs,
                graphMs,
                retries: retriesSinceAccepted,
                pairIndex: scenes.length,
                routeMs: routeResult.dt,
                rejectionCounts,
            };
            scenes.push(scene);
            usedEndpoints.push(pair.start, pair.goal);
            retriesSinceAccepted = 0;
            continue;
        }
        const rejectionReason = runtimeResult.reason || (runtimeResult.timeout ? 'timeout' : 'side');
        if (rejectionReason === 'timeout') rejectionCounts.timeout++;
        else if (rejectionReason === 'distinct') rejectionCounts.distinct++;
        else if (rejectionReason === 'runtime') rejectionCounts.distance++;
        else if (rejectionReason === 'routeside') rejectionCounts.routeside++;
        else if (rejectionReason === 'lateral') rejectionCounts.lateral++;
        else rejectionCounts.side++;
        retriesSinceAccepted++;
    }

    if (scenes.length < pairCount)
        throw new Error(`Only found ${scenes.length}/${pairCount} route pairs for seed ${seed}`);

    const batch = {
        kind: 'city-batch',
        city,
        visibilityGraph,
        scenes,
        index: 0,
        meta: {
            seed,
            settings,
            generationMs,
            graphMs,
            routeCount: scenes.length,
            rejectionCounts,
        },
    };
    scenes.forEach((batchScene, batchIndex) => {
        batchScene.batch = batch;
        batchScene.batchIndex = batchIndex;
    });
    return batch;
}

function routePairTooCloseToUsed(pair, usedEndpoints) {
    for (const endpoint of usedEndpoints) {
        if (Math.hypot(pair.start.x - endpoint.x, pair.start.y - endpoint.y) < CONTROL_PAIR_ENDPOINT_MIN_GAP)
            return true;
        if (Math.hypot(pair.goal.x - endpoint.x, pair.goal.y - endpoint.y) < CONTROL_PAIR_ENDPOINT_MIN_GAP)
            return true;
    }
    return false;
}

function mapMetresPerUnit() {
    return scene?.kind === 'mask' && Number.isFinite(scene.metresPerMapUnit)
        ? scene.metresPerMapUnit
        : MAP_METRES_PER_UNIT;
}

function calcRuntimeRouteLength(path, metresPerUnit = mapMetresPerUnit()) {
    if (!path || path.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < path.length; i++) {
        const dx = path[i].x - path[i - 1].x;
        const dy = path[i].y - path[i - 1].y;
        total += Math.hypot(dx, dy) * metresPerUnit;
    }
    return Math.round(total);
}

function normalizeTurnRad(angle) {
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    return angle;
}

function roundNoA(value) {
    return Math.round(value * 10) / 10;
}

function simplifiedNoAPoints(points, metresPerUnit = mapMetresPerUnit()) {
    const minStep = NOA_MIN_SEGMENT_M / metresPerUnit;
    const out = [];
    for (const p of points || []) {
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        const current = { x: p.x, y: p.y };
        const prev = out[out.length - 1];
        if (!prev || Math.hypot(current.x - prev.x, current.y - prev.y) >= minStep) {
            out.push(current);
        }
    }
    const last = points?.[points.length - 1];
    if (out.length && last && Number.isFinite(last.x) && Number.isFinite(last.y)) {
        out[out.length - 1] = { x: last.x, y: last.y };
    }
    return out;
}

function calcRuntimeRouteNoA(path, metresPerUnit = mapMetresPerUnit()) {
    const rP = simplifiedNoAPoints(path, metresPerUnit);
    if (!rP || rP.length < 3) return 0;

    const epsRad = NOA_EPSILON_DEG * Math.PI / 180;
    const cum = [0];
    const headings = [];
    const segLen = [];
    for (let i = 1; i < rP.length; i++) {
        const dx = rP[i].x - rP[i - 1].x;
        const dy = rP[i].y - rP[i - 1].y;
        const len = Math.hypot(dx, dy) * metresPerUnit;
        cum.push(cum[i - 1] + len);
        segLen.push(len);
        headings.push((dx === 0 && dy === 0) ? null : Math.atan2(dy, dx));
    }

    const turns = [];
    for (let i = 1; i < headings.length; i++) {
        const h1 = headings[i - 1], h2 = headings[i];
        if (h1 === null || h2 === null) continue;
        const signed = normalizeTurnRad(h2 - h1);
        const abs = Math.abs(signed);
        if (abs < epsRad) continue;
        if (Math.min(segLen[i - 1], segLen[i]) < NOA_MIN_SEGMENT_M) continue;
        turns.push({ pos: cum[i], signedDeg: signed * 180 / Math.PI, absDeg: abs * 180 / Math.PI });
    }

    let noA = 0;
    for (let i = 0; i < turns.length;) {
        const cluster = [turns[i++]];
        while (i < turns.length && turns[i].pos - cluster[0].pos <= NOA_CLUSTER_WINDOW_M) {
            cluster.push(turns[i++]);
        }

        const span = cluster[cluster.length - 1].pos - cluster[0].pos;
        const totalAbs = cluster.reduce((sum, turn) => sum + turn.absDeg, 0);
        const net = Math.abs(cluster.reduce((sum, turn) => sum + turn.signedDeg, 0));
        const maxTurn = Math.max(...cluster.map(turn => turn.absDeg));
        if (span <= NOA_ARTIFACT_WINDOW_M && net < NOA_MIN_EFFECT_DEG && totalAbs >= NOA_CORNER_DEG) continue;

        const directionDeg = Math.max(maxTurn, net);
        if (directionDeg >= NOA_MIN_EFFECT_DEG || totalAbs >= NOA_CORNER_DEG) {
            noA += directionDeg / NOA_CORNER_DEG;
        }

        let counterDeg = 0;
        for (let j = 0; j < cluster.length; j++) {
            let localAbs = 0;
            let localNet = 0;
            for (let k = j; k < cluster.length; k++) {
                if (cluster[k].pos - cluster[j].pos > NOA_COUNTER_TURN_WINDOW_M) break;
                localAbs += cluster[k].absDeg;
                localNet += cluster[k].signedDeg;
            }
            counterDeg = Math.max(counterDeg, localAbs - Math.abs(localNet));
        }
        if (counterDeg >= NOA_COUNTER_MIN_DEG) {
            noA += counterDeg / (2 * NOA_CORNER_DEG);
        }
    }
    return roundNoA(noA);
}

function calcRuntimeRouteTime(length, noA, elevation = 0, obstacle = 0) {
    if (!length) return null;
    const elev = Number.isFinite(Number(elevation)) ? Number(elevation) : 0;
    const obstaclePenalty = Number.isFinite(Number(obstacle)) ? Number(obstacle) : 0;
    const flatEquiv = length + ALT_FLAT_EQUIV_M * elev;
    return flatEquiv / RUN_SPEED + (noA || 0) + obstaclePenalty;
}

function enrichRuntimePath(pathRecord) {
    const length = calcRuntimeRouteLength(pathRecord.path);
    const noA = calcRuntimeRouteNoA(pathRecord.path);
    const elevation = 0;
    const obstacle = 0;
    return {
        ...pathRecord,
        length,
        noA,
        elevation,
        obstacle,
        run_time: calcRuntimeRouteTime(length, noA, elevation, obstacle),
    };
}

// Extremes strategy — mirror of selectExtremeRouteOptions in the worker. Serves
// the left-most (min side) and right-most (max side) routes, accepting only when
// their runtime gap is below selectionConfig.extremesMaxRelativeGap.
function selectExtremeRouteOptions(pair, routeResult) {
    const paths = (routeResult.paths || []).map(enrichRuntimePath);
    const base = {
        ...routeResult,
        paths,
        selected: null,
        routeIndexes: [],
        routeLengthSlots: runtimeSlotsFor(paths, 'length'),
        routeSideSlots: runtimeSlotsFor(paths, 'side'),
        routeSideLabelSlots: runtimeSlotsFor(paths, 'sideLabel'),
        routeRuntimeSlots: runtimeSlotsFor(paths, 'run_time'),
        routeNoASlots: runtimeSlotsFor(paths, 'noA'),
        routeElevationSlots: runtimeSlotsFor(paths, 'elevation'),
        blockFastest: false,
        ok: false,
    };

    if (paths.length === 0) return { ...base, reason: routeResult.reason || 'timeout' };
    if (paths.length === 1) return { ...base, reason: 'distinct', routeIndexes: [paths[0].routeIndex] };

    ensureRouteSides(paths, pair.start, pair.goal);

    const withRun = paths.filter((p) => Number.isFinite(p.run_time) && p.run_time > 0);
    if (withRun.length < 2) return { ...base, reason: 'distinct' };

    let leftmost = withRun[0], rightmost = withRun[0];
    for (const p of withRun) {
        if (p.side < leftmost.side) leftmost = p;
        if (p.side > rightmost.side) rightmost = p;
    }
    if (leftmost === rightmost) return { ...base, reason: 'routeside' };

    const selected = [leftmost, rightmost];
    const sideGap = Math.abs(leftmost.side - rightmost.side);
    const routeSideMin = sideGap / 4;
    if (
        sideGap < ROUTE_RUNTIME_MIN_SIDE_GAP ||
        leftmost.side * rightmost.side >= 0 ||
        selected.some((p) => Math.abs(p.side) < routeSideMin)
    ) return { ...base, reason: 'routeside' };

    const faster = Math.min(leftmost.run_time, rightmost.run_time);
    const slower = Math.max(leftmost.run_time, rightmost.run_time);
    const relativeGap = faster > 0 ? (slower - faster) / faster : Infinity;
    if (relativeGap >= selectionConfig.extremesMaxRelativeGap) return { ...base, reason: 'runtime' };

    const skippedBarriers = skippedBarriersForSelection(paths, selected);

    return {
        ...base,
        ok: true,
        reason: 'ok',
        selected,
        routeIndexes: selected.map((p) => p.routeIndex),
        routeLengthSlots: runtimeSlotsFor(paths, 'length'),
        routeSideSlots: runtimeSlotsFor(paths, 'side'),
        routeSideLabelSlots: runtimeSlotsFor(paths, 'sideLabel'),
        routeRuntimeSlots: runtimeSlotsFor(paths, 'run_time'),
        routeNoASlots: runtimeSlotsFor(paths, 'noA'),
        routeElevationSlots: runtimeSlotsFor(paths, 'elevation'),
        skippedBarriers,
        blockFastest: skippedBarriers.length > 0,
    };
}

function selectRuntimeRouteOptions(pair, routeResult) {
    const paths = (routeResult.paths || []).map(enrichRuntimePath);
    const base = {
        ...routeResult,
        paths,
        selected: null,
        routeIndexes: [],
        routeLengthSlots: runtimeSlotsFor(paths, 'length'),
        routeSideSlots: runtimeSlotsFor(paths, 'side'),
        routeSideLabelSlots: runtimeSlotsFor(paths, 'sideLabel'),
        routeRuntimeSlots: runtimeSlotsFor(paths, 'run_time'),
        routeNoASlots: runtimeSlotsFor(paths, 'noA'),
        routeElevationSlots: runtimeSlotsFor(paths, 'elevation'),
        blockFastest: false,
        ok: false,
    };

    if (paths.length === 0) return { ...base, reason: routeResult.reason || 'timeout' };
    if (paths.length === 1) return { ...base, reason: 'distinct', routeIndexes: [paths[0].routeIndex] };

    ensureRouteSides(paths, pair.start, pair.goal);
    const pick = selectWeightedRoutePair(paths, {
        start: pair.start,
        goal: pair.goal,
        config: {
            ...selectionConfig.weighted,
            minSideGap: ROUTE_RUNTIME_MIN_SIDE_GAP,
            maxRelativeGap: ROUTE_RUNTIME_MAX_RELATIVE_GAP,
        },
    });
    if (!pick.ok) return { ...base, reason: pick.reason };

    const selected = pick.selected;
    const skippedBarriers = skippedBarriersForSelection(paths, selected);

    return {
        ...base,
        ok: true,
        reason: 'ok',
        selected,
        routeIndexes: selected.map((p) => p.routeIndex),
        routeLengthSlots: runtimeSlotsFor(paths, 'length'),
        routeSideSlots: runtimeSlotsFor(paths, 'side'),
        routeSideLabelSlots: runtimeSlotsFor(paths, 'sideLabel'),
        routeRuntimeSlots: runtimeSlotsFor(paths, 'run_time'),
        routeNoASlots: runtimeSlotsFor(paths, 'noA'),
        routeElevationSlots: runtimeSlotsFor(paths, 'elevation'),
        skippedBarriers,
        blockFastest: skippedBarriers.length > 0,
        relativeGap: pick.relativeGap,
        sideGap: pick.sideGap,
        pairCandidates: pick.candidates.length,
    };
}

function buildSceneFromRouteResult(city, visibilityGraph, pair, routeResult) {
    const selected = routeResult.selected
        .slice()
        .sort((a, b) => (a.side || 0) - (b.side || 0));

    const routes = selected.map((r) => {
        return {
            points: r.path,
            length: r.length,
            noA: r.noA,
            elevation: r.elevation,
            obstacle: r.obstacle,
            run_time: r.run_time,
            time: r.run_time,
            routeIndex: r.routeIndex,
            pos: r.side,
            side: r.side,
            sideLabel: r.sideLabel,
        };
    });

    return {
        kind: 'city',
        city,
        visibilityGraph,
        routeResult,
        start: pair.start,
        ziel: pair.goal,
        routes,
        mapScale: 1,
    };
}

/* =========================================================
   MASK SCENE BUILDER (WP 3.3)
   Turns a pathing-worker `pair` (already converted to map units by
   MaskSceneSource) into a scene of the SAME shape as a city scene, so
   renderScene / buildRenderedScene / the choice + scoring + report flow all
   work unchanged. The only structural differences: kind === 'mask', a
   `mapImage` descriptor for the raster background instead of `scene.city`,
   and no `visibilityGraph`. The worker already selected + refined the two
   routes, but its barrier metadata is retained as `routeResult` so the shared
   purple-block renderer has exactly the same input shape as city scenes.
========================================================= */

function maskRouteSide(points, start, goal) {
    const sgDx = goal.x - start.x;
    const sgDy = goal.y - start.y;
    const sgLen = Math.hypot(sgDx, sgDy) || 1;
    let sum = 0;
    for (const pt of points) sum += sgDx * (pt.y - start.y) - sgDy * (pt.x - start.x);
    return (sum / points.length) / sgLen;
}

function buildMaskScene(pair) {
    const start = pair.start;
    const ziel = pair.goal;
    const metresPerMapUnit = pair.source.metresPerMapUnit;

    // Worker guarantees routes[0]=left, routes[1]=right. Compute the signed
    // side value the same way selectRuntimeRouteOptions does so the stats panel
    // ordering (sort by pos) and report payload match the city path.
    const routes = pair.routes.map((r) => {
        const points = r.points;
        const side = maskRouteSide(points, start, ziel);
        const length = calcRuntimeRouteLength(points, metresPerMapUnit);
        const noA = calcRuntimeRouteNoA(points, metresPerMapUnit);
        const obstacle = Number.isFinite(Number(r.obstacle)) ? Number(r.obstacle) : 0;
        // The worker's runtime is a terrain-weighted pathing cost used only
        // to select a pair. It is not measured in seconds and can therefore
        // be orders of magnitude larger than the distance/angle breakdown
        // shown in the stats panel. The scene runtime must use that same
        // seconds-based model as the breakdown.
        const runTime = calcRuntimeRouteTime(length, noA, 0, obstacle);
        return {
            points,
            length,
            noA,
            elevation: 0,
            obstacle,
            run_time: runTime,
            time: runTime,
            routeIndex: Number.isFinite(r.routeIndex) ? r.routeIndex : r.index + 1,
            pos: side,
            side,
            sideLabel: side > 0 ? 'R' : side < 0 ? 'L' : 'C',
        };
    });

    return {
        kind: 'mask',
        start,
        ziel,
        routes,
        routeResult: {
            routeIndexes: routes.map((route) => route.routeIndex),
            skippedBarriers: pair.skippedBarriers || [],
            blockFastest: (pair.skippedBarriers || []).length > 0,
            barriers: pair.barriers || [],
        },
        mapScale: 1,
        mapScaleDenominator: pair.source.mapScale,
        editorScale: pair.source.editorScale,
        metresPerMapUnit,
        // Raster background descriptor. Full-res mask dims × TRAIN_SCALE_VALUE =
        // map-image px, which is exactly the map-unit space start/ziel/routes
        // live in, so the <image> at (0,0) with these dims aligns pixel-exact.
        mapImage: {
            href: pair.source.mapImageUrl,
            width: pair.source.mapWidth,
            height: pair.source.mapHeight,
        },
        meta: {
            source: 'mask',
            fileId: pair.source.fileId,
            filename: pair.source.filename,
            retries: pair.meta?.retries ?? null,
            attempts: pair.meta?.attempts ?? null,
            sideGap: pair.meta?.sideGap ?? null,
            relGap: pair.meta?.relGap ?? null,
            legality: pair.meta?.legality ?? null,
            timings: pair.meta?.timings ?? null,
            workerMs: pair.meta?.workerMs ?? null,
            rejectionCounts: pair.meta?.rejectionCounts || {},
            refineMode: pair.meta?.refineMode ?? null,
            refine: pair.meta?.refine || [],
        },
    };
}

function routePickPointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > pt.y) !== (b.y > pt.y)) {
            const x = (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x;
            if (pt.x < x) inside = !inside;
        }
    }
    return inside;
}

function routePickWardBbox(ward) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ward.polygon) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}

function routePickPointSegmentDistance(pt, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 <= 1e-9) return Math.hypot(pt.x - a.x, pt.y - a.y);
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
    return Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t));
}

function routePickDistanceToClosedPolyline(pt, pts) {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        best = Math.min(best, routePickPointSegmentDistance(pt, a, b));
    }
    return best;
}

function routePickPointAllowed(pt, ward, wall) {
    if (ward.inner) return 'inner';
    const wallShape = wall && wall.shape;
    if (!wallShape || wallShape.length < 3) return null;
    if (routePickPointInPolygon(pt, wallShape)) return null;
    if (routePickDistanceToClosedPolyline(pt, wallShape) <= ROUTE_PICK_OUTSIDE_WALL_MAX_DIST) return 'outsideWall';
    return null;
}

function routePickWeightedPoint(pool) {
    let total = 0;
    for (const p of pool) total += p.weight;
    let r = Math.random() * total;
    for (const p of pool) {
        r -= p.weight;
        if (r <= 0) return p;
    }
    return pool[pool.length - 1] || null;
}

function routePickPoint(candidates, visGraph, wall = null) {
    const pool = [];
    for (let attempt = 0; attempt < 500; attempt++) {
        const item = candidates[(Math.random() * candidates.length) | 0];
        const b = item.bbox;
        for (let local = 0; local < 20; local++) {
            const pt = {
                x: b.minX + Math.random() * (b.maxX - b.minX),
                y: b.minY + Math.random() * (b.maxY - b.minY),
            };
            if (!routePickPointInPolygon(pt, item.ward.polygon)) continue;
            const area = routePickPointAllowed(pt, item.ward, wall);
            if (!area) continue;
            if (visGraph._inRawObstacle && visGraph._inRawObstacle(pt.x, pt.y)) continue;
            const boundaryDist = routePickDistanceToClosedPolyline(pt, item.ward.polygon);
            const biasedDist = Math.min(boundaryDist, ROUTE_PICK_INTERIOR_BIAS_CAP) + ROUTE_PICK_INTERIOR_BIAS_EPS;
            pool.push({
                ...pt,
                wardType: item.ward.type || 'generic',
                area,
                boundaryDist,
                weight: Math.pow(biasedDist, ROUTE_PICK_INTERIOR_BIAS_POWER),
            });
            if (pool.length >= ROUTE_PICK_POINT_POOL_SIZE) {
                const picked = routePickWeightedPoint(pool);
                if (!picked) return null;
                const { weight, ...out } = picked;
                return out;
            }
        }
    }
    const picked = routePickWeightedPoint(pool);
    if (!picked) return null;
    const { weight, ...out } = picked;
    return out;
}

function routePickPair(candidates, visGraph, wall = null) {
    for (let attempt = 0; attempt < 1000; attempt++) {
        const start = routePickPoint(candidates, visGraph, wall);
        const goal = routePickPoint(candidates, visGraph, wall);
        if (!start || !goal) return null;
        const straightLine = Math.hypot(goal.x - start.x, goal.y - start.y);
        if (straightLine >= ROUTE_PICK_MIN_DIST && straightLine <= ROUTE_PICK_MAX_DIST)
            return { start, goal, straightLine };
    }
    return null;
}

function generateUrbanPrimary() {
    const cx = rand(VB_W * 0.40, VB_W * 0.60);
    const cy = rand(VB_H * 0.38, VB_H * 0.62);
    const angle = rand(-0.45, 0.45) + pickRandom([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    const across = angle + Math.PI / 2;
    const shapes = [];

    const main = urbanRect(cx, cy, rand(150, 235), rand(70, 115), angle, IOF.building, 'building');
    shapes.push(main);

    const wingSide = pickRandom([-1, 1]);
    const wingOffset = rotate({ x: rand(-35, 35), y: wingSide * rand(72, 112) }, angle);
    const wing = urbanRect(cx + wingOffset.x, cy + wingOffset.y, rand(75, 135), rand(55, 95), angle, IOF.building, 'building');
    shapes.push(wing);

    if (Math.random() < 0.7) {
        const rowSide = pickRandom([-1, 1]);
        const rowOffset = rotate({ x: rowSide * rand(145, 220), y: rand(-18, 18) }, angle);
        shapes.push(urbanRect(cx + rowOffset.x, cy + rowOffset.y, rand(70, 125), rand(58, 105), angle, IOF.building, 'building'));
    }

    const buildings = shapes.filter(s => s.kind === 'building');
    for (const b of buildings) {
        if (Math.random() < 0.85) {
            const garden = gardenForBuilding(b, pickRandom([-1, 1]));
            shapes.push(garden);
            shapes.push(...fencesForPatch(garden, angle, Math.random() < 0.5));
        }
    }

    const barrierLen = rand(170, 270);
    const offset = rotate({ x: rand(-35, 35), y: -wingSide * rand(88, 125) }, angle);
    const a = {
        x: cx + offset.x - Math.cos(angle) * barrierLen / 2,
        y: cy + offset.y - Math.sin(angle) * barrierLen / 2,
    };
    const b = {
        x: cx + offset.x + Math.cos(angle) * barrierLen / 2,
        y: cy + offset.y + Math.sin(angle) * barrierLen / 2,
    };
    shapes.push(wallShape(a, b, IOF.stone_wall, 5.5, false));

    const hull = convexHull(shapes.flatMap(s => s.hull || []));
    return { composition: 'urban_block', shapes, hull };
}

function generateUrbanDecoration(primaryHull, routePts, start, ziel) {
    const items = [];

    for (let i = 0; i < randInt(5, 8); i++) {
        items.push(blockPatch(
            rand(90, VB_W - 90),
            rand(70, VB_H - 70),
            rand(115, 280),
            rand(65, 170),
            pickRandom([0, Math.PI / 2, rand(-0.25, 0.25)]),
            IOF.open_yellow,
            'grass',
            pickRandom(['none', 'left', 'right'])
        ));
    }

    for (let i = 0; i < randInt(3, 5); i++) {
        const p = placeAwayFromRoutes(primaryHull, routePts, start, ziel, 75);
        if (!p) continue;
        const angle = pickRandom([0, Math.PI / 2, -Math.PI / 2]) + rand(-0.18, 0.18);
        const building = urbanRect(p.x, p.y, rand(55, 115), rand(45, 90), angle, IOF.building, 'small_building');
        items.push(building);
        if (Math.random() < 0.75) {
            const garden = gardenForBuilding(building, pickRandom([-1, 1]));
            items.push(garden);
            items.push(...fencesForPatch(garden, angle, true));
        }
    }

    for (let i = 0; i < randInt(3, 6); i++) {
        const p = placeAwayFromRoutes(primaryHull, routePts, start, ziel, 40);
        if (!p) continue;
        const angle = pickRandom([0, Math.PI / 2]) + rand(-0.2, 0.2);
        const len = rand(75, 165);
        const a = { x: p.x - Math.cos(angle) * len / 2, y: p.y - Math.sin(angle) * len / 2 };
        const b = { x: p.x + Math.cos(angle) * len / 2, y: p.y + Math.sin(angle) * len / 2 };
        items.push(wallShape(a, b, IOF.fence, Math.random() < 0.45 ? 3.2 : 4.8, Math.random() < 0.65));
    }

    return items;
}

function placeAwayFromRoutes(primaryHull, routePts, start, ziel, clearance) {
    for (let attempts = 0; attempts < 40; attempts++) {
        const p = { x: rand(55, VB_W - 55), y: rand(55, VB_H - 55) };
        if (pointInPolygon(p, primaryHull)) continue;
        if (distToPolygon(p, primaryHull) < 35) continue;
        if (Math.hypot(p.x - start.x, p.y - start.y) < 70) continue;
        if (Math.hypot(p.x - ziel.x, p.y - ziel.y) < 70) continue;
        const minRouteDist = Math.min(pathMinDistance(p, routePts[0]), pathMinDistance(p, routePts[1]));
        if (minRouteDist < clearance) continue;
        return p;
    }
    return null;
}

function urbanRect(cx, cy, w, h, angle, color, kind) {
    const polygon = rectCorners(cx, cy, w, h, angle);
    return { kind, polygon, hull: polygon, color, stroke: IOF.building, angle, cx, cy, w, h };
}

function gardenForBuilding(building, side) {
    const along = rand(-building.w * 0.12, building.w * 0.12);
    const gw = clamp(building.w * rand(0.72, 1.05), 55, 155);
    const gh = clamp(building.h * rand(0.62, 1.10), 45, 120);
    const offset = rotate({ x: along, y: side * (building.h / 2 + gh / 2 + rand(2, 8)) }, building.angle);
    return blockPatch(
        building.cx + offset.x,
        building.cy + offset.y,
        gw,
        gh,
        building.angle,
        IOF.private_garden,
        'private_garden',
        'none'
    );
}

function fencesForPatch(patch, angle, ticked) {
    const pts = patch.polygon;
    const walls = [];
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 18) continue;
        if (Math.random() < 0.78) walls.push(wallShape(a, b, IOF.fence, ticked ? 3.2 : 4.8, ticked));
    }
    if (walls.length === 0 && pts.length >= 2) walls.push(wallShape(pts[0], pts[1], IOF.fence, 3.2, ticked));
    return walls;
}

function blockPatch(cx, cy, w, h, angle, color, kind, roundedSide = 'none') {
    const hw = w / 2, hh = h / 2;
    let pts;
    if (roundedSide === 'left' || roundedSide === 'right') {
        const side = roundedSide === 'right' ? 1 : -1;
        const xFlat = -side * hw;
        const xRound = side * hw;
        pts = [{ x: xFlat, y: -hh }, { x: xFlat, y: hh }];
        const steps = 8;
        for (let i = 0; i <= steps; i++) {
            const t = -Math.PI / 2 + (i / steps) * Math.PI;
            pts.push({
                x: xRound - side * (w * 0.18) * (1 - Math.cos(t)),
                y: Math.sin(t) * hh,
            });
        }
        if (side < 0) pts.reverse();
    } else {
        pts = [
            { x: -hw, y: -hh }, { x: hw, y: -hh },
            { x: hw, y: hh }, { x: -hw, y: hh },
        ];
    }

    const ca = Math.cos(angle), sa = Math.sin(angle);
    const polygon = pts.map(p => ({
        x: cx + p.x * ca - p.y * sa,
        y: cy + p.x * sa + p.y * ca,
    }));
    return { kind, polygon, hull: convexHull(polygon), color, angle, cx, cy, w, h };
}

/* =========================================================
   GEOMETRY HELPERS
========================================================= */

function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickWeighted(pairs) {
    const total = pairs.reduce((s, p) => s + p[1], 0);
    let r = Math.random() * total;
    for (const [item, w] of pairs) { r -= w; if (r <= 0) return item; }
    return pairs[0][0];
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function boundingBox(pts) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs),
             minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points) {
    if (points.length < 3) return points.slice();
    const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const lower = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi + 1e-9) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function distToPolygon(p, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        best = Math.min(best, segmentPointDistance(p, a, b));
    }
    return best;
}

function segmentPointDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx*dx + dy*dy || 1;
    let t = ((p.x - a.x)*dx + (p.y - a.y)*dy) / lenSq;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function pathLength(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    return s;
}

function pathMinDistance(p, pathPts) {
    let best = Infinity;
    for (let i = 1; i < pathPts.length; i++) {
        best = Math.min(best, segmentPointDistance(p, pathPts[i - 1], pathPts[i]));
        if (best < 1) break;
    }
    return best;
}

/* =========================================================
   SIDE-SPLIT ROUTING — two arcs around the compound hull
========================================================= */

function tangentRoutes(start, ziel, obstacleHull) {
    const hull = convexHull([start, ziel, ...obstacleHull]);
    const sIdx = hull.findIndex(p => p === start);
    const zIdx = hull.findIndex(p => p === ziel);
    if (sIdx === -1 || zIdx === -1) {
        return [route([start, ziel]), route([start, ziel])];
    }

    const arc1 = walkArc(hull, sIdx, zIdx,  1);
    const arc2 = walkArc(hull, sIdx, zIdx, -1);

    // "Left" of start→ziel from the player's perspective (running toward ziel)
    const mid = arc1[Math.floor(arc1.length / 2)];
    const sideSign = (ziel.x - start.x) * (mid.y - start.y) - (ziel.y - start.y) * (mid.x - start.x);
    const arc1IsLeft = sideSign < 0;

    return arc1IsLeft
        ? [route(arc1), route(arc2)]
        : [route(arc2), route(arc1)];
}

function walkArc(hull, fromIdx, toIdx, step) {
    const arc = [];
    let i = fromIdx;
    arc.push(hull[i]);
    while (i !== toIdx) {
        i = (i + step + hull.length) % hull.length;
        arc.push(hull[i]);
    }
    return arc;
}

function route(pts) {
    const length = pathLength(pts) * mapMetresPerUnit();
    const time  = length / RUN_SPEED;   // seconds
    return { points: pts, length, time };
}

/* =========================================================
   RENDERING
========================================================= */

function renderScene({ cameraDuration = 1000, onCameraReady = null } = {}) {
    if (!installRenderedScene(scene)) {
        clearLayer('rp-bg-layer');
        clearLayer('rp-decor-layer');
        clearLayer('rp-obstacle-layer');
        clearLayer('rp-route-layer');
        clearLayer('rp-control-layer');

        const rotGroup = SVG('rp-rotation');
        if (scene.kind === 'mask') {
            if (rotGroup) rotGroup.setAttribute('transform', maskFitTransform(scene));
            drawMaskBackground(scene);
        } else {
            if (rotGroup) rotGroup.setAttribute('transform', cityFitTransform(scene.city?.bounds));
            drawBackground();
            drawCityMap(scene.city);
        }
        drawRouteHitAreas();
        drawRouteBlocks();
        drawControls(scene.start, scene.ziel);
    }
    orientCameraToScene(cameraDuration, onCameraReady);
}

function layerEl(id) {
    return (_renderTarget && _renderTarget[id]) || SVG(id);
}

function clearLayer(id) { layerEl(id).innerHTML = ''; }

function createRenderLayerSet() {
    return {
        'rp-bg-layer': svgEl('g'),
        'rp-decor-layer': svgEl('g'),
        'rp-obstacle-layer': svgEl('g'),
        'rp-route-layer': svgEl('g'),
        'rp-control-layer': svgEl('g'),
    };
}

function withSceneAndTarget(sceneToRender, target, fn) {
    const prevScene = scene;
    const prevTarget = _renderTarget;
    scene = sceneToRender;
    _renderTarget = target;
    try {
        return fn();
    } finally {
        _renderTarget = prevTarget;
        scene = prevScene;
    }
}

function buildRenderedScene(sceneToRender) {
    if (!sceneToRender || sceneToRender._renderCache) return sceneToRender?._renderCache || null;
    const layers = createRenderLayerSet();
    const rotationTransform = withSceneAndTarget(sceneToRender, layers, () => {
        let transform;
        if (sceneToRender.kind === 'mask') {
            transform = maskFitTransform(sceneToRender);
            drawMaskBackground(sceneToRender);
        } else {
            transform = cityFitTransform(sceneToRender.city?.bounds);
            drawBackground();
            drawCityMap(sceneToRender.city);
        }
        drawRouteHitAreas();
        drawRouteBlocks();
        drawControls(sceneToRender.start, sceneToRender.ziel);
        return transform;
    });
    sceneToRender._renderCache = { layers, rotationTransform };
    return sceneToRender._renderCache;
}

function installRenderedScene(sceneToRender) {
    const cache = sceneToRender?._renderCache;
    if (!cache) return false;
    const rotGroup = SVG('rp-rotation');
    if (rotGroup) rotGroup.setAttribute('transform', cache.rotationTransform || '');
    for (const id of Object.keys(cache.layers)) {
        const target = SVG(id);
        target.replaceChildren(...Array.from(cache.layers[id].childNodes));
    }
    sceneToRender._renderCache = null;
    return true;
}

function scheduleUpcomingScenePrerender() {
    if (sceneSource === 'mask' && maskSource) {
        // Prerender the next buffered mask scene (if any) so the SVG cache is
        // warm before it is served.
        scheduleScenePrerender(maskSource.buffer?.[0]);
        return;
    }
    if (!currentBatch || currentBatch.index >= currentBatch.scenes.length) return;
    scheduleScenePrerender(currentBatch.scenes[currentBatch.index]);
}

function scheduleScenePrerender(sceneToRender) {
    if (!sceneToRender || sceneToRender._renderCache || _prerenderTimer) return;
    const run = () => {
        _prerenderTimer = null;
        if (!sceneToRender._renderCache) {
            buildRenderedScene(sceneToRender);
        }
    };
    if ('requestIdleCallback' in window) {
        _prerenderTimer = window.requestIdleCallback(run, { timeout: 1200 });
    } else {
        _prerenderTimer = window.setTimeout(run, 120);
    }
}

function drawBackground() {
    const bg = svgEl('rect');
    const bounds = scene?.city?.bounds;
    if (bounds) {
        const pad = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.15;
        bg.setAttribute('x', bounds.minX - pad);
        bg.setAttribute('y', bounds.minY - pad);
        bg.setAttribute('width', (bounds.maxX - bounds.minX) + pad * 2);
        bg.setAttribute('height', (bounds.maxY - bounds.minY) + pad * 2);
    } else {
        bg.setAttribute('x', 0); bg.setAttribute('y', 0);
        bg.setAttribute('width', VB_W); bg.setAttribute('height', VB_H);
    }
    bg.setAttribute('fill', '#efe9d8');
    layerEl('rp-bg-layer').appendChild(bg);
}

function cityFitTransform(bounds) {
    if (!bounds) {
        if (scene) scene.mapScale = 1;
        if (scene) { scene.mapTx = 0; scene.mapTy = 0; }
        return '';
    }
    const bw = Math.max(1e-3, bounds.maxX - bounds.minX);
    const bh = Math.max(1e-3, bounds.maxY - bounds.minY);
    const scale = Math.min((VB_W * (1 - CITY_FIT_PAD * 2)) / bw, (VB_H * (1 - CITY_FIT_PAD * 2)) / bh);
    const tx = VB_W / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
    const ty = VB_H / 2 - ((bounds.minY + bounds.maxY) / 2) * scale;
    if (scene) {
        scene.mapScale = scale;
        scene.mapTx = tx;
        scene.mapTy = ty;
    }
    return `translate(${tx},${ty}) scale(${scale})`;
}

function maskSceneBounds(sc) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const acc = (p) => {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    };
    acc(sc.start); acc(sc.ziel);
    for (const r of sc.routes || []) for (const p of r.points || []) acc(p);
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
}

// Fit the route + endpoint bounding box (with a control-radius margin) into the
// viewbox, mirroring cityFitTransform. The raster background lives in the same
// map-unit space, so it is placed at (0,0) at native size and simply scaled by
// this transform along with everything else.
function maskFitTransform(sc) {
    const bounds = maskSceneBounds(sc);
    if (!bounds) {
        if (sc) { sc.mapScale = 1; sc.mapTx = 0; sc.mapTy = 0; }
        return '';
    }
    const margin = controlRadiusForScene(sc) * 3;
    const minX = bounds.minX - margin, minY = bounds.minY - margin;
    const maxX = bounds.maxX + margin, maxY = bounds.maxY + margin;
    const bw = Math.max(1e-3, maxX - minX);
    const bh = Math.max(1e-3, maxY - minY);
    const scale = Math.min((VB_W * (1 - CITY_FIT_PAD * 2)) / bw, (VB_H * (1 - CITY_FIT_PAD * 2)) / bh);
    const tx = VB_W / 2 - ((minX + maxX) / 2) * scale;
    const ty = VB_H / 2 - ((minY + maxY) / 2) * scale;
    sc.mapScale = scale;
    sc.mapTx = tx;
    sc.mapTy = ty;
    return `translate(${tx},${ty}) scale(${scale})`;
}

function drawMaskBackground(sc) {
    const layer = layerEl('rp-bg-layer');
    const img = sc.mapImage;
    if (!img || !img.href) return;
    const image = svgEl('image');
    image.setAttribute('x', 0);
    image.setAttribute('y', 0);
    if (Number.isFinite(img.width) && Number.isFinite(img.height)) {
        image.setAttribute('width', img.width);
        image.setAttribute('height', img.height);
    }
    image.setAttribute('preserveAspectRatio', 'none');
    // href for modern browsers; xlink:href kept for older SVG image support.
    image.setAttribute('href', img.href);
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', img.href);
    image.setAttribute('pointer-events', 'none');
    layer.appendChild(image);
}

function mapPointToSurface(p) {
    const s = scene?.mapScale || 1;
    return {
        x: (scene?.mapTx || 0) + p.x * s,
        y: (scene?.mapTy || 0) + p.y * s,
    };
}

function orientCameraToScene(duration = 0, onComplete = null) {
    if (!scene?.start || !scene?.ziel) {
        onComplete?.();
        return;
    }

    const start = mapPointToSurface(scene.start);
    const ziel = mapPointToSurface(scene.ziel);

    const rotDeg = cameraRotationForEndpoints(start, ziel);
    if (rotDeg === null) {
        onComplete?.();
        return;
    }
    const R = rotDeg * Math.PI / 180;
    const cosR = Math.cos(R);
    const sinR = Math.sin(R);
    const toRot = p => ({ rx: p.x * cosR - p.y * sinR, ry: p.x * sinR + p.y * cosR });

    const routePts = [];
    for (const route of scene.routes || []) {
        if (route.points?.length) routePts.push(...route.points.map(mapPointToSurface));
    }
    const dataPts = routePts.length ? routePts : [start, ziel];
    const rotData = dataPts.map(toRot);

    let minRX = Math.min(...rotData.map(p => p.rx));
    let maxRX = Math.max(...rotData.map(p => p.rx));
    let minRY = Math.min(...rotData.map(p => p.ry));
    let maxRY = Math.max(...rotData.map(p => p.ry));

    [start, ziel].forEach(pt => {
        const { rx, ry } = toRot(pt);
        const controlSurfaceRadius = controlRadiusForScene(scene) * (scene?.mapScale || 1);
        minRX = Math.min(minRX, rx - controlSurfaceRadius);
        maxRX = Math.max(maxRX, rx + controlSurfaceRadius);
        minRY = Math.min(minRY, ry - controlSurfaceRadius);
        maxRY = Math.max(maxRY, ry + controlSurfaceRadius);
    });

    const startRX = toRot(start).rx;
    const centerRY = (minRY + maxRY) / 2;

    const container = SVG('map-container');
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const halfW = Math.max(startRX - minRX, maxRX - startRX);
    const halfH = (maxRY - minRY) / 2;
    const scaleX = halfW > 0 ? (cw / 2 - CAMERA_PAD) / halfW : MAX_ZOOM;
    const scaleY = halfH > 0 ? (ch / 2 - CAMERA_PAD) / halfH : MAX_ZOOM;
    const scale = Math.max(1e-6, Math.min(scaleX, scaleY, MAX_ZOOM));

    const setBounds = () => {
        camBounds = {
            minRX: startRX - (cw / 2) / scale,
            maxRX: startRX + (cw / 2) / scale,
            minRY: centerRY - (ch / 2) / scale,
            maxRY: centerRY + (ch / 2) / scale,
            minScale: scale,
        };
        clampCam();
        applyTransform();
        onComplete?.();
    };

    animateCam({
        rot: rotDeg,
        scale,
        cx: startRX * cosR + centerRY * sinR,
        cy: -startRX * sinR + centerRY * cosR,
    }, duration, setBounds);
}

function animateCam(target, duration = 1000, onComplete) {
    if (_camAnim) cancelAnimationFrame(_camAnim);

    const container = SVG('map-container');
    const scx = container.clientWidth / 2;
    const scy = container.clientHeight / 2;

    const fromR = cam.rot * Math.PI / 180;
    const fromCosR = Math.cos(fromR);
    const fromSinR = Math.sin(fromR);
    const fromDX = scx - cam.x;
    const fromDY = scy - cam.y;
    const safeScale = cam.scale > 0 ? cam.scale : 1;
    const fromCx = ( fromCosR * fromDX + fromSinR * fromDY) / safeScale;
    const fromCy = (-fromSinR * fromDX + fromCosR * fromDY) / safeScale;
    const fromScale = cam.scale;
    const fromRotDeg = cam.rot;
    const dRot = ((target.rot - fromRotDeg) % 360 + 540) % 360 - 180;
    const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const applyAt = (e) => {
        const curRotDeg = fromRotDeg + dRot * e;
        const curScale = fromScale + (target.scale - fromScale) * e;
        const curCx = fromCx + (target.cx - fromCx) * e;
        const curCy = fromCy + (target.cy - fromCy) * e;
        const curR = curRotDeg * Math.PI / 180;
        const cosR = Math.cos(curR);
        const sinR = Math.sin(curR);
        cam.rot = curRotDeg;
        cam.scale = curScale;
        cam.x = scx - (curCx * cosR - curCy * sinR) * curScale;
        cam.y = scy - (curCx * sinR + curCy * cosR) * curScale;
        applyTransform();
    };

    if (duration <= 0) {
        applyAt(1);
        cam.rot = target.rot;
        _camAnim = null;
        onComplete?.();
        commitCameraTransform();
        return;
    }

    let startTs = null;
    function step(ts) {
        if (!startTs) startTs = ts;
        const t = Math.min((ts - startTs) / duration, 1);
        applyAt(ease(t));
        if (t < 1) {
            _camAnim = requestAnimationFrame(step);
        } else {
            cam.rot = target.rot;
            _camAnim = null;
            onComplete?.();
            commitCameraTransform();
        }
    }

    _camAnim = requestAnimationFrame(step);
}

const MAP_PALETTE = {
    innerFill: '#e4d7b6', innerStroke: '#9a8a63',
    outerFill: '#cdd6ac', outerStroke: '#9aa877',
    waterFill: '#00adef', waterStroke: '#000000',
    river: '#00adef', riverBank: '#000000',
    wall: '#888888', wallOutline: '#000000', gate: '#efe9d8', gateTower: '#c8c8c8',
    bridgeDock: '#c8a46a', bridgeDockOutline: '#000000',
    seed: '#c0392b',
    block: '#000000',
    building: '#888888', buildingStroke: '#000000',
    plazaBuilding: '#888888',
    outerGarden: '#a6b93c',
    cathedralGround: '#fdc01d',
    park: '#fdc01d', parkStroke: '#000000',
    largestLotInset: '#c8c8c8',
    cathedral: '#888888', cathedralStroke: '#000000',
    cathedralWall: '#000000',
    hedge: '#009218',
    alley: '#a99d77',
    featureObject: '#000', featureTree: '#009218', featureFountain: '#2b7fc4',
};
const MAP_BUILDING_OUTLINE_WIDTH = 0.18;
const MAP_GATE_TOWER_OUTLINE_WIDTH = MAP_BUILDING_OUTLINE_WIDTH / 2;
const MAP_WALL_TOWER_DIAMETER_SCALE = 2;
const MAP_WATER_OUTLINE_WIDTH = 0.2;
const MAP_RIVER_MOUTH_FILL_OVERLAP = MAP_WATER_OUTLINE_WIDTH;
const MAP_HEDGE_WIDTH = 0.5;
const MAP_CITY_WALL_WIDTH = 1.8;
const MAP_BRIDGE_FILL_WIDTH = 1.6;
const MAP_BLOCK_OUTLINE_FILLET = 0.4;

function mapWardBaseFill(w) {
    const outerCity = w.type === 'outerGarden' || w.type === 'outerHighrise';
    return w.water ? MAP_PALETTE.waterFill : (w.inner || outerCity) ? MAP_PALETTE.innerFill : MAP_PALETTE.outerFill;
}

function mapPolyPath(pts) {
    if (pts.length < 2) return '';
    return 'M' + pts.map(p => p.x + ',' + p.y).join('L');
}

function mapPolygonPath(poly) {
    if (!poly || poly.length < 3) return '';
    return `M${poly.map((p) => `${p.x},${p.y}`).join('L')}Z`;
}

function mapPointDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function mapChaikinSmooth(pts, iterations) {
    if (pts.length < 3) return pts;
    let a = pts;
    for (let it = 0; it < iterations; it++) {
        const h = [a[0]];
        for (let i = 1, n = a.length - 1; i < n; i++) {
            const g = a[i], p = a[i - 1], nx = a[i + 1];
            h.push({ x: g.x * 0.75 + p.x * 0.25, y: g.y * 0.75 + p.y * 0.25 });
            h.push({ x: g.x * 0.75 + nx.x * 0.25, y: g.y * 0.75 + nx.y * 0.25 });
        }
        h.push(a[a.length - 1]);
        a = h;
    }
    return a;
}

function mapPreviewDeltaFromPath(delta, path, width) {
    if (!delta || path.length < 2) return delta;
    const p0 = path[0], p1 = path[1];
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len, ty = dy / len;
    const hw = width / 2;
    const a = { x: p0.x - ty * hw, y: p0.y + tx * hw };
    const b = { x: p0.x + ty * hw, y: p0.y - tx * hw };
    const right = mapPointDist(a, delta.right) <= mapPointDist(b, delta.right) ? a : b;
    const left = right === a ? b : a;
    const ctrlLen = Math.max(mapPointDist(delta.right, delta.rightCtrl1), len * 0.5);
    return {
        ...delta,
        right,
        rightCtrl1: { x: right.x - tx * ctrlLen, y: right.y - ty * ctrlLen },
        leftCtrl2: { x: left.x - tx * ctrlLen, y: left.y - ty * ctrlLen },
        left,
    };
}

function mapDeltaPath(dl) {
    let d = `M${dl.right.x},${dl.right.y}`;
    d += ` C${dl.rightCtrl1.x},${dl.rightCtrl1.y} ${dl.rightCtrl2.x},${dl.rightCtrl2.y} ${dl.prevShore.x},${dl.prevShore.y}`;
    if (dl.isConvex) d += ` L${dl.mouth.x},${dl.mouth.y}`;
    d += ` L${dl.nextShore.x},${dl.nextShore.y}`;
    d += ` C${dl.leftCtrl1.x},${dl.leftCtrl1.y} ${dl.leftCtrl2.x},${dl.leftCtrl2.y} ${dl.left.x},${dl.left.y}`;
    return d;
}

function mapRiverRenderGeometry(river) {
    if (!river || !river.course || river.course.length < 2) return null;
    const course = river.delta
        ? [{ x: (river.course[0].x + river.course[1].x) / 2, y: (river.course[0].y + river.course[1].y) / 2 }, ...river.course.slice(1)]
        : river.course;
    const visualCourse = mapChaikinSmooth(course, 3);
    let fillCourse = visualCourse;
    if (river.delta && visualCourse.length >= 2) {
        const p0 = visualCourse[0], p1 = visualCourse[1];
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy) || 1;
        fillCourse = [{ x: p0.x - (dx / len) * MAP_RIVER_MOUTH_FILL_OVERLAP, y: p0.y - (dy / len) * MAP_RIVER_MOUTH_FILL_OVERLAP }, ...visualCourse.slice(1)];
    }
    return {
        visualCourse,
        pathD: mapPolyPath(visualCourse),
        fillPathD: mapPolyPath(fillCourse),
        delta: river.delta ? mapPreviewDeltaFromPath(river.delta, visualCourse, river.width) : null,
    };
}

function drawCityMap(city) {
    if (!city) return;
    const layer = layerEl('rp-bg-layer');
    for (const w of city.wards || []) {
        if (w.water) continue;
        if (!w.polygon || w.polygon.length < 3) continue;
        const el = svgEl('polygon');
        el.setAttribute('points', w.polygon.map((p) => p.x + ',' + p.y).join(' '));
        el.setAttribute('fill', mapWardBaseFill(w));
        el.setAttribute('stroke', 'none');
        layer.appendChild(el);
    }
    const riverGeometry = mapRiverRenderGeometry(city.river);
    drawMapBlocks(layer, city.blocks);
    drawMapBuildings(layer, city.buildings);
    drawMapHedges(layer, city.hedges);
    drawMapCathedralHedges(layer, city.cathedralHedges);
    drawMapRoads();
    drawMapWaterBody(layer, city.wards, city.river, riverGeometry);
    if (riverGeometry) drawMapBridges(layer, city.river, riverGeometry.visualCourse);
    drawMapDocks(layer, city.docks);
    const riverNodeSet = new Set();
    if (city.river && city.river.course) for (const v of city.river.course) riverNodeSet.add(v);
    drawMapWall(layer, city.wall, city.river && city.river.width, riverNodeSet);
    drawMapFeatures(layer, city.features);
}

function drawMapWaterBody(layer, wards, river, riverGeometry) {
    let d = '';
    for (const w of wards || []) if (w.water) d += mapPolygonPath(w.polygon);
    if (riverGeometry?.delta) d += mapDeltaPath(riverGeometry.delta);
    const hasRiver = riverGeometry && river?.width;
    const outlineWidth = MAP_WATER_OUTLINE_WIDTH * 2;
    if (d) {
        const outline = svgEl('path');
        outline.setAttribute('d', d);
        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', MAP_PALETTE.waterStroke);
        outline.setAttribute('stroke-width', outlineWidth);
        outline.setAttribute('stroke-linejoin', 'round');
        layer.appendChild(outline);
    }
    if (hasRiver) {
        const outline = svgEl('path');
        outline.setAttribute('d', riverGeometry.pathD);
        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', MAP_PALETTE.waterStroke);
        outline.setAttribute('stroke-width', river.width + outlineWidth);
        outline.setAttribute('stroke-linecap', river.delta ? 'butt' : 'round');
        outline.setAttribute('stroke-linejoin', 'round');
        layer.appendChild(outline);
    }
    if (d) {
        const water = svgEl('path');
        water.setAttribute('d', d);
        water.setAttribute('fill', MAP_PALETTE.waterFill);
        water.setAttribute('stroke', 'none');
        layer.appendChild(water);
    }
    if (hasRiver) {
        const riverFill = svgEl('path');
        riverFill.setAttribute('d', riverGeometry.fillPathD || riverGeometry.pathD);
        riverFill.setAttribute('fill', 'none');
        riverFill.setAttribute('stroke', MAP_PALETTE.river);
        riverFill.setAttribute('stroke-width', river.width);
        riverFill.setAttribute('stroke-linecap', river.delta ? 'butt' : 'round');
        riverFill.setAttribute('stroke-linejoin', 'round');
        layer.appendChild(riverFill);
    }
}

function drawMapRoads() {
    return;
}

function mapClosestPointOnSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return {
        x: a.x + dx * t,
        y: a.y + dy * t,
        t,
        distance: Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)),
    };
}

function mapClosestPointOnPath(p, path) {
    let best = null;
    for (let i = 0; i < path.length - 1; i++) {
        const q = mapClosestPointOnSegment(p, path[i], path[i + 1]);
        if (!best || q.distance < best.distance) best = { ...q, segment: i };
    }
    return best;
}

function mapVisualRiverCrossing(origin, axis, path, allowFallback = true) {
    let best = null;
    for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const sx = b.x - a.x, sy = b.y - a.y;
        const denom = axis.x * sy - axis.y * sx;
        if (Math.abs(denom) < 1e-8) continue;
        const ox = a.x - origin.x, oy = a.y - origin.y;
        const t = (ox * sy - oy * sx) / denom;
        const u = (ox * axis.y - oy * axis.x) / denom;
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        const point = { x: origin.x + axis.x * t, y: origin.y + axis.y * t };
        const score = Math.abs(t);
        if (!best || score < best.score) best = { point, segment: i, score };
    }
    if (best) return best;
    if (!allowFallback) return null;
    const closest = mapClosestPointOnPath(origin, path);
    return closest ? { point: { x: closest.x, y: closest.y }, segment: closest.segment, score: closest.distance } : null;
}

function mapRiverTangentAt(path, segment) {
    const a = path[Math.max(0, Math.min(segment, path.length - 2))];
    const b = path[Math.max(1, Math.min(segment + 1, path.length - 1))];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
}

function mapDistanceToPath(p, path) {
    let best = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const l2 = dx * dx + dy * dy || 1;
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        const ex = p.x - (a.x + dx * t), ey = p.y - (a.y + dy * t);
        const d = ex * ex + ey * ey;
        if (d < best) best = d;
    }
    return Math.sqrt(best);
}

// The rendered river is a round-join stroke along the smoothed centerline, so
// water is exactly the set of points within `radius` of that polyline. March
// along `dir` from a point on the centerline until the ray first leaves the
// water band, then bisect the exact shore distance. A tangent projection
// (span = shoreHalfWidth / axis·normal) assumes a locally straight river and
// misses the real shore wherever the river bends sharply near the bridge.
function mapShoreExitAlongRay(start, dir, path, radius) {
    const step = Math.max(0.4, radius * 0.2);
    const maxSpan = radius * 12;
    let inside = 0;
    let outside = -1;
    for (let s = step; s <= maxSpan; s += step) {
        if (mapDistanceToPath({ x: start.x + dir.x * s, y: start.y + dir.y * s }, path) >= radius) {
            outside = s;
            break;
        }
        inside = s;
    }
    if (outside < 0) return null;
    for (let k = 0; k < 20; k++) {
        const mid = (inside + outside) / 2;
        if (mapDistanceToPath({ x: start.x + dir.x * mid, y: start.y + dir.y * mid }, path) >= radius) outside = mid;
        else inside = mid;
    }
    return { x: start.x + dir.x * outside, y: start.y + dir.y * outside };
}

function mapBridgeSideShorePoints(origin, axis, path, shoreHalfWidth) {
    const crossing = mapVisualRiverCrossing(origin, axis, path, false);
    if (!crossing) return null;
    const plus = mapShoreExitAlongRay(crossing.point, axis, path, shoreHalfWidth);
    const minus = mapShoreExitAlongRay(crossing.point, { x: -axis.x, y: -axis.y }, path, shoreHalfWidth);
    if (!plus || !minus) return null;
    return { minus, plus, center: crossing.point };
}

function mapBridgeDeckBleedPoint(side, point, bleed) {
    const dx = point.x - side.center.x;
    const dy = point.y - side.center.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return point;
    return { x: point.x + dx / len * bleed, y: point.y + dy / len * bleed };
}

function drawMapBridges(layer, river, visualCourse = null) {
    if (!river || !river.bridges || !river.course || river.course.length < 3) return;
    const path = visualCourse && visualCourse.length >= 2 ? visualCourse : river.course;
    const riverWidth = Number.isFinite(river.width) ? river.width : 5;
    const bridgePoint = (bridge) => ({ x: bridge.x, y: bridge.y });
    for (const bridge of river.bridges) {
        const i = river.course.findIndex((p) => Math.abs(p.x - bridge.x) < 1e-6 && Math.abs(p.y - bridge.y) < 1e-6);
        if (i <= 0 || i >= river.course.length - 1) continue;
        const fill = '#e4d7b6';
        const fillWidth = Number.isFinite(bridge.width) ? bridge.width : MAP_BRIDGE_FILL_WIDTH;
        const sideOutlineWidth = 0.2;
        let axis = null;
        if (bridge.from && bridge.to) {
            const dx = bridge.to.x - bridge.from.x, dy = bridge.to.y - bridge.from.y;
            const len = Math.hypot(dx, dy) || 1;
            axis = { x: dx / len, y: dy / len };
        } else {
            const crossing = mapClosestPointOnPath(bridgePoint(bridge), path);
            if (!crossing) continue;
            const tangent = mapRiverTangentAt(path, crossing.segment);
            axis = { x: -tangent.y, y: tangent.x };
        }
        const centerCrossing = mapVisualRiverCrossing(bridgePoint(bridge), axis, path);
        if (!centerCrossing) continue;
        const sideNormal = { x: -axis.y, y: axis.x };
        const halfDeck = fillWidth / 2;
        const shoreHalfWidth = riverWidth / 2 + MAP_WATER_OUTLINE_WIDTH;
        const deckBleed = MAP_WATER_OUTLINE_WIDTH * 1.5 + 0.05;
        const leftOrigin = { x: centerCrossing.point.x + sideNormal.x * halfDeck, y: centerCrossing.point.y + sideNormal.y * halfDeck };
        const rightOrigin = { x: centerCrossing.point.x - sideNormal.x * halfDeck, y: centerCrossing.point.y - sideNormal.y * halfDeck };
        const left = mapBridgeSideShorePoints(leftOrigin, axis, path, shoreHalfWidth);
        const right = mapBridgeSideShorePoints(rightOrigin, axis, path, shoreHalfWidth);
        if (!left || !right) continue;
        const deck = svgEl('polygon');
        const deckPts = [
            mapBridgeDeckBleedPoint(left, left.minus, deckBleed),
            mapBridgeDeckBleedPoint(left, left.plus, deckBleed),
            mapBridgeDeckBleedPoint(right, right.plus, deckBleed),
            mapBridgeDeckBleedPoint(right, right.minus, deckBleed),
        ];
        deck.setAttribute('points', deckPts.map((p) => `${p.x},${p.y}`).join(' '));
        deck.setAttribute('fill', fill);
        deck.setAttribute('stroke', 'none');
        layer.appendChild(deck);
        for (const side of [left, right]) {
            const rail = svgEl('line');
            rail.setAttribute('x1', side.minus.x); rail.setAttribute('y1', side.minus.y);
            rail.setAttribute('x2', side.plus.x); rail.setAttribute('y2', side.plus.y);
            rail.setAttribute('stroke', MAP_PALETTE.bridgeDockOutline);
            rail.setAttribute('stroke-width', sideOutlineWidth);
            rail.setAttribute('stroke-linecap', 'butt');
            layer.appendChild(rail);
        }
    }
}

function drawMapDocks(layer, docks) {
    if (!docks || docks.length === 0) return;
    for (const dock of docks) {
        const w = dock.large ? 2 : 1;
        const fillWidth = 1.6 * w;
        const outlineWidth = fillWidth + 0.4 * w;
        const fill = '#e4d7b6';
        for (const pier of dock.piers || []) {
            if (!pier.from || !pier.to) continue;
            const dx = pier.to.x - pier.from.x;
            const dy = pier.to.y - pier.from.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const seaCap = { x: pier.to.x + ux * outlineWidth / 10, y: pier.to.y + uy * outlineWidth / 10 };
            const landOverlap = MAP_WATER_OUTLINE_WIDTH * 2;
            const landFrom = { x: pier.from.x - ux * landOverlap, y: pier.from.y - uy * landOverlap };
            const dFill = `M${landFrom.x},${landFrom.y} L${pier.to.x},${pier.to.y}`;
            const dOutline = `M${pier.from.x},${pier.from.y} L${seaCap.x},${seaCap.y}`;
            for (const [stroke, width, d] of [[MAP_PALETTE.bridgeDockOutline, outlineWidth, dOutline], [fill, fillWidth, dFill]]) {
                const path = svgEl('path');
                path.setAttribute('d', d); path.setAttribute('fill', 'none');
                path.setAttribute('stroke', stroke); path.setAttribute('stroke-width', width);
                path.setAttribute('stroke-linecap', 'butt'); path.setAttribute('stroke-linejoin', 'round');
                layer.appendChild(path);
            }
        }
    }
}

function mapRoundedBlockPath(points, r) {
    if (!points || points.length < 3) return null;
    const n = points.length;
    const leftNormal = (dx, dy, len) => (len > 0 ? { x: -dy / len, y: dx / len } : null);
    const segs = [];
    for (let i = 0; i < n; i++) {
        const A = points[(i - 1 + n) % n];
        const B = points[i];
        const C = points[(i + 1) % n];
        const inDx = B.x - A.x, inDy = B.y - A.y;
        const outDx = C.x - B.x, outDy = C.y - B.y;
        const inLen = Math.hypot(inDx, inDy);
        const outLen = Math.hypot(outDx, outDy);
        if (inLen < 1e-9 || outLen < 1e-9) return null;
        const inUx = inDx / inLen, inUy = inDy / inLen;
        const outUx = outDx / outLen, outUy = outDy / outLen;
        const dot = inUx * outUx + inUy * outUy;
        const turn = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (turn < 1e-6) return null;
        const lnIn = leftNormal(inDx, inDy, inLen);
        const lnOut = leftNormal(outDx, outDy, outLen);
        const bisX = lnIn.x + lnOut.x;
        const bisY = lnIn.y + lnOut.y;
        const bisLen = Math.hypot(bisX, bisY);
        if (bisLen < 1e-9) return null;
        const nBisX = bisX / bisLen;
        const nBisY = bisY / bisLen;
        const halfTurn = turn / 2;
        const tanHalf = Math.tan(halfTurn);
        const cosHalf = Math.cos(halfTurn);
        if (tanHalf < 1e-9 || cosHalf < 1e-9) return null;
        let d = r * tanHalf;
        d = Math.min(d, inLen * 0.499, outLen * 0.499);
        const effR = d / tanHalf;
        const centerDist = effR / cosHalf;
        const t1x = B.x - inUx * d;
        const t1y = B.y - inUy * d;
        const t2x = B.x + outUx * d;
        const t2y = B.y + outUy * d;
        const cx = B.x + nBisX * centerDist;
        const cy = B.y + nBisY * centerDist;
        const a1 = Math.atan2(t1y - cy, t1x - cx);
        const a2 = Math.atan2(t2y - cy, t2x - cx);
        let delta = a2 - a1;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const sweep = delta > 0 ? 1 : 0;
        const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
        segs.push({ t1x, t1y, t2x, t2y, r: effR, sweep, largeArc });
    }
    let d = `M${segs[0].t2x},${segs[0].t2y}`;
    for (let i = 0; i < n; i++) {
        const next = segs[(i + 1) % n];
        d += ` L${next.t1x},${next.t1y}`;
        d += ` A${next.r},${next.r} 0 ${next.largeArc},${next.sweep} ${next.t2x},${next.t2y}`;
    }
    return d + 'Z';
}

function drawMapBlocks(layer, blocks) {
    if (!blocks || blocks.length === 0) return;
    let d = '';
    for (const b of blocks) {
        if (!b || b.length < 3) continue;
        const rounded = mapRoundedBlockPath(b, MAP_BLOCK_OUTLINE_FILLET);
        if (rounded) d += rounded;
    }
    if (!d) return;
    const el = svgEl('path');
    el.setAttribute('d', d);
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', MAP_PALETTE.block);
    el.setAttribute('stroke-width', '0.06');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('fill-rule', 'evenodd');
    layer.appendChild(el);
}

function drawMapBuildings(layer, buildings) {
    if (!buildings || buildings.length === 0) return;
    for (const b of buildings) {
        const polygon = Array.isArray(b) ? b : b.polygon;
        if (!polygon || polygon.length < 3) continue;
        const cls = Array.isArray(b) ? null : b.class;
        let fill = MAP_PALETTE.building, stroke = MAP_PALETTE.buildingStroke;
        if (cls === 'park' || cls === 'outerHighrisePark') { fill = MAP_PALETTE.park; stroke = MAP_PALETTE.parkStroke; }
        else if (cls === 'largestLotInset' || cls === 'housingEntranceFill') { fill = MAP_PALETTE.largestLotInset; stroke = MAP_PALETTE.buildingStroke; }
        else if (cls === 'outerHighrisePath') { fill = MAP_PALETTE.alley; stroke = 'none'; }
        else if (cls === 'outerGarden') { fill = MAP_PALETTE.outerGarden; stroke = MAP_PALETTE.outerGarden; }
        else if (cls === 'outerGardenOutline') { fill = 'none'; stroke = MAP_PALETTE.buildingStroke; }
        else if (cls === 'cathedralGround') { fill = MAP_PALETTE.cathedralGround; stroke = MAP_PALETTE.parkStroke; }
        else if (cls === 'cathedral') { fill = MAP_PALETTE.cathedral; stroke = MAP_PALETTE.cathedralStroke; }
        else if (cls === 'plazaBuilding') { fill = MAP_PALETTE.plazaBuilding; stroke = MAP_PALETTE.buildingStroke; }
        const el = svgEl('polygon');
        el.setAttribute('points', polygon.map((p) => p.x + ',' + p.y).join(' '));
        el.setAttribute('fill', fill);
        el.setAttribute('stroke', stroke);
        if (cls === 'outerGarden' || cls === 'outerHighrisePath') {
            el.setAttribute('stroke-width', '0');
        } else if (cls === 'outerGardenOutline') {
            el.setAttribute('stroke-width', MAP_BUILDING_OUTLINE_WIDTH);
        } else if (cls === 'largestLotInset' || cls === 'housingEntranceFill') {
            el.setAttribute('stroke-width', MAP_BUILDING_OUTLINE_WIDTH / 2);
        } else if (cls === 'cathedral' || cls === 'cathedralGround' || cls === 'park' || cls === 'outerHighrisePark') {
            el.setAttribute('stroke-width', MAP_BUILDING_OUTLINE_WIDTH / 2);
        } else {
            el.setAttribute('stroke-width', MAP_BUILDING_OUTLINE_WIDTH);
        }
        el.setAttribute('stroke-linejoin', 'round');
        layer.appendChild(el);
    }
}

function drawMapHedges(layer, hedges) {
    if (!hedges || hedges.length === 0) return;
    for (const hedge of hedges) {
        if (!hedge || hedge.length < 2) continue;
        if (!hedge.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
        const el = svgEl('polyline');
        el.setAttribute('points', hedge.map((p) => `${p.x},${p.y}`).join(' '));
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', MAP_PALETTE.hedge);
        el.setAttribute('stroke-width', MAP_HEDGE_WIDTH);
        el.setAttribute('stroke-linecap', 'butt');
        el.setAttribute('stroke-linejoin', 'round');
        layer.appendChild(el);
    }
}

function drawMapCathedralHedges(layer, hedges) {
    if (!hedges || hedges.length === 0) return;
    for (const hedge of hedges) {
        if (!hedge || hedge.length < 2) continue;
        if (!hedge.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
        const el = svgEl('polyline');
        el.setAttribute('points', hedge.map((p) => `${p.x},${p.y}`).join(' '));
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', MAP_PALETTE.cathedralWall);
        el.setAttribute('stroke-width', MAP_HEDGE_WIDTH);
        el.setAttribute('stroke-linecap', 'butt');
        el.setAttribute('stroke-linejoin', 'round');
        layer.appendChild(el);
    }
}

function drawMapWall(layer, wall, riverWidth, riverNodes) {
    if (!wall || !wall.shape || wall.shape.length < 2) return;
    const thickness = MAP_CITY_WALL_WIDTH;
    const outlineThickness = thickness + MAP_BUILDING_OUTLINE_WIDTH;
    const n = wall.shape.length;
    const segs = wall.segments;
    const halfRiver = (riverWidth || 0) / 2;
    const endpointAt = new Map();
    for (let i = 0; i < n; i++) {
        if (segs && segs[i] === false) continue;
        let a = wall.shape[i];
        let b = wall.shape[(i + 1) % n];
        if (halfRiver > 0 && segs) {
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len;
            let ax = a.x, ay = a.y, bx = b.x, by = b.y;
            if (segs[(i + n - 1) % n] === false || (riverNodes && riverNodes.has(a))) { ax = a.x + ux * halfRiver; ay = a.y + uy * halfRiver; }
            if (segs[(i + 1) % n] === false || (riverNodes && riverNodes.has(b))) { bx = b.x - ux * halfRiver; by = b.y - uy * halfRiver; }
            a = { x: ax, y: ay }; b = { x: bx, y: by };
        }
        endpointAt.set(i, a);
        endpointAt.set((i + 1) % n, b);
        for (const [stroke, width] of [[MAP_PALETTE.wallOutline, outlineThickness], [MAP_PALETTE.wall, thickness]]) {
            const seg = svgEl('line');
            seg.setAttribute('x1', a.x); seg.setAttribute('y1', a.y);
            seg.setAttribute('x2', b.x); seg.setAttribute('y2', b.y);
            seg.setAttribute('stroke', stroke); seg.setAttribute('stroke-width', width);
            seg.setAttribute('stroke-linecap', 'butt'); seg.setAttribute('stroke-linejoin', 'round');
            layer.appendChild(seg);
        }
    }
    const towerR = thickness * MAP_WALL_TOWER_DIAMETER_SCALE / 2;
    for (const t of wall.towers || []) {
        const ti = wall.shape.findIndex((p) => Math.abs(p.x - t.x) < 1e-6 && Math.abs(p.y - t.y) < 1e-6);
        const pos = (ti !== -1 && endpointAt.get(ti)) || t;
        const tower = svgEl('circle');
        tower.setAttribute('cx', pos.x); tower.setAttribute('cy', pos.y);
        tower.setAttribute('r', towerR); tower.setAttribute('fill', MAP_PALETTE.wall);
        tower.setAttribute('stroke', MAP_PALETTE.wallOutline); tower.setAttribute('stroke-width', MAP_BUILDING_OUTLINE_WIDTH);
        layer.appendChild(tower);
    }
    for (const gate of wall.gates || []) {
        if (riverNodes && riverNodes.has(gate)) continue;
        const idx = wall.shape.findIndex((p) => Math.abs(p.x - gate.x) < 1e-6 && Math.abs(p.y - gate.y) < 1e-6);
        const pos = (idx !== -1 && endpointAt.get(idx)) || gate;
        const tower = svgEl('circle');
        tower.setAttribute('cx', pos.x); tower.setAttribute('cy', pos.y);
        tower.setAttribute('r', towerR); tower.setAttribute('fill', MAP_PALETTE.gateTower);
        tower.setAttribute('stroke', MAP_PALETTE.wallOutline); tower.setAttribute('stroke-width', MAP_GATE_TOWER_OUTLINE_WIDTH);
        tower.setAttribute('class', 'gate-tower');
        tower.setAttribute('data-kind', 'gate');
        layer.appendChild(tower);
    }
}

function drawMapFeatures(layer, features) {
    if (!features || features.length === 0) return;
    const r = 0.5;
    for (const f of features) {
        if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) continue;
        const c = svgEl('circle');
        const isTree = f.kind === 'tree';
        c.setAttribute('cx', f.x); c.setAttribute('cy', f.y); c.setAttribute('r', isTree ? 0.67 * r : r);
        c.setAttribute('stroke', isTree ? 'none' : f.kind === 'object' ? MAP_PALETTE.featureObject : MAP_PALETTE.featureFountain);
        c.setAttribute('stroke-width', isTree ? '0' : '0.2');
        c.setAttribute('fill', isTree ? MAP_PALETTE.featureTree : 'none');
        layer.appendChild(c);
    }
}

function drawRouteHitAreas() {
    const layer = layerEl('rp-route-layer');
    if (!scene?.routes?.length) return;

    scene.routes.forEach((route, i) => addRouteHitArea(layer, route, i));
}

function createRoutePolyline(route, { stroke = 'black', strokeWidth = 1.5, opacity = 1, adaptiveStroke = false, interactive = false } = {}) {
    const points = route?.points || route?.rP;
    if (!points || points.length < 2) return null;
    const el = svgEl('polyline');
    el.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', stroke);
    if (adaptiveStroke) setAdaptiveRouteStroke(el, strokeWidth);
    else el.setAttribute('stroke-width', strokeWidth);
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
    el.setAttribute('opacity', String(opacity));
    if (interactive) {
        el.setAttribute('pointer-events', 'stroke');
        el.style.cursor = 'pointer';
    } else {
        el.setAttribute('pointer-events', 'none');
    }
    return el;
}

function drawRouteBlocks(layer = layerEl('rp-route-layer')) {
    const blockedBars = (scene.routeResult?.skippedBarriers?.length)
        ? scene.routeResult.skippedBarriers
        : (scene.routeResult?.blockFastest && scene.routeResult?.barriers?.length ? [scene.routeResult.barriers[0]] : []);
    for (const b of blockedBars) {
        const line = svgEl('line');
        line.setAttribute('x1', b.ax); line.setAttribute('y1', b.ay);
        line.setAttribute('x2', b.bx); line.setAttribute('y2', b.by);
        line.setAttribute('stroke', CONTROL_COLOR);
        line.setAttribute('stroke-width', blockingStrokeWidthForScene());
        line.setAttribute('stroke-linecap', 'butt');
        line.setAttribute('pointer-events', 'none');
        layer.appendChild(line);
    }
}

function drawDecor(items) {
    const layer = layerEl('rp-decor-layer');
    for (const d of items) {
        if (d.kind === 'tile_polygon') {
            const p = svgEl('polygon');
            p.setAttribute('points', d.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', d.color);
            p.setAttribute('opacity', '0.85');
            layer.appendChild(p);
        } else {
            drawShape(d, false, layer);
        }
    }
}

function drawShape(shape, primary, layer) {
    layer = layer || layerEl('rp-obstacle-layer');
    switch (shape.kind) {
        case 'grass':
        case 'private_garden': {
            const p = svgEl('polygon');
            p.setAttribute('points', shape.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', shape.color);
            p.setAttribute('stroke', shape.kind === 'private_garden' ? IOF.fence : 'none');
            p.setAttribute('stroke-width', shape.kind === 'private_garden' ? '1.2' : '0');
            p.setAttribute('opacity', '0.96');
            layer.appendChild(p);
            break;
        }
        case 'open':
        case 'paved_area':
        case 'canopy':
        case 'olive': {
            const p = svgEl('polygon');
            p.setAttribute('points', shape.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', shape.color);
            p.setAttribute('opacity', shape.kind === 'paved_area' ? '0.92' : '0.86');
            layer.appendChild(p);
            break;
        }
        case 'building':
        case 'small_building': {
            const p = svgEl('polygon');
            p.setAttribute('points', shape.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', shape.color);
            p.setAttribute('stroke', '#000');
            p.setAttribute('stroke-width', '1.5');
            layer.appendChild(p);
            break;
        }
        case 'pond':
        case 'small_pond': {
            const p = svgEl('polygon');
            p.setAttribute('points', shape.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', shape.color);
            p.setAttribute('stroke', shape.stroke || IOF.pond_border);
            p.setAttribute('stroke-width', '2.5');
            layer.appendChild(p);
            break;
        }
        case 'veg_light':
        case 'veg_medium':
        case 'vegetation': {
            const p = svgEl('polygon');
            p.setAttribute('points', shape.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', shape.color === IOF.veg_medium ? 'url(#rp-veg-stripe)' : shape.color);
            p.setAttribute('opacity', '0.85');
            layer.appendChild(p);
            break;
        }
        case 'road': {
            const polygon = svgEl('polygon');
            polygon.setAttribute('points', shape.hull.map(v => `${v.x},${v.y}`).join(' '));
            polygon.setAttribute('fill', shape.color);
            polygon.setAttribute('stroke', IOF.uncrossable);
            polygon.setAttribute('stroke-width', '1');
            polygon.setAttribute('opacity', '0.9');
            layer.appendChild(polygon);
            break;
        }
        case 'path': {
            const line = svgEl('line');
            line.setAttribute('x1', shape.a.x); line.setAttribute('y1', shape.a.y);
            line.setAttribute('x2', shape.b.x); line.setAttribute('y2', shape.b.y);
            line.setAttribute('stroke', shape.color);
            line.setAttribute('stroke-width', shape.width);
            line.setAttribute('stroke-linecap', 'round');
            line.setAttribute('stroke-dasharray', '9 7');
            line.setAttribute('opacity', '0.85');
            layer.appendChild(line);
            break;
        }
        case 'contour': {
            const poly = svgEl('polyline');
            poly.setAttribute('points', shape.polyline.map(v => `${v.x},${v.y}`).join(' '));
            poly.setAttribute('fill', 'none');
            poly.setAttribute('stroke', shape.color);
            poly.setAttribute('stroke-width', '1.4');
            poly.setAttribute('stroke-linejoin', 'round');
            poly.setAttribute('stroke-linecap', 'round');
            poly.setAttribute('opacity', '0.72');
            layer.appendChild(poly);
            break;
        }
        case 'wall': {
            const a = shape.a, b = shape.b;
            const isHedge = shape.color === IOF.veg_slow;
            if (isHedge) {
                // Thick green band for hedge
                const polygon = svgEl('polygon');
                polygon.setAttribute('points', shape.hull.map(v => `${v.x},${v.y}`).join(' '));
                polygon.setAttribute('fill', IOF.veg_slow);
                polygon.setAttribute('opacity', '0.95');
                layer.appendChild(polygon);
            } else {
                // Stone wall / fence — black thick line
                const line = svgEl('line');
                line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
                line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
                line.setAttribute('stroke', shape.color);
                line.setAttribute('stroke-width', (shape.half * 0.9) || 4);
                line.setAttribute('stroke-linecap', 'round');
                layer.appendChild(line);
                if (shape.ticked) drawFenceTicks(layer, a, b);
            }
            break;
        }
        case 'short_fence': {
            const line = svgEl('line');
            line.setAttribute('x1', shape.a.x); line.setAttribute('y1', shape.a.y);
            line.setAttribute('x2', shape.b.x); line.setAttribute('y2', shape.b.y);
            line.setAttribute('stroke', shape.color);
            line.setAttribute('stroke-width', '3');
            line.setAttribute('stroke-linecap', 'round');
            layer.appendChild(line);
            drawFenceTicks(layer, shape.a, shape.b);
            break;
        }
        case 'boulder': {
            const c = svgEl('circle');
            c.setAttribute('cx', shape.cx); c.setAttribute('cy', shape.cy);
            c.setAttribute('r', shape.r);
            c.setAttribute('fill', shape.color);
            layer.appendChild(c);
            break;
        }
        case 'cliff': {
            const poly = svgEl('polyline');
            poly.setAttribute('points', shape.polyline.map(v => `${v.x},${v.y}`).join(' '));
            poly.setAttribute('fill', 'none');
            poly.setAttribute('stroke', shape.color);
            poly.setAttribute('stroke-width', '5');
            poly.setAttribute('stroke-linejoin', 'round');
            poly.setAttribute('stroke-linecap', 'round');
            layer.appendChild(poly);
            // Hatches on one side
            for (let i = 0; i < shape.polyline.length - 1; i++) {
                const a = shape.polyline[i], b = shape.polyline[i + 1];
                const dx = b.x - a.x, dy = b.y - a.y;
                const len = Math.hypot(dx, dy);
                const ux = dx / len, uy = dy / len;
                const step = 12;
                for (let t = step / 2; t < len; t += step) {
                    const px = a.x + ux * t, py = a.y + uy * t;
                    const tk = svgEl('line');
                    tk.setAttribute('x1', px); tk.setAttribute('y1', py);
                    tk.setAttribute('x2', px - uy * 8); tk.setAttribute('y2', py + ux * 8);
                    tk.setAttribute('stroke', shape.color);
                    tk.setAttribute('stroke-width', '2');
                    layer.appendChild(tk);
                }
            }
            break;
        }
    }
}

function drawFenceTicks(layer, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const step = 16;
    for (let t = step / 2; t < len; t += step) {
        const px = a.x + ux * t, py = a.y + uy * t;
        // X-mark for crossable fence: two short crossed lines
        const tk = svgEl('line');
        tk.setAttribute('x1', px - uy * 4); tk.setAttribute('y1', py + ux * 4);
        tk.setAttribute('x2', px + uy * 4); tk.setAttribute('y2', py - ux * 4);
        tk.setAttribute('stroke', '#000');
        tk.setAttribute('stroke-width', '1.5');
        layer.appendChild(tk);
    }
}

function drawControls(start, ziel) {
    const layer = layerEl('rp-control-layer');
    const radius = controlRadiusForScene();
    const gap = controlGapForScene();
    const strokeWidth = controlStrokeWidthForScene();
    // Use the same draw routines as regular play mode: two equal circles +
    // a straight connection line (no arrow, no dashed line).
    [start, ziel].forEach(pt => {
        const c = svgEl('circle');
        c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); c.setAttribute('r', radius);
        c.setAttribute('fill', 'transparent');
        c.setAttribute('stroke', CONTROL_COLOR);
        c.setAttribute('stroke-width', strokeWidth);
        c.setAttribute('opacity', CONTROL_OPACITY);
        layer.appendChild(c);
    });

    const dx  = ziel.x - start.x;
    const dy  = ziel.y - start.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 2 * (radius + gap)) return;

    const angle  = Math.atan2(dy, dx);
    const offset = radius + gap;
    const line = svgEl('line');
    line.setAttribute('x1', start.x + Math.cos(angle) * offset);
    line.setAttribute('y1', start.y + Math.sin(angle) * offset);
    line.setAttribute('x2', ziel.x  - Math.cos(angle) * offset);
    line.setAttribute('y2', ziel.y  - Math.sin(angle) * offset);
    line.setAttribute('stroke', CONTROL_COLOR);
    line.setAttribute('stroke-width', strokeWidth);
    line.setAttribute('fill', 'none');
    line.setAttribute('opacity', CONTROL_OPACITY);
    layer.appendChild(line);
}

function formatTimeDelta(diffSec) {
    if (diffSec < 60) return `+${diffSec.toFixed(1)}s`;
    const m = Math.floor(diffSec / 60);
    const s = diffSec % 60;
    return `+${m}:${String(s.toFixed(1)).padStart(2, '0')}`;
}

function formatTime(sec) {
    if (sec == null || isNaN(sec)) return '-';
    if (sec < 60) return `${sec.toFixed(0)}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s.toFixed(0)).padStart(2, '0')}`;
}

function initStatsPanel() {
    const bar = document.getElementById('play-btn-bar');
    if (!bar) return;

    bar.addEventListener('click', e => {
        if (phase !== 'reveal' || !scene) return;
        if (e.target.closest('.play-btn')) return;
        if (performance.now() < suppressStatsToggleUntil) return;

        if (statsVisible) {
            hideStatsPanel();
        } else {
            renderStatsPanel({ routes: scene.routes, meta: scene.meta, kind: scene.kind });
        }
    });
}

function hideStatsPanel() {
    statsVisible = false;
    const panel = document.getElementById('play-stats-panel');
    if (panel) panel.classList.remove('visible');
}

function renderStatsPanel(cp) {
    const panel = document.getElementById('play-stats-panel');
    if (!panel) return;
    panel.innerHTML = '';

    const sorted = cp.routes
        .map((route, i) => ({ route, i }))
        .sort((a, b) => (a.route.pos ?? Infinity) - (b.route.pos ?? Infinity));

    const isDesktop = document.body.classList.contains('desktop');
    const stacked = !isDesktop && sorted.length > 3;

    if (lastChoiceTimes) {
        const t = lastChoiceTimes;
        const ICON_CLOCK = window.icon ? window.icon('clock', '0.9em') : '';
        const ICON_HOUR = window.icon ? window.icon('hourglass', '0.9em') : '';
        const header = document.createElement('div');
        header.id = 'play-stats-header';
        header.innerHTML =
            `<span class="stats-choice-total"><span class="stats-icon">${ICON_CLOCK}</span>${(t.total).toFixed(2)}s</span>` +
            `<span class="stats-choice-sub"><span class="stats-icon">${ICON_HOUR}</span>+${(t.penalty).toFixed(2)}s</span>`;
        panel.appendChild(header);
    }

    const inner = document.createElement('div');
    inner.id = 'play-stats-inner';
    if (stacked) inner.classList.add('stacked');

    const row = (label, value) =>
        `<span class="stats-row"><span class="stats-label">${label}</span><span class="stats-value">${value}</span></span>`;

    sorted.forEach(({ route, i }) => {
        const distTime = route.length ? (route.length / RUN_SPEED).toFixed(1) : null;
        const noATime = route.noA ? route.noA.toFixed(1) : '0';
        const obstacleTime = Number(route.obstacle).toFixed(1) || '0';
        const showObstacle = Number(obstacleTime) > 0;
        const showCorners = Number(noATime) > 0;

        const lengthStr = route.length ? `${route.length.toFixed(0)}m` : '-';
        const ICON_OBSTACLE = window.icon ? window.icon('obstacle', '0.9em') : '';
        const ICON_ANGLE = window.icon ? window.icon('angle', '1em') : '';
        const obstacleLabel = `<span class="stats-icon">${ICON_OBSTACLE}</span>:`;
        const noALabel = `<span class="stats-icon">${ICON_ANGLE}</span>${noATime}:`;

        const col = document.createElement('div');
        col.className = 'stats-col';
        col.style.borderColor = ROUTE_COLORS[i] || '#888';
        col.innerHTML =
            `<span class="stats-total">${formatTime(route.run_time)}</span>` +
            row(`${lengthStr}:`, distTime == null ? '+0.0s' : `+${distTime}s`) +
            (showObstacle ? row(obstacleLabel, `+${obstacleTime}s`) : '') +
            (showCorners ? row(noALabel, `+${noATime}s`) : '');
        inner.appendChild(col);
    });

    panel.appendChild(inner);
    statsVisible = true;
    panel.classList.add('visible');
}

function initReportButton() {
    const btn = SVG('rp-report-btn');
    if (!btn) return;
    ensureHudActionButtons(btn);
    btn.addEventListener('click', () => {
        confirmRouteReport()
            .then(confirmed => {
                if (!confirmed) return;
                return reportCurrentRoute();
            })
            .catch(err => console.error('report-infinite-route failed:', err));
    });
    updateReportButton();
}

function ensureHudActionButtons(reportBtn) {
    const hud = SVG('rp-hud');
    if (!hud || SVG('rp-home-btn')) return;

    let actions = SVG('rp-hud-actions');
    if (!actions) {
        actions = document.createElement('div');
        actions.id = 'rp-hud-actions';
        actions.style.justifySelf = 'end';
        actions.style.display = 'inline-flex';
        actions.style.alignItems = 'center';
        actions.style.gap = '6px';
        reportBtn.replaceWith(actions);
        actions.appendChild(reportBtn);
        reportBtn.style.justifySelf = 'auto';
    }

    const homeLabel = typeof gettext === 'function' ? gettext('Home') : 'Home';
    const homeBtn = document.createElement('a');
    homeBtn.id = 'rp-home-btn';
    homeBtn.className = 'rp-report-btn';
    homeBtn.href = '/';
    homeBtn.title = homeLabel;
    homeBtn.setAttribute('aria-label', homeLabel);
    homeBtn.style.justifySelf = 'auto';
    homeBtn.style.textDecoration = 'none';
    homeBtn.innerHTML = '<x-icon name="home" size="20px"></x-icon>';
    actions.appendChild(homeBtn);
}

function updateReportButton() {
    const btn = SVG('rp-report-btn');
    if (!btn) return;
    btn.disabled = reportingRoute || confirmingRouteReport || !['choose', 'reveal'].includes(phase) || !scene;
}

function ensureReportModal() {
    let modal = SVG('rp-report-modal');
    if (modal) return modal;

    const reportTitle = typeof gettext === 'function' ? gettext('Report route') : 'Report route';
    const reportText = typeof gettext === 'function'
        ? gettext('Please only report significant mistakes, slightly imperfect routes can happen.')
        : 'Please only report significant mistakes, slightly imperfect routes can happen.';
    const cancelLabel = typeof gettext === 'function' ? gettext('Cancel') : 'Cancel';
    const sendLabel = typeof gettext === 'function' ? gettext('Send') : 'Send';

    modal = document.createElement('div');
    modal.id = 'rp-report-modal';
    modal.className = 'rp-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'rp-report-modal-title');

    const card = document.createElement('div');
    card.className = 'rp-modal-card';

    const title = document.createElement('h2');
    title.id = 'rp-report-modal-title';
    title.textContent = reportTitle;

    const text = document.createElement('p');
    text.textContent = reportText;

    const actions = document.createElement('div');
    actions.className = 'rp-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'rp-modal-btn rp-modal-btn-secondary';
    cancelBtn.type = 'button';
    cancelBtn.dataset.reportCancel = '';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'rp-modal-btn rp-modal-btn-primary';
    confirmBtn.type = 'button';
    confirmBtn.dataset.reportConfirm = '';
    confirmBtn.textContent = sendLabel;

    actions.append(cancelBtn, confirmBtn);
    card.append(title, text, actions);
    modal.appendChild(card);
    document.body.appendChild(modal);
    return modal;
}

function confirmRouteReport() {
    if (reportingRoute || confirmingRouteReport || !['choose', 'reveal'].includes(phase) || !scene) {
        return Promise.resolve(false);
    }

    const modal = ensureReportModal();
    const confirmBtn = modal.querySelector('[data-report-confirm]');
    const cancelBtn = modal.querySelector('[data-report-cancel]');

    confirmingRouteReport = true;
    updateReportButton();
    modal.classList.add('open');
    confirmBtn?.focus();

    return new Promise(resolve => {
        let done = false;
        const close = confirmed => {
            if (done) return;
            done = true;
            modal.classList.remove('open');
            modal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKey);
            confirmBtn?.removeEventListener('click', onConfirm);
            cancelBtn?.removeEventListener('click', onCancel);
            confirmingRouteReport = false;
            updateReportButton();
            resolve(confirmed);
        };
        const onConfirm = () => close(true);
        const onCancel = () => close(false);
        const onBackdrop = e => {
            if (e.target === modal) close(false);
        };
        const onKey = e => {
            if (e.key === 'Escape') close(false);
        };

        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
        confirmBtn?.addEventListener('click', onConfirm);
        cancelBtn?.addEventListener('click', onCancel);
    });
}

function showReportSentModal() {
    let modal = SVG('rp-report-sent-modal');
    if (!modal) {
        const sentLabel = typeof gettext === 'function' ? gettext('Report sent') : 'Report sent';
        modal = document.createElement('div');
        modal.id = 'rp-report-sent-modal';
        modal.className = 'rp-modal rp-success-modal';
        modal.setAttribute('role', 'status');
        modal.setAttribute('aria-live', 'polite');

        const card = document.createElement('div');
        card.className = 'rp-success-card';
        card.setAttribute('aria-label', sentLabel);
        card.innerHTML = '<x-icon name="check" size="96px"></x-icon>';
        modal.appendChild(card);
        document.body.appendChild(modal);
    }

    modal.classList.add('open');
    window.setTimeout(() => modal.classList.remove('open'), 1000);
}

function clonePoint(p) {
    return p && Number.isFinite(p.x) && Number.isFinite(p.y)
        ? { x: p.x, y: p.y }
        : null;
}

function clonePoints(points) {
    return (points || []).map(clonePoint).filter(Boolean);
}

function buildInfinityReportPayload() {
    const reportSeed = sceneSource === 'mask'
        ? Number(maskSource?.fileId ?? scene?.meta?.fileId)
        : Number(scene?.meta?.seed);
    if (!Number.isInteger(reportSeed) || reportSeed <= 0 || !scene.start || !scene.ziel) return null;
    const routeResult = scene.routeResult || {};
    return {
        // ReportedInfinity intentionally has no File FK. For uploaded-map
        // scenes the existing seed column stores File.id; /debug/infinity/
        // resolves a matching live file before falling back to city regen.
        seed: reportSeed,
        pair_index: scene.meta.pairIndex ?? scene.batchIndex ?? null,
        start: clonePoint(scene.start),
        goal: clonePoint(scene.ziel),
        map_metres_per_unit: mapMetresPerUnit(),
        settings: scene.meta.settings || {},
        route_indexes: routeResult.routeIndexes || [],
        routes: (scene.routes || []).map((route, index) => ({
            index,
            routeIndex: route.routeIndex ?? null,
            side: route.side ?? null,
            sideLabel: route.sideLabel ?? null,
            pos: route.pos ?? null,
            length: route.length ?? null,
            noA: route.noA ?? null,
            obstacle: route.obstacle ?? null,
            run_time: route.run_time ?? null,
            points: clonePoints(route.points),
        })),
        skipped_barriers: routeResult.skippedBarriers || [],
        route_result: {
            reason: routeResult.reason || null,
            blockFastest: !!routeResult.blockFastest,
            routeIndexes: routeResult.routeIndexes || [],
            routeLengthSlots: routeResult.routeLengthSlots || [],
            routeRuntimeSlots: routeResult.routeRuntimeSlots || [],
            routeNoASlots: routeResult.routeNoASlots || [],
            routeSideSlots: routeResult.routeSideSlots || [],
            routeSideLabelSlots: routeResult.routeSideLabelSlots || [],
        },
        client_state: {
            mapScale: scene.mapScale ?? null,
            mapTx: scene.mapTx ?? null,
            mapTy: scene.mapTy ?? null,
            batchIndex: scene.batchIndex ?? null,
            cityBounds: scene.city?.bounds || null,
            camera: { x: cam.x, y: cam.y, scale: cam.scale, rot: cam.rot },
        },
    };
}

async function reportCurrentRoute() {
    if (reportingRoute || !['choose', 'reveal'].includes(phase) || !scene) return;
    const payload = buildInfinityReportPayload();
    if (!payload) return;

    reportingRoute = true;
    updateReportButton();
    try {
        const data = await submitRouteReport(payload);
        applyServerChoiceCount(data?.choice_count);
        showReportSentModal();
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        next();
    } finally {
        reportingRoute = false;
        updateReportButton();
    }
}

/* =========================================================
   CHOICE FLOW + PLAY-MODE-STYLE ANIMATION
========================================================= */

function renderChoiceButtons() {
    const bar = SVG('play-btn-bar');
    bar.innerHTML = '';

    const isDesktop = document.body.classList.contains('desktop');
    const fontSize = isDesktop
        ? `${Math.min(28, Math.max(14, Math.round(56 / 2)))}px`
        : `${Math.min(22, Math.max(8,  Math.round(44 / 2)))}px`;

    // Buttons in play-mode style (route-btn route-btn-labeled)
    scene.routes.forEach((r, i) => {
        const btn = document.createElement('button');
        btn.className = 'play-btn route-btn route-btn-labeled';
        btn.style.background = ROUTE_COLORS[i];
        btn.style.fontSize   = fontSize;
        btn.dataset.idx = i;

        const label = document.createElement('span');
        label.className = 'play-btn-label';
        label.textContent = i === 0 ? gettext('Left') : gettext('Right');
        btn.appendChild(label);

        btn.addEventListener('click', () => pickSide(i));
        bar.appendChild(btn);
    });
}

function pickSide(idx) {
    if (phase !== 'choose') return;
    phase = 'reveal';
    updateReportButton();

    // Match normal play: cap idle time from an abandoned tab before it reaches
    // either the HUD or the server. The server enforces the same ceiling.
    const choiceTime = Math.min(
        (performance.now() - choiceStartTime) / 1000,
        MAX_CHOICE_TIME,
    );
    const chosen     = scene.routes[idx];
    const other      = scene.routes[1 - idx];
    lastChoiceTimes = { total: choiceTime, real: choiceTime, penalty: 0 };
    suppressStatsToggleUntil = performance.now() + STATS_TOGGLE_SUPPRESS_MS;

    // Disable buttons; mark which one was clicked
    const buttons = SVG('play-btn-bar').querySelectorAll('.play-btn');
    buttons.forEach((b, i) => {
        b.disabled = true;
        if (i === idx) b.classList.add('active');
    });

    // Determine which route is faster by editor-style runtime.
    const chosenTime = chosen.run_time;
    const otherTime = other.run_time;
    const shorter = chosenTime <= otherTime ? chosen : other;
    const longer  = chosenTime >  otherTime ? chosen : other;
    const correctIdx = chosenTime <= otherTime ? idx : 1 - idx;
    const slowerIdx  = correctIdx === 0 ? 1 : 0;
    const isCorrect  = idx === correctIdx;
    const diffSec    = longer.run_time - shorter.run_time;

    // Replace the original Links/Rechts label with the crown (correct) and
    // the +X% / +Ys delta (slower). Layout is identical for both — the same
    // .play-btn-label slot is reused so the text simply gets swapped out.
    const correctLabel = buttons[correctIdx].querySelector('.play-btn-label');
    if (correctLabel) {
        correctLabel.innerHTML = window.icon ? window.icon('crown', '1.6em') : '';
        correctLabel.classList.add('rp-btn-crown');
    }
    buttons[correctIdx].classList.add('route-btn-fastest');

    const slowerLabel = buttons[slowerIdx].querySelector('.play-btn-label');
    if (slowerLabel && diffSec > 0) {
        slowerLabel.innerHTML =
            `<span class="route-btn-delta-rel">+${Math.round((diffSec / shorter.run_time) * 100)}%</span>` +
            `<span class="route-btn-delta-abs">${formatTimeDelta(diffSec)}</span>`;
        slowerLabel.classList.add('route-btn-delta');
    }

    // Animate routes (play.js dot-and-trail style, both routes in parallel)
    animateRoutes(idx);

    // Stats update — flame goes orange when a new record is set
    let newRecord = false;
    if (isCorrect) {
        stats.correct++;
        stats.streak++;
        if (stats.streak > stats.bestStreak) {
            stats.bestStreak = stats.streak;
            newRecord = true;
        }
    } else {
        stats.streak = 0;
    }
    saveStats();
    renderHud({ choiceTime, newRecord });

    // Submit to DB
    submitChoice({
        correct:      isCorrect,
        choice_time:  choiceTime,
        shorter_time: shorter.run_time,
        longer_time:  longer.run_time,
        file_id:      sceneSource === 'mask' ? (maskSource?.fileId ?? null) : null,
    });
}

function animateRoutes(chosenIdx) {
    const layer = SVG('rp-route-layer');
    layer.innerHTML = '';

    const validTimes = scene.routes.map(r => r.run_time).filter(t => t > 0);
    const minTime    = validTimes.length ? Math.min(...validTimes) : 1;

    const anims = scene.routes.map((route, i) => {
        const rP = route.points;
        if (!rP || rP.length < 2) return null;

        const dists = [0];
        for (let j = 1; j < rP.length; j++)
            dists.push(dists[j - 1] + Math.hypot(rP[j].x - rP[j - 1].x, rP[j].y - rP[j - 1].y));
        const totalDist = dists[dists.length - 1];

        const ratio    = route.run_time > 0 ? route.run_time / minTime : 1;
        const excess   = ratio - 1;
        const amp      = 5 - 4 * Math.min(excess, 1);
        const duration = 1 + excess * amp;        // seconds

        const color = ROUTE_COLORS[i];

        // Same route presentation as normal play: white background trail and
        // colored foreground trail with adaptive zoom-aware stroke widths.
        const bgTrail = svgEl('polyline');
        bgTrail.setAttribute('fill', 'none');
        bgTrail.setAttribute('stroke', 'white');
        setAdaptiveRouteStroke(bgTrail, ROUTE_BACKGROUND_STROKE_WIDTH);
        bgTrail.setAttribute('stroke-linecap', 'round');
        bgTrail.setAttribute('stroke-linejoin', 'round');
        bgTrail.setAttribute('vector-effect', 'non-scaling-stroke');
        bgTrail.setAttribute('points', `${rP[0].x},${rP[0].y}`);
        bgTrail.setAttribute('pointer-events', 'none');
        layer.appendChild(bgTrail);

        const trail = svgEl('polyline');
        trail.setAttribute('fill', 'none');
        trail.setAttribute('stroke', color);
        setAdaptiveRouteStroke(trail, ROUTE_FOREGROUND_STROKE_WIDTH);
        trail.setAttribute('stroke-linecap',  'round');
        trail.setAttribute('stroke-linejoin', 'round');
        trail.setAttribute('points', `${rP[0].x},${rP[0].y}`);
        trail.setAttribute('vector-effect', 'non-scaling-stroke');
        trail.setAttribute('opacity', '1');
        layer.appendChild(trail);

        const dot = svgEl('circle');
        dot.setAttribute('r', ROUTE_DOT_SURFACE_RADIUS / (scene?.mapScale || 1));
        dot.setAttribute('fill', color);
        dot.setAttribute('cx', rP[0].x);
        dot.setAttribute('cy', rP[0].y);
        dot.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(dot);

        return { rP, dists, totalDist, duration, color, bgTrail, trail, dot, i, done: false };
    }).filter(Boolean);

    drawRouteBlocks(layer);

    const t0 = performance.now();
    if (_routeAnim) cancelAnimationFrame(_routeAnim);

    (function tick(now) {
        const elapsed = (now - t0) / 1000;
        let allDone = true;

        anims.forEach(anim => {
            if (anim.done) return;
            const { rP, dists, totalDist, duration, bgTrail, trail, dot } = anim;

            const dist = Math.min((elapsed / duration) * totalDist, totalDist);
            let seg = dists.length - 2;
            for (let j = 1; j < dists.length; j++) {
                if (dists[j] >= dist) { seg = j - 1; break; }
            }
            const segLen = (dists[seg + 1] ?? totalDist) - dists[seg];
            const segT   = segLen > 0 ? (dist - dists[seg]) / segLen : 1;
            const p0 = rP[seg], p1 = rP[Math.min(seg + 1, rP.length - 1)];
            const cx = p0.x + (p1.x - p0.x) * segT;
            const cy = p0.y + (p1.y - p0.y) * segT;

            dot.setAttribute('cx', cx);
            dot.setAttribute('cy', cy);

            const pts = rP.slice(0, seg + 1).map(p => `${p.x},${p.y}`);
            if (segT > 0) pts.push(`${cx},${cy}`);
            const trailPoints = pts.join(' ');
            bgTrail.setAttribute('points', trailPoints);
            trail.setAttribute('points', trailPoints);

            if (dist >= totalDist) {
                anim.done = true;
                dot.remove();
                emitWave(rP[rP.length - 1], anim.color);
            } else {
                allDone = false;
            }
        });

        if (!allDone) _routeAnim = requestAnimationFrame(tick);
        else _routeAnim = null;
    })(t0);
}

function emitWave(pos, color) {
    const layer = SVG('rp-control-layer');
    const radius = controlRadiusForScene();
    const c = svgEl('circle');
    c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y); c.setAttribute('r', radius);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', color);
    c.setAttribute('stroke-width', controlWaveStrokeWidthForScene());
    c.setAttribute('opacity', '0.85');
    c.style.filter = 'blur(4px)';
    layer.appendChild(c);
    const start = performance.now();
    (function step(now) {
        const t = Math.min((now - start) / 1800, 1);
        const e = 1 - Math.pow(1 - t, 2);
        c.setAttribute('r',       radius + (radius * 1.6) * e);
        c.setAttribute('opacity', (1 - e) * 0.85);
        if (t < 1) requestAnimationFrame(step);
        else c.remove();
    })(start);
}

/* =========================================================
   FEEDBACK + STATS + DB
========================================================= */

function loadStats() {
    try {
        const o = JSON.parse(localStorage.getItem('rpStats') || '{}');
        return {
            attempts:   0,
            correct:    o.correct    || 0,
            streak:     o.streak     || 0,
            bestStreak: o.bestStreak || 0,
        };
    } catch { return { attempts: 0, correct: 0, streak: 0, bestStreak: 0 }; }
}
function saveStats() {
    try { localStorage.setItem('rpStats', JSON.stringify(stats)); } catch {}
}

function renderHud(opts = {}) {
    const attemptsEl = SVG('rp-attempts');
    const streakEl   = SVG('rp-streak');
    const flameEl    = SVG('rp-flame');
    const choiceEl   = SVG('rp-choice-time');
    if (attemptsEl) attemptsEl.textContent = stats.attempts;
    if (streakEl)   streakEl.textContent   = stats.streak;
    if (flameEl) {
        // Orange flame when the current streak just broke the previous record
        const onFire = !!opts.newRecord;
        flameEl.classList.toggle('is-record', onFire);
        // Also stay orange while the current streak == best (record is alive)
        if (!onFire && stats.streak > 0 && stats.streak === stats.bestStreak) {
            flameEl.classList.add('is-record');
        }
    }
    if (choiceEl && opts.choiceTime !== undefined) {
        const clockIcon = window.icon ? window.icon('clock', '0.9em') : '';
        choiceEl.innerHTML = `${clockIcon}<span>${opts.choiceTime.toFixed(2)}s</span>`;
    }
}

function applyServerChoiceCount(choiceCount) {
    const count = Number(choiceCount);
    if (!Number.isFinite(count)) return;
    stats.attempts = Math.max(0, Math.trunc(count));
    renderHud();
}

async function refreshInfiniteUserStats() {
    try {
        const res = await fetch('/play/infinity/user-stats/', {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        applyServerChoiceCount(data?.choice_count);
    } catch (err) {
        console.warn('failed to load infinite user stats:', err);
    }
}

function submitChoice(payload) {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? '';
    fetch('/play/infinity/submit-choice/', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
        body:    JSON.stringify(payload),
    })
        .then(async res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            applyServerChoiceCount(data?.choice_count);
        })
        .catch(err => console.error('submit-infinite-choice failed:', err));
}

async function submitRouteReport(payload) {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? '';
    const res = await fetch('/play/infinity/report-route/', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
        body:    JSON.stringify(payload),
    });
    if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
            const data = await res.json();
            if (data?.error) message = data.error;
        } catch {}
        throw new Error(message);
    }
    return res.json();
}
