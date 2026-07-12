import assert from 'node:assert/strict';

import { calcRouteObstacle } from '../navgraph_router.js';

const FREE = 255;
const SLOW_OBSTACLE = 150;
const STAIRS = 242;

function horizontalMask(values) {
    return {
        mask: Uint8Array.from(values),
        width: values.length,
        height: 1,
        path: [{ x: 0, y: 0 }, { x: values.length - 1, y: 0 }],
    };
}

function score(values, passageSpans = []) {
    const fixture = horizontalMask(values);
    return calcRouteObstacle(
        fixture.mask,
        fixture.width,
        fixture.height,
        fixture.path,
        passageSpans,
    );
}

assert.equal(
    score([FREE, SLOW_OBSTACLE, SLOW_OBSTACLE, FREE]),
    1,
    'one contiguous slow-obstacle run adds one second',
);

assert.equal(
    score([FREE, SLOW_OBSTACLE, FREE, SLOW_OBSTACLE, FREE]),
    2,
    'leaving and re-entering slow obstacle adds a second entry penalty',
);

assert.equal(
    score([FREE, STAIRS, STAIRS, FREE]),
    0.3,
    'the editor-compatible quarter-second stair entry is rounded to one decimal',
);

assert.equal(
    score([FREE, SLOW_OBSTACLE, STAIRS, FREE]),
    1.3,
    'changing directly from obstacle to stairs counts both terrain entries',
);

assert.equal(
    score([SLOW_OBSTACLE, SLOW_OBSTACLE], [{ fromIndex: 0, toIndex: 1 }]),
    0,
    'a passage surface does not inherit obstacle terrain projected underneath it',
);

console.log('navgraph obstacle runtime tests passed');
