// Pre/post processing — JS port of the retired server helpers
// + the corridor mask from pathing/theta.py:_fast_corridor_mask.
// All operate on a flat Uint8Array greyscale grid.

import { bresenhamPoints } from './bresenham.js';

const TRAIN_SCALE = 0.710;
const BLOCKED_LINE_WIDTH = 7;

// Stamp a horizontal scanline (inclusive) onto a Uint8Array grid at value 0.
function blackLineH(grid, w, h, y, x0, x1) {
    if (y < 0 || y >= h) return;
    const lo = Math.max(0, Math.min(x0, x1));
    const hi = Math.min(w - 1, Math.max(x0, x1));
    const base = y * w;
    for (let x = lo; x <= hi; x++) grid[base + x] = 0;
}

// Draw a thick line of `value` (0 = blocker) at (x0,y0)-(x1,y1), width px wide.
// Matches PIL ImageDraw.line(fill=0, width=BLOCKED_LINE_WIDTH).
function drawThickLine(grid, w, h, x0, y0, x1, y1, value, width) {
    const pts = bresenhamPoints(x0, y0, x1, y1);
    const r = Math.max(0, Math.floor((width - 1) / 2));
    for (let i = 0; i < pts.length; i += 2) {
        const cx = pts[i], cy = pts[i + 1];
        for (let dy = -r; dy <= r; dy++) {
            const yy = cy + dy;
            if (yy < 0 || yy >= h) continue;
            const dxMax = Math.floor(Math.sqrt(r * r - dy * dy + 1e-9));
            const base = yy * w;
            const lo = Math.max(0, cx - dxMax);
            const hi = Math.min(w - 1, cx + dxMax);
            for (let xx = lo; xx <= hi; xx++) grid[base + xx] = value;
        }
    }
}

// Simple scanline polygon fill (even-odd). Sets all interior pixels to 0.
function fillPolygon(grid, w, h, points) {
    if (points.length < 3) return;
    let ymin = Infinity, ymax = -Infinity;
    for (const p of points) {
        if (p.y < ymin) ymin = p.y;
        if (p.y > ymax) ymax = p.y;
    }
    ymin = Math.max(0, Math.floor(ymin));
    ymax = Math.min(h - 1, Math.ceil(ymax));
    for (let y = ymin; y <= ymax; y++) {
        const xs = [];
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            const ay = a.y, by = b.y;
            if ((ay <= y && by > y) || (by <= y && ay > y)) {
                const t = (y - ay) / (by - ay);
                xs.push(a.x + t * (b.x - a.x));
            }
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            blackLineH(grid, w, h, y, Math.ceil(xs[i]), Math.floor(xs[i + 1]));
        }
    }
}

// Apply user-drawn blockers to a copy of the mask. Coordinates from the
// editor are in *map* pixels and are divided by TRAIN_SCALE to enter the
// mask grid — identical to the retired server apply_blocked_terrain helper.
export function applyBlockedTerrain(grid, w, h, blockedTerrain) {
    // The cached grid for the no-blockers case is shared; copy before mutating.
    const out = new Uint8Array(grid);
    if (!blockedTerrain) return out;
    const lines = blockedTerrain.lines || [];
    const areas = blockedTerrain.areas || [];
    for (const ln of lines) {
        if (!ln || !ln.start || !ln.end) continue;
        const x0 = Math.round(ln.start.x / TRAIN_SCALE);
        const y0 = Math.round(ln.start.y / TRAIN_SCALE);
        const x1 = Math.round(ln.end.x / TRAIN_SCALE);
        const y1 = Math.round(ln.end.y / TRAIN_SCALE);
        drawThickLine(out, w, h, x0, y0, x1, y1, 0, BLOCKED_LINE_WIDTH);
    }
    for (const area of areas) {
        const pts = (area.points || []).map(p => ({
            x: p.x / TRAIN_SCALE,
            y: p.y / TRAIN_SCALE,
        }));
        if (pts.length >= 3) fillPolygon(out, w, h, pts);
    }
    return out;
}

// Crop the mask to a bbox around start/ziel padded by `margin`. Edges of the
// returned subgrid are set to 0 to prevent A*/theta* from escaping. Returns
// { subgrid: Uint8Array, sw, sh, offsetX, offsetY, startSub, zielSub }.
// Mirrors the retired server extract_subgrid helper.
export function extractSubgrid(grid, w, h, start, ziel, margin) {
    const xs = [start.x, ziel.x];
    const ys = [start.y, ziel.y];
    const xMin = Math.max(Math.min(...xs) - margin, 0);
    const xMax = Math.min(Math.max(...xs) + margin, w - 1);
    const yMin = Math.max(Math.min(...ys) - margin, 0);
    const yMax = Math.min(Math.max(...ys) + margin, h - 1);
    const sw = xMax - xMin + 1;
    const sh = yMax - yMin + 1;
    const subgrid = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) {
        const srcBase = (y + yMin) * w + xMin;
        subgrid.set(grid.subarray(srcBase, srcBase + sw), y * sw);
    }
    // Block edges (matches Python's `subgrid[0,:] = 0` etc).
    for (let x = 0; x < sw; x++) {
        subgrid[x] = 0;
        subgrid[(sh - 1) * sw + x] = 0;
    }
    for (let y = 0; y < sh; y++) {
        subgrid[y * sw] = 0;
        subgrid[y * sw + sw - 1] = 0;
    }
    return {
        subgrid, sw, sh,
        offsetX: xMin, offsetY: yMin,
        startSub: { x: start.x - xMin, y: start.y - yMin },
        zielSub: { x: ziel.x - xMin, y: ziel.y - yMin },
    };
}

// 8-connected BFS to the nearest non-zero pixel. Mirrors
// the retired server move_to_nearest_free helper.
export function snapToFree(grid, w, h, x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return null;
    if (grid[y * w + x] !== 0) return { x, y };
    const visited = new Uint8Array(w * h);
    visited[y * w + x] = 1;
    // ring buffer of (x, y) — coordinates packed as y*w + x.
    let head = 0;
    const queue = [y * w + x];
    const dirs = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
    while (head < queue.length) {
        const p = queue[head++];
        const px = p % w, py = (p - px) / w;
        for (const d of dirs) {
            const np = p + d;
            const nx = np % w, ny = (np - nx) / w;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            if (Math.abs(nx - px) > 1 || Math.abs(ny - py) > 1) continue; // wrap guard
            if (visited[np]) continue;
            visited[np] = 1;
            if (grid[np] !== 0) return { x: nx, y: ny };
            queue.push(np);
        }
    }
    return null;
}

// Corridor mask along a polyline. Walks Bresenham between consecutive
// vertices and stamps a circular disk of `radius` at every pixel. Direct port
// of the retired server generate_corridor_mask_numpy helper. Production uses
// this with the SIMPLIFIED A* waypoints (after simplify_wps), not the dense
// A* path, so a `radius=40` corridor covers a wide tube around the high-level
// turn polyline.
export function corridorMask(polyline, sw, sh, radius) {
    const mask = new Uint8Array(sw * sh);
    if (polyline.length < 2) return mask;
    const stamp = [];
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy <= radius * radius) stamp.push(dx, dy);
        }
    }
    function stampAt(cx, cy) {
        for (let j = 0; j < stamp.length; j += 2) {
            const nx = cx + stamp[j], ny = cy + stamp[j + 1];
            if (nx < 0 || nx >= sw || ny < 0 || ny >= sh) continue;
            mask[ny * sw + nx] = 1;
        }
    }
    if (polyline.length === 2) {
        stampAt(polyline[0], polyline[1]);
        return mask;
    }
    for (let i = 0; i + 3 < polyline.length; i += 2) {
        const pts = bresenhamPoints(
            polyline[i], polyline[i + 1],
            polyline[i + 2], polyline[i + 3],
        );
        for (let k = 0; k < pts.length; k += 2) stampAt(pts[k], pts[k + 1]);
    }
    return mask;
}

// Soft-block cells adjacent to impassable pixels. Direct port of
// the retired server inflate_obstacles helper: every passable cell that has
// at least one impassable neighbour within `radius` is overwritten with
// `dilationBlock` (default 150 ≈ "very slow"). Production runs this on the
// subgrid before applying the corridor mask, so theta* sees an obstacle halo
// that costs ~10× more to traverse than fast terrain but is still passable
// for narrow corridors.
export function inflateObstacles(grid, w, h, radius = 1, dilationBlock = 255 - 24) {
    const out = new Uint8Array(grid);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            if (grid[idx] === 0) continue;
            let nearObstacle = false;
            for (let dy = -radius; dy <= radius && !nearObstacle; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -radius; dx <= radius; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= w) continue;
                    if (grid[ny * w + nx] === 0) { nearObstacle = true; break; }
                }
            }
            if (nearObstacle && grid[idx] > dilationBlock) out[idx] = dilationBlock;
        }
    }
    return out;
}

// Black out the middle section of previously-generated routes so the next A*
// is forced through a topologically different path. Port of
// the retired server draw_route_mask helper:
//   - skip the first/last 40% of the start-ziel distance (preserves approach)
//   - within that band, stamp a circle of radius = min(dist_start, dist_end)/7
//     so the blackout is widest mid-route and tapers near endpoints
// All coords (route polylines, startGrid, zielGrid) must be in mask-grid
// pixels (caller converts from map units).
export function drawRouteMask(grid, w, h, routesGrid, startGrid, zielGrid) {
    const out = new Uint8Array(grid);
    if (!routesGrid || routesGrid.length === 0) return out;

    function routePoints(route) {
        return (route || []).map(p => {
            if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]) };
            return { x: Number(p?.x), y: Number(p?.y) };
        }).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    }

    function interp(a, b, t) {
        return {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
        };
    }

    function stampDisk(cx, cy, radius) {
        const x = Math.round(cx);
        const y = Math.round(cy);
        if (radius <= 0) {
            if (x >= 0 && x < w && y >= 0 && y < h) out[y * w + x] = 0;
            return;
        }
        for (let dy = -radius; dy <= radius; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            const dxMax = Math.floor(Math.sqrt(radius * radius - dy * dy));
            const base = yy * w;
            const lo = Math.max(0, x - dxMax);
            const hi = Math.min(w - 1, x + dxMax);
            for (let xx = lo; xx <= hi; xx++) out[base + xx] = 0;
        }
    }

    function blockMiddleBlob(pts, cum, totalDist) {
        const blockStart = totalDist * 0.4;
        const blockEnd = totalDist * 0.6;
        for (let i = 0; i < pts.length - 1; i++) {
            const segStart = cum[i];
            const segEnd = cum[i + 1];
            const segLen = segEnd - segStart;
            if (segLen <= 0) continue;
            const aDist = Math.max(segStart, blockStart);
            const bDist = Math.min(segEnd, blockEnd);
            if (bDist < aDist) continue;

            const a = interp(pts[i], pts[i + 1], (aDist - segStart) / segLen);
            const b = interp(pts[i], pts[i + 1], (bDist - segStart) / segLen);
            const pixels = bresenhamPoints(Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y));
            const pixelSteps = Math.max(1, pixels.length / 2 - 1);
            for (let k = 0; k < pixels.length; k += 2) {
                const px = pixels[k], py = pixels[k + 1];
                const along = aDist + (bDist - aDist) * ((k / 2) / pixelSteps);
                const radius = Math.max(3, Math.floor(Math.min(along, totalDist - along) / 7));
                stampDisk(px, py, radius);
            }
        }
    }

    for (const route of routesGrid) {
        const pts = routePoints(route);
        if (pts.length < 2) continue;

        const cum = [0];
        for (let i = 1; i < pts.length; i++) {
            cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
        }
        const totalDist = cum[cum.length - 1];
        if (totalDist <= 0) continue;

        blockMiddleBlob(pts, cum, totalDist);
    }
    return out;
}

// Element-wise: out = (corridor === 1) ? subgrid : 0. New Uint8Array.
export function applyCorridor(subgrid, corridor) {
    const n = subgrid.length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (corridor[i]) out[i] = subgrid[i];
    return out;
}
