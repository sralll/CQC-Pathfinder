// Noise.js — fractal (fBm) noise for the wavy coastline.
//
// The reference builds the coast perturbation with `pg.fractal(6)`: 6 octaves of Perlin, gridSize
// 1,2,4,… and amplitude 1, 0.5, 0.25, … summed. We use value-noise octaves with the same
// gridSize/amplitude schedule (a faithful-in-mechanism stand-in for Perlin — the coast SHAPE is
// the circle+channel below; this just waves its edge). Each octave is seeded from the PRNG.

function hash(ix, iy, seed) {
	let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (seed | 0) * 1274126177;
	h = (h ^ (h >>> 13)) >>> 0;
	h = (h * 1274126177) >>> 0;
	h = (h ^ (h >>> 16)) >>> 0;
	return h / 4294967295; // [0,1]
}

function valueNoise(x, y, seed) {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const fx = x - ix;
	const fy = y - iy;
	const u = fx * fx * (3 - 2 * fx);
	const v = fy * fy * (3 - 2 * fy);
	const a = hash(ix, iy, seed);
	const b = hash(ix + 1, iy, seed);
	const c = hash(ix, iy + 1, seed);
	const d = hash(ix + 1, iy + 1, seed);
	return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v; // [0,1]
}

// octaves: number of octaves; rng: () => [0,1) (used to seed each octave). Returns { get(x,y) }
// summing octaves of value noise mapped to ~[-1,1] per octave (matching the reference's summed,
// non-normalised Perlin output magnitude).
export function makeFractal(octaves, rng) {
	const comps = [];
	let gridSize = 1;
	let amplitude = 1;
	for (let i = 0; i < octaves; i++) {
		comps.push({ seed: Math.floor(rng() * 1e6), gridSize, amplitude });
		gridSize *= 2;
		amplitude *= 0.5;
	}
	return {
		get(x, y) {
			let s = 0;
			for (const c of comps) s += c.amplitude * (valueNoise(x * c.gridSize, y * c.gridSize, c.seed) * 2 - 1);
			return s;
		},
	};
}
