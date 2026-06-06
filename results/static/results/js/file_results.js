/* =========================================================
   FILE RESULTS — ranking table, performance chart, map view
========================================================= */

/* =========================================================
   STATE
========================================================= */

const FILE_ID = parseInt(document.getElementById('play-wrap').dataset.fileId, 10);

let allResults      = [];
let cpAvgs          = [];
let cpCount         = 0;
let includeTraining = true;
let selectedIds     = new Set();

let project        = null;   // from /play/file/<id>/
let currentCpIdx   = 0;
let cpColorCache   = {};     // { cp_id: [color, ...] }
let cpDistances    = [];     // min route length per CP, for x-axis scaling

const MAP_R_CONTROL = 25;
const MAP_GAP       = 8;
const MAP_MAX_ZOOM  = 8;
const ROUTE_COLORS  = ['#DD0011', '#CC6000', '#008888', '#0055FF', '#5500BB', '#8800CC'];

let mapCam = { x: 0, y: 0, scale: 1, rot: 0 };
let mapApplyTransform = () => {};
let _mapCamAnim   = null;
let _mapRouteAnim = null;

const USER_COLORS = [
    '#e03030', '#e07020', '#22aa44', '#2266ee',
    '#9922cc', '#00aaaa', '#cc6600', '#6644cc',
];

/* =========================================================
   INIT
========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    initToggle();
    initChartClick();
    initMapCamera();
    await Promise.all([loadResults(), loadProject()]);
    window.addEventListener('resize', () => drawChart());
});

/* =========================================================
   DATA LOADING
========================================================= */

async function loadResults() {
    document.getElementById('play-loading').style.display = '';
    try {
        const res  = await fetch(`/results/${FILE_ID}/data/`);
        const data = await res.json();
        const title = data.file_name || '';
        document.getElementById('fr-nav-title').textContent = title;
        allResults = data.results || [];
        cpAvgs     = data.cp_avgs  || [];
        cpCount    = data.cp_count || 0;

        const canSeeRoutes = data.is_trainer || data.user_has_results;
        if (!canSeeRoutes) {
            document.getElementById('fr-bottom').style.display  = 'none';
            document.getElementById('fr-cheater').style.display = 'flex';
        }

        render();
    } catch (e) {
        console.error('loadResults failed:', e);
    } finally {
        document.getElementById('play-loading').style.display = 'none';
    }
}

async function loadProject() {
    try {
        const res  = await fetch(`/play/file/${FILE_ID}/`);
        project = await res.json();

        // Distance of each CP's leg (shortest route), used for proportional x-axis
        cpDistances = project.control_pairs.map(cp => {
            const lens = cp.routes.map(r => r.length).filter(l => l > 0);
            return lens.length ? Math.min(...lens) : 1;
        });

        await loadMapImage(project.map_file, project.scale || 1);
        drawBlockedTerrain();
        showCp(0);
    } catch (e) {
        console.error('loadProject failed:', e);
    }
}

function loadMapImage(filename, scale) {
    return new Promise((resolve, reject) => {
        const img        = document.getElementById('fr-map-img');
        const scaleLayer = document.getElementById('fr-map-scale-layer');
        scaleLayer.style.transform       = `scale(${scale})`;
        scaleLayer.style.transformOrigin = 'top left';

        img.onload = () => {
            const container = document.getElementById('fr-map-container');
            const iw  = img.naturalWidth  * scale;
            const ih  = img.naturalHeight * scale;
            const cw  = container.clientWidth;
            const ch  = container.clientHeight;
            const sc  = Math.min(cw / iw, ch / ih);
            mapCam    = { x: (cw - iw*sc)/2, y: (ch - ih*sc)/2, scale: sc, rot: 0 };
            mapApplyTransform();
            resolve();
        };
        img.onerror = reject;
        img.src     = `/play/map/${filename}/`;
    });
}

/* =========================================================
   TOGGLE
========================================================= */

function initToggle() {
    document.getElementById('fr-training-toggle').addEventListener('change', e => {
        includeTraining = e.target.checked;
        selectedIds.clear();
        render();
    });
}

/* =========================================================
   CHART CLICK — jump to control pair
========================================================= */

function initChartClick() {
    const svg = document.getElementById('fr-chart');
    svg.addEventListener('click', e => {
        if (cpCount === 0) return;
        const rect   = svg.getBoundingClientRect();
        const W      = svg.clientWidth  || 700;
        const ML     = 48, MR = 52;
        const chartW = W - ML - MR;

        const clickX = (e.clientX - rect.left) * (W / rect.width);
        const chartX = clickX - ML;
        if (chartX < 0 || chartX > chartW) return;

        const fraction  = chartX / chartW;
        const dists     = cpDistances.length === cpCount ? cpDistances : Array(cpCount).fill(1);
        const totalDist = dists.reduce((a, b) => a + b, 0) || cpCount;
        const cumDist   = [0];
        dists.forEach(d => cumDist.push(cumDist[cumDist.length - 1] + d));

        for (let i = 0; i < cpCount; i++) {
            if (fraction >= cumDist[i] / totalDist && fraction < cumDist[i + 1] / totalDist) {
                showCp(i);
                return;
            }
        }
        showCp(cpCount - 1);
    });
}

/* =========================================================
   TABLE + CHART RENDER
========================================================= */

function render() {
    const rows = visibleRows();
    renderTable(rows);
    drawChart();
}

function visibleRows() {
    return includeTraining ? allResults : allResults.filter(r => !r.has_training);
}

function renderTable(rows) {
    const tbody = document.getElementById('fr-tbody');
    tbody.innerHTML = '';

    if (rows.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="6" style="text-align:center;color:#666;padding:24px;">
            Keine ${includeTraining ? '' : 'Wettkampf-'}Resultate vorhanden.</td>`;
        tbody.appendChild(tr);
        return;
    }

    const selArr = [...selectedIds];
    rows.forEach((r, idx) => {
        const checked  = selectedIds.has(r.user_id);
        const colorIdx = selArr.indexOf(r.user_id);
        const color    = checked ? USER_COLORS[colorIdx % USER_COLORS.length] : null;

        const tr = document.createElement('tr');
        if (r.has_training) tr.classList.add('fr-row-training');
        if (color) tr.style.borderLeft = `3px solid ${color}`;

        tr.innerHTML = `
            <td class="fr-col-check">
                <input type="checkbox" class="fr-check" data-uid="${r.user_id}"
                       ${checked ? 'checked' : ''}>
            </td>
            <td class="fr-col-rank">${idx + 1}</td>
            <td class="fr-col-name">${r.name}</td>
            <td class="fr-col-time">${formatTime(r.choice_time)}</td>
            <td class="fr-col-time">${formatTime(r.time_diff)}</td>
            <td class="fr-col-time fr-col-total">${formatTime(r.total)}</td>`;

        tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.fr-check').forEach(cb => {
        cb.addEventListener('change', e => {
            const uid = parseInt(e.target.dataset.uid);
            if (e.target.checked) selectedIds.add(uid);
            else                  selectedIds.delete(uid);
            render();
        });
    });
}

/* =========================================================
   SVG CHART
========================================================= */

function drawChart() {
    const svg = document.getElementById('fr-chart');
    svg.innerHTML = '';

    const W = svg.clientWidth  || 700;
    const H = svg.clientHeight || 200;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const narrow = W < 500;
    const ML = narrow ? 30 : 48, MR = narrow ? 34 : 52, MT = narrow ? 8 : 12, MB = narrow ? 20 : 34;
    const chartW = W - ML - MR;
    const chartH = H - MT - MB;

    if (selectedIds.size === 0 || cpCount === 0) {
        const t = svgEl('text');
        t.setAttribute('x', W/2); t.setAttribute('y', H/2);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('fill', '#444'); t.setAttribute('font-size', '12');
        t.textContent = 'Athlete auswählen um den Verlauf zu sehen';
        svg.appendChild(t); return;
    }

    const rows = visibleRows();
    const userLines = {};
    const selArr    = [...selectedIds];

    selArr.forEach(uid => {
        const r = rows.find(x => x.user_id === uid);
        if (!r) return;
        let cum = 0;
        userLines[uid] = [0, ...r.per_cp.map((cp, i) => {
            cum += (cp.choice_time + cp.route_diff) - (cpAvgs[i] || 0);
            return cum;
        })];
    });

    const allVals = Object.values(userLines).flat();
    const yMin = Math.min(0, ...allVals);
    const yMax = Math.max(0, ...allVals);
    const yRange = (yMax - yMin) || 1;

    // Cumulative distance positions for proportional x-axis
    const dists     = cpDistances.length === cpCount ? cpDistances : Array(cpCount).fill(1);
    const totalDist = dists.reduce((a, b) => a + b, 0) || cpCount;
    const cumDist   = [0];
    dists.forEach(d => cumDist.push(cumDist[cumDist.length - 1] + d));

    const toX = i => ML + (cumDist[i] / totalDist) * chartW;
    const toY = v => MT + ((v - yMin) / yRange) * chartH;

    // Highlight current CP column (drawn first, behind everything)
    if (currentCpIdx >= 0 && currentCpIdx < cpCount) {
        const hi = svgEl('rect');
        hi.setAttribute('x',      toX(currentCpIdx));
        hi.setAttribute('y',      MT);
        hi.setAttribute('width',  toX(currentCpIdx + 1) - toX(currentCpIdx));
        hi.setAttribute('height', chartH);
        hi.setAttribute('fill',   'rgba(200,200,200,0.07)');
        svg.appendChild(hi);
    }

    // Vertical grid lines + CP number labels
    for (let i = 0; i <= cpCount; i++) {
        const x    = toX(i);
        const line = svgEl('line');
        line.setAttribute('x1', x); line.setAttribute('y1', MT);
        line.setAttribute('x2', x); line.setAttribute('y2', MT + chartH);
        line.setAttribute('stroke', '#2a2a2a'); line.setAttribute('stroke-width', '1');
        svg.appendChild(line);
        if (i > 0) {
            const midX = (toX(i - 1) + toX(i)) / 2;
            const lbl  = svgEl('text');
            lbl.setAttribute('x', midX); lbl.setAttribute('y', MT + chartH + 14);
            lbl.setAttribute('text-anchor', 'middle');
            lbl.setAttribute('fill', i - 1 === currentCpIdx ? '#bbb' : '#555');
            lbl.setAttribute('font-size', '9');
            lbl.textContent = i;
            svg.appendChild(lbl);
        }
    }

    // Horizontal grid
    const step = niceStep(yRange, Math.floor(chartH / 40));
    for (let v = Math.ceil(yMin / step) * step; v <= yMax + step*0.01; v += step) {
        const y      = toY(v);
        const isZero = Math.abs(v) < step * 0.01;
        const line   = svgEl('line');
        line.setAttribute('x1', ML); line.setAttribute('y1', y);
        line.setAttribute('x2', ML + chartW); line.setAttribute('y2', y);
        line.setAttribute('stroke', isZero ? '#555' : '#222');
        line.setAttribute('stroke-width', isZero ? '1' : '0.5');
        svg.appendChild(line);
        const lbl = svgEl('text');
        lbl.setAttribute('x', ML - 4); lbl.setAttribute('y', y + 4);
        lbl.setAttribute('text-anchor', 'end');
        lbl.setAttribute('fill', isZero ? '#888' : '#444');
        lbl.setAttribute('font-size', '9');
        lbl.textContent = `${Math.round(v)}s`;
        svg.appendChild(lbl);
    }

    // User lines
    selArr.forEach((uid, colorIdx) => {
        if (!userLines[uid]) return;
        const color  = USER_COLORS[colorIdx % USER_COLORS.length];
        const pts    = userLines[uid];
        const points = pts.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');

        const poly = svgEl('polyline');
        poly.setAttribute('points', points);
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', color);
        poly.setAttribute('stroke-width', '1.5');
        poly.setAttribute('stroke-linejoin', 'round');
        poly.setAttribute('stroke-linecap', 'round');
        svg.appendChild(poly);

        const r   = rows.find(x => x.user_id === uid);
        const lbl = svgEl('text');
        lbl.setAttribute('x', toX(cpCount) + 4);
        lbl.setAttribute('y', toY(pts[pts.length - 1]) + 4);
        lbl.setAttribute('fill', color);
        lbl.setAttribute('font-size', '10');
        lbl.setAttribute('font-weight', '600');
        lbl.textContent = (r?.name || '').substring(0, 3);
        svg.appendChild(lbl);
    });
}

/* =========================================================
   MAP — BLOCKED TERRAIN
========================================================= */

const BLOCK_COLOR = 'rgb(160,51,240)';

function drawBlockedTerrain() {
    const layer = document.getElementById('fr-blocked-layer');
    if (!layer) return;
    layer.innerHTML = '';
    const bt = project?.blocked_terrain;
    if (!bt) return;

    (bt.lines || []).forEach(seg => {
        const vis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        vis.setAttribute('x1', seg.start.x); vis.setAttribute('y1', seg.start.y);
        vis.setAttribute('x2', seg.end.x);   vis.setAttribute('y2', seg.end.y);
        vis.setAttribute('stroke',        BLOCK_COLOR);
        vis.setAttribute('stroke-width',  '5');
        vis.setAttribute('stroke-linecap','butt');
        vis.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(vis);
    });

    (bt.areas || []).forEach(area => {
        if (area.points.length < 3) return;
        const fill = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        fill.setAttribute('points',          area.points.map(p => `${p.x},${p.y}`).join(' '));
        fill.setAttribute('fill',            'url(#fr-block-hatch)');
        fill.setAttribute('stroke',          BLOCK_COLOR);
        fill.setAttribute('stroke-width',    '1');
        fill.setAttribute('stroke-linejoin', 'miter');
        fill.setAttribute('vector-effect',   'non-scaling-stroke');
        fill.setAttribute('pointer-events',  'none');
        layer.appendChild(fill);
    });
}

/* =========================================================
   MAP — CAMERA
========================================================= */

function initMapCamera() {
    const container = document.getElementById('fr-map-container');
    const camera    = document.getElementById('fr-camera');

    mapApplyTransform = () => {
        if (!isFinite(mapCam.x) || !isFinite(mapCam.y) || !isFinite(mapCam.scale)) return;
        camera.style.transform =
            `translate(${mapCam.x}px,${mapCam.y}px) rotate(${mapCam.rot}deg) scale(${mapCam.scale})`;
    };

    const MAP_MIN_ZOOM = 0.05;
    const clampScale = s => Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, s));

    let drag = null;
    let lastPinchDist = null;

    // ── Mouse ────────────────────────────────────────────
    container.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (_mapCamAnim) { cancelAnimationFrame(_mapCamAnim); _mapCamAnim = null; }
        drag = { startX: e.clientX - mapCam.x, startY: e.clientY - mapCam.y };
        container.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', e => {
        if (!drag) return;
        mapCam.x = e.clientX - drag.startX;
        mapCam.y = e.clientY - drag.startY;
        mapApplyTransform();
    });

    window.addEventListener('mouseup', () => {
        if (drag) container.style.cursor = '';
        drag = null;
    });

    container.addEventListener('wheel', e => {
        e.preventDefault();
        if (_mapCamAnim) { cancelAnimationFrame(_mapCamAnim); _mapCamAnim = null; }
        const newScale = clampScale(mapCam.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
        const f        = newScale / mapCam.scale;
        const rect     = container.getBoundingClientRect();
        const mx       = e.clientX - rect.left;
        const my       = e.clientY - rect.top;
        mapCam.x     = mx - (mx - mapCam.x) * f;
        mapCam.y     = my - (my - mapCam.y) * f;
        mapCam.scale = newScale;
        mapApplyTransform();
    }, { passive: false });

    // ── Touch ────────────────────────────────────────────
    container.addEventListener('touchstart', e => {
        if (_mapCamAnim) { cancelAnimationFrame(_mapCamAnim); _mapCamAnim = null; }
        if (e.touches.length === 1) {
            drag = { startX: e.touches[0].clientX - mapCam.x, startY: e.touches[0].clientY - mapCam.y };
            lastPinchDist = null;
        } else if (e.touches.length === 2) {
            drag = null;
            lastPinchDist = mapPinchDist(e.touches);
        }
    }, { passive: true });

    container.addEventListener('touchmove', e => {
        e.preventDefault();
        if (e.touches.length === 1 && drag) {
            mapCam.x = e.touches[0].clientX - drag.startX;
            mapCam.y = e.touches[0].clientY - drag.startY;
        } else if (e.touches.length === 2 && lastPinchDist !== null) {
            const dist     = mapPinchDist(e.touches);
            const newScale = clampScale(mapCam.scale * dist / lastPinchDist);
            const f        = newScale / mapCam.scale;
            const rect     = container.getBoundingClientRect();
            const mx       = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
            const my       = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
            mapCam.x     = mx - (mx - mapCam.x) * f;
            mapCam.y     = my - (my - mapCam.y) * f;
            mapCam.scale = newScale;
            lastPinchDist = dist;
        }
        mapApplyTransform();
    }, { passive: false });

    container.addEventListener('touchend', e => {
        if (e.touches.length < 2) lastPinchDist = null;
        if (e.touches.length === 0) drag = null;
    }, { passive: true });
}

function mapPinchDist(touches) {
    return Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
    );
}

function mapAnimateCam(target, duration, onComplete) {
    if (_mapCamAnim) cancelAnimationFrame(_mapCamAnim);
    const container = document.getElementById('fr-map-container');
    const scx = container.clientWidth  / 2;
    const scy = container.clientHeight / 2;

    const fromR    = mapCam.rot * Math.PI / 180;
    const safeScale = mapCam.scale > 0 ? mapCam.scale : 1;
    const fromDX   = scx - mapCam.x;
    const fromDY   = scy - mapCam.y;
    const fromCx   = ( Math.cos(fromR)*fromDX + Math.sin(fromR)*fromDY) / safeScale;
    const fromCy   = (-Math.sin(fromR)*fromDX + Math.cos(fromR)*fromDY) / safeScale;
    const fromScale = mapCam.scale;
    const fromRot   = mapCam.rot;
    const dRot      = ((target.rot - fromRot) % 360 + 540) % 360 - 180;
    const ease      = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;

    let startTs = null;
    function step(ts) {
        if (!startTs) startTs = ts;
        const t = Math.min((ts - startTs) / duration, 1);
        const e = ease(t);
        const rot   = fromRot   + dRot              * e;
        const scale = fromScale + (target.scale - fromScale) * e;
        const cx    = fromCx    + (target.cx    - fromCx)    * e;
        const cy    = fromCy    + (target.cy    - fromCy)    * e;
        const cosR  = Math.cos(rot * Math.PI / 180);
        const sinR  = Math.sin(rot * Math.PI / 180);
        mapCam.rot   = rot;
        mapCam.scale = scale;
        mapCam.x     = scx - (cx*cosR - cy*sinR) * scale;
        mapCam.y     = scy - (cx*sinR + cy*cosR) * scale;
        mapApplyTransform();
        if (t < 1) _mapCamAnim = requestAnimationFrame(step);
        else { _mapCamAnim = null; onComplete?.(); }
    }
    _mapCamAnim = requestAnimationFrame(step);
}

/* =========================================================
   MAP — CP DISPLAY
========================================================= */

function assignCpColors(cp) {
    if (cpColorCache[cp.id]) return cpColorCache[cp.id];
    const shuffled = [...ROUTE_COLORS].sort(() => Math.random() - 0.5);
    const sorted = cp.routes
        .map((r, i) => ({ i, pos: r.pos ?? Infinity }))
        .sort((a, b) => a.pos - b.pos);
    const colors = new Array(cp.routes.length);
    sorted.forEach(({ i }, rank) => { colors[i] = shuffled[rank % shuffled.length]; });
    cpColorCache[cp.id] = colors;
    return colors;
}

function showCp(idx) {
    if (!project?.control_pairs?.length) return;
    const cp = project.control_pairs[idx];
    if (!cp) return;
    currentCpIdx = idx;

    document.getElementById('fr-prev-btn').disabled = idx === 0;
    document.getElementById('fr-next-btn').disabled = idx === project.control_pairs.length - 1;
    document.getElementById('fr-cp-label').textContent = `Posten ${idx + 1} / ${project.control_pairs.length}`;

    if (_mapRouteAnim) { cancelAnimationFrame(_mapRouteAnim); _mapRouteAnim = null; }

    const colors = assignCpColors(cp);
    fitCpCamera(cp, () => {
        drawCpControls(cp);
        animateCpRoutes(cp, colors);
    });

    renderRouteList(cp, colors);
    drawChart(); // re-highlight current CP column
}

let _navLock = false;
function _navGuard(fn) {
    if (_navLock) return;
    _navLock = true;
    fn();
    setTimeout(() => { _navLock = false; }, 350);
}

function prevCp() { _navGuard(() => { if (currentCpIdx > 0) showCp(currentCpIdx - 1); }); }
function nextCp() { _navGuard(() => { if (project && currentCpIdx < project.control_pairs.length - 1) showCp(currentCpIdx + 1); }); }

function replayAnimation() {
    if (!project?.control_pairs?.length) return;
    const cp = project.control_pairs[currentCpIdx];
    if (!cp) return;
    animateCpRoutes(cp, assignCpColors(cp));
}

function fitCpCamera(cp, onComplete) {
    const dx    = cp.ziel.x - cp.start.x;
    const dy    = cp.ziel.y - cp.start.y;
    const rotDeg = -90 - Math.atan2(dy, dx) * (180 / Math.PI);
    const R     = rotDeg * Math.PI / 180;
    const cosR  = Math.cos(R), sinR = Math.sin(R);
    const toRot = p => ({ rx: p.x*cosR - p.y*sinR, ry: p.x*sinR + p.y*cosR });

    const rPts    = cp.routes.flatMap(r => r.rP || []);
    const dataPts = rPts.length ? rPts : [cp.start, cp.ziel];
    const rotData = dataPts.map(toRot);

    let minRX = Math.min(...rotData.map(p => p.rx));
    let maxRX = Math.max(...rotData.map(p => p.rx));
    let minRY = Math.min(...rotData.map(p => p.ry));
    let maxRY = Math.max(...rotData.map(p => p.ry));

    [cp.start, cp.ziel].forEach(pt => {
        const { rx, ry } = toRot(pt);
        minRX = Math.min(minRX, rx - MAP_R_CONTROL);
        maxRX = Math.max(maxRX, rx + MAP_R_CONTROL);
        minRY = Math.min(minRY, ry - MAP_R_CONTROL);
        maxRY = Math.max(maxRY, ry + MAP_R_CONTROL);
    });

    const startRX  = toRot(cp.start).rx;
    const centerRY = (minRY + maxRY) / 2;

    const container = document.getElementById('fr-map-container');
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const PAD   = 10;
    const halfW = Math.max(startRX - minRX, maxRX - startRX);
    const halfH = (maxRY - minRY) / 2;
    const scale = Math.min(
        halfW > 0 ? (cw/2 - PAD) / halfW : MAP_MAX_ZOOM,
        halfH > 0 ? (ch/2 - PAD) / halfH : MAP_MAX_ZOOM,
        MAP_MAX_ZOOM
    );

    mapAnimateCam({
        rot:   rotDeg, scale,
        cx:    startRX * cosR + centerRY * sinR,
        cy:   -startRX * sinR + centerRY * cosR,
    }, 800, () => {
        document.getElementById('fr-control-layer').innerHTML = '';
        drawCpControls(cp);
        onComplete?.();
    });
}

function drawCpControls(cp) {
    const layer = document.getElementById('fr-control-layer');
    layer.innerHTML = '';

    const color = 'rgb(160,51,240)';

    [cp.start, cp.ziel].forEach(pt => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y);
        c.setAttribute('r',  MAP_R_CONTROL);
        c.setAttribute('fill', 'transparent');
        c.setAttribute('stroke', color);
        c.setAttribute('stroke-width', '3');
        c.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(c);
    });

    const angle  = Math.atan2(cp.ziel.y - cp.start.y, cp.ziel.x - cp.start.x);
    const dist   = Math.hypot(cp.ziel.x - cp.start.x, cp.ziel.y - cp.start.y);
    if (dist > 2 * (MAP_R_CONTROL + MAP_GAP)) {
        const off = MAP_R_CONTROL + MAP_GAP;
        const ln  = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('x1', cp.start.x + Math.cos(angle)*off);
        ln.setAttribute('y1', cp.start.y + Math.sin(angle)*off);
        ln.setAttribute('x2', cp.ziel.x  - Math.cos(angle)*off);
        ln.setAttribute('y2', cp.ziel.y  - Math.sin(angle)*off);
        ln.setAttribute('stroke', color);
        ln.setAttribute('stroke-width', '3');
        ln.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(ln);
    }
}

/* =========================================================
   MAP — ROUTE ANIMATION
========================================================= */

function animateCpRoutes(cp, colors) {
    if (_mapRouteAnim) { cancelAnimationFrame(_mapRouteAnim); _mapRouteAnim = null; }
    const layer = document.getElementById('fr-route-layer');
    layer.innerHTML = '';

    const validTimes = cp.routes.map(r => r.run_time).filter(t => t > 0);
    const minTime    = validTimes.length ? Math.min(...validTimes) : 1;

    const anims = cp.routes.map((route, i) => {
        const rP = route.rP;
        if (!rP || rP.length < 2) return null;

        const dists = [0];
        for (let j = 1; j < rP.length; j++)
            dists.push(dists[j-1] + Math.hypot(rP[j].x - rP[j-1].x, rP[j].y - rP[j-1].y));
        const totalDist = dists[dists.length - 1];

        const ratio    = route.run_time > 0 ? route.run_time / minTime : 1;
        const excess   = ratio - 1;
        const amp      = 5 - 4 * Math.min(excess, 1);
        const duration = 1 + excess * amp;
        const color    = colors[i];

        const bg = mkRoute(route, 'white', 3, 0.2);
        if (bg) layer.appendChild(bg);

        const trail = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        trail.setAttribute('fill', 'none');
        trail.setAttribute('stroke', color);
        trail.setAttribute('stroke-width', '2.5');
        trail.setAttribute('stroke-linecap',  'round');
        trail.setAttribute('stroke-linejoin', 'round');
        trail.setAttribute('vector-effect', 'non-scaling-stroke');
        trail.setAttribute('points', `${rP[0].x},${rP[0].y}`);
        layer.appendChild(trail);

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', '5'); dot.setAttribute('fill', color);
        dot.setAttribute('cx', rP[0].x); dot.setAttribute('cy', rP[0].y);
        dot.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.appendChild(dot);

        return { rP, dists, totalDist, duration, color, trail, dot, done: false };
    }).filter(Boolean);

    const t0 = performance.now();
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
            const segLen = (dists[seg+1] ?? totalDist) - dists[seg];
            const segT   = segLen > 0 ? (dist - dists[seg]) / segLen : 1;
            const p0 = rP[seg], p1 = rP[Math.min(seg+1, rP.length-1)];
            const cx = p0.x + (p1.x - p0.x) * segT;
            const cy = p0.y + (p1.y - p0.y) * segT;

            dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
            const pts = rP.slice(0, seg+1).map(p => `${p.x},${p.y}`);
            if (segT > 0) pts.push(`${cx},${cy}`);
            trail.setAttribute('points', pts.join(' '));

            if (dist >= totalDist) { anim.done = true; dot.remove(); emitWave(rP[rP.length - 1], anim.color); }
            else allDone = false;
        });

        if (!allDone) _mapRouteAnim = requestAnimationFrame(tick);
        else          _mapRouteAnim = null;
    })(t0);
}

function mkRoute(route, stroke, strokeWidth, opacity) {
    if (!route?.rP || route.rP.length < 2) return null;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    el.setAttribute('points',          route.rP.map(p => `${p.x},${p.y}`).join(' '));
    el.setAttribute('fill',            'none');
    el.setAttribute('stroke',          stroke);
    el.setAttribute('stroke-width',    strokeWidth);
    el.setAttribute('stroke-linecap',  'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('vector-effect',   'non-scaling-stroke');
    el.setAttribute('opacity',         String(opacity));
    el.setAttribute('pointer-events',  'none');
    return el;
}

/* =========================================================
   ROUTE LIST
========================================================= */

function renderRouteList(cp, colors) {
    const panel = document.getElementById('fr-route-panel');
    panel.innerHTML = '';

    const rows  = visibleRows();
    const cpIdx = currentCpIdx;

    // Find the minimum run_time to mark the fastest route
    const minRunTime = Math.min(...cp.routes.map(r => r.run_time || Infinity).filter(t => t < Infinity));

    cp.routes.forEach((route, i) => {
        const color = colors[i];

        // Header
        const header = document.createElement('div');
        header.className = 'fr-route-header';
        header.style.borderLeftColor = color;

        const isFastest = route.run_time && route.run_time <= minRunTime;
        const parts = [];
        if (route.length)         parts.push(`${Math.round(route.length)}m`);
        if (route.elevation != null) parts.push(`${Math.round(route.elevation)}Hm`);
        if (route.run_time)       parts.push(formatTime(route.run_time));
        if (!isFastest && route.run_time && minRunTime > 0)
            parts.push(`+${Math.round(((route.run_time / minRunTime) - 1) * 100)}%`);
        const crownHtml = isFastest
            ? `<span class="fr-route-crown">${icon('crown', '11px')}</span>`
            : '';
        header.innerHTML = `<span class="fr-route-name" style="color:${color}">
            Route ${i + 1} ${crownHtml}</span>
            <span class="fr-route-stats">${parts.join(', ')}</span>`;
        panel.appendChild(header);

        // Athletes who chose this route
        const athletes = rows.filter(r => {
            const pc = r.per_cp[cpIdx];
            return pc && pc.route_id === route.id;
        });

        const athleteWrap = document.createElement('div');
        athleteWrap.className = 'fr-route-athletes';
        panel.appendChild(athleteWrap);

        if (athletes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'fr-route-athlete fr-route-empty';
            empty.textContent = '—';
            athleteWrap.appendChild(empty);
        } else {
            athletes.forEach(r => {
                const pc    = r.per_cp[cpIdx];
                const row   = document.createElement('div');
                row.className = 'fr-route-athlete' + (r.has_training ? ' fr-training' : '');
                row.innerHTML = `<span class="fr-athlete-name">${r.name}</span>
                    <span class="fr-athlete-time">(${pc.choice_time.toFixed(2)}s)</span>`;
                athleteWrap.appendChild(row);
            });
        }
    });
}

/* =========================================================
   WAVE ANIMATION
========================================================= */

function emitWave(pos, color) {
    const layer = document.getElementById('fr-wave-layer');
    if (!layer) return;

    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx',           pos.x);
    c.setAttribute('cy',           pos.y);
    c.setAttribute('r',            MAP_R_CONTROL);
    c.setAttribute('fill',         'none');
    c.setAttribute('stroke',       color);
    c.setAttribute('stroke-width', '14');
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    c.style.filter = 'blur(4px)';
    layer.appendChild(c);

    const start    = performance.now();
    const duration = 1800;
    const endR     = MAP_R_CONTROL * 2.5;

    (function animate(now) {
        const t    = Math.min((now - start) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 2);
        c.setAttribute('r',       MAP_R_CONTROL + (endR - MAP_R_CONTROL) * ease);
        c.setAttribute('opacity', (1 - ease) * 0.85);
        if (t < 1) requestAnimationFrame(animate);
        else c.remove();
    })(start);
}

/* =========================================================
   UTILS
========================================================= */

function svgEl(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function niceStep(range, maxSteps) {
    const raw = range / Math.max(maxSteps, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const r   = raw / mag;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
}

function formatTime(sec) {
    if (sec == null || isNaN(sec)) return '—';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}
