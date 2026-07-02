// GeomUtils — port of com.watabou.geom.GeomUtils.

import { Point } from './Point.js';

export class GeomUtils {
	static intersectLines(x1, y1, dx1, dy1, x2, y2, dx2, dy2) {
		const d = dx1 * dy2 - dy1 * dx2;
		if (d === 0)
			return null;

		const t2 = (dy1 * (x2 - x1) - dx1 * (y2 - y1)) / d;
		const t1 = dx1 !== 0 ?
			(x2 - x1 + dx2 * t2) / dx1 :
			(y2 - y1 + dy2 * t2) / dy1;

		return new Point(t1, t2);
	}

	static interpolate(p1, p2, ratio = 0.5) {
		const d = p2.subtract(p1);
		return new Point(p1.x + d.x * ratio, p1.y + d.y * ratio);
	}

	static scalar(x1, y1, x2, y2) {
		return x1 * x2 + y1 * y2;
	}

	static cross(x1, y1, x2, y2) {
		return x1 * y2 - y1 * x2;
	}

	static distance2line(x1, y1, dx1, dy1, x0, y0) {
		return (dx1 * y0 - dy1 * x0 + (y1 + dy1) * x1 - (x1 + dx1) * y1) / Math.sqrt(dx1 * dx1 + dy1 * dy1);
	}
}
