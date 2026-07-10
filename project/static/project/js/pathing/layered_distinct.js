// Surface-aware route distinctness for transient passage classifications.
//
// This module deliberately does not persist surface identity. Saved 2D routes
// are classified on demand with passage_classifier.js. Base-only comparisons
// delegate to distinct.js unchanged so existing route semantics remain exact.

import { routeDistinct } from './distinct.js';
import { classificationFromPassageSpans, classifyRoutePassages } from './passage_classifier.js';

const DEFAULT_PASSAGE_SAMPLE_STEP_PX = 4;
const DEFAULT_PASSAGE_MIN_SEPARATION_PX = 3;
const DEFAULT_PASSAGE_MAX_SEPARATION_PX = 24;
const DEFAULT_PASSAGE_WIDTH_FRACTION = 0.25;
const DEFAULT_PASSAGE_MIN_SEPARATED_SAMPLES = 3;
const DEFAULT_PASSAGE_MIN_SEPARATED_FRACTION = 0.35;
const DEFAULT_PASSAGE_ENDPOINT_FRACTION = 0.1;
const DEFAULT_PASSAGE_MAX_SAMPLES = 64;
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

function classificationForRoute(route, flat, passages, classifierOptions) {
    if (route != null && Object.prototype.hasOwnProperty.call(route, 'passageSpans')
            && Array.isArray(route.passageSpans)) {
        return classificationFromPassageSpans(flat, route.passageSpans);
    }
    return classifyRoutePassages(flat, passages, classifierOptions);
}

function flatToPoints(flat) {
    const points = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
        points.push({ x: flat[i], y: flat[i + 1] });
    }
    return points;
}

function cumulativeDistances(points) {
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
        cumulative.push(cumulative[i - 1]
            + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    }
    return cumulative;
}

function pointAtDistance(points, cumulative, distance) {
    if (points.length === 0) return null;
    if (distance <= 0) return points[0];
    const total = cumulative[cumulative.length - 1];
    if (distance >= total) return points[points.length - 1];
    let low = 0;
    let high = cumulative.length - 1;
    while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (cumulative[middle] <= distance) low = middle;
        else high = middle;
    }
    const span = cumulative[low + 1] - cumulative[low];
    const fraction = span > 0 ? (distance - cumulative[low]) / span : 0;
    const a = points[low];
    const b = points[low + 1];
    return {
        x: a.x + (b.x - a.x) * fraction,
        y: a.y + (b.y - a.y) * fraction,
    };
}

function pointSegmentDistance(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= EPSILON) return Math.hypot(point.x - a.x, point.y - a.y);
    let fraction = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    fraction = Math.max(0, Math.min(1, fraction));
    return Math.hypot(point.x - (a.x + dx * fraction), point.y - (a.y + dy * fraction));
}

function pointPolylineDistance(point, polyline) {
    let distance = Infinity;
    for (let i = 1; i < polyline.length; i++) {
        distance = Math.min(distance, pointSegmentDistance(point, polyline[i - 1], polyline[i]));
    }
    return distance;
}

function positiveNumber(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeFraction(value, fallback) {
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function positiveInteger(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function passageOptions(options) {
    return {
        sampleStepPx: positiveNumber(options.passageSampleStepPx, DEFAULT_PASSAGE_SAMPLE_STEP_PX),
        minSeparationPx: Number.isFinite(options.passageMinSeparationPx)
            && options.passageMinSeparationPx > 0 ? options.passageMinSeparationPx : null,
        minSeparationFloorPx: positiveNumber(
            options.passageMinSeparationFloorPx,
            DEFAULT_PASSAGE_MIN_SEPARATION_PX,
        ),
        maxSeparationPx: positiveNumber(
            options.passageMaxSeparationPx,
            DEFAULT_PASSAGE_MAX_SEPARATION_PX,
        ),
        widthFraction: positiveNumber(options.passageWidthFraction, DEFAULT_PASSAGE_WIDTH_FRACTION),
        minSeparatedSamples: positiveInteger(
            options.passageMinSeparatedSamples,
            DEFAULT_PASSAGE_MIN_SEPARATED_SAMPLES,
        ),
        minSeparatedFraction: nonNegativeFraction(
            options.passageMinSeparatedFraction,
            DEFAULT_PASSAGE_MIN_SEPARATED_FRACTION,
        ),
        endpointFraction: nonNegativeFraction(
            options.passageEndpointFraction,
            DEFAULT_PASSAGE_ENDPOINT_FRACTION,
        ),
        maxSamples: positiveInteger(options.passageMaxSamples, DEFAULT_PASSAGE_MAX_SAMPLES),
    };
}

function surfaceSequence(classification) {
    return classification.legs
        .filter((leg) => leg.surface !== 'base')
        .map((leg) => leg.surface.slice('passage:'.length));
}

function sequencesEqual(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function classificationSummary(classification) {
    return {
        passageSpans: classification.passageSpans.map((span) => ({ ...span })),
        surfaces: classification.legs.map((leg) => leg.surface),
        diagnostics: classification.diagnostics.map((entry) => ({ ...entry })),
    };
}

function passageLegs(classification) {
    return classification.legs.filter((leg) => leg.surface !== 'base');
}

function baseLegs(classification) {
    return classification.legs.filter((leg) => leg.surface === 'base');
}

function separationThreshold(passage, options) {
    if (options.minSeparationPx !== null) return options.minSeparationPx;
    return Math.max(
        options.minSeparationFloorPx,
        Math.min(options.maxSeparationPx, passage.width * options.widthFraction),
    );
}

function directionalSeparation(source, target, threshold, options) {
    const cumulative = cumulativeDistances(source);
    const length = cumulative[cumulative.length - 1];
    if (!(length > 0) || target.length < 2) {
        return { samples: 0, separatedSamples: 0, separatedFraction: 0, maxDistance: 0 };
    }
    const sampleCount = Math.min(
        options.maxSamples,
        Math.max(8, Math.ceil(length / options.sampleStepPx)),
    );
    let samples = 0;
    let separatedSamples = 0;
    let maxDistance = 0;
    for (let i = 1; i < sampleCount; i++) {
        const fraction = i / sampleCount;
        if (fraction < options.endpointFraction || fraction > 1 - options.endpointFraction) continue;
        const point = pointAtDistance(source, cumulative, length * fraction);
        const distance = pointPolylineDistance(point, target);
        samples++;
        maxDistance = Math.max(maxDistance, distance);
        if (distance + EPSILON >= threshold) separatedSamples++;
    }
    return {
        samples,
        separatedSamples,
        separatedFraction: samples > 0 ? separatedSamples / samples : 0,
        maxDistance,
    };
}

function comparePassageLegs(candidateLeg, existingLeg, passage, options) {
    const thresholdPx = separationThreshold(passage, options);
    const candidatePoints = flatToPoints(candidateLeg.points);
    const existingPoints = flatToPoints(existingLeg.points);
    const candidateToExisting = directionalSeparation(
        candidatePoints,
        existingPoints,
        thresholdPx,
        options,
    );
    const existingToCandidate = directionalSeparation(
        existingPoints,
        candidatePoints,
        thresholdPx,
        options,
    );
    const requiredSamples = Math.min(
        options.minSeparatedSamples,
        candidateToExisting.samples,
        existingToCandidate.samples,
    );
    const meaningful = requiredSamples > 0
        && candidateToExisting.separatedSamples >= requiredSamples
        && existingToCandidate.separatedSamples >= requiredSamples
        && candidateToExisting.separatedFraction + EPSILON >= options.minSeparatedFraction
        && existingToCandidate.separatedFraction + EPSILON >= options.minSeparatedFraction;
    return {
        passageId: passage.id,
        meaningful,
        thresholdPx,
        requiredSamples,
        candidateToExisting,
        existingToCandidate,
    };
}

function compareSurroundingBaseLegs(candidateClassification, existingClassification,
    grid, w, h, options) {
    const candidateBase = baseLegs(candidateClassification);
    const existingBase = baseLegs(existingClassification);
    const comparisons = [];
    const count = Math.min(candidateBase.length, existingBase.length);
    for (let i = 0; i < count; i++) {
        const result = routeDistinct(
            candidateBase[i].points,
            [existingBase[i].points],
            grid,
            w,
            h,
            options,
        );
        comparisons.push({ legIndex: i, ...result });
    }
    return {
        distinct: comparisons.some((comparison) => comparison.distinct),
        comparisons,
        candidateBaseLegs: candidateBase.length,
        existingBaseLegs: existingBase.length,
    };
}

function compareClassifiedPair(candidateFlat, candidateClassification, existingFlat,
    existingClassification, grid, w, h, passagesById, options) {
    const candidateSequence = surfaceSequence(candidateClassification);
    const existingSequence = surfaceSequence(existingClassification);
    if (!sequencesEqual(candidateSequence, existingSequence)) {
        return {
            distinct: true,
            reason: 'different surface topology',
            strategy: 'surface-topology',
            candidatePassages: candidateSequence,
            existingPassages: existingSequence,
            passageComparisons: [],
        };
    }

    const legacy = routeDistinct(candidateFlat, [existingFlat], grid, w, h, options);
    if (candidateSequence.length === 0) {
        const comparison = legacy.perRoute?.[0] || legacy;
        return {
            ...comparison,
            distinct: legacy.distinct,
            reason: legacy.reason,
            strategy: 'base-legacy',
            candidatePassages: [],
            existingPassages: [],
            passageComparisons: [],
        };
    }

    const candidateLegList = passageLegs(candidateClassification);
    const existingLegList = passageLegs(existingClassification);
    const localOptions = passageOptions(options);
    const passageComparisons = [];
    for (let i = 0; i < candidateLegList.length; i++) {
        const passageId = candidateSequence[i];
        const passage = passagesById.get(passageId);
        if (!passage) continue;
        passageComparisons.push(comparePassageLegs(
            candidateLegList[i],
            existingLegList[i],
            passage,
            localOptions,
        ));
    }
    if (passageComparisons.some((comparison) => comparison.meaningful)) {
        return {
            distinct: true,
            reason: 'meaningful lateral separation on shared passage',
            strategy: 'passage-lateral',
            candidatePassages: candidateSequence,
            existingPassages: existingSequence,
            passageComparisons,
            legacy,
        };
    }
    const surroundingBase = compareSurroundingBaseLegs(
        candidateClassification,
        existingClassification,
        grid,
        w,
        h,
        options,
    );
    if (surroundingBase.distinct) {
        return {
            distinct: true,
            reason: 'real obstacle between surrounding route portions',
            strategy: 'legacy-surrounding',
            candidatePassages: candidateSequence,
            existingPassages: existingSequence,
            passageComparisons,
            legacy,
            surroundingBase,
        };
    }
    return {
        distinct: false,
        reason: 'no meaningful separation on shared passage',
        strategy: 'same-passage-overlap',
        candidatePassages: candidateSequence,
        existingPassages: existingSequence,
        passageComparisons,
        legacy,
        surroundingBase,
    };
}

/**
 * Compare a candidate 2D mask-coordinate route with existing 2D routes while
 * reconstructing passage surfaces transiently. No returned data is persisted.
 *
 * The signature intentionally mirrors routeDistinct, with normalized passages
 * inserted before the optional settings object.
 */
export function layeredRouteDistinct(candidateRoute, existingRoutes, grid, w, h,
    normalizedPassages, options = {}) {
    const candidateFlat = routeToFlat(candidateRoute);
    if (candidateFlat === null || candidateFlat.length < 4) {
        return { distinct: false, reason: 'empty candidate', comparedRoutes: 0 };
    }
    const validExistingRoutes = (existingRoutes || [])
        .map((route, originalIndex) => ({ flat: routeToFlat(route), originalIndex }))
        .filter((entry) => entry.flat !== null && entry.flat.length >= 4);
    if (validExistingRoutes.length === 0) {
        return { distinct: true, reason: 'first route', comparedRoutes: 0 };
    }

    const passages = Array.isArray(normalizedPassages) ? normalizedPassages : [];
    const candidateClassification = classificationForRoute(
        candidateRoute, candidateFlat, passages, options.classifier,
    );
    const existingClassifications = validExistingRoutes.map((entry) => (
        classificationForRoute(existingRoutes[entry.originalIndex], entry.flat, passages, options.classifier)
    ));

    const allBaseOnly = candidateClassification.passageSpans.length === 0
        && existingClassifications.every((classification) => classification.passageSpans.length === 0);
    if (allBaseOnly) {
        // Exact legacy delegation is deliberate: no additional keys or altered
        // aggregation semantics on the overwhelmingly common no-passage path.
        return routeDistinct(
            candidateFlat,
            validExistingRoutes.map((entry) => entry.flat),
            grid,
            w,
            h,
            options,
        );
    }

    const passagesById = new Map(passages.map((passage) => [passage.id, passage]));
    const perRoute = [];
    for (let i = 0; i < validExistingRoutes.length; i++) {
        const existing = validExistingRoutes[i];
        const comparison = compareClassifiedPair(
            candidateFlat,
            candidateClassification,
            existing.flat,
            existingClassifications[i],
            grid,
            w,
            h,
            passagesById,
            options,
        );
        perRoute.push({
            routeIndex: existing.originalIndex,
            ...comparison,
            existingClassification: classificationSummary(existingClassifications[i]),
        });
        if (!comparison.distinct) {
            return {
                distinct: false,
                reason: comparison.reason,
                comparedRoutes: i + 1,
                mode: 'layered',
                candidateClassification: classificationSummary(candidateClassification),
                perRoute,
            };
        }
    }
    return {
        distinct: true,
        reason: 'surface-aware separation from all existing routes',
        comparedRoutes: validExistingRoutes.length,
        mode: 'layered',
        candidateClassification: classificationSummary(candidateClassification),
        perRoute,
    };
}
