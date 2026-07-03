import { ROUTE_BARRIER_DRAW_WIDTH } from './infinite/citygen/core/RoutePlanner.js';

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
const deleteReportBtn = document.getElementById('di-delete-report');

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

function csrfToken() {
    return root.dataset.csrfToken || document.querySelector('meta[name="csrf-token"]')?.content || '';
}

function clearReport(message = 'Select a report') {
    currentReport = null;
    mapLayer.replaceChildren();
    routeLayer.replaceChildren();
    controlLayer.replaceChildren();
    setViewBox({ x: -100, y: -100, w: 200, h: 200 });
    titleEl.textContent = 'Select a report';
    deleteReportBtn.disabled = true;
    setStatus(message);
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

function mapWardBaseFill(ward) {
    const outerCity = ward.type === 'outerGarden' || ward.type === 'outerHighrise';
    return ward.water
        ? MAP_PALETTE.waterFill
        : (ward.inner || outerCity) ? MAP_PALETTE.innerFill : MAP_PALETTE.outerFill;
}

function mapPolyPath(points) {
    if (!points || points.length < 2) return '';
    return `M${points.map((p) => `${p.x},${p.y}`).join('L')}`;
}

function mapPolygonPath(points) {
    if (!points || points.length < 3) return '';
    return `M${points.map((p) => `${p.x},${p.y}`).join('L')}Z`;
}

function mapPointDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function mapPointKey(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? `${point.x.toFixed(6)},${point.y.toFixed(6)}`
        : '';
}

function mapPointSet(points) {
    return new Set((points || []).map(mapPointKey).filter(Boolean));
}

function mapChaikinSmooth(points, iterations) {
    if (!points || points.length < 3) return points || [];
    let smoothed = points;
    for (let it = 0; it < iterations; it++) {
        const next = [smoothed[0]];
        for (let i = 1, n = smoothed.length - 1; i < n; i++) {
            const current = smoothed[i], prev = smoothed[i - 1], following = smoothed[i + 1];
            next.push({ x: current.x * 0.75 + prev.x * 0.25, y: current.y * 0.75 + prev.y * 0.25 });
            next.push({ x: current.x * 0.75 + following.x * 0.25, y: current.y * 0.75 + following.y * 0.25 });
        }
        next.push(smoothed[smoothed.length - 1]);
        smoothed = next;
    }
    return smoothed;
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

function mapDeltaPath(delta) {
    let d = `M${delta.right.x},${delta.right.y}`;
    d += ` C${delta.rightCtrl1.x},${delta.rightCtrl1.y} ${delta.rightCtrl2.x},${delta.rightCtrl2.y} ${delta.prevShore.x},${delta.prevShore.y}`;
    if (delta.isConvex) d += ` L${delta.mouth.x},${delta.mouth.y}`;
    d += ` L${delta.nextShore.x},${delta.nextShore.y}`;
    d += ` C${delta.leftCtrl1.x},${delta.leftCtrl1.y} ${delta.leftCtrl2.x},${delta.leftCtrl2.y} ${delta.left.x},${delta.left.y}`;
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

function drawPath(layer, d, attrs) {
    if (!d) return;
    const node = el('path');
    node.setAttribute('d', d);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    layer.appendChild(node);
}

function drawMapWaterBody(layer, wards, river, riverGeometry) {
    let d = '';
    for (const ward of wards || []) if (ward.water) d += mapPolygonPath(ward.polygon);
    if (riverGeometry?.delta) d += mapDeltaPath(riverGeometry.delta);
    const hasRiver = riverGeometry && river?.width;
    const outlineWidth = MAP_WATER_OUTLINE_WIDTH * 2;
    if (d) {
        drawPath(layer, d, {
            fill: 'none',
            stroke: MAP_PALETTE.waterStroke,
            'stroke-width': outlineWidth,
            'stroke-linejoin': 'round',
        });
    }
    if (hasRiver) {
        drawPath(layer, riverGeometry.pathD, {
            fill: 'none',
            stroke: MAP_PALETTE.waterStroke,
            'stroke-width': river.width + outlineWidth,
            'stroke-linecap': river.delta ? 'butt' : 'round',
            'stroke-linejoin': 'round',
        });
    }
    if (d) drawPath(layer, d, { fill: MAP_PALETTE.waterFill, stroke: 'none' });
    if (hasRiver) {
        drawPath(layer, riverGeometry.fillPathD || riverGeometry.pathD, {
            fill: 'none',
            stroke: MAP_PALETTE.river,
            'stroke-width': river.width,
            'stroke-linecap': river.delta ? 'butt' : 'round',
            'stroke-linejoin': 'round',
        });
    }
}

function mapClosestPointOnSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
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
        const fill = MAP_PALETTE.innerFill;
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
        drawPolygon(layer, [
            mapBridgeDeckBleedPoint(left, left.minus, deckBleed),
            mapBridgeDeckBleedPoint(left, left.plus, deckBleed),
            mapBridgeDeckBleedPoint(right, right.plus, deckBleed),
            mapBridgeDeckBleedPoint(right, right.minus, deckBleed),
        ], fill);
        for (const side of [left, right]) {
            const rail = el('line');
            rail.setAttribute('x1', side.minus.x);
            rail.setAttribute('y1', side.minus.y);
            rail.setAttribute('x2', side.plus.x);
            rail.setAttribute('y2', side.plus.y);
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
        const fill = MAP_PALETTE.innerFill;
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
                drawPath(layer, d, {
                    fill: 'none',
                    stroke,
                    'stroke-width': width,
                    'stroke-linecap': 'butt',
                    'stroke-linejoin': 'round',
                });
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
    return `${d}Z`;
}

function drawMapBlocks(layer, blocks) {
    if (!blocks || blocks.length === 0) return;
    let d = '';
    for (const block of blocks) {
        const rounded = mapRoundedBlockPath(block, MAP_BLOCK_OUTLINE_FILLET);
        if (rounded) d += rounded;
    }
    drawPath(layer, d, {
        fill: 'none',
        stroke: MAP_PALETTE.block,
        'stroke-width': '0.06',
        'stroke-linejoin': 'round',
        'fill-rule': 'evenodd',
    });
}

function drawMapBuildings(layer, buildings) {
    if (!buildings || buildings.length === 0) return;
    for (const building of buildings) {
        const polygon = Array.isArray(building) ? building : building.polygon;
        if (!polygon || polygon.length < 3) continue;
        const cls = Array.isArray(building) ? null : building.class;
        let fill = MAP_PALETTE.building, stroke = MAP_PALETTE.buildingStroke;
        if (cls === 'park' || cls === 'outerHighrisePark') { fill = MAP_PALETTE.park; stroke = MAP_PALETTE.parkStroke; }
        else if (cls === 'largestLotInset' || cls === 'housingEntranceFill') { fill = MAP_PALETTE.largestLotInset; stroke = MAP_PALETTE.buildingStroke; }
        else if (cls === 'outerHighrisePath') { fill = MAP_PALETTE.alley; stroke = 'none'; }
        else if (cls === 'outerGarden') { fill = MAP_PALETTE.outerGarden; stroke = MAP_PALETTE.outerGarden; }
        else if (cls === 'outerGardenOutline') { fill = 'none'; stroke = MAP_PALETTE.buildingStroke; }
        else if (cls === 'cathedralGround') { fill = MAP_PALETTE.cathedralGround; stroke = MAP_PALETTE.parkStroke; }
        else if (cls === 'cathedral') { fill = MAP_PALETTE.cathedral; stroke = MAP_PALETTE.cathedralStroke; }
        else if (cls === 'plazaBuilding') { fill = MAP_PALETTE.plazaBuilding; stroke = MAP_PALETTE.buildingStroke; }

        const node = el('polygon');
        node.setAttribute('points', polygonPoints(polygon));
        node.setAttribute('fill', fill);
        node.setAttribute('stroke', stroke);
        if (cls === 'outerGarden' || cls === 'outerHighrisePath') {
            node.setAttribute('stroke-width', '0');
        } else if (cls === 'outerGardenOutline') {
            node.setAttribute('stroke-width', MAP_BUILDING_OUTLINE_WIDTH);
        } else if (cls === 'largestLotInset' || cls === 'housingEntranceFill') {
            node.setAttribute('stroke-width', MAP_BUILDING_OUTLINE_WIDTH / 2);
        } else if (cls === 'cathedral' || cls === 'cathedralGround' || cls === 'park' || cls === 'outerHighrisePark') {
            node.setAttribute('stroke-width', MAP_BUILDING_OUTLINE_WIDTH / 2);
        } else {
            node.setAttribute('stroke-width', MAP_BUILDING_OUTLINE_WIDTH);
        }
        node.setAttribute('stroke-linejoin', 'round');
        layer.appendChild(node);
    }
}

function drawMapLines(layer, lines, stroke, width) {
    for (const line of lines || []) {
        if (!line || line.length < 2) continue;
        if (!line.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
        const node = el('polyline');
        node.setAttribute('points', pathPoints(line));
        node.setAttribute('fill', 'none');
        node.setAttribute('stroke', stroke);
        node.setAttribute('stroke-width', width);
        node.setAttribute('stroke-linecap', 'butt');
        node.setAttribute('stroke-linejoin', 'round');
        layer.appendChild(node);
    }
}

function drawMapWall(layer, wall, riverWidth, riverNodeKeys) {
    if (!wall || !wall.shape || wall.shape.length < 2) return;
    const thickness = MAP_CITY_WALL_WIDTH;
    const outlineThickness = thickness + MAP_BUILDING_OUTLINE_WIDTH;
    const n = wall.shape.length;
    const segments = wall.segments;
    const halfRiver = (riverWidth || 0) / 2;
    const endpointAt = new Map();
    const isRiverNode = (point) => riverNodeKeys && riverNodeKeys.has(mapPointKey(point));
    for (let i = 0; i < n; i++) {
        if (segments && segments[i] === false) continue;
        let a = wall.shape[i];
        let b = wall.shape[(i + 1) % n];
        if (halfRiver > 0 && segments) {
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len;
            let ax = a.x, ay = a.y, bx = b.x, by = b.y;
            if (segments[(i + n - 1) % n] === false || isRiverNode(a)) { ax = a.x + ux * halfRiver; ay = a.y + uy * halfRiver; }
            if (segments[(i + 1) % n] === false || isRiverNode(b)) { bx = b.x - ux * halfRiver; by = b.y - uy * halfRiver; }
            a = { x: ax, y: ay };
            b = { x: bx, y: by };
        }
        endpointAt.set(i, a);
        endpointAt.set((i + 1) % n, b);
        for (const [stroke, width] of [[MAP_PALETTE.wallOutline, outlineThickness], [MAP_PALETTE.wall, thickness]]) {
            const segment = el('line');
            segment.setAttribute('x1', a.x);
            segment.setAttribute('y1', a.y);
            segment.setAttribute('x2', b.x);
            segment.setAttribute('y2', b.y);
            segment.setAttribute('stroke', stroke);
            segment.setAttribute('stroke-width', width);
            segment.setAttribute('stroke-linecap', 'butt');
            segment.setAttribute('stroke-linejoin', 'round');
            layer.appendChild(segment);
        }
    }
    const towerR = thickness * MAP_WALL_TOWER_DIAMETER_SCALE / 2;
    for (const towerPoint of wall.towers || []) {
        const ti = wall.shape.findIndex((p) => Math.abs(p.x - towerPoint.x) < 1e-6 && Math.abs(p.y - towerPoint.y) < 1e-6);
        const pos = (ti !== -1 && endpointAt.get(ti)) || towerPoint;
        drawCircle(layer, pos, towerR, MAP_PALETTE.wall, MAP_PALETTE.wallOutline, MAP_BUILDING_OUTLINE_WIDTH);
    }
    for (const gate of wall.gates || []) {
        if (isRiverNode(gate)) continue;
        const idx = wall.shape.findIndex((p) => Math.abs(p.x - gate.x) < 1e-6 && Math.abs(p.y - gate.y) < 1e-6);
        const pos = (idx !== -1 && endpointAt.get(idx)) || gate;
        drawCircle(layer, pos, towerR, MAP_PALETTE.gateTower, MAP_PALETTE.wallOutline, MAP_GATE_TOWER_OUTLINE_WIDTH);
    }
}

function drawMapFeatures(layer, features) {
    const r = 0.5;
    for (const feature of features || []) {
        if (!Number.isFinite(feature.x) || !Number.isFinite(feature.y)) continue;
        const isTree = feature.kind === 'tree';
        drawCircle(
            layer,
            feature,
            isTree ? 0.67 * r : r,
            isTree ? MAP_PALETTE.featureTree : 'none',
            isTree ? 'none' : feature.kind === 'object' ? MAP_PALETTE.featureObject : MAP_PALETTE.featureFountain,
            isTree ? 0 : 0.2,
        );
    }
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
        if (!ward.polygon || ward.polygon.length < 3) continue;
        drawPolygon(mapLayer, ward.polygon, mapWardBaseFill(ward));
    }
    const riverGeometry = mapRiverRenderGeometry(city.river);
    drawMapBlocks(mapLayer, city.blocks);
    drawMapBuildings(mapLayer, city.buildings);
    drawMapLines(mapLayer, city.hedges, MAP_PALETTE.hedge, MAP_HEDGE_WIDTH);
    drawMapLines(mapLayer, city.cathedralHedges, MAP_PALETTE.cathedralWall, MAP_HEDGE_WIDTH);
    drawMapWaterBody(mapLayer, city.wards, city.river, riverGeometry);
    if (riverGeometry) drawMapBridges(mapLayer, city.river, riverGeometry.visualCourse);
    drawMapDocks(mapLayer, city.docks);
    drawMapWall(mapLayer, city.wall, city.river && city.river.width, mapPointSet(city.river?.course));
    drawMapFeatures(mapLayer, city.features);
}

function routePoints(route) {
    return route?.points || route?.rP || [];
}

function drawReport(report, city) {
    currentReport = report;
    deleteReportBtn.disabled = false;
    drawCity(city);
    routeLayer.replaceChildren();
    controlLayer.replaceChildren();
    routeLayer.style.display = routesVisible ? '' : 'none';

    for (const [index, route] of (report.routes || []).entries()) {
        const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
        drawPolyline(routeLayer, routePoints(route), '#fff', 4, 0.9);
        drawPolyline(routeLayer, routePoints(route), color, 2, 1);
    }
    // Blocking bars, drawn like infinite_play's drawRouteBlocks. They live in
    // the control layer (not the route layer) so they stay visible when the
    // route overlay is toggled off — they are part of the scene, not a route.
    for (const b of report.skipped_barriers || []) {
        if (![b?.ax, b?.ay, b?.bx, b?.by].every(Number.isFinite)) continue;
        const line = el('line');
        line.setAttribute('x1', b.ax);
        line.setAttribute('y1', b.ay);
        line.setAttribute('x2', b.bx);
        line.setAttribute('y2', b.by);
        line.setAttribute('stroke', CONTROL_COLOR);
        line.setAttribute('stroke-width', ROUTE_BARRIER_DRAW_WIDTH);
        line.setAttribute('stroke-linecap', 'butt');
        controlLayer.appendChild(line);
    }
    drawCircle(controlLayer, report.start, CONTROL_RADIUS, 'none', CONTROL_COLOR, 0.45);
    drawCircle(controlLayer, report.goal, CONTROL_RADIUS, 'none', CONTROL_COLOR, 0.45);
    drawCircle(controlLayer, report.goal, 0.75, CONTROL_COLOR, CONTROL_COLOR, 0);

    const routePts = (report.routes || []).flatMap(routePoints);
    setViewBox(paddedBounds(city?.bounds || report.client_state?.cityBounds, [report.start, report.goal, ...routePts]));
    titleEl.textContent = `Report #${report.id} | seed ${report.seed} | pair ${report.pair_index ?? '-'}`;
    setStatus(
        'Report data',
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

async function deleteCurrentReport() {
    if (!currentReport) return;
    const report = currentReport;
    const confirmed = window.confirm(`Delete report #${report.id}?`);
    if (!confirmed) return;

    deleteReportBtn.disabled = true;
    setStatus(`Deleting report #${report.id}...`);
    const response = await fetch(`${root.dataset.reportBaseUrl}${report.id}/`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-CSRFToken': csrfToken() },
    });
    if (!response.ok) {
        deleteReportBtn.disabled = false;
        throw new Error(`Delete failed (${response.status})`);
    }
    clearReport(`Deleted report #${report.id}.`);
    await loadReports();
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
deleteReportBtn.addEventListener('click', () => {
    deleteCurrentReport().catch((err) => setStatus(err.message));
});
toggleRoutesBtn.addEventListener('click', () => {
    routesVisible = !routesVisible;
    toggleRoutesBtn.setAttribute('aria-pressed', routesVisible ? 'true' : 'false');
    routeLayer.style.display = routesVisible ? '' : 'none';
});

initPanZoom();
loadReports().catch((err) => setStatus(err.message));
