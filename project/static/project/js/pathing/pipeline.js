// Orchestrator — mirrors pathing/theta.py:find_path step-for-step with
// identical defaults so the JS path matches the server θ* polyline.

import {
    applyBlockedTerrain, extractSubgrid, snapToFree,
    corridorMask, applyCorridor, drawRouteMask,
} from './preprocess.js';
import { astar } from './astar.js';
import { simplifyAStarSameTerrainPath, simplifyThetaPath } from './simplify.js';
import { guidedThetaStar } from './theta_star.js';

// Direct port of the retired server route finder.
// Constants match the old preprocessing and theta* defaults so
// the polylines mirror production.
const SCALE_REFERENCE = 0.5;
const INITIAL_MARGIN_BASE = 100;
const MARGIN_STEP_BASE = 100;
const MAX_MARGIN_BASE = 1000;
const CORRIDOR_RADIUS_BASE = 24;
const THETA_SWITCH_RADIUS = 10;
const SIMPLIFY_ANGLE_DEG = 10.0;
const SIMPLIFY_DIST_PX = 5.0;
const SIMPLIFY_MIN_WPS_DIST = 10;

const TRAIN_SCALE = 0.710;

function nowMs() { return performance.now(); }

function scaledPx(base, mapScale) {
    const scale = Number(mapScale);
    const factor = Number.isFinite(scale) && scale > 0 ? SCALE_REFERENCE / scale : 1;
    return Math.max(1, Math.round(base * factor));
}

// log lines (browser console). Format mirrors `[theta]` lines in
// pathing/theta.py exactly so console reads identically on both sides.
function log(prefix, msg) {
    // eslint-disable-next-line no-console
    console.log(`[${prefix}] ${msg}`);
}

/**
 * Run the legacy A* + corridor + θ* pipeline on a pre-loaded grid + labels.
 *
 * @param {Uint8Array} grid       (post-blockedTerrain) mask
 * @param {Uint16Array|Int32Array} labels  connected-components on grid
 * @param {number} w
 * @param {number} h
 * @param {{x:number,y:number}} startGrid  in mask-grid coords
 * @param {{x:number,y:number}} zielGrid   in mask-grid coords
 * @param {boolean} wasCached              whether (grid, labels) came from cache
 * @param {string} logPrefix               console prefix, e.g. "theta-client"
 * @returns {{path:Array<number>|null, timings:Object, error?:string}}
 */
export function runPipeline(grid, labels, w, h, startGrid, zielGrid, wasCached, logPrefix, mapScale = null, routesGrid = []) {
    const timings = {};
    const tTotal = nowMs();
    const initialMargin = scaledPx(INITIAL_MARGIN_BASE, mapScale);
    const marginStep = scaledPx(MARGIN_STEP_BASE, mapScale);
    const maxMargin = scaledPx(MAX_MARGIN_BASE, mapScale);
    const corridorRadius = scaledPx(CORRIDOR_RADIUS_BASE, mapScale);

    // The "grid+labels resolve" cost is paid by the caller; record it as 0
    // here on warm hits, or whatever it actually took on cold.
    timings.load_mask = 0;
    log(logPrefix, `load_mask+labels: shape=(${h}, ${w}) (${wasCached ? 'cached' : 'cold'}, 0ms)`);

    // 2. Connectivity precheck
    let t = nowMs();
    const sx = startGrid.x | 0, sy = startGrid.y | 0;
    const zx = zielGrid.x | 0, zy = zielGrid.y | 0;
    if (sx < 0 || sx >= w || sy < 0 || sy >= h || zx < 0 || zx >= w || zy < 0 || zy >= h) {
        log(logPrefix, 'start/ziel outside mask');
        timings.connectivity = nowMs() - t;
        return { path: null, timings, error: 'start/ziel outside mask' };
    }
    const lblStart = labels[sy * w + sx];
    const lblZiel = labels[zy * w + zx];
    timings.connectivity = nowMs() - t;
    if (lblStart === 0 || lblZiel === 0) {
        log(logPrefix, `start or ziel on impassable pixel (${Math.round(timings.connectivity)}ms)`);
        return { path: null, timings, error: 'start or ziel on impassable pixel' };
    }
    if (lblStart !== lblZiel) {
        log(logPrefix, `start and ziel are in different free-space components (${Math.round(timings.connectivity)}ms) — no route exists`);
        return { path: null, timings, error: 'disconnected' };
    }
    log(logPrefix, `connectivity OK (${Math.round(timings.connectivity)}ms)`);

    function routesForSubgrid(routesGrid, offsetX, offsetY) {
        const out = [];
        for (const route of routesGrid || []) {
            const pts = (route || []).map(p => ({
                x: p.x - offsetX,
                y: p.y - offsetY,
            })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
            if (pts.length >= 2) out.push(pts);
        }
        return out;
    }

    // 3. Margin-growth subgrid + A*
    let aStarPath = null;
    let sub = null;
    let margin = initialMargin;
    let aStarTotal = 0;
    let routeMaskTotal = 0;
    const aStarScratch = {};
    while (margin <= maxMargin) {
        const tA = nowMs();
        sub = extractSubgrid(grid, w, h, startGrid, zielGrid, margin);
        if (routesGrid.length) {
            const tR = nowMs();
            const routesSub = routesForSubgrid(routesGrid, sub.offsetX, sub.offsetY);
            if (routesSub.length) {
                sub.subgrid = drawRouteMask(sub.subgrid, sub.sw, sub.sh, routesSub, sub.startSub, sub.zielSub);
            }
            routeMaskTotal += nowMs() - tR;
        }
        const startSnap = snapToFree(sub.subgrid, sub.sw, sub.sh, sub.startSub.x, sub.startSub.y);
        const zielSnap  = snapToFree(sub.subgrid, sub.sw, sub.sh, sub.zielSub.x,  sub.zielSub.y);
        if (!startSnap || !zielSnap) {
            log(logPrefix, `snap failed at margin=${margin}`);
            aStarTotal += nowMs() - tA;
            margin += marginStep;
            continue;
        }
        sub.startSub = startSnap;
        sub.zielSub = zielSnap;
        aStarPath = astar(sub.subgrid, sub.sw, sub.sh, startSnap, zielSnap, aStarScratch);
        const dt = nowMs() - tA;
        aStarTotal += dt;
        if (aStarPath !== null) {
            log(logPrefix, `A* OK at margin=${margin}, subgrid=(${sub.sh}, ${sub.sw}), pts=${aStarPath.length / 2} (${Math.round(dt)}ms)`);
            break;
        }
        log(logPrefix, `A* no path at margin=${margin} (${Math.round(dt)}ms)`);
        margin += marginStep;
    }
    timings.a_star = aStarTotal;
    timings.route_mask = routeMaskTotal;
    if (routeMaskTotal > 0) {
        log(logPrefix, `route mask on subgrid: ${Math.round(routeMaskTotal)}ms`);
    }
    if (aStarPath === null) {
        log(logPrefix, 'A* failed at every margin — giving up');
        timings.total = nowMs() - tTotal;
        return { path: null, timings, error: 'A* exhausted margin' };
    }

    // 4. Dense A* same-terrain reduction. This skips the old direction-change
    // recognition pass: every shortcut must stay on the same exact mask value,
    // so the A* cost/speed map is preserved.
    t = nowMs();
    const wps = simplifyAStarSameTerrainPath(aStarPath, sub.subgrid, sub.sw, sub.sh, SIMPLIFY_MIN_WPS_DIST);
    timings.simplify_astar_same_terrain = nowMs() - t;
    log(logPrefix, `same-terrain A* waypoints: ${wps.length / 2} (${Math.round(timings.simplify_astar_same_terrain)}ms)`);

    // Lift the simplified A* polyline to full-mask coords so the worker can
    // hand it back alongside the final θ* path.
    // 5. Corridor mask. Build this around the conservative same-terrain A*
    // polyline so theta* gets a narrower guide without crossing speed classes
    // or impassable corners.
    t = nowMs();
    const corridor = corridorMask(wps, sub.sw, sub.sh, corridorRadius);
    const constrained = applyCorridor(sub.subgrid, corridor);
    timings.corridor = nowMs() - t;
    log(logPrefix, `corridor radius=${corridorRadius}, margin=${initialMargin}/${marginStep}/${maxMargin} (${Math.round(timings.corridor)}ms)`);

    // 6. LOS cache is per-request inside guidedThetaStar — no separate phase
    // timer because there's nothing to do up front.
    timings.los_cache = 0;

    // 7. Guided θ*
    t = nowMs();
    const thetaPath = guidedThetaStar(
        constrained, sub.sw, sub.sh,
        sub.startSub, sub.zielSub,
        wps, THETA_SWITCH_RADIUS,
    );
    timings.theta_star = nowMs() - t;
    if (!thetaPath) {
        log(logPrefix, `theta* failed inside corridor (${Math.round(timings.theta_star)}ms)`);
        timings.total = nowMs() - tTotal;
        return {
            path: null,
            debugBaseGrid: sub.subgrid,
            debugPaths: {
                astar_raw: aStarPath,
            },
            debugWidth: sub.sw,
            debugHeight: sub.sh,
            debugOffsetX: sub.offsetX,
            debugOffsetY: sub.offsetY,
            timings,
            error: 'theta* no path',
        };
    }
    log(logPrefix, `theta* path: ${thetaPath.length / 2} pts (${Math.round(timings.theta_star)}ms)`);

    // 8. Simplify polyline — direct port of simplify_theta_path.
    t = nowMs();
    const simplified = simplifyThetaPath(thetaPath, SIMPLIFY_ANGLE_DEG, SIMPLIFY_DIST_PX);
    timings.simplify_theta = nowMs() - t;

    // 9. Lift theta* polyline to full-mask coords
    const out = new Array(simplified.length);
    for (let i = 0; i < simplified.length; i += 2) {
        out[i]     = simplified[i]     + sub.offsetX;
        out[i + 1] = simplified[i + 1] + sub.offsetY;
    }
    timings.total = nowMs() - tTotal;
    log(logPrefix, `total: ${Math.round(timings.total)}ms, polyline pts: ${out.length / 2}`);
    return {
        path: out,
        // Debug payload — the corridor-constrained inflated subgrid theta*
        // actually saw, plus its origin in mask-pixel coords. The worker
        // turns this into a downloadable PNG so coordinates can be verified
        // against the production server's route output.
        debugBaseGrid: sub.subgrid,
        debugPaths: {
            astar_raw: aStarPath,
        },
        debugWidth: sub.sw,
        debugHeight: sub.sh,
        debugOffsetX: sub.offsetX,
        debugOffsetY: sub.offsetY,
        timings,
    };
}

/**
 * Convert a flat client-side polyline in mask-grid pixels to the editor's
 * polyline shape ([[x,y], ...] in map-pixel coords, with endpoints pinned to
 * the user-clicked start/ziel).
 */
export function liftToEditorPolyline(flatGrid, startMap, zielMap) {
    const out = [[startMap.x, startMap.y]];
    const n = flatGrid.length / 2;
    for (let i = 1; i < n - 1; i++) {
        out.push([flatGrid[2 * i] * TRAIN_SCALE, flatGrid[2 * i + 1] * TRAIN_SCALE]);
    }
    out.push([zielMap.x, zielMap.y]);
    return out;
}

export const TRAIN_SCALE_VALUE = TRAIN_SCALE;
export { applyBlockedTerrain };
