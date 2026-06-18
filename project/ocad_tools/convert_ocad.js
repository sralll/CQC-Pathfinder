const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { DOMImplementation, XMLSerializer } = require("xmldom");
const { readOcad, ocadToSvg } = require("ocad2geojson");

const execFileAsync = promisify(execFile);
const MAX_RASTER_DIMENSION = 6000;
const TRAIN_SCALE = 0.710;
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
  701000, // start
  702000, // map issue point
  703000, // control
  704000, // control number
  704001, // control number variant
  705000, // connection line
  706000, // finish
  707000, // marked route
  720000, // course title/description text
  721000,
  760000,
  10602010, // fastest route
]);
const MASK_VALUES = {
  impassable: 0,
  verySlow: 135,
  slow: 231,
  cross: 241,
  fast: 243,
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[i + 1];
    i++;
  }
  return args;
}

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

function mapScaleFactor(mapScale) {
  const value = Number(mapScale);
  return Number.isFinite(value) && value > 0 ? value / REFERENCE_MAP_SCALE : 1;
}

function routeMetresPerEditorPx(mapScale) {
  return PX_TO_M * mapScaleFactor(mapScale);
}

function installSerializableIdSetter(dom) {
  const probe = dom.createElementNS("http://www.w3.org/2000/svg", "g");
  const proto = Object.getPrototypeOf(probe);
  const existing = Object.getOwnPropertyDescriptor(proto, "id");
  if (existing?.set) return;
  Object.defineProperty(proto, "id", {
    get() {
      return this.getAttribute("id") || "";
    },
    set(value) {
      if (value == null || value === "") this.removeAttribute("id");
      else this.setAttribute("id", String(value));
    },
  });
}

function isCourseDisplayObject(object) {
  return COURSE_DISPLAY_EXCLUDED_SYMS.has(Number(object.sym));
}

function makeRenderableObjectFilter(ocadFile) {
  const symbolByNumber = new Map((ocadFile.symbols || []).map((symbol) => [Number(symbol.symNum), symbol]));
  return (object) => {
    if (isCourseDisplayObject(object)) return false;
    if (isActualRouteObject(object, symbolByNumber)) return false;
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

function calcRouteLength(route, mapScale = REFERENCE_MAP_SCALE) {
  const pts = route.rP;
  if (!pts || pts.length < 2) {
    route.length = 0;
    return;
  }
  let total = 0;
  const metresPerPx = routeMetresPerEditorPx(mapScale);
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) * metresPerPx;
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

function simplifiedNoAPoints(points, mapScale = REFERENCE_MAP_SCALE) {
  const minStep = NOA_MIN_SEGMENT_M / routeMetresPerEditorPx(mapScale);
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

function calcRouteNoA(route, mapScale = REFERENCE_MAP_SCALE) {
  const rP = simplifiedNoAPoints(route.rP, mapScale);
  if (!rP || rP.length < 3) {
    route.noA = 0;
    return;
  }

  const epsRad = (NOA_EPSILON_DEG * Math.PI) / 180;
  const cum = [0];
  const headings = [];
  const segLen = [];
  const metresPerPx = routeMetresPerEditorPx(mapScale);

  for (let i = 1; i < rP.length; i++) {
    const dx = rP[i].x - rP[i - 1].x;
    const dy = rP[i].y - rP[i - 1].y;
    const len = Math.hypot(dx, dy) * metresPerPx;
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

function makeRoute(rP, cp, order, mapScale, source) {
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
  calcRouteLength(route, mapScale);
  calcRouteNoA(route, mapScale);
  calcRouteRunTime(route);
  calcRouteSide(cp, route);
  return route;
}

function isActualRouteObject(object, symbolByNumber) {
  const sym = Number(object.sym);
  if (sym === 10602010) return true;
  const symbol = symbolByNumber.get(sym);
  if (!symbol || Number(symbol.type) !== 2) return false;
  // Covers "Fastest route", "Shortest Route", "Alternative Routes", etc.
  return /\broutes?\b/i.test(symbol.description || "");
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

function attachActualRoutesToControlPair(cp, from, to, points, routeIndex, mapScale) {
  const entries = routeIndex.segments.get(`${from}->${to}`) || [];
  const sortedEntries = [...entries].sort((a, b) => (a.routeOrder || 0) - (b.routeOrder || 0));
  if (!cp._routeKeys) cp._routeKeys = new Set();
  for (const entry of sortedEntries) {
    const rP = [];
    appendRoutePoints(rP, [points[from].pixel]);
    appendRoutePoints(rP, entry.points || []);
    appendRoutePoints(rP, [points[to].pixel]);
    if (rP.length < 2) continue;
    const routeKey = routeGeometryKey(rP);
    if (cp._routeKeys.has(routeKey)) continue;
    cp._routeKeys.add(routeKey);
    cp.routes.push(makeRoute(rP, cp, cp.routes.length, mapScale, {
      from,
      to,
      fallback: "actual_route_segments",
      label: entry.label || "",
    }));
  }
  cp.complex = cp.routes.length > 1;
}

function nearestControlPoint(pixel, points, maxDistance) {
  let bestId = null;
  let bestDistance = maxDistance;
  for (const [id, point] of Object.entries(points)) {
    const dist = Math.hypot(pixel.x - point.pixel.x, pixel.y - point.pixel.y);
    if (dist <= bestDistance) {
      bestDistance = dist;
      bestId = id;
    }
  }
  return bestId;
}

function buildControlPairsFromDisplayLines(ocadFile, bounds, rasterScale, editorScale, points, routeIndex, mapScale) {
  const controlPairs = [];
  const seen = new Set();
  const pointLookup = { ...points };
  const editorDiag = Math.hypot((bounds[2] - bounds[0]) * rasterScale * editorScale, (bounds[3] - bounds[1]) * rasterScale * editorScale);
  const snapDistance = Math.max(20, editorDiag * 0.012);

  for (const [index, object] of (ocadFile.objects || []).entries()) {
    if (Number(object.sym) !== 705000 || !object.coordinates?.length) continue;
    const startPixel = coordinateToEditorPixel(object.coordinates[0], bounds, rasterScale, editorScale);
    const endPixel = coordinateToEditorPixel(object.coordinates[object.coordinates.length - 1], bounds, rasterScale, editorScale);
    let from = nearestControlPoint(startPixel, pointLookup, snapDistance);
    let to = nearestControlPoint(endPixel, pointLookup, snapDistance);
    if (!from) {
      from = `__display_${index}_from`;
      pointLookup[from] = { id: from, pixel: startPixel };
    }
    if (!to) {
      to = `__display_${index}_to`;
      pointLookup[to] = { id: to, pixel: endPixel };
    }
    if (from === to) {
      from = `__display_${index}_from`;
      pointLookup[from] = { id: from, pixel: startPixel };
    }
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cp = {
      order: controlPairs.length,
      start: pointLookup[from].pixel,
      ziel: pointLookup[to].pixel,
      complex: false,
      routes: [],
      source: {
        from,
        to,
        fallback: "course_display_lines",
      },
      _routeKeys: new Set(),
    };
    attachActualRoutesToControlPair(cp, from, to, pointLookup, routeIndex, mapScale);
    cp.complex = cp.routes.length > 1;
    delete cp._routeKeys;
    controlPairs.push(cp);
  }

  return controlPairs;
}

function buildControlPairsFromRouteIndex(points, routeIndex, mapScale) {
  const controlPairs = [];
  for (const [key] of routeIndex.segments.entries()) {
    const [from, to] = key.split("->");
    if (!points[from] || !points[to]) continue;
    const cp = {
      order: controlPairs.length,
      start: points[from].pixel,
      ziel: points[to].pixel,
      complex: false,
      routes: [],
      source: {
        from,
        to,
        fallback: "actual_route_segments",
      },
      _routeKeys: new Set(),
    };
    attachActualRoutesToControlPair(cp, from, to, points, routeIndex, mapScale);
    delete cp._routeKeys;
    controlPairs.push(cp);
  }
  return controlPairs;
}

function buildControlPairs(courses, points, routeIndex, editorScale, mapScale, ocadFile = null, bounds = null, rasterScale = 1) {
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
      cp.routes.push(makeRoute(rP, cp, cp.routes.length, mapScale, {
        course: course.name,
        from,
        to,
        marked_routes: leg.markedRoutes || [],
      }));
      if (cp.routes.length > 1) cp.complex = true;
    }
  }

  for (const cp of controlPairs) delete cp._routeKeys;
  if (controlPairs.length) return controlPairs;
  const displayPairs = ocadFile && bounds
    ? buildControlPairsFromDisplayLines(ocadFile, bounds, rasterScale, editorScale, points, routeIndex, mapScale)
    : [];
  return displayPairs.length ? displayPairs : buildControlPairsFromRouteIndex(points, routeIndex, mapScale);
}

function ocadSymbolCode(sym) {
  const raw = String(Number(sym || 0)).padStart(6, "0");
  return `${Number(raw.slice(0, 3))}.${raw.slice(3)}`;
}

function loadMaskSymbolTable() {
  const tablePath = path.join(process.cwd(), "greyscale_mask.py");
  if (!fs.existsSync(tablePath)) return {};
  const source = fs.readFileSync(tablePath, "utf8");
  const table = {};
  const re = /['"]([^'"]+)['"]\s*:\s*\{[^}]*['"]gray_value['"]\s*:\s*(\d+)/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    table[match[1]] = Number(match[2]);
  }
  return table;
}

function lookupOldMaskValue(table, sym) {
  const code = ocadSymbolCode(sym);
  if (table[code] != null) return table[code];

  const variants = [
    code.replace(/0+$/, ""),
    code.replace(/\.0+$/, ".00"),
    code.replace(/\.0+$/, "."),
    code.slice(0, 6),
    code.slice(0, 5),
  ];
  for (const key of variants) {
    if (table[key] != null) return table[key];
  }

  let bestKey = null;
  for (const key of Object.keys(table)) {
    if (code.startsWith(key) && (!bestKey || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? table[bestKey] : null;
}

function remapOldMaskValue(oldValue) {
  if (oldValue == null || oldValue >= 255) return null;
  if (oldValue < 10 || oldValue === 34) return MASK_VALUES.impassable;
  if (oldValue < 22) return MASK_VALUES.verySlow;
  if (oldValue < 26) return MASK_VALUES.slow;
  if (oldValue < 28 || oldValue === 32) return MASK_VALUES.cross;
  if (oldValue < 32 || oldValue === 33) return MASK_VALUES.fast;
  return null;
}

function collectMaskObjects(ocadFile, table) {
  return (ocadFile.objects || [])
    .map((object) => {
      const oldValue = lookupOldMaskValue(table, object.sym);
      return { object, maskValue: remapOldMaskValue(oldValue) };
    })
    .filter(({ maskValue }) => maskValue != null);
}

function colorToRgb(gray) {
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function quantizeMaskBuffer(buffer) {
  const values = Object.values(MASK_VALUES);
  for (let i = 0; i < buffer.length; i++) {
    let best = values[0];
    let bestDistance = Math.abs(buffer[i] - best);
    for (const value of values.slice(1)) {
      const distance = Math.abs(buffer[i] - value);
      if (distance < bestDistance) {
        best = value;
        bestDistance = distance;
      }
    }
    buffer[i] = best;
  }
  return buffer;
}

async function writeQuantizedMask(svg, outPath, width, height) {
  const { data, info } = await sharp(Buffer.from(svg))
    .flatten({ background: colorToRgb(MASK_VALUES.fast) })
    .resize(width, height, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const quantized = quantizeMaskBuffer(Buffer.from(data));
  await sharp(quantized, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 1,
    },
  })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

function makeMaskOcadFile(ocadFile, maskEntries) {
  const maskBySym = new Map();
  for (const { object, maskValue } of maskEntries) {
    if (!maskBySym.has(object.sym)) maskBySym.set(object.sym, maskValue);
  }

  const grayColorByOriginal = new Map();
  const colors = [...ocadFile.colors];
  function grayColorIndex(originalIndex, gray) {
    const key = `${originalIndex}:${gray}`;
    if (grayColorByOriginal.has(key)) return grayColorByOriginal.get(key);
    const original = ocadFile.colors[originalIndex] || {};
    const idx = colors.length;
    colors.push({
      ...original,
      rgb: colorToRgb(gray),
      renderOrder: original.renderOrder ?? 0,
    });
    grayColorByOriginal.set(key, idx);
    return idx;
  }

  function rewriteColorRef(symbol, prop, gray) {
    if (typeof symbol[prop] === "number") {
      symbol[prop] = grayColorIndex(symbol[prop], gray);
    }
  }

  function cloneWithPrototype(value) {
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value);
  }

  const symbols = (ocadFile.symbols || []).map((symbol) => {
    const gray = maskBySym.get(symbol.symNum);
    if (gray == null) return symbol;
    const clone = cloneWithPrototype(symbol);

    for (const prop of [
      "lineColor",
      "fillColor",
      "frColor",
      "hatchColor",
      "fontColor",
      "color",
    ]) {
      rewriteColorRef(clone, prop, gray);
    }

    if (Array.isArray(clone.colors)) {
      clone.colors = clone.colors.map((colorIndex) =>
        typeof colorIndex === "number" ? grayColorIndex(colorIndex, gray) : colorIndex
      );
    }

    if (clone.doubleLine) {
      clone.doubleLine = { ...clone.doubleLine };
      for (const prop of ["dblLeftColor", "dblRightColor", "dblFillColor"]) {
        rewriteColorRef(clone.doubleLine, prop, gray);
      }
    }

    if (Array.isArray(clone.elements)) {
      clone.elements = clone.elements.map((element) => {
        const next = { ...element };
        rewriteColorRef(next, "color", gray);
        return next;
      });
    }

    return clone;
  });

  return Object.assign(Object.create(Object.getPrototypeOf(ocadFile)), {
    ...ocadFile,
    colors,
    symbols,
    objects: maskEntries.map(({ object }) => object),
  });
}

function serializeOcadSvg(ocadFile, objects, width, height, background = "transparent") {
  const dom = new DOMImplementation().createDocument("http://www.w3.org/2000/svg", "svg", null);
  installSerializableIdSetter(dom);
  const svgNode = ocadToSvg(ocadFile, {
    document: dom,
    exportHidden: true,
    objects,
    fill: background,
  });
  svgNode.setAttribute("width", String(width));
  svgNode.setAttribute("height", String(height));
  return new XMLSerializer().serializeToString(svgNode);
}

function pythonBinary() {
  if (process.env.OCAD_PYTHON_BINARY) return process.env.OCAD_PYTHON_BINARY;
  if (process.env.PYTHON) return process.env.PYTHON;
  const localVenvPython = path.join(
    __dirname,
    "..",
    "..",
    ".venv",
    process.platform === "win32" ? "Scripts\\python.exe" : "bin/python"
  );
  if (fs.existsSync(localVenvPython)) return localVenvPython;
  if (process.env.VIRTUAL_ENV) {
    return path.join(
      process.env.VIRTUAL_ENV,
      process.platform === "win32" ? "Scripts\\python.exe" : "bin/python"
    );
  }
  return process.platform === "win32" ? "python" : "python3";
}

async function renderSvgWithResvg(svg, outPath, width, height) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocad-svg-"));
  const svgPath = path.join(tempDir, "map.svg");
  fs.writeFileSync(svgPath, svg);
  try {
    const scriptPath = path.join(__dirname, "render_svg_resvg.py");
    await execFileAsync(pythonBinary(), [
      scriptPath,
      svgPath,
      outPath,
      String(width),
      String(height),
    ], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: Number(process.env.OCAD_RESVG_TIMEOUT_MS || 120000),
    });
    return { renderer: "resvg" };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function renderSvgWithSharp(svg, outPath) {
  await sharp(Buffer.from(svg))
    .flatten({ background: "#ffffff" })
    .png({
      compressionLevel: 6,
      adaptiveFiltering: true,
      palette: true,
      quality: 90,
      effort: 4,
    })
    .toFile(outPath);
  return { renderer: "sharp" };
}

async function renderVisibleSvgToPng(svg, outPath, width, height) {
  const renderer = (process.env.OCAD_SVG_RENDERER || "resvg").toLowerCase();
  if (renderer === "resvg") return renderSvgWithResvg(svg, outPath, width, height);
  return renderSvgWithSharp(svg, outPath);
}

async function main() {
  const args = parseArgs(process.argv);
  const input = args.input;
  const pngOut = args.png;
  const geojsonOut = args.geojson;
  const maskOut = args.mask;
  const calibrationFactor = Number(args["scale-factor"] || process.env.OCAD_EDITOR_SCALE_FACTOR || 1);
  const skipMask = args["skip-mask"] === "true";
  const maskOnly = args["mask-only"] === "true";
  const courseOnly = args["course-only"] === "true";

  if (!input || (maskOnly && !maskOut) || (!maskOnly && !courseOnly && !pngOut)) {
    throw new Error("Usage: node convert_ocad.js --input in.ocd --png out.png [--mask out.png] [--skip-mask true] [--mask-only true] [--course-only true] [--scale-factor 1.0]");
  }
  if (!Number.isFinite(calibrationFactor) || calibrationFactor <= 0) {
    throw new Error("OCAD scale factor must be a positive number");
  }

  const ocadFile = await readOcad(input);
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
  const maskWidth = Math.max(1, Math.round((width * editorScale) / TRAIN_SCALE));
  const maskHeight = Math.max(1, Math.round((height * editorScale) / TRAIN_SCALE));

  if (!maskOnly && !courseOnly) {
    const mapObjects = (ocadFile.objects || []).filter(makeRenderableObjectFilter(ocadFile));
    const svg = serializeOcadSvg(ocadFile, mapObjects, width, height);

    fs.mkdirSync(path.dirname(pngOut), { recursive: true });
    var renderInfo = await renderVisibleSvgToPng(svg, pngOut, width, height);
  }

  let maskEntries = null;
  if (maskOut && !skipMask) {
    fs.mkdirSync(path.dirname(maskOut), { recursive: true });
    const maskTable = loadMaskSymbolTable();
    maskEntries = collectMaskObjects(ocadFile, maskTable);
    const maskOcadFile = makeMaskOcadFile(ocadFile, maskEntries);
    const maskSvg = serializeOcadSvg(
      maskOcadFile,
      maskOcadFile.objects,
      maskWidth,
      maskHeight,
      colorToRgb(MASK_VALUES.fast)
    );
    await writeQuantizedMask(maskSvg, maskOut, maskWidth, maskHeight);
  }

  const controlPoints = extractControlPoints(ocadFile, bounds, rasterScale, editorScale);
  const courses = extractCourses(ocadFile);
  const routeIndex = buildActualRouteIndex(ocadFile, bounds, rasterScale, editorScale);
  const controlPairs = buildControlPairs(
    courses, controlPoints, routeIndex, editorScale, mapScale, ocadFile, bounds, rasterScale
  );
  const actualRouteSegments = Array.from(routeIndex.segments.values())
    .reduce((sum, entries) => sum + entries.length, 0);

  process.stdout.write(JSON.stringify({
    status: "ok",
    width,
    height,
    scale: editorScale,
    scaled: true,
    ocad_map_scale: mapScale,
    scale_calibration_factor: calibrationFactor,
    meters_per_raster_pixel: metersPerRasterPixel,
    geojson_file: null,
    mask_file: maskOut ? path.basename(maskOut) : null,
    control_pairs: controlPairs,
    courses: courses.length,
    controls: Object.keys(controlPoints).length,
    actual_route_segments: actualRouteSegments,
    mask_symbols: maskEntries ? maskEntries.length : null,
    mask_status: maskOut && !skipMask ? "generated" : "skipped",
    renderer: renderInfo?.renderer || null,
    renderer_binary: renderInfo?.binary || null,
  }));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exit(1);
});
