// features.js — shared collector for "removed-corner" map features.
//
// The chamfer steps that cut a triangle off a buildable area or a building lot leave a
// small gap behind. Instead of letting that gap read as empty, we drop a tiny landmark
// into it — a tree or a fountain (orienteering symbols: a green circle for a distinctive
// tree, a blue circle for a water feature). The generator collects these points and the
// renderer draws them as small green/blue circles.
//
// State is kept at module scope because the chamfer routines are deeply-nested pure
// functions; threading a collector argument through all of them would be invasive.
// Generation is synchronous and single-threaded, so a shared sink is safe. The kind is
// derived from the coordinates (no RNG call), so collecting features never advances the
// seeded random stream and the generated geometry stays bit-for-bit identical.

const _features = [];

export function clearFeatures() {
	_features.length = 0;
}

export function takeFeatures() {
	const out = _features.slice();
	_features.length = 0;
	return out;
}

// Deterministic tree/fountain split from position: roughly one in four removed corners
// becomes a fountain, the rest are trees. A coordinate hash keeps this independent of the
// seeded RNG so feature collection can't perturb generation.
export function featureKind(x, y) {
	const h = (Math.imul(Math.round(x * 16), 73856093) ^ Math.imul(Math.round(y * 16), 19349663)) >>> 0;
	return h % 4 === 0 ? 'fountain' : 'tree';
}

export function recordFeature(x, y, kind) {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return;
	_features.push({ x, y, kind: kind || featureKind(x, y) });
}

// Record a feature at the centroid of a removed corner triangle so the circle lands inside
// the chamfer gap (and thus inside the kept polygon), not out on the old sharp tip.
export function recordRemovedTriangle(a, b, c) {
	if (!a || !b || !c) return;
	recordFeature((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3);
}
