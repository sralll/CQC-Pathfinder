// Deterministic geometry for v1 third-dimension passages.
//
// This module is deliberately DOM/Canvas-free so the browser worker, editor
// preview, and Node verification harness all use identical pixel rules.

export const PASSAGE_SCHEMA_VERSION = 1;
export const PASSAGE_FAST_VALUE = 241;
export const PASSAGE_BOUNDARY_VALUE = 255 - 24;
export const PASSAGE_MIN_WIDTH = 2;
export const PASSAGE_MAX_WIDTH = 256;
export const PASSAGE_MAX_ITEMS = 64;
export const PASSAGE_MAX_POINTS = 256;
// Entrance topology is a map-space geometry rule. Keep this single exported
// value authoritative for raster cells, classifiers, graph transitions, SVG,
// and regression fixtures. The portal band lies OUTSIDE the drawn corridor:
// each terminal segment is extended outward by this depth and the appended
// rectangle is the entrance band.
export const PASSAGE_PORTAL_DEPTH = 3;
// Dense cropped rasters keep the hot path simple, but an adversarial long
// diagonal can otherwise allocate most of a map-sized bounding box. These
// limits bound both normalization and the two directional A* state copies.
export const PASSAGE_MAX_RASTER_CELLS = 1_048_576;
export const PASSAGE_MAX_TOTAL_RASTER_CELLS = 2_097_152;
export const PASSAGE_MAX_RASTER_WORK = 16_777_216;
export const PASSAGE_MAX_TOTAL_RASTER_WORK = 33_554_432;

const DEFAULT_PADDING = 1;
const DEFAULT_BOUNDARY_BAND = 1;
const EPSILON = 1e-9;

function diagnostic(code, itemIndex, id, detail) {
    return Object.freeze({ code, itemIndex, id: id || null, detail });
}

function pointSegmentDistanceSquared(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= EPSILON) {
        const ex = px - ax;
        const ey = py - ay;
        return ex * ex + ey * ey;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const ex = px - (ax + t * dx);
    const ey = py - (ay + t * dy);
    return ex * ex + ey * ey;
}

function cross(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax, ay, bx, by, px, py) {
    return px >= Math.min(ax, bx) - EPSILON && px <= Math.max(ax, bx) + EPSILON
        && py >= Math.min(ay, by) - EPSILON && py <= Math.max(ay, by) + EPSILON;
}

function segmentsIntersect(a, b, c, d) {
    const abC = cross(a[0], a[1], b[0], b[1], c[0], c[1]);
    const abD = cross(a[0], a[1], b[0], b[1], d[0], d[1]);
    const cdA = cross(c[0], c[1], d[0], d[1], a[0], a[1]);
    const cdB = cross(c[0], c[1], d[0], d[1], b[0], b[1]);
    if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
        && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
    return (Math.abs(abC) <= EPSILON && onSegment(a[0], a[1], b[0], b[1], c[0], c[1]))
        || (Math.abs(abD) <= EPSILON && onSegment(a[0], a[1], b[0], b[1], d[0], d[1]))
        || (Math.abs(cdA) <= EPSILON && onSegment(c[0], c[1], d[0], d[1], a[0], a[1]))
        || (Math.abs(cdB) <= EPSILON && onSegment(c[0], c[1], d[0], d[1], b[0], b[1]));
}

function segmentDistanceSquared(a, b, c, d) {
    if (segmentsIntersect(a, b, c, d)) return 0;
    return Math.min(
        pointSegmentDistanceSquared(a[0], a[1], c[0], c[1], d[0], d[1]),
        pointSegmentDistanceSquared(b[0], b[1], c[0], c[1], d[0], d[1]),
        pointSegmentDistanceSquared(c[0], c[1], a[0], a[1], b[0], b[1]),
        pointSegmentDistanceSquared(d[0], d[1], a[0], a[1], b[0], b[1]),
    );
}

function hasSelfOverlappingCorridor(points, width) {
    const thresholdSquared = width * width + EPSILON;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
        cumulative.push(cumulative[i - 1] + Math.hypot(
            points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1],
        ));
    }
    for (let first = 1; first < points.length; first++) {
        for (let second = first + 2; second < points.length; second++) {
            // Dense control points along one continuous bend naturally have
            // overlapping stroke footprints. Only compare portions separated
            // by more than one corridor width along the centreline.
            if (cumulative[second - 1] - cumulative[first] <= width + EPSILON) continue;
            if (segmentDistanceSquared(
                points[first - 1], points[first],
                points[second - 1], points[second],
            ) <= thresholdSquared) return true;
        }
    }
    return false;
}

function normalizePoints(rawPoints) {
    if (!Array.isArray(rawPoints) || rawPoints.length > PASSAGE_MAX_POINTS) return null;
    const points = [];
    for (const raw of rawPoints) {
        if (!Array.isArray(raw) || raw.length < 2) return null;
        const x = Number(raw[0]);
        const y = Number(raw[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const previous = points[points.length - 1];
        if (previous && previous[0] === x && previous[1] === y) continue;
        points.push([x, y]);
    }
    if (points.length < 2) return null;
    return points;
}

function validDimension(value) {
    return Number.isInteger(value) && value > 0;
}

function unitVector(from, to) {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);
    if (!(length > EPSILON)) return null;
    return Object.freeze({ x: dx / length, y: dy / length });
}

/** Terminal inward tangents used by both the runtime and SVG renderer.
 *  `startOuter`/`endOuter` are the drawn endpoints pushed outward by the
 *  portal depth; the corridor plus its two entrance bands ends there.
 *  Returns null for degenerate input (fewer than two points, or a zero-length
 *  terminal segment as unnormalized editor drafts can briefly contain). */
export function passageTerminalFrames(passage) {
    const points = passage?.points;
    if (!Array.isArray(points) || points.length < 2) return null;
    const start = Object.freeze(points[0].slice());
    const end = Object.freeze(points[points.length - 1].slice());
    const startInward = unitVector(start, points[1]);
    const endInward = unitVector(end, points[points.length - 2]);
    if (!startInward || !endInward) return null;
    const startOuter = Object.freeze([
        start[0] - startInward.x * PASSAGE_PORTAL_DEPTH,
        start[1] - startInward.y * PASSAGE_PORTAL_DEPTH,
    ]);
    const endOuter = Object.freeze([
        end[0] - endInward.x * PASSAGE_PORTAL_DEPTH,
        end[1] - endInward.y * PASSAGE_PORTAL_DEPTH,
    ]);
    return Object.freeze({ start, end, startInward, endInward, startOuter, endOuter });
}

function resolveFrames(passage) {
    return passage.terminalFrames || passageTerminalFrames(passage);
}

function terminalProjections(frames, x, y) {
    if (!frames) return { start: -Infinity, end: -Infinity };
    return {
        start: (x - frames.start[0]) * frames.startInward.x
            + (y - frames.start[1]) * frames.startInward.y,
        end: (x - frames.end[0]) * frames.endInward.x
            + (y - frames.end[1]) * frames.endInward.y,
    };
}

/** Minimum Euclidean distance from a global point to the passage centreline,
 *  measured against the terminal segments extended outward through the portal
 *  bands. Points beyond either outer cap plane are outside (Infinity). */
export function distanceToPassage(passage, x, y) {
    const frames = resolveFrames(passage);
    const projections = terminalProjections(frames, x, y);
    if (projections.start < -PASSAGE_PORTAL_DEPTH - EPSILON
        || projections.end < -PASSAGE_PORTAL_DEPTH - EPSILON) return Infinity;
    let best = Infinity;
    const points = passage.points;
    const last = points.length - 1;
    for (let i = 1; i <= last; i++) {
        const a = i === 1 ? frames.startOuter : points[i - 1];
        const b = i === last ? frames.endOuter : points[i];
        const distanceSquared = pointSegmentDistanceSquared(x, y, a[0], a[1], b[0], b[1]);
        if (distanceSquared < best) best = distanceSquared;
    }
    return Math.sqrt(best);
}

/** True inside the side-expanded stroke, clipped by both flat outer cap planes. */
export function hitTestPassage(passage, x, y, tolerance = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(tolerance)) return false;
    return distanceToPassage(passage, x, y) <= passage.width / 2 + Math.max(0, tolerance) + EPSILON;
}

/** Entrance identity in the two rectangular bands outside the drawn endpoints.
 *  The tolerance also applies along the corridor axis so a point on (or within
 *  tolerance of) the drawn cap plane still counts as touching that entrance —
 *  raster cell membership stays strictly outside the plane. */
export function passageEntranceAt(passage, x, y, tolerance = 0) {
    if (!hitTestPassage(passage, x, y, tolerance)) return 0;
    const projections = terminalProjections(resolveFrames(passage), x, y);
    const reach = Math.max(0, tolerance) + EPSILON;
    const inStart = projections.start <= reach;
    const inEnd = projections.end <= reach;
    return (inStart ? 1 : 0) | (inEnd ? 2 : 0);
}

export function globalToPassageLocal(passage, x, y) {
    return { x: x - passage.originX, y: y - passage.originY };
}

export function passageLocalToGlobal(passage, x, y) {
    return { x: x + passage.originX, y: y + passage.originY };
}

export function passageLocalIndexToGlobal(passage, index) {
    if (!Number.isInteger(index) || index < 0 || index >= passage.grid.length) return null;
    const x = index % passage.localWidth;
    const y = (index - x) / passage.localWidth;
    return passageLocalToGlobal(passage, x, y);
}

export function passageLocalIndex(passage, globalX, globalY) {
    const x = globalX - passage.originX;
    const y = globalY - passage.originY;
    if (!Number.isInteger(x) || !Number.isInteger(y)
        || x < 0 || y < 0 || x >= passage.localWidth || y >= passage.localHeight) return -1;
    return y * passage.localWidth + x;
}

export function passageGridValueAt(passage, globalX, globalY) {
    const index = passageLocalIndex(passage, globalX, globalY);
    return index < 0 ? 0 : passage.grid[index];
}

/** Binary search in a sorted Uint32Array entrance set. */
export function entranceContainsLocalIndex(entrance, index) {
    let low = 0;
    let high = entrance.length - 1;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        const candidate = entrance[middle];
        if (candidate === index) return true;
        if (candidate < index) low = middle + 1;
        else high = middle - 1;
    }
    return false;
}

/**
 * Rasterize one structurally valid persisted item. Coordinates of cells are
 * their integer global mask-pixel centres. The returned typed arrays are
 * authoritative read-only data (TypedArrays themselves cannot be frozen).
 */
export function rasterizePassage(rawItem, options = {}) {
    const itemIndex = Number.isInteger(options.itemIndex) ? options.itemIndex : -1;
    const id = typeof rawItem?.id === 'string' ? rawItem.id : null;
    if (!id || id.length > 64) {
        return { passage: null, diagnostics: [diagnostic('invalid-id', itemIndex, id, 'Passage id must be a non-empty string of at most 64 characters.')] };
    }
    const width = Number(rawItem?.width);
    if (!Number.isFinite(width) || width < PASSAGE_MIN_WIDTH || width > PASSAGE_MAX_WIDTH) {
        return { passage: null, diagnostics: [diagnostic('invalid-width', itemIndex, id, `Width must be between ${PASSAGE_MIN_WIDTH} and ${PASSAGE_MAX_WIDTH}.`)] };
    }
    const normalizedPoints = normalizePoints(rawItem?.points);
    if (!normalizedPoints) {
        return { passage: null, diagnostics: [diagnostic('invalid-points', itemIndex, id, 'At least two distinct finite consecutive points are required.')] };
    }
    const startPoint = normalizedPoints[0];
    const endPoint = normalizedPoints[normalizedPoints.length - 1];
    const terminalFrames = passageTerminalFrames({ points: normalizedPoints });
    if (!terminalFrames) {
        return { passage: null, diagnostics: [diagnostic('invalid-points', itemIndex, id, 'At least two distinct finite consecutive points are required.')] };
    }
    if (hasSelfOverlappingCorridor(normalizedPoints, width)) {
        return { passage: null, diagnostics: [diagnostic('self-overlapping-corridor', itemIndex, id, 'A passage corridor must not cross, branch, or touch a non-adjacent part of itself.')] };
    }

    const mapWidth = options.mapWidth;
    const mapHeight = options.mapHeight;
    const hasMapBounds = validDimension(mapWidth) && validDimension(mapHeight);
    if ((mapWidth !== undefined || mapHeight !== undefined) && !hasMapBounds) {
        return { passage: null, diagnostics: [diagnostic('invalid-map-bounds', itemIndex, id, 'Map width and height must both be positive integers.')] };
    }

    const radius = width / 2;
    const padding = Number.isInteger(options.padding) && options.padding >= 0
        ? options.padding : DEFAULT_PADDING;
    let minPointX = Infinity;
    let minPointY = Infinity;
    let maxPointX = -Infinity;
    let maxPointY = -Infinity;
    for (const point of [...normalizedPoints, terminalFrames.startOuter, terminalFrames.endOuter]) {
        minPointX = Math.min(minPointX, point[0]);
        minPointY = Math.min(minPointY, point[1]);
        maxPointX = Math.max(maxPointX, point[0]);
        maxPointY = Math.max(maxPointY, point[1]);
    }
    let minX = Math.floor(minPointX - radius) - padding;
    let minY = Math.floor(minPointY - radius) - padding;
    let maxX = Math.ceil(maxPointX + radius) + padding;
    let maxY = Math.ceil(maxPointY + radius) + padding;
    if (hasMapBounds) {
        minX = Math.max(0, minX);
        minY = Math.max(0, minY);
        maxX = Math.min(mapWidth - 1, maxX);
        maxY = Math.min(mapHeight - 1, maxY);
    }
    if (maxX < minX || maxY < minY) {
        return { passage: null, diagnostics: [diagnostic('outside-map', itemIndex, id, 'Passage corridor does not intersect the mask bounds.')] };
    }

    const localWidth = maxX - minX + 1;
    const localHeight = maxY - minY + 1;
    const rasterCells = localWidth * localHeight;
    const maxRasterCells = Number.isInteger(options.maxRasterCells) && options.maxRasterCells > 0
        ? options.maxRasterCells : PASSAGE_MAX_RASTER_CELLS;
    if (!Number.isSafeInteger(rasterCells) || rasterCells > maxRasterCells) {
        return { passage: null, diagnostics: [diagnostic('raster-budget-exceeded', itemIndex, id, `Passage raster exceeds the ${maxRasterCells}-cell runtime budget.`)] };
    }
    const segmentBounds = [];
    let rasterWork = 0;
    const lastSegment = normalizedPoints.length - 1;
    for (let segment = 1; segment <= lastSegment; segment++) {
        // Terminal segments extend outward through the portal bands so the
        // appended entrance rectangles keep the full corridor width.
        const a = segment === 1 ? terminalFrames.startOuter : normalizedPoints[segment - 1];
        const b = segment === lastSegment ? terminalFrames.endOuter : normalizedPoints[segment];
        const fromX = Math.max(minX, Math.floor(Math.min(a[0], b[0]) - radius));
        const fromY = Math.max(minY, Math.floor(Math.min(a[1], b[1]) - radius));
        const toX = Math.min(maxX, Math.ceil(Math.max(a[0], b[0]) + radius));
        const toY = Math.min(maxY, Math.ceil(Math.max(a[1], b[1]) + radius));
        const cells = Math.max(0, toX - fromX + 1) * Math.max(0, toY - fromY + 1);
        rasterWork += cells;
        segmentBounds.push({ a, b, fromX, fromY, toX, toY });
    }
    const maxRasterWork = Number.isInteger(options.maxRasterWork) && options.maxRasterWork > 0
        ? options.maxRasterWork : PASSAGE_MAX_RASTER_WORK;
    if (!Number.isSafeInteger(rasterWork) || rasterWork > maxRasterWork) {
        return { passage: null, diagnostics: [diagnostic('raster-work-budget-exceeded', itemIndex, id, `Passage rasterization exceeds the ${maxRasterWork}-cell work budget.`)] };
    }
    const grid = new Uint8Array(rasterCells);
    const startEntrance = [];
    const endEntrance = [];
    const fastValue = Number.isInteger(options.fastValue) && options.fastValue > 0 && options.fastValue <= 255
        ? options.fastValue : PASSAGE_FAST_VALUE;
    const boundaryValue = Number.isInteger(options.boundaryValue) && options.boundaryValue > 0 && options.boundaryValue <= 255
        ? options.boundaryValue : PASSAGE_BOUNDARY_VALUE;
    const boundaryBand = Number.isFinite(options.boundaryBand) && options.boundaryBand >= 0
        ? options.boundaryBand : DEFAULT_BOUNDARY_BAND;
    const radiusSquared = radius * radius + EPSILON;
    const start = startPoint;
    const end = endPoint;

    for (const { a, b, fromX, fromY, toX, toY } of segmentBounds) {
        for (let globalY = fromY; globalY <= toY; globalY++) {
            const row = (globalY - minY) * localWidth;
            for (let globalX = fromX; globalX <= toX; globalX++) {
                const startProjection = (globalX - start[0]) * terminalFrames.startInward.x
                    + (globalY - start[1]) * terminalFrames.startInward.y;
                const endProjection = (globalX - end[0]) * terminalFrames.endInward.x
                    + (globalY - end[1]) * terminalFrames.endInward.y;
                if (startProjection < -PASSAGE_PORTAL_DEPTH - EPSILON
                    || endProjection < -PASSAGE_PORTAL_DEPTH - EPSILON) continue;
                const distanceSquared = pointSegmentDistanceSquared(
                    globalX, globalY, a[0], a[1], b[0], b[1],
                );
                if (distanceSquared > radiusSquared) continue;
                const index = row + globalX - minX;
                const clearance = Math.min(
                    radius - Math.sqrt(distanceSquared),
                    startProjection + PASSAGE_PORTAL_DEPTH,
                    endProjection + PASSAGE_PORTAL_DEPTH,
                );
                const isBoundary = boundaryBand > 0 && clearance < boundaryBand - EPSILON;
                // Any segment that sees the pixel as interior wins over a boundary
                // observation, independent of the numeric terrain values supplied.
                if (!isBoundary) grid[index] = fastValue;
                else if (grid[index] === 0) grid[index] = boundaryValue;
            }
        }
    }

    for (let localY = 0; localY < localHeight; localY++) {
        const globalY = minY + localY;
        const row = localY * localWidth;
        for (let localX = 0; localX < localWidth; localX++) {
            const index = row + localX;
            if (grid[index] === 0) continue;
            const globalX = minX + localX;
            const startProjection = (globalX - start[0]) * terminalFrames.startInward.x
                + (globalY - start[1]) * terminalFrames.startInward.y;
            const endProjection = (globalX - end[0]) * terminalFrames.endInward.x
                + (globalY - end[1]) * terminalFrames.endInward.y;
            if (startProjection < -EPSILON) startEntrance.push(index);
            if (endProjection < -EPSILON) endEntrance.push(index);
        }
    }

    // Placement judgment (overlapping or touching bands, entrance terrain) is
    // deliberately left to the coaches. Only a band with no raster cells at
    // all is rejected, because such a passage could never be entered.
    if (!startEntrance.length || !endEntrance.length) {
        return { passage: null, diagnostics: [diagnostic(
            'empty-entrance', itemIndex, id,
            'Each entrance band must contain at least one raster cell inside the map.',
        )] };
    }

    const frozenPoints = Object.freeze(normalizedPoints.map((point) => Object.freeze(point.slice())));
    const bounds = Object.freeze({ minX, minY, maxX, maxY });
    const passage = Object.freeze({
        id,
        points: frozenPoints,
        terminalFrames,
        width,
        bounds,
        localWidth,
        localHeight,
        originX: minX,
        originY: minY,
        grid,
        startEntrance: Uint32Array.from(startEntrance),
        endEntrance: Uint32Array.from(endEntrance),
    });
    return { passage, diagnostics: [], rasterWork };
}

/**
 * Normalize a canonical document (or an items array supplied by a worker
 * message). Unknown versions are ignored safely and never treated as v1.
 */
export function normalizePassagesForRuntime(documentOrItems, options = {}) {
    if (documentOrItems == null) {
        return Object.freeze({ passages: Object.freeze([]), diagnostics: Object.freeze([]), versionSupported: true });
    }
    let items;
    if (Array.isArray(documentOrItems)) {
        items = documentOrItems;
    } else if (documentOrItems && documentOrItems.version === PASSAGE_SCHEMA_VERSION && Array.isArray(documentOrItems.items)) {
        items = documentOrItems.items;
    } else if (documentOrItems && documentOrItems.version !== PASSAGE_SCHEMA_VERSION) {
        return Object.freeze({
            passages: Object.freeze([]),
            diagnostics: Object.freeze([diagnostic('unsupported-version', -1, null, 'Only passage schema version 1 is supported at runtime.')]),
            versionSupported: false,
        });
    } else {
        return Object.freeze({
            passages: Object.freeze([]),
            diagnostics: Object.freeze([diagnostic('invalid-document', -1, null, 'Passage data must be a version-1 document or an items array.')]),
            versionSupported: true,
        });
    }

    const diagnostics = [];
    const passages = [];
    let totalRasterCells = 0;
    let totalRasterWork = 0;
    const maxTotalRasterCells = Number.isInteger(options.maxTotalRasterCells) && options.maxTotalRasterCells > 0
        ? options.maxTotalRasterCells : PASSAGE_MAX_TOTAL_RASTER_CELLS;
    const maxTotalRasterWork = Number.isInteger(options.maxTotalRasterWork) && options.maxTotalRasterWork > 0
        ? options.maxTotalRasterWork : PASSAGE_MAX_TOTAL_RASTER_WORK;
    const ids = new Set();
    const count = Math.min(items.length, PASSAGE_MAX_ITEMS);
    if (items.length > PASSAGE_MAX_ITEMS) {
        diagnostics.push(diagnostic('too-many-items', PASSAGE_MAX_ITEMS, null, `Only the first ${PASSAGE_MAX_ITEMS} passages were considered.`));
    }
    for (let i = 0; i < count; i++) {
        const raw = items[i];
        const id = typeof raw?.id === 'string' ? raw.id : null;
        if (id && ids.has(id)) {
            diagnostics.push(diagnostic('duplicate-id', i, id, 'Duplicate passage id was ignored.'));
            continue;
        }
        const result = rasterizePassage(raw, { ...options, itemIndex: i });
        diagnostics.push(...result.diagnostics);
        if (!result.passage) continue;
        if (totalRasterCells + result.passage.grid.length > maxTotalRasterCells) {
            diagnostics.push(diagnostic(
                'total-raster-budget-exceeded', i, result.passage.id,
                `Passage rasters exceed the ${maxTotalRasterCells}-cell aggregate runtime budget.`,
            ));
            continue;
        }
        if (totalRasterWork + result.rasterWork > maxTotalRasterWork) {
            diagnostics.push(diagnostic(
                'total-raster-work-budget-exceeded', i, result.passage.id,
                `Passage rasterization exceeds the ${maxTotalRasterWork}-cell aggregate work budget.`,
            ));
            continue;
        }
        ids.add(result.passage.id);
        passages.push(result.passage);
        totalRasterCells += result.passage.grid.length;
        totalRasterWork += result.rasterWork;
    }
    return Object.freeze({
        passages: Object.freeze(passages),
        diagnostics: Object.freeze(diagnostics),
        versionSupported: true,
    });
}
