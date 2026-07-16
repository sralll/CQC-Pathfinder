/* Shared adaptive route-stroke model for result/play map views. */
(function exposeRouteStrokeScale(global) {
    const STROKE_MULTIPLIER = 2.5;
    const SCALE_EXPONENT = 0.33;
    const MIN_MAP_ZOOM = 0.05;

    function positiveScale(value, fallback = 1) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    // The route grows on screen as the map is zoomed, but only with the cube
    // root of the map zoom. Map details therefore grow much faster than the
    // route while zooming in, while the route stays legible when zoomed out.
    function screenWidth(baseWidth, mapZoom) {
        const safeZoom = Math.max(positiveScale(mapZoom), MIN_MAP_ZOOM);
        return Number(baseWidth) * STROKE_MULTIPLIER * Math.pow(safeZoom, SCALE_EXPONENT);
    }

    // Some views zoom an HTML ancestor; others commit zoom into an SVG
    // transform with non-scaling-stroke. renderScale is only the transform
    // that still scales the stroke itself, so both rendering paths can share
    // the same desired screen width.
    function attributeWidth(baseWidth, mapZoom, renderScale = 1) {
        return screenWidth(baseWidth, mapZoom) / positiveScale(renderScale);
    }

    global.RouteStrokeScale = Object.freeze({
        attributeWidth,
        screenWidth,
    });
})(typeof window === 'undefined' ? globalThis : window);
