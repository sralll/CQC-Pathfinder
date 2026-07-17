// 8-connected union-find connected-component labelling.
// 8-connected component labeling for passable mask pixels.
// Label 0 = background (grid == 0), labels >=1 = free-space components.

export function labelConnected(grid, w, h) {
    const n = w * h;
    // Two-pass with union-find on equivalences.
    const parent = new Int32Array(n + 1); // 0 unused (background)
    const labels = new Int32Array(n);     // provisional pass-1 labels
    let nextLabel = 1;

    function find(x) {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    }
    function union(a, b) {
        const ra = find(a), rb = find(b);
        if (ra === rb) return;
        if (ra < rb) parent[rb] = ra;
        else parent[ra] = rb;
    }

    // Pass 1 — for each free pixel look at NW, N, NE, W neighbours that
    // are already processed; union their labels, or allocate a new one.
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            if (grid[idx] === 0) continue;
            const candidates = [];
            // NW
            if (y > 0 && x > 0) {
                const l = labels[idx - w - 1];
                if (l) candidates.push(l);
            }
            // N
            if (y > 0) {
                const l = labels[idx - w];
                if (l) candidates.push(l);
            }
            // NE
            if (y > 0 && x < w - 1) {
                const l = labels[idx - w + 1];
                if (l) candidates.push(l);
            }
            // W
            if (x > 0) {
                const l = labels[idx - 1];
                if (l) candidates.push(l);
            }
            if (candidates.length === 0) {
                labels[idx] = nextLabel;
                parent[nextLabel] = nextLabel;
                nextLabel++;
            } else {
                let minLbl = candidates[0];
                for (let i = 1; i < candidates.length; i++) {
                    if (candidates[i] < minLbl) minLbl = candidates[i];
                }
                labels[idx] = minLbl;
                for (const c of candidates) if (c !== minLbl) union(minLbl, c);
            }
        }
    }

    // Pass 2 — compress labels with the union-find roots and remap to a
    // contiguous numbering so we can return a Uint16Array when possible.
    const remap = new Int32Array(nextLabel);
    let final = 0;
    for (let l = 1; l < nextLabel; l++) {
        const r = find(l);
        if (remap[r] === 0) {
            final++;
            remap[r] = final;
        }
        remap[l] = remap[r];
    }
    const useU16 = final < 65535;
    const out = useU16 ? new Uint16Array(n) : new Int32Array(n);
    for (let i = 0; i < n; i++) {
        const l = labels[i];
        out[i] = l ? remap[l] : 0;
    }
    return { labels: out, ncomp: final };
}

/**
 * Return whether two passable pixels share an 8-connected component.
 *
 * Unlike labelConnected(), this single-query helper does not label or remap
 * every component in the image. It is used for alternate-route exhaustion
 * proofs where only start-to-goal reachability matters.
 */
export function areConnected8(grid, w, h, start, goal, destructive = false) {
    const sx = start?.x | 0, sy = start?.y | 0;
    const gx = goal?.x | 0, gy = goal?.y | 0;
    if (sx < 0 || sx >= w || sy < 0 || sy >= h
            || gx < 0 || gx >= w || gy < 0 || gy >= h) return false;
    const startIndex = sy * w + sx;
    const goalIndex = gy * w + gx;
    if (!grid[startIndex] || !grid[goalIndex]) return false;
    if (startIndex === goalIndex) return true;

    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    if (destructive) {
        // Callers may opt in when the grid is a disposable search-domain copy.
        // Marking visited pixels directly avoids a second full-size allocation
        // and a second random-access array in the alternate-route proof.
        grid[startIndex] = 0;
        queue[tail++] = startIndex;
        while (head < tail) {
            const index = queue[head++];
            const x = index % w;
            const y = (index - x) / w;
            if (x > 0 && x + 1 < w && y > 0 && y + 1 < h) {
                // Most visited pixels are interior. Preserve the same
                // top-to-bottom, left-to-right neighbour order without the
                // per-node min/max work and nested-loop bookkeeping.
                let next = index - w - 1;
                if (grid[next]) {
                    if (next === goalIndex) return true;
                    grid[next] = 0; queue[tail++] = next;
                }
                next = index - w;
                if (grid[next]) {
                    if (next === goalIndex) return true;
                    grid[next] = 0; queue[tail++] = next;
                }
                next = index - w + 1;
                if (grid[next]) {
                    if (next === goalIndex) return true;
                    grid[next] = 0; queue[tail++] = next;
                }
                next = index - 1;
                if (grid[next]) {
                    if (next === goalIndex) return true;
                    grid[next] = 0; queue[tail++] = next;
                }
                next = index + 1;
                if (grid[next]) {
                    if (next === goalIndex) return true;
                    grid[next] = 0; queue[tail++] = next;
                }
                next = index + w - 1;
                if (grid[next]) {
                    if (next === goalIndex) return true;
                    grid[next] = 0; queue[tail++] = next;
                }
                next = index + w;
                if (grid[next]) {
                    if (next === goalIndex) return true;
                    grid[next] = 0; queue[tail++] = next;
                }
                next = index + w + 1;
                if (grid[next]) {
                    if (next === goalIndex) return true;
                    grid[next] = 0; queue[tail++] = next;
                }
                continue;
            }
            const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
            const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
            for (let ny = y0; ny <= y1; ny++) {
                const base = ny * w;
                for (let nx = x0; nx <= x1; nx++) {
                    if (nx === x && ny === y) continue;
                    const next = base + nx;
                    if (!grid[next]) continue;
                    if (next === goalIndex) return true;
                    grid[next] = 0;
                    queue[tail++] = next;
                }
            }
        }
        return false;
    }

    const seen = new Uint8Array(w * h);
    seen[startIndex] = 1;
    queue[tail++] = startIndex;
    while (head < tail) {
        const index = queue[head++];
        const x = index % w;
        const y = (index - x) / w;
        const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
        const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
        for (let ny = y0; ny <= y1; ny++) {
            const base = ny * w;
            for (let nx = x0; nx <= x1; nx++) {
                if (nx === x && ny === y) continue;
                const next = base + nx;
                if (seen[next] || !grid[next]) continue;
                if (next === goalIndex) return true;
                seen[next] = 1;
                queue[tail++] = next;
            }
        }
    }
    return false;
}
