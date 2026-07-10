// Passage-aware routing branch. The established base-only runPipeline() remains
// untouched and is selected by worker.js whenever no valid passages exist.

import { extractSubgrid, snapToFree, corridorMask, applyCorridor } from './preprocess.js';
import { simplifyAStarSameTerrainPath, simplifyThetaPath } from './simplify.js';
import { guidedThetaStar } from './theta_star.js';
import { layeredAstar } from './layered_astar.js';
import { applySurfaceRouteMasks } from './surface_route_mask.js';

const SCALE_REFERENCE = 0.5;
const INITIAL_MARGIN_BASE = 100;
const MARGIN_STEP_BASE = 100;
const MAX_MARGIN_BASE = 1000;
const CORRIDOR_RADIUS_BASE = 24;
const THETA_SWITCH_RADIUS = 10;
const SIMPLIFY_ANGLE_DEG = 10.0;
const SIMPLIFY_DIST_PX = 5.0;
const SIMPLIFY_MIN_WPS_DIST = 10;

function nowMs() { return performance.now(); }

function scaledPx(base, mapScale) {
    const scale = Number(mapScale);
    const factor = Number.isFinite(scale) && scale > 0 ? SCALE_REFERENCE / scale : 1;
    return Math.max(1, Math.round(base * factor));
}

function log(prefix, message) {
    // eslint-disable-next-line no-console
    console.log(`[${prefix}] ${message}`);
}

function pointsToLocal(flatGlobal, originX, originY) {
    const out = new Array(flatGlobal.length);
    for (let i = 0; i < flatGlobal.length; i += 2) {
        out[i] = flatGlobal[i] - originX;
        out[i + 1] = flatGlobal[i + 1] - originY;
    }
    return out;
}

function pointsToGlobal(flatLocal, originX, originY) {
    const out = new Array(flatLocal.length);
    for (let i = 0; i < flatLocal.length; i += 2) {
        out[i] = flatLocal[i] + originX;
        out[i + 1] = flatLocal[i + 1] + originY;
    }
    return out;
}

function samePoint(flat, offset, other, otherOffset) {
    return flat[offset] === other[otherOffset] && flat[offset + 1] === other[otherOffset + 1];
}

function refineDenseLeg(denseGlobal, surface, corridorRadius) {
    if (!denseGlobal || denseGlobal.length < 2) return null;
    if (denseGlobal.length === 2) return denseGlobal.slice();

    const dense = pointsToLocal(denseGlobal, surface.originX, surface.originY);
    const start = { x: dense[0], y: dense[1] };
    const goal = { x: dense[dense.length - 2], y: dense[dense.length - 1] };
    const waypoints = simplifyAStarSameTerrainPath(
        dense, surface.grid, surface.w, surface.h, SIMPLIFY_MIN_WPS_DIST,
    );
    const corridor = corridorMask(waypoints, surface.w, surface.h, corridorRadius);
    const constrained = applyCorridor(surface.grid, corridor);
    const theta = guidedThetaStar(
        constrained, surface.w, surface.h,
        start, goal, waypoints, THETA_SWITCH_RADIUS,
    );
    if (!theta) return null;
    const simplified = simplifyThetaPath(theta, SIMPLIFY_ANGLE_DEG, SIMPLIFY_DIST_PX);
    if (simplified.length < 2) return null;
    // Surface transitions are topology anchors and must remain exact.
    simplified[0] = start.x;
    simplified[1] = start.y;
    simplified[simplified.length - 2] = goal.x;
    simplified[simplified.length - 1] = goal.y;
    return pointsToGlobal(simplified, surface.originX, surface.originY);
}

function refineTypedPath(search, baseSurface, passages, corridorRadius) {
    const passageById = new Map(passages.map(passage => [String(passage.id), passage]));
    const refinedLegs = [];
    for (const leg of search.legs) {
        let surface;
        if (leg.surface === 'base') {
            surface = baseSurface;
        } else {
            const passage = passageById.get(String(leg.passageId));
            if (!passage) return null;
            surface = {
                grid: passage.grid,
                w: passage.localWidth,
                h: passage.localHeight,
                originX: passage.originX,
                originY: passage.originY,
            };
        }
        const points = refineDenseLeg(leg.points, surface, corridorRadius);
        if (!points) return null;
        refinedLegs.push({ ...leg, points });
    }

    const path = [];
    const passageSpans = [];
    for (const leg of refinedLegs) {
        let fromIndex = path.length ? path.length / 2 - 1 : 0;
        let appendFrom = 0;
        if (path.length && samePoint(path, path.length - 2, leg.points, 0)) appendFrom = 2;
        else if (path.length) {
            // A surface transition should be zero-length at the same projected cell.
            return null;
        }
        for (let i = appendFrom; i < leg.points.length; i++) path.push(leg.points[i]);
        if (leg.surface !== 'base') {
            passageSpans.push({
                passageId: leg.passageId,
                fromIndex,
                toIndex: path.length / 2 - 1,
            });
        }
    }
    return { path, passageSpans, legs: refinedLegs };
}

/**
 * Run the sparse layered branch on a full post-blockedTerrain base grid.
 * Returns null/error when the caller should fall back to legacy runPipeline().
 */
export function runLayeredPipeline(
    grid, w, h, startGrid, goalGrid, passages,
    logPrefix, mapScale = null, routes = [],
) {
    const timings = {};
    const tTotal = nowMs();
    const initialMargin = scaledPx(INITIAL_MARGIN_BASE, mapScale);
    const marginStep = scaledPx(MARGIN_STEP_BASE, mapScale);
    const maxMargin = scaledPx(MAX_MARGIN_BASE, mapScale);
    const corridorRadius = scaledPx(CORRIDOR_RADIUS_BASE, mapScale);

    const sx = startGrid.x | 0;
    const sy = startGrid.y | 0;
    const gx = goalGrid.x | 0;
    const gy = goalGrid.y | 0;
    if (sx < 0 || sx >= w || sy < 0 || sy >= h
        || gx < 0 || gx >= w || gy < 0 || gy >= h
        || grid[sy * w + sx] === 0 || grid[gy * w + gx] === 0) {
        return { path: null, timings, error: 'start or ziel on impassable pixel', fallback: true };
    }

    let search = null;
    let sub = null;
    let requestPassages = passages;
    let margin = initialMargin;
    let searchMs = 0;
    while (margin <= maxMargin) {
        const tSearch = nowMs();
        sub = extractSubgrid(grid, w, h, startGrid, goalGrid, margin);
        const masked = applySurfaceRouteMasks({
            grid: sub.subgrid,
            w: sub.sw,
            h: sub.sh,
            originX: sub.offsetX,
            originY: sub.offsetY,
        }, passages, routes);
        sub.subgrid = masked.base.grid;
        requestPassages = masked.passages;
        const startSnap = snapToFree(sub.subgrid, sub.sw, sub.sh, sub.startSub.x, sub.startSub.y);
        const goalSnap = snapToFree(sub.subgrid, sub.sw, sub.sh, sub.zielSub.x, sub.zielSub.y);
        if (startSnap && goalSnap) {
            sub.startSub = startSnap;
            sub.zielSub = goalSnap;
            search = layeredAstar({
                grid: sub.subgrid,
                w: sub.sw,
                h: sub.sh,
                originX: sub.offsetX,
                originY: sub.offsetY,
            }, startSnap, goalSnap, requestPassages);
        }
        const elapsed = nowMs() - tSearch;
        searchMs += elapsed;
        if (search) {
            log(logPrefix, `layered A* OK at margin=${margin}, nodes=${search.stats.allocatedNodes}, passages=${search.stats.selectedPassages} (${Math.round(elapsed)}ms)`);
            break;
        }
        margin += marginStep;
    }
    timings.layered_a_star = searchMs;
    if (!search || !sub) {
        timings.total = nowMs() - tTotal;
        return { path: null, timings, error: 'layered A* exhausted margin', fallback: true };
    }

    const tRefine = nowMs();
    const refined = refineTypedPath(search, {
        grid: sub.subgrid,
        w: sub.sw,
        h: sub.sh,
        originX: sub.offsetX,
        originY: sub.offsetY,
    }, requestPassages, corridorRadius);
    timings.layered_refine = nowMs() - tRefine;
    timings.total = nowMs() - tTotal;
    if (!refined) {
        return { path: null, timings, error: 'layered theta* no path', fallback: false };
    }
    log(logPrefix, `layered total: ${Math.round(timings.total)}ms, legs=${refined.legs.length}, pts=${refined.path.length / 2}`);
    return {
        path: refined.path,
        passageSpans: refined.passageSpans,
        typedLegs: refined.legs,
        timings,
        layeredStats: search.stats,
        margin,
    };
}
