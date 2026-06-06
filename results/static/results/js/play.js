/* =========================================================
   PLAY MODE
========================================================= */

/* =========================================================
   STATE
========================================================= */

const urlParts        = window.location.pathname.split('/').filter(Boolean);
const fileId          = urlParts[urlParts.length - 2];   // /play/<id>/<mode>/
const competitionMode = urlParts[urlParts.length - 1] === 'competition';

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

const R_CONTROL = 25;
const GAP       = 8;
const MIN_ZOOM  = 0.2;
const MAX_ZOOM  = 8;

let currentCpIndex = -1;

/* =========================================================
   INIT
========================================================= */

document.addEventListener('DOMContentLoaded', () => {
    initCamera();
    loadFile();
});

async function loadFile() {
    showMapSpinner();
    try {
        const res = await fetch(`/play/file/${fileId}/`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        project.id            = data.id;
        project.name          = data.name;
        project.scale         = data.scale;
        project.scaled        = data.scaled;
        project.map_file        = data.map_file;
        project.blocked_terrain = data.blocked_terrain;
        project.control_pairs   = data.control_pairs;
        await loadMap(project.map_file);
        renderButtons([{ label: 'Bereit?', icon: 'flag', action: () => showControlPair(0) }]);
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
        img.src = `/play/map/${filename}/`;
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
    const scale = Math.min(cw / imgW, ch / imgH);
    cam.rot   = 0;
    cam.x     = (cw - imgW * scale) / 2;
    cam.y     = (ch - imgH * scale) / 2;
    cam.scale = scale;
    applyTransform();
}

/* =========================================================
   CAMERA  (pan + pinch-zoom, mirrors editor behaviour)
========================================================= */

function initCamera() {
    const container = document.getElementById('map-container');
    const camera    = document.getElementById('camera');

    let drag = null;
    let lastPinchDist = null;

    applyTransform = () => {
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

function createRoutePolyline(route, { stroke = 'black', strokeWidth = 1.5 } = {}) {
    if (!route?.rP || route.rP.length < 2) return null;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    el.setAttribute('points',           route.rP.map(p => `${p.x},${p.y}`).join(' '));
    el.setAttribute('fill',             'none');
    el.setAttribute('stroke',           stroke);
    el.setAttribute('stroke-width',     strokeWidth);
    el.setAttribute('stroke-linecap',   'round');
    el.setAttribute('stroke-linejoin',  'round');
    el.setAttribute('vector-effect',    'non-scaling-stroke');
    el.setAttribute('pointer-events',   'none');
    return el;
}

function drawRoutes(cp) {
    const layer = document.getElementById('route-layer');
    layer.innerHTML = '';
    if (!cp?.routes?.length) return;

    // White background pass
    cp.routes.forEach(route => {
        const el = createRoutePolyline(route, { stroke: 'white', strokeWidth: 3 });
        if (el) layer.appendChild(el);
    });

    // Black foreground pass
    cp.routes.forEach(route => {
        const el = createRoutePolyline(route, { stroke: 'black', strokeWidth: 1.5 });
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

    // Clear immediately so nothing stale shows during the animation
    document.getElementById('route-layer').innerHTML   = '';
    document.getElementById('control-layer').innerHTML = '';

    // Rotation: start at bottom, ziel straight above
    const dx     = cp.ziel.x - cp.start.x;
    const dy     = cp.ziel.y - cp.start.y;
    const rotDeg = -90 - Math.atan2(dy, dx) * (180 / Math.PI);
    const R      = rotDeg * Math.PI / 180;
    const cosR   = Math.cos(R);
    const sinR   = Math.sin(R);

    // Fit tightly around the route points only
    const points = [];
    for (const route of cp.routes) {
        if (route.rP?.length) points.push(...route.rP);
    }
    // Fall back to start/ziel if no routes yet
    if (!points.length) points.push(cp.start, cp.ziel);

    // Project into rotated coordinate system
    const rotated = points.map(p => ({
        rx: p.x * cosR - p.y * sinR,
        ry: p.x * sinR + p.y * cosR,
    }));

    const PAD = 15;
    let minRX = Math.min(...rotated.map(p => p.rx)) - PAD;
    let maxRX = Math.max(...rotated.map(p => p.rx)) + PAD;
    let minRY = Math.min(...rotated.map(p => p.ry)) - PAD;
    let maxRY = Math.max(...rotated.map(p => p.ry)) + PAD;

    // Expand bounding box to fully contain the start and ziel circles
    [cp.start, cp.ziel].forEach(pt => {
        if (!pt) return;
        const rx = pt.x * cosR - pt.y * sinR;
        const ry = pt.x * sinR + pt.y * cosR;
        minRX = Math.min(minRX, rx - R_CONTROL);
        maxRX = Math.max(maxRX, rx + R_CONTROL);
        minRY = Math.min(minRY, ry - R_CONTROL);
        maxRY = Math.max(maxRY, ry + R_CONTROL);
    });

    const container = document.getElementById('map-container');
    const cw    = container.clientWidth;
    const ch    = container.clientHeight;
    const scale = Math.min(cw / (maxRX - minRX), ch / (maxRY - minRY));

    // Convert bounding-box centre from rotated space back to map space
    const centerRX = (minRX + maxRX) / 2;
    const centerRY = (minRY + maxRY) / 2;
    // R⁻¹(rot) = [cosR, sinR; -sinR, cosR]
    animateCam({
        rot:   rotDeg,
        scale: scale,
        cx:    centerRX * cosR + centerRY * sinR,
        cy:   -centerRX * sinR + centerRY * cosR,
    }, 1000, () => {
        drawRoutes(cp);
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.classList.add('control-pair-group');
        drawControlPairCircles(cp, group);
        drawConnection(cp, group);
        document.getElementById('control-layer').appendChild(group);
    });

    renderNavButtons();
}

function renderNavButtons() {
    const last = project.control_pairs.length - 1;
    renderButtons([
        {
            label: 'Zurück',
            icon:  'chevron-left',
            action: () => showControlPair(currentCpIndex - 1),
            disabled: currentCpIndex <= 0,
        },
        {
            label: 'Weiter',
            icon:  'chevron-right',
            action: () => showControlPair(currentCpIndex + 1),
            disabled: currentCpIndex >= last,
        },
    ]);
}

/* =========================================================
   CAMERA ANIMATION
========================================================= */

let _camAnim = null;   // cancel token for any running animation

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
    // R⁻¹(rot) · (screen_centre − cam_origin) / scale  →  map centre
    const fromCx = ( fromCosR * fromDX + fromSinR * fromDY) / cam.scale;
    const fromCy = (-fromSinR * fromDX + fromCosR * fromDY) / cam.scale;

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
   BUTTON BAR
========================================================= */

function renderButtons(defs) {
    const bar = document.getElementById('play-btn-bar');
    bar.innerHTML = '';
    defs.forEach(({ label, icon, action, cls, disabled }) => {
        const btn = document.createElement('button');
        btn.className = 'play-btn' + (cls ? ` ${cls}` : '');
        if (disabled) btn.disabled = true;
        btn.innerHTML = `
            <x-icon name="${icon}" size="1.4em"></x-icon>
            <span class="play-btn-label">${label}</span>`;
        btn.addEventListener('click', action);
        bar.appendChild(btn);
    });
}
