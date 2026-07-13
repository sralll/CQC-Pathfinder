// WP 3.1 / 3.2 sparse layered routing verification.
// Usage:
//   node project/static/project/js/pathing/dev/layered_passage.test.mjs

import assert from 'node:assert/strict';
import { normalizePassagesForRuntime, passageEntranceAt } from '../passage_geometry.js';
import { classifyRoutePassages } from '../passage_classifier.js';
import { layeredAstar } from '../layered_astar.js';
import { runLayeredPipeline } from '../layered_pipeline.js';
import { applySurfaceRouteMasks } from '../surface_route_mask.js';
import { guidedThetaStar } from '../theta_star.js';
import { createPassageFixtures } from './passage_fixtures.mjs';

const FAST = 241;

function openMask(w, h) { return new Uint8Array(w * h).fill(FAST); }

function normalize(document, w, h) {
    const result = normalizePassagesForRuntime(document, { mapWidth: w, mapHeight: h });
    assert.deepEqual(result.diagnostics, []);
    return result.passages;
}

function baseSurface(grid, w, h) {
    return { grid, w, h, originX: 0, originY: 0 };
}

function assertDirectionalLeg(leg, passage) {
    assert.match(leg.surface, /^passage:/);
    const start = passageEntranceAt(passage, leg.points[0], leg.points[1]);
    const end = passageEntranceAt(
        passage,
        leg.points[leg.points.length - 2],
        leg.points[leg.points.length - 1],
    );
    if (leg.direction === 'from-start') {
        assert.equal(start, 1);
        assert.equal(end, 2);
    } else {
        assert.equal(leg.direction, 'from-end');
        assert.equal(start, 2);
        assert.equal(end, 1);
    }
}

// A wall separates the base components. The only legal connection is the
// passage; allocation is base + two directional copies of its cropped raster.
{
    const w = 40, h = 30;
    const grid = openMask(w, h);
    for (let y = 1; y < h - 1; y++) grid[y * w + 20] = 0;
    const passages = normalize({
        version: 1,
        items: [{ id: 'wall-bridge', points: [[14, 15], [26, 15]], width: 6 }],
    }, w, h);
    const search = layeredAstar(baseSurface(grid, w, h), { x: 5, y: 10 }, { x: 34, y: 20 }, passages);
    assert.ok(search);
    assert.deepEqual(search.legs.map(leg => leg.surface), ['base', 'passage:wall-bridge', 'base']);
    assertDirectionalLeg(search.legs[1], passages[0]);
    assert.equal(search.stats.allocatedNodes, w * h + 2 * passages[0].grid.length);

    const reverse = layeredAstar(baseSurface(grid, w, h), { x: 34, y: 20 }, { x: 5, y: 10 }, passages);
    assert.ok(reverse);
    assert.equal(reverse.legs[1].direction, 'from-end');
    assertDirectionalLeg(reverse.legs[1], passages[0]);
}

// The projected centre of a + crossing does not create a transition. The
// horizontal base route remains wholly base even though a vertical passage
// raster exists at the same coordinates.
{
    const fixture = Object.fromEntries(createPassageFixtures().map(item => [item.name, item]))['plus-crossing'];
    const passages = normalize(fixture.passages, fixture.baseMask.width, fixture.baseMask.height);
    const search = layeredAstar(
        baseSurface(fixture.baseMask.grid, fixture.baseMask.width, fixture.baseMask.height),
        { x: fixture.start[0], y: fixture.start[1] },
        { x: fixture.goal[0], y: fixture.goal[1] },
        passages,
    );
    assert.ok(search);
    assert.deepEqual(search.legs.map(leg => leg.surface), ['base']);
}

// Every cell across a rectangular portal band is eligible for a base/surface
// transition. Here the only live cells are opposite edge cells, not centreline
// cells, so a successful traversal proves full-width coverage.
{
    const w = 40, h = 30;
    const grid = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x <= 10; x++) grid[y * w + x] = FAST;
        for (let x = 30; x < w; x++) grid[y * w + x] = FAST;
    }
    // The outward bands cover x 11..13 and 27..29 across rows 12..18. Leave
    // exactly one live base cell in each band — opposite extreme corners — and
    // connect them to the open regions through rows outside the band.
    for (const x of [11, 12, 13]) grid[11 * w + x] = FAST;
    grid[12 * w + 13] = FAST;                    // start band corner (13, 12)
    for (const x of [27, 28, 29]) grid[19 * w + x] = FAST;
    grid[18 * w + 27] = FAST;                    // end band corner (27, 18)
    const passages = normalize({
        version: 1,
        items: [{ id: 'edge-portals', points: [[14, 15], [26, 15]], width: 6 }],
    }, w, h);
    const search = layeredAstar(
        baseSurface(grid, w, h), { x: 5, y: 12 }, { x: 34, y: 18 }, passages,
    );
    assert.ok(search);
    assert.deepEqual(search.legs.map(leg => leg.surface), ['base', 'passage:edge-portals', 'base']);
    assert.deepEqual(search.legs[1].points.slice(0, 2), [13, 12]);
    assert.deepEqual(search.legs[1].points.slice(-2), [27, 18]);
}

// Surface-aware refinement is free to cross a wide bridge diagonally and the
// flattened result can be deterministically reclassified without Route metadata.
{
    const w = 44, h = 24;
    const grid = openMask(w, h);
    for (let y = 1; y < h - 1; y++) grid[y * w + 22] = 0;
    const passages = normalize({
        version: 1,
        items: [{ id: 'wide', points: [[9, 11], [35, 11]], width: 12 }],
    }, w, h);
    const result = runLayeredPipeline(
        grid, w, h, { x: 3, y: 6 }, { x: 40, y: 17 }, passages, 'layered-test',
    );
    assert.ok(result.path, result.error);
    assert.equal(result.passageSpans.length, 1);
    const span = result.passageSpans[0];
    const passageYs = [];
    for (let i = span.fromIndex; i <= span.toIndex; i++) passageYs.push(result.path[i * 2 + 1]);
    assert.ok(new Set(passageYs).size > 1, `passage path was forced horizontal/central: ${passageYs}`);
    const classified = classifyRoutePassages(result.path, passages);
    assert.deepEqual(classified.passageSpans, result.passageSpans);
}

// The legacy global middle-band blocker is stamped only on the classified
// surface: an upper route leaves base untouched, and a projected base crossing
// leaves the passage raster untouched.
{
    const w = 40, h = 30;
    const grid = openMask(w, h);
    const passages = normalize({
        version: 1,
        items: [{ id: 'mask-surface', points: [[10, 15], [30, 15]], width: 6 }],
    }, w, h);
    const base = baseSurface(grid, w, h);
    const upperRoute = [[5, 15], [10, 15], [20, 15], [30, 15], [35, 15]];
    const upperMasked = applySurfaceRouteMasks(base, passages, [upperRoute]);
    assert.equal(upperMasked.base.grid[15 * w + 20], FAST);
    const upperPassage = upperMasked.passages[0];
    const upperLocal = (15 - upperPassage.originY) * upperPassage.localWidth + (20 - upperPassage.originX);
    assert.equal(upperPassage.grid[upperLocal], 0);

    const authoritativeBase = upperRoute.map(point => point.slice());
    authoritativeBase.passageSpans = [];
    const authoritativeBaseMasked = applySurfaceRouteMasks(base, passages, [authoritativeBase]);
    assert.equal(authoritativeBaseMasked.base.grid[15 * w + 20], 0);
    const authoritativeUntouchedPassage = authoritativeBaseMasked.passages[0];
    const authoritativeLocal = (15 - authoritativeUntouchedPassage.originY)
        * authoritativeUntouchedPassage.localWidth + (20 - authoritativeUntouchedPassage.originX);
    assert.notEqual(authoritativeUntouchedPassage.grid[authoritativeLocal], 0);

    const baseCrossing = [[20, 1], [20, 8], [20, 15], [20, 22], [20, 28]];
    const baseMasked = applySurfaceRouteMasks(base, passages, [baseCrossing]);
    assert.equal(baseMasked.base.grid[15 * w + 20], 0);
    const untouchedPassage = baseMasked.passages[0];
    const untouchedLocal = (15 - untouchedPassage.originY) * untouchedPassage.localWidth + (20 - untouchedPassage.originX);
    assert.notEqual(untouchedPassage.grid[untouchedLocal], 0);
}

// A passage with no currently live portals must not force a legacy fallback:
// the layered helper still finds a base path, preserving surface-aware route
// blocking for any previous upper-level route.
{
    const grid = openMask(12, 12);
    const baseOnly = layeredAstar(
        baseSurface(grid, 12, 12), { x: 1, y: 1 }, { x: 10, y: 10 }, [],
    );
    assert.ok(baseOnly);
    assert.deepEqual(baseOnly.legs.map(leg => leg.surface), ['base']);
    assert.equal(baseOnly.stats.selectedPassages, 0);
}

// Passage-only weighted LOS can cross the mandatory slow portal rows in one
// any-angle edge. The legacy same-grey rule leaves one-point stubs at both
// transitions even though the direct segment is legal and cheaper.
{
    const w = 24, h = 9;
    const grid = openMask(w, h);
    for (let y = 0; y < h; y++) {
        grid[y * w + 1] = 231;
        grid[y * w + 22] = 231;
    }
    const start = { x: 1, y: 4 };
    const goal = { x: 22, y: 4 };
    const legacy = guidedThetaStar(grid, w, h, start, goal, [22, 4], 10);
    const weighted = guidedThetaStar(
        grid, w, h, start, goal, [22, 4], 10, null, { integrateLineCost: true },
    );
    assert.ok(legacy.length > 4);
    assert.deepEqual(weighted, [1, 4, 22, 4]);
}

// Chained passages exercise the post-refinement forward/reverse portal sweep.
// Every passage leg is reduced to one legal any-angle segment, while the sweep
// revisits the first passage after the second changes their shared base leg.
{
    const w = 80, h = 40;
    const grid = openMask(w, h);
    for (let y = 1; y < h - 1; y++) {
        grid[y * w + 25] = 0;
        grid[y * w + 55] = 0;
    }
    const passages = normalize({
        version: 1,
        items: [
            { id: 'smooth-chain-a', points: [[19, 20], [31, 20]], width: 14 },
            { id: 'smooth-chain-b', points: [[49, 20], [61, 20]], width: 14 },
        ],
    }, w, h);
    const result = runLayeredPipeline(
        grid, w, h, { x: 4, y: 5 }, { x: 75, y: 35 }, passages, 'smooth-chain-test',
    );
    assert.ok(result.path, result.error);
    assert.deepEqual(
        result.typedLegs.map(leg => leg.surface),
        ['base', 'passage:smooth-chain-a', 'base', 'passage:smooth-chain-b', 'base'],
    );
    assert.ok(result.typedLegs.filter(leg => leg.surface !== 'base')
        .every(leg => leg.points.length === 4));
    assert.ok(result.portalOptimization?.attempts >= 2);
    assert.ok(result.portalOptimization?.accepted >= 1);
    assert.ok(result.portalOptimization?.sweeps >= 2);
    assert.deepEqual(classifyRoutePassages(result.path, passages).passageSpans, result.passageSpans);
}

console.log('layered passage routing: directional topology, crossing isolation, any-angle refinement, and reclassification passed');
