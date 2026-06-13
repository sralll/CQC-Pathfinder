const { Buffer } = require("buffer");
const { readOcad, ocadToSvg } = require("ocad2geojson");

const MAX_RASTER_DIMENSION = 6000;
const REFERENCE_MAP_SCALE = 4000;
const REFERENCE_METERS_PER_PIXEL = 0.48;
const OCAD_UNITS_PER_METER_ON_PAPER = 100 * 1000;
const RUN_SPEED = 4.75;
const PX_TO_M = 0.48;
const NOA_CLUSTER_WINDOW_M = 20;
const NOA_COUNTER_TURN_WINDOW_M = 10;
const NOA_ARTIFACT_WINDOW_M = 3;
const NOA_MIN_SEGMENT_M = 1.5;
const NOA_CORNER_DEG = 60;
const NOA_EPSILON_DEG = 2;
const NOA_MIN_EFFECT_DEG = 30;
const NOA_COUNTER_MIN_DEG = 30;
const ROUTE_POINT_MIN_DISTANCE = 2;
const COURSE_DISPLAY_EXCLUDED_SYMS = new Set([
  701000,
  702000,
  703000,
  704000,
  704001,
  705000,
  706000,
  707000,
  720000,
  721000,
  760000,
  10602010,
]);

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseObjectString(objectString) {
  const result = {};
  const parts = String(objectString || "").split("\t").filter(Boolean);
  if (parts.length) result._first = parts[0];
  for (const part of parts.slice(1)) {
    const key = part.slice(0, 1);
    const value = part.slice(1);
    if (!key) continue;
    if (result[key] === undefined) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

function coordinateToPixel(coord, bounds, scale) {
  const x = Number(coord[0]);
  const y = Number(coord[1]);
  return {
    x: Math.round((x - bounds[0]) * scale * 100) / 100,
    y: Math.round((bounds[3] - y) * scale * 100) / 100,
  };
}

function scalePoint(point, scale) {
  return {
    x: Math.round(point.x * scale * 100) / 100,
    y: Math.round(point.y * scale * 100) / 100,
  };
}

function coordinateToEditorPixel(coord, bounds, rasterScale, editorScale) {
  return scalePoint(coordinateToPixel(coord, bounds, rasterScale), editorScale);
}

function getOcadMapScale(ocadFile) {
  const crs = ocadFile.getCrs();
  const scale = Number(crs.scale);
  return Number.isFinite(scale) && scale > 1 ? scale : REFERENCE_MAP_SCALE;
}

function computeEditorScale(mapScale, rasterScale, calibrationFactor) {
  const metersPerRasterPixel = mapScale / OCAD_UNITS_PER_METER_ON_PAPER / rasterScale;
  return (
    metersPerRasterPixel *
    REFERENCE_MAP_SCALE /
    mapScale /
    REFERENCE_METERS_PER_PIXEL *
    calibrationFactor
  );
}

function isCourseDisplayObject(object) {
  return COURSE_DISPLAY_EXCLUDED_SYMS.has(Number(object.sym));
}

function makeRenderableObjectFilter(ocadFile) {
  const symbolByNumber = new Map((ocadFile.symbols || []).map((symbol) => [Number(symbol.symNum), symbol]));
  return (object) => {
    if (isCourseDisplayObject(object)) return false;
    const symbol = symbolByNumber.get(Number(object.sym));
    return !symbol || Number(symbol.status || 0) === 0;
  };
}

function extractControlPoints(ocadFile, bounds, rasterScale, editorScale) {
  const points = {};

  for (const object of ocadFile.objects || []) {
    if (!object.objectString || !object.coordinates?.length) continue;
    const parsed = parseObjectString(object.objectString);
    const id = firstValue(parsed.a);
    const kind = firstValue(parsed.Y);
    if (!id || points[id]) continue;

    const coord = object.coordinates[0];
    const rasterPixel = coordinateToPixel(coord, bounds, rasterScale);
    points[id] = {
      id,
      kind: kind || "",
      sym: object.sym,
      raw: { x: Number(coord[0]), y: Number(coord[1]) },
      raster_pixel: rasterPixel,
      pixel: scalePoint(rasterPixel, editorScale),
      objectString: object.objectString,
    };
  }

  return points;
}

function extractCourses(ocadFile) {
  const courseEntries = ocadFile.parameterStrings?.["2"] || [];
  return courseEntries.map((entry) => ({
    name: entry._first || "",
    start: firstValue(entry.s) || null,
    controls: normalizeList(entry.c),
    markedRoutes: normalizeList(entry.m),
    finish: firstValue(entry.f) || null,
    tokens: (entry._pairs || [])
      .filter((pair) => ["s", "c", "m", "f"].includes(pair.code))
      .map((pair) => ({ code: pair.code, value: pair.value })),
    climb: entry.C || null,
  }));
}

function buildCourseLegs(course) {
  const legs = [];
  let from = null;
  let marked = [];

  for (const token of course.tokens || []) {
    if (token.code === "m") {
      if (token.value) marked.push(token.value);
      continue;
    }
    if (!["s", "c", "f"].includes(token.code) || !token.value) continue;
    if (from) legs.push({ from, to: token.value, markedRoutes: marked });
    from = token.value;
    marked = [];
  }

  return legs;
}

function routePointKey(point) {
  return `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`;
}

function appendRoutePoints(target, points) {
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const prev = target[target.length - 1];
    if (prev && Math.hypot(prev.x - point.x, prev.y - point.y) < ROUTE_POINT_MIN_DISTANCE) continue;
    target.push(point);
  }
}

function calcRouteLength(route) {
  const pts = route.rP;
  if (!pts || pts.length < 2) {
    route.length = 0;
    return;
  }
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) * PX_TO_M;
  }
  route.length = Math.round(total);
}

function normalizeTurnRad(angle) {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

function roundNoA(value) {
  return Math.round(value * 10) / 10;
}

function simplifiedNoAPoints(points) {
  const minStep = NOA_MIN_SEGMENT_M / PX_TO_M;
  const out = [];
  for (const point of points || []) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    const current = { x: point.x, y: point.y };
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(current.x - prev.x, current.y - prev.y) >= minStep) out.push(current);
  }
  const last = points?.[points.length - 1];
  if (out.length && last && Number.isFinite(last.x) && Number.isFinite(last.y)) {
    out[out.length - 1] = { x: last.x, y: last.y };
  }
  return out;
}

function calcRouteNoA(route, scale) {
  const rP = simplifiedNoAPoints(route.rP);
  if (!rP || rP.length < 3) {
    route.noA = 0;
    return;
  }

  const epsRad = (NOA_EPSILON_DEG * Math.PI) / 180;
  const cum = [0];
  const headings = [];
  const segLen = [];

  for (let i = 1; i < rP.length; i++) {
    const dx = rP[i].x - rP[i - 1].x;
    const dy = rP[i].y - rP[i - 1].y;
    const len = Math.hypot(dx, dy) * PX_TO_M;
    cum.push(cum[i - 1] + len);
    segLen.push(len);
    headings.push(dx === 0 && dy === 0 ? null : Math.atan2(dy, dx));
  }

  const turns = [];
  for (let i = 1; i < headings.length; i++) {
    const h1 = headings[i - 1];
    const h2 = headings[i];
    if (h1 === null || h2 === null) continue;
    const signed = normalizeTurnRad(h2 - h1);
    const abs = Math.abs(signed);
    if (abs < epsRad) continue;
    if (Math.min(segLen[i - 1], segLen[i]) < NOA_MIN_SEGMENT_M) continue;
    turns.push({ pos: cum[i], signedDeg: (signed * 180) / Math.PI, absDeg: (abs * 180) / Math.PI });
  }

  let noA = 0;
  for (let i = 0; i < turns.length;) {
    const cluster = [turns[i++]];
    while (i < turns.length && turns[i].pos - cluster[0].pos <= NOA_CLUSTER_WINDOW_M) {
      cluster.push(turns[i++]);
    }

    const span = cluster[cluster.length - 1].pos - cluster[0].pos;
    const totalAbs = cluster.reduce((sum, turn) => sum + turn.absDeg, 0);
    const net = Math.abs(cluster.reduce((sum, turn) => sum + turn.signedDeg, 0));
    const maxTurn = Math.max(...cluster.map((turn) => turn.absDeg));
    if (span <= NOA_ARTIFACT_WINDOW_M && net < NOA_MIN_EFFECT_DEG && totalAbs >= NOA_CORNER_DEG) continue;

    const directionDeg = Math.max(maxTurn, net);
    if (directionDeg >= NOA_MIN_EFFECT_DEG || totalAbs >= NOA_CORNER_DEG) {
      noA += directionDeg / NOA_CORNER_DEG;
    }

    let counterDeg = 0;
    for (let j = 0; j < cluster.length; j++) {
      let localAbs = 0;
      let localNet = 0;
      for (let k = j; k < cluster.length; k++) {
        if (cluster[k].pos - cluster[j].pos > NOA_COUNTER_TURN_WINDOW_M) break;
        localAbs += cluster[k].absDeg;
        localNet += cluster[k].signedDeg;
      }
      counterDeg = Math.max(counterDeg, localAbs - Math.abs(localNet));
    }
    if (counterDeg >= NOA_COUNTER_MIN_DEG) {
      noA += counterDeg / (2 * NOA_CORNER_DEG);
    }
  }

  route.noA = roundNoA(noA);
}

function calcRouteRunTime(route) {
  const length = route.length;
  const elevation = route.elevation;
  if (length == null || length === 0) {
    route.run_time = null;
    return;
  }
  const noAPenalty = route.noA || 0;
  if (!elevation) {
    route.run_time = length / RUN_SPEED + noAPenalty;
    return;
  }
  const gradient = (elevation / length) * 100;
  const gapUp = 0.0017 * gradient ** 2 + 0.02901 * gradient + 0.99387;
  const gapDown = 0.0017 * gradient ** 2 - 0.02901 * gradient + 0.99387;
  const adjSpeed = RUN_SPEED / ((gapUp + gapDown) / 2);
  route.run_time = length / adjSpeed + noAPenalty;
}

function calcRouteSide(cp, route) {
  const rP = route.rP;
  if (!rP?.length || !cp.start || !cp.ziel) {
    route.pos = null;
    return;
  }
  const dx = cp.ziel.x - cp.start.x;
  const dy = cp.ziel.y - cp.start.y;
  let sum = 0;
  for (const p of rP) {
    sum += dx * (p.y - cp.start.y) - dy * (p.x - cp.start.x);
  }
  route.pos = sum / rP.length;
}

function makeRoute(rP, cp, order, scale, source) {
  const route = {
    id: null,
    order,
    rP,
    noA: null,
    pos: null,
    length: null,
    run_time: null,
    elevation: 0,
    source,
  };
  calcRouteLength(route);
  calcRouteNoA(route, scale);
  calcRouteRunTime(route);
  calcRouteSide(cp, route);
  return route;
}

function isActualRouteObject(object, symbolByNumber) {
  const sym = Number(object.sym);
  const symbol = symbolByNumber.get(sym);
  const description = String(symbol?.description || "").toLowerCase();
  return sym === 10602010 || description === "fastest route";
}

function buildActualRouteIndex(ocadFile, bounds, rasterScale, editorScale) {
  const segments = new Map();
  const symbolByNumber = new Map((ocadFile.symbols || []).map((symbol) => [Number(symbol.symNum), symbol]));

  for (const object of ocadFile.objects || []) {
    if (!isActualRouteObject(object, symbolByNumber)) continue;
    const parsed = parseObjectString(object.objectString);
    const points = (object.coordinates || [])
      .map((coord) => coordinateToEditorPixel(coord, bounds, rasterScale, editorScale));
    const from = firstValue(parsed.f);
    const to = firstValue(parsed.t);
    if (!from || !to || points.length < 2) continue;
    const key = `${from}->${to}`;
    if (!segments.has(key)) segments.set(key, []);
    segments.get(key).push({
      routeOrder: Number(parsed._first || 0),
      from,
      to,
      points,
      objectString: object.objectString || "",
      label: firstValue(parsed.n) || "",
      rawLengthTime: firstValue(parsed.c) || "",
    });
  }

  return { segments };
}

function findActualRouteSegment(index, from, to) {
  const entries = index.segments.get(`${from}->${to}`) || [];
  return entries[0] || null;
}

function buildLegPolyline(leg, course, points, routeIndex) {
  const start = points[leg.from];
  const end = points[leg.to];
  if (!start || !end) return null;

  const rP = [];
  appendRoutePoints(rP, [start.pixel]);

  let cursor = leg.from;
  let matchedSegments = 0;
  for (const markedId of leg.markedRoutes || []) {
    const entry = findActualRouteSegment(routeIndex, cursor, markedId);
    if (entry) {
      appendRoutePoints(rP, entry.points);
      matchedSegments++;
    }
    cursor = markedId;
  }

  const exit = findActualRouteSegment(routeIndex, cursor, leg.to);
  if (exit) {
    appendRoutePoints(rP, exit.points);
    matchedSegments++;
  }
  if (!matchedSegments) return null;
  appendRoutePoints(rP, [end.pixel]);

  return rP.length >= 2 ? rP : null;
}

function routeGeometryKey(rP) {
  return rP.map(routePointKey).join("|");
}

function buildControlPairs(courses, points, routeIndex, editorScale) {
  const seen = new Set();
  const byLeg = new Map();
  const controlPairs = [];

  for (const course of courses) {
    for (const leg of buildCourseLegs(course)) {
      const { from, to } = leg;
      if (!points[from] || !points[to]) continue;
      const key = `${from}->${to}`;
      let cp = byLeg.get(key);
      if (!cp) {
        if (seen.has(key)) continue;
        seen.add(key);
        cp = {
          order: controlPairs.length,
          start: points[from].pixel,
          ziel: points[to].pixel,
          complex: false,
          routes: [],
          source: {
            from,
            to,
            first_course: course.name,
          },
          _routeKeys: new Set(),
        };
        byLeg.set(key, cp);
        controlPairs.push(cp);
      }

      const rP = buildLegPolyline(leg, course, points, routeIndex);
      if (!rP) continue;
      const routeKey = routeGeometryKey(rP);
      if (cp._routeKeys.has(routeKey)) continue;
      cp._routeKeys.add(routeKey);
      cp.routes.push(makeRoute(rP, cp, cp.routes.length, editorScale, {
        course: course.name,
        from,
        to,
        marked_routes: leg.markedRoutes || [],
      }));
      if (cp.routes.length > 1) cp.complex = true;
    }
  }

  for (const cp of controlPairs) delete cp._routeKeys;
  return controlPairs;
}

async function renderSvgPreview(file, options = {}) {
  const calibrationFactor = Number(options.scaleFactor || 1);
  const buffer = Buffer.from(await file.arrayBuffer());
  const ocadFile = await readOcad(buffer);
  const mapScale = getOcadMapScale(ocadFile);
  const bounds = ocadFile.getBounds();
  const widthUnits = bounds[2] - bounds[0];
  const heightUnits = bounds[3] - bounds[1];
  const rasterScale = Math.min(
    MAX_RASTER_DIMENSION / widthUnits,
    MAX_RASTER_DIMENSION / heightUnits
  );
  const editorScale = computeEditorScale(mapScale, rasterScale, calibrationFactor);
  const metersPerRasterPixel = mapScale / OCAD_UNITS_PER_METER_ON_PAPER / rasterScale;
  const width = Math.max(1, Math.round(widthUnits * rasterScale));
  const height = Math.max(1, Math.round(heightUnits * rasterScale));
  const objects = (ocadFile.objects || []).filter(makeRenderableObjectFilter(ocadFile));
  const svg = ocadToSvg(ocadFile, {
    document,
    exportHidden: true,
    objects,
    fill: "transparent",
  });
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", String(bounds[0]));
  background.setAttribute("y", String(bounds[1]));
  background.setAttribute("width", String(widthUnits));
  background.setAttribute("height", String(heightUnits));
  background.setAttribute("fill", "#ffffff");
  svg.insertBefore(background, svg.querySelector("g"));

  svg.setAttribute("id", "map-svg-preview");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  svg.style.display = "block";
  svg.style.background = "#ffffff";
  svg.style.pointerEvents = "none";
  svg.style.userSelect = "none";

  const controlPoints = extractControlPoints(ocadFile, bounds, rasterScale, editorScale);
  const courses = extractCourses(ocadFile);
  const routeIndex = buildActualRouteIndex(ocadFile, bounds, rasterScale, editorScale);
  const controlPairs = buildControlPairs(courses, controlPoints, routeIndex, editorScale);
  const actualRouteSegments = Array.from(routeIndex.segments.values())
    .reduce((sum, entries) => sum + entries.length, 0);

  return {
    svg,
    width,
    height,
    scale: editorScale,
    scaled: true,
    control_pairs: controlPairs,
    ocad: {
      courses: courses.length,
      controls: Object.keys(controlPoints).length,
      width,
      height,
      map_scale: mapScale,
      scale_calibration_factor: calibrationFactor,
      meters_per_raster_pixel: metersPerRasterPixel,
      actual_route_segments: actualRouteSegments,
    },
  };
}

window.OcadBrowser = {
  renderSvgPreview,
};
