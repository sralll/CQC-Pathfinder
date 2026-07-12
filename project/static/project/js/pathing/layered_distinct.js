// Surface-aware route distinctness for transient passage classifications.
//
// This module deliberately does not persist surface identity. Saved 2D routes
// are classified on demand with passage_classifier.js. Base-only comparisons
// delegate to distinct.js unchanged so existing route semantics remain exact.

import { routeDistinct } from './distinct.js';
import { classificationFromPassageSpans, classifyRoutePassages } from './passage_classifier.js';

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

function baseLegs(classification) {
    return classification.legs.filter((leg) => leg.surface === 'base');
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
    existingClassification, grid, w, h, options) {
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

    // A passage is one route choice, regardless of where each refined line runs
    // inside its corridor. Only compare the surrounding base-surface legs for
    // real obstacle separation; the level-0 mask beneath a passage is irrelevant.
    const passageComparisons = candidateSequence.map((passageId) => ({
        passageId,
        ignoredForDistinctness: true,
    }));
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
        reason: 'differences confined to shared passages',
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
