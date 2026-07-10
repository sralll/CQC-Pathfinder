// Stamp previously generated routes onto only the surface they used.
// The legacy global 40%-60% distance band and radius formula are preserved;
// classification changes only which grid receives each sampled segment.

import { bresenhamPoints } from './bresenham.js';
import { classificationFromPassageSpans, classifyRoutePassages } from './passage_classifier.js';

function routePoints(route) {
    return (route || []).map(point => ({
        x: Number(Array.isArray(point) ? point[0] : point?.x),
        y: Number(Array.isArray(point) ? point[1] : point?.y),
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function hasAuthoritativeSpans(route) {
    return route != null && Object.prototype.hasOwnProperty.call(route, 'passageSpans')
        && Array.isArray(route.passageSpans);
}

function interp(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function surfaceForSegment(segmentEndIndex, spans) {
    for (const span of spans || []) {
        if (segmentEndIndex - 1 >= span.fromIndex && segmentEndIndex <= span.toIndex) {
            return `passage:${span.passageId}`;
        }
    }
    return 'base';
}

function stampDisk(surface, globalX, globalY, radius) {
    const cx = Math.round(globalX - surface.originX);
    const cy = Math.round(globalY - surface.originY);
    if (radius <= 0) {
        if (cx >= 0 && cx < surface.w && cy >= 0 && cy < surface.h) {
            surface.grid[cy * surface.w + cx] = 0;
        }
        return;
    }
    for (let dy = -radius; dy <= radius; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= surface.h) continue;
        const dxMax = Math.floor(Math.sqrt(radius * radius - dy * dy));
        const base = y * surface.w;
        const lo = Math.max(0, cx - dxMax);
        const hi = Math.min(surface.w - 1, cx + dxMax);
        for (let x = lo; x <= hi; x++) surface.grid[base + x] = 0;
    }
}

/**
 * Clone and route-mask a base subgrid plus normalized passage rasters.
 *
 * @returns {{base:object,passages:Array<object>,classifications:Array<object>}}
 */
export function applySurfaceRouteMasks(base, passages, routes) {
    if (!routes?.length) return { base, passages, classifications: [] };
    const maskedBase = { ...base, grid: new Uint8Array(base.grid) };
    const maskedPassages = passages.map(passage => ({ ...passage, grid: new Uint8Array(passage.grid) }));
    const surfaces = new Map([['base', maskedBase]]);
    for (const passage of maskedPassages) {
        surfaces.set(`passage:${passage.id}`, {
            grid: passage.grid,
            w: passage.localWidth,
            h: passage.localHeight,
            originX: passage.originX,
            originY: passage.originY,
        });
    }

    const classifications = [];
    for (const rawRoute of routes) {
        const points = routePoints(rawRoute);
        if (points.length < 2) continue;
        const classification = hasAuthoritativeSpans(rawRoute)
            ? classificationFromPassageSpans(points, rawRoute.passageSpans)
            : classifyRoutePassages(points, passages);
        classifications.push(classification);
        const cumulative = [0];
        for (let i = 1; i < points.length; i++) {
            cumulative.push(cumulative[i - 1] + Math.hypot(
                points[i].x - points[i - 1].x,
                points[i].y - points[i - 1].y,
            ));
        }
        const totalDistance = cumulative[cumulative.length - 1];
        if (totalDistance <= 0) continue;
        const blockStart = totalDistance * 0.4;
        const blockEnd = totalDistance * 0.6;

        for (let i = 1; i < points.length; i++) {
            const segmentStart = cumulative[i - 1];
            const segmentEnd = cumulative[i];
            const segmentLength = segmentEnd - segmentStart;
            if (segmentLength <= 0) continue;
            const fromDistance = Math.max(segmentStart, blockStart);
            const toDistance = Math.min(segmentEnd, blockEnd);
            if (toDistance < fromDistance) continue;

            const surfaceName = surfaceForSegment(i, classification.passageSpans);
            const surface = surfaces.get(surfaceName) || maskedBase;
            const a = interp(points[i - 1], points[i], (fromDistance - segmentStart) / segmentLength);
            const b = interp(points[i - 1], points[i], (toDistance - segmentStart) / segmentLength);
            const pixels = bresenhamPoints(
                Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y),
            );
            const pixelSteps = Math.max(1, pixels.length / 2 - 1);
            for (let k = 0; k < pixels.length; k += 2) {
                const along = fromDistance + (toDistance - fromDistance) * ((k / 2) / pixelSteps);
                const radius = Math.max(3, Math.floor(Math.min(along, totalDistance - along) / 7));
                stampDisk(surface, pixels[k], pixels[k + 1], radius);
            }
        }
    }
    return { base: maskedBase, passages: maskedPassages, classifications };
}
