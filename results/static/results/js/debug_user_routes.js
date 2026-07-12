import { TRAIN_SCALE_VALUE } from '/static/project/js/pathing/pipeline.js';
import { maskScaleForMap } from './infinite/mask_scene_source.js';

const NS = 'http://www.w3.org/2000/svg';
const ROUTE_COLORS = ['#0066dd', '#e27600', '#7a2cbf', '#008e82', '#bb244f'];
const PASSAGE_ROUTE_COLOR = '#ff2bb5';

const root = document.getElementById('debug-user-routes');
const fileList = document.getElementById('dur-file-list');
const svg = document.getElementById('dur-map');
const mapWrap = document.getElementById('dur-map-wrap');
const mapLayer = document.getElementById('dur-map-layer');
const passageLayer = document.getElementById('dur-passage-layer');
const routeLayer = document.getElementById('dur-route-layer');
const pointLayer = document.getElementById('dur-point-layer');
const titleEl = document.getElementById('dur-title');
const summaryEl = document.getElementById('dur-summary');
const outputEl = document.getElementById('dur-output');
const findButton = document.getElementById('dur-find');
const firstPassageButton = document.getElementById('dur-first-passage');
const startButton = document.getElementById('dur-set-start');
const goalButton = document.getElementById('dur-set-goal');
const showPassages = document.getElementById('dur-show-passages');
const fullRefinement = document.getElementById('dur-full-refinement');
const inputs = {
    startX: document.getElementById('dur-start-x'),
    startY: document.getElementById('dur-start-y'),
    goalX: document.getElementById('dur-goal-x'),
    goalY: document.getElementById('dur-goal-y'),
};

let files = [];
let currentFile = null;
let passages = [];
let worker = null;
let workerMessageId = 1;
let workerReady = false;
let passageRevision = null;
let placement = 'start';
let start = null;
let goal = null;
let mapBounds = null;
let viewBox = { x: 0, y: 0, w: 100, h: 100 };
let pan = null;
let suppressClick = false;

function svgElement(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
}

function setOutput(message) {
    outputEl.textContent = message;
}

function setViewBox(box) {
    viewBox = box;
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
}

function fitMap() {
    if (!mapBounds) return;
    const pad = Math.max(mapBounds.w, mapBounds.h) * 0.025;
    setViewBox({
        x: -pad,
        y: -pad,
        w: mapBounds.w + pad * 2,
        h: mapBounds.h + pad * 2,
    });
}

async function fetchJson(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function fetchArrayBuffer(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
}

async function decodeMask(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const greys = new Uint8Array(bitmap.width * bitmap.height);
    for (let i = 0, j = 0; i < greys.length; i++, j += 4) greys[i] = rgba[j];
    bitmap.close?.();
    return { greys, width: canvas.width, height: canvas.height };
}

function workerRequest(payload, expectedType, timeoutMs = 30000) {
    const msgId = workerMessageId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(gettext('Route search timed out.')));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
        };
        const onMessage = (event) => {
            const message = event.data;
            if (!message || message.msgId !== msgId || message.type !== expectedType) return;
            cleanup();
            if (message.error) reject(Object.assign(new Error(message.error), { response: message }));
            else resolve(message);
        };
        const onError = (event) => {
            cleanup();
            reject(new Error(event.message || gettext('Pathfinder worker failed.')));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage({ ...payload, msgId });
    });
}

function renderFileList() {
    fileList.replaceChildren();
    if (!files.length) {
        fileList.textContent = gettext('No maps with masks were found.');
        return;
    }
    for (const file of files) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `dur-file-item${currentFile?.id === file.id ? ' active' : ''}`;
        const name = document.createElement('span');
        name.className = 'dur-file-name';
        name.textContent = file.name;
        const state = document.createElement('span');
        state.className = `dur-file-state ${file.route_ready ? 'ready' : 'stale'}`;
        state.textContent = file.route_ready ? gettext('Ready') : gettext('Rebuild required');
        const meta = document.createElement('span');
        meta.className = 'dur-file-meta';
        meta.textContent = `${file.team || '—'} · ${file.passage_count} ${gettext('passages')}`;
        const id = document.createElement('span');
        id.className = 'dur-file-meta';
        id.textContent = `#${file.id}`;
        button.append(name, state, meta, id);
        button.addEventListener('click', () => loadFile(file));
        fileList.appendChild(button);
    }
}

async function loadFiles() {
    setOutput(gettext('Loading maps…'));
    const response = await fetchJson(root.dataset.filesUrl);
    files = response.files || [];
    renderFileList();
    const preferred = files.find((file) => file.route_ready && file.passage_count > 0)
        || files.find((file) => file.route_ready);
    if (preferred) await loadFile(preferred);
    else setOutput(files.length ? gettext('No map has a current navgraph. Rebuild one in the editor first.') : gettext('No maps with masks were found.'));
}

function resetWorker() {
    try { worker?.terminate(); } catch (_) {}
    worker = null;
    workerReady = false;
    passageRevision = null;
}

async function loadFile(file) {
    currentFile = file;
    renderFileList();
    resetWorker();
    start = null;
    goal = null;
    passages = [];
    mapBounds = null;
    mapLayer.replaceChildren();
    passageLayer.replaceChildren();
    routeLayer.replaceChildren();
    pointLayer.replaceChildren();
    findButton.disabled = true;
    firstPassageButton.disabled = true;
    titleEl.textContent = file.name;
    summaryEl.textContent = `${file.passage_count} ${gettext('passages')}`;
    if (!file.route_ready) {
        setOutput(gettext('This map has no current navgraph. Rebuild it in the editor before testing routes.'));
        return;
    }
    setOutput(gettext('Loading map and navgraph…'));
    try {
        const [binBuffer, mask, passageDocument] = await Promise.all([
            fetchArrayBuffer(file.navgraph_url),
            decodeMask(file.mask_url),
            fetchJson(file.passages_url),
        ]);
        if (currentFile?.id !== file.id) return;
        passages = passageDocument.items || [];
        mapBounds = {
            w: mask.width * TRAIN_SCALE_VALUE,
            h: mask.height * TRAIN_SCALE_VALUE,
        };
        const image = svgElement('image', {
            href: file.map_url,
            x: 0,
            y: 0,
            width: mapBounds.w,
            height: mapBounds.h,
            preserveAspectRatio: 'none',
        });
        mapLayer.replaceChildren(image);
        drawPassages();
        fitMap();
        worker = new Worker(
            new URL('/static/project/js/pathing/worker.js', window.location.origin),
            { type: 'module' },
        );
        const ackPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(gettext('Navgraph loading timed out.'))), 30000);
            const onMessage = (event) => {
                const message = event.data;
                if (!message || message.type !== 'navgraph') return;
                clearTimeout(timer);
                worker.removeEventListener('message', onMessage);
                if (message.error) reject(new Error(message.error));
                else resolve(message);
            };
            worker.addEventListener('message', onMessage);
        });
        worker.postMessage({
            type: 'navgraphReady',
            mapId: String(file.id),
            filename: file.name,
            binBuffer,
            maskBuffer: mask.greys.buffer,
            width: mask.width,
            height: mask.height,
            config: maskScaleForMap(file.map_scale, file.editor_scale).navConfig,
            levelPassages: passages,
        }, [binBuffer, mask.greys.buffer]);
        const ack = await ackPromise;
        workerReady = true;
        passageRevision = ack.passageRevision || null;
        findButton.disabled = false;
        firstPassageButton.disabled = passages.length === 0;
        if (passages.length) placeAroundFirstPassage(false);
        setOutput(`${gettext('Navgraph ready.')} ${ack.nodes} ${gettext('nodes')}, ${ack.edges} ${gettext('edges')}.`);
    } catch (error) {
        resetWorker();
        setOutput(`${gettext('Could not load this map:')} ${error.message}`);
    }
}

function mapPoint(point) {
    return { x: Number(point[0]) * TRAIN_SCALE_VALUE, y: Number(point[1]) * TRAIN_SCALE_VALUE };
}

function drawPassages() {
    passageLayer.replaceChildren();
    passageLayer.style.display = showPassages.checked ? '' : 'none';
    for (const passage of passages) {
        const points = (passage.points || []).map(mapPoint);
        if (points.length < 2) continue;
        const line = svgElement('polyline', {
            points: points.map((point) => `${point.x},${point.y}`).join(' '),
            fill: 'none',
            stroke: '#00b7d3',
            'stroke-width': Number(passage.width) * TRAIN_SCALE_VALUE,
            'stroke-opacity': .27,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        });
        const center = svgElement('polyline', {
            points: points.map((point) => `${point.x},${point.y}`).join(' '),
            fill: 'none',
            stroke: '#007e99',
            'stroke-width': 1.5,
            'stroke-dasharray': '5 3',
            'vector-effect': 'non-scaling-stroke',
        });
        passageLayer.append(line, center);
        for (const endpoint of [points[0], points[points.length - 1]]) {
            passageLayer.appendChild(svgElement('circle', {
                cx: endpoint.x,
                cy: endpoint.y,
                r: Number(passage.width) * TRAIN_SCALE_VALUE / 2,
                fill: 'none',
                stroke: '#007e99',
                'stroke-width': 1.5,
                'vector-effect': 'non-scaling-stroke',
            }));
        }
    }
}

function setPlacement(mode) {
    placement = mode;
    startButton.classList.toggle('active', mode === 'start');
    goalButton.classList.toggle('active', mode === 'goal');
}

function syncInputs() {
    inputs.startX.value = start ? start.x.toFixed(1) : '';
    inputs.startY.value = start ? start.y.toFixed(1) : '';
    inputs.goalX.value = goal ? goal.x.toFixed(1) : '';
    inputs.goalY.value = goal ? goal.y.toFixed(1) : '';
}

function drawPoints() {
    pointLayer.replaceChildren();
    const marker = (point, fill, label) => {
        if (!point) return;
        pointLayer.appendChild(svgElement('circle', {
            cx: point.x, cy: point.y, r: 7,
            fill, stroke: '#fff', 'stroke-width': 3,
            'vector-effect': 'non-scaling-stroke',
        }));
        const text = svgElement('text', {
            x: point.x + 10, y: point.y - 10,
            fill: '#111', stroke: '#fff', 'stroke-width': 3,
            'paint-order': 'stroke', 'font-size': 14,
            'font-weight': 700, 'vector-effect': 'non-scaling-stroke',
        });
        text.textContent = label;
        pointLayer.appendChild(text);
    };
    marker(start, '#19ad4b', gettext('Start'));
    marker(goal, '#ee2d32', gettext('Goal'));
    syncInputs();
}

function placeAroundFirstPassage(runSearch = true) {
    const passage = passages[0];
    if (!passage || passage.points.length < 2) return;
    const first = passage.points[0];
    const last = passage.points[passage.points.length - 1];
    // Entrance centres are guaranteed to be the legal base/passage transition
    // locations baked into a current navgraph. Extrapolating beyond the caps
    // can put a debug endpoint inside the very wall crossed by the passage
    // (Bern Altstadt's lower bridge entrance is one real example).
    start = mapPoint(first);
    goal = mapPoint(last);
    routeLayer.replaceChildren();
    drawPoints();
    if (runSearch) findRoutes();
}

function drawPolyline(points, stroke, width, opacity = 1, dash = null) {
    if (!points || points.length < 2) return;
    const attrs = {
        points: points.map((point) => `${point.x * TRAIN_SCALE_VALUE},${point.y * TRAIN_SCALE_VALUE}`).join(' '),
        fill: 'none', stroke, 'stroke-width': width, opacity,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke',
    };
    if (dash) attrs['stroke-dasharray'] = dash;
    routeLayer.appendChild(svgElement('polyline', attrs));
}

function drawRoutes(result) {
    routeLayer.replaceChildren();
    for (const [index, route] of (result.routes || []).entries()) {
        const dash = route.refineMode === 'graph-preview' ? '8 5' : null;
        drawPolyline(route.path, '#fff', 6, .9, dash);
        drawPolyline(route.path, ROUTE_COLORS[index % ROUTE_COLORS.length], 3, 1, dash);
        for (const span of route.passageSpans || []) {
            const from = Math.max(0, Number(span.fromIndex));
            const to = Math.min(route.path.length - 1, Number(span.toIndex));
            drawPolyline(route.path.slice(from, to + 1), PASSAGE_ROUTE_COLOR, 5, 1);
        }
    }
    drawPoints();
}

async function findRoutes() {
    if (!workerReady || !start || !goal) {
        setOutput(gettext('Place both route points first.'));
        return;
    }
    findButton.disabled = true;
    setOutput(gettext('Finding routes…'));
    try {
        const result = await workerRequest({
            type: 'debugRoute',
            mapId: String(currentFile.id),
            passageRevision,
            fullRefinement: fullRefinement.checked,
            start: { x: start.x / TRAIN_SCALE_VALUE, y: start.y / TRAIN_SCALE_VALUE },
            goal: { x: goal.x / TRAIN_SCALE_VALUE, y: goal.y / TRAIN_SCALE_VALUE },
        }, 'debugRoutes', 120000);
        drawRoutes(result);
        const lines = [
            `${gettext('Result')}: ${result.reason}`,
            `${gettext('Routes')}: ${result.routes.length} · ${gettext('time')}: ${result.workerMs} ms`,
            `${gettext('Snap targets')}: ${result.startSnapCount} / ${result.goalSnapCount}`,
        ];
        result.routes.forEach((route, index) => {
            const ids = (route.passageSpans || []).map((span) => span.passageId).join(', ') || gettext('none');
            const refinement = route.refineMode === 'graph-preview'
                ? gettext('Graph preview')
                : route.refineMode;
            const legality = route.legality === null
                ? gettext('not checked')
                : route.legality;
            lines.push(`${gettext('Route')} ${index + 1}: ${route.path.length} ${gettext('points')} · ${gettext('passages')}: ${ids} · ${gettext('refinement')}: ${refinement} · ${gettext('legality errors')}: ${legality}`);
        });
        setOutput(lines.join('\n'));
    } catch (error) {
        routeLayer.replaceChildren();
        drawPoints();
        setOutput(`${gettext('Route search failed:')} ${error.message}`);
    } finally {
        findButton.disabled = !workerReady;
    }
}

function clientToMap(event) {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
}

svg.addEventListener('click', (event) => {
    if (!workerReady || suppressClick) {
        suppressClick = false;
        return;
    }
    const point = clientToMap(event);
    const placed = { x: point.x, y: point.y };
    if (placement === 'start') start = placed;
    else goal = placed;
    routeLayer.replaceChildren();
    drawPoints();
});

svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = clientToMap(event);
    const factor = event.deltaY < 0 ? .84 : 1 / .84;
    setViewBox({
        x: point.x - (point.x - viewBox.x) * factor,
        y: point.y - (point.y - viewBox.y) * factor,
        w: viewBox.w * factor,
        h: viewBox.h * factor,
    });
}, { passive: false });

svg.addEventListener('pointerdown', (event) => {
    if (!event.shiftKey && event.button !== 1) return;
    event.preventDefault();
    pan = { x: event.clientX, y: event.clientY, box: { ...viewBox }, moved: false };
    mapWrap.classList.add('panning');
    svg.setPointerCapture(event.pointerId);
});

svg.addEventListener('pointermove', (event) => {
    if (!pan) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    const bounds = svg.getBoundingClientRect();
    setViewBox({
        ...pan.box,
        x: pan.box.x - dx * pan.box.w / bounds.width,
        y: pan.box.y - dy * pan.box.h / bounds.height,
    });
});

svg.addEventListener('pointerup', () => {
    if (pan?.moved) suppressClick = true;
    pan = null;
    mapWrap.classList.remove('panning');
});

function readInputs() {
    const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, Number(input.value)]));
    if ([values.startX, values.startY].every(Number.isFinite)) start = { x: values.startX, y: values.startY };
    if ([values.goalX, values.goalY].every(Number.isFinite)) goal = { x: values.goalX, y: values.goalY };
    routeLayer.replaceChildren();
    drawPoints();
}

Object.values(inputs).forEach((input) => input.addEventListener('change', readInputs));
startButton.addEventListener('click', () => setPlacement('start'));
goalButton.addEventListener('click', () => setPlacement('goal'));
findButton.addEventListener('click', findRoutes);
firstPassageButton.addEventListener('click', () => placeAroundFirstPassage(true));
showPassages.addEventListener('change', drawPassages);
document.getElementById('dur-reload').addEventListener('click', loadFiles);

loadFiles().catch((error) => setOutput(`${gettext('Could not load maps:')} ${error.message}`));
