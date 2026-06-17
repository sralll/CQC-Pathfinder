// 8-connected union-find connected-component labelling.
// Output equivalent to scipy.ndimage.label(grid > 0, structure=np.ones((3,3))).
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
