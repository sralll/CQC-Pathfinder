// Weighted 8-connected A* on a Uint8Array grid.
// Cost formula matches the retired server A* implementation:
//   move_cost = hypot(dx, dy) * (255 - grid[neighbor])
// (only the neighbour's cost factor; no averaging). Impassable cells (grid==0)
// are skipped, matching the Python condition `if grid[ny, nx] == 0: continue`.
// Heuristic = euclidean(neighbor, goal), same as the legacy.
//
// Returns the full pixel walk as a flat Int32-style array [x0,y0,x1,y1,...]
// or null if no path.

import { MinHeap } from './heap.js';

const SQRT2 = Math.SQRT2;
// Diagonal offsets, then cardinals. Order doesn't affect correctness.
const DXS = new Int8Array([-1, -1, -1, 0, 0, 1, 1, 1]);
const DYS = new Int8Array([-1, 0, 1, -1, 1, -1, 0, 1]);
const STEPS = new Float32Array([SQRT2, 1, SQRT2, 1, 1, SQRT2, 1, SQRT2]);

export function astar(grid, w, h, start, goal, scratch = null) {
    const sx = start.x | 0, sy = start.y | 0;
    const gx = goal.x | 0, gy = goal.y | 0;
    if (sx === gx && sy === gy) return [sx, sy];

    const n = w * h;
    let gScore = scratch?.gScore;
    let parent = scratch?.parent;
    let closed = scratch?.closed;
    if (!gScore || gScore.length < n) {
        gScore = new Float32Array(n);
        parent = new Int32Array(n);
        closed = new Uint8Array(n);
        if (scratch) {
            scratch.gScore = gScore;
            scratch.parent = parent;
            scratch.closed = closed;
        }
    }
    gScore.fill(Infinity, 0, n);
    parent.fill(-1, 0, n);
    closed.fill(0, 0, n);

    const open = new MinHeap();
    const startIdx = sy * w + sx;
    gScore[startIdx] = 0;
    open.push(Math.hypot(gx - sx, gy - sy), startIdx);

    while (open.size > 0) {
        const cur = open.pop();
        if (closed[cur]) continue;
        closed[cur] = 1;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx === gx && cy === gy) {
            // Reconstruct and flip to start->goal.
            const rev = [];
            let p = cur;
            while (p !== -1) {
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
        const gCur = gScore[cur];
        for (let k = 0; k < 8; k++) {
            const dxs = DXS[k];
            const dys = DYS[k];
            const nx = cx + dxs;
            const ny = cy + dys;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nIdx = ny * w + nx;
            const nGrey = grid[nIdx];
            if (nGrey === 0) continue;
            // Production parity: the legacy server A* implementation didn't
            // block diagonal corner squeezes. With the runtime inflate_
            // obstacles + corridor pass downstream, wall-adjacent cells get
            // higher cost so A* naturally detours; the explicit corner
            // block over-constrained narrow passages.
            const moveCost = STEPS[k] * (255 - nGrey);
            const tentative = gCur + moveCost;
            if (tentative < gScore[nIdx]) {
                gScore[nIdx] = tentative;
                parent[nIdx] = cur;
                const f = tentative + Math.hypot(gx - nx, gy - ny);
                open.push(f, nIdx);
            }
        }
    }
    return null;
}
