// Synthetic third-dimension fixtures shared by geometry, layered routing,
// refinement, and regression work packages.
//
// Run their current geometry/classifier assertions with:
//   node project/static/project/js/pathing/dev/passage_geometry.test.mjs

// Fixture coordinates and passage definitions are mask-pixel coordinates and
// use the exact persisted version-1 schema.

const FAST = 241;

function emptyMask(width, height, value = 0) {
    const grid = new Uint8Array(width * height);
    if (value) grid.fill(value);
    return { width, height, grid };
}

function setCell(mask, x, y, value = FAST) {
    if (x >= 0 && y >= 0 && x < mask.width && y < mask.height) {
        mask.grid[y * mask.width + x] = value;
    }
}

function line(mask, x0, y0, x1, y1, value = FAST) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
        const t = steps ? i / steps : 0;
        setCell(mask, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), value);
    }
}

function rect(mask, x0, y0, x1, y1, value = FAST) {
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) setCell(mask, x, y, value);
    }
}

function passage(id, points, width) {
    return { id, points, width };
}

function plusCrossing() {
    const baseMask = emptyMask(25, 25);
    line(baseMask, 1, 12, 23, 12);
    rect(baseMask, 10, 0, 14, 3);
    rect(baseMask, 10, 21, 14, 24);
    return {
        name: 'plus-crossing',
        baseMask,
        passages: {
            version: 1,
            items: [passage('crossing-vertical', [[12, 2], [12, 22]], 6)],
        },
        start: [1, 12],
        goal: [23, 12],
        routes: {
            projectedBaseCrossing: [[1, 12], [6, 12], [12, 12], [18, 12], [23, 12]],
            forwardPassage: [[12, -2], [12, 2], [12, 7], [12, 12], [12, 17], [12, 22], [12, 26]],
            reversePassage: [[12, 26], [12, 22], [12, 17], [12, 12], [12, 7], [12, 2], [12, -2]],
            sameEntranceReturn: [[12, -2], [12, 2], [12, 7], [12, 2], [12, -2]],
            terminatesInside: [[12, -2], [12, 2], [12, 9]],
            exitsSide: [[12, -2], [12, 2], [12, 8], [18, 12], [12, 17], [12, 22], [12, 26]],
        },
        expectedTopology: {
            baseCrossingSurface: 'base',
            forwardPassageId: 'crossing-vertical',
            reversePassageId: 'crossing-vertical',
            midCorridorTransitionAllowed: false,
        },
    };
}

function wideDiagonal() {
    const baseMask = emptyMask(42, 22, FAST);
    return {
        name: 'wide-diagonal',
        baseMask,
        passages: {
            version: 1,
            items: [passage('wide-horizontal', [[8, 10], [32, 10]], 10)],
        },
        start: [3, 6],
        goal: [37, 14],
        routes: {
            offCentreDiagonal: [[3, 6], [8, 6], [20, 9], [32, 14], [37, 14]],
            centreline: [[3, 10], [8, 10], [20, 10], [32, 10], [37, 10]],
        },
        expectedTopology: {
            allowsOffCentreEntrances: true,
            allowsDiagonalInterior: true,
            centrelineRequired: false,
        },
    };
}

function bent() {
    const baseMask = emptyMask(34, 34, FAST);
    return {
        name: 'bent-passage',
        baseMask,
        passages: {
            version: 1,
            items: [passage('bent', [[5, 26], [15, 26], [15, 16], [27, 16]], 8)],
        },
        start: [1, 26],
        goal: [31, 16],
        routes: {
            legalInteriorCut: [[1, 26], [5, 26], [12, 24], [15, 20], [18, 17], [27, 16], [31, 16]],
            illegalCornerCut: [[1, 26], [5, 26], [22, 22], [27, 16], [31, 16]],
        },
        expectedTopology: {
            interiorCornerCutAllowed: true,
            leavingRoundedStrokeAllowed: false,
        },
    };
}

function overlappingPassages() {
    const baseMask = emptyMask(30, 30, FAST);
    return {
        name: 'overlapping-independent-passages',
        baseMask,
        passages: {
            version: 1,
            items: [
                passage('overlap-horizontal', [[3, 15], [27, 15]], 6),
                passage('overlap-vertical', [[15, 3], [15, 27]], 6),
            ],
        },
        start: [3, 15],
        goal: [15, 27],
        expectedTopology: {
            projectedOverlap: [15, 15],
            directPassageTransitionAllowed: false,
            surfaces: ['passage:overlap-horizontal', 'passage:overlap-vertical'],
        },
    };
}

function invalidEntrances() {
    const baseMask = emptyMask(30, 20);
    line(baseMask, 1, 10, 8, 10);
    return {
        name: 'invalid-base-entrances',
        baseMask,
        passages: {
            version: 1,
            items: [passage('no-base-portals', [[12, 4], [24, 16]], 4)],
        },
        start: [1, 10],
        goal: [8, 10],
        expectedTopology: {
            startPassableTransitions: 0,
            endPassableTransitions: 0,
            persistedGeometryStillValid: true,
            routingMustSkipPassage: true,
        },
    };
}

function overlappingEntranceCaps() {
    const baseMask = emptyMask(20, 20, FAST);
    return {
        name: 'overlapping-entrance-caps',
        baseMask,
        passages: {
            version: 1,
            items: [passage('ambiguous-caps', [[5, 10], [8, 10]], 6)],
        },
        start: [5, 10],
        goal: [8, 10],
        expectedTopology: {
            runtimeGeometryValid: false,
            diagnostic: 'overlapping-entrances',
        },
    };
}

function baseOnly() {
    const baseMask = emptyMask(32, 24, FAST);
    rect(baseMask, 14, 0, 16, 18, 0);
    rect(baseMask, 14, 9, 16, 12, FAST);
    return {
        name: 'base-only-regression',
        baseMask,
        passages: { version: 1, items: [] },
        start: [2, 4],
        goal: [29, 20],
        expectedTopology: {
            useExistingPipelineExactly: true,
            passageCount: 0,
        },
    };
}

function benchmark() {
    const baseMask = emptyMask(384, 256, FAST);
    for (let x = 48; x < 360; x += 64) {
        rect(baseMask, x, 0, x + 2, 225, 0);
        rect(baseMask, x, 36 + (x % 3) * 42, x + 2, 76 + (x % 3) * 42, FAST);
    }
    return {
        name: 'passage-benchmark',
        baseMask,
        passages: {
            version: 1,
            items: [
                passage('bench-1', [[30, 40], [115, 55]], 12),
                passage('bench-2', [[90, 210], [155, 170], [225, 178]], 18),
                passage('bench-3', [[250, 45], [350, 110]], 24),
                passage('bench-4', [[270, 220], [335, 188]], 8),
            ],
        },
        start: [10, 20],
        goal: [370, 235],
        expectedTopology: {
            realisticSubgrid: true,
            passageCount: 4,
        },
    };
}

export const EXPECTED_PASSAGE_SEMANTICS = Object.freeze({
    controls: 'Controls remain on base in v1; a control at an entrance is valid because that entrance connects to base.',
    blockers: 'blocked_terrain modifies base only and never modifies a projected passage surface.',
    maskEdits: 'A base-mask edit may invalidate entrance transitions for a request without deleting persisted passage geometry.',
    routeReclassification: 'Only a complete opposite-entrance traversal wholly contained in one corridor becomes a passage span; unclassified route portions remain base.',
    overlaps: 'Projected base/passage and passage/passage overlaps create no transition; only each passage endpoint cap can connect to base.',
});

export function createPassageFixtures() {
    return [
        plusCrossing(),
        wideDiagonal(),
        bent(),
        overlappingPassages(),
        invalidEntrances(),
        overlappingEntranceCaps(),
        baseOnly(),
    ];
}

export function createPassageBenchmarkFixture() {
    return benchmark();
}

