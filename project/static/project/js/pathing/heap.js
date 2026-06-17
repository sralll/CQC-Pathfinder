// Binary min-heap of (priority, value) pairs.
// Used for A*/theta* open lists. Same semantics as Python heapq: pop returns
// the smallest priority. Ties broken by insertion order via the value field
// (we never rely on it explicitly).

export class MinHeap {
    constructor() {
        this._ps = []; // priorities
        this._vs = []; // values
    }
    get size() { return this._ps.length; }
    push(priority, value) {
        this._ps.push(priority);
        this._vs.push(value);
        this._swim(this._ps.length - 1);
    }
    pop() {
        const lastIdx = this._ps.length - 1;
        const v = this._vs[0];
        if (lastIdx > 0) {
            this._ps[0] = this._ps[lastIdx];
            this._vs[0] = this._vs[lastIdx];
        }
        this._ps.pop();
        this._vs.pop();
        if (this._ps.length > 0) this._sink(0);
        return v;
    }
    _swim(i) {
        const ps = this._ps, vs = this._vs;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (ps[parent] <= ps[i]) break;
            [ps[parent], ps[i]] = [ps[i], ps[parent]];
            [vs[parent], vs[i]] = [vs[i], vs[parent]];
            i = parent;
        }
    }
    _sink(i) {
        const ps = this._ps, vs = this._vs;
        const n = ps.length;
        while (true) {
            const l = 2 * i + 1, r = 2 * i + 2;
            let smallest = i;
            if (l < n && ps[l] < ps[smallest]) smallest = l;
            if (r < n && ps[r] < ps[smallest]) smallest = r;
            if (smallest === i) break;
            [ps[smallest], ps[i]] = [ps[i], ps[smallest]];
            [vs[smallest], vs[i]] = [vs[i], vs[smallest]];
            i = smallest;
        }
    }
}
