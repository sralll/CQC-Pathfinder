import { bresenhamPoints } from './bresenham.js';

const DEFAULT_SAMPLE_STEP_PX = 24;
const DEFAULT_MIN_SEPARATION_PX = 24;
const DEFAULT_MIN_SEPARATED_SAMPLES = 4;
const DEFAULT_MIN_OBJECT_HITS = 2;
const DEFAULT_MAX_SAMPLES = 72;
const DEFAULT_ENDPOINT_FRACTION = 0.12;

function flatToPoints(flat) {
    const out = [];
    for (let i = 0; i + 1 < (flat?.length || 0); i += 2) {
        const x = Number(flat[i]);
        const y = Number(flat[i + 1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
            out.push({ x, y });
        }
    }
    return out;
}

function routeToPoints(route) {
    if (!route) return [];
    if (Array.isArray(route) && typeof route[0] === 'number') return flatToPoints(route);
    const out = [];
    for (const p of route || []) {
        const x = Number(Array.isArray(p) ? p[0] : p?.x);
        const y = Number(Array.isArray(p) ? p[1] : p?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
    }
    return out;
}

function cumulativeDistances(points) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    }
    return cum;
}

function pointAtDistance(points, cum, distance) {
    if (points.length === 0) return null;
    if (distance <= 0) return points[0];
    const total = cum[cum.length - 1];
    if (distance >= total) return points[points.length - 1];
    let lo = 0;
    let hi = cum.length - 1;
    while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= distance) lo = mid;
        else hi = mid;
    }
    const span = cum[lo + 1] - cum[lo];
    const t = span > 0 ? (distance - cum[lo]) / span : 0;
    const a = points[lo];
    const b = points[lo + 1];
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    };
}

function lineCrossesBlocked(grid, w, h, a, b) {
    const x0 = Math.round(a.x);
    const y0 = Math.round(a.y);
    const x1 = Math.round(b.x);
    const y1 = Math.round(b.y);
    if (x0 < 0 || x0 >= w || y0 < 0 || y0 >= h || x1 < 0 || x1 >= w || y1 < 0 || y1 >= h) {
        return false;
    }
    const line = bresenhamPoints(x0, y0, x1, y1);
    for (let i = 2; i + 3 < line.length; i += 2) {
        const x = line[i];
        const y = line[i + 1];
        if (x >= 0 && x < w && y >= 0 && y < h && grid[y * w + x] === 0) {
            return true;
        }
    }
    return false;
}

function compareRoutes(candidate, existing, grid, w, h, opts) {
    const candCum = cumulativeDistances(candidate);
    const existCum = cumulativeDistances(existing);
    const candLen = candCum[candCum.length - 1];
    const existLen = existCum[existCum.length - 1];
    if (!(candLen > 0) || !(existLen > 0)) {
        return { distinct: false, reason: 'degenerate route', separatedSamples: 0, objectHits: 0, samples: 0 };
    }

    const sampleCount = Math.min(
        opts.maxSamples,
        Math.max(8, Math.ceil(candLen / opts.sampleStepPx)),
    );
    let separatedSamples = 0;
    let objectHits = 0;
    let samples = 0;

    for (let i = 1; i < sampleCount; i++) {
        const f = i / sampleCount;
        if (f < opts.endpointFraction || f > 1 - opts.endpointFraction) continue;
        const a = pointAtDistance(candidate, candCum, candLen * f);
        const b = pointAtDistance(existing, existCum, existLen * f);
        if (!a || !b) continue;
        samples++;
        const sep = Math.hypot(a.x - b.x, a.y - b.y);
        if (sep < opts.minSeparationPx) continue;
        separatedSamples++;
        if (lineCrossesBlocked(grid, w, h, a, b)) objectHits++;
    }

    const distinct = separatedSamples >= opts.minSeparatedSamples && objectHits >= opts.minObjectHits;
    return {
        distinct,
        reason: distinct ? 'real obstacle between routes' : 'no real obstacle between routes',
        separatedSamples,
        objectHits,
        samples,
    };
}

export function routeDistinct(candidateFlat, existingRoutes, grid, w, h, options = {}) {
    const candidate = flatToPoints(candidateFlat);
    const routes = (existingRoutes || []).map(routeToPoints).filter(route => route.length >= 2);
    const opts = {
        sampleStepPx: options.sampleStepPx || DEFAULT_SAMPLE_STEP_PX,
        minSeparationPx: options.minSeparationPx || DEFAULT_MIN_SEPARATION_PX,
        minSeparatedSamples: options.minSeparatedSamples || DEFAULT_MIN_SEPARATED_SAMPLES,
        minObjectHits: options.minObjectHits || DEFAULT_MIN_OBJECT_HITS,
        maxSamples: options.maxSamples || DEFAULT_MAX_SAMPLES,
        endpointFraction: options.endpointFraction ?? DEFAULT_ENDPOINT_FRACTION,
    };

    if (candidate.length < 2) {
        return { distinct: false, reason: 'empty candidate', comparedRoutes: 0 };
    }
    if (routes.length === 0) {
        return { distinct: true, reason: 'first route', comparedRoutes: 0 };
    }

    const perRoute = [];
    for (let i = 0; i < routes.length; i++) {
        const cmp = compareRoutes(candidate, routes[i], grid, w, h, opts);
        perRoute.push({ routeIndex: i, ...cmp });
        if (!cmp.distinct) {
            return {
                distinct: false,
                reason: cmp.reason,
                comparedRoutes: i + 1,
                perRoute,
            };
        }
    }
    return {
        distinct: true,
        reason: 'real obstacle between candidate and all existing routes',
        comparedRoutes: routes.length,
        perRoute,
    };
}
