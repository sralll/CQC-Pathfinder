// Voronoi — port of com.watabou.geom.Voronoi (incremental Bowyer–Watson Delaunay,
// dual taken as Voronoi regions).
//
// IDENTITY CONTRACT (see plan): each Triangle owns a single circumcenter Point `c`.
// A Triangle that is shared between two adjacent regions contributes the SAME `c`
// instance to both region polygons. Patch.fromRegion uses `tr.c`, so adjacent patches
// end up sharing vertex Point instances on their common edge. Everything downstream
// (edge matching, junction merge, topology graph) depends on this. Never clone `c`.

import { Point } from './Point.js';
import { MathUtils } from './MathUtils.js';
import { remove as arrRemove } from './arrays.js';

export class Triangle {
	constructor(p1, p2, p3) {
		const s =
			(p2.x - p1.x) * (p2.y + p1.y) +
			(p3.x - p2.x) * (p3.y + p2.y) +
			(p1.x - p3.x) * (p1.y + p3.y);
		this.p1 = p1;
		// CCW ordering
		this.p2 = s > 0 ? p2 : p3;
		this.p3 = s > 0 ? p3 : p2;

		// circumcenter — computed from the ORIGINAL parameter order (p1,p2,p3), as in Haxe
		const x1 = (p1.x + p2.x) / 2;
		const y1 = (p1.y + p2.y) / 2;
		const x2 = (p2.x + p3.x) / 2;
		const y2 = (p2.y + p3.y) / 2;

		const dx1 = p1.y - p2.y;
		const dy1 = p2.x - p1.x;
		const dx2 = p2.y - p3.y;
		const dy2 = p3.x - p2.x;

		const tg1 = dy1 / dx1;
		const t2 = (y1 - y2 - (x1 - x2) * tg1) / (dy2 - dx2 * tg1);

		this.c = new Point(x2 + dx2 * t2, y2 + dy2 * t2);
		this.r = Point.distance(this.c, p1);
	}

	hasEdge(a, b) {
		return (
			(this.p1 === a && this.p2 === b) ||
			(this.p2 === a && this.p3 === b) ||
			(this.p3 === a && this.p1 === b)
		);
	}
}

export class Region {
	constructor(seed) {
		this.seed = seed;
		this.vertices = []; // Array<Triangle>
	}

	sortVertices() {
		this.vertices.sort((a, b) => this._compareAngles(a, b));
		return this;
	}

	center() {
		const c = new Point();
		for (const v of this.vertices) c.addEq(v.c);
		c.scaleEq(1 / this.vertices.length);
		return c;
	}

	borders(r) {
		const len1 = this.vertices.length;
		const len2 = r.vertices.length;
		for (let i = 0; i < len1; i++) {
			const j = r.vertices.indexOf(this.vertices[i]);
			if (j !== -1) return this.vertices[(i + 1) % len1] === r.vertices[(j + len2 - 1) % len2];
		}
		return false;
	}

	_compareAngles(v1, v2) {
		const x1 = v1.c.x - this.seed.x;
		const y1 = v1.c.y - this.seed.y;
		const x2 = v2.c.x - this.seed.x;
		const y2 = v2.c.y - this.seed.y;

		if (x1 >= 0 && x2 < 0) return 1;
		if (x2 >= 0 && x1 < 0) return -1;
		if (x1 === 0 && x2 === 0) return y2 > y1 ? 1 : -1;

		return MathUtils.sign(x2 * y1 - x1 * y2);
	}
}

export class Voronoi {
	constructor(minx, miny, maxx, maxy) {
		this.triangles = [];

		const c1 = new Point(minx, miny);
		const c2 = new Point(minx, maxy);
		const c3 = new Point(maxx, miny);
		const c4 = new Point(maxx, maxy);
		this.frame = [c1, c2, c3, c4];
		this.points = [c1, c2, c3, c4];
		this.triangles.push(new Triangle(c1, c2, c3));
		this.triangles.push(new Triangle(c2, c3, c4));

		this._regions = new Map();
		for (const p of this.points) this._regions.set(p, this.buildRegion(p));
		this._regionsDirty = false;
	}

	addPoint(p) {
		const toSplit = [];
		for (const tr of this.triangles) if (Point.distance(p, tr.c) < tr.r) toSplit.push(tr);

		if (toSplit.length > 0) {
			this.points.push(p);

			const a = [];
			const b = [];
			for (const t1 of toSplit) {
				let e1 = true;
				let e2 = true;
				let e3 = true;
				for (const t2 of toSplit) {
					if (t2 !== t1) {
						// A shared edge runs in opposite directions in the two triangles.
						if (e1 && t2.hasEdge(t1.p2, t1.p1)) e1 = false;
						if (e2 && t2.hasEdge(t1.p3, t1.p2)) e2 = false;
						if (e3 && t2.hasEdge(t1.p1, t1.p3)) e3 = false;
						if (!(e1 || e2 || e3)) break;
					}
				}
				if (e1) {
					a.push(t1.p1);
					b.push(t1.p2);
				}
				if (e2) {
					a.push(t1.p2);
					b.push(t1.p3);
				}
				if (e3) {
					a.push(t1.p3);
					b.push(t1.p1);
				}
			}

			let index = 0;
			do {
				this.triangles.push(new Triangle(p, a[index], b[index]));
				index = a.indexOf(b[index]);
			} while (index !== 0);

			for (const tr of toSplit) arrRemove(this.triangles, tr);

			this._regionsDirty = true;
		}
	}

	buildRegion(p) {
		const r = new Region(p);
		for (const tr of this.triangles) if (tr.p1 === p || tr.p2 === p || tr.p3 === p) r.vertices.push(tr);
		return r.sortVertices();
	}

	get regions() {
		if (this._regionsDirty) {
			this._regions = new Map();
			this._regionsDirty = false;
			for (const p of this.points) this._regions.set(p, this.buildRegion(p));
		}
		return this._regions;
	}

	isReal(tr) {
		return !(this.frame.indexOf(tr.p1) !== -1 || this.frame.indexOf(tr.p2) !== -1 || this.frame.indexOf(tr.p3) !== -1);
	}

	triangulation() {
		return this.triangles.filter((tr) => this.isReal(tr));
	}

	partioning() {
		// Iterate over points (not the map) to honor point ordering.
		const result = [];
		const regions = this.regions;
		for (const p of this.points) {
			const r = regions.get(p);
			let isReal = true;
			for (const v of r.vertices)
				if (!this.isReal(v)) {
					isReal = false;
					break;
				}
			if (isReal) result.push(r);
		}
		return result;
	}

	getNeighbours(r1) {
		const out = [];
		for (const r2 of this.regions.values()) if (r1.borders(r2)) out.push(r2);
		return out;
	}

	static relax(voronoi, toRelax = null) {
		const regions = voronoi.partioning();

		const points = voronoi.points.slice();
		for (const p of voronoi.frame) arrRemove(points, p);

		if (toRelax == null) toRelax = voronoi.points;
		for (const r of regions)
			if (toRelax.indexOf(r.seed) !== -1) {
				arrRemove(points, r.seed);
				points.push(r.center());
			}

		return Voronoi.build(points);
	}

	static build(vertices) {
		let minx = 1e10;
		let miny = 1e10;
		let maxx = -1e9;
		let maxy = -1e9;
		for (const v of vertices) {
			if (v.x < minx) minx = v.x;
			if (v.y < miny) miny = v.y;
			if (v.x > maxx) maxx = v.x;
			if (v.y > maxy) maxy = v.y;
		}
		const dx = (maxx - minx) * 0.5;
		const dy = (maxy - miny) * 0.5;

		const voronoi = new Voronoi(minx - dx / 2, miny - dy / 2, maxx + dx / 2, maxy + dy / 2);
		for (const v of vertices) voronoi.addPoint(v);

		return voronoi;
	}
}
