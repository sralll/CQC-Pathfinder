// Cutter — port of com.watabou.towngenerator.building.Cutter.
// Geometric helpers for subdividing a block polygon into building lots.

import { Point } from './Point.js';
import { Polygon } from './Polygon.js';
import { GeomUtils } from './GeomUtils.js';
import { amin } from './arrays.js';
import { dcos, dsin } from './dmath.js';

export class Cutter {
	// Cut a polygon across the edge starting at `vertex`, at `ratio` along it, rotated by `angle`.
	static bisect(poly, vertex, ratio = 0.5, angle = 0.0, gap = 0.0) {
		const next = poly.next(vertex);

		const p1 = GeomUtils.interpolate(vertex, next, ratio);
		const d = next.subtract(vertex);

		const cosB = dcos(angle);
		const sinB = dsin(angle);
		const vx = d.x * cosB - d.y * sinB;
		const vy = d.y * cosB + d.x * sinB;
		const p2 = new Point(p1.x - vy, p1.y + vx);

		return poly.cut(p1, p2, gap);
	}

	static radial(poly, center = null, gap = 0.0) {
		if (center == null) center = poly.centroid;

		const sectors = [];
		poly.forEdge((v0, v1) => {
			let sector = new Polygon([center, v0, v1]);
			if (gap > 0) sector = sector.shrink([gap / 2, 0, gap / 2]);
			sectors.push(sector);
		});
		return sectors;
	}

	static semiRadial(poly, center = null, gap = 0.0) {
		if (center == null) {
			const centroid = poly.centroid;
			center = amin(poly, (v) => Point.distance(v, centroid));
		}

		gap /= 2;

		const sectors = [];
		poly.forEdge((v0, v1) => {
			if (v0 !== center && v1 !== center) {
				let sector = new Polygon([center, v0, v1]);
				if (gap > 0) {
					const d = [poly.findEdge(center, v0) === -1 ? gap : 0, 0, poly.findEdge(v1, center) === -1 ? gap : 0];
					sector = sector.shrink(d);
				}
				sectors.push(sector);
			}
		});
		return sectors;
	}

	static ring(poly, thickness) {
		const slices = [];
		poly.forEdge((v1, v2) => {
			const v = v2.subtract(v1);
			const n = v.rotate90().norm(thickness);
			slices.push({ p1: v1.add(n), p2: v2.add(n), len: v.length });
		});

		// Short sides should be sliced first
		slices.sort((s1, s2) => s1.len - s2.len);

		const peel = [];
		let p = poly;
		for (let i = 0; i < slices.length; i++) {
			const halves = p.cut(slices[i].p1, slices[i].p2);
			p = halves[0];
			if (halves.length === 2) peel.push(halves[1]);
		}

		return peel;
	}
}
