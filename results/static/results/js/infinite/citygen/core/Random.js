// Random — port of com.watabou.utils.Random.
// Lehmer / Park-Miller LCG. Must stay bit-exact with the Haxe original:
// seed*g is < 2^53 so it is exact in JS doubles — use Math.trunc (Haxe Std.int
// truncates toward zero), NOT bitwise ops which would wrap to 32 bits.

const g = 48271.0;
const n = 2147483647;

let seed = 1;

export class Random {
	static reset(seed_ = -1) {
		seed = (seed_ !== -1 ? seed_ : Math.trunc(Date.now() % n));
	}

	static getSeed() {
		return seed;
	}

	static next() {
		return (seed = Math.trunc((seed * g) % n));
	}

	static float() {
		return Random.next() / n;
	}

	static normal() {
		return (Random.float() + Random.float() + Random.float()) / 3;
	}

	static int(min, max) {
		return Math.trunc(min + Random.next() / n * (max - min));
	}

	static bool(chance = 0.5) {
		return Random.float() < chance;
	}

	static fuzzy(f = 1.0) {
		return f === 0 ?
			0.5 :
			(1 - f) / 2 + f * Random.normal();
	}
}
