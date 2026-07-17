import { dexp, dhypot } from './citygen/core/dmath.js';

export const DEFAULT_ROUTE_PAIR_SELECTION = Object.freeze({
    minSideGap: 10,
    maxRelativeGap: 0.40,
    targetRelativeGap: 0.10,
    relativeGapStdDev: 0.06,
    uniformPairWeight: 0.10,
    highRouteIndexBias: 1.25,
    // Infinity masks may set this to 1. Later cumulative alternates otherwise
    // contain several blockers that cannot all be rendered with the lower
    // selected route, producing unexplained detours around invisible walls.
    maxRouteIndexGap: Infinity,
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

function chooseClosestToTarget(candidates, cfg) {
    return candidates.slice().sort((a, b) =>
        Math.abs(a.relativeGap - cfg.targetRelativeGap)
            - Math.abs(b.relativeGap - cfg.targetRelativeGap)
        || a.absGap - b.absGap
        || a.total - b.total
        || b.maxRouteIndex - a.maxRouteIndex
        || a.i - b.i
        || a.j - b.j
    )[0] || null;
}

function rejectionReason(counts) {
    if (!counts.totalPairs) return 'distinct';
    if (counts.runtime === counts.totalPairs) return 'runtime';
    if (counts.lateral > 0 && counts.candidatesBeforeLateral > 0) return 'lateral';
    if (counts.center > 0 && counts.candidatesBeforeCenter > 0) return 'routeside';
    return 'side';
}

function routePairCandidates(paths, { start, goal, config = {} } = {}) {
    const cfg = { ...DEFAULT_ROUTE_PAIR_SELECTION, ...config };
    if (!paths || paths.length === 0) return { ok: false, reason: 'timeout', candidates: [], cfg, maxRouteIndex: 1 };
    if (paths.length === 1) return { ok: false, reason: 'distinct', candidates: [], cfg, maxRouteIndex: 1 };

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
            if (Math.abs((a.routeIndex || 1) - (b.routeIndex || 1)) > cfg.maxRouteIndexGap) {
                counts.side++;
                continue;
            }
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
                targetDistance: Math.abs(relativeGap - cfg.targetRelativeGap),
            });
        }
    }

    if (!candidates.length) {
        return { ok: false, reason: rejectionReason(counts), candidates, counts, cfg, maxRouteIndex };
    }

    return { ok: true, reason: 'ok', candidates, counts, cfg, maxRouteIndex };
}

function selectionResult(paths, candidateSet, selectedPair) {
    if (!candidateSet.ok || !selectedPair) {
        return {
            ok: false,
            reason: candidateSet.reason,
            selected: null,
            candidates: candidateSet.candidates,
            counts: candidateSet.counts,
        };
    }
    const selected = [paths[selectedPair.i], paths[selectedPair.j]];
    return {
        ok: true,
        reason: 'ok',
        selected,
        pair: selectedPair,
        candidates: candidateSet.candidates,
        counts: candidateSet.counts,
        relativeGap: selectedPair.relativeGap,
        sideGap: selectedPair.sideGap,
        targetRelativeGap: candidateSet.cfg.targetRelativeGap,
        targetDistance: selectedPair.targetDistance,
    };
}

export function selectWeightedRoutePair(paths, { start, goal, config = {}, rng = null } = {}) {
    const candidateSet = routePairCandidates(paths, { start, goal, config });
    const selectedPair = candidateSet.ok
        ? chooseWeighted(candidateSet.candidates, candidateSet.maxRouteIndex, candidateSet.cfg, rng)
        : null;
    return selectionResult(paths, candidateSet, selectedPair);
}

/** Apply the full rejection stack, then choose the pair nearest the target gap. */
export function selectRoutePairClosestToTarget(paths, { start, goal, config = {} } = {}) {
    const candidateSet = routePairCandidates(paths, { start, goal, config });
    const selectedPair = candidateSet.ok
        ? chooseClosestToTarget(candidateSet.candidates, candidateSet.cfg)
        : null;
    return selectionResult(paths, candidateSet, selectedPair);
}

export function skippedBarriersForSelection(paths, selected) {
    const selectedSet = new Set(selected || []);
    // Route R+1 was found with route R blocked. If a selected route has index N,
    // visibly retain every unselected blocker below N so the player can see why
    // that higher-index alternative exists. Selected routes themselves are
    // never crossed out.
    const highestSelectedIndex = Math.max(
        ...(selected || []).map((p) => p.routeIndex || 0),
        0,
    );
    return (paths || [])
        .filter((p) => p.routeIndex < highestSelectedIndex && !selectedSet.has(p) && p.barrier)
        .map((p) => p.barrier);
}
