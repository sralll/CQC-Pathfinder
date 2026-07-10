// Reconstruct transient surface identity from an ordinary saved 2D route.
// No classifier output is persisted in Route.rP or any Django model.

import { distanceToPassage, hitTestPassage, passageEntranceAt } from './passage_geometry.js';

const DEFAULT_TOLERANCE = 0.75;
const DEFAULT_MAX_EXCURSION = 1.5;
const DEFAULT_SAMPLE_STEP = 0.5;
const EPSILON = 1e-9;

function routeToFlat(route) {
    if (!Array.isArray(route)) return null;
    if (route.length === 0) return [];
    if (typeof route[0] === 'number') {
        if (route.length % 2 !== 0) return null;
        const flat = route.map(Number);
        return flat.every(Number.isFinite) ? flat : null;
    }
    const flat = [];
    for (const point of route) {
        const x = Array.isArray(point) ? Number(point[0]) : Number(point?.x);
        const y = Array.isArray(point) ? Number(point[1]) : Number(point?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        flat.push(x, y);
    }
    return flat;
}

function sliceFlat(flat, fromIndex, toIndex) {
    return flat.slice(fromIndex * 2, toIndex * 2 + 2);
}

function routeSpanLength(flat, fromIndex, toIndex) {
    let length = 0;
    for (let i = fromIndex + 1; i <= toIndex; i++) {
        length += Math.hypot(flat[i * 2] - flat[(i - 1) * 2], flat[i * 2 + 1] - flat[(i - 1) * 2 + 1]);
    }
    return length;
}

function spanContainment(flat, fromIndex, toIndex, passage, options) {
    const radius = passage.width / 2;
    const tolerance = options.tolerance;
    const sampleStep = options.sampleStep;
    const maxExcursion = options.maxExcursion;
    let outsideRun = 0;

    for (let i = fromIndex + 1; i <= toIndex; i++) {
        const ax = flat[(i - 1) * 2];
        const ay = flat[(i - 1) * 2 + 1];
        const bx = flat[i * 2];
        const by = flat[i * 2 + 1];
        const segmentLength = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(segmentLength / sampleStep));
        const distancePerStep = segmentLength / steps;
        for (let step = i === fromIndex + 1 ? 0 : 1; step <= steps; step++) {
            const t = step / steps;
            const x = ax + (bx - ax) * t;
            const y = ay + (by - ay) * t;
            const distance = distanceToPassage(passage, x, y);
            if (distance > radius + tolerance + EPSILON) {
                return { valid: false, reason: 'outside-tolerance', atIndex: i - 1, x, y };
            }
            if (distance > radius + EPSILON) {
                outsideRun += distancePerStep;
                if (outsideRun > maxExcursion + EPSILON) {
                    return { valid: false, reason: 'side-exit', atIndex: i - 1, x, y };
                }
            } else {
                outsideRun = 0;
            }
        }
    }
    return { valid: true };
}

function entranceRuns(flat, passage, tolerance) {
    const runs = [];
    let activeType = 0;
    let activeFrom = 0;
    const count = flat.length / 2;
    for (let i = 0; i < count; i++) {
        const type = passageEntranceAt(passage, flat[i * 2], flat[i * 2 + 1], tolerance);
        if (type === activeType) continue;
        if (activeType !== 0) runs.push({ type: activeType, fromIndex: activeFrom, toIndex: i - 1 });
        activeType = type;
        activeFrom = i;
    }
    if (activeType !== 0) runs.push({ type: activeType, fromIndex: activeFrom, toIndex: count - 1 });
    return runs;
}

function candidatesForPassage(flat, passage, options, diagnostics) {
    const runs = entranceRuns(flat, passage, options.tolerance);
    const candidates = [];
    const rejected = [];
    for (let first = 0; first < runs.length; first++) {
        const fromRun = runs[first];
        if (fromRun.type !== 1 && fromRun.type !== 2) continue;
        for (let second = first + 1; second < runs.length; second++) {
            const toRun = runs[second];
            if (toRun.type !== 1 && toRun.type !== 2 || toRun.type === fromRun.type) continue;
            const fromIndex = fromRun.fromIndex;
            const toIndex = toRun.toIndex;
            const containment = spanContainment(flat, fromIndex, toIndex, passage, options);
            if (!containment.valid) {
                rejected.push({ passageId: passage.id, fromIndex, toIndex, reason: containment.reason, atIndex: containment.atIndex });
                continue;
            }
            candidates.push({
                passageId: passage.id,
                surface: `passage:${passage.id}`,
                fromIndex,
                toIndex,
                length: routeSpanLength(flat, fromIndex, toIndex),
                direction: fromRun.type === 1 ? 'forward' : 'reverse',
            });
        }
    }

    if (candidates.length === 0) {
        let touchesFootprint = false;
        let touchesStart = false;
        let touchesEnd = false;
        for (let i = 0; i < flat.length; i += 2) {
            const x = flat[i];
            const y = flat[i + 1];
            if (hitTestPassage(passage, x, y, options.tolerance)) touchesFootprint = true;
            const entrance = passageEntranceAt(passage, x, y, options.tolerance);
            if (entrance & 1) touchesStart = true;
            if (entrance & 2) touchesEnd = true;
        }
        if (rejected.length) {
            diagnostics.push({ code: 'rejected-complete-span', passageId: passage.id, rejected });
        } else if (touchesStart && !touchesEnd || touchesEnd && !touchesStart) {
            const last = flat.length >= 2
                ? hitTestPassage(passage, flat[flat.length - 2], flat[flat.length - 1], options.tolerance)
                : false;
            diagnostics.push({
                code: last ? 'terminates-in-passage' : 'same-entrance-or-incomplete',
                passageId: passage.id,
            });
        } else if (touchesFootprint && !touchesStart && !touchesEnd) {
            diagnostics.push({ code: 'middle-only', passageId: passage.id });
        } else if (touchesStart && touchesEnd) {
            diagnostics.push({ code: 'ambiguous-entrance-overlap', passageId: passage.id });
        }
    }
    return candidates;
}

function intervalsConflict(a, b) {
    // Sharing one transition point is legal: passage A -> base -> passage B.
    return a.fromIndex < b.toIndex && b.fromIndex < a.toIndex;
}

function selectCandidates(candidates) {
    candidates.sort((a, b) => {
        if (Math.abs(a.length - b.length) > EPSILON) return b.length - a.length;
        const idOrder = a.passageId.localeCompare(b.passageId);
        if (idOrder !== 0) return idOrder;
        if (a.fromIndex !== b.fromIndex) return a.fromIndex - b.fromIndex;
        return a.toIndex - b.toIndex;
    });
    const selected = [];
    for (const candidate of candidates) {
        if (!selected.some((existing) => intervalsConflict(candidate, existing))) selected.push(candidate);
    }
    selected.sort((a, b) => a.fromIndex - b.fromIndex
        || a.toIndex - b.toIndex
        || a.passageId.localeCompare(b.passageId));
    return selected;
}

function buildLegs(flat, selected) {
    if (flat.length === 0) return [];
    if (selected.length === 0) return [{ surface: 'base', points: flat.slice() }];
    const legs = [];
    let cursor = 0;
    let previousWasPassage = false;
    for (const span of selected) {
        if (span.fromIndex > cursor || previousWasPassage) {
            legs.push({ surface: 'base', points: sliceFlat(flat, cursor, span.fromIndex) });
        }
        legs.push({ surface: span.surface, points: sliceFlat(flat, span.fromIndex, span.toIndex) });
        cursor = span.toIndex;
        previousWasPassage = true;
    }
    if (cursor < flat.length / 2 - 1) {
        legs.push({ surface: 'base', points: sliceFlat(flat, cursor, flat.length / 2 - 1) });
    }
    return legs;
}

/**
 * Build the same transient typed-leg contract from authoritative worker spans.
 * An explicit empty array is meaningful: the layered search stayed on base
 * even if the flattened projection could later look like a passage traversal.
 */
export function classificationFromPassageSpans(route, rawSpans) {
    const flat = routeToFlat(route);
    if (flat === null || !Array.isArray(rawSpans)) {
        return {
            legs: [], passageSpans: [],
            diagnostics: [{ code: 'invalid-authoritative-spans' }],
        };
    }
    const pointCount = flat.length / 2;
    const selected = rawSpans.map((span) => ({
        passageId: String(span?.passageId || ''),
        surface: `passage:${String(span?.passageId || '')}`,
        fromIndex: Number(span?.fromIndex),
        toIndex: Number(span?.toIndex),
    })).sort((a, b) => a.fromIndex - b.fromIndex
        || a.toIndex - b.toIndex || a.passageId.localeCompare(b.passageId));
    const valid = selected.every((span, index) => span.passageId
        && Number.isInteger(span.fromIndex) && Number.isInteger(span.toIndex)
        && span.fromIndex >= 0 && span.toIndex > span.fromIndex && span.toIndex < pointCount
        && (index === 0 || !intervalsConflict(selected[index - 1], span)));
    if (!valid) {
        return {
            legs: flat.length ? [{ surface: 'base', points: flat.slice() }] : [],
            passageSpans: [],
            diagnostics: [{ code: 'invalid-authoritative-spans' }],
        };
    }
    const passageSpans = selected.map(({ passageId, fromIndex, toIndex }) => ({
        passageId, fromIndex, toIndex,
    }));
    return { legs: buildLegs(flat, selected), passageSpans, diagnostics: [] };
}

/**
 * Classify a saved/generated 2D route into transient surface-aware legs.
 * Every input coordinate is preserved verbatim and in order; no point is
 * simplified, moved, or persisted.
 */
export function classifyRoutePassages(route, normalizedPassages, rawOptions = {}) {
    const flat = routeToFlat(route);
    if (flat === null) {
        return {
            legs: [],
            passageSpans: [],
            diagnostics: [{ code: 'invalid-route', detail: 'Route must contain only finite 2D coordinates.' }],
        };
    }
    if (flat.length < 4 || !Array.isArray(normalizedPassages) || normalizedPassages.length === 0) {
        return {
            legs: flat.length ? [{ surface: 'base', points: flat.slice() }] : [],
            passageSpans: [],
            diagnostics: [],
        };
    }

    const options = {
        tolerance: Number.isFinite(rawOptions.tolerance) && rawOptions.tolerance >= 0
            ? rawOptions.tolerance : DEFAULT_TOLERANCE,
        maxExcursion: Number.isFinite(rawOptions.maxExcursion) && rawOptions.maxExcursion >= 0
            ? rawOptions.maxExcursion : DEFAULT_MAX_EXCURSION,
        sampleStep: Number.isFinite(rawOptions.sampleStep) && rawOptions.sampleStep > 0
            ? rawOptions.sampleStep : DEFAULT_SAMPLE_STEP,
    };
    const diagnostics = [];
    const candidates = [];
    const passages = normalizedPassages.slice().sort((a, b) => a.id.localeCompare(b.id));
    for (const passage of passages) {
        candidates.push(...candidatesForPassage(flat, passage, options, diagnostics));
    }
    const selected = selectCandidates(candidates);
    const passageSpans = selected.map((span) => ({
        passageId: span.passageId,
        fromIndex: span.fromIndex,
        toIndex: span.toIndex,
    }));
    return {
        legs: buildLegs(flat, selected),
        passageSpans,
        diagnostics,
    };
}
