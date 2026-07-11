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

function surfaceForPassage(passage) {
    return {
        grid: passage.grid,
        w: passage.localWidth,
        h: passage.localHeight,
        originX: passage.originX,
        originY: passage.originY,
        refineFullRaster: true,
    };
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
    // Passage rasters are already tightly cropped to their complete legal
    // footprint. Applying the legacy fixed-radius tube here can exclude most
    // of a wide passage and permanently preserve a wall-biased dense route.
    // Base legs retain the established corridor for performance and to avoid
    // changing the no-passage pathing behaviour.
    const constrained = surface.refineFullRaster
        ? surface.grid
        : applyCorridor(
            surface.grid,
            corridorMask(waypoints, surface.w, surface.h, corridorRadius),
        );
    // On a passage, guide directly to the goal. The legacy waypoint guidance
    // owns one mutable progress index for the entire search, so using it here
    // would make wide-raster refinement depend on node expansion order.
    const thetaWaypoints = surface.refineFullRaster
        ? [goal.x, goal.y]
        : waypoints;
    const theta = guidedThetaStar(
        constrained, surface.w, surface.h,
        start, goal, thetaWaypoints, THETA_SWITCH_RADIUS,
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
            surface = surfaceForPassage(passage);
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

function legCost(points, surface) {
    let cost = 0;
    for (let i = 2; i < points.length; i += 2) {
        const ax = points[i - 2] - surface.originX;
        const ay = points[i - 1] - surface.originY;
        const bx = points[i] - surface.originX;
        const by = points[i + 1] - surface.originY;
        const distance = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(distance));
        const stepDistance = distance / steps;
        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            const x = Math.round(ax + (bx - ax) * t);
            const y = Math.round(ay + (by - ay) * t);
            if (x < 0 || x >= surface.w || y < 0 || y >= surface.h) return Infinity;
            const grey = surface.grid[y * surface.w + x];
            if (grey === 0) return Infinity;
            cost += stepDistance * (255 - grey);
        }
    }
    return cost;
}

function withEndpoint(points, atStart, point) {
    const out = points.slice();
    const offset = atStart ? 0 : out.length - 2;
    out[offset] = point[0];
    out[offset + 1] = point[1];
    return out;
}

function livePortalCells(passage, entrance, baseSurface) {
    const cells = [];
    for (const localIndex of entrance) {
        if (!passage.grid[localIndex]) continue;
        const localX = localIndex % passage.localWidth;
        const localY = (localIndex - localX) / passage.localWidth;
        const x = localX + passage.originX;
        const y = localY + passage.originY;
        const bx = x - baseSurface.originX;
        const by = y - baseSurface.originY;
        if (!Number.isInteger(bx) || !Number.isInteger(by)
            || bx < 0 || bx >= baseSurface.w || by < 0 || by >= baseSurface.h
            || !baseSurface.grid[by * baseSurface.w + bx]) continue;
        cells.push([x, y]);
    }
    return cells;
}

// Coordinate-descent over the two live portal bands. A full Cartesian search
// can exceed a million pairs at the maximum passage width; alternating the two
// bands is bounded, deterministic, and captures the anchor-sliding defect
// without changing the layered topology or permitting a mid-corridor exit.
function optimizePortalAnchors(search, baseSurface, passages) {
    const passageById = new Map(passages.map(passage => [String(passage.id), passage]));
    const legs = search.legs.map(leg => ({ ...leg, points: leg.points.slice() }));
    for (let index = 1; index + 1 < legs.length; index++) {
        const passageLeg = legs[index];
        if (passageLeg.surface === 'base'
            || legs[index - 1].surface !== 'base'
            || legs[index + 1].surface !== 'base') continue;
        const passage = passageById.get(String(passageLeg.passageId));
        if (!passage) continue;
        const forward = passageLeg.direction === 'from-start';
        const startCells = livePortalCells(
            passage, forward ? passage.startEntrance : passage.endEntrance, baseSurface,
        );
        const endCells = livePortalCells(
            passage, forward ? passage.endEntrance : passage.startEntrance, baseSurface,
        );
        if (!startCells.length || !endCells.length) continue;

        const previous = legs[index - 1];
        const next = legs[index + 1];
        const passageSurface = surfaceForPassage(passage);
        let start = [passageLeg.points[0], passageLeg.points[1]];
        let end = [passageLeg.points.at(-2), passageLeg.points.at(-1)];
        const score = (candidateStart, candidateEnd) => {
            const previousCost = legCost(
                withEndpoint(previous.points, false, candidateStart), baseSurface,
            );
            if (!Number.isFinite(previousCost)) return Infinity;
            const passageCost = legCost(
                [...candidateStart, ...candidateEnd], passageSurface,
            );
            if (!Number.isFinite(passageCost)) return Infinity;
            const nextCost = legCost(
                withEndpoint(next.points, true, candidateEnd), baseSurface,
            );
            return previousCost + passageCost + nextCost;
        };

        let best = score(start, end);
        for (let iteration = 0; iteration < 3; iteration++) {
            let changed = false;
            for (const candidate of startCells) {
                const candidateScore = score(candidate, end);
                if (candidateScore + 1e-6 < best) {
                    start = candidate;
                    best = candidateScore;
                    changed = true;
                }
            }
            for (const candidate of endCells) {
                const candidateScore = score(start, candidate);
                if (candidateScore + 1e-6 < best) {
                    end = candidate;
                    best = candidateScore;
                    changed = true;
                }
            }
            if (!changed) break;
        }
        previous.points = withEndpoint(previous.points, false, start);
        passageLeg.points = withEndpoint(
            withEndpoint(passageLeg.points, true, start), false, end,
        );
        next.points = withEndpoint(next.points, true, end);
    }
    return { ...search, legs };
}

function refinementDiagnostics(search, refined, baseSurface, passages) {
    const passageById = new Map(passages.map(passage => [String(passage.id), passage]));
    let refinedCost = 0;
    const portalCells = [];
    const legCosts = [];
    for (const leg of refined.legs) {
        let surface = baseSurface;
        if (leg.surface !== 'base') {
            const passage = passageById.get(String(leg.passageId));
            if (!passage) return null;
            surface = {
                grid: passage.grid,
                w: passage.localWidth,
                h: passage.localHeight,
                originX: passage.originX,
                originY: passage.originY,
            };
            portalCells.push({
                passageId: leg.passageId,
                direction: leg.direction,
                start: [leg.points[0], leg.points[1]],
                end: [leg.points[leg.points.length - 2], leg.points[leg.points.length - 1]],
            });
        }
        const cost = legCost(leg.points, surface);
        refinedCost += cost;
        legCosts.push({ surface: leg.surface, cost });
    }
    return { denseCost: search.cost, refinedCost, legCosts, portalCells };
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
    const baseSurface = {
        grid: sub.subgrid,
        w: sub.sw,
        h: sub.sh,
        originX: sub.offsetX,
        originY: sub.offsetY,
    };
    const legalizedSearch = optimizePortalAnchors(search, baseSurface, requestPassages);
    const refined = refineTypedPath(
        legalizedSearch, baseSurface, requestPassages, corridorRadius,
    );
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
        refinementDiagnostics: refinementDiagnostics(
            search, refined, baseSurface, requestPassages,
        ),
        margin,
    };
}
