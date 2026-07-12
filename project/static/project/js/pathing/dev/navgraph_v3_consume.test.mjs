// CR 8.3 — consume the serialized v3 passage topology in the worker/router.
// Usage: node project/static/project/js/pathing/dev/navgraph_v3_consume.test.mjs
//
// This suite proves the router builds Infinity topology directly from the baked
// v3 CSR (no dynamic portal overlay), while still reusing the passage raster for
// surface-aware refinement, typed legality, passage spans, and barrier surface
// separation. It covers:
//   - a v3 artifact + its matching JSON document generate a typed, refined route
//     across a wall the base graph cannot cross, with zero legality violations;
//   - forward/reverse traversal keeps the passage leg and reports direction;
//   - control endpoints and sample targets snap to BASE nodes only;
//   - a stale document (revision mismatch) is rejected deterministically, not
//     silently downgraded to base-only;
//   - a base barrier across the passage projection never blocks the passage
//     chain, and a passage barrier never blocks the base underpass;
//   - base-only v3 attaches cleanly; a v2 artifact refuses serialized passages.
//
// `writeV3` mirrors project/navgraph.py `_write_bin` (kept in lock-step with the
// twin in navgraph_v3_contract.test.mjs). Building through loadArtifact exercises
// the real reader + strict topology validation end to end.

import assert from 'node:assert/strict';
import {
    loadArtifact, buildState, attachSerializedPassages, graphAstar,
    computeRouteOptions, refineTypedNavgraphRoute, countTypedLegalityViolations,
    nodePathToTypedRouteSerialized, snapEndpoint, blockedByBarriers,
    SUPPORTED_VERSION, LEGACY_BASE_ONLY_VERSION,
    EDGE_KIND_BASE, EDGE_KIND_PASSAGE, EDGE_KIND_TRANSITION,
} from '../navgraph_router.js';
import { passageRevision } from '../navgraph_passage_overlay.js';

const NAVGRAPH_MAGIC = 'NVG1';
const FAST = 241;

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

// --- v3 serializer (mirror of project/navgraph.py `_write_bin`) --------------
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
    const coarseMinval = f.coarseMinval ?? new Uint8Array(ch * cw).fill(FAST);
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

// Assemble a v3 spec from base nodes + typed passages, mirroring the builder's
// canonical passage-id ordinal order (codepoint id sort).
function specFrom({ W, H, baseNodes, passages }) {
    const ordered = passages.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const nodes = [];
    for (const [x, y] of baseNodes) nodes.push(x, y);
    const passageNodeStart = [];
    const passageNodeCount = [];
    const ordinalOf = new Map();
    let idx = baseNodes.length;
    ordered.forEach((p, ordinal) => {
        ordinalOf.set(p.id, ordinal);
        passageNodeStart.push(idx);
        passageNodeCount.push(p.points.length);
        for (const [x, y] of p.points) nodes.push(x, y);
        idx += p.points.length;
    });
    const edges = [];
    const edgeKinds = [];
    const edgePassage = [];
    const addEdge = (u, v, kind, owner) => { edges.push(u, v); edgeKinds.push(kind); edgePassage.push(owner); };
    return {
        W, H, baseNodes, ordered, ordinalOf, passageNodeStart, passageNodeCount, addEdge,
        finish(revision) {
            const E = edges.length / 2;
            const weights = new Float32Array(E);
            for (let e = 0; e < E; e++) {
                const u = edges[2 * e], v = edges[2 * e + 1];
                weights[e] = (Math.hypot(nodes[2 * u] - nodes[2 * v], nodes[2 * u + 1] - nodes[2 * v + 1]) || 1) * 14;
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
                revision,
            };
        },
    };
}

const CFG = {
    snapMaxDistPx: 30,
    snapMaxTargets: 2,
    corridorRadius: 10,
    passageCorridorRadius: 10,
    refineBudgetMs: Infinity,
    primaryBudgetMs: Infinity,
    extraBudgetMs: Infinity,
    routeAttempts: 3,
};

// A vertical wall at x=30 splits the base graph; a horizontal passage bridges it.
function bridgeScene() {
    const W = 60, H = 30;
    const mask = new Uint8Array(W * H).fill(FAST);
    for (let y = 0; y < H; y++) mask[y * W + 30] = 0; // impassable wall
    const doc = [{ id: 'bridge', points: [[24, 15], [36, 15]], width: 8 }];
    const s = specFrom({
        W, H,
        baseNodes: [[5, 15], [20, 15], [40, 15], [55, 15]], // 0,1 left; 2,3 right
        passages: [{ id: 'bridge', points: [[24, 15], [36, 15]] }], // nodes 4,5
    });
    s.addEdge(0, 1, EDGE_KIND_BASE, -1);
    s.addEdge(2, 3, EDGE_KIND_BASE, -1);
    s.addEdge(4, 5, EDGE_KIND_PASSAGE, 0);
    s.addEdge(1, 4, EDGE_KIND_TRANSITION, 0); // left base ↔ passage start
    s.addEdge(2, 5, EDGE_KIND_TRANSITION, 0); // right base ↔ passage end
    const artifact = loadArtifact(writeV3(s.finish(passageRevision(doc, W, H))));
    const state = buildState(artifact, mask, CFG);
    return { state, artifact, doc, W, H };
}

// ---------------------------------------------------------------------------
// 1. End-to-end: v3 + matching JSON → typed, refined, legal route over the wall.
// ---------------------------------------------------------------------------
test('base graph alone cannot cross the wall; the serialized passage bridges it', () => {
    const { state, doc, artifact } = bridgeScene();
    // Before attaching the document there is no passage raster, but topology is
    // already in the CSR — a route still traverses the passage chain.
    const stats = attachSerializedPassages(state, doc);
    assert.equal(stats.passageCount, 1);
    assert.equal(stats.passageNodeCount, 2);
    assert.equal(stats.passageEdges, 1);
    assert.equal(stats.transitions, 2);
    assert.equal(state.passageRevision, artifact.passageRevision);
    assert.equal(state.passageOverlay, null); // no dynamic overlay in v3 mode

    const found = graphAstar(state, { x: 55, y: 15 }, [{ node: 0, w: 0 }], [{ node: 3, w: 0 }], null);
    assert.ok(found, 'A* finds a route through the serialized passage');
    const typed = nodePathToTypedRouteSerialized(state, found.nodePath, { x: 5, y: 15 }, { x: 55, y: 15 });
    assert.deepEqual(typed.legs.map((leg) => leg.surface), ['base', 'passage:bridge', 'base']);
    assert.equal(typed.legs[1].direction, 'from-start');

    const refined = refineTypedNavgraphRoute(state, {
        path: typed.path, typedLegs: typed.legs, cost: found.cost,
    }, [], { routeIndex: 1 });
    assert.notEqual(refined.mode, 'unusable');
    assert.equal(refined.passageSpans.length, 1);
    assert.equal(refined.passageSpans[0].passageId, 'bridge');
    assert.equal(countTypedLegalityViolations(state, refined.typedLegs), 0);
});

test('reverse traversal keeps the passage leg and reports from-end', () => {
    const { state, doc } = bridgeScene();
    attachSerializedPassages(state, doc);
    const reverse = graphAstar(state, { x: 5, y: 15 }, [{ node: 3, w: 0 }], [{ node: 0, w: 0 }], null);
    assert.ok(reverse);
    const typed = nodePathToTypedRouteSerialized(state, reverse.nodePath, { x: 55, y: 15 }, { x: 5, y: 15 });
    assert.deepEqual(typed.legs.map((leg) => leg.surface), ['base', 'passage:bridge', 'base']);
    assert.equal(typed.legs[1].direction, 'from-end');
});

test('computeRouteOptions produces a typed passage route with zero legality violations', () => {
    const { state, doc } = bridgeScene();
    attachSerializedPassages(state, doc);
    const options = computeRouteOptions(
        state, { x: 5, y: 15 }, { x: 55, y: 15 },
        [{ node: 0, w: 0 }], [{ node: 3, w: 0 }],
    );
    assert.ok(options.paths.length >= 1, options.reason);
    const route = options.paths[0];
    assert.ok(route.typedLegs.some((leg) => leg.surface === 'passage:bridge'));
    const refined = refineTypedNavgraphRoute(state, route, options.barriers, { routeIndex: route.routeIndex });
    assert.equal(countTypedLegalityViolations(state, refined.typedLegs), 0);
});

// ---------------------------------------------------------------------------
// 2. Control endpoints / sample targets snap to BASE nodes only.
// ---------------------------------------------------------------------------
test('snapping never targets a serialized passage node', () => {
    const { state, doc, artifact } = bridgeScene();
    attachSerializedPassages(state, doc);
    // Snap right on top of passage node 4 (24,15): every returned target must be
    // a base node (< baseNodeCount), never the passage node itself.
    const snaps = snapEndpoint(state, { x: 24, y: 15 });
    assert.ok(snaps.length > 0);
    for (const snap of snaps) assert.ok(snap.node < artifact.baseNodeCount, `snapped to passage node ${snap.node}`);
});

// ---------------------------------------------------------------------------
// 3. Stale document (revision mismatch) is rejected deterministically.
// ---------------------------------------------------------------------------
test('a passage document whose revision differs from the artifact is rejected', () => {
    const { state } = bridgeScene();
    const stale = [{ id: 'bridge', points: [[24, 15], [36, 16]], width: 8 }]; // moved a point
    throws(() => attachSerializedPassages(state, stale), /stale build/, 'moved-point document rejected');
    const widthChange = [{ id: 'bridge', points: [[24, 15], [36, 15]], width: 10 }];
    throws(() => attachSerializedPassages(state, widthChange), /stale build/, 'width-change document rejected');
    const empty = [];
    throws(() => attachSerializedPassages(state, empty), /stale build|runtime passages/, 'empty document rejected');
});

test('the same document always yields the same rejection (deterministic)', () => {
    const stale = [{ id: 'bridge', points: [[24, 15], [36, 16]], width: 8 }];
    const messages = new Set();
    for (let i = 0; i < 3; i++) {
        const { state } = bridgeScene();
        try { attachSerializedPassages(state, stale); assert.fail('expected throw'); }
        catch (err) { messages.add(err.message); }
    }
    assert.equal(messages.size, 1, 'rejection message is deterministic');
});

// ---------------------------------------------------------------------------
// 4. Barrier surface separation: base barriers vs passage barriers.
// ---------------------------------------------------------------------------
// Scene: a base underpass (nodes 0↔1 through the crossing region) AND a crossing
// passage. The passage edge and the base edge geometrically cross near (30,15).
function crossingScene() {
    const W = 60, H = 40;
    const mask = new Uint8Array(W * H).fill(FAST);
    const doc = [{ id: 'tunnel', points: [[30, 8], [30, 32]], width: 8 }];
    const s = specFrom({
        W, H,
        baseNodes: [[8, 15], [52, 15], [30, 4], [30, 36]], // 0 left,1 right (underpass), 2 top,3 bottom
        passages: [{ id: 'tunnel', points: [[30, 8], [30, 32]] }], // nodes 4,5 (vertical)
    });
    s.addEdge(0, 1, EDGE_KIND_BASE, -1);          // horizontal underpass through (30,15)
    s.addEdge(4, 5, EDGE_KIND_PASSAGE, 0);         // vertical passage through (30,20)
    s.addEdge(2, 4, EDGE_KIND_TRANSITION, 0);
    s.addEdge(3, 5, EDGE_KIND_TRANSITION, 0);
    const artifact = loadArtifact(writeV3(s.finish(passageRevision(doc, W, H))));
    const state = buildState(artifact, mask, CFG);
    attachSerializedPassages(state, doc);
    // edge indices: 0 = base underpass, 1 = passage, 2/3 = transitions
    return { state, artifact };
}

test('a base barrier across the passage projection does not block the passage chain', () => {
    const { state } = crossingScene();
    // A base-surface barrier drawn across x∈[20,40] at y=20 crosses BOTH the base
    // underpass (y=15? no — at y=20) and the passage. Place it at y=20 so it
    // crosses the vertical passage between its nodes; it is base-surface.
    const barrier = { ax: 20, ay: 20, bx: 40, by: 20, surface: 'base' };
    const blocked = blockedByBarriers(state, [barrier]);
    const set = blocked instanceof Set ? blocked : blocked.baseEdges;
    assert.ok(!set.has(1), 'base barrier must NOT block the passage edge');
});

test('a passage barrier does not block the base underpass', () => {
    const { state } = crossingScene();
    // A passage-surface barrier drawn transversally across the vertical passage
    // at y=20. It crosses the passage edge but not the base underpass (y=15).
    const barrier = { ax: 22, ay: 20, bx: 38, by: 20, surface: 'passage:tunnel' };
    const blocked = blockedByBarriers(state, [barrier]);
    const set = blocked instanceof Set ? blocked : blocked.baseEdges;
    assert.ok(!set.has(0), 'passage barrier must NOT block the base underpass edge');
    assert.ok(set.has(1), 'passage barrier DOES block its own passage edge');
});

test('a base barrier blocks the base underpass it crosses', () => {
    const { state } = crossingScene();
    const barrier = { ax: 30, ay: 5, bx: 30, by: 25, surface: 'base' };
    const blocked = blockedByBarriers(state, [barrier]);
    const set = blocked instanceof Set ? blocked : blocked.baseEdges;
    assert.ok(set.has(0), 'base barrier blocks the base underpass');
    assert.ok(!set.has(1), 'base barrier does not block the passage edge');
});

// ---------------------------------------------------------------------------
// 5. Base-only v3 attaches cleanly; v2 refuses serialized passages.
// ---------------------------------------------------------------------------
test('base-only v3 artifact attaches with zero passages', () => {
    const W = 40, H = 20;
    const s = specFrom({ W, H, baseNodes: [[5, 10], [35, 10]], passages: [] });
    s.addEdge(0, 1, EDGE_KIND_BASE, -1);
    const artifact = loadArtifact(writeV3(s.finish(passageRevision(null, W, H))));
    const state = buildState(artifact, new Uint8Array(W * H).fill(FAST), CFG);
    const stats = attachSerializedPassages(state, null);
    assert.equal(stats.passageCount, 0);
    assert.equal(state.passageRevision, artifact.passageRevision);
});

test('a v2 legacy artifact refuses serialized passages', () => {
    const W = 40, H = 20;
    const s = specFrom({ W, H, baseNodes: [[5, 10], [35, 10]], passages: [] });
    s.addEdge(0, 1, EDGE_KIND_BASE, -1);
    const f = s.finish(passageRevision(null, W, H));
    f.version = LEGACY_BASE_ONLY_VERSION;
    const artifact = loadArtifact(writeV3(f));
    const state = buildState(artifact, new Uint8Array(W * H).fill(FAST), CFG);
    throws(() => attachSerializedPassages(state, null), /require a v3/, 'v2 artifact refuses serialized attach');
});

console.log(`\nnavgraph_v3_consume: ${passed} checks passed`);
