import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    cameraRotationDistance,
    cameraRotationForEndpoints,
    orientMaskSceneForCamera,
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
        points: [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 10, y: 0 }],
        side: 2,
        pos: 2,
        sideLabel: 'R',
        passageSpans: [{ passageId: 'bridge', fromIndex: 0, toIndex: 1 }],
    }],
};
assert.equal(orientMaskSceneForCamera(scene, 80), true);
assert.equal(scene.start, goal);
assert.equal(scene.ziel, start);
assert.deepEqual(scene.routes[0].points, [
    { x: 10, y: 0 }, { x: 5, y: 2 }, { x: 0, y: 0 },
]);
assert.equal(scene.routes[0].side, -2);
assert.equal(scene.routes[0].pos, -2);
assert.equal(scene.routes[0].sideLabel, 'L');
assert.deepEqual(scene.routes[0].passageSpans, [
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

const playerSource = fs.readFileSync(new URL(
    '../../../../../../results/static/results/js/infinite_play.js', import.meta.url,
), 'utf8');
assert.match(playerSource, /orientMaskSceneForCamera\(scene, cam\.rot\)/,
    'the next uploaded-map scene must be oriented before rendering');
assert.match(playerSource, /cameraRotationForEndpoints\(start, ziel\)/,
    'direction choice and camera animation must share the same rotation formula');

console.log('infinite scene orientation tests passed');
