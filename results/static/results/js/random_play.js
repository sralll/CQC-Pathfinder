/* =========================================================
   RANDOM PLAY — procedurally-generated single-obstacle leg
   Front-end only, no DB writes. Isolated from regular play.

   Architecture
   ------------
   1.  generateScene()       — random obstacle (building / pond / fence /
                                impassable-cliff / hedge),  random decoration,
                                random start + ziel on opposite sides.
   2.  tangentRoutes(...)    — for a convex obstacle, computes the shortest
                                detour on each side using the convex hull of
                                {start, ziel, obstacle vertices}.
   3.  renderScene()         — paints background, decoration, obstacle, start
                                and ziel circles.  Routes are HIDDEN.
   4.  pickSide(side)        — animates the chosen route, fades the other,
                                shows feedback, updates streak.
   5.  next()                — clears + generates a fresh scene.

   The scene uses an internal 1200×800 coordinate space; the SVG's
   preserveAspectRatio handles fitting it into the available viewport.
========================================================= */

const VB_W = 1200;
const VB_H = 800;
const RUN_SPEED = 4.75;    // m/s — same number used in regular play mode
const PX_PER_M  = 6;       // viewBox px per "metre"  → 200 px = ~33 m

const COLOR_LEFT  = '#0055FF';
const COLOR_RIGHT = '#DD0011';

const SVG  = (id) => document.getElementById(id);
const NS   = 'http://www.w3.org/2000/svg';
const svgEl = (tag) => document.createElementNS(NS, tag);

let scene  = null;
let phase  = 'choose';    // 'choose' | 'reveal'
let stats  = loadStats();

document.addEventListener('DOMContentLoaded', () => {
    const svg = SVG('rp-svg');
    svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
    next();
    window.addEventListener('keydown', e => {
        if (phase === 'choose') {
            if (e.key === 'ArrowLeft')  pickSide('left');
            if (e.key === 'ArrowRight') pickSide('right');
        } else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
            next();
        }
    });
    renderHud();
});

/* =========================================================
   SCENE GENERATION
========================================================= */

const OBSTACLE_TYPES = ['building', 'pond', 'fence', 'hedge', 'cliff'];

function next() {
    phase = 'choose';
    scene = generateScene();
    renderScene();
    closeFeedback();
    renderChoiceButtons();
}

function generateScene() {
    const type   = pickRandom(OBSTACLE_TYPES);
    const center = {
        x: rand(VB_W * 0.30, VB_W * 0.70),
        y: rand(VB_H * 0.30, VB_H * 0.70),
    };

    let obstacle;
    switch (type) {
        case 'building': obstacle = makeBuilding(center.x, center.y); break;
        case 'pond':     obstacle = makePond(center.x, center.y);     break;
        case 'fence':    obstacle = makeFence(center.x, center.y);    break;
        case 'hedge':    obstacle = makeHedge(center.x, center.y);    break;
        case 'cliff':    obstacle = makeCliff(center.x, center.y);    break;
    }

    const { start, ziel } = placeEndpoints(obstacle);
    const routes = tangentRoutes(start, ziel, obstacle.hull);

    const decor = makeDecoration(obstacle);

    return { obstacle, start, ziel, routes, decor };
}

/* ── Obstacle generators ───────────────────────────────── */

function makeBuilding(cx, cy) {
    // Rotated rectangle.  Sometimes an L-shape via two stacked rectangles.
    const w = rand(140, 260);
    const h = rand(100, 220);
    const angle = rand(0, Math.PI * 2);
    const corners = rectCorners(cx, cy, w, h, angle);

    if (Math.random() < 0.35) {
        // L-shape: subtract a smaller rect from one corner.  We don't actually
        // model the cut-out for routing; the convex hull (the full rect) is
        // what the path is computed against, which is fine here.
        const c2w = w * rand(0.4, 0.6);
        const c2h = h * rand(0.4, 0.6);
        const offX = (w - c2w) / 2 * pickRandom([-1, 1]);
        const offY = (h - c2h) / 2 * pickRandom([-1, 1]);
        const cx2  = cx + offX * Math.cos(angle) - offY * Math.sin(angle);
        const cy2  = cy + offX * Math.sin(angle) + offY * Math.cos(angle);
        const cutout = rectCorners(cx2, cy2, c2w + 4, c2h + 4, angle);
        return {
            type: 'building',
            polygons: [corners, cutout],
            hull: corners,                         // routing uses the full rect
            color: '#1f1f1f',
            stroke: '#000',
        };
    }

    return {
        type:  'building',
        polygons: [corners],
        hull:  corners,
        color: '#1f1f1f',
        stroke:'#000',
    };
}

function rectCorners(cx, cy, w, h, angle) {
    const hw = w/2, hh = h/2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    return [
        { x: -hw, y: -hh },
        { x:  hw, y: -hh },
        { x:  hw, y:  hh },
        { x: -hw, y:  hh },
    ].map(p => ({
        x: cx + p.x*ca - p.y*sa,
        y: cy + p.x*sa + p.y*ca,
    }));
}

function makePond(cx, cy) {
    // Organic blob: radial polygon with smooth perturbation.
    const n = 14;
    const baseR = rand(80, 150);
    const verts = [];
    let r = baseR;
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.05, 0.05);
        // Smooth jitter via a random walk in radius
        r = clamp(r + rand(-baseR * 0.10, baseR * 0.10), baseR * 0.65, baseR * 1.20);
        verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return {
        type:  'pond',
        polygons: [verts],
        hull:  convexHull(verts),
        color: '#82d2f2',
        stroke:'#1a78b3',
    };
}

function makeFence(cx, cy) {
    // Single line segment treated as an impassable barrier.
    const len   = rand(220, 380);
    const angle = rand(0, Math.PI * 2);
    const dx = Math.cos(angle) * len / 2;
    const dy = Math.sin(angle) * len / 2;
    const a  = { x: cx - dx, y: cy - dy };
    const b  = { x: cx + dx, y: cy + dy };
    // For routing, give the line a tiny "thickness" so the hull algorithm
    // can route around either endpoint without zero-width edge cases.
    const nx = -Math.sin(angle) * 4;
    const ny =  Math.cos(angle) * 4;
    const hull = [
        { x: a.x - nx, y: a.y - ny },
        { x: b.x - nx, y: b.y - ny },
        { x: b.x + nx, y: b.y + ny },
        { x: a.x + nx, y: a.y + ny },
    ];
    return {
        type:    'fence',
        polygons:[],           // not a filled shape
        segments:[[a, b]],
        hull,
        color:   '#000',
        stroke:  '#000',
    };
}

function makeHedge(cx, cy) {
    // Wider line with green colouring.
    const len   = rand(240, 380);
    const angle = rand(0, Math.PI * 2);
    const dx = Math.cos(angle) * len / 2;
    const dy = Math.sin(angle) * len / 2;
    const a  = { x: cx - dx, y: cy - dy };
    const b  = { x: cx + dx, y: cy + dy };
    const half = 14;
    const nx = -Math.sin(angle) * half;
    const ny =  Math.cos(angle) * half;
    const hull = [
        { x: a.x - nx, y: a.y - ny },
        { x: b.x - nx, y: b.y - ny },
        { x: b.x + nx, y: b.y + ny },
        { x: a.x + nx, y: a.y + ny },
    ];
    return {
        type:    'hedge',
        polygons:[hull],
        hull,
        color:   '#5a8b3e',
        stroke:  '#324c1f',
    };
}

function makeCliff(cx, cy) {
    // Impassable cliff: a jagged thick line.
    const segments = rand(3, 6) | 0;
    const totalLen = rand(220, 360);
    const angle    = rand(0, Math.PI * 2);
    const segLen   = totalLen / segments;
    const points = [{ x: cx - Math.cos(angle) * totalLen / 2,
                      y: cy - Math.sin(angle) * totalLen / 2 }];
    for (let i = 0; i < segments; i++) {
        const a = angle + rand(-0.25, 0.25);
        const last = points[points.length - 1];
        points.push({
            x: last.x + Math.cos(a) * segLen,
            y: last.y + Math.sin(a) * segLen,
        });
    }
    // Thicken into a polygon for routing.
    const half = 10;
    const hull = inflatePolyline(points, half);
    return {
        type:    'cliff',
        polygons:[],
        polyline:points,
        hull,
        color:   '#000',
        stroke:  '#000',
    };
}

function inflatePolyline(pts, half) {
    // Compute a simple "thickness" hull by offsetting each side
    if (pts.length < 2) return [];
    // Average normal-perpendicular for each side, mirrored
    const top = [];
    const bot = [];
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

/* ── Decoration (purely cosmetic; ignored by routing) ────── */

function makeDecoration(obstacle) {
    const decor = [];
    const bb = boundingBox(obstacle.hull);

    // A few light-green vegetation blobs scattered around the periphery
    const vegCount = randInt(3, 6);
    for (let i = 0; i < vegCount; i++) {
        const c = randomFarPoint(obstacle.hull, 80);
        if (!c) continue;
        const r = rand(30, 70);
        decor.push({ kind: 'vegetation', cx: c.x, cy: c.y, r });
    }

    // A few path/street strips (light grey)
    if (Math.random() < 0.7) {
        const horiz = Math.random() < 0.5;
        const t = rand(VB_W * 0.15, VB_W * 0.85);
        decor.push({
            kind: 'path',
            x: horiz ? 0     : t - 6,
            y: horiz ? t - 6 : 0,
            w: horiz ? VB_W  : 12,
            h: horiz ? 12    : VB_H,
        });
    }

    return decor;
}

function randomFarPoint(hull, minDist) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const p = { x: rand(40, VB_W - 40), y: rand(40, VB_H - 40) };
        const d = distToPolygon(p, hull);
        if (d > minDist) return p;
    }
    return null;
}

/* ── Endpoint placement ────────────────────────────────── */

function placeEndpoints(obstacle) {
    const bb = boundingBox(obstacle.hull);
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    const w  = bb.maxX - bb.minX;
    const h  = bb.maxY - bb.minY;

    // Choose an axis along which to place start/ziel.  Pick the SHORTER side
    // of the bounding box so the detour is meaningful (start and ziel are
    // separated by the longer dimension of the obstacle).
    const horizontal = h < w;   // obstacle wider than tall → endpoints above/below

    const margin = rand(90, 160);
    let start, ziel;
    if (horizontal) {
        // Place above and below
        start = { x: cx + rand(-w * 0.35, w * 0.35), y: clamp(bb.minY - margin, 60, VB_H - 60) };
        ziel  = { x: cx + rand(-w * 0.35, w * 0.35), y: clamp(bb.maxY + margin, 60, VB_H - 60) };
    } else {
        // Place left and right
        start = { x: clamp(bb.minX - margin, 60, VB_W - 60), y: cy + rand(-h * 0.35, h * 0.35) };
        ziel  = { x: clamp(bb.maxX + margin, 60, VB_W - 60), y: cy + rand(-h * 0.35, h * 0.35) };
    }

    // Randomly swap so the visual orientation varies
    if (Math.random() < 0.5) [start, ziel] = [ziel, start];

    return { start, ziel };
}

/* =========================================================
   GEOMETRY HELPERS
========================================================= */

function rand(min, max)     { return min + Math.random() * (max - min); }
function randInt(min, max)  { return Math.floor(rand(min, max + 1)); }
function pickRandom(arr)    { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(v, lo, hi)   { return Math.max(lo, Math.min(hi, v)); }

function boundingBox(pts) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs),
             minY: Math.min(...ys), maxY: Math.max(...ys) };
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
    const cx = a.x + dx * t, cy = a.y + dy * t;
    return Math.hypot(p.x - cx, p.y - cy);
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

function pathLength(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    }
    return total;
}

/* =========================================================
   SIDE-SPLIT ROUTING — shortest path on each side of the
   obstacle, using the convex hull of {start, ziel, hull}.
========================================================= */

function tangentRoutes(start, ziel, obstacleHull) {
    // Hull of everything; the two arcs from start → ziel are our routes.
    const allPoints = [start, ziel, ...obstacleHull];
    const hull      = convexHull(allPoints);

    const sIdx = hull.findIndex(p => p === start);
    const zIdx = hull.findIndex(p => p === ziel);

    if (sIdx === -1 || zIdx === -1) {
        // Start or ziel is inside the obstacle hull (shouldn't happen after
        // proper endpoint placement, but fall back to a straight line).
        return {
            left:  { points: [start, ziel], length: pathLength([start, ziel]) },
            right: { points: [start, ziel], length: pathLength([start, ziel]) },
        };
    }

    // Walk hull in both directions from start to ziel
    const arc1 = walkArc(hull, sIdx, zIdx,  1);
    const arc2 = walkArc(hull, sIdx, zIdx, -1);

    // Which is "left" of the start→ziel segment?
    const mid = arc1[Math.floor(arc1.length / 2)];
    const sideSign = (ziel.x - start.x) * (mid.y - start.y) - (ziel.y - start.y) * (mid.x - start.x);
    // In screen coords (y-down), cross product > 0 means "right of vector",
    // but visual "left" from a top-down map perspective is the same direction
    // a player would intuitively call "left" while running from start to ziel.
    // Pick a convention and stick to it:
    const arc1IsLeft = sideSign < 0;

    return arc1IsLeft
        ? { left:  buildRoute(arc1), right: buildRoute(arc2) }
        : { left:  buildRoute(arc2), right: buildRoute(arc1) };
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

function buildRoute(pts) {
    return { points: pts, length: pathLength(pts) };
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
    clearLayer('rp-ui-layer');

    drawBackground();
    drawDecor(scene.decor);
    drawObstacle(scene.obstacle);
    drawControl(scene.start, true);
    drawControl(scene.ziel,  false);
}

function clearLayer(id) { SVG(id).innerHTML = ''; }

function drawBackground() {
    const r = svgEl('rect');
    r.setAttribute('x', 0); r.setAttribute('y', 0);
    r.setAttribute('width', VB_W); r.setAttribute('height', VB_H);
    r.setAttribute('fill', '#fff4cc');
    SVG('rp-bg-layer').appendChild(r);
}

function drawDecor(decor) {
    const layer = SVG('rp-decor-layer');
    for (const d of decor) {
        if (d.kind === 'vegetation') {
            const c = svgEl('circle');
            c.setAttribute('cx', d.cx); c.setAttribute('cy', d.cy); c.setAttribute('r', d.r);
            c.setAttribute('fill', '#bce0a0');
            c.setAttribute('opacity', '0.85');
            layer.appendChild(c);
        } else if (d.kind === 'path') {
            const r = svgEl('rect');
            r.setAttribute('x', d.x); r.setAttribute('y', d.y);
            r.setAttribute('width', d.w); r.setAttribute('height', d.h);
            r.setAttribute('fill', '#f7f7f7');
            r.setAttribute('opacity', '0.9');
            layer.appendChild(r);
        }
    }
}

function drawObstacle(obs) {
    const layer = SVG('rp-obstacle-layer');
    switch (obs.type) {
        case 'building': {
            obs.polygons.forEach((poly, i) => {
                const p = svgEl('polygon');
                p.setAttribute('points', poly.map(v => `${v.x},${v.y}`).join(' '));
                if (i === 0) {
                    p.setAttribute('fill', obs.color);
                    p.setAttribute('stroke', obs.stroke);
                    p.setAttribute('stroke-width', '2');
                } else {
                    // L-shape "cut-out" — overlay matching the background colour
                    p.setAttribute('fill', '#fff4cc');
                    p.setAttribute('stroke', 'none');
                }
                layer.appendChild(p);
            });
            break;
        }
        case 'pond': {
            const p = svgEl('polygon');
            p.setAttribute('points', obs.polygons[0].map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', obs.color);
            p.setAttribute('stroke', obs.stroke);
            p.setAttribute('stroke-width', '3');
            layer.appendChild(p);
            break;
        }
        case 'fence': {
            const [a, b] = obs.segments[0];
            const line = svgEl('line');
            line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
            line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
            line.setAttribute('stroke', '#000');
            line.setAttribute('stroke-width', '4');
            line.setAttribute('stroke-dasharray', '8 4');
            layer.appendChild(line);
            // Tick marks
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
            const ux = dx / len, uy = dy / len;
            const tickStep = 18, tickLen = 5;
            for (let t = tickStep; t < len; t += tickStep) {
                const px = a.x + ux * t, py = a.y + uy * t;
                const tk = svgEl('line');
                tk.setAttribute('x1', px); tk.setAttribute('y1', py);
                tk.setAttribute('x2', px - uy * tickLen);
                tk.setAttribute('y2', py + ux * tickLen);
                tk.setAttribute('stroke', '#000');
                tk.setAttribute('stroke-width', '1.5');
                layer.appendChild(tk);
            }
            break;
        }
        case 'hedge': {
            const p = svgEl('polygon');
            p.setAttribute('points', obs.polygons[0].map(v => `${v.x},${v.y}`).join(' '));
            p.setAttribute('fill', obs.color);
            p.setAttribute('stroke', obs.stroke);
            p.setAttribute('stroke-width', '2');
            p.setAttribute('opacity', '0.92');
            layer.appendChild(p);
            break;
        }
        case 'cliff': {
            const poly = svgEl('polyline');
            poly.setAttribute('points', obs.polyline.map(v => `${v.x},${v.y}`).join(' '));
            poly.setAttribute('fill', 'none');
            poly.setAttribute('stroke', '#000');
            poly.setAttribute('stroke-width', '5');
            poly.setAttribute('stroke-linejoin', 'round');
            poly.setAttribute('stroke-linecap', 'round');
            layer.appendChild(poly);
            // Hatches on one side
            for (let i = 0; i < obs.polyline.length - 1; i++) {
                const a = obs.polyline[i], b = obs.polyline[i + 1];
                const dx = b.x - a.x, dy = b.y - a.y;
                const len = Math.hypot(dx, dy);
                const ux = dx / len, uy = dy / len;
                const step = 12;
                for (let t = step / 2; t < len; t += step) {
                    const px = a.x + ux * t, py = a.y + uy * t;
                    const tk = svgEl('line');
                    tk.setAttribute('x1', px); tk.setAttribute('y1', py);
                    tk.setAttribute('x2', px - uy * 7);
                    tk.setAttribute('y2', py + ux * 7);
                    tk.setAttribute('stroke', '#000');
                    tk.setAttribute('stroke-width', '2');
                    layer.appendChild(tk);
                }
            }
            break;
        }
    }
}

function drawControl(pt, isStart) {
    const layer = SVG('rp-control-layer');
    const r = 22;
    const c = svgEl('circle');
    c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); c.setAttribute('r', r);
    c.setAttribute('class', 'rp-control-circle');
    layer.appendChild(c);

    if (isStart) {
        // Triangle for start
        const tri = svgEl('polygon');
        const s = 14;
        const pts = [
            { x: pt.x,         y: pt.y - s },
            { x: pt.x + s*0.87, y: pt.y + s/2 },
            { x: pt.x - s*0.87, y: pt.y + s/2 },
        ];
        tri.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
        tri.setAttribute('fill', 'none');
        tri.setAttribute('stroke', '#a033f0');
        tri.setAttribute('stroke-width', '2.5');
        layer.appendChild(tri);
    } else {
        // Concentric inner circle for ziel
        const c2 = svgEl('circle');
        c2.setAttribute('cx', pt.x); c2.setAttribute('cy', pt.y); c2.setAttribute('r', r * 0.55);
        c2.setAttribute('class', 'rp-control-circle');
        c2.setAttribute('stroke-width', '2.5');
        layer.appendChild(c2);
    }
}

function drawRoute(route, color, classes = '') {
    const layer = SVG('rp-route-layer');
    const path = svgEl('polyline');
    path.setAttribute('points', route.points.map(p => `${p.x},${p.y}`).join(' '));
    path.setAttribute('class', `rp-route ${classes}`);
    path.setAttribute('stroke', color);
    layer.appendChild(path);
    return path;
}

/* =========================================================
   CHOICE FLOW
========================================================= */

function renderChoiceButtons() {
    const bar = SVG('rp-btn-bar');
    bar.innerHTML = '';

    const leftBtn  = document.createElement('button');
    leftBtn.className = 'rp-btn';
    leftBtn.style.background = COLOR_LEFT;
    leftBtn.textContent = 'Links';
    leftBtn.addEventListener('click', () => pickSide('left'));

    const rightBtn = document.createElement('button');
    rightBtn.className = 'rp-btn';
    rightBtn.style.background = COLOR_RIGHT;
    rightBtn.textContent = 'Rechts';
    rightBtn.addEventListener('click', () => pickSide('right'));

    bar.appendChild(leftBtn);
    bar.appendChild(rightBtn);
}

function renderNextButton() {
    const bar = SVG('rp-btn-bar');
    bar.innerHTML = '';

    const btn = document.createElement('button');
    btn.className = 'rp-btn rp-btn-next';
    btn.textContent = 'Nächste';
    btn.addEventListener('click', next);
    bar.appendChild(btn);
}

function pickSide(side) {
    if (phase !== 'choose') return;
    phase = 'reveal';

    const chosen   = scene.routes[side];
    const otherKey = side === 'left' ? 'right' : 'left';
    const other    = scene.routes[otherKey];

    // Draw both routes — chosen highlighted, other faded — and animate the
    // chosen one's trace from start to ziel.
    const chosenColor = side === 'left' ? COLOR_LEFT : COLOR_RIGHT;
    const otherColor  = side === 'left' ? COLOR_RIGHT : COLOR_LEFT;

    drawRoute(other,  otherColor,  'rp-route-faded');
    drawRoute(chosen, chosenColor);
    animateTrace(chosen, chosenColor);

    // Determine performance
    const correctSide = scene.routes.left.length <= scene.routes.right.length ? 'left' : 'right';
    const isCorrect   = side === correctSide;
    const diffPx      = Math.abs(scene.routes.left.length - scene.routes.right.length);
    const diffMeters  = diffPx / PX_PER_M;
    const diffSeconds = diffMeters / RUN_SPEED;

    showFeedback({ isCorrect, diffMeters, diffSeconds, chosen, correctSide });

    // Update stats
    stats.attempts++;
    if (isCorrect) { stats.correct++; stats.streak++; stats.bestStreak = Math.max(stats.bestStreak, stats.streak); }
    else           { stats.streak = 0; }
    saveStats();
    renderHud();

    // Switch button bar to "next"
    renderNextButton();
}

function animateTrace(route, color) {
    // Build a polyline and animate its stroke-dashoffset
    const layer = SVG('rp-route-layer');
    const trace = svgEl('polyline');
    trace.setAttribute('points', route.points.map(p => `${p.x},${p.y}`).join(' '));
    trace.setAttribute('class', 'rp-trace');
    trace.setAttribute('stroke', color);
    layer.appendChild(trace);
    const len = route.length;
    trace.style.strokeDasharray  = `${len}`;
    trace.style.strokeDashoffset = `${len}`;
    // Speed scales with route length; clamp between 700-1400ms
    const duration = clamp(len * 1.3, 700, 1400);
    trace.style.transition = `stroke-dashoffset ${duration}ms linear`;
    // Trigger transition on next frame
    requestAnimationFrame(() => { trace.style.strokeDashoffset = '0'; });
}

/* =========================================================
   FEEDBACK
========================================================= */

function showFeedback({ isCorrect, diffMeters, diffSeconds }) {
    const el = SVG('rp-feedback');
    el.innerHTML = '';

    const status = document.createElement('span');
    status.className = isCorrect ? 'rp-feedback-correct' : 'rp-feedback-wrong';
    status.textContent = isCorrect ? '✓ Schnellste Route' : '✗ Längere Route';
    el.appendChild(status);

    if (!isCorrect) {
        const diff = document.createElement('span');
        diff.className = 'rp-feedback-diff';
        diff.textContent = `+${diffMeters.toFixed(0)} m  ·  +${diffSeconds.toFixed(1)}s`;
        el.appendChild(diff);
    } else if (diffMeters < 1) {
        const diff = document.createElement('span');
        diff.className = 'rp-feedback-diff';
        diff.textContent = '(praktisch gleich lang)';
        el.appendChild(diff);
    }

    el.classList.add('open');
}

function closeFeedback() {
    const el = SVG('rp-feedback');
    el.classList.remove('open');
    el.innerHTML = '';
}

/* =========================================================
   STATS / STREAK  (localStorage, no DB)
========================================================= */

function loadStats() {
    try {
        const raw = localStorage.getItem('rpStats');
        if (!raw) throw 0;
        const o = JSON.parse(raw);
        return {
            attempts:    o.attempts    || 0,
            correct:     o.correct     || 0,
            streak:      o.streak      || 0,
            bestStreak:  o.bestStreak  || 0,
        };
    } catch { return { attempts: 0, correct: 0, streak: 0, bestStreak: 0 }; }
}

function saveStats() {
    try { localStorage.setItem('rpStats', JSON.stringify(stats)); } catch {}
}

function renderHud() {
    document.getElementById('rp-attempts').textContent     = stats.attempts;
    document.getElementById('rp-correct').textContent      = stats.correct;
    document.getElementById('rp-streak').textContent       = stats.streak;
    document.getElementById('rp-best-streak').textContent  = stats.bestStreak;
}
