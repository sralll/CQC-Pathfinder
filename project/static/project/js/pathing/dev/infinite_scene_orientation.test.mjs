import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    cameraRotationDistance,
    cameraRotationForEndpoints,
    orientMaskSceneForCamera,
    orientSceneForCamera,
} from '../../../../../../results/static/results/js/infinite/scene_orientation.js';

const start = { x: 0, y: 0 };
const goal = { x: 10, y: 0 };
assert.equal(cameraRotationForEndpoints(start, goal), -90);
assert.equal(cameraRotationForEndpoints(goal, start), -270);
assert.equal(cameraRotationDistance(80, -270), 10);
assert.equal(cameraRotationDistance(80, -90), 170);

const cached = { stale: true };
const scene = {
    kind: 'mask',
    start,
    ziel: goal,
    _renderCache: cached,
    routes: [{
        routeIndex: 1,
        points: [{ x: 0, y: 0 }, { x: 5, y: -2 }, { x: 10, y: 0 }],
        side: -2,
        pos: -2,
        sideLabel: 'L',
        passageSpans: [{ passageId: 'bridge', fromIndex: 0, toIndex: 1 }],
    }, {
        routeIndex: 2,
        points: [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 10, y: 0 }],
        side: 2,
        pos: 2,
        sideLabel: 'R',
    }],
};
assert.equal(orientMaskSceneForCamera(scene, 80), true);
assert.equal(scene.start, goal);
assert.equal(scene.ziel, start);
assert.deepEqual(scene.routes.map((route) => route.routeIndex), [2, 1],
    'reversing direction must also restore left-to-right rendering order');
assert.deepEqual(scene.routes[0].points, [
    { x: 10, y: 0 }, { x: 5, y: 2 }, { x: 0, y: 0 },
]);
assert.equal(scene.routes[0].side, -2);
assert.equal(scene.routes[0].pos, -2);
assert.equal(scene.routes[0].sideLabel, 'L');
assert.deepEqual(scene.routes[1].passageSpans, [
    { passageId: 'bridge', fromIndex: 1, toIndex: 2 },
]);
assert.equal(scene._renderCache, null);

const forwardScene = {
    kind: 'mask', start, ziel: goal,
    routes: [{ points: [start, goal] }],
};
assert.equal(orientMaskSceneForCamera(forwardScene, -80), false);
assert.equal(forwardScene.start, start);
assert.equal(orientMaskSceneForCamera({ ...forwardScene, kind: 'city' }, 80), false);

const cityScene = {
    kind: 'city',
    start,
    ziel: goal,
    _renderCache: cached,
    routes: [{
        routeIndex: 1,
        points: [{ x: 0, y: 0 }, { x: 5, y: -3 }, { x: 10, y: 0 }],
        side: -3,
        pos: -3,
        sideLabel: 'L',
    }, {
        routeIndex: 2,
        points: [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 10, y: 0 }],
        side: 3,
        pos: 3,
        sideLabel: 'R',
    }],
    routeResult: {
        selected: [{
            routeIndex: 1,
            path: [{ x: 0, y: 0 }, { x: 5, y: -3 }, { x: 10, y: 0 }],
            side: -3,
            sideLabel: 'L',
        }, {
            routeIndex: 2,
            path: [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 10, y: 0 }],
            side: 3,
            sideLabel: 'R',
        }],
        routeSideSlots: [-3, 3, null],
        routeSideLabelSlots: ['L', 'R', null],
    },
};
assert.equal(orientSceneForCamera(cityScene, 80), true);
assert.equal(cityScene.start, goal);
assert.equal(cityScene.ziel, start);
assert.deepEqual(cityScene.routes.map((route) => route.routeIndex), [2, 1]);
assert.deepEqual(cityScene.routes.map((route) => route.side), [-3, 3]);
assert.deepEqual(cityScene.routes.map((route) => route.sideLabel), ['L', 'R']);
assert.deepEqual(cityScene.routes[0].points, [
    { x: 10, y: 0 }, { x: 5, y: 3 }, { x: 0, y: 0 },
]);
assert.deepEqual(cityScene.routeResult.selected.map((route) => route.side), [3, -3]);
assert.deepEqual(cityScene.routeResult.selected.map((route) => route.sideLabel), ['R', 'L']);
assert.deepEqual(cityScene.routeResult.selected[0].path, [
    { x: 10, y: 0 }, { x: 5, y: -3 }, { x: 0, y: 0 },
]);
assert.deepEqual(cityScene.routeResult.routeSideSlots, [3, -3, null]);
assert.deepEqual(cityScene.routeResult.routeSideLabelSlots, ['R', 'L', null]);
assert.equal(cityScene._renderCache, null);
assert.equal(orientSceneForCamera({ ...forwardScene, kind: 'unknown' }, 80), false);

const playerSource = fs.readFileSync(new URL(
    '../../../../../../results/static/results/js/infinite_play.js', import.meta.url,
), 'utf8');
assert.match(playerSource, /orientSceneForCamera\(scene, cam\.rot\)/,
    'the next generated or uploaded-map scene must be oriented before rendering');
assert.match(playerSource, /cameraRotationForEndpoints\(start, ziel\)/,
    'direction choice and camera animation must share the same rotation formula');

console.log('infinite scene orientation tests passed');
