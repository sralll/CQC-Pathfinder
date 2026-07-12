// Polygon — port of com.watabou.geom.Polygon.
//
// In Haxe this is an `abstract over Array<Point>`. Here it is `class Polygon extends Array`
// with `Symbol.species = Array`, so slice/concat/map/filter return PLAIN arrays (never call
// `new Polygon(number)`); we wrap explicitly with `new Polygon([...])` exactly where the Haxe
// code does `new Polygon( this.slice(...) )`. Points are shared by reference throughout.

import { Point } from './Point.js';
import { GeomUtils } from './GeomUtils.js';
import { MathUtils } from './MathUtils.js';
import { remove as arrRemove } from './arrays.js';
import { dcos, dsin } from './dmath.js';

const DELTA = 0.000001;

export class Polygon extends Array {
	// Make derived-array methods (slice/concat/map/filter) return plain Array,
	// so they don't try to construct `new Polygon(length)`.
	static get [Symbol.species]() {
		return Array;
	}

	constructor(vertices = null) {
		super();
		if (vertices != null) for (const v of vertices) this.push(v); // shallow copy: shared Point refs
	}

	// --- small array helpers Haxe gets from ArrayExtender / Array, scoped to `this` ---
	last() {
		return this[this.length - 1];
	}

	remove(x) {
		const i = this.indexOf(x);
		if (i === -1) return false;
		this.splice(i, 1);
		return true;
	}

	set(p) {
		for (let i = 0; i < p.length; i++) this[i].set(p[i]);
	}

	// --- metrics ---
	get square() {
		let v1 = this.last();
		let v2 = this[0];
		let s = v1.x * v2.y - v2.x * v1.y;
		for (let i = 1; i < this.length; i++) {
			v1 = v2;
			v2 = this[i];
			s += v1.x * v2.y - v2.x * v1.y;
		}
		return s * 0.5;
	}

	get perimeter() {
		let len = 0.0;
		this.forEdge((v0, v1) => {
			len += Point.distance(v0, v1);
		});
		return len;
	}

	// circle = 1.00, square = 0.79, triangle = 0.60
	get compactness() {
		const p = this.perimeter;
		return (4 * Math.PI * this.square) / (p * p);
	}

	// Faster approximation of centroid (average of vertices)
	get center() {
		const c = new Point();
		for (const v of this) c.addEq(v);
		c.scaleEq(1 / this.length);
		return c;
	}

	get centroid() {
		let x = 0.0;
		let y = 0.0;
		let a = 0.0;
		this.forEdge((v0, v1) => {
			const f = GeomUtils.cross(v0.x, v0.y, v1.x, v1.y);
			a += f;
			x += (v0.x + v1.x) * f;
			y += (v0.y + v1.y) * f;
		});
		const s6 = 1 / (3 * a);
		return new Point(s6 * x, s6 * y);
	}

	contains(v) {
		return this.indexOf(v) !== -1;
	}

	forEdge(f) {
		const len = this.length;
		for (let i = 0; i < len; i++) f(this[i], this[(i + 1) % len]);
	}

	// like forEdge but skips the closing v(n-1)->v(0) edge
	forSegment(f) {
		for (let i = 0; i < this.length - 1; i++) f(this[i], this[i + 1]);
	}

	offset(p) {
		const dx = p.x;
		const dy = p.y;
		for (const v of this) v.offset(dx, dy);
	}

	rotate(a) {
		const cosA = dcos(a);
		const sinA = dsin(a);
		for (const v of this) {
			const vx = v.x * cosA - v.y * sinA;
			const vy = v.y * cosA + v.x * sinA;
			v.setTo(vx, vy);
		}
	}

	isConvexVertexi(i) {
		const len = this.length;
		const v0 = this[(i + len - 1) % len];
		const v1 = this[i];
		const v2 = this[(i + 1) % len];
		return GeomUtils.cross(v1.x - v0.x, v1.y - v0.y, v2.x - v1.x, v2.y - v1.y) > 0;
	}

	isConvexVertex(v1) {
		const v0 = this.prev(v1);
		const v2 = this.next(v1);
		return GeomUtils.cross(v1.x - v0.x, v1.y - v0.y, v2.x - v1.x, v2.y - v1.y) > 0;
	}

	isConvex() {
		for (const v of this) if (!this.isConvexVertex(v)) return false;
		return true;
	}

	smoothVertexi(i, f = 1.0) {
		const v = this[i];
		const len = this.length;
		const prev = this[(i + len - 1) % len];
		const next = this[(i + 1) % len];
		return new Point((prev.x + v.x * f + next.x) / (2 + f), (prev.y + v.y * f + next.y) / (2 + f));
	}

	smoothVertex(v, f = 1.0) {
		const prev = this.prev(v);
		const next = this.next(v);
		return new Point(prev.x + v.x * f + next.x, prev.y + v.y * f + next.y).scale(1 / (2 + f));
	}

	// NOTE: faithful port — the original only ever returns the distance to the FIRST vertex
	// (the loop updates v0 but never updates `d`). Kept verbatim for behavioral parity.
	distance(p) {
		let v0 = this[0];
		const d = Point.distance(v0, p);
		for (let i = 1; i < this.length; i++) {
			const v1 = this[i];
			const d1 = Point.distance(v1, p);
			if (d1 < d) v0 = v1;
		}
		return d;
	}

	smoothVertexEq(f = 1.0) {
		const len = this.length;
		let v1 = this[len - 1];
		let v2 = this[0];
		const out = [];
		for (let i = 0; i < len; i++) {
			const v0 = v1;
			v1 = v2;
			v2 = this[(i + 1) % len];
			out.push(new Point((v0.x + v1.x * f + v2.x) / (2 + f), (v0.y + v1.y * f + v2.y) / (2 + f)));
		}
		return new Polygon(out);
	}

	filterShort(threshold) {
		let i = 1;
		let v0 = this[0];
		let v1 = this[1];
		const result = [v0];
		do {
			do {
				v1 = this[i++];
			} while (Point.distance(v0, v1) < threshold && i < this.length);
			result.push((v0 = v1));
		} while (i < this.length);
		return new Polygon(result);
	}

	// Insets one edge defined by its first vertex. Doesn't change vertex count.
	inset(p1, d) {
		const i1 = this.indexOf(p1);
		const i0 = i1 > 0 ? i1 - 1 : this.length - 1;
		const p0 = this[i0];
		const i2 = i1 < this.length - 1 ? i1 + 1 : 0;
		const p2 = this[i2];
		const i3 = i2 < this.length - 1 ? i2 + 1 : 0;
		const p3 = this[i3];

		const v0 = p1.subtract(p0);
		const v1 = p2.subtract(p1);
		const v2 = p3.subtract(p2);

		let cos = v0.dot(v1) / v0.length / v1.length;
		let z = v0.x * v1.y - v0.y * v1.x;
		let t = d / Math.sqrt(1 - cos * cos);
		if (z > 0) t = Math.min(t, v0.length * 0.99);
		else t = Math.min(t, v1.length * 0.5);
		t *= MathUtils.sign(z);
		this[i1] = p1.subtract(v0.norm(t));

		cos = v1.dot(v2) / v1.length / v2.length;
		z = v1.x * v2.y - v1.y * v2.x;
		t = d / Math.sqrt(1 - cos * cos);
		if (z > 0) t = Math.min(t, v2.length * 0.99);
		else t = Math.min(t, v1.length * 0.5);
		this[i2] = p2.add(v2.norm(t));
	}

	insetAll(d) {
		const p = new Polygon(this);
		for (let i = 0; i < p.length; i++) if (d[i] !== 0) p.inset(p[i], d[i]);
		return p;
	}

	insetEq(d) {
		for (let i = 0; i < this.length; i++) this.inset(this[i], d);
	}

	// Insets all edges by per-edge distances. Reliable for convex & concave, but changes
	// vertex count and can create "steps" when distances differ. Handles self-intersection.
	buffer(d) {
		const q = new Polygon();
		let i = 0;
		this.forEdge((v0, v1) => {
			const dd = d[i++];
			if (dd === 0) {
				q.push(v0);
				q.push(v1);
			} else {
				const v = v1.subtract(v0);
				const n = v.rotate90().norm(dd);
				q.push(v0.add(n));
				q.push(v1.add(n));
			}
		});

		// Resolve self-intersections: split every crossing into shared points.
		let wasCut;
		let lastEdge = 0;
		do {
			wasCut = false;
			const n = q.length;
			for (i = lastEdge; i < n - 2; i++) {
				lastEdge = i;

				const p11 = q[i];
				const p12 = q[i + 1];
				const x1 = p11.x;
				const y1 = p11.y;
				const dx1 = p12.x - x1;
				const dy1 = p12.y - y1;

				const jmax = i > 0 ? n : n - 1;
				for (let j = i + 2; j < jmax; j++) {
					const p21 = q[j];
					const p22 = j < n - 1 ? q[j + 1] : q[0];
					const x2 = p21.x;
					const y2 = p21.y;
					const dx2 = p22.x - x2;
					const dy2 = p22.y - y2;

					const int = GeomUtils.intersectLines(x1, y1, dx1, dy1, x2, y2, dx2, dy2);
					if (int != null && int.x > DELTA && int.x < 1 - DELTA && int.y > DELTA && int.y < 1 - DELTA) {
						const pn = new Point(x1 + dx1 * int.x, y1 + dy1 * int.x);
						q.splice(j + 1, 0, pn);
						q.splice(i + 1, 0, pn);
						wasCut = true;
						break;
					}
				}
				if (wasCut) break;
			}
		} while (wasCut);

		// Pick the biggest sub-loop.
		const regular = [];
		for (i = 0; i < q.length; i++) regular.push(i);

		let bestPart = null;
		let bestPartSq = Number.NEGATIVE_INFINITY;

		while (regular.length > 0) {
			const indices = [];
			const start = regular[0];
			let k = start;
			do {
				indices.push(k);
				arrRemove(regular, k);

				const next = (k + 1) % q.length;
				const v = q[next];
				let next1 = q.indexOf(v);
				if (next1 === next) next1 = q.lastIndexOf(v);
				k = next1 === -1 ? next : next1;
			} while (k !== start);

			const p = new Polygon(indices.map((ix) => q[ix]));
			const s = p.square;
			if (s > bestPartSq) {
				bestPart = p;
				bestPartSq = s;
			}
		}

		return bestPart;
	}

	bufferEq(d) {
		return this.buffer(this.map(() => d));
	}

	// Insets all edges by per-edge distances by repeatedly cutting. Can't outset; best for
	// convex polygons; produces a convex polygon; changes vertex count.
	shrink(d) {
		let q = new Polygon(this);
		let i = 0;
		this.forEdge((v1, v2) => {
			const dd = d[i++];
			if (dd > 0) {
				const v = v2.subtract(v1);
				const n = v.rotate90().norm(dd);
				q = q.cut(v1.add(n), v2.add(n), 0)[0];
			}
		});
		return q;
	}

	shrinkEq(d) {
		return this.shrink(this.map(() => d));
	}

	// Robust uniform inset: shift every edge inward by d, compute new vertices as
	// intersections of adjacent offset lines, then resolve any self-intersections
	// (which arise at concave vertices). Works for both convex and concave polygons.
	shrinkRobust(d) {
		const n = this.length;
		if (n < 3 || !(d > 0)) return new Polygon(this.map(v => v.clone()));

		const area = this.square;
		if (Math.abs(area) < 1e-10) return null;
		const s = area > 0 ? 1 : -1;

		const edges = [];
		for (let i = 0; i < n; i++) {
			const a = this[i];
			const b = this[(i + 1) % n];
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const len = Math.sqrt(dx * dx + dy * dy);
			if (len < 1e-10) {
				edges.push(null);
			} else {
				edges.push({
					dx, dy,
					nx: (-dy / len) * d * s,
					ny: (dx / len) * d * s
				});
			}
		}
		for (let i = 0; i < n; i++) {
			if (!edges[i]) edges[i] = edges[(i + 1) % n] || edges[(i + n - 1) % n];
		}
		if (!edges[0]) return null;

		const q = [];
		for (let i = 0; i < n; i++) {
			const prev = (i + n - 1) % n;
			const e0 = edges[prev];
			const e1 = edges[i];
			const ox0 = this[prev].x + e0.nx;
			const oy0 = this[prev].y + e0.ny;
			const ox1 = this[i].x + e1.nx;
			const oy1 = this[i].y + e1.ny;

			const t = GeomUtils.intersectLines(ox0, oy0, e0.dx, e0.dy, ox1, oy1, e1.dx, e1.dy);
			if (!t || Math.abs(t.x) > 1e8) {
				q.push(new Point((ox0 + ox1) / 2, (oy0 + oy1) / 2));
			} else {
				q.push(new Point(ox0 + e0.dx * t.x, oy0 + e0.dy * t.x));
			}
		}

		let wasCut;
		let lastEdge = 0;
		do {
			wasCut = false;
			const m = q.length;
			for (let i = lastEdge; i < m - 2; i++) {
				lastEdge = i;
				const p11 = q[i];
				const p12 = q[i + 1];
				const x1 = p11.x, y1 = p11.y;
				const dx1 = p12.x - x1, dy1 = p12.y - y1;
				const jmax = i > 0 ? m : m - 1;
				for (let j = i + 2; j < jmax; j++) {
					const p21 = q[j];
					const p22 = j < m - 1 ? q[j + 1] : q[0];
					const x2 = p21.x, y2 = p21.y;
					const dx2 = p22.x - x2, dy2 = p22.y - y2;
					const int = GeomUtils.intersectLines(x1, y1, dx1, dy1, x2, y2, dx2, dy2);
					if (int != null && int.x > DELTA && int.x < 1 - DELTA && int.y > DELTA && int.y < 1 - DELTA) {
						const pn = new Point(x1 + dx1 * int.x, y1 + dy1 * int.x);
						q.splice(j + 1, 0, pn);
						q.splice(i + 1, 0, pn);
						wasCut = true;
						break;
					}
				}
				if (wasCut) break;
			}
		} while (wasCut);

		if (q.length === n) return new Polygon(q);

		const regular = [];
		for (let i = 0; i < q.length; i++) regular.push(i);

		let bestPart = null;
		let bestPartSq = 0;

		while (regular.length > 0) {
			const indices = [];
			const start = regular[0];
			let k = start;
			do {
				indices.push(k);
				arrRemove(regular, k);
				const next = (k + 1) % q.length;
				const v = q[next];
				let next1 = q.indexOf(v);
				if (next1 === next) next1 = q.lastIndexOf(v);
				k = next1 === -1 ? next : next1;
			} while (k !== start);

			const p = new Polygon(indices.map(ix => q[ix]));
			const sq = Math.abs(p.square);
			if (sq > bestPartSq) {
				bestPart = p;
				bestPartSq = sq;
			}
		}

		return bestPart;
	}

	// Cuts a peel along one edge (inset of a single edge via cut).
	peel(v1, d) {
		const i1 = this.indexOf(v1);
		const i2 = i1 === this.length - 1 ? 0 : i1 + 1;
		const v2 = this[i2];

		const v = v2.subtract(v1);
		const n = v.rotate90().norm(d);

		return this.cut(v1.add(n), v2.add(n), 0)[0];
	}

	// Simplifies the polygon down to n vertices (drops the lowest-area vertices). Mutates.
	simplyfy(n) {
		let len = this.length;
		while (len > n) {
			let result = 0;
			let min = Number.POSITIVE_INFINITY;

			let b = this[len - 1];
			let c = this[0];
			for (let i = 0; i < len; i++) {
				const a = b;
				b = c;
				c = this[(i + 1) % len];
				const measure = Math.abs(a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
				if (measure < min) {
					result = i;
					min = measure;
				}
			}

			this.splice(result, 1);
			len--;
		}
	}

	findEdge(a, b) {
		const index = this.indexOf(a);
		return index !== -1 && this[(index + 1) % this.length] === b ? index : -1;
	}

	next(a) {
		return this[(this.indexOf(a) + 1) % this.length];
	}

	prev(a) {
		return this[(this.indexOf(a) + this.length - 1) % this.length];
	}

	vector(v) {
		return this.next(v).subtract(v);
	}

	vectori(i) {
		return this[i === this.length - 1 ? 0 : i + 1].subtract(this[i]);
	}

	borders(another) {
		const len1 = this.length;
		const len2 = another.length;
		for (let i = 0; i < len1; i++) {
			const j = another.indexOf(this[i]);
			if (j !== -1) {
				const next = this[(i + 1) % len1];
				if (next === another[(j + 1) % len2] || next === another[(j + len2 - 1) % len2]) return true;
			}
		}
		return false;
	}

	getBounds() {
		const rect = { left: this[0].x, top: this[0].y, right: this[0].x, bottom: this[0].y };
		for (const v of this) {
			rect.left = Math.min(rect.left, v.x);
			rect.right = Math.max(rect.right, v.x);
			rect.top = Math.min(rect.top, v.y);
			rect.bottom = Math.max(rect.bottom, v.y);
		}
		return rect;
	}

	split(p1, p2) {
		return this.spliti(this.indexOf(p1), this.indexOf(p2));
	}

	spliti(i1, i2) {
		if (i1 > i2) {
			const t = i1;
			i1 = i2;
			i2 = t;
		}
		return [
			new Polygon(this.slice(i1, i2 + 1)),
			new Polygon(this.slice(i2).concat(this.slice(0, i1 + 1))),
		];
	}

	cut(p1, p2, gap = 0) {
		const x1 = p1.x;
		const y1 = p1.y;
		const dx1 = p2.x - x1;
		const dy1 = p2.y - y1;

		const len = this.length;
		let edge1 = 0;
		let ratio1 = 0.0;
		let edge2 = 0;
		let ratio2 = 0.0;
		let count = 0;

		for (let i = 0; i < len; i++) {
			const v0 = this[i];
			const v1 = this[(i + 1) % len];

			const x2 = v0.x;
			const y2 = v0.y;
			const dx2 = v1.x - x2;
			const dy2 = v1.y - y2;

			const t = GeomUtils.intersectLines(x1, y1, dx1, dy1, x2, y2, dx2, dy2);
			if (t != null && t.y >= 0 && t.y <= 1) {
				if (count === 0) {
					edge1 = i;
					ratio1 = t.x;
				} else if (count === 1) {
					edge2 = i;
					ratio2 = t.x;
				}
				count++;
			}
		}

		if (count === 2) {
			const point1 = p1.add(p2.subtract(p1).scale(ratio1));
			const point2 = p1.add(p2.subtract(p1).scale(ratio2));

			let half1 = new Polygon(this.slice(edge1 + 1, edge2 + 1));
			half1.unshift(point1);
			half1.push(point2);

			let half2 = new Polygon(this.slice(edge2 + 1).concat(this.slice(0, edge1 + 1)));
			half2.unshift(point2);
			half2.push(point1);

			if (gap > 0) {
				half1 = half1.peel(point2, gap / 2);
				half2 = half2.peel(point1, gap / 2);
			}

			const v = this.vectori(edge1);
			return GeomUtils.cross(dx1, dy1, v.x, v.y) > 0 ? [half1, half2] : [half2, half1];
		} else {
			return [new Polygon(this)];
		}
	}

	interpolate(p) {
		let sum = 0.0;
		const dd = this.map((v) => {
			const d = 1 / Point.distance(v, p);
			sum += d;
			return d;
		});
		return dd.map((d) => d / sum);
	}

	static rect(w = 1.0, h = 1.0) {
		return new Polygon([
			new Point(-w / 2, -h / 2),
			new Point(w / 2, -h / 2),
			new Point(w / 2, h / 2),
			new Point(-w / 2, h / 2),
		]);
	}

	static regular(n = 8, r = 1.0) {
		const pts = [];
		for (let i = 0; i < n; i++) {
			const a = (i / n) * Math.PI * 2;
			pts.push(new Point(r * dcos(a), r * dsin(a)));
		}
		return new Polygon(pts);
	}

	static circle(r = 1.0) {
		return Polygon.regular(16, r);
	}
}
