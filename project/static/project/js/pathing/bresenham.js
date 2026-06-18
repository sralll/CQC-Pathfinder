// Integer Bresenham line walker from the retired server implementation.
// Yields every pixel along the
// line from (x0, y0) to (x1, y1) inclusive.

export function bresenhamPoints(x0, y0, x1, y1) {
    const pts = [];
    let x = x0, y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (true) {
        pts.push(x, y);
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
    }
    return pts;
}

// Plain Bresenham LOS from the retired server implementation.
// Returns false as soon as the cell the line is currently at is 0.
export function hasLineOfSight(grid, w, h, x0, y0, x1, y1) {
    let x = x0, y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (true) {
        if (grid[y * w + x] === 0) return false;
        if (x === x1 && y === y1) return true;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
    }
}

// Conservative same-terrain LOS. The line may only touch pixels with the
// exact same greyscale value as the start cell; corner crossings also check
// both adjacent cells so shortcuts do not shave through blocked/speed-changing
// corners.
export function sameTerrainOnLine(grid, w, h, x0, y0, x1, y1) {
    const ref = grid[y0 * w + x0];
    if (ref === 0) return false;
    let x = x0;
    let y = y0;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const nx = Math.abs(dx);
    const ny = Math.abs(dy);
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    let ix = 0;
    let iy = 0;

    function same(tx, ty) {
        return tx >= 0 && tx < w && ty >= 0 && ty < h && grid[ty * w + tx] === ref;
    }

    if (!same(x, y)) return false;
    while (ix < nx || iy < ny) {
        const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
        if (decision === 0) {
            if (!same(x + sx, y) || !same(x, y + sy)) return false;
            x += sx;
            y += sy;
            ix++;
            iy++;
        } else if (decision < 0) {
            x += sx;
            ix++;
        } else {
            y += sy;
            iy++;
        }
        if (!same(x, y)) return false;
    }
    return true;
}
