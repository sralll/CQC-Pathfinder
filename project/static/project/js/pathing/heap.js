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
        const ps = this._ps, vs = this._vs;
        let i = ps.length;
        ps.push(priority);
        vs.push(value);
        // Move the hole upward and write the new entry once. This has the
        // exact comparison/tie behaviour of the former swap loop (`<=` keeps
        // an equal-priority parent above the new entry), with fewer array
        // reads and writes on the hot A*/Theta* open-list path.
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (ps[parent] <= priority) break;
            ps[i] = ps[parent];
            vs[i] = vs[parent];
            i = parent;
        }
        ps[i] = priority;
        vs[i] = value;
    }
    pop() {
        const ps = this._ps, vs = this._vs;
        const rootValue = vs[0];
        const lastPriority = ps.pop();
        const lastValue = vs.pop();
        const n = ps.length;
        if (n === 0) return rootValue;

        let i = 0;
        const half = n >> 1;
        while (i < half) {
            let child = i * 2 + 1;
            const right = child + 1;
            if (right < n && ps[right] < ps[child]) child = right;
            if (lastPriority <= ps[child]) break;
            ps[i] = ps[child];
            vs[i] = vs[child];
            i = child;
        }
        ps[i] = lastPriority;
        vs[i] = lastValue;
        return rootValue;
    }
}
