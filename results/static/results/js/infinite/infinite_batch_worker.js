import { generateWards } from './citygen/core/CityGen.js';
import {
    buildRouteVisibilityGraph,
    computeRouteOptions,
} from './citygen/core/RoutePlanner.js';

const RUN_SPEED = 4.75;
const ALT_FLAT_EQUIV_M = 4;
const NOA_CLUSTER_WINDOW_M = 20;
const NOA_COUNTER_TURN_WINDOW_M = 10;
const NOA_ARTIFACT_WINDOW_M = 5;
const NOA_MIN_SEGMENT_M = 1.5;
const NOA_CORNER_DEG = 90;
const NOA_EPSILON_DEG = 2;
const NOA_MIN_EFFECT_DEG = 45;
const NOA_COUNTER_MIN_DEG = 45;
const ROUTE_RUNTIME_MAX_RELATIVE_GAP = 0.5;
const MAP_METRES_PER_UNIT = 2.5;
const ROUTE_PICK_MIN_DIST = 40;
const ROUTE_PICK_MAX_DIST = 120;
const ROUTE_PICK_OUTSIDE_WALL_MAX_DIST = 12;
const ROUTE_PICK_POINT_POOL_SIZE = 64;
const ROUTE_PICK_INTERIOR_BIAS_POWER = 3;
const ROUTE_PICK_INTERIOR_BIAS_CAP = 12;
const ROUTE_PICK_INTERIOR_BIAS_EPS = 0.25;
const CITY_ROUTE_RETRIES = 240;
const CITY_SCENE_ATTEMPTS = 12;
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

function randInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
}

function mapMetresPerUnit() {
    return MAP_METRES_PER_UNIT;
}

function calcRuntimeRouteLength(path) {
    if (!path || path.length < 2) return 0;
    const metresPerUnit = mapMetresPerUnit();
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

function simplifiedNoAPoints(points) {
    const minStep = NOA_MIN_SEGMENT_M / mapMetresPerUnit();
    const out = [];
    for (const p of points || []) {
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        const current = { x: p.x, y: p.y };
        const prev = out[out.length - 1];
        if (!prev || Math.hypot(current.x - prev.x, current.y - prev.y) >= minStep) out.push(current);
    }
    const last = points?.[points.length - 1];
    if (out.length && last && Number.isFinite(last.x) && Number.isFinite(last.y)) {
        out[out.length - 1] = { x: last.x, y: last.y };
    }
    return out;
}

function calcRuntimeRouteNoA(path) {
    const rP = simplifiedNoAPoints(path);
    if (!rP || rP.length < 3) return 0;

    const epsRad = NOA_EPSILON_DEG * Math.PI / 180;
    const metresPerUnit = mapMetresPerUnit();
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
        while (i < turns.length && turns[i].pos - cluster[0].pos <= NOA_CLUSTER_WINDOW_M) cluster.push(turns[i++]);

        const span = cluster[cluster.length - 1].pos - cluster[0].pos;
        const totalAbs = cluster.reduce((sum, turn) => sum + turn.absDeg, 0);
        const net = Math.abs(cluster.reduce((sum, turn) => sum + turn.signedDeg, 0));
        const maxTurn = Math.max(...cluster.map(turn => turn.absDeg));
        if (span <= NOA_ARTIFACT_WINDOW_M && net < NOA_MIN_EFFECT_DEG && totalAbs >= NOA_CORNER_DEG) continue;

        const directionDeg = Math.max(maxTurn, net);
        if (directionDeg >= NOA_MIN_EFFECT_DEG || totalAbs >= NOA_CORNER_DEG) noA += directionDeg / NOA_CORNER_DEG;

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
        if (counterDeg >= NOA_COUNTER_MIN_DEG) noA += counterDeg / (2 * NOA_CORNER_DEG);
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

function runtimeSlotsFor(paths, field) {
    const slots = [null, null, null, null];
    for (const p of paths || []) slots[p.routeIndex - 1] = p[field] ?? null;
    return slots;
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

    const sgDx = pair.goal.x - pair.start.x;
    const sgDy = pair.goal.y - pair.start.y;
    const sgLen = Math.hypot(sgDx, sgDy) || 1;
    for (const p of paths) {
        if (Number.isFinite(p.side)) continue;
        let sum = 0;
        for (const pt of p.path) sum += sgDx * (pt.y - pair.start.y) - sgDy * (pt.x - pair.start.x);
        p.side = (sum / p.path.length) / sgLen;
        p.sideLabel = p.side > 0 ? 'R' : p.side < 0 ? 'L' : 'C';
    }

    paths.sort((a, b) => (a.run_time ?? Infinity) - (b.run_time ?? Infinity));
    for (let i = 0; i < paths.length; i++) paths[i].routeIndex = i + 1;

    const pairs = [];
    for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
            const a = paths[i], b = paths[j];
            if (!a.run_time || !b.run_time) continue;
            const faster = Math.min(a.run_time, b.run_time);
            const slower = Math.max(a.run_time, b.run_time);
            pairs.push({
                i,
                j,
                relativeGap: faster > 0 ? (slower - faster) / faster : Infinity,
                absGap: slower - faster,
                total: a.run_time + b.run_time,
                sideGap: Math.abs(a.side - b.side),
            });
        }
    }
    pairs.sort((a, b) => a.relativeGap - b.relativeGap || a.absGap - b.absGap || a.total - b.total);

    const bestPair = pairs.filter((p) => {
        const selected = [paths[p.i], paths[p.j]];
        return p.sideGap >= 10 && selected[0].side * selected[1].side < 0;
    })[0];
    if (!bestPair) return { ...base, reason: 'side' };

    const selected = [paths[bestPair.i], paths[bestPair.j]];
    const routeSideMin = bestPair.sideGap / 4;
    if (selected.some((p) => Math.abs(p.side) < routeSideMin)) return { ...base, reason: 'routeside' };
    if (bestPair.relativeGap > ROUTE_RUNTIME_MAX_RELATIVE_GAP) return { ...base, reason: 'runtime' };

    const selectedFastest = Math.min(selected[0].run_time, selected[1].run_time);
    const skippedBarriers = paths
        .filter((p) => p.run_time < selectedFastest && p.barrier)
        .map((p) => p.barrier);

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

function buildSceneFromRouteResult(city, pair, routeResult) {
    const selected = routeResult.selected.slice().sort((a, b) => (a.side || 0) - (b.side || 0));
    const routes = selected.map((r) => ({
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
    }));
    return {
        kind: 'city',
        city,
        routeResult,
        start: pair.start,
        ziel: pair.goal,
        routes,
        mapScale: 1,
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
    for (let i = 0; i < pts.length; i++) best = Math.min(best, routePickPointSegmentDistance(pt, pts[i], pts[(i + 1) % pts.length]));
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
        if (straightLine >= ROUTE_PICK_MIN_DIST && straightLine <= ROUTE_PICK_MAX_DIST) return { start, goal, straightLine };
    }
    return null;
}

function routePairTooCloseToUsed(pair, usedEndpoints) {
    for (const endpoint of usedEndpoints) {
        if (Math.hypot(pair.start.x - endpoint.x, pair.start.y - endpoint.y) < CONTROL_PAIR_ENDPOINT_MIN_GAP) return true;
        if (Math.hypot(pair.goal.x - endpoint.x, pair.goal.y - endpoint.y) < CONTROL_PAIR_ENDPOINT_MIN_GAP) return true;
    }
    return false;
}

function buildSceneBatchCandidate(pairCount) {
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

    const rejectionCounts = { distinct: 0, distance: 0, side: 0, routeside: 0, timeout: 0 };
    const scenes = [];
    const usedEndpoints = [];
    const maxRetries = CITY_ROUTE_RETRIES * pairCount;

    for (let retries = 0; retries < maxRetries && scenes.length < pairCount; retries++) {
        const pair = routePickPair(candidates, visibilityGraph, city.wall);
        if (!pair) {
            rejectionCounts.distance++;
            continue;
        }
        if (routePairTooCloseToUsed(pair, usedEndpoints)) {
            rejectionCounts.distance++;
            continue;
        }
        const routeResult = computeRouteOptions(pair.start, pair.goal, visibilityGraph);
        const runtimeResult = selectRuntimeRouteOptions(pair, routeResult);
        if (runtimeResult.ok) {
            const scene = buildSceneFromRouteResult(city, pair, runtimeResult);
            scene.meta = {
                seed,
                settings,
                generationMs,
                graphMs,
                retries,
                pairIndex: scenes.length,
                routeMs: routeResult.dt,
                rejectionCounts,
            };
            scenes.push(scene);
            usedEndpoints.push(pair.start, pair.goal);
            continue;
        }
        const rejectionReason = runtimeResult.reason || (runtimeResult.timeout ? 'timeout' : 'side');
        if (rejectionReason === 'timeout') rejectionCounts.timeout++;
        else if (rejectionReason === 'distinct') rejectionCounts.distinct++;
        else if (rejectionReason === 'runtime') rejectionCounts.distance++;
        else if (rejectionReason === 'routeside') rejectionCounts.routeside++;
        else rejectionCounts.side++;
    }

    if (scenes.length < pairCount) throw new Error(`Only found ${scenes.length}/${pairCount} route pairs for seed ${seed}`);

    const batch = {
        kind: 'city-batch',
        city,
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

function generateSceneBatch(pairCount) {
    let lastError = null;
    for (let i = 0; i < CITY_SCENE_ATTEMPTS; i++) {
        try {
            return buildSceneBatchCandidate(pairCount);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('No routable city batch generated');
}

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'generateBatch') return;

    const startTime = performance.now();
    try {
        const batch = generateSceneBatch(msg.pairCount || 5);
        self.postMessage({
            type: 'batch',
            msgId: msg.msgId,
            batch,
            elapsedMs: performance.now() - startTime,
        });
    } catch (err) {
        self.postMessage({
            type: 'batch',
            msgId: msg.msgId,
            error: String(err && err.message || err),
            elapsedMs: performance.now() - startTime,
        });
    }
});
