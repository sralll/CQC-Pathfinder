// Direction helpers for uploaded-map Infinity scenes. Reversing a control pair
// leaves the route-choice problem unchanged, so use the direction that requires
// the smaller camera rotation from the scene currently on screen.

function normalizeRotationDelta(degrees) {
    return ((degrees + 540) % 360) - 180;
}

export function cameraRotationForEndpoints(start, goal) {
    if (!start || !goal) return null;
    const dx = goal.x - start.x;
    const dy = goal.y - start.y;
    if (!(Number.isFinite(dx) && Number.isFinite(dy)) || (dx === 0 && dy === 0)) return null;
    return -90 - Math.atan2(dy, dx) * (180 / Math.PI);
}

export function cameraRotationDistance(fromDegrees, toDegrees) {
    if (!(Number.isFinite(fromDegrees) && Number.isFinite(toDegrees))) return Infinity;
    return Math.abs(normalizeRotationDelta(toDegrees - fromDegrees));
}

function reversePassageSpans(spans, pointCount) {
    if (!Array.isArray(spans)) return spans;
    return spans.slice().reverse().map((span) => ({
        ...span,
        fromIndex: pointCount - 1 - span.toIndex,
        toIndex: pointCount - 1 - span.fromIndex,
    }));
}

function reverseRoute(route) {
    const pointCount = route.points?.length || 0;
    route.points = (route.points || []).slice().reverse();
    if (Array.isArray(route.passageSpans)) {
        route.passageSpans = reversePassageSpans(route.passageSpans, pointCount);
    }
    if (Number.isFinite(route.side)) route.side = -route.side;
    if (Number.isFinite(route.pos)) route.pos = -route.pos;
    if (route.sideLabel === 'L') route.sideLabel = 'R';
    else if (route.sideLabel === 'R') route.sideLabel = 'L';
}

/**
 * Reverse a mask scene in place when that saves camera rotation.
 * Returns true when start/goal and every route were reversed.
 */
export function orientMaskSceneForCamera(scene, currentRotation) {
    if (scene?.kind !== 'mask' || !Number.isFinite(currentRotation)) return false;
    const forwardRotation = cameraRotationForEndpoints(scene.start, scene.ziel);
    const reverseRotation = cameraRotationForEndpoints(scene.ziel, scene.start);
    if (forwardRotation === null || reverseRotation === null) return false;
    if (cameraRotationDistance(currentRotation, reverseRotation)
            >= cameraRotationDistance(currentRotation, forwardRotation)) return false;

    [scene.start, scene.ziel] = [scene.ziel, scene.start];
    for (const route of scene.routes || []) reverseRoute(route);
    // A buffered scene may already have been prerendered before its direction
    // was chosen. Rebuild it so the swapped controls and polylines are shown.
    scene._renderCache = null;
    return true;
}
