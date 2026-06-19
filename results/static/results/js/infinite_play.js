/* =========================================================
   INFINITE PLAY — procedurally-generated sprint route-choice
   problem. Uses IOF-style colours, compound obstacles,
   decorative obstacles, rotated camera (start at bottom),
   and the same dot-and-trail animation as play.js.

   Records each attempt to /play/infinity/submit-choice/ →
   InfiniteChoice DB model.
========================================================= */

/* ── Coordinate system & constants ────────────────────── */

const VB_W      = 1200;
const VB_H      = 800;
const RUN_SPEED = 4.75;   // m/s reference flat-ground speed
const PX_PER_M  = 6;      // viewBox px → metres

const ROUTE_COLORS  = ['#DD0011', '#CC6000'];   // play.js's first two route colours
const CONTROL_COLOR = '#a033f0';                // standard orienteering pink/purple
const R_CONTROL     = 25;                       // control circle radius

// IOF/OCAD-like sprint palette, sampled from the reference SVG exports.
const IOF = {
    open_yellow:   'rgb(255,204,54)',
    open_orange:   'rgb(255,194,54)',
    paved:         'rgb(184,184,184)',
    paved_dark:    'rgb(128,128,128)',
    forest_run:    'rgb(255,255,255)',
    veg_light:     'rgb(138,255,115)',
    veg_medium:    'rgb(74,255,23)',
    veg_slow:      'rgb(61,255,23)',
    veg_olive:     'rgb(158,186,0)',
    building:      'rgb(0,0,0)',
    pond:          'rgb(0,128,255)',
    pond_border:   'rgb(0,96,220)',
    stone_wall:    'rgb(0,0,0)',
    fence:         'rgb(0,0,0)',
    cliff:         'rgb(0,0,0)',
    contour:       'rgb(191,128,64)',
    uncrossable:   'rgb(102,102,102)',
};

const NS    = 'http://www.w3.org/2000/svg';
const svgEl = (tag) => document.createElementNS(NS, tag);
const SVG   = (id)  => document.getElementById(id);

/* ── State ────────────────────────────────────────────── */

let scene       = null;
let phase       = 'choose';   // 'choose' | 'reveal'
let choiceStartTime = null;
let _routeAnim  = null;
let stats       = loadStats();

document.addEventListener('DOMContentLoaded', () => {
    SVG('rp-svg').setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
    SVG('rp-svg').setAttribute('preserveAspectRatio', 'xMidYMid meet');
    document.body.classList.add('has-prior-results'); // grey progress bar (visual hint: no project)
    next();
    initInput();
    renderHud();
});

function initInput() {
    document.addEventListener('keydown', e => {
        if (phase === 'choose') {
            if (e.key === 'ArrowLeft')  pickSide(0);
            if (e.key === 'ArrowRight') pickSide(1);
        } else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
            e.preventDefault();
            next();
        }
    });
    // Tap on map background advances after reveal
    SVG('map-container').addEventListener('click', e => {
        if (phase !== 'reveal') return;
        if (e.target.closest('.play-btn')) return;
        next();
    });
}

/* =========================================================
   PROCEDURAL GENERATION
========================================================= */

function next() {
    phase = 'choose';
    if (_routeAnim) { cancelAnimationFrame(_routeAnim); _routeAnim = null; }
    scene = generateScene();
    renderScene();
    // Clear the centre choice-time slot — fresh problem, no time to show yet
    const ct = SVG('rp-choice-time');
    if (ct) ct.textContent = '';
    renderChoiceButtons();
    choiceStartTime = performance.now();
}

function generateScene() {
    let best = null;
    let bestDiff = -1;
    for (let i = 0; i < 8; i++) {
        const candidate = buildSceneCandidate();
        const diff = Math.abs(candidate.routes[0].time - candidate.routes[1].time);
        if (diff > bestDiff) {
            best = candidate;
            bestDiff = diff;
        }
        if (diff >= 0.45) return candidate;
    }
    return best;
}

function buildSceneCandidate() {
    // 1. Build a compound "primary" obstacle (1–3 connected shapes)
    const primary = generatePrimaryCompound();
    const cluster = generateBlockingCluster(primary.hull);
    primary.shapes = [...primary.shapes, ...cluster];
    primary.hull = convexHull(primary.shapes.flatMap(s => s.hull || []));

    // 2. Place start + ziel on opposite sides of the primary obstacle's hull
    let { start, ziel } = placeEndpoints(primary.hull);

    // 3. Compute the two routes around the primary hull
    let routes = tangentRoutes(start, ziel, primary.hull);

    // 4. Add decorative obstacles + map "texture" tiles that don't intersect routes
    const decor = generateDecoration(primary.hull, [routes[0].points, routes[1].points], start, ziel);

    // 5. Bake a rotation + translation into every coordinate so that start
    //    ends up at the bottom of the viewbox and ziel at the top. This way
    //    the SVG always renders upright without a runtime <g transform>.
    const angle = Math.atan2(ziel.y - start.y, ziel.x - start.x);
    const rot   = -Math.PI / 2 - angle;
    const mid   = { x: (start.x + ziel.x) / 2, y: (start.y + ziel.y) / 2 };
    const dst   = { x: VB_W / 2, y: VB_H / 2 };

    const transform = p => {
        const dx = p.x - mid.x, dy = p.y - mid.y;
        const ca = Math.cos(rot), sa = Math.sin(rot);
        return { x: dst.x + dx * ca - dy * sa, y: dst.y + dx * sa + dy * ca };
    };

    const start2 = transform(start);
    const ziel2  = transform(ziel);

    const primary2 = applyTransformToCompound(primary, transform);

    // Re-compute routes against the transformed hull so the route points
    // reference the new vertices (so the post-pick animation lines up)
    const routes2 = tangentRoutes(start2, ziel2, primary2.hull);

    const decor2 = decor.map(d => applyTransformToDecor(d, transform));

    return { primary: primary2, decor: decor2, start: start2, ziel: ziel2, routes: routes2 };
}

function applyTransformToCompound(primary, T) {
    const shapes = primary.shapes.map(s => applyTransformToShape(s, T));
    return { composition: primary.composition, shapes, hull: shapes.flatMap(s => s.hull) };
}

function applyTransformToShape(s, T) {
    const out = { ...s };
    if (s.polygon)  out.polygon  = s.polygon.map(T);
    if (s.polyline) out.polyline = s.polyline.map(T);
    if (s.hull)     out.hull     = s.hull.map(T);
    if (s.a)        out.a        = T(s.a);
    if (s.b)        out.b        = T(s.b);
    if (s.cx !== undefined && s.cy !== undefined) {
        const c = T({ x: s.cx, y: s.cy });
        out.cx = c.x; out.cy = c.y;
    }
    // For a wall, we need to recompute hull after a,b transform — but the
    // hull we have is already in world coords pre-transform, and we did
    // map it above. That's correct.
    return out;
}

function applyTransformToDecor(d, T) {
    if (d.kind === 'tile') {
        // Re-derive corners, transform them, then convert back to bb + rot
        // (drawing path uses x/y/w/h/rot of the original; simpler to just
        // transform all four corners and store them as a polygon override)
        const corners = [
            { x: d.x, y: d.y }, { x: d.x + d.w, y: d.y },
            { x: d.x + d.w, y: d.y + d.h }, { x: d.x, y: d.y + d.h },
        ].map(T);
        return { kind: 'tile_polygon', polygon: corners, color: d.color };
    }
    return applyTransformToShape(d, T);
}

/* ── Compound primary obstacle ────────────────────────── */

function generatePrimaryCompound() {
    const composition = pickWeighted([
        ['L_building',         5],
        ['T_building',         3],
        ['U_courtyard',        3],
        ['building_with_wing', 4],
        ['building_plus_wall', 4],
        ['building_plus_pond', 2],
        ['building_row',       3],
        ['pond_with_island',   1],
        ['fence_corridor',     3],
        ['hedge_bend',         2],
        ['cliff_arc',          2],
    ]);
    const cx = rand(VB_W * 0.35, VB_W * 0.65);
    const cy = rand(VB_H * 0.35, VB_H * 0.65);
    const baseAngle = rand(0, Math.PI * 2);

    let shapes = [];
    switch (composition) {
        case 'L_building': {
            const w = rand(180, 280), h = rand(120, 180);
            const armW = w * rand(0.40, 0.55), armH = rand(80, 140);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            // L-arm extending downward from one end
            const off = rotate({ x: w/2 - armW/2, y: -h/2 - armH/2 }, baseAngle);
            const b = rectAt(cx + off.x, cy + off.y, armW, armH, baseAngle, IOF.building, 'building');
            shapes = [a, b];
            break;
        }
        case 'T_building': {
            const w = rand(220, 320), h = rand(100, 140);
            const armW = rand(80, 130), armH = rand(150, 220);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            const off = rotate({ x: 0, y: (h + armH) / 2 - 4 }, baseAngle);
            const b = rectAt(cx + off.x, cy + off.y, armW, armH, baseAngle, IOF.building, 'building');
            shapes = [a, b];
            break;
        }
        case 'U_courtyard': {
            // Three rectangles forming a U with an open courtyard in the middle
            const w = rand(240, 320), h = rand(50, 90);   // base bar
            const armW = rand(50, 80), armH = rand(140, 200);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            const dxL = -(w - armW) / 2, dyL = -(h + armH) / 2 + 4;
            const oL  = rotate({ x: dxL, y: dyL }, baseAngle);
            const oR  = rotate({ x: -dxL, y: dyL }, baseAngle);
            shapes = [
                a,
                rectAt(cx + oL.x, cy + oL.y, armW, armH, baseAngle, IOF.building, 'building'),
                rectAt(cx + oR.x, cy + oR.y, armW, armH, baseAngle, IOF.building, 'building'),
            ];
            break;
        }
        case 'building_with_wing': {
            const w = rand(170, 240), h = rand(120, 180);
            const wing = rand(70, 120);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            const off = rotate({ x: w/2 + wing/2 - 2, y: rand(-h/4, h/4) }, baseAngle);
            const b = rectAt(cx + off.x, cy + off.y, wing, wing * rand(0.6, 0.9), baseAngle, IOF.building, 'building');
            shapes = [a, b];
            break;
        }
        case 'building_plus_wall': {
            const w = rand(160, 240), h = rand(110, 170);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            // Stone wall extending from the building edge
            const wallLen = rand(140, 220);
            const startEdge = rotate({ x: w/2, y: rand(-h/3, h/3) }, baseAngle);
            const wallAngle = baseAngle + rand(-0.6, 0.6);
            const wallEnd  = {
                x: cx + startEdge.x + Math.cos(wallAngle) * wallLen,
                y: cy + startEdge.y + Math.sin(wallAngle) * wallLen,
            };
            shapes = [a, wallShape({ x: cx + startEdge.x, y: cy + startEdge.y }, wallEnd, IOF.stone_wall, 8)];
            break;
        }
        case 'building_plus_pond': {
            const w = rand(160, 220), h = rand(120, 170);
            const a = rectAt(cx, cy, w, h, baseAngle, IOF.building, 'building');
            const off = rotate({ x: -(w/2 + rand(60, 90)), y: rand(-h/2, h/2) }, baseAngle);
            shapes = [a, blobShape(cx + off.x, cy + off.y, rand(55, 95), IOF.pond, IOF.pond_border, 'pond')];
            break;
        }
        case 'building_row': {
            // 2-3 small buildings in a row, narrow alleys between them
            const count = randInt(2, 3);
            const bw = rand(70, 110), bh = rand(70, 120);
            const gap = rand(8, 20);
            const total = count * bw + (count - 1) * gap;
            for (let i = 0; i < count; i++) {
                const dx = -total / 2 + bw / 2 + i * (bw + gap);
                const off = rotate({ x: dx, y: 0 }, baseAngle);
                shapes.push(rectAt(cx + off.x, cy + off.y, bw, bh, baseAngle, IOF.building, 'building'));
            }
            break;
        }
        case 'pond_with_island': {
            const r = rand(120, 170);
            shapes = [blobShape(cx, cy, r, IOF.pond, IOF.pond_border, 'pond')];
            // Tiny "island" (decorative — sits on top of the pond)
            const off = rotate({ x: rand(-r * 0.3, r * 0.3), y: rand(-r * 0.3, r * 0.3) }, 0);
            shapes.push(rectAt(cx + off.x, cy + off.y, rand(30, 50), rand(25, 45), baseAngle, IOF.building, 'building'));
            break;
        }
        case 'fence_corridor': {
            // Two parallel fences forming an impassable corridor
            const len = rand(220, 320);
            const gap = rand(50, 90);
            const angle = baseAngle;
            const nx = -Math.sin(angle), ny = Math.cos(angle);
            const dx = Math.cos(angle) * len / 2, dy = Math.sin(angle) * len / 2;
            shapes = [
                wallShape({ x: cx - dx + nx * gap, y: cy - dy + ny * gap },
                          { x: cx + dx + nx * gap, y: cy + dy + ny * gap }, IOF.fence, 4, true),
                wallShape({ x: cx - dx - nx * gap, y: cy - dy - ny * gap },
                          { x: cx + dx - nx * gap, y: cy + dy - ny * gap }, IOF.fence, 4, true),
            ];
            break;
        }
        case 'hedge_bend': {
            // A hedge with a kink → forms an L-shaped barrier
            const len1 = rand(140, 200), len2 = rand(120, 180);
            const a = { x: cx - Math.cos(baseAngle) * len1, y: cy - Math.sin(baseAngle) * len1 };
            const b = { x: cx, y: cy };
            const bendAngle = baseAngle + rand(0.7, 1.3) * pickRandom([-1, 1]);
            const c = { x: cx + Math.cos(bendAngle) * len2, y: cy + Math.sin(bendAngle) * len2 };
            shapes = [
                wallShape(a, b, IOF.veg_slow, 14),
                wallShape(b, c, IOF.veg_slow, 14),
            ];
            break;
        }
        case 'cliff_arc': {
            const segs = randInt(3, 5);
            const total = rand(220, 320);
            const segLen = total / segs;
            let cur = { x: cx - Math.cos(baseAngle) * total / 2, y: cy - Math.sin(baseAngle) * total / 2 };
            let angle = baseAngle;
            const pts = [cur];
            for (let i = 0; i < segs; i++) {
                angle += rand(-0.35, 0.35);
                cur = { x: cur.x + Math.cos(angle) * segLen, y: cur.y + Math.sin(angle) * segLen };
                pts.push(cur);
            }
            shapes = [{
                kind: 'cliff', polyline: pts,
                hull: inflatePolyline(pts, 12),
                color: IOF.cliff, stroke: IOF.cliff,
            }];
            break;
        }
    }

    // Combined convex hull of all shape hulls → routing target
    const allHullPoints = shapes.flatMap(s => s.hull);
    const hull = convexHull(allHullPoints);

    return { composition, shapes, hull };
}

/* ── Shape builders ───────────────────────────────────── */

function generateBlockingCluster(anchorHull) {
    const bb = boundingBox(anchorHull);
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    const radius = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
    const count = randInt(2, 5);
    const shapes = [];

    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + rand(-0.55, 0.55);
        const dist = radius * rand(0.45, 0.85);
        const x = clamp(cx + Math.cos(angle) * dist, 110, VB_W - 110);
        const y = clamp(cy + Math.sin(angle) * dist, 90, VB_H - 90);
        const rot = angle + rand(-0.8, 0.8);
        const item = pickWeighted([
            ['building', 5],
            ['wall',     3],
            ['fence',    2],
            ['hedge',    3],
            ['pond',     2],
        ]);

        if (item === 'building') {
            shapes.push(rectAt(x, y, rand(55, 135), rand(45, 115), rot, IOF.building, 'building'));
        } else if (item === 'wall' || item === 'fence' || item === 'hedge') {
            const len = rand(90, 190);
            const half = item === 'hedge' ? rand(9, 15) : item === 'wall' ? 6 : 4;
            const color = item === 'hedge' ? IOF.veg_slow : IOF.fence;
            const a = { x: x - Math.cos(rot) * len / 2, y: y - Math.sin(rot) * len / 2 };
            const b = { x: x + Math.cos(rot) * len / 2, y: y + Math.sin(rot) * len / 2 };
            shapes.push(wallShape(a, b, color, half, item === 'fence'));
        } else {
            shapes.push(blobShape(x, y, rand(35, 70), IOF.pond, IOF.pond_border, 'pond'));
        }
    }

    return shapes;
}

function rectAt(cx, cy, w, h, angle, fill, kind) {
    const polygon = kind && kind.includes('building')
        ? buildingFootprint(cx, cy, w, h, angle)
        : rectCorners(cx, cy, w, h, angle);
    return { kind, polygon, hull: convexHull(polygon), color: fill, stroke: '#000' };
}

function buildingFootprint(cx, cy, w, h, angle) {
    const hw = w / 2, hh = h / 2;
    const style = pickWeighted([['chamfer', 4], ['notch', 5], ['step', 3], ['plain', 2]]);
    let pts;

    if (style === 'chamfer') {
        const c = Math.min(w, h) * rand(0.10, 0.22);
        pts = [
            { x: -hw + c, y: -hh }, { x: hw - c, y: -hh },
            { x: hw, y: -hh + c }, { x: hw, y: hh - c },
            { x: hw - c, y: hh }, { x: -hw + c, y: hh },
            { x: -hw, y: hh - c }, { x: -hw, y: -hh + c },
        ];
    } else if (style === 'notch') {
        const nw = w * rand(0.20, 0.36);
        const nd = h * rand(0.15, 0.28);
        pts = [
            { x: -hw, y: -hh }, { x: -nw / 2, y: -hh },
            { x: -nw / 2, y: -hh + nd }, { x: nw / 2, y: -hh + nd },
            { x: nw / 2, y: -hh }, { x: hw, y: -hh },
            { x: hw, y: hh }, { x: -hw, y: hh },
        ];
    } else if (style === 'step') {
        const sx = w * rand(0.18, 0.34);
        const sy = h * rand(0.18, 0.34);
        pts = [
            { x: -hw, y: -hh }, { x: hw - sx, y: -hh },
            { x: hw - sx, y: -hh + sy }, { x: hw, y: -hh + sy },
            { x: hw, y: hh }, { x: -hw + sx, y: hh },
            { x: -hw + sx, y: hh - sy }, { x: -hw, y: hh - sy },
        ];
    } else {
        pts = [
            { x: -hw, y: -hh }, { x: hw, y: -hh },
            { x: hw, y: hh }, { x: -hw, y: hh },
        ];
    }

    const ca = Math.cos(angle), sa = Math.sin(angle);
    return pts.map(p => ({
        x: cx + p.x * ca - p.y * sa,
        y: cy + p.x * sa + p.y * ca,
    }));
}

function rectCorners(cx, cy, w, h, angle) {
    const hw = w/2, hh = h/2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    return [
        { x: -hw, y: -hh }, { x:  hw, y: -hh }, { x:  hw, y:  hh }, { x: -hw, y:  hh },
    ].map(p => ({
        x: cx + p.x * ca - p.y * sa,
        y: cy + p.x * sa + p.y * ca,
    }));
}

function rotate(p, angle) {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    return { x: p.x * ca - p.y * sa, y: p.x * sa + p.y * ca };
}

function blobShape(cx, cy, baseR, fill, stroke, kind) {
    const n = 16;
    const verts = [];
    let r = baseR;
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.04, 0.04);
        r = clamp(r + rand(-baseR * 0.08, baseR * 0.08), baseR * 0.7, baseR * 1.2);
        verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return { kind, polygon: verts, hull: convexHull(verts), color: fill, stroke };
}

function wallShape(a, b, color, half, ticked = false) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * half, ny = dx / len * half;
    const hull = [
        { x: a.x - nx, y: a.y - ny },
        { x: b.x - nx, y: b.y - ny },
        { x: b.x + nx, y: b.y + ny },
        { x: a.x + nx, y: a.y + ny },
    ];
    return { kind: 'wall', a, b, hull, color, stroke: color, half, ticked };
}

function inflatePolyline(pts, half) {
    if (pts.length < 2) return [];
    const top = [], bot = [];
    for (let i = 0; i < pts.length; i++) {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const dx = next.x - prev.x, dy = next.y - prev.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        top.push({ x: pts[i].x + nx * half, y: pts[i].y + ny * half });
        bot.push({ x: pts[i].x - nx * half, y: pts[i].y - ny * half });
    }
    return [...top, ...bot.reverse()];
}

/* ── Endpoint placement ───────────────────────────────── */

function placeEndpoints(hull) {
    const bb = boundingBox(hull);
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    const w  = bb.maxX - bb.minX;
    const h  = bb.maxY - bb.minY;

    const horizontal = h < w;
    const margin = rand(110, 170);
    let start, ziel;
    if (horizontal) {
        start = { x: cx + rand(-w * 0.30, w * 0.30), y: clamp(bb.minY - margin, 70, VB_H - 70) };
        ziel  = { x: cx + rand(-w * 0.30, w * 0.30), y: clamp(bb.maxY + margin, 70, VB_H - 70) };
    } else {
        start = { x: clamp(bb.minX - margin, 70, VB_W - 70), y: cy + rand(-h * 0.30, h * 0.30) };
        ziel  = { x: clamp(bb.maxX + margin, 70, VB_W - 70), y: cy + rand(-h * 0.30, h * 0.30) };
    }
    if (Math.random() < 0.5) [start, ziel] = [ziel, start];
    return { start, ziel };
}

/* ── Decoration: stuff around the main obstacle ──────── */

function generateDecoration(primaryHull, routePts, start, ziel) {
    const items = [];

    const terrainCount = randInt(7, 12);
    for (let i = 0; i < terrainCount; i++) {
        const kind = pickWeighted([
            ['open',       4],
            ['paved_area', 4],
            ['veg_light',  3],
            ['veg_medium', 2],
            ['olive',      1],
        ]);
        const color = {
            open: IOF.open_yellow,
            paved_area: pickRandom([IOF.paved, IOF.paved_dark]),
            veg_light: IOF.veg_light,
            veg_medium: IOF.veg_medium,
            olive: IOF.veg_olive,
        }[kind];
        items.push(areaPatch(
            rand(80, VB_W - 80),
            rand(65, VB_H - 65),
            rand(90, 260),
            rand(55, 190),
            rand(0, Math.PI * 2),
            color,
            kind
        ));
    }

    const roadCount = randInt(2, 4);
    for (let i = 0; i < roadCount; i++) {
        items.push(lineFeature(
            randomEdgePoint(),
            randomEdgePoint(),
            rand(18, 34),
            pickRandom([IOF.paved, IOF.paved_dark]),
            'road'
        ));
    }

    const contourCount = randInt(5, 9);
    for (let i = 0; i < contourCount; i++) {
        items.push(contourLine(rand(80, VB_W - 80), rand(70, VB_H - 70), rand(120, 320), rand(0, Math.PI * 2)));
    }

    const decorCount = randInt(9, 15);
    for (let i = 0; i < decorCount; i++) {
        let attempts = 20, placed = null;
        while (attempts-- > 0) {
            const cx = rand(50, VB_W - 50);
            const cy = rand(50, VB_H - 50);
            // Must not intersect the primary obstacle or the planned routes or the control circles
            if (pointInPolygon({x: cx, y: cy}, primaryHull)) continue;
            if (distToPolygon({x: cx, y: cy}, primaryHull) < 30) continue;
            if (Math.hypot(cx - start.x, cy - start.y) < 50) continue;
            if (Math.hypot(cx - ziel.x,  cy - ziel.y)  < 50) continue;
            // Far enough from the planned route paths (so the path doesn't cross decorations)
            const minRouteDist = Math.min(
                pathMinDistance({x: cx, y: cy}, routePts[0]),
                pathMinDistance({x: cx, y: cy}, routePts[1]),
            );
            if (minRouteDist < 35) continue;

            placed = generateDecorItem(cx, cy);
            break;
        }
        if (placed) items.push(placed);
    }

    return items;
}

function generateDecorItem(cx, cy) {
    const kind = pickWeighted([
        ['small_building', 3],
        ['vegetation',     6],
        ['short_fence',    3],
        ['boulder',        2],
        ['small_pond',     2],
        ['canopy',         2],
        ['path',           3],
    ]);
    const angle = rand(0, Math.PI * 2);
    switch (kind) {
        case 'small_building':
            return rectAt(cx, cy, rand(45, 90), rand(35, 80), angle, IOF.building, 'small_building');
        case 'vegetation':
            return blobShape(cx, cy, rand(25, 65), pickRandom([IOF.veg_light, IOF.veg_medium, IOF.veg_olive]), null, 'vegetation');
        case 'short_fence': {
            const len = rand(80, 150);
            const a = { x: cx - Math.cos(angle) * len / 2, y: cy - Math.sin(angle) * len / 2 };
            const b = { x: cx + Math.cos(angle) * len / 2, y: cy + Math.sin(angle) * len / 2 };
            return { kind: 'short_fence', a, b, color: IOF.fence };
        }
        case 'boulder':
            return { kind: 'boulder', cx, cy, r: rand(3, 6), color: IOF.cliff };
        case 'small_pond':
            return blobShape(cx, cy, rand(25, 45), IOF.pond, IOF.pond_border, 'small_pond');
        case 'canopy':
            return areaPatch(cx, cy, rand(50, 100), rand(35, 85), angle, IOF.open_orange, 'canopy');
        case 'path': {
            const len = rand(85, 180);
            const a = { x: cx - Math.cos(angle) * len / 2, y: cy - Math.sin(angle) * len / 2 };
            const b = { x: cx + Math.cos(angle) * len / 2, y: cy + Math.sin(angle) * len / 2 };
            return lineFeature(a, b, rand(4, 7), IOF.contour, 'path');
        }
    }
}

function areaPatch(cx, cy, w, h, angle, color, kind) {
    const n = randInt(9, 15);
    const pts = [];
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.11, 0.11);
        const rx = w / 2 * rand(0.78, 1.18);
        const ry = h / 2 * rand(0.78, 1.18);
        const lx = Math.cos(a) * rx;
        const ly = Math.sin(a) * ry;
        pts.push({
            x: cx + lx * ca - ly * sa,
            y: cy + lx * sa + ly * ca,
        });
    }
    return { kind, polygon: pts, hull: convexHull(pts), color };
}

function lineFeature(a, b, width, color, kind) {
    return {
        kind,
        a, b,
        width,
        color,
        hull: inflatePolyline([a, b], width / 2),
    };
}

function contourLine(cx, cy, length, angle) {
    const pts = [];
    const segs = randInt(4, 7);
    const step = length / segs;
    const normal = angle + Math.PI / 2;
    for (let i = 0; i <= segs; i++) {
        const along = (i - segs / 2) * step;
        const wave = Math.sin(i * rand(0.8, 1.25)) * rand(8, 18);
        pts.push({
            x: cx + Math.cos(angle) * along + Math.cos(normal) * wave,
            y: cy + Math.sin(angle) * along + Math.sin(normal) * wave,
        });
    }
    return { kind: 'contour', polyline: pts, hull: inflatePolyline(pts, 2), color: IOF.contour };
}

function randomEdgePoint() {
    const side = randInt(0, 3);
    if (side === 0) return { x: rand(0, VB_W), y: -30 };
    if (side === 1) return { x: VB_W + 30, y: rand(0, VB_H) };
    if (side === 2) return { x: rand(0, VB_W), y: VB_H + 30 };
    return { x: -30, y: rand(0, VB_H) };
}

/* =========================================================
   GEOMETRY HELPERS
========================================================= */

function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickWeighted(pairs) {
    const total = pairs.reduce((s, p) => s + p[1], 0);
    let r = Math.random() * total;
    for (const [item, w] of pairs) { r -= w; if (r <= 0) return item; }
    return pairs[0][0];
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function boundingBox(pts) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs),
             minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points) {
    if (points.length < 3) return points.slice();
    const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const lower = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi + 1e-9) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function distToPolygon(p, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        best = Math.min(best, segmentPointDistance(p, a, b));
    }
    return best;
}

function segmentPointDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx*dx + dy*dy || 1;
    let t = ((p.x - a.x)*dx + (p.y - a.y)*dy) / lenSq;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function pathLength(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    return s;
}

function pathMinDistance(p, pathPts) {
    let best = Infinity;
    for (let i = 1; i < pathPts.length; i++) {
        best = Math.min(best, segmentPointDistance(p, pathPts[i - 1], pathPts[i]));
        if (best < 1) break;
    }
    return best;
}

/* =========================================================
   SIDE-SPLIT ROUTING — two arcs around the compound hull
========================================================= */

function tangentRoutes(start, ziel, obstacleHull) {
    const hull = convexHull([start, ziel, ...obstacleHull]);
    const sIdx = hull.findIndex(p => p === start);
    const zIdx = hull.findIndex(p => p === ziel);
    if (sIdx === -1 || zIdx === -1) {
        return [route([start, ziel]), route([start, ziel])];
    }

    const arc1 = walkArc(hull, sIdx, zIdx,  1);
    const arc2 = walkArc(hull, sIdx, zIdx, -1);

    // "Left" of start→ziel from the player's perspective (running toward ziel)
    const mid = arc1[Math.floor(arc1.length / 2)];
    const sideSign = (ziel.x - start.x) * (mid.y - start.y) - (ziel.y - start.y) * (mid.x - start.x);
    const arc1IsLeft = sideSign < 0;

    return arc1IsLeft
        ? [route(arc1), route(arc2)]
        : [route(arc2), route(arc1)];
}

function walkArc(hull, fromIdx, toIdx, step) {
    const arc = [];
    let i = fromIdx;
    arc.push(hull[i]);
    while (i !== toIdx) {
        i = (i + step + hull.length) % hull.length;
        arc.push(hull[i]);
    }
    return arc;
}

function route(pts) {
    const len   = pathLength(pts);
    const time  = (len / PX_PER_M) / RUN_SPEED;   // seconds
    return { points: pts, length: len, time };
}

/* =========================================================
   RENDERING
========================================================= */

function renderScene() {
    clearLayer('rp-bg-layer');
    clearLayer('rp-decor-layer');
    clearLayer('rp-obstacle-layer');
    clearLayer('rp-route-layer');
    clearLayer('rp-control-layer');

    // No runtime rotation — the coords are already in the canonical frame.
    const rotGroup = SVG('rp-rotation');
    if (rotGroup) rotGroup.removeAttribute('transform');

    drawBackground();
    drawDecor(scene.decor);
    for (const shape of scene.primary.shapes) drawShape(shape, true);
    drawControls(scene.start, scene.ziel);
}

function clearLayer(id) { SVG(id).innerHTML = ''; }

function drawBackground() {
    const bg = svgEl('rect');
    bg.setAttribute('x', 0); bg.setAttribute('y', 0);
    bg.setAttribute('width', VB_W); bg.setAttribute('height', VB_H);
    bg.setAttribute('fill', IOF.forest_run);
    SVG('rp-bg-layer').appendChild(bg);
}

function drawDecor(items) {
    const layer = SVG('rp-decor-layer');
    for (const d of items) {
        if (d.kind === 'tile_polygon') {
            const p = svgEl('polygon');
            p.setAttribute('points', d.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', d.color);
            p.setAttribute('opacity', '0.85');
            layer.appendChild(p);
        } else {
            drawShape(d, false, layer);
        }
    }
}

function drawShape(shape, primary, layer) {
    layer = layer || SVG('rp-obstacle-layer');
    switch (shape.kind) {
        case 'open':
        case 'paved_area':
        case 'canopy':
        case 'olive': {
            const p = svgEl('polygon');
            p.setAttribute('points', shape.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', shape.color);
            p.setAttribute('opacity', shape.kind === 'paved_area' ? '0.92' : '0.86');
            layer.appendChild(p);
            break;
        }
        case 'building':
        case 'small_building': {
            const p = svgEl('polygon');
            p.setAttribute('points', shape.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', shape.color);
            p.setAttribute('stroke', '#000');
            p.setAttribute('stroke-width', '1.5');
            layer.appendChild(p);
            break;
        }
        case 'pond':
        case 'small_pond': {
            const p = svgEl('polygon');
            p.setAttribute('points', shape.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', shape.color);
            p.setAttribute('stroke', shape.stroke || IOF.pond_border);
            p.setAttribute('stroke-width', '2.5');
            layer.appendChild(p);
            break;
        }
        case 'veg_light':
        case 'veg_medium':
        case 'vegetation': {
            const p = svgEl('polygon');
            p.setAttribute('points', shape.polygon.map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', shape.color === IOF.veg_medium ? 'url(#rp-veg-stripe)' : shape.color);
            p.setAttribute('opacity', '0.85');
            layer.appendChild(p);
            break;
        }
        case 'road': {
            const polygon = svgEl('polygon');
            polygon.setAttribute('points', shape.hull.map(v => `${v.x},${v.y}`).join(' '));
            polygon.setAttribute('fill', shape.color);
            polygon.setAttribute('stroke', IOF.uncrossable);
            polygon.setAttribute('stroke-width', '1');
            polygon.setAttribute('opacity', '0.9');
            layer.appendChild(polygon);
            break;
        }
        case 'path': {
            const line = svgEl('line');
            line.setAttribute('x1', shape.a.x); line.setAttribute('y1', shape.a.y);
            line.setAttribute('x2', shape.b.x); line.setAttribute('y2', shape.b.y);
            line.setAttribute('stroke', shape.color);
            line.setAttribute('stroke-width', shape.width);
            line.setAttribute('stroke-linecap', 'round');
            line.setAttribute('stroke-dasharray', '9 7');
            line.setAttribute('opacity', '0.85');
            layer.appendChild(line);
            break;
        }
        case 'contour': {
            const poly = svgEl('polyline');
            poly.setAttribute('points', shape.polyline.map(v => `${v.x},${v.y}`).join(' '));
            poly.setAttribute('fill', 'none');
            poly.setAttribute('stroke', shape.color);
            poly.setAttribute('stroke-width', '1.4');
            poly.setAttribute('stroke-linejoin', 'round');
            poly.setAttribute('stroke-linecap', 'round');
            poly.setAttribute('opacity', '0.72');
            layer.appendChild(poly);
            break;
        }
        case 'wall': {
            const a = shape.a, b = shape.b;
            const isHedge = shape.color === IOF.veg_slow;
            if (isHedge) {
                // Thick green band for hedge
                const polygon = svgEl('polygon');
                polygon.setAttribute('points', shape.hull.map(v => `${v.x},${v.y}`).join(' '));
                polygon.setAttribute('fill', IOF.veg_slow);
                polygon.setAttribute('opacity', '0.95');
                layer.appendChild(polygon);
            } else {
                // Stone wall / fence — black thick line
                const line = svgEl('line');
                line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
                line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
                line.setAttribute('stroke', shape.color);
                line.setAttribute('stroke-width', (shape.half * 0.9) || 4);
                line.setAttribute('stroke-linecap', 'round');
                layer.appendChild(line);
                if (shape.ticked) drawFenceTicks(layer, a, b);
            }
            break;
        }
        case 'short_fence': {
            const line = svgEl('line');
            line.setAttribute('x1', shape.a.x); line.setAttribute('y1', shape.a.y);
            line.setAttribute('x2', shape.b.x); line.setAttribute('y2', shape.b.y);
            line.setAttribute('stroke', shape.color);
            line.setAttribute('stroke-width', '3');
            line.setAttribute('stroke-linecap', 'round');
            layer.appendChild(line);
            drawFenceTicks(layer, shape.a, shape.b);
            break;
        }
        case 'boulder': {
            const c = svgEl('circle');
            c.setAttribute('cx', shape.cx); c.setAttribute('cy', shape.cy);
            c.setAttribute('r', shape.r);
            c.setAttribute('fill', shape.color);
            layer.appendChild(c);
            break;
        }
        case 'cliff': {
            const poly = svgEl('polyline');
            poly.setAttribute('points', shape.polyline.map(v => `${v.x},${v.y}`).join(' '));
            poly.setAttribute('fill', 'none');
            poly.setAttribute('stroke', shape.color);
            poly.setAttribute('stroke-width', '5');
            poly.setAttribute('stroke-linejoin', 'round');
            poly.setAttribute('stroke-linecap', 'round');
            layer.appendChild(poly);
            // Hatches on one side
            for (let i = 0; i < shape.polyline.length - 1; i++) {
                const a = shape.polyline[i], b = shape.polyline[i + 1];
                const dx = b.x - a.x, dy = b.y - a.y;
                const len = Math.hypot(dx, dy);
                const ux = dx / len, uy = dy / len;
                const step = 12;
                for (let t = step / 2; t < len; t += step) {
                    const px = a.x + ux * t, py = a.y + uy * t;
                    const tk = svgEl('line');
                    tk.setAttribute('x1', px); tk.setAttribute('y1', py);
                    tk.setAttribute('x2', px - uy * 8); tk.setAttribute('y2', py + ux * 8);
                    tk.setAttribute('stroke', shape.color);
                    tk.setAttribute('stroke-width', '2');
                    layer.appendChild(tk);
                }
            }
            break;
        }
    }
}

function drawFenceTicks(layer, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const step = 16;
    for (let t = step / 2; t < len; t += step) {
        const px = a.x + ux * t, py = a.y + uy * t;
        // X-mark for crossable fence: two short crossed lines
        const tk = svgEl('line');
        tk.setAttribute('x1', px - uy * 4); tk.setAttribute('y1', py + ux * 4);
        tk.setAttribute('x2', px + uy * 4); tk.setAttribute('y2', py - ux * 4);
        tk.setAttribute('stroke', '#000');
        tk.setAttribute('stroke-width', '1.5');
        layer.appendChild(tk);
    }
}

function drawControls(start, ziel) {
    const layer = SVG('rp-control-layer');
    // Use the same draw routines as regular play mode: two equal circles +
    // a straight connection line (no arrow, no dashed line).
    [start, ziel].forEach(pt => {
        const c = svgEl('circle');
        c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); c.setAttribute('r', R_CONTROL);
        c.setAttribute('fill', 'transparent');
        c.setAttribute('stroke', CONTROL_COLOR);
        c.setAttribute('stroke-width', '3');
        c.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(c);
    });

    const GAP = 8;
    const dx  = ziel.x - start.x;
    const dy  = ziel.y - start.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 2 * (R_CONTROL + GAP)) return;

    const angle  = Math.atan2(dy, dx);
    const offset = R_CONTROL + GAP;
    const line = svgEl('line');
    line.setAttribute('x1', start.x + Math.cos(angle) * offset);
    line.setAttribute('y1', start.y + Math.sin(angle) * offset);
    line.setAttribute('x2', ziel.x  - Math.cos(angle) * offset);
    line.setAttribute('y2', ziel.y  - Math.sin(angle) * offset);
    line.setAttribute('stroke', CONTROL_COLOR);
    line.setAttribute('stroke-width', '3');
    line.setAttribute('fill', 'none');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    layer.appendChild(line);
}

/* =========================================================
   CHOICE FLOW + PLAY-MODE-STYLE ANIMATION
========================================================= */

function renderChoiceButtons() {
    const bar = SVG('play-btn-bar');
    bar.innerHTML = '';

    const isDesktop = document.body.classList.contains('desktop');
    const fontSize = isDesktop
        ? `${Math.min(28, Math.max(14, Math.round(56 / 2)))}px`
        : `${Math.min(22, Math.max(8,  Math.round(44 / 2)))}px`;

    // Buttons in play-mode style (route-btn route-btn-labeled)
    scene.routes.forEach((r, i) => {
        const btn = document.createElement('button');
        btn.className = 'play-btn route-btn route-btn-labeled';
        btn.style.background = ROUTE_COLORS[i];
        btn.style.fontSize   = fontSize;
        btn.dataset.idx = i;

        const label = document.createElement('span');
        label.className = 'play-btn-label';
        label.textContent = i === 0 ? 'Links' : 'Rechts';
        btn.appendChild(label);

        btn.addEventListener('click', () => pickSide(i));
        bar.appendChild(btn);
    });
}

function pickSide(idx) {
    if (phase !== 'choose') return;
    phase = 'reveal';

    const choiceTime = ((performance.now() - choiceStartTime) / 1000);
    const chosen     = scene.routes[idx];
    const other      = scene.routes[1 - idx];

    // Disable buttons; mark which one was clicked
    const buttons = SVG('play-btn-bar').querySelectorAll('.play-btn');
    buttons.forEach((b, i) => {
        b.disabled = true;
        if (i === idx) b.classList.add('active');
    });

    // Determine which route is the shorter (correct)
    const shorter = chosen.time <= other.time ? chosen : other;
    const longer  = chosen.time >  other.time ? chosen : other;
    const correctIdx = chosen.time <= other.time ? idx : 1 - idx;
    const slowerIdx  = correctIdx === 0 ? 1 : 0;
    const isCorrect  = idx === correctIdx;
    const diffSec    = longer.time - shorter.time;

    // Replace the original Links/Rechts label with the crown (correct) and
    // the +X% / +Ys delta (slower). Layout is identical for both — the same
    // .play-btn-label slot is reused so the text simply gets swapped out.
    const correctLabel = buttons[correctIdx].querySelector('.play-btn-label');
    if (correctLabel) {
        correctLabel.innerHTML = window.icon ? window.icon('crown', '1.6em') : '';
        correctLabel.classList.add('rp-btn-crown');
    }
    buttons[correctIdx].classList.add('route-btn-fastest');

    const slowerLabel = buttons[slowerIdx].querySelector('.play-btn-label');
    if (slowerLabel && diffSec > 0) {
        slowerLabel.innerHTML =
            `<span class="route-btn-delta-rel">+${Math.round((diffSec / shorter.time) * 100)}%</span>` +
            `<span class="route-btn-delta-abs">+${diffSec.toFixed(1)}s</span>`;
        slowerLabel.classList.add('route-btn-delta');
    }

    // Animate routes (play.js dot-and-trail style, both routes in parallel)
    animateRoutes(idx);

    // Stats update — flame goes orange when a new record is set
    stats.attempts++;
    let newRecord = false;
    if (isCorrect) {
        stats.correct++;
        stats.streak++;
        if (stats.streak > stats.bestStreak) {
            stats.bestStreak = stats.streak;
            newRecord = true;
        }
    } else {
        stats.streak = 0;
    }
    saveStats();
    renderHud({ choiceTime, newRecord });

    // Submit to DB
    submitChoice({
        correct:      isCorrect,
        choice_time:  choiceTime,
        shorter_time: shorter.time,
        longer_time:  longer.time,
    });
}

function animateRoutes(chosenIdx) {
    const layer = SVG('rp-route-layer');
    layer.innerHTML = '';

    const validTimes = scene.routes.map(r => r.time).filter(t => t > 0);
    const minTime    = validTimes.length ? Math.min(...validTimes) : 1;

    const anims = scene.routes.map((route, i) => {
        const rP = route.points;
        if (!rP || rP.length < 2) return null;

        const dists = [0];
        for (let j = 1; j < rP.length; j++)
            dists.push(dists[j - 1] + Math.hypot(rP[j].x - rP[j - 1].x, rP[j].y - rP[j - 1].y));
        const totalDist = dists[dists.length - 1];

        const ratio    = route.time > 0 ? route.time / minTime : 1;
        const excess   = ratio - 1;
        const amp      = 5 - 4 * Math.min(excess, 1);
        const duration = 1 + excess * amp;        // seconds

        const color = ROUTE_COLORS[i];

        // Background dimmed white outline
        const bg = svgEl('polyline');
        bg.setAttribute('points', rP.map(p => `${p.x},${p.y}`).join(' '));
        bg.setAttribute('fill', 'none');
        bg.setAttribute('stroke', 'white');
        bg.setAttribute('stroke-width', '3');
        bg.setAttribute('opacity', '0.2');
        bg.setAttribute('stroke-linejoin', 'round');
        layer.appendChild(bg);

        const trail = svgEl('polyline');
        trail.setAttribute('fill', 'none');
        trail.setAttribute('stroke', color);
        trail.setAttribute('stroke-width', '3');
        trail.setAttribute('stroke-linecap',  'round');
        trail.setAttribute('stroke-linejoin', 'round');
        trail.setAttribute('points', `${rP[0].x},${rP[0].y}`);
        if (i !== chosenIdx) trail.setAttribute('opacity', '0.7');
        layer.appendChild(trail);

        const dot = svgEl('circle');
        dot.setAttribute('r', '6');
        dot.setAttribute('fill', color);
        dot.setAttribute('cx', rP[0].x);
        dot.setAttribute('cy', rP[0].y);
        layer.appendChild(dot);

        return { rP, dists, totalDist, duration, color, trail, dot, i, done: false };
    }).filter(Boolean);

    const t0 = performance.now();
    if (_routeAnim) cancelAnimationFrame(_routeAnim);

    (function tick(now) {
        const elapsed = (now - t0) / 1000;
        let allDone = true;

        anims.forEach(anim => {
            if (anim.done) return;
            const { rP, dists, totalDist, duration, trail, dot } = anim;

            const dist = Math.min((elapsed / duration) * totalDist, totalDist);
            let seg = dists.length - 2;
            for (let j = 1; j < dists.length; j++) {
                if (dists[j] >= dist) { seg = j - 1; break; }
            }
            const segLen = (dists[seg + 1] ?? totalDist) - dists[seg];
            const segT   = segLen > 0 ? (dist - dists[seg]) / segLen : 1;
            const p0 = rP[seg], p1 = rP[Math.min(seg + 1, rP.length - 1)];
            const cx = p0.x + (p1.x - p0.x) * segT;
            const cy = p0.y + (p1.y - p0.y) * segT;

            dot.setAttribute('cx', cx);
            dot.setAttribute('cy', cy);

            const pts = rP.slice(0, seg + 1).map(p => `${p.x},${p.y}`);
            if (segT > 0) pts.push(`${cx},${cy}`);
            trail.setAttribute('points', pts.join(' '));

            if (dist >= totalDist) {
                anim.done = true;
                dot.remove();
                emitWave(rP[rP.length - 1], anim.color);
            } else {
                allDone = false;
            }
        });

        if (!allDone) _routeAnim = requestAnimationFrame(tick);
        else _routeAnim = null;
    })(t0);
}

function emitWave(pos, color) {
    const layer = SVG('rp-control-layer');
    const c = svgEl('circle');
    c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y); c.setAttribute('r', R_CONTROL);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', color);
    c.setAttribute('stroke-width', '14');
    c.setAttribute('opacity', '0.85');
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    c.style.filter = 'blur(4px)';
    layer.appendChild(c);
    const start = performance.now();
    (function step(now) {
        const t = Math.min((now - start) / 1800, 1);
        const e = 1 - Math.pow(1 - t, 2);
        c.setAttribute('r',       R_CONTROL + (R_CONTROL * 1.6) * e);
        c.setAttribute('opacity', (1 - e) * 0.85);
        if (t < 1) requestAnimationFrame(step);
        else c.remove();
    })(start);
}

/* =========================================================
   FEEDBACK + STATS + DB
========================================================= */

function loadStats() {
    try {
        const o = JSON.parse(localStorage.getItem('rpStats') || '{}');
        return {
            attempts:   o.attempts   || 0,
            correct:    o.correct    || 0,
            streak:     o.streak     || 0,
            bestStreak: o.bestStreak || 0,
        };
    } catch { return { attempts: 0, correct: 0, streak: 0, bestStreak: 0 }; }
}
function saveStats() {
    try { localStorage.setItem('rpStats', JSON.stringify(stats)); } catch {}
}

function renderHud(opts = {}) {
    const attemptsEl = SVG('rp-attempts');
    const streakEl   = SVG('rp-streak');
    const flameEl    = SVG('rp-flame');
    const choiceEl   = SVG('rp-choice-time');
    if (attemptsEl) attemptsEl.textContent = stats.attempts;
    if (streakEl)   streakEl.textContent   = stats.streak;
    if (flameEl) {
        // Orange flame when the current streak just broke the previous record
        const onFire = !!opts.newRecord;
        flameEl.classList.toggle('is-record', onFire);
        // Also stay orange while the current streak == best (record is alive)
        if (!onFire && stats.streak > 0 && stats.streak === stats.bestStreak) {
            flameEl.classList.add('is-record');
        }
    }
    if (choiceEl && opts.choiceTime !== undefined) {
        choiceEl.textContent = `${opts.choiceTime.toFixed(2)}s`;
    }
}

function submitChoice(payload) {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? '';
    fetch('/play/infinity/submit-choice/', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
        body:    JSON.stringify(payload),
    }).catch(err => console.error('submit-infinite-choice failed:', err));
}
