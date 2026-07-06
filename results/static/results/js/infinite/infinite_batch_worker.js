import { generateWards } from './citygen/core/CityGen.js';
import { Random } from './citygen/core/Random.js';
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
const ROUTE_RUNTIME_MIN_SIDE_GAP = 10;
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

// Balance reject (route-choice difficulty tuning).
//
// The two served routes are always the closest pair in runtime. When they are
// *too* close the fastest choice is essentially a coin-flip and does not train
// the player's route-choice skill. `probability` is the chance we reject an
// otherwise-valid problem whose runtime relative gap is within `maxRelativeGap`
// and retry with new endpoints — this shifts the served distribution toward
// clearer left/right decisions without dropping to fewer explored routes.
//
// TUNE HERE:
//   maxRelativeGap — the "within X%" band that counts as too balanced (0.05 = 5%).
//   probability    — reject chance inside that band (0 disables; 1 removes the
//                    band entirely). Uses the per-batch seeded RNG so a given
//                    seed stays reproducible.
//
// This object is mutable so scripts/balance_harness.mjs can sweep it; edit the
// defaults below to change production behaviour.
export const balanceRejectConfig = {
    maxRelativeGap: 0.05,
    probability: 0.8,
};

// Route-selection strategy (experimental — see scripts/selection_harness.mjs).
//
//   'closest'  — production default. Serve the two routes with the SMALLEST
//                runtime gap (subject to balanceRejectConfig).
//   'extremes' — serve the geographic extremes: the left-most route (min side)
//                and the right-most route (max side). These naturally differ
//                more, so the left/right decision is clearer. The pair is only
//                accepted when its runtime gap is *below* `extremesMaxRelativeGap`
//                (too-lopsided pairs are no real decision and get retried).
//
// TUNE HERE:
//   strategy              — 'closest' | 'extremes'.
//   maxRoutes             — routes explored per problem (4 or 5). Each extra
//                           route is forced around the previous route's barrier.
//   primaryRouteBudgetMs  — A* budget for the first two routes (null = none).
//   extraRouteBudgetMs    — A* budget for routes 3+. A route exceeding its
//                           budget is dropped ("kicked").
//   extremesMaxRelativeGap— accept an extremes pair only when its runtime gap is
//                           below this (0.30 = 30%).
//
// Mutable so the harness can sweep it; edit the defaults to change production.
export const selectionConfig = {
    strategy: 'extremes',
    maxRoutes: 5,
    primaryRouteBudgetMs: 400,
    extraRouteBudgetMs: 200,
    extremesMaxRelativeGap: 0.30,
};

function createRng(seed = null) {
    if (!(Number.isFinite(seed) && seed > 0)) {
        return {
            float: () => Math.random(),
            int: (min, max) => Math.floor(min + Math.random() * (max - min + 1)),
        };
    }
    const saved = Random.getSeed();
    Random.reset(seed);
    return {
        float: () => Random.float(),
        int: (min, max) => Math.floor(min + Random.float() * (max - min + 1)),
        restore: () => Random.reset(saved),
    };
}

function randInt(min, max, rng = null) {
    return rng ? rng.int(min, max) : Math.floor(min + Math.random() * (max - min + 1));
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

function selectRuntimeRouteOptions(pair, routeResult, rng = null) {
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

    const bestPair = pairs[0];
    if (!bestPair) return { ...base, reason: 'distinct' };

    if (bestPair.relativeGap > ROUTE_RUNTIME_MAX_RELATIVE_GAP) return { ...base, reason: 'runtime' };

    const selected = [paths[bestPair.i], paths[bestPair.j]];
    const routeSideMin = bestPair.sideGap / 4;
    if (
        bestPair.sideGap < ROUTE_RUNTIME_MIN_SIDE_GAP ||
        selected[0].side * selected[1].side >= 0 ||
        selected.some((p) => Math.abs(p.side) < routeSideMin)
    ) return { ...base, reason: 'routeside' };

    // Balance reject: probabilistically drop problems whose two routes are too
    // close in runtime (see balanceRejectConfig). Uses the seeded per-batch RNG
    // so a given seed stays reproducible; falls back to Math.random if unseeded.
    if (
        bestPair.relativeGap <= balanceRejectConfig.maxRelativeGap &&
        (rng ? rng.float() : Math.random()) < balanceRejectConfig.probability
    ) return { ...base, reason: 'balanced' };

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

// Extremes strategy: serve the left-most and right-most routes (see
// selectionConfig). Mirrors selectRuntimeRouteOptions for enrichment, side
// computation and blocking, but selects by side extremity instead of the
// smallest runtime gap, and accepts only when the runtime gap is below
// selectionConfig.extremesMaxRelativeGap.
function selectExtremeRouteOptions(pair, routeResult, rng = null) {
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

    // routeIndex by run_time (fastest = 1) so blocking/visualisation is stable.
    paths.sort((a, b) => (a.run_time ?? Infinity) - (b.run_time ?? Infinity));
    for (let i = 0; i < paths.length; i++) paths[i].routeIndex = i + 1;

    const withRun = paths.filter((p) => Number.isFinite(p.run_time) && p.run_time > 0);
    if (withRun.length < 2) return { ...base, reason: 'distinct' };

    // Left-most (min side) and right-most (max side).
    let leftmost = withRun[0], rightmost = withRun[0];
    for (const p of withRun) {
        if (p.side < leftmost.side) leftmost = p;
        if (p.side > rightmost.side) rightmost = p;
    }
    if (leftmost === rightmost) return { ...base, reason: 'routeside' };

    const selected = [leftmost, rightmost];
    const sideGap = Math.abs(leftmost.side - rightmost.side);
    const routeSideMin = sideGap / 4;
    // Sign must invert (one L, one R), minimum side gap respected, and each route
    // far enough to its own side (a quarter of the gap from centre).
    if (
        sideGap < ROUTE_RUNTIME_MIN_SIDE_GAP ||
        leftmost.side * rightmost.side >= 0 ||
        selected.some((p) => Math.abs(p.side) < routeSideMin)
    ) return { ...base, reason: 'routeside' };

    const faster = Math.min(leftmost.run_time, rightmost.run_time);
    const slower = Math.max(leftmost.run_time, rightmost.run_time);
    const relativeGap = faster > 0 ? (slower - faster) / faster : Infinity;
    // Accept only a genuine-but-decidable difference: below the cap. Above it the
    // choice is obvious (no training value) — retry with new endpoints.
    if (relativeGap >= selectionConfig.extremesMaxRelativeGap) return { ...base, reason: 'runtime' };

    // Block every route that is not one of the two served (left-most/right-most).
    const skippedBarriers = paths
        .filter((p) => p !== leftmost && p !== rightmost && p.barrier)
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

function routePickWeightedPoint(pool, rng) {
    let total = 0;
    for (const p of pool) total += p.weight;
    let r = rng.float() * total;
    for (const p of pool) {
        r -= p.weight;
        if (r <= 0) return p;
    }
    return pool[pool.length - 1] || null;
}

function routePickPoint(candidates, visGraph, wall = null, rng = createRng()) {
    const pool = [];
    for (let attempt = 0; attempt < 500; attempt++) {
        const item = candidates[(rng.float() * candidates.length) | 0];
        const b = item.bbox;
        for (let local = 0; local < 20; local++) {
            const pt = {
                x: b.minX + rng.float() * (b.maxX - b.minX),
                y: b.minY + rng.float() * (b.maxY - b.minY),
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
                const picked = routePickWeightedPoint(pool, rng);
                if (!picked) return null;
                const { weight, ...out } = picked;
                return out;
            }
        }
    }
    const picked = routePickWeightedPoint(pool, rng);
    if (!picked) return null;
    const { weight, ...out } = picked;
    return out;
}

function routePickPair(candidates, visGraph, wall = null, rng = createRng()) {
    for (let attempt = 0; attempt < 1000; attempt++) {
        const start = routePickPoint(candidates, visGraph, wall, rng);
        const goal = routePickPoint(candidates, visGraph, wall, rng);
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

function normalizeSettings(settings = {}, rng = createRng()) {
    const seed = Number.isFinite(Number(settings.seed)) && Number(settings.seed) > 0
        ? Math.trunc(Number(settings.seed))
        : Math.floor(rng.float() * 2147483646) + 1;
    return {
        ...CITY_SETTINGS,
        ...settings,
        seed,
        size: Number.isFinite(Number(settings.size)) ? Math.trunc(Number(settings.size)) : randInt(25, 40, rng),
        river: settings.river != null ? !!settings.river : rng.float() >= 0.45,
        coast: settings.coast != null ? !!settings.coast : rng.float() >= 0.45,
        walls: settings.walls != null ? !!settings.walls : rng.float() >= 0.20,
    };
}

function makeBatchSkeleton(city, settings, generationMs, graphMs, rejectionCounts) {
    return {
        kind: 'city-batch',
        city,
        scenes: [],
        index: 0,
        meta: {
            seed: settings.seed,
            settings,
            generationMs,
            graphMs,
            routeCount: 0,
            rejectionCounts,
        },
    };
}

function buildSceneBatchCandidate(pairCount, options = {}) {
    const rng = options.rng || createRng(options.seed || options.settings?.seed || null);
    const settings = normalizeSettings(options.settings || { seed: options.seed }, rng);

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

    const rejectionCounts = { distinct: 0, distance: 0, side: 0, routeside: 0, balanced: 0, timeout: 0 };
    const batch = makeBatchSkeleton(city, settings, generationMs, graphMs, rejectionCounts);
    const scenes = batch.scenes;
    const usedEndpoints = [];
    const maxRetries = CITY_ROUTE_RETRIES * pairCount;

    for (let retries = 0; retries < maxRetries && scenes.length < pairCount; retries++) {
        const pair = routePickPair(candidates, visibilityGraph, city.wall, rng);
        if (!pair) {
            rejectionCounts.distance++;
            continue;
        }
        if (routePairTooCloseToUsed(pair, usedEndpoints)) {
            rejectionCounts.distance++;
            continue;
        }
        const routeResult = computeRouteOptions(pair.start, pair.goal, visibilityGraph, {
            maxRoutes: selectionConfig.maxRoutes,
            primaryBudgetMs: selectionConfig.primaryRouteBudgetMs,
            extraBudgetMs: selectionConfig.extraRouteBudgetMs,
        });
        const runtimeResult = selectionConfig.strategy === 'extremes'
            ? selectExtremeRouteOptions(pair, routeResult, rng)
            : selectRuntimeRouteOptions(pair, routeResult, rng);
        if (runtimeResult.ok) {
            const scene = buildSceneFromRouteResult(city, pair, runtimeResult);
            scene.meta = {
                seed: settings.seed,
                settings,
                generationMs,
                graphMs,
                retries,
                pairIndex: scenes.length,
                routeMs: routeResult.dt,
                rejectionCounts,
            };
            scenes.push(scene);
            batch.meta.routeCount = scenes.length;
            options.onScene?.(scene, scenes.length - 1, batch);
            usedEndpoints.push(pair.start, pair.goal);
            continue;
        }
        const rejectionReason = runtimeResult.reason || (runtimeResult.timeout ? 'timeout' : 'side');
        if (rejectionReason === 'timeout') rejectionCounts.timeout++;
        else if (rejectionReason === 'distinct') rejectionCounts.distinct++;
        else if (rejectionReason === 'runtime') rejectionCounts.distance++;
        else if (rejectionReason === 'routeside') rejectionCounts.routeside++;
        else if (rejectionReason === 'balanced') rejectionCounts.balanced++;
        else rejectionCounts.side++;
    }

    if (scenes.length < pairCount) throw new Error(`Only found ${scenes.length}/${pairCount} route pairs for seed ${settings.seed}`);

    scenes.forEach((batchScene, batchIndex) => {
        batchScene.batch = batch;
        batchScene.batchIndex = batchIndex;
    });
    return batch;
}

export function generateSceneBatch(pairCount, options = {}) {
    let lastError = null;
    for (let i = 0; i < CITY_SCENE_ATTEMPTS; i++) {
        try {
            return buildSceneBatchCandidate(pairCount, options);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('No routable city batch generated');
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

export function determinismHashForSeed(seed, pairCount = 3) {
    const batch = generateSceneBatch(pairCount, {
        seed,
        settings: {
            ...CITY_SETTINGS,
            seed,
            size: 32,
            river: true,
            coast: true,
            walls: true,
        },
    });
    const summary = {
        city: batch.city,
        scenes: batch.scenes.map((scene) => ({
            start: scene.start,
            ziel: scene.ziel,
            routes: scene.routes.map((route) => ({
                points: route.points,
                length: route.length,
                noA: route.noA,
                run_time: route.run_time,
                side: route.side,
            })),
            routeIndexes: scene.routeResult?.routeIndexes || [],
            routeRuntimeSlots: scene.routeResult?.routeRuntimeSlots || [],
            routeNoASlots: scene.routeResult?.routeNoASlots || [],
        })),
    };
    return hashString(stableStringify(summary));
}

export function runDeterminismCheck(seeds, pairCount = 3) {
    return seeds.map((seed) => ({ seed, hash: determinismHashForSeed(seed, pairCount) }));
}

function generateCity(settings) {
    const normalized = normalizeSettings(settings || {}, createRng(settings?.seed || null));
    return {
        city: generateWards(normalized),
        settings: normalized,
    };
}

if (typeof self !== 'undefined' && self.addEventListener) self.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    const startTime = performance.now();
    try {
        if (msg.type === 'generateCity') {
            const result = generateCity(msg.settings || { seed: msg.seed });
            self.postMessage({
                type: 'city',
                msgId: msg.msgId,
                ...result,
                elapsedMs: performance.now() - startTime,
            });
            return;
        }

        if (msg.type === 'determinism') {
            self.postMessage({
                type: 'determinism',
                msgId: msg.msgId,
                hashes: runDeterminismCheck(msg.seeds || [], msg.pairCount || 3),
                elapsedMs: performance.now() - startTime,
            });
            return;
        }

        if (msg.type !== 'generateBatch') return;

        const stream = msg.stream !== false;
        const batch = generateSceneBatch(msg.pairCount || 5, {
            seed: msg.seed,
            settings: msg.settings,
            onScene: stream
                ? (scene, index, batchRef) => {
                    const { batch: _batch, ...scenePayload } = scene;
                    self.postMessage({
                        type: 'scene',
                        msgId: msg.msgId,
                        index,
                        scene: scenePayload,
                        batchMeta: batchRef.meta,
                        elapsedMs: performance.now() - startTime,
                    });
                }
                : null,
        });
        self.postMessage({
            type: stream ? 'batch_done' : 'batch',
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
