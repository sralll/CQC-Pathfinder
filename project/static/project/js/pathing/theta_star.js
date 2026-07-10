// Guided theta* on a Uint8Array grid — direct port of
// Retired server guided_theta_star_sync.
//
// Per-neighbour decision (lifted verbatim from the Python):
//   cost = 255 - grid[neighbor]
//   if LOS(parent(current), neighbor):
//       if all pixels along LOS share the parent's grey value:
//           cand_g = g[parent] + dist(parent, neighbor) * cost
//           cand_parent = parent
//       else:
//           cand_g = g[current] + dist(current, neighbor) * cost
//           cand_parent = current
//   else:
//       cand_g = g[current] + dist(current, neighbor) + cost
//       cand_parent = current
//   f = cand_g + heuristic(neighbor, guidance_target)
//
// guidance_target advances to waypoints[++i] once the current node is within
// `switch_radius` of waypoints[i]. Defaults: switch_radius=10, same as
// pathing/theta.py:THETA_SWITCH_RADIUS.

import { MinHeap } from './heap.js';

const SQRT2 = Math.SQRT2;

// Monotonic clock for the optional deadline (Node >=16 + browser workers both
// expose `performance`). Kept module-local so theta_star.js stays DOM-free.
const nowMs = (typeof performance !== 'undefined' && performance.now)
	? () => performance.now()
	: () => Date.now();
const DXS = new Int8Array([-1, -1, -1, 0, 0, 1, 1, 1]);
const DYS = new Int8Array([-1, 0, 1, -1, 1, -1, 0, 1]);

// Plain Bresenham LOS + same-terrain check. Direct port of the inline
// has_line_of_sight + same_terrain test in
// Retired server guided_theta_star_sync behaviour.
function losAndSameTerrain(grid, w, h, x0, y0, x1, y1) {
    const ref = grid[y0 * w + x0];
    let x = x0, y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let sameTerrain = true;
    let first = true;
    while (true) {
        const g = grid[y * w + x];
        if (g === 0) return { los: false, sameTerrain: false };
        if (!first && g !== ref) sameTerrain = false;
        first = false;
        if (x === x1 && y === y1) return { los: true, sameTerrain };
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
    }
}

// `deadlineMs` (absolute `nowMs()` timestamp, optional) aborts the search
// (returns null) once exceeded — checked every ~1024 pops. The editor path
// (pipeline.js) passes none and is unaffected.
export function guidedThetaStar(grid, w, h, start, goal, waypoints, switchRadius = 10, deadlineMs = null) {
    const sx = start.x | 0, sy = start.y | 0;
    const gx = goal.x | 0, gy = goal.y | 0;
    const n = w * h;
    const gScore = new Float32Array(n);
    for (let i = 0; i < n; i++) gScore[i] = Infinity;
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);

    // LOS cache. The cache is keyed by the packed (parent, neighbour) pair.
    // For a sub-grid up to ~1500x1500 we comfortably fit in 53-bit safe ints.
    const losCache = new Map();
    const SWH = w * h;
    function losAndTerrain(p1, p2) {
        const key = p1 * SWH + p2;
        const hit = losCache.get(key);
        if (hit !== undefined) return hit;
        const p1x = p1 % w, p1y = (p1 - p1x) / w;
        const p2x = p2 % w, p2y = (p2 - p2x) / w;
        const r = losAndSameTerrain(grid, w, h, p1x, p1y, p2x, p2y);
        losCache.set(key, r);
        return r;
    }

    const startIdx = sy * w + sx;
    const goalIdx = gy * w + gx;
    gScore[startIdx] = 0;
    parent[startIdx] = startIdx;

    const open = new MinHeap();
    open.push(Math.hypot(gx - sx, gy - sy), startIdx);

    let guidanceIdx = 0;
    const totalWps = waypoints.length / 2;

    let popCount = 0;
    while (open.size > 0) {
        if (deadlineMs !== null && (popCount++ & 1023) === 0 && nowMs() > deadlineMs) return null;
        const cur = open.pop();
        if (closed[cur]) continue;
        closed[cur] = 1;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cur === goalIdx) {
            // Reconstruct: walk parent[] back to start.
            const rev = [];
            let p = cur;
            while (true) {
                rev.push(p % w, (p - (p % w)) / w);
                if (p === startIdx) break;
                p = parent[p];
            }
            const out = new Array(rev.length);
            for (let i = 0, j = rev.length - 2; i < rev.length; i += 2, j -= 2) {
                out[i] = rev[j];
                out[i + 1] = rev[j + 1];
            }
            return out;
        }

        // Advance guidance waypoint if close enough.
        while (guidanceIdx + 1 < totalWps) {
            const wx = waypoints[2 * guidanceIdx];
            const wy = waypoints[2 * guidanceIdx + 1];
            if (Math.hypot(cx - wx, cy - wy) < switchRadius) guidanceIdx++;
            else break;
        }
        let tx, ty;
        if (guidanceIdx < totalWps) {
            tx = waypoints[2 * guidanceIdx];
            ty = waypoints[2 * guidanceIdx + 1];
        } else {
            tx = gx; ty = gy;
        }

        const gCur = gScore[cur];
        const par = parent[cur];
        for (let k = 0; k < 8; k++) {
            const nx = cx + DXS[k];
            const ny = cy + DYS[k];
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nIdx = ny * w + nx;
            const nGrey = grid[nIdx];
            if (nGrey === 0) continue;
            if (closed[nIdx]) continue;

            const cost = 255 - nGrey;
            let candG, candParent;
            // par may equal start (parent[start] = start). LOS from start
            // works fine; LOS from cur to neighbour also fine.
            const r = losAndTerrain(par, nIdx);
            if (r.los) {
                if (r.sameTerrain) {
                    const px = par % w, py = (par - px) / w;
                    const d = Math.hypot(nx - px, ny - py);
                    candG = gScore[par] + d * cost;
                    candParent = par;
                } else {
                    const d = Math.hypot(nx - cx, ny - cy);
                    candG = gCur + d * cost;
                    candParent = cur;
                }
            } else {
                const d = Math.hypot(nx - cx, ny - cy);
                candG = gCur + d + cost;   // note: + cost, not * cost (matches Python)
                candParent = cur;
            }

            if (candG < gScore[nIdx]) {
                gScore[nIdx] = candG;
                parent[nIdx] = candParent;
                const f = candG + Math.hypot(tx - nx, ty - ny);
                open.push(f, nIdx);
            }
        }
    }
    return null;
}
