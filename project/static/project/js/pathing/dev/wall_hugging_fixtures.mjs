// CR 6 diagnostics: passages that require a gradual lateral change rather
// than following either wall. All coordinates are mask-pixel coordinates.

const FAST = 241;
const SLOW = 221;

function makeBase(width, height, leftOpenThrough, rightOpenFrom) {
    const grid = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (x <= leftOpenThrough || x >= rightOpenFrom) grid[y * width + x] = FAST;
        }
    }
    return grid;
}

function fixture(name, { points, width, start, goal, terrainVariant = false }) {
    const mapWidth = 132;
    const mapHeight = 104;
    const grid = makeBase(mapWidth, mapHeight, 36, 94);
    if (terrainVariant) {
        // Unequal base costs influence which broad-portal cell is selected,
        // without changing the legal passage cross-section.
        for (let y = 0; y < mapHeight / 2; y++) {
            for (let x = 0; x <= 36; x++) grid[y * mapWidth + x] = SLOW;
        }
    }
    return {
        name,
        mapWidth,
        mapHeight,
        grid,
        start,
        goal,
        passageDocument: {
            version: 1,
            items: [{ id: name, points, width }],
        },
    };
}

export function createWallHuggingFixtures() {
    const straight = {
        points: [[31, 52], [99, 52]],
        width: 64,
        start: [8, 25],
        goal: [124, 79],
    };
    return [
        fixture('wide-straight', straight),
        fixture('wide-straight-reverse', {
            ...straight,
            start: straight.goal,
            goal: straight.start,
        }),
        fixture('wide-straight-terrain', { ...straight, terrainVariant: true }),
        fixture('narrow-straight', { ...straight, width: 36 }),
        fixture('wide-diagonal', {
            points: [[31, 28], [99, 76]],
            width: 56,
            start: [8, 14],
            goal: [124, 91],
        }),
        fixture('wide-bend', {
            points: [[31, 72], [66, 72], [99, 42]],
            width: 52,
            start: [8, 88],
            goal: [124, 24],
        }),
    ];
}
