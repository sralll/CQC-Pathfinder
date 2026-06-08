/* =========================================================
   PLAY MODE
========================================================= */

/* =========================================================
   STATE
========================================================= */

const urlParts        = window.location.pathname.split('/').filter(Boolean);
const fileId          = urlParts[urlParts.length - 2];   // /play/<id>/<mode>/
const competitionMode = urlParts[urlParts.length - 1] === 'competition';
document.body.classList.toggle('training-mode', !competitionMode);

let cam = { x: 0, y: 0, scale: 1, rot: 0 };   // rot in degrees (CSS convention)
let project = {
    id:            null,
    name:          '',
    scale:         null,
    scaled:        false,
    map_file:        '',
    blocked_terrain: null,   // { lines: [{start,end}], areas: [{points}] }
    control_pairs:   [],     // [{ id, order, start, ziel, complex, routes: [{ id, order, rP, noA, pos, length, run_time, elevation }] }]
};
let applyTransform = () => {};

const R_CONTROL  = 25;
const GAP        = 8;
const MIN_ZOOM   = 0.2;
const MAX_ZOOM   = 8;
const RUN_SPEED  = 4.75;   // m/s — flat-terrain reference speed
const routeColor = ['#DD0011', '#CC6000', '#008888', '#0055FF', '#5500BB', '#8800CC'];

let currentCpIndex    = -1;
let camBounds         = null;   // { minRX, maxRX, minRY, maxRY, minScale } in rotated space; null during animation
let currentRouteColors = [];    // colors[i] for cp.routes[i]
let selectedRouteIdx   = null;  // index into cp.routes, or null for all
let choiceStartTime    = null;  // performance.now() when routes became visible
let buttonsDisabled    = false; // true after first submission for this CP
let currentBtnFontSize = '12px'; // kept in sync with renderAllButtons for stats panel
let replayMode         = false; // true → all CPs already done, no DB writes

/* =========================================================
   INIT
========================================================= */

document.addEventListener('DOMContentLoaded', () => {
    initCamera();
    loadFile();
    initKeyNav();
    initStatsPanel();
});

function canAdvance() {
    const last = project.control_pairs.length - 1;
    return buttonsDisabled && currentCpIndex >= 0 && currentCpIndex < last;
}

// Last CP has been answered; user is trying to go to the next one
function isFinished() {
    const last = project.control_pairs.length - 1;
    return buttonsDisabled && currentCpIndex === last;
}

function tryAdvance() {
    if (canAdvance()) {
        showControlPair(currentCpIndex + 1);
    } else if (isFinished()) {
        showEndOfFileModal();
    }
}

function showEndOfFileModal() {
    let modal = document.getElementById('play-end-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'play-end-modal';
        modal.innerHTML = `
            <div class="play-end-card">
                <h3 class="play-end-title">Projekt abgeschlossen</h3>
                <p class="play-end-sub">Was möchtest du als nächstes tun?</p>
                <div class="play-end-actions">
                    <a class="play-end-btn"           href="/results/${fileId}/">Resultate ansehen</a>
                    <a class="play-end-btn secondary" href="/play/">Zurück zur Projektliste</a>
                    <a class="play-end-btn secondary" href="/">Startseite</a>
                </div>
            </div>`;
        document.body.appendChild(modal);
        // Close on backdrop click
        modal.addEventListener('click', e => {
            if (e.target === modal) modal.classList.remove('open');
        });
    }
    modal.classList.add('open');
}

function initKeyNav() {
    const container = document.getElementById('map-container');

    // ── Desktop: spacebar / enter ────────────────────────────
    document.addEventListener('keydown', e => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            tryAdvance();
        }
    });

    // ── Desktop: double-click on map ─────────────────────────
    container.addEventListener('dblclick', () => {
        tryAdvance();
    });

    // ── Mobile: swipe right-to-left on map ───────────────────
    let swipeStartX = null;
    let swipeStartY = null;
    const SWIPE_MIN_X = 60;   // minimum horizontal distance px
    const SWIPE_MAX_Y = 40;   // maximum vertical drift px

    container.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) { swipeStartX = null; return; }
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
    }, { passive: true });

    container.addEventListener('touchend', e => {
        if (swipeStartX === null) return;
        const dx = e.changedTouches[0].clientX - swipeStartX;
        const dy = e.changedTouches[0].clientY - swipeStartY;
        swipeStartX = null;
        if (dx < -SWIPE_MIN_X && Math.abs(dy) < SWIPE_MAX_Y) {
            tryAdvance();
        }
    }, { passive: true });
}

async function loadFile() {
    showMapSpinner();
    try {
        const res = await fetch(`/play/get-file/${fileId}/`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        project.id            = data.id;
        project.name          = data.name;
        project.scale         = data.scale;
        project.scaled        = data.scaled;
        project.map_file        = data.map_file;
        project.blocked_terrain = data.blocked_terrain;
        project.control_pairs   = data.control_pairs;
        replayMode              = !!data.replay;
        document.body.classList.toggle('replay-mode', replayMode);
        // Any prior results in the DB → grey progress bar, regardless of mode
        document.body.classList.toggle('has-prior-results', (data.done_cp_count || 0) > 0);
        await loadMap(project.map_file);
        const isDesktop  = document.body.classList.contains('desktop');
        const readyFontSize = isDesktop
            ? `${Math.min(28, Math.max(14, Math.round(56 / 1)))}px`
            : `${Math.min(22, Math.max(8,  Math.round(44 / 1)))}px`;
        // First-button label hints the play mode:
        //   replay      → "Wiedergabe?" (no save)
        //   resuming    → "Weiter?"     (continuing a 'begonnen' run)
        //   first play  → "Bereit?"
        let firstLabel = 'Bereit?';
        if (replayMode)                       firstLabel = 'Wiedergabe?';
        else if ((data.done_cp_count || 0) > 0) firstLabel = 'Weiter?';
        renderButtons([{
            label:    firstLabel,
            cls:      'route-btn route-btn-labeled',
            bgColor:  replayMode ? '#666' : '#e07020',
            fontSize: readyFontSize,
            action:   () => showControlPair(0),
        }]);
    } catch (e) {
        console.error('loadFile failed:', e);
    } finally {
        hideMapSpinner();
    }
}

function loadMap(filename) {
    return new Promise((resolve, reject) => {
        const img = document.getElementById('map-img');
        img.onload = () => {
            applyProjectScale();
            drawBlockedTerrain();
            const s = project.scale || 1;
            fitCamera(img.naturalWidth * s, img.naturalHeight * s);
            resolve();
        };
        img.onerror = reject;
        img.src = `/play/get-map/${filename}/`;
    });
}

function applyProjectScale() {
    const scaleLayer = document.getElementById('map-scale-layer');
    scaleLayer.style.transform       = `scale(${project.scale || 1})`;
    scaleLayer.style.transformOrigin = 'top left';
}

function fitCamera(imgW, imgH) {
    const container = document.getElementById('map-container');
    const cw    = container.clientWidth;
    const ch    = container.clientHeight;
    const scale = imgW > 0 && imgH > 0 ? Math.min(cw / imgW, ch / imgH) : 1;
    cam.rot   = 0;
    cam.x     = (cw - imgW * scale) / 2;
    cam.y     = (ch - imgH * scale) / 2;
    cam.scale = Math.max(scale, 1e-6);  // never zero — prevents division by zero in animateCam
    applyTransform();
}

/* =========================================================
   CAMERA  (pan + pinch-zoom, mirrors editor behaviour)
========================================================= */

function clampCam() {
    if (!camBounds) return;
    const container = document.getElementById('map-container');
    const cw = container.clientWidth;
    const ch = container.clientHeight;

    // Scale: no zooming out past the calculated minimum
    cam.scale = Math.min(Math.max(cam.scale, camBounds.minScale), MAX_ZOOM);
    const s = cam.scale;

    // cam.x bounds: screen must stay within [minRX, maxRX] in rotated space.
    // Screen left  (x=0)  → rotated X = -cam.x / s  ≥ minRX  → cam.x ≤ -minRX·s
    // Screen right (x=cw) → rotated X = (cw-cam.x)/s ≤ maxRX → cam.x ≥ cw-maxRX·s
    const xHi = -camBounds.minRX * s;
    const xLo =  cw - camBounds.maxRX * s;
    cam.x = (xLo > xHi) ? (xLo + xHi) / 2          // content narrower than screen: centre
                         : Math.min(xHi, Math.max(xLo, cam.x));

    // cam.y bounds: same logic for vertical axis
    const yHi = -camBounds.minRY * s;
    const yLo =  ch - camBounds.maxRY * s;
    cam.y = (yLo > yHi) ? (yLo + yHi) / 2
                         : Math.min(yHi, Math.max(yLo, cam.y));
}

function initCamera() {
    const container = document.getElementById('map-container');
    const camera    = document.getElementById('camera');

    let drag = null;
    let lastPinchDist = null;

    applyTransform = () => {
        if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.scale) || !isFinite(cam.rot)) return;
        camera.style.transform =
            `translate(${cam.x}px, ${cam.y}px) rotate(${cam.rot}deg) scale(${cam.scale})`;
    };

    // ── Mouse ────────────────────────────────────────────
    container.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        drag = { startX: e.clientX - cam.x, startY: e.clientY - cam.y };
        container.classList.add('panning');
    });

    window.addEventListener('mousemove', e => {
        if (!drag) return;
        cam.x = e.clientX - drag.startX;
        cam.y = e.clientY - drag.startY;
        clampCam();
        applyTransform();
    });

    window.addEventListener('mouseup', () => {
        drag = null;
        container.classList.remove('panning');
    });

    container.addEventListener('wheel', e => {
        e.preventDefault();
        const rawFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale  = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.scale * rawFactor));
        const factor    = newScale / cam.scale;
        const rect      = container.getBoundingClientRect();
        const mx        = e.clientX - rect.left;
        const my        = e.clientY - rect.top;
        cam.x     = mx - (mx - cam.x) * factor;
        cam.y     = my - (my - cam.y) * factor;
        cam.scale = newScale;
        clampCam();
        applyTransform();
    }, { passive: false });

    // ── Touch ────────────────────────────────────────────
    container.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
            drag = { startX: e.touches[0].clientX - cam.x, startY: e.touches[0].clientY - cam.y };
            lastPinchDist = null;
        } else if (e.touches.length === 2) {
            drag = null;
            lastPinchDist = pinchDist(e.touches);
        }
    }, { passive: true });

    container.addEventListener('touchmove', e => {
        e.preventDefault();
        if (e.touches.length === 1 && drag) {
            cam.x = e.touches[0].clientX - drag.startX;
            cam.y = e.touches[0].clientY - drag.startY;
        } else if (e.touches.length === 2 && lastPinchDist !== null) {
            const dist     = pinchDist(e.touches);
            const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.scale * dist / lastPinchDist));
            const factor   = newScale / cam.scale;
            const mx       = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const my       = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const rect     = container.getBoundingClientRect();
            const cx       = mx - rect.left;
            const cy       = my - rect.top;
            cam.x     = cx - (cx - cam.x) * factor;
            cam.y     = cy - (cy - cam.y) * factor;
            cam.scale = newScale;
            lastPinchDist = dist;
        }
        clampCam();
        applyTransform();
    }, { passive: false });

    container.addEventListener('touchend', e => {
        if (e.touches.length < 2) lastPinchDist = null;
        if (e.touches.length === 0) drag = null;
    }, { passive: true });
}

function pinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
}

/* =========================================================
   BLOCKED TERRAIN — DRAW
========================================================= */

const BLOCK_COLOR = 'rgb(160, 51, 240)';

function drawBlockedTerrain() {
    const layer = document.getElementById('blocked-layer');
    if (!layer) return;
    layer.innerHTML = '';
    const bt = project.blocked_terrain;
    if (!bt) return;

    (bt.lines || []).forEach(seg => {
        const vis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        vis.setAttribute('x1', seg.start.x); vis.setAttribute('y1', seg.start.y);
        vis.setAttribute('x2', seg.end.x);   vis.setAttribute('y2', seg.end.y);
        vis.setAttribute('stroke',       BLOCK_COLOR);
        vis.setAttribute('stroke-width', '5');
        vis.setAttribute('stroke-linecap', 'butt');
        vis.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(vis);
    });

    (bt.areas || []).forEach(area => {
        if (area.points.length < 3) return;
        const fill = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        fill.setAttribute('points',         area.points.map(p => `${p.x},${p.y}`).join(' '));
        fill.setAttribute('fill',           'url(#block-hatch)');
        fill.setAttribute('fill-opacity',   '1');
        fill.setAttribute('stroke',         BLOCK_COLOR);
        fill.setAttribute('stroke-width',   '1');
        fill.setAttribute('stroke-linejoin','miter');
        fill.setAttribute('vector-effect',  'non-scaling-stroke');
        fill.setAttribute('pointer-events', 'none');
        layer.appendChild(fill);
    });
}

/* =========================================================
   ROUTES — DRAW
========================================================= */

function createRoutePolyline(route, { stroke = 'black', strokeWidth = 1.5, opacity = 1 } = {}) {
    if (!route?.rP || route.rP.length < 2) return null;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    el.setAttribute('points',           route.rP.map(p => `${p.x},${p.y}`).join(' '));
    el.setAttribute('fill',             'none');
    el.setAttribute('stroke',           stroke);
    el.setAttribute('stroke-width',     strokeWidth);
    el.setAttribute('stroke-linecap',   'round');
    el.setAttribute('stroke-linejoin',  'round');
    el.setAttribute('vector-effect',    'non-scaling-stroke');
    el.setAttribute('opacity',          String(opacity));
    el.setAttribute('pointer-events',   'none');
    return el;
}

function drawRoutes(cp) {
    const layer = document.getElementById('route-layer');
    layer.innerHTML = '';
    if (!cp?.routes?.length) return;
    if (!cp.complex) return;   // non-complex: routes not revealed on the map

    // Draw order: routeColor index ascending (FFFF00 bottom → 00FF00 top)
    // so less-visible colours are never buried under brighter ones
    const drawOrder = cp.routes
        .map((route, i) => ({ route, i }))
        .sort((a, b) =>
            routeColor.indexOf(currentRouteColors[a.i]) -
            routeColor.indexOf(currentRouteColors[b.i])
        );

    // White background pass
    drawOrder.forEach(({ route }) => {
        const el = createRoutePolyline(route, { stroke: 'white', strokeWidth: 3 });
        if (el) layer.appendChild(el);
    });

    // Colored foreground pass — dim unselected routes when one is selected
    drawOrder.forEach(({ route, i }) => {
        const color  = currentRouteColors[i] || '#000';
        const dimmed = selectedRouteIdx !== null && selectedRouteIdx !== i;
        const el = createRoutePolyline(route, {
            stroke: color, strokeWidth: 1.5, opacity: dimmed ? 0.2 : 1,
        });
        if (el) layer.appendChild(el);
    });
}

/* =========================================================
   CONTROL PAIR — DRAW
========================================================= */

function showControlPair(index) {
    const cp = project.control_pairs[index];
    if (!cp?.start || !cp?.ziel) return;
    currentCpIndex = index;

    // Cancel any running route animation from the previous CP
    if (_routeAnim) { cancelAnimationFrame(_routeAnim); _routeAnim = null; }

    // Hide stats panel
    hideStatsPanel();

    // Reset per-CP state and clear drawing layers
    camBounds          = null;
    selectedRouteIdx   = null;
    currentRouteColors = [];
    buttonsDisabled    = false;
    document.getElementById('route-layer').innerHTML   = '';
    document.getElementById('control-layer').innerHTML = '';

    // Rotation: start at bottom, ziel straight above
    const dx     = cp.ziel.x - cp.start.x;
    const dy     = cp.ziel.y - cp.start.y;
    const rotDeg = -90 - Math.atan2(dy, dx) * (180 / Math.PI);
    const R      = rotDeg * Math.PI / 180;
    const cosR   = Math.cos(R);
    const sinR   = Math.sin(R);

    const toRot = p => ({ rx: p.x * cosR - p.y * sinR, ry: p.x * sinR + p.y * cosR });

    // Route rP points; fall back to start/ziel if no routes yet
    const rPts = [];
    for (const route of cp.routes) {
        if (route.rP?.length) rPts.push(...route.rP);
    }
    const dataPts = rPts.length ? rPts : [cp.start, cp.ziel];
    const rotData = dataPts.map(toRot);

    let minRX = Math.min(...rotData.map(p => p.rx));
    let maxRX = Math.max(...rotData.map(p => p.rx));
    let minRY = Math.min(...rotData.map(p => p.ry));
    let maxRY = Math.max(...rotData.map(p => p.ry));

    // Expand to include start/ziel circles
    [cp.start, cp.ziel].forEach(pt => {
        if (!pt) return;
        const { rx, ry } = toRot(pt);
        minRX = Math.min(minRX, rx - R_CONTROL);
        maxRX = Math.max(maxRX, rx + R_CONTROL);
        minRY = Math.min(minRY, ry - R_CONTROL);
        maxRY = Math.max(maxRY, ry + R_CONTROL);
    });

    // Horizontal centre: startRX (= zielRX — same X after rotation by design)
    const startRX  = toRot(cp.start).rx;
    const centerRY = (minRY + maxRY) / 2;

    const container = document.getElementById('map-container');
    const cw = container.clientWidth;
    const ch = container.clientHeight;

    // Scale: 10 screen-pixel margin on every side, centred at startRX horizontally
    const PAD     = 10;
    const halfW   = Math.max(startRX - minRX, maxRX - startRX);  // widest half-extent from centre line
    const halfH   = (maxRY - minRY) / 2;
    const scaleX  = halfW > 0 ? (cw / 2 - PAD) / halfW : MAX_ZOOM;
    const scaleY  = halfH > 0 ? (ch / 2 - PAD) / halfH : MAX_ZOOM;
    const scale   = Math.min(scaleX, scaleY, MAX_ZOOM);

    // Map-space coordinates of camera centre (R⁻¹ · (startRX, centerRY))
    animateCam({
        rot:   rotDeg,
        scale: scale,
        cx:    startRX * cosR + centerRY * sinR,
        cy:   -startRX * sinR + centerRY * cosR,
    }, 1000, () => {
        // Bounds = full initial viewport in rotated space (user can zoom in + pan within)
        camBounds = {
            minRX: startRX - (cw / 2) / scale,
            maxRX: startRX + (cw / 2) / scale,
            minRY: centerRY - (ch / 2) / scale,
            maxRY: centerRY + (ch / 2) / scale,
            minScale: scale,
        };
        assignRouteColors(cp.routes);
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.classList.add('control-pair-group');
        drawControlPairCircles(cp, group);
        drawConnection(cp, group);
        document.getElementById('control-layer').appendChild(group);

        if (!competitionMode && cp.complex) {
            // Training mode: hide routes/buttons behind a reveal step first
            const isDesktop = document.body.classList.contains('desktop');
            const revealFontSize = isDesktop
                ? `${Math.min(28, Math.max(14, Math.round(56 / 1)))}px`
                : `${Math.min(22, Math.max(8,  Math.round(44 / 1)))}px`;
            renderButtons([{
                label:    'Routen anzeigen',
                cls:      'route-btn route-btn-labeled',
                bgColor:  '#e07020',
                fontSize: revealFontSize,
                action:   () => {
                    drawRoutes(cp);
                    choiceStartTime = performance.now();
                    renderAllButtons(cp);
                },
            }]);
        } else {
            drawRoutes(cp);
            choiceStartTime = performance.now();
            renderAllButtons(cp);
        }
    });

    renderNavButtons();  // show nav state immediately while animating
    updateProgressBar();
}

function assignRouteColors(routes) {
    // 1. Shuffle the colour palette
    const pool = [...routeColor];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    // 2. Sort route indices by pos (neighbours in pos-space get adjacent colours)
    const sorted = routes
        .map((r, i) => ({ i, pos: r.pos ?? Infinity }))
        .sort((a, b) => a.pos - b.pos);

    // 3. Assign cyclically — wrapping never repeats a neighbour because
    //    index k   → pool[k % 6]
    //    index k+1 → pool[(k+1) % 6]   ← always different for pool.length = 6
    currentRouteColors = new Array(routes.length);
    sorted.forEach(({ i }, rank) => {
        currentRouteColors[i] = pool[rank % pool.length];
    });
}

function renderNavButtons() {
    renderButtons([]);  // clear bar while animating
}

function updateProgressBar() {
    const fill  = document.getElementById('play-progress-fill');
    if (!fill) return;
    const total = project.control_pairs.length;
    const pct   = total > 0 ? ((currentCpIndex + 1) / total) * 100 : 0;
    fill.style.width = `${pct}%`;
}

function formatTimeDelta(diffSec) {
    if (diffSec < 60) return `+${Math.round(diffSec)}s`;
    const m = Math.floor(diffSec / 60);
    const s = Math.round(diffSec % 60);
    return `+${m}:${String(s).padStart(2, '0')}`;
}

function formatTime(sec) {
    if (sec == null || isNaN(sec)) return '–';
    if (sec < 60) return `${Math.round(sec)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

/* =========================================================
   STATS PANEL
========================================================= */

let statsVisible = false;

function initStatsPanel() {
    document.getElementById('play-btn-bar').addEventListener('click', e => {
        if (!buttonsDisabled || currentCpIndex < 0) return;
        // Ignore clicks that originated from a button (e.g. route choice) — only
        // react to direct taps on the bar background between / around the buttons.
        if (e.target.closest('.play-btn')) return;
        if (statsVisible) hideStatsPanel();
        else renderStatsPanel(project.control_pairs[currentCpIndex]);
    });
}

function hideStatsPanel() {
    statsVisible = false;
    const panel = document.getElementById('play-stats-panel');
    if (panel) panel.classList.remove('visible');
}

function renderStatsPanel(cp) {
    const panel = document.getElementById('play-stats-panel');
    panel.innerHTML = '';

    const sorted = cp.routes
        .map((route, i) => ({ route, i }))
        .sort((a, b) => (a.route.pos ?? Infinity) - (b.route.pos ?? Infinity));

    const isDesktop = document.body.classList.contains('desktop');
    const stacked   = !isDesktop && sorted.length > 3;

    const inner = document.createElement('div');
    inner.id = 'play-stats-inner';
    if (stacked) inner.classList.add('stacked');

    const row = (label, value) =>
        `<span class="stats-row"><span class="stats-label">${label}</span><span class="stats-value">${value}</span></span>`;

    sorted.forEach(({ route, i }) => {
        const distTime = route.length ? route.length / RUN_SPEED : null;
        const noATime  = route.noA || 0;
        // Elevation contribution = total minus flat-distance time.
        // noA is read directly from the stored JSON attribute — not recomputed —
        // so we don't subtract it here (older files may not have it baked into run_time).
        const elevTime = route.run_time != null && distTime != null
            ? route.run_time - distTime : null;

        const showElev    = !!route.elevation && elevTime != null && elevTime > 0.5;
        const showCorners = noATime > 0;

        const lengthStr = route.length    ? `${Math.round(route.length)}m`    : '–';
        const elevStr   = route.elevation ? `${Math.round(route.elevation)}m` : '–';
        const noALabel  = noATime === 1   ? '1 Ecke' : `${noATime} Ecken`;

        const col = document.createElement('div');
        col.className = 'stats-col';
        col.style.borderColor = currentRouteColors[i];
        col.innerHTML =
            `<span class="stats-total">${formatTime(route.run_time)}</span>` +
            row(`${lengthStr}:`, `+${formatTime(distTime)}`) +
            (showElev    ? row(`${elevStr}:`,    `+${formatTime(elevTime)}`) : '') +
            (showCorners ? row(`${noALabel}:`,   `+${noATime}s`)            : '');
        inner.appendChild(col);
    });

    panel.appendChild(inner);
    statsVisible = true;
    panel.classList.add('visible');
}

function renderAllButtons(cp) {
    // Sort routes by pos ascending (null/undefined sorts last)
    const sorted = cp.routes
        .map((route, i) => ({ route, i }))
        .sort((a, b) => (a.route.pos ?? Infinity) - (b.route.pos ?? Infinity));

    // After a choice is made, compute fastest route for performance feedback
    let fastestIdx = null;
    let minTime    = null;
    if (buttonsDisabled) {
        const timed = sorted.filter(({ route }) => route.run_time > 0);
        if (timed.length) {
            minTime    = Math.min(...timed.map(({ route }) => route.run_time));
            fastestIdx = timed.find(({ route }) => route.run_time === minTime)?.i ?? null;
        }
    }

    // For non-complex CPs: smaller pos = Links, larger pos = Rechts
    const minPos = cp.complex ? null : Math.min(...cp.routes.map(r => r.pos ?? Infinity));

    // Font size for all route buttons: larger when fewer (wider) buttons
    // Desktop has more horizontal space so the scaling is gentler
    const n           = sorted.length;
    const isDesktop   = document.body.classList.contains('desktop');
    const btnFontSize = isDesktop
        ? `${Math.min(28, Math.max(14, Math.round(56 / n)))}px`
        : `${Math.min(22, Math.max(8,  Math.round(44 / n)))}px`;
    currentBtnFontSize = btnFontSize;
    const twoLines = n >= 5;

    renderButtons(sorted.map(({ route, i }) => {
        let fastest = false;
        let delta   = null;
        if (buttonsDisabled && minTime !== null) {
            if (i === fastestIdx) {
                fastest = true;
            } else if (route.run_time > 0) {
                const diffSec = route.run_time - minTime;
                const relPct  = Math.round((diffSec / minTime) * 100);
                delta = { rel: `+${relPct}%`, abs: formatTimeDelta(diffSec), twoLines };
            }
        }
        return {
            bgColor:   currentRouteColors[i] || '#888',
            fontSize:  btnFontSize,
            cls:       cp.complex ? 'route-btn' : 'route-btn route-btn-labeled',
            label:    cp.complex ? undefined : (route.pos === minPos ? 'Links' : 'Rechts'),
            active:   selectedRouteIdx === i,
            disabled: buttonsDisabled,
            fastest,
            delta,
            action:  () => {
                if (buttonsDisabled) return;
                const selecting = selectedRouteIdx !== i;
                selectedRouteIdx = selecting ? i : null;
                if (selecting) {
                    buttonsDisabled = true;
                    renderAllButtons(cp);          // re-render disabled
                    submitResult(cp, cp.routes[i]);
                    animateRoutes(cp, i);
                } else {
                    drawRoutes(cp);
                    renderAllButtons(cp);
                }
            },
        };
    }));
}

/* =========================================================
   CAMERA ANIMATION
========================================================= */

let _camAnim   = null;   // cancel token for any running camera animation
let _routeAnim = null;   // cancel token for any running route animation

function animateCam(target, duration = 1000, onComplete) {
    if (_camAnim) cancelAnimationFrame(_camAnim);

    const container = document.getElementById('map-container');
    const scx = container.clientWidth  / 2;
    const scy = container.clientHeight / 2;

    // Derive the map coordinate currently at screen centre from cam.x/y/rot/scale
    const fromR    = cam.rot * Math.PI / 180;
    const fromCosR = Math.cos(fromR);
    const fromSinR = Math.sin(fromR);
    const fromDX   = scx - cam.x;
    const fromDY   = scy - cam.y;
    const safeScale = cam.scale > 0 ? cam.scale : 1;
    // R⁻¹(rot) · (screen_centre − cam_origin) / scale  →  map centre
    const fromCx = ( fromCosR * fromDX + fromSinR * fromDY) / safeScale;
    const fromCy = (-fromSinR * fromDX + fromCosR * fromDY) / safeScale;

    const fromScale  = cam.scale;
    const fromRotDeg = cam.rot;
    // Shortest angular path
    const dRot = ((target.rot - fromRotDeg) % 360 + 540) % 360 - 180;

    const ease = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;

    let startTs = null;
    function step(ts) {
        if (!startTs) startTs = ts;
        const t = Math.min((ts - startTs) / duration, 1);
        const e = ease(t);

        const curRotDeg = fromRotDeg + dRot * e;
        const curScale  = fromScale  + (target.scale - fromScale) * e;
        const curCx     = fromCx     + (target.cx    - fromCx)    * e;
        const curCy     = fromCy     + (target.cy    - fromCy)    * e;

        // Recompute cam.x/y so the interpolated map centre stays at screen centre
        const curR    = curRotDeg * Math.PI / 180;
        const cosR    = Math.cos(curR);
        const sinR    = Math.sin(curR);

        cam.rot   = curRotDeg;
        cam.scale = curScale;
        cam.x     = scx - (curCx * cosR - curCy * sinR) * curScale;
        cam.y     = scy - (curCx * sinR + curCy * cosR) * curScale;

        applyTransform();

        if (t < 1) {
            _camAnim = requestAnimationFrame(step);
        } else {
            cam.rot  = target.rot;
            _camAnim = null;
            onComplete?.();
        }
    }

    _camAnim = requestAnimationFrame(step);
}

function drawControlPairCircles(cp, parent) {
    [cp.start, cp.ziel].forEach(point => {
        if (!point) return;
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', point.x);
        circle.setAttribute('cy', point.y);
        circle.setAttribute('r',  R_CONTROL);
        circle.setAttribute('fill',         'transparent');
        circle.setAttribute('stroke',       'rgb(160, 51, 240)');
        circle.setAttribute('stroke-width', '3');
        circle.setAttribute('vector-effect', 'non-scaling-stroke');
        parent.appendChild(circle);
    });
}

function drawConnection(cp, parent) {
    if (!cp.start || !cp.ziel) return;
    const { start, ziel } = cp;
    const dx   = ziel.x - start.x;
    const dy   = ziel.y - start.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 2 * (R_CONTROL + GAP)) return;

    const angle  = Math.atan2(dy, dx);
    const offset = R_CONTROL + GAP;
    const x1 = start.x + Math.cos(angle) * offset;
    const y1 = start.y + Math.sin(angle) * offset;
    const x2 = ziel.x  - Math.cos(angle) * offset;
    const y2 = ziel.y  - Math.sin(angle) * offset;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke',       'rgb(160, 51, 240)');
    line.setAttribute('stroke-width', '3');
    line.setAttribute('fill', 'none');
    line.setAttribute('vector-effect', 'non-scaling-stroke');

    parent.appendChild(line);
}

function drawConnectionArrow(start, ziel, angle, parent) {
    const arrowSize  = 15;
    const arrowAngle = Math.PI / 6;
    const midX = (start.x + ziel.x + Math.cos(angle) * arrowSize / 2) / 2;
    const midY = (start.y + ziel.y + Math.sin(angle) * arrowSize / 2) / 2;

    const mkLine = (x1, y1, x2, y2) => {
        const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        l.setAttribute('x1', x1); l.setAttribute('y1', y1);
        l.setAttribute('x2', x2); l.setAttribute('y2', y2);
        l.setAttribute('stroke',         'rgb(160, 51, 240)');
        l.setAttribute('stroke-width',   '3');
        l.setAttribute('stroke-linecap', 'round');
        l.setAttribute('vector-effect',  'non-scaling-stroke');
        return l;
    };

    parent.appendChild(mkLine(
        midX, midY,
        midX - Math.cos(angle - arrowAngle) * arrowSize,
        midY - Math.sin(angle - arrowAngle) * arrowSize,
    ));
    parent.appendChild(mkLine(
        midX, midY,
        midX - Math.cos(angle + arrowAngle) * arrowSize,
        midY - Math.sin(angle + arrowAngle) * arrowSize,
    ));
}

/* =========================================================
   MAP SPINNER
========================================================= */

function showMapSpinner() {
    const layer = document.getElementById('ui-layer');
    layer.innerHTML = '';

    const spinner = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    spinner.id = 'map-spinner';

    const radii  = [64, 84, 104];
    const speeds = [1, 0.65, 0.38];
    const colors = ['#444', '#666', '#999'];
    const arcs   = [];

    const rect = document.getElementById('map-container').getBoundingClientRect();
    const cx   = (rect.width  / 2 - cam.x) / cam.scale;
    const cy   = (rect.height / 2 - cam.y) / cam.scale;

    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x',      -radii[2] - 12);
    bg.setAttribute('y',      -radii[2] - 12);
    bg.setAttribute('width',   2 * radii[2] + 24);
    bg.setAttribute('height',  2 * radii[2] + 24);
    bg.setAttribute('rx',      radii[2] + 10);
    bg.setAttribute('fill',   '#2a2a2a');
    spinner.appendChild(bg);

    radii.forEach((r, i) => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', 0); circle.setAttribute('cy', 0); circle.setAttribute('r', r);
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
    layer.appendChild(spinner);

    let start = null;
    function animate(ts) {
        if (!start) start = ts;
        const elapsed = (ts - start) / 1000;
        arcs.forEach(arc => {
            arc.el.setAttribute('transform',
                `rotate(${(elapsed * arc.speed * 360 + arc.offset * 60) % 360})`
            );
        });
        if (document.getElementById('map-spinner')) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}

function hideMapSpinner() {
    document.getElementById('ui-layer').innerHTML = '';
}

/* =========================================================
   ROUTE ANIMATION  (dot + trail + wave on submission)
========================================================= */

function animateRoutes(cp, selectedIdx) {
    const layer = document.getElementById('route-layer');
    layer.innerHTML = '';

    // Normalise durations: fastest run_time → 1 second; others scale proportionally
    const validTimes = cp.routes.map(r => r.run_time).filter(t => t > 0);
    const minTime    = validTimes.length ? Math.min(...validTimes) : 1;

    const anims = cp.routes.map((route, i) => {
        const rP = route.rP;
        if (!rP || rP.length < 2) return null;

        // Cumulative pixel distances
        const dists = [0];
        for (let j = 1; j < rP.length; j++)
            dists.push(dists[j - 1] + Math.hypot(rP[j].x - rP[j - 1].x, rP[j].y - rP[j - 1].y));
        const totalDist = dists[dists.length - 1];

        // Animation duration: fastest = 1 s. Amplifier tapers from 5× at 0% excess
        // down to 1× at 100% excess, then stays at 1× — keeps large differences
        // visible without making badly-drawn routes absurdly slow.
        const ratio    = route.run_time > 0 ? route.run_time / minTime : 1;
        const excess   = ratio - 1;
        const amp      = 5 - 4 * Math.min(excess, 1);
        const duration = 1 + excess * amp;

        const color = currentRouteColors[i];

        // Dimmed white background (static)
        const bg = createRoutePolyline(route, { stroke: 'white', strokeWidth: 3, opacity: 0.2 });
        if (bg) layer.appendChild(bg);

        // Trail (grows with the dot)
        const trail = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        trail.setAttribute('fill', 'none');
        trail.setAttribute('stroke', color);
        trail.setAttribute('stroke-width', '2.5');
        trail.setAttribute('stroke-linecap',  'round');
        trail.setAttribute('stroke-linejoin', 'round');
        trail.setAttribute('vector-effect', 'non-scaling-stroke');
        trail.setAttribute('points', `${rP[0].x},${rP[0].y}`);
        layer.appendChild(trail);

        // Dot
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r',    '5');
        dot.setAttribute('fill',  color);
        dot.setAttribute('cx',    rP[0].x);
        dot.setAttribute('cy',    rP[0].y);
        dot.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(dot);

        return { rP, dists, totalDist, duration, color, trail, dot, i, done: false };
    }).filter(Boolean);

    const t0 = performance.now();
    if (_routeAnim) cancelAnimationFrame(_routeAnim);

    (function tick(now) {
        const elapsed = (now - t0) / 1000;
        let   allDone = true;

        anims.forEach(anim => {
            if (anim.done) return;
            const { rP, dists, totalDist, duration, trail, dot, i } = anim;

            // Linear progress within this route's normalised duration
            const dist = Math.min((elapsed / duration) * totalDist, totalDist);

            // Current segment
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
            trail.setAttribute('points', pts.join(' '));

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
    const layer = document.getElementById('ui-layer');
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', pos.x);
    c.setAttribute('cy', pos.y);
    c.setAttribute('r',  R_CONTROL);
    c.setAttribute('fill',          'none');
    c.setAttribute('stroke',         color);
    c.setAttribute('stroke-width',  '14');
    c.setAttribute('vector-effect',  'non-scaling-stroke');
    c.style.filter = 'blur(4px)';
    layer.appendChild(c);

    const start    = performance.now();
    const duration = 1800;                  // slower, more dramatic
    const endR     = R_CONTROL * 2.5;

    (function animate(now) {
        const t    = Math.min((now - start) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 2);   // ease-out quad
        c.setAttribute('r',       R_CONTROL + (endR - R_CONTROL) * ease);
        c.setAttribute('opacity', (1 - ease) * 0.85);
        if (t < 1) requestAnimationFrame(animate);
        else c.remove();
    })(start);
}

/* =========================================================
   RESULT SUBMISSION
========================================================= */

function submitResult(cp, route) {
    // Replay mode: file is already fully played; do not write anything to the DB.
    // The server also enforces this (Choice.objects.get_or_create), but skipping
    // the request avoids unnecessary traffic.
    if (replayMode) return;

    const choiceTime = choiceStartTime !== null
        ? (performance.now() - choiceStartTime) / 1000
        : 0;

    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? '';

    fetch('/play/submit-result/', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
        body: JSON.stringify({
            control_pair_id:   cp.id,
            selected_route_id: route?.id ?? null,
            choice_time:       choiceTime,
            competition:       competitionMode,
        }),
    }).catch(err => console.error('submit-result failed:', err));
}

/* =========================================================
   BUTTON BAR
========================================================= */

function renderButtons(defs) {
    const bar = document.getElementById('play-btn-bar');
    bar.innerHTML = '';
    defs.forEach(({ label, iconName, action, cls, disabled, bgColor, fontSize, active, fastest, delta }) => {
        const btn = document.createElement('button');
        let btnCls = 'play-btn' + (cls ? ` ${cls}` : '') + (active ? ' active' : '');
        if (fastest) btnCls += ' route-btn-fastest';
        btn.className = btnCls;
        if (disabled) btn.disabled = true;
        if (bgColor)  btn.style.background = bgColor;
        if (fontSize) btn.style.fontSize   = fontSize;

        let html = '';
        if (iconName) {
            html = `<x-icon name="${iconName}" size="1.4em"></x-icon>
                    <span class="play-btn-label">${label || ''}</span>`;
        } else if (fastest) {
            html = icon('crown', '1.4em');
        } else if (delta) {
            const lineClass = delta.twoLines ? ' two-lines' : '';
            html = `<span class="route-btn-delta${lineClass}"><span class="route-btn-delta-rel">${delta.rel}</span><span class="route-btn-delta-abs">${delta.abs}</span></span>`;
        } else if (label) {
            html = `<span class="play-btn-label">${label}</span>`;
        }
        btn.innerHTML = html;
        btn.addEventListener('click', action);
        bar.appendChild(btn);
    });
}
