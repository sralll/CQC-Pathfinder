// WP 6.2 / 6.3 dynamic navgraph passage overlay verification.
// Usage: node project/static/project/js/pathing/dev/navgraph_passage_overlay.test.mjs

import assert from 'node:assert/strict';
import {
    attachLevelPassages, buildState, countTypedLegalityViolations,
    computeRouteOptions, graphAstar, refineTypedNavgraphRoute,
} from '../navgraph_router.js';
import { nodePathToTypedRoute, passageRevision } from '../navgraph_passage_overlay.js';

const FAST = 241;

function artifactFor(w, h, nodes, edges) {
    const N = nodes.length / 2;
    const E = edges.length / 2;
    const coarseScale = 10;
    const ch = Math.ceil(h / coarseScale), cw = Math.ceil(w / coarseScale);
    const weights = new Float32Array(E);
    for (let e = 0; e < E; e++) {
        const u = edges[2 * e], v = edges[2 * e + 1];
        weights[e] = Math.hypot(nodes[2 * u] - nodes[2 * v], nodes[2 * u + 1] - nodes[2 * v + 1]) * 14;
    }
    return {
        W: w, H: h, N, E, minCostPerPx: 14,
        nodes: Uint32Array.from(nodes), edges: Uint32Array.from(edges), weights,
        coarseScale, ch, cw,
        coarseLabels: new Int32Array(ch * cw).fill(1),
        coarseMinval: new Uint8Array(ch * cw).fill(FAST),
        coarseClear: new Float32Array(ch * cw).fill(20),
        hitzoneScale: coarseScale, hh: ch, hw: cw,
        coarseHitzone: new Uint8Array(ch * cw).fill(1),
    };
}

function wallState() {
    const w = 60, h = 30;
    const mask = new Uint8Array(w * h).fill(FAST);
    for (let y = 0; y < h; y++) mask[y * w + 30] = 0;
    const artifact = artifactFor(
        w, h,
        [5, 15, 20, 15, 40, 15, 55, 15],
        [0, 1, 2, 3],
    );
    return buildState(artifact, mask, {
        snapMaxDistPx: 30,
        snapMaxTargets: 2,
        corridorRadius: 10,
        passageCorridorRadius: 10,
        refineBudgetMs: Infinity,
    });
}

const bridge = [{ id: 'bridge', points: [[24, 15], [36, 15]], width: 8 }];

// Infinity shares the editor's complete entrance-band optimizer rather than
// pinning serialized/dynamic centreline portals. With off-axis endpoints the
// globally shorter traversal enters/exits at different y coordinates.
{
	const state = wallState();
	attachLevelPassages(state, bridge);
	const typedLegs = [
		{ surface: 'base', passageId: null, direction: null, points: [{ x: 5, y: 8 }, { x: 24, y: 15 }] },
		{ surface: 'passage:bridge', passageId: 'bridge', direction: 'from-start', points: [{ x: 24, y: 15 }, { x: 36, y: 15 }] },
		{ surface: 'base', passageId: null, direction: null, points: [{ x: 36, y: 15 }, { x: 55, y: 25 }] },
	];
	const refined = refineTypedNavgraphRoute(state, {
		path: typedLegs.flatMap((leg) => leg.points), typedLegs, cost: 0,
	}, [], { routeIndex: 1 });
	assert.equal(refined.mode, 'theta');
	assert.ok(refined.portalOptimization?.accepted > 0, refined.portalOptimization);
	const passageLeg = refined.typedLegs[1];
	assert.ok(passageLeg.points[0].y !== 15 || passageLeg.points.at(-1).y !== 15,
		'Infinity passage portals remained pinned to the centreline');
}

// Empty passage data leaves the established base graph path byte-for-byte shaped.
{
    const state = wallState();
    const leftOnly = graphAstar(state, { x: 20, y: 15 }, [{ node: 0, w: 0 }], [{ node: 1, w: 0 }], null);
    const before = JSON.stringify(leftOnly);
    const stats = attachLevelPassages(state, []);
    assert.equal(stats.passageCount, 0);
    assert.equal(state.passageOverlay.nodeCount, 0);
    const after = graphAstar(state, { x: 20, y: 15 }, [{ node: 0, w: 0 }], [{ node: 1, w: 0 }], null);
    assert.equal(JSON.stringify(after), before);
}

// The wall is disconnected in the base artifact. The dynamic overlay bridges it,
// retains passage identity, and refines each surface against its own raster.
{
    const state = wallState();
    assert.equal(graphAstar(state, { x: 55, y: 15 }, [{ node: 0, w: 0 }], [{ node: 3, w: 0 }], null), null);
    const stats = attachLevelPassages(state, bridge);
    assert.equal(stats.passageCount, 1);
    assert.ok(stats.portalCount >= 6);
    const found = graphAstar(state, { x: 55, y: 15 }, [{ node: 0, w: 0 }], [{ node: 3, w: 0 }], null);
    assert.ok(found);
    const typed = nodePathToTypedRoute(state, found.nodePath, { x: 5, y: 15 }, { x: 55, y: 15 });
    assert.deepEqual(typed.legs.map((leg) => leg.surface), ['base', 'passage:bridge', 'base']);
    assert.equal(typed.legs[1].direction, 'from-start');
    const refined = refineTypedNavgraphRoute(state, {
        path: typed.path, typedLegs: typed.legs, cost: found.cost,
    }, [], { routeIndex: 1 });
    assert.notEqual(refined.mode, 'unusable');
    assert.equal(refined.passageSpans.length, 1);
    assert.equal(countTypedLegalityViolations(state, refined.typedLegs), 0);

    const reverse = graphAstar(state, { x: 5, y: 15 }, [{ node: 3, w: 0 }], [{ node: 0, w: 0 }], null);
    const reverseTyped = nodePathToTypedRoute(state, reverse.nodePath, { x: 55, y: 15 }, { x: 5, y: 15 });
    assert.equal(reverseTyped.legs[1].direction, 'from-end');
}

// All cross-surface edges are at a derived cap. A projected crossing, including
// an overlap with an independent passage, creates no passage-to-passage edge.
{
    const state = wallState();
    attachLevelPassages(state, [
        ...bridge,
        { id: 'vertical', points: [[30, 5], [30, 25]], width: 6 },
    ]);
    for (const edges of state.passageOverlay.adjacency.values()) {
        for (const edge of edges) {
            if (!edge.surface.startsWith('passage:')) continue;
            const from = state.passageOverlay.nodeCoords[edge.from - state.artifact.N];
            const to = state.passageOverlay.nodeCoords[edge.to - state.artifact.N];
            assert.equal(from.passageId, edge.passageId);
            assert.equal(to.passageId, edge.passageId);
            assert.notEqual(from.cap, to.cap);
        }
    }
}

// Revision is deterministic, item-order independent, and width-sensitive. Wider
// caps expose more candidate portals without allocating a full-map extra layer.
{
    const narrow = [{ id: 'a', points: [[10, 10], [40, 10]], width: 4 }];
    const wide = [{ id: 'a', points: [[10, 10], [40, 10]], width: 16 }];
    assert.equal(passageRevision(narrow, 60, 30), passageRevision(narrow, 60, 30));
    assert.notEqual(passageRevision(narrow, 60, 30), passageRevision(wide, 60, 30));
    assert.equal(
        passageRevision([...narrow, { id: 'b', points: [[10, 20], [40, 20]], width: 4 }], 60, 30),
        passageRevision([{ id: 'b', points: [[10, 20], [40, 20]], width: 4 }, ...narrow], 60, 30),
    );
    const state = wallState();
    const narrowStats = attachLevelPassages(state, narrow);
    const wideStats = attachLevelPassages(state, wide);
    assert.ok(wideStats.portalCount > narrowStats.portalCount);
}

// Route-option generation can discover distinct width-aware passage lines. The
// barrier placed on the first route is tagged with its surface, so it is not
// accidentally applied to the projected base graph.
{
    const w = 60, h = 40;
    const mask = new Uint8Array(w * h).fill(FAST);
    for (let y = 2; y < h - 2; y++) mask[y * w + 30] = 0;
    const artifact = artifactFor(
        w, h,
        [5, 20, 20, 20, 20, 0, 40, 0, 40, 20, 55, 20],
        [0, 1, 1, 2, 2, 3, 3, 4, 4, 5],
    );
    const state = buildState(artifact, mask, {
        snapMaxDistPx: 25,
        snapMaxTargets: 1,
        routeAttempts: 3,
        primaryBudgetMs: Infinity,
        extraBudgetMs: Infinity,
        barrierMaxHalfPx: 20,
        barrierExtendMaxHalfPx: 20,
        barrierStepPx: 1,
        barrierMarginPx: 0,
        barrierAnchorMinAreaPx: 10,
        barrierElongationRatio: 2,
    });
    attachLevelPassages(state, [{ id: 'choice', points: [[24, 20], [36, 20]], width: 8 }]);
    const options = computeRouteOptions(
        state, { x: 5, y: 20 }, { x: 55, y: 20 },
        [{ node: 0, w: 0 }], [{ node: 5, w: 0 }],
    );
    assert.ok(options.paths.length >= 2, options.reason);
    assert.ok(options.paths[0].typedLegs.some((leg) => leg.surface === 'passage:choice'));
    assert.equal(options.barriers[0].surface, 'passage:choice');
	assert.ok(Math.hypot(
		options.barriers[0].bx - options.barriers[0].ax,
		options.barriers[0].by - options.barriers[0].ay,
	) >= 12, 'passage blocker did not cover width plus overhang');
    assert.notDeepEqual(options.paths[1].nodePath, options.paths[0].nodePath);
}

console.log('navgraph passage overlay: topology, typed refinement, width portals, and revision policy passed');
