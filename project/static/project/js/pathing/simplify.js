// Polyline simplification helpers. The active pipeline uses the dense A*
// same-terrain reducer plus the legacy theta path trimmer; the old turn-based
// A* helpers remain here only for comparison/debugging.

import { hasLineOfSight, sameTerrainOnLine } from './bresenham.js';

// Detect direction-change waypoints via cross product. Path is a flat array
// [x0,y0, x1,y1, ...]. Returns indices into the flat representation
// (i.e. a new flat polyline of turn points).
export function getAStarTurns(flatPath) {
    const n = flatPath.length / 2;
    if (n < 3) return flatPath.slice();
    const out = [flatPath[0], flatPath[1]];
    let prevVx = flatPath[2] - flatPath[0];
    let prevVy = flatPath[3] - flatPath[1];
    let lastTurnDir = 0;
    let lastIndex = 0;
    for (let i = 1; i < n - 1; i++) {
        const cx = flatPath[2 * i],     cy = flatPath[2 * i + 1];
        const nx = flatPath[2 * i + 2], ny = flatPath[2 * i + 3];
        const currVx = nx - cx;
        const currVy = ny - cy;
        const cross = prevVx * currVy - prevVy * currVx;
        const currTurnDir = Math.sign(cross);
        if (currTurnDir === 0) {
            // collinear: keep walking
        } else {
            if (lastTurnDir === currTurnDir) {
                out.push(flatPath[2 * lastIndex], flatPath[2 * lastIndex + 1]);
                lastTurnDir = 0;
            } else {
                lastTurnDir = currTurnDir;
            }
            lastIndex = i;
            prevVx = currVx;
            prevVy = currVy;
        }
    }
    out.push(flatPath[2 * (n - 1)], flatPath[2 * (n - 1) + 1]);
    return out;
}

// LOS-based waypoint reduction. Walks j backward from the end; first j with
// LOS(i, j) and distance >= min_distance wins. Mirrors the legacy Python
// Retired server simplify_wps semantics.
//
// CAVEAT: the legacy fallback (no LOS-valid distant j → step to i+1 without
// re-checking LOS) can stitch a non-LOS pair into the output polyline when
// successive turn waypoints don't see each other. Prefer simplifyAStarPath
// below for cut-off-free output.
export function simplifyWps(flatWps, grid, w, h, minDistance = 10) {
    const out = [];
    const n = flatWps.length / 2;
    const minDistanceSq = minDistance * minDistance;
    let i = 0;
    while (i < n) {
        const ix = flatWps[2 * i], iy = flatWps[2 * i + 1];
        out.push(ix, iy);
        let nextI = i + 1;
        for (let j = n - 1; j > i; j--) {
            const jx = flatWps[2 * j], jy = flatWps[2 * j + 1];
            const dx = jx - ix, dy = jy - iy;
            if (dx * dx + dy * dy < minDistanceSq) continue;
            if (hasLineOfSight(grid, w, h, ix, iy, jx, jy)) {
                nextI = j;
                break;
            }
        }
        i = nextI;
    }
    return out;
}

// Cut-off-free simplifier. Walks the *full A\* path* (1-pixel steps) and
// jumps from current position to the furthest forward-reachable index whose
// LOS is intact. Because consecutive A* points are 1 pixel apart, the
// fallback (next pixel) is always LOS-trivially valid, so every segment in
// the output is guaranteed walkable. The current pipeline still calls
// simplifyWps for production parity; keep this around as the safer candidate
// if the debug PNGs confirm corner clipping in the waypoint pass.
export function simplifyAStarPath(astarPath, grid, w, h, minDistance = 10) {
    const out = [];
    const n = astarPath.length / 2;
    if (n === 0) return out;
    out.push(astarPath[0], astarPath[1]);
    let i = 0;
    while (i < n - 1) {
        const ix = astarPath[2 * i], iy = astarPath[2 * i + 1];
        // Find the furthest j with LOS *and* dist >= minDistance.
        let bestJ = -1;
        for (let j = n - 1; j > i; j--) {
            const jx = astarPath[2 * j], jy = astarPath[2 * j + 1];
            const dx = jx - ix, dy = jy - iy;
            const dist = Math.hypot(dx, dy);
            if (dist < minDistance) break; // j only decreases — once below, all further j too short
            if (hasLineOfSight(grid, w, h, ix, iy, jx, jy)) {
                bestJ = j;
                break;
            }
        }
        // If no long shortcut works, find the furthest j with LOS regardless
        // of distance (the immediate i+1 is always LOS-valid since A* steps
        // are 1 pixel, so this always succeeds).
        if (bestJ < 0) {
            for (let j = n - 1; j > i; j--) {
                const jx = astarPath[2 * j], jy = astarPath[2 * j + 1];
                if (hasLineOfSight(grid, w, h, ix, iy, jx, jy)) {
                    bestJ = j;
                    break;
                }
            }
        }
        if (bestJ < 0) bestJ = i + 1; // safety
        out.push(astarPath[2 * bestJ], astarPath[2 * bestJ + 1]);
        i = bestJ;
    }
    return out;
}

// Same-terrain reduction over the full dense A* pixel walk. From each output
// point, scan backwards from the goal and jump to the furthest future A* point
// that can be connected without crossing an impassable pixel or any different
// grey value. This removes geometric zig-zag while preserving the exact speed
// classes represented by the A* path.
export function simplifyAStarSameTerrainPath(astarPath, grid, w, h, minDistance = 10) {
    const out = [];
    const n = astarPath.length / 2;
    const minDistanceSq = minDistance * minDistance;
    if (n === 0) return out;
    out.push(astarPath[0], astarPath[1]);
    let i = 0;
    while (i < n - 1) {
        const ix = astarPath[2 * i], iy = astarPath[2 * i + 1];
        let bestJ = -1;
        for (let j = n - 1; j > i; j--) {
            const jx = astarPath[2 * j], jy = astarPath[2 * j + 1];
            const dx = jx - ix, dy = jy - iy;
            const dist = dx * dx + dy * dy;
            if (dist < minDistanceSq) break;
            if (sameTerrainOnLine(grid, w, h, ix, iy, jx, jy)) {
                bestJ = j;
                break;
            }
        }
        if (bestJ < 0) {
            for (let j = n - 1; j > i; j--) {
                const jx = astarPath[2 * j], jy = astarPath[2 * j + 1];
                if (sameTerrainOnLine(grid, w, h, ix, iy, jx, jy)) {
                    bestJ = j;
                    break;
                }
            }
        }
        if (bestJ < 0) bestJ = i + 1;
        out.push(astarPath[2 * bestJ], astarPath[2 * bestJ + 1]);
        i = bestJ;
    }
    return out;
}

// Iterative polyline smoothing for the "route 3" experimental output:
//   1) drop any vertex whose neighbours can see each other directly,
//   2) for each remaining vertex, search ± orthogonal offsets for a
//      position that shortens the total polyline while keeping both
//      adjacent segments LOS-valid.
// The repeat-until-stable loop converges on the convex envelope of the
// reachable polyline within the local free-space, so isolated "switch sides
// of the road then switch back" detours collapse.
export function smoothPolyline(flatPath, grid, w, h, opts = {}) {
    const slideRange = opts.slideRange ?? 12; // pixels searched orthogonally
    const slidePasses = opts.slidePasses ?? 3;
    let pts = [];
    for (let i = 0; i < flatPath.length; i += 2) pts.push([flatPath[i], flatPath[i + 1]]);

    function reduceVertices() {
        let changed = true;
        while (changed && pts.length > 2) {
            changed = false;
            for (let i = 1; i < pts.length - 1; i++) {
                const [px, py] = pts[i - 1];
                const [qx, qy] = pts[i + 1];
                if (hasLineOfSight(grid, w, h, px, py, qx, qy)) {
                    pts.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }
    }

    reduceVertices();

    for (let pass = 0; pass < slidePasses; pass++) {
        for (let i = 1; i < pts.length - 1; i++) {
            const [px, py] = pts[i - 1];
            const [cx, cy] = pts[i];
            const [nx, ny] = pts[i + 1];
            const dx = nx - px;
            const dy = ny - py;
            const mag = Math.hypot(dx, dy);
            if (mag === 0) continue;
            const ox = -dy / mag;
            const oy =  dx / mag;
            let bestX = cx, bestY = cy;
            let bestLen = Math.hypot(cx - px, cy - py) + Math.hypot(nx - cx, ny - cy);
            for (let delta = -slideRange; delta <= slideRange; delta++) {
                if (delta === 0) continue;
                const tx = Math.round(cx + ox * delta);
                const ty = Math.round(cy + oy * delta);
                if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
                if (grid[ty * w + tx] === 0) continue;
                if (!hasLineOfSight(grid, w, h, px, py, tx, ty)) continue;
                if (!hasLineOfSight(grid, w, h, tx, ty, nx, ny)) continue;
                const newLen = Math.hypot(tx - px, ty - py) + Math.hypot(nx - tx, ny - ty);
                if (newLen < bestLen - 0.5) {
                    bestLen = newLen;
                    bestX = tx;
                    bestY = ty;
                }
            }
            if (bestX !== cx || bestY !== cy) pts[i] = [bestX, bestY];
        }
        reduceVertices();
    }

    // Strict-LOS guard rail. The smoothing reduces zig-zag, but the initial
    // θ* polyline can include sub-pixel corner clips that θ*'s in-loop LOS
    // missed. For any segment that still fails strict (supercover) LOS we
    // insert a free midpoint that's LOS-visible from both endpoints.
    pts = bisectInvalidSegments(pts, grid, w, h);

    const out = [];
    for (const [x, y] of pts) out.push(x, y);
    return out;
}

function bisectInvalidSegments(pts, grid, w, h, maxDepth = 4) {
    for (let depth = 0; depth < maxDepth; depth++) {
        let changed = false;
        const out = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
            const [ax, ay] = out[out.length - 1];
            const [bx, by] = pts[i];
            if (hasLineOfSight(grid, w, h, ax, ay, bx, by)) {
                out.push([bx, by]);
                continue;
            }
            // Search a small neighbourhood around the geometric midpoint for
            // a free pixel that has strict LOS to both endpoints. If found,
            // splice it in. Otherwise leave the segment alone (rare).
            const mx = Math.round((ax + bx) / 2);
            const my = Math.round((ay + by) / 2);
            let inserted = null;
            outer: for (let r = 1; r <= 12; r++) {
                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                        const tx = mx + dx, ty = my + dy;
                        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
                        if (grid[ty * w + tx] === 0) continue;
                        if (hasLineOfSight(grid, w, h, ax, ay, tx, ty) &&
                            hasLineOfSight(grid, w, h, tx, ty, bx, by)) {
                            inserted = [tx, ty];
                            break outer;
                        }
                    }
                }
            }
            if (inserted) {
                out.push(inserted);
                changed = true;
            }
            out.push([bx, by]);
        }
        pts = out;
        if (!changed) break;
    }
    return pts;
}

function signedAngleDeg(v1x, v1y, v2x, v2y) {
    const a1 = Math.atan2(v1y, v1x);
    const a2 = Math.atan2(v2y, v2x);
    let ang = (a2 - a1) * 180 / Math.PI;
    if (ang > 180) ang -= 360;
    else if (ang < -180) ang += 360;
    return ang;
}

// Angle/distance polyline trimmer. Direct port of
// Retired server simplify_theta_path.
export function simplifyThetaPath(flatPath, angleThresholdDeg = 10.0, distanceThreshold = 5.0) {
    const n = flatPath.length / 2;
    if (n < 3) return flatPath.slice();
    const out = [flatPath[0], flatPath[1]];
    let prevAngleSign = null;
    for (let i = 1; i < n - 1; i++) {
        const px = flatPath[2 * (i - 1)], py = flatPath[2 * (i - 1) + 1];
        const cx = flatPath[2 * i],       cy = flatPath[2 * i + 1];
        const nx = flatPath[2 * (i + 1)], ny = flatPath[2 * (i + 1) + 1];
        const v1x = cx - px, v1y = cy - py;
        const v2x = nx - cx, v2y = ny - cy;
        const mag1 = Math.hypot(v1x, v1y);
        const mag2 = Math.hypot(v2x, v2y);
        if (mag1 === 0 || mag2 === 0) continue;
        const angle = signedAngleDeg(v1x, v1y, v2x, v2y);
        const angleAbs = Math.abs(angle);
        const angleSign = angleAbs >= angleThresholdDeg ? Math.sign(angle) : prevAngleSign;

        if (mag1 > distanceThreshold || mag2 > distanceThreshold) {
            out.push(cx, cy);
        } else if (angleAbs < angleThresholdDeg) {
            // skip
        } else if (angleSign === prevAngleSign) {
            out.push(cx, cy);
        } else if (mag1 > distanceThreshold || mag2 > distanceThreshold) {
            out.push(cx, cy);
        }
        prevAngleSign = angleSign;
    }
    out.push(flatPath[2 * (n - 1)], flatPath[2 * (n - 1) + 1]);
    return out;
}
