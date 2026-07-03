const NS = 'http://www.w3.org/2000/svg';
const ROUTE_COLORS = ['#dd0011', '#cc6000', '#0066cc', '#7a2cbf'];
const CONTROL_COLOR = '#a033f0';
const CONTROL_RADIUS = 2.5;
const DETERMINISM_SEEDS = [
    10101, 20202, 30303, 40404, 50505,
    60606, 70707, 80808, 90909, 111111,
    222222, 333333, 444444, 555555, 666666,
    777777, 888888, 999999, 1234567, 7654321,
];

const root = document.getElementById('debug-infinity');
const reportList = document.getElementById('di-report-list');
const titleEl = document.getElementById('di-report-title');
const outputEl = document.getElementById('di-output');
const svg = document.getElementById('di-map');
const mapLayer = document.getElementById('di-map-layer');
const routeLayer = document.getElementById('di-route-layer');
const controlLayer = document.getElementById('di-control-layer');
const mapWrap = document.getElementById('di-map-wrap');
const toggleRoutesBtn = document.getElementById('di-toggle-routes');

let worker = null;
let workerMsgId = 1;
let currentReport = null;
let viewBox = { x: -100, y: -100, w: 200, h: 200 };
let routesVisible = true;

function el(tag) {
    return document.createElementNS(NS, tag);
}

function setStatus(message, extra = null) {
    outputEl.textContent = extra ? `${message}\n\n${extra}` : message;
}

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./infinite/infinite_batch_worker.js', import.meta.url), { type: 'module' });
    return worker;
}

function workerRequest(payload) {
    const w = ensureWorker();
    const msgId = workerMsgId++;
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            w.removeEventListener('message', onMessage);
            w.removeEventListener('error', onError);
            w.removeEventListener('messageerror', onMessageError);
        };
        const onMessage = (event) => {
            const msg = event.data;
            if (!msg || msg.msgId !== msgId) return;
            cleanup();
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg);
        };
        const onError = (event) => {
            cleanup();
            reject(new Error(event.message || 'worker error'));
        };
        const onMessageError = () => {
            cleanup();
            reject(new Error('worker message error'));
        };
        w.addEventListener('message', onMessage);
        w.addEventListener('error', onError);
        w.addEventListener('messageerror', onMessageError);
        w.postMessage({ ...payload, msgId });
    });
}

function setViewBox(box) {
    viewBox = box;
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
}

function paddedBounds(bounds, points = []) {
    let minX = bounds?.minX ?? Infinity;
    let minY = bounds?.minY ?? Infinity;
    let maxX = bounds?.maxX ?? -Infinity;
    let maxY = bounds?.maxY ?? -Infinity;
    for (const p of points) {
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return { x: -100, y: -100, w: 200, h: 200 };
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const pad = Math.max(w, h) * 0.08;
    return { x: minX - pad, y: minY - pad, w: w + pad * 2, h: h + pad * 2 };
}

function polygonPoints(points) {
    return (points || []).map((p) => `${p.x},${p.y}`).join(' ');
}

function pathPoints(points) {
    return (points || []).map((p) => `${p.x},${p.y}`).join(' ');
}

function drawPolygon(layer, points, fill, stroke = 'none', strokeWidth = 0) {
    if (!points || points.length < 3) return;
    const node = el('polygon');
    node.setAttribute('points', polygonPoints(points));
    node.setAttribute('fill', fill);
    node.setAttribute('stroke', stroke);
    node.setAttribute('stroke-width', strokeWidth);
    node.setAttribute('stroke-linejoin', 'round');
    layer.appendChild(node);
}

function drawPolyline(layer, points, stroke, strokeWidth, opacity = 1) {
    if (!points || points.length < 2) return;
    const node = el('polyline');
    node.setAttribute('points', pathPoints(points));
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', stroke);
    node.setAttribute('stroke-width', strokeWidth);
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('vector-effect', 'non-scaling-stroke');
    node.setAttribute('opacity', opacity);
    layer.appendChild(node);
}

function drawCircle(layer, point, radius, fill, stroke, strokeWidth = 0.35) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    const node = el('circle');
    node.setAttribute('cx', point.x);
    node.setAttribute('cy', point.y);
    node.setAttribute('r', radius);
    node.setAttribute('fill', fill);
    node.setAttribute('stroke', stroke);
    node.setAttribute('stroke-width', strokeWidth);
    node.setAttribute('vector-effect', 'non-scaling-stroke');
    layer.appendChild(node);
}

function drawCity(city) {
    mapLayer.replaceChildren();
    if (!city) return;
    const bg = el('rect');
    const box = paddedBounds(city.bounds);
    bg.setAttribute('x', box.x);
    bg.setAttribute('y', box.y);
    bg.setAttribute('width', box.w);
    bg.setAttribute('height', box.h);
    bg.setAttribute('fill', '#efe9d8');
    mapLayer.appendChild(bg);

    for (const ward of city.wards || []) {
        if (ward.water) continue;
        const fill = ward.inner || ward.type === 'outerGarden' || ward.type === 'outerHighrise'
            ? '#e4d7b6'
            : '#cdd6ac';
        drawPolygon(mapLayer, ward.polygon, fill);
    }
    for (const ward of city.wards || []) {
        if (ward.water) drawPolygon(mapLayer, ward.polygon, '#00adef', '#004f8a', 0.25);
    }
    for (const building of city.buildings || []) {
        const polygon = Array.isArray(building) ? building : building.polygon;
        if (!polygon) continue;
        let fill = '#888';
        let stroke = '#000';
        if (building.class === 'park' || building.class === 'outerHighrisePark') {
            fill = '#fdc01d';
            stroke = '#000';
        } else if (building.class === 'outerGarden') {
            fill = '#a6b93c';
            stroke = '#a6b93c';
        } else if (building.class === 'outerHighrisePath') {
            fill = '#a99d77';
            stroke = 'none';
        }
        drawPolygon(mapLayer, polygon, fill, stroke, 0.18);
    }
    for (const hedge of city.hedges || []) drawPolyline(mapLayer, hedge, '#009218', 0.5);
    for (const hedge of city.cathedralHedges || []) drawPolyline(mapLayer, hedge, '#000', 0.5);
    for (const feature of city.features || []) {
        const isTree = feature.kind === 'tree';
        drawCircle(mapLayer, feature, isTree ? 0.34 : 0.5, isTree ? '#009218' : 'none', isTree ? 'none' : '#2b7fc4', 0.2);
    }
}

function routePoints(route) {
    return route?.points || route?.rP || [];
}

function drawReport(report, city) {
    currentReport = report;
    drawCity(city);
    routeLayer.replaceChildren();
    controlLayer.replaceChildren();
    routeLayer.style.display = routesVisible ? '' : 'none';

    for (const [index, route] of (report.routes || []).entries()) {
        const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
        drawPolyline(routeLayer, routePoints(route), '#fff', 4, 0.9);
        drawPolyline(routeLayer, routePoints(route), color, 2, 1);
    }
    drawCircle(controlLayer, report.start, CONTROL_RADIUS, 'none', CONTROL_COLOR, 0.45);
    drawCircle(controlLayer, report.goal, CONTROL_RADIUS, 'none', CONTROL_COLOR, 0.45);
    drawCircle(controlLayer, report.goal, 0.75, CONTROL_COLOR, CONTROL_COLOR, 0);

    const routePts = (report.routes || []).flatMap(routePoints);
    setViewBox(paddedBounds(city?.bounds || report.client_state?.cityBounds, [report.start, report.goal, ...routePts]));
    titleEl.textContent = `Report #${report.id} | seed ${report.seed} | pair ${report.pair_index ?? '-'}`;
    setStatus(
        'Reports created under an older generator version may not reproduce their city after generation changes.',
        JSON.stringify({
            id: report.id,
            user: report.user,
            team: report.team,
            timestamp: report.timestamp,
            seed: report.seed,
            pair_index: report.pair_index,
            route_indexes: report.route_indexes,
            route_runtime_slots: report.route_result?.routeRuntimeSlots,
            route_noa_slots: report.route_result?.routeNoASlots,
            user_agent: report.user_agent,
        }, null, 2),
    );
}

async function loadReports() {
    reportList.textContent = 'Loading...';
    const response = await fetch(root.dataset.reportsUrl, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Report list failed (${response.status})`);
    const data = await response.json();
    reportList.replaceChildren();
    for (const report of data.reports || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'di-report-item';
        button.dataset.reportId = report.id;

        const main = document.createElement('span');
        main.className = 'di-report-main';
        main.textContent = `#${report.id} ${report.user}`;
        const seed = document.createElement('span');
        seed.className = 'di-report-seed';
        seed.textContent = `seed ${report.seed}`;
        const meta = document.createElement('span');
        meta.className = 'di-report-meta';
        meta.textContent = report.timestamp ? new Date(report.timestamp).toLocaleString() : '';
        const pair = document.createElement('span');
        pair.className = 'di-report-meta di-report-seed';
        pair.textContent = `pair ${report.pair_index ?? '-'}`;

        button.append(main, seed, meta, pair);
        button.addEventListener('click', () => loadReport(report.id));
        reportList.appendChild(button);
    }
    if (!reportList.children.length) reportList.textContent = 'No reports yet.';
}

async function loadReport(id) {
    document.querySelectorAll('.di-report-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.reportId === String(id));
    });
    setStatus('Loading report...');
    const response = await fetch(`${root.dataset.reportBaseUrl}${id}/`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Report detail failed (${response.status})`);
    const data = await response.json();
    const report = data.report;
    const settings = { ...(report.settings || {}), seed: report.seed };
    const cityMsg = await workerRequest({ type: 'generateCity', settings });
    drawReport(report, cityMsg.city);
}

async function runDeterminismCheck() {
    setStatus('Running determinism check...');
    const started = performance.now();
    const msg = await workerRequest({ type: 'determinism', seeds: DETERMINISM_SEEDS, pairCount: 3 });
    const lines = [
        `elapsed_ms=${(performance.now() - started).toFixed(1)}`,
        ...msg.hashes.map((item) => `${item.seed} ${item.hash}`),
    ];
    setStatus('Determinism hashes', lines.join('\n'));
}

function initPanZoom() {
    let drag = null;
    mapWrap.addEventListener('pointerdown', (event) => {
        mapWrap.setPointerCapture(event.pointerId);
        drag = {
            x: event.clientX,
            y: event.clientY,
            box: { ...viewBox },
        };
        mapWrap.classList.add('panning');
    });
    mapWrap.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const rect = svg.getBoundingClientRect();
        const dx = (event.clientX - drag.x) * drag.box.w / rect.width;
        const dy = (event.clientY - drag.y) * drag.box.h / rect.height;
        setViewBox({ ...drag.box, x: drag.box.x - dx, y: drag.box.y - dy });
    });
    const stopDrag = () => {
        drag = null;
        mapWrap.classList.remove('panning');
    };
    mapWrap.addEventListener('pointerup', stopDrag);
    mapWrap.addEventListener('pointercancel', stopDrag);
    mapWrap.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const mx = (event.clientX - rect.left) / rect.width;
        const my = (event.clientY - rect.top) / rect.height;
        const factor = event.deltaY < 0 ? 0.9 : 1.1;
        const nw = viewBox.w * factor;
        const nh = viewBox.h * factor;
        const cx = viewBox.x + viewBox.w * mx;
        const cy = viewBox.y + viewBox.h * my;
        setViewBox({
            x: cx - nw * mx,
            y: cy - nh * my,
            w: nw,
            h: nh,
        });
    }, { passive: false });
}

document.getElementById('di-refresh').addEventListener('click', () => {
    loadReports().catch((err) => setStatus(err.message));
});
document.getElementById('di-determinism').addEventListener('click', () => {
    runDeterminismCheck().catch((err) => setStatus(err.message));
});
toggleRoutesBtn.addEventListener('click', () => {
    routesVisible = !routesVisible;
    toggleRoutesBtn.setAttribute('aria-pressed', routesVisible ? 'true' : 'false');
    routeLayer.style.display = routesVisible ? '' : 'none';
});

initPanZoom();
loadReports().catch((err) => setStatus(err.message));
