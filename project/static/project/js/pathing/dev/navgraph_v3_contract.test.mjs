// CR 8.1 — frozen typed-navgraph (v3) artifact + false-junction topology contract.
// Usage: node project/static/project/js/pathing/dev/navgraph_v3_contract.test.mjs
//
// This suite freezes the v3 `.navgraph.bin` contract (base/passage/transition
// topology + passage_revision) BEFORE production topology construction (CR 8.2)
// changes anything. It covers:
//   - binary round-trip for zero / one / multiple passages;
//   - strict rejection of corrupt length / kind / ordinal / range / revision data;
//   - passage-revision determinism (item-order independent; sensitive to
//     point / width / id / mask-dimension changes) and cross-language parity;
//   - the frozen false-junction fixture: a graph-level topology checker that
//     PASSES the correctly isolated typed graph (what CR 8.2 must produce) and
//     FAILS the old additive-overlay graph that leaves the base four-way junction.
//
// `writeV3` here is a deliberate line-by-line mirror of `_write_bin` in
// project/navgraph.py. If you change the byte layout, change both.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
	loadArtifact, SUPPORTED_VERSION, LEGACY_BASE_ONLY_VERSION,
	EDGE_KIND_BASE, EDGE_KIND_PASSAGE, EDGE_KIND_TRANSITION,
} from '../navgraph_router.js';
import { passageRevision } from '../navgraph_passage_overlay.js';

const NAVGRAPH_MAGIC = 'NVG1';

let passed = 0;
function test(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}
function throws(fn, re, name) {
	assert.throws(fn, re, name);
	passed++;
	console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// In-test v3 serializer — mirror of project/navgraph.py `_write_bin`.
// ---------------------------------------------------------------------------
function writeV3(f) {
	const version = f.version ?? SUPPORTED_VERSION;
	const {
		H, W, minCostPerPx = 14, coarseScale = 10, hitzoneScale = 10,
		nodes, edges, weights, components,
		edgeKinds, edgePassage, passageNodeStart, passageNodeCount,
		baseNodeCount, revision,
	} = f;
	const coarseOriginX = f.coarseOriginX ?? 0;
	const coarseOriginY = f.coarseOriginY ?? 0;
	const N = nodes.length / 2;
	const E = edges.length / 2;
	const P = passageNodeStart.length;
	const ch = f.ch ?? Math.max(1, Math.ceil(H / coarseScale));
	const cw = f.cw ?? Math.max(1, Math.ceil(W / coarseScale));
	const hh = f.hh ?? ch;
	const hw = f.hw ?? cw;
	const coarseMinval = f.coarseMinval ?? new Uint8Array(ch * cw).fill(241);
	const coarseClear = f.coarseClear ?? new Uint8Array(ch * cw).fill(20);
	const coarseLabels = f.coarseLabels ?? (version === SUPPORTED_VERSION
		? new Uint8Array(ch * cw).fill(1) : new Int32Array(ch * cw).fill(1));
	const coarseHitzone = f.coarseHitzone ?? new Uint8Array(hh * hw).fill(1);
	const isV3 = version === SUPPORTED_VERSION;
	const revBytes = isV3 ? new TextEncoder().encode(revision ?? '') : new Uint8Array(0);
	const headerEnd = isV3 ? 72 + revBytes.length : 52;

	const kindsBytes = isV3 ? E : 0;
	const edgePassageBytes = isV3 ? E * 4 : 0;
	const rangeBytes = isV3 ? P * 4 * 2 : 0;
	const total = headerEnd
		+ N * 2 * 4 + E * 2 * 4 + E * 4 + N * 4
		+ kindsBytes + edgePassageBytes + rangeBytes
		+ ch * cw + ch * cw + ch * cw * (isV3 ? 1 : 4) + hh * hw;

	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	for (let i = 0; i < 4; i++) buf[i] = NAVGRAPH_MAGIC.charCodeAt(i);
	dv.setUint32(4, version, true);
	dv.setInt32(8, H, true);
	dv.setInt32(12, W, true);
	dv.setFloat32(16, minCostPerPx, true);
	dv.setUint32(20, N, true);
	dv.setUint32(24, E, true);
	dv.setInt32(28, coarseScale, true);
	dv.setInt32(32, ch, true);
	dv.setInt32(36, cw, true);
	dv.setInt32(40, hitzoneScale, true);
	dv.setInt32(44, hh, true);
	dv.setInt32(48, hw, true);
	let off = 52;
	if (isV3) {
		dv.setUint32(52, baseNodeCount, true);
		dv.setUint32(56, P, true);
		dv.setUint32(60, revBytes.length, true);
		dv.setInt32(64, coarseOriginX, true);
		dv.setInt32(68, coarseOriginY, true);
		buf.set(revBytes, 72);
		off = 72 + revBytes.length;
	}
	const put = (arr, Ctor) => {
		const bytes = new Uint8Array(Ctor.from(arr).buffer);
		buf.set(bytes, off);
		off += bytes.length;
	};
	put(nodes, Int32Array);
	put(edges, Int32Array);
	put(weights, Float32Array);
	put(components, Int32Array);
	if (isV3) {
		put(edgeKinds, Uint8Array);
		put(edgePassage, Int32Array);
		put(passageNodeStart, Int32Array);
		put(passageNodeCount, Int32Array);
	}
	put(coarseMinval, Uint8Array);
	put(coarseClear, Uint8Array);
	put(coarseLabels, isV3 ? Uint8Array : Int32Array);
	put(coarseHitzone, Uint8Array);
	assert.equal(off, total, 'writer offset must reach computed total');
	return buf;
}

// A small helper to assemble a typed artifact spec from nodes + typed edges.
function specFrom({ W = 300, H = 220, baseNodes, passages }) {
	const nodes = [];
	for (const [x, y] of baseNodes) nodes.push(x, y);
	const passageNodeStart = [];
	const passageNodeCount = [];
	let idx = baseNodes.length;
	for (const p of passages) {
		passageNodeStart.push(idx);
		passageNodeCount.push(p.points.length);
		for (const [x, y] of p.points) nodes.push(x, y);
		idx += p.points.length;
	}
	const edges = [];
	const edgeKinds = [];
	const edgePassage = [];
	const addEdge = (u, v, kind, owner) => {
		edges.push(u, v);
		edgeKinds.push(kind);
		edgePassage.push(owner);
	};
	return {
		W, H,
		nodes: Int32Array.from(nodes),
		baseNodeCount: baseNodes.length,
		passageNodeStart: Int32Array.from(passageNodeStart),
		passageNodeCount: Int32Array.from(passageNodeCount),
		addEdge,
		_edges: edges, _edgeKinds: edgeKinds, _edgePassage: edgePassage,
		finish() {
			const E = edges.length / 2;
			const weights = new Float32Array(E);
			for (let e = 0; e < E; e++) {
				const u = edges[2 * e], v = edges[2 * e + 1];
				weights[e] = Math.hypot(nodes[2 * u] - nodes[2 * v], nodes[2 * u + 1] - nodes[2 * v + 1]) || 1;
			}
			return {
				W, H,
				nodes: Int32Array.from(nodes),
				edges: Int32Array.from(edges),
				weights,
				components: new Int32Array(nodes.length / 2).fill(1),
				edgeKinds: Uint8Array.from(edgeKinds),
				edgePassage: Int32Array.from(edgePassage),
				passageNodeStart: Int32Array.from(passageNodeStart),
				passageNodeCount: Int32Array.from(passageNodeCount),
				baseNodeCount: baseNodes.length,
				revision: passageRevision(null, W, H),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Typed-graph model + the frozen false-junction checker.
// ---------------------------------------------------------------------------
function typedGraph(art) {
	const adj = new Map();
	for (let n = 0; n < art.N; n++) adj.set(n, []);
	for (let e = 0; e < art.E; e++) {
		const u = art.edges[2 * e], v = art.edges[2 * e + 1];
		const kind = art.edgeKinds[e], owner = art.edgePassage[e];
		adj.get(u).push({ to: v, kind, owner });
		adj.get(v).push({ to: u, kind, owner });
	}
	const passageOf = new Int32Array(art.N).fill(-1);
	for (let p = 0; p < art.passageCount; p++) {
		const s = art.passageNodeStart[p], c = art.passageNodeCount[p];
		for (let n = s; n < s + c; n++) passageOf[n] = p;
	}
	const isEndpoint = (n) => {
		const p = passageOf[n];
		if (p < 0) return false;
		const s = art.passageNodeStart[p], c = art.passageNodeCount[p];
		return n === s || n === s + c - 1;
	};
	return { adj, passageOf, isEndpoint };
}

/** BFS reachability restricted to a set of allowed edge kinds. */
function reachable(g, start, goal, kinds) {
	const seen = new Set([start]);
	const stack = [start];
	while (stack.length) {
		const cur = stack.pop();
		if (cur === goal) return true;
		for (const e of g.adj.get(cur)) {
			if (!kinds.has(e.kind) || seen.has(e.to)) continue;
			seen.add(e.to);
			stack.push(e.to);
		}
	}
	return false;
}

/**
 * Return the list of false-junction violations for a parsed typed artifact.
 * Empty means the topology is correctly isolated (CR 8.2 target). The old
 * additive overlay, which keeps the base four-way junction, produces violations.
 */
function falseJunctionViolations(art) {
	const g = typedGraph(art);
	const v = [];
	// (a) No transition may touch a non-endpoint passage node.
	for (let e = 0; e < art.E; e++) {
		if (art.edgeKinds[e] !== EDGE_KIND_TRANSITION) continue;
		const u = art.edges[2 * e], w = art.edges[2 * e + 1];
		const pu = g.passageOf[u], pw = g.passageOf[w];
		// exactly one endpoint is a passage node, and it must be an endpoint
		const passageEnd = pu >= 0 ? u : (pw >= 0 ? w : -1);
		if (passageEnd < 0) v.push(`transition ${e} touches no passage node`);
		else if (!g.isEndpoint(passageEnd)) v.push(`transition ${e} lands mid-passage at node ${passageEnd}`);
	}
	// (b) No passage edge is a chord (must join consecutive same-passage nodes).
	for (let e = 0; e < art.E; e++) {
		if (art.edgeKinds[e] !== EDGE_KIND_PASSAGE) continue;
		const u = art.edges[2 * e], w = art.edges[2 * e + 1];
		if (g.passageOf[u] !== g.passageOf[w]) v.push(`passage edge ${e} crosses passages`);
		else if (Math.abs(u - w) !== 1) v.push(`passage edge ${e} is a chord (${u},${w})`);
	}
	// (c) Following base edges only, you must never enter a passage node
	//     (a base router cannot turn onto the passage at the projected crossing).
	for (let n = 0; n < art.baseNodeCount; n++) {
		const seen = new Set([n]);
		const stack = [n];
		while (stack.length) {
			const cur = stack.pop();
			for (const e of g.adj.get(cur)) {
				if (e.kind !== EDGE_KIND_BASE || seen.has(e.to)) continue;
				if (g.passageOf[e.to] >= 0) { v.push(`base walk from ${n} entered passage node ${e.to}`); break; }
				seen.add(e.to);
				stack.push(e.to);
			}
		}
	}
	return v;
}

// ---------------------------------------------------------------------------
// 1. Round-trip: zero / one / multiple passages.
// ---------------------------------------------------------------------------
test('round-trip: zero passages (base-only v3)', () => {
	const s = specFrom({ baseNodes: [[50, 100], [250, 100]], passages: [] });
	s.addEdge(0, 1, EDGE_KIND_BASE, -1);
	const art = loadArtifact(writeV3({
		...s.finish(), coarseOriginX: 20, coarseOriginY: 30,
	}));
	assert.equal(art.version, SUPPORTED_VERSION);
	assert.equal(art.N, 2);
	assert.equal(art.baseNodeCount, 2);
	assert.equal(art.passageCount, 0);
	assert.equal(art.passageRevision, passageRevision(null, 300, 220));
	assert.equal(art.edgeKinds[0], EDGE_KIND_BASE);
	assert.equal(art.edgePassage[0], -1);
	assert.equal(art.coarseOriginX, 20);
	assert.equal(art.coarseOriginY, 30);
});

test('round-trip: one passage (3-point chain + endpoint transitions)', () => {
	const s = specFrom({
		baseNodes: [[50, 20], [250, 20], [50, 200], [250, 200]],
		passages: [{ points: [[150, 40], [150, 110], [150, 180]] }],
	});
	// base ring
	s.addEdge(0, 1, EDGE_KIND_BASE, -1);
	s.addEdge(2, 3, EDGE_KIND_BASE, -1);
	s.addEdge(0, 2, EDGE_KIND_BASE, -1);
	s.addEdge(1, 3, EDGE_KIND_BASE, -1);
	// passage chain nodes 4,5,6
	s.addEdge(4, 5, EDGE_KIND_PASSAGE, 0);
	s.addEdge(5, 6, EDGE_KIND_PASSAGE, 0);
	// transitions at endpoints only
	s.addEdge(0, 4, EDGE_KIND_TRANSITION, 0);
	s.addEdge(6, 2, EDGE_KIND_TRANSITION, 0);
	const art = loadArtifact(writeV3(s.finish()));
	assert.equal(art.N, 7);
	assert.equal(art.baseNodeCount, 4);
	assert.equal(art.passageCount, 1);
	assert.deepEqual(Array.from(art.passageNodeStart), [4]);
	assert.deepEqual(Array.from(art.passageNodeCount), [3]);
	assert.deepEqual(falseJunctionViolations(art), []);
});

test('round-trip: multiple (overlapping independent) passages', () => {
	const s = specFrom({
		baseNodes: [[50, 20], [250, 20], [50, 200], [250, 200]],
		passages: [
			{ points: [[150, 40], [150, 180]] },            // vertical, nodes 4,5
			{ points: [[40, 110], [150, 110], [260, 110]] }, // horizontal, nodes 6,7,8
		],
	});
	s.addEdge(0, 1, EDGE_KIND_BASE, -1);
	s.addEdge(2, 3, EDGE_KIND_BASE, -1);
	// passage 0 chain (2 points → 1 undirected edge)
	s.addEdge(4, 5, EDGE_KIND_PASSAGE, 0);
	s.addEdge(0, 4, EDGE_KIND_TRANSITION, 0);
	s.addEdge(2, 5, EDGE_KIND_TRANSITION, 0);
	// passage 1 chain
	s.addEdge(6, 7, EDGE_KIND_PASSAGE, 1);
	s.addEdge(7, 8, EDGE_KIND_PASSAGE, 1);
	s.addEdge(0, 6, EDGE_KIND_TRANSITION, 1);
	s.addEdge(1, 8, EDGE_KIND_TRANSITION, 1);
	const art = loadArtifact(writeV3(s.finish()));
	assert.equal(art.passageCount, 2);
	assert.deepEqual(Array.from(art.passageNodeStart), [4, 6]);
	assert.deepEqual(Array.from(art.passageNodeCount), [2, 3]);
	assert.deepEqual(falseJunctionViolations(art), []);

	// passages overlap geometrically (both pass through (150,110)) yet no edge
	// joins a node of passage 0 to a node of passage 1.
	const g = typedGraph(art);
	for (let e = 0; e < art.E; e++) {
		const u = art.edges[2 * e], w = art.edges[2 * e + 1];
		const pu = g.passageOf[u], pw = g.passageOf[w];
		assert.ok(!(pu >= 0 && pw >= 0 && pu !== pw), 'no cross-passage edge');
	}
});

// ---------------------------------------------------------------------------
// 2. Frozen false-junction fixture: correct isolation vs old additive overlay.
// ---------------------------------------------------------------------------
function underpassCrossingSpec({ falseJunction }) {
	// Horizontal base underpass geometrically passes through the crossing (150,100);
	// a vertical passage crosses it. Correct topology: base A–C edge (through the
	// crossing) has NO node there; passage chain is separate; transitions only at
	// the two passage endpoints. The old additive overlay leaves a base node at the
	// crossing wired both into the base underpass and to the passage — the false
	// four-way junction — which `falseJunction` reproduces.
	const baseNodes = [
		[50, 100],   // 0 base-left
		[250, 100],  // 1 base-right
		[150, 30],   // 2 base-top (transition anchor)
		[150, 170],  // 3 base-bottom (transition anchor)
	];
	const passages = [{ points: [[150, 45], [150, 100], [150, 155]] }]; // nodes 4,5,6 (5 == crossing)
	if (falseJunction) baseNodes.push([150, 100]); // 4? no — pushed as base node 4, passages shift
	const s = specFrom({ baseNodes, passages });
	// base underpass left↔right passing through the crossing
	s.addEdge(0, 1, EDGE_KIND_BASE, -1);
	const pStart = baseNodes.length; // first passage node index
	// passage chain
	s.addEdge(pStart, pStart + 1, EDGE_KIND_PASSAGE, 0);
	s.addEdge(pStart + 1, pStart + 2, EDGE_KIND_PASSAGE, 0);
	// transitions at endpoints only
	s.addEdge(2, pStart, EDGE_KIND_TRANSITION, 0);
	s.addEdge(3, pStart + 2, EDGE_KIND_TRANSITION, 0);
	if (falseJunction) {
		// The old base-only graph kept its node at the crossing wired into the
		// underpass AND longitudinally up/down the bridge projection — the false
		// four-way junction. Modelled as an extra base node at the crossing with a
		// base edge turning into the corridor (base topology reaching a passage
		// node), so a base router can traverse the passage projection.
		const crossing = 4; // the pushed base node
		s.addEdge(0, crossing, EDGE_KIND_BASE, -1);
		s.addEdge(crossing, 1, EDGE_KIND_BASE, -1);
		s.addEdge(crossing, pStart + 1, EDGE_KIND_BASE, -1); // illegal turn onto the passage body
	}
	return s.finish();
}

test('false-junction fixture: correct isolation passes all invariants', () => {
	const art = loadArtifact(writeV3(underpassCrossingSpec({ falseJunction: false })));
	const g = typedGraph(art);
	const base = new Set([EDGE_KIND_BASE]);
	const passage = new Set([EDGE_KIND_PASSAGE]);
	const pStart = art.baseNodeCount; // 4
	// base-left → base-right via underpass
	assert.ok(reachable(g, 0, 1, base), 'base-left reaches base-right');
	// passage-start → passage-end via chain
	assert.ok(reachable(g, pStart, pStart + 2, passage), 'passage chain connects endpoints');
	// two-point direction check would use a 2-node passage; here the multi-point
	// chain visits nodes in order and cannot skip the middle:
	const midNbrs = g.adj.get(pStart + 1).filter((e) => e.kind === EDGE_KIND_PASSAGE);
	assert.equal(midNbrs.length, 2, 'intermediate passage node has same-passage degree 2');
	// passage-start cannot leave into base at the projected middle (node pStart+1
	// has no base/transition edge):
	const midAll = g.adj.get(pStart + 1);
	assert.ok(midAll.every((e) => e.kind === EDGE_KIND_PASSAGE), 'projected-middle node is passage-only');
	// the umbrella checker is clean
	assert.deepEqual(falseJunctionViolations(art), []);
});

test('false-junction fixture: old additive overlay graph is REJECTED by the checker', () => {
	const art = loadArtifact(writeV3(underpassCrossingSpec({ falseJunction: true })));
	const violations = falseJunctionViolations(art);
	assert.ok(violations.length > 0, 'the false four-way junction must be detected');
	// A base-only walk can now turn off the underpass and traverse the passage
	// projection — exactly the reported bridge bug.
	assert.ok(violations.some((m) => m.includes('base walk')), `expected base-turn violation: ${violations}`);
});

test('two-point passage is traversable in both directions', () => {
	const s = specFrom({
		baseNodes: [[50, 50], [50, 200]],
		passages: [{ points: [[150, 60], [150, 190]] }],
	});
	s.addEdge(0, 2, EDGE_KIND_TRANSITION, 0);
	s.addEdge(1, 3, EDGE_KIND_TRANSITION, 0);
	s.addEdge(2, 3, EDGE_KIND_PASSAGE, 0);
	const art = loadArtifact(writeV3(s.finish()));
	const g = typedGraph(art);
	const passage = new Set([EDGE_KIND_PASSAGE]);
	assert.ok(reachable(g, 2, 3, passage), 'start→end');
	assert.ok(reachable(g, 3, 2, passage), 'end→start');
	assert.deepEqual(falseJunctionViolations(art), []);
});

// ---------------------------------------------------------------------------
// 3. Corruption / bounds rejection.
// ---------------------------------------------------------------------------
function baseOneEdge() {
	const s = specFrom({ baseNodes: [[50, 100], [250, 100]], passages: [] });
	s.addEdge(0, 1, EDGE_KIND_BASE, -1);
	return s.finish();
}

throws(() => loadArtifact(new Uint8Array(10)), /too small/, 'reject: truncated header');
throws(() => {
	const buf = writeV3(baseOneEdge());
	buf[0] = 0x58; // corrupt magic
	loadArtifact(buf);
}, /bad magic/, 'reject: bad magic');
throws(() => {
	const buf = writeV3(baseOneEdge());
	new DataView(buf.buffer).setUint32(4, 99, true); // unknown version
	loadArtifact(buf);
}, /unsupported navgraph version/, 'reject: unknown version');
throws(() => {
	const buf = writeV3(baseOneEdge());
	loadArtifact(buf.subarray(0, buf.length - 4)); // drop trailing bytes
}, /byte length/, 'reject: truncated body (length mismatch)');
throws(() => {
	const good = writeV3(baseOneEdge());
	const buf = new Uint8Array(good.length + 8); // trailing garbage
	buf.set(good, 0);
	loadArtifact(buf);
}, /byte length/, 'reject: overlong body (length mismatch)');
throws(() => {
	const s = specFrom({
		baseNodes: [[50, 20], [250, 20]],
		passages: [{ points: [[150, 40], [150, 180]] }],
	});
	s.addEdge(2, 3, EDGE_KIND_PASSAGE, 0);
	const f = s.finish();
	f.edgeKinds = Uint8Array.from([7]); // unknown kind
	loadArtifact(writeV3(f));
}, /unknown kind/, 'reject: unknown edge kind');
throws(() => {
	const s = specFrom({
		baseNodes: [[50, 20], [250, 20]],
		passages: [{ points: [[150, 40], [150, 180]] }],
	});
	s.addEdge(0, 1, EDGE_KIND_BASE, 0); // base edge must own -1
	s.addEdge(2, 3, EDGE_KIND_PASSAGE, 0);
	loadArtifact(writeV3(s.finish()));
}, /base edge .* -1/, 'reject: base edge with a passage ordinal');
throws(() => {
	const s = specFrom({
		baseNodes: [[50, 20], [250, 20]],
		passages: [{ points: [[150, 40], [150, 180]] }],
	});
	s.addEdge(2, 3, EDGE_KIND_PASSAGE, 5); // owner out of range (P=1)
	loadArtifact(writeV3(s.finish()));
}, /owner .* out of range/, 'reject: passage edge owner out of range');
throws(() => {
	const s = specFrom({
		baseNodes: [[50, 20], [250, 20]],
		passages: [{ points: [[150, 40], [150, 180]] }],
	});
	s.addEdge(2, 3, EDGE_KIND_PASSAGE, 0);
	const f = s.finish();
	f.passageNodeStart = Int32Array.from([3]); // should be 2 (== baseNodeCount)
	loadArtifact(writeV3(f));
}, /not contiguous/, 'reject: non-contiguous passage node range');
throws(() => {
	const s = specFrom({
		baseNodes: [[50, 20], [250, 20]],
		passages: [{ points: [[150, 40], [150, 180]] }],
	});
	s.addEdge(2, 3, EDGE_KIND_PASSAGE, 0);
	const f = s.finish();
	f.edges = Int32Array.from([2, 99]); // endpoint out of range
	loadArtifact(writeV3(f));
}, /endpoint out of range/, 'reject: edge endpoint out of range');
throws(() => {
	const f = baseOneEdge();
	f.revision = 'x'.repeat(300); // exceeds NAVGRAPH_REVISION_MAX_LEN
	loadArtifact(writeV3(f));
}, /invalid revision length|revision string overruns/, 'reject: over-long revision string');

// ---------------------------------------------------------------------------
// 4. Legacy v2 (base-only) still parses; reports zero passages, null revision.
// ---------------------------------------------------------------------------
test('legacy v2 base-only artifact parses as zero passages', () => {
	const s = specFrom({ baseNodes: [[50, 100], [250, 100]], passages: [] });
	s.addEdge(0, 1, EDGE_KIND_BASE, -1);
	const f = s.finish();
	f.version = LEGACY_BASE_ONLY_VERSION;
	const art = loadArtifact(writeV3(f));
	assert.equal(art.version, LEGACY_BASE_ONLY_VERSION);
	assert.equal(art.baseNodeCount, art.N);
	assert.equal(art.passageCount, 0);
	assert.equal(art.passageRevision, null);
	assert.equal(art.edgeKinds, null);
});

// ---------------------------------------------------------------------------
// 5. passage_revision: determinism, sensitivity, cross-language parity.
// ---------------------------------------------------------------------------
test('passage_revision is item-order independent', () => {
	const a = { version: 1, items: [
		{ id: 'bbb', points: [[1, 2], [3, 4]], width: 10 },
		{ id: 'aaa', points: [[5, 6], [7, 8]], width: 12 },
	] };
	const b = { version: 1, items: [a.items[1], a.items[0]] };
	assert.equal(passageRevision(a, 800, 600), passageRevision(b, 800, 600));
});

test('passage_revision changes for point / width / id / mask-dimension changes', () => {
	const base = { version: 1, items: [{ id: 'aaa', points: [[1, 2], [3, 4]], width: 10 }] };
	const r = passageRevision(base, 800, 600);
	const point = { version: 1, items: [{ id: 'aaa', points: [[1, 2], [3, 5]], width: 10 }] };
	const width = { version: 1, items: [{ id: 'aaa', points: [[1, 2], [3, 4]], width: 11 }] };
	const id = { version: 1, items: [{ id: 'aab', points: [[1, 2], [3, 4]], width: 10 }] };
	assert.notEqual(passageRevision(point, 800, 600), r);
	assert.notEqual(passageRevision(width, 800, 600), r);
	assert.notEqual(passageRevision(id, 800, 600), r);
	assert.notEqual(passageRevision(base, 801, 600), r);
	assert.notEqual(passageRevision(base, 800, 601), r);
});

test('passage_revision matches project/navgraph.py (cross-language pin)', () => {
	// These literals are produced by project/navgraph.py passage_revision() for
	// the identical document; the twin Python test asserts the same strings.
	const doc = { version: 1, items: [
		{ id: '8cb8a384-c073-4a4d-9dce-b67e2c6de101', points: [[1420.5, 830.0], [1460.0, 845.5], [1510.0, 870.0]], width: 24.0 },
		{ id: '0aaa1111-2222-3333-4444-555566667777', points: [[10, 20], [30.25, 40]], width: 12 },
	] };
	assert.equal(passageRevision(doc, 2000, 1500), 'p1-338caebeb32575fa');
	assert.equal(passageRevision(null, 2000, 1500), 'p1-7b79b8b7dc80d52b');
});

// ---------------------------------------------------------------------------
// 6. Frozen real-map fixture (top-left bridge). CR 8.1 freezes the mask, region,
//    and invariant checklist; the live topology assertions are CR 8.2 / CR 8.5.
// ---------------------------------------------------------------------------
test('real-map fixture (top-left bridge) is frozen and references a present mask', () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(here, '..', '..', '..', '..', '..', '..');
	const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'top_left_bridge.fixture.json'), 'utf8'));
	assert.equal(fixture.mask, 'media/masks/mask_20250604_135955.png');
	assert.ok(existsSync(join(repoRoot, fixture.mask)), 'referenced real mask must exist in the repo');
	assert.deepEqual(fixture.mask_shape, [1674, 2739]);
	// The passage document and live builder assertions are deferred to CR 8.2.
	assert.equal(fixture.passage_document, null, 'passage document is authored in CR 8.2');
	// Freeze the invariant checklist so CR 8.2/8.5 cannot silently drop one.
	assert.equal(fixture.frozen_invariants.length, 8);
	assert.ok(fixture.frozen_invariants.some((s) => s.includes('one continuous typed passage chain')));
	assert.ok(fixture.frozen_invariants.some((s) => s.includes('transitions only at the two saved passage endpoint')));
	assert.ok(fixture.frozen_invariants.some((s) => s.includes('base walk never enters a passage node')));
});

console.log(`\nnavgraph_v3_contract: ${passed} checks passed`);
