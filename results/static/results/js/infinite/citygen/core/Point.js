// Point — port of openfl.geom.Point + com.watabou.utils.PointExtender.
//
// IMPORTANT (see plan, "Point identity is load-bearing"): the whole generator
// relies on adjacent patches SHARING the same Point instance. Methods that return
// a "new" Point (add/subtract/scale/clone/norm/rotate90) must create fresh objects,
// while the *Eq / set / setTo / offset / normalize variants MUTATE in place.
// Do not change which methods mutate vs. return — callers depend on it.

import { datan2 } from './dmath.js';

export class Point {
	constructor(x = 0, y = 0) {
		this.x = x;
		this.y = y;
	}

	// openfl: length is a getter (distance from origin)
	get length() {
		return Math.sqrt(this.x * this.x + this.y * this.y);
	}

	static distance(a, b) {
		const dx = a.x - b.x;
		const dy = a.y - b.y;
		return Math.sqrt(dx * dx + dy * dy);
	}

	clone() {
		return new Point(this.x, this.y);
	}

	// --- returning new Point (openfl) ---
	add(q) {
		return new Point(this.x + q.x, this.y + q.y);
	}

	subtract(q) {
		return new Point(this.x - q.x, this.y - q.y);
	}

	// --- mutating in place (openfl) ---
	normalize(thickness = 1) {
		const len = this.length;
		if (len !== 0) {
			const norm = thickness / len;
			this.x *= norm;
			this.y *= norm;
		}
	}

	offset(dx, dy) {
		this.x += dx;
		this.y += dy;
	}

	setTo(x, y) {
		this.x = x;
		this.y = y;
	}

	// --- PointExtender (used via `using`, so called as instance methods) ---
	set(q) {
		this.x = q.x;
		this.y = q.y;
	}

	scale(f) {
		return new Point(this.x * f, this.y * f);
	}

	// norm: clone, then normalize -> returns a fresh Point; `this` is unchanged
	norm(length = 1) {
		const p = this.clone();
		p.normalize(length);
		return p;
	}

	addEq(q) {
		this.x += q.x;
		this.y += q.y;
	}

	subEq(q) {
		this.x -= q.x;
		this.y -= q.y;
	}

	scaleEq(f) {
		this.x *= f;
		this.y *= f;
	}

	atan() {
		return datan2(this.y, this.x);
	}

	dot(q) {
		return this.x * q.x + this.y * q.y;
	}

	rotate90() {
		return new Point(-this.y, this.x);
	}
}
