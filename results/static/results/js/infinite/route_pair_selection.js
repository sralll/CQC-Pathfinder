import { dexp, dhypot } from './citygen/core/dmath.js';

export const DEFAULT_ROUTE_PAIR_SELECTION = Object.freeze({
    minSideGap: 10,
    maxRelativeGap: 0.40,
    targetRelativeGap: 0.10,
    relativeGapStdDev: 0.06,
    uniformPairWeight: 0.10,
    highRouteIndexBias: 1.25,
});

export function routeSlotsFor(paths, field, minSlots = 5) {
    let maxIndex = minSlots;
    for (const p of paths || []) {
        if (Number.isFinite(p?.routeIndex)) maxIndex = Math.max(maxIndex, p.routeIndex);
    }
    const slots = Array.from({ length: maxIndex }, () => null);
    for (const p of paths || []) {
        if (!Number.isFinite(p?.routeIndex) || p.routeIndex < 1) continue;
        slots[p.routeIndex - 1] = p[field] ?? null;
    }
    return slots;
}

export function ensureRouteSides(paths, start, goal) {
    const sgDx = goal.x - start.x;
    const sgDy = goal.y - start.y;
    const directLength = dhypot(sgDx, sgDy) || 1;
    for (const p of paths || []) {
        if (Number.isFinite(p.side)) continue;
        let sum = 0;
        for (const pt of p.path || []) sum += sgDx * (pt.y - start.y) - sgDy * (pt.x - start.x);
        p.side = (sum / ((p.path && p.path.length) || 1)) / directLength;
        p.sideLabel = p.side > 0 ? 'R' : p.side < 0 ? 'L' : 'C';
    }
    return directLength;
}

function rngFloat(rng) {
    if (rng && typeof rng.float === 'function') return rng.float();
    if (typeof rng === 'function') return rng();
    return Math.random();
}

function pairWeight(pair, maxRouteIndex, cfg) {
    const z = (pair.relativeGap - cfg.targetRelativeGap) / Math.max(1e-6, cfg.relativeGapStdDev);
    const bell = dexp(-0.5 * z * z);
    const broad = cfg.uniformPairWeight + (1 - cfg.uniformPairWeight) * bell;
    const indexDenom = Math.max(1, maxRouteIndex - 1);
    const indexNorm = Math.max(0, (pair.maxRouteIndex - 1) / indexDenom);
    return broad * (1 + cfg.highRouteIndexBias * indexNorm);
}

function chooseWeighted(candidates, maxRouteIndex, cfg, rng) {
    let total = 0;
    for (const c of candidates) {
        c.weight = pairWeight(c, maxRouteIndex, cfg);
        total += c.weight;
    }
    let r = rngFloat(rng) * total;
    for (const c of candidates) {
        r -= c.weight;
        if (r <= 0) return c;
    }
    return candidates[candidates.length - 1] || null;
}

function rejectionReason(counts) {
    if (!counts.totalPairs) return 'distinct';
    if (counts.runtime === counts.totalPairs) return 'runtime';
    if (counts.lateral > 0 && counts.candidatesBeforeLateral > 0) return 'lateral';
    if (counts.center > 0 && counts.candidatesBeforeCenter > 0) return 'routeside';
    return 'side';
}

export function selectWeightedRoutePair(paths, { start, goal, config = {}, rng = null } = {}) {
    const cfg = { ...DEFAULT_ROUTE_PAIR_SELECTION, ...config };
    if (!paths || paths.length === 0) return { ok: false, reason: 'timeout', selected: null, candidates: [] };
    if (paths.length === 1) return { ok: false, reason: 'distinct', selected: null, candidates: [] };

    const directLength = ensureRouteSides(paths, start, goal);
    let maxRouteIndex = 1;
    for (const p of paths) {
        if (Number.isFinite(p.routeIndex)) maxRouteIndex = Math.max(maxRouteIndex, p.routeIndex);
    }

    const candidates = [];
    const counts = {
        totalPairs: 0,
        runtime: 0,
        side: 0,
        center: 0,
        lateral: 0,
        candidatesBeforeCenter: 0,
        candidatesBeforeLateral: 0,
    };

    for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
            const a = paths[i], b = paths[j];
            if (!Number.isFinite(a.run_time) || !Number.isFinite(b.run_time) || a.run_time <= 0 || b.run_time <= 0) continue;
            counts.totalPairs++;
            const faster = Math.min(a.run_time, b.run_time);
            const slower = Math.max(a.run_time, b.run_time);
            const relativeGap = faster > 0 ? (slower - faster) / faster : Infinity;
            if (!(relativeGap < cfg.maxRelativeGap)) {
                counts.runtime++;
                continue;
            }
            const sideGap = Math.abs(a.side - b.side);
            if (sideGap < cfg.minSideGap || a.side * b.side >= 0) {
                counts.side++;
                continue;
            }
            counts.candidatesBeforeCenter++;
            const routeSideMin = sideGap / 4;
            if (Math.abs(a.side) < routeSideMin || Math.abs(b.side) < routeSideMin) {
                counts.center++;
                continue;
            }
            counts.candidatesBeforeLateral++;
            if (Math.abs(a.side) > directLength || Math.abs(b.side) > directLength) {
                counts.lateral++;
                continue;
            }
            candidates.push({
                i,
                j,
                relativeGap,
                absGap: slower - faster,
                total: a.run_time + b.run_time,
                sideGap,
                maxRouteIndex: Math.max(a.routeIndex || 1, b.routeIndex || 1),
                avgRouteIndex: ((a.routeIndex || 1) + (b.routeIndex || 1)) / 2,
            });
        }
    }

    if (!candidates.length) {
        return { ok: false, reason: rejectionReason(counts), selected: null, candidates, counts };
    }

    const selectedPair = chooseWeighted(candidates, maxRouteIndex, cfg, rng);
    const selected = [paths[selectedPair.i], paths[selectedPair.j]];
    return {
        ok: true,
        reason: 'ok',
        selected,
        pair: selectedPair,
        candidates,
        counts,
        relativeGap: selectedPair.relativeGap,
        sideGap: selectedPair.sideGap,
    };
}

export function skippedBarriersForSelection(paths, selected) {
    const selectedSet = new Set(selected || []);
    // A barrier placed after route R was active only while computing routes
    // with routeIndex > R.  The rendered scene applies each skipped barrier to
    // BOTH selected routes, so it is safe to draw only barriers that predate
    // the lower selected index.  Using the former highest-selected bound made
    // pairs such as routes 1 + 5 render barriers 2..4 across route 1 even though
    // that route existed before those barriers were placed.
    const lowestSelectedIndex = Math.min(
        ...(selected || []).map((p) => p.routeIndex || Infinity),
        Infinity,
    );
    if (!Number.isFinite(lowestSelectedIndex)) return [];
    return (paths || [])
        .filter((p) => p.routeIndex < lowestSelectedIndex && !selectedSet.has(p) && p.barrier)
        .map((p) => p.barrier);
}
