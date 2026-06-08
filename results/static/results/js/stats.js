/* =========================================================
   STATS — personal performance vs. team, route-choice
   quality, average times and activity over time
========================================================= */

let statsData = null;

const CATEGORY_KEYS    = ['fastest', 'less_5', 'between_5_10', 'more_10'];
const CATEGORY_LABELS  = ['Schnellste', '< 5%', '5–10%', '> 10%'];
const USER_COLORS      = ['#4CAF50', '#FFC107', '#FF9800', '#F44336'];
const TEAM_COLORS      = ['rgba(76,175,80,0.32)', 'rgba(255,193,7,0.32)', 'rgba(255,152,0,0.32)', 'rgba(244,67,54,0.32)'];

// HTML labels: index 0 (Schnellste) becomes the crown icon
function categoryLabelHtml(i, size) {
    if (i === 0) {
        const sz = size || '11px';
        return `<span class="stats-donut-legend-icon">${typeof icon === 'function' ? icon('crown', sz) : '👑'}</span>`;
    }
    return escapeHtml(CATEGORY_LABELS[i]);
}

let tooltipEl = null;

const PAGE = {
    isTrainer:      false,
    competition:    true,            // false = training
    view:           'graph',         // 'graph' | 'table'
    selectedAthlete: null,           // { id, name } or null = own stats
    athletes:       [],
    tableRows:      [],              // raw rows from /stats/get-table
    tableSort:      { key: null, dir: 1 }, // dir 1 = ascending, -1 = descending
};

/* =========================================================
   INIT
========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    PAGE.isTrainer = document.getElementById('play-wrap').dataset.isTrainer === '1';
    initModeToggle();
    initExpandButtons();
    updateNavTitle();
    if (PAGE.isTrainer) {
        initTrainerControls();
        initTableSortHandlers();
        loadAthletes();   // fire and forget — dropdown populates async
    }
    await loadStats();
    window.addEventListener('resize', renderCharts);
});

function updateNavTitle() {
    const el = document.getElementById('stats-nav-title');
    if (!el) return;
    el.textContent = `Statistik (${PAGE.competition ? 'Wettkampf' : 'Training'})`;
}

function initModeToggle() {
    const input = document.getElementById('mode-toggle-input');
    if (!input) return;
    input.checked = PAGE.competition;
    updateModeIcons();
    input.addEventListener('change', () => {
        PAGE.competition = input.checked;
        updateModeIcons();
        updateNavTitle();
        loadStats();
    });

    // Mobile: tap to open mode-tip-box
    document.querySelectorAll('.nav-mode-toggle .mode-icon-tip').forEach(tip => {
        tip.addEventListener('click', e => {
            e.stopPropagation();
            const wasOpen = tip.classList.contains('tip-open');
            document.querySelectorAll('.mode-icon-tip.tip-open').forEach(t => t.classList.remove('tip-open'));
            if (!wasOpen) tip.classList.add('tip-open');
        });
    });
    document.addEventListener('click', () => {
        document.querySelectorAll('.mode-icon-tip.tip-open').forEach(t => t.classList.remove('tip-open'));
    });
}

function updateModeIcons() {
    document.querySelector('.nav-mode-toggle [data-mode="training"]')
        ?.classList.toggle('mode-active', !PAGE.competition);
    document.querySelector('.nav-mode-toggle [data-mode="competition"]')
        ?.classList.toggle('mode-active',  PAGE.competition);
}

/* =========================================================
   EXPAND / COLLAPSE — fullscreen card within grid
========================================================= */

function initExpandButtons() {
    document.querySelectorAll('.stats-card-expand').forEach(btn => {
        setExpandIcon(btn, false);
        btn.addEventListener('click', () => toggleCardExpand(btn.closest('.stats-card')));
    });
}

function setExpandIcon(btn, expanded) {
    if (typeof icon === 'function') {
        btn.innerHTML = icon(expanded ? 'collapse' : 'expand', '13px');
    }
    btn.title          = expanded ? 'Verkleinern' : 'Vergrössern';
    btn.ariaLabel      = btn.title;
}

function toggleCardExpand(card) {
    if (!card) return;
    const grid = document.getElementById('stats-grid');
    const expanding = !card.classList.contains('expanded');

    grid.querySelectorAll('.stats-card.expanded').forEach(c => {
        c.classList.remove('expanded');
        const b = c.querySelector('.stats-card-expand');
        if (b) setExpandIcon(b, false);
    });

    if (expanding) {
        card.classList.add('expanded');
        grid.classList.add('has-expanded');
        const btn = card.querySelector('.stats-card-expand');
        if (btn) setExpandIcon(btn, true);
    } else {
        grid.classList.remove('has-expanded');
    }
    // Re-flow SVGs after size change
    if (statsData) renderCharts();
}

/* =========================================================
   LOADING SPINNER
========================================================= */

function setCardsLoading(loading) {
    document.querySelectorAll('#stats-grid .stats-card-body')
        .forEach(b => b.classList.toggle('loading', loading));
}

/* =========================================================
   TRAINER CONTROLS — view toggle + athlete picker
========================================================= */

function initTrainerControls() {
    document.querySelectorAll('.trainer-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('active')) return;
            PAGE.view = btn.dataset.view;
            document.querySelectorAll('.trainer-view-btn')
                .forEach(b => b.classList.toggle('active', b === btn));
            applyView();
            loadStats();
        });
    });

    const search   = document.getElementById('trainer-athlete-search');
    const clearBtn = document.getElementById('trainer-athlete-clear');
    const dropdown = document.getElementById('trainer-athlete-dropdown');

    search.addEventListener('focus', () => {
        // Clear the input on focus so the user can search again, but keep
        // PAGE.selectedAthlete (and therefore the displayed stats) until they
        // pick a different one.
        search.value = '';
        clearBtn.classList.remove('visible');
        renderAthleteDropdown('', true);
    });
    search.addEventListener('input', () => {
        clearBtn.classList.toggle('visible', !!search.value);
        renderAthleteDropdown(search.value, true);
    });
    search.addEventListener('blur', () => {
        // If the user blurs without selecting anything, restore the previously
        // selected athlete's name so the field reflects what's being shown.
        setTimeout(() => {
            if (!dropdown.classList.contains('open')) {
                search.value = PAGE.selectedAthlete ? PAGE.selectedAthlete.name : '';
                clearBtn.classList.toggle('visible', !!PAGE.selectedAthlete);
            }
        }, 200);
    });
    search.addEventListener('keydown', e => {
        if (e.key === 'Escape') { dropdown.classList.remove('open'); search.blur(); }
    });

    clearBtn.addEventListener('click', () => {
        search.value = '';
        clearBtn.classList.remove('visible');
        selectAthlete(null);
        dropdown.classList.remove('open');
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('#trainer-athlete-picker')) {
            dropdown.classList.remove('open');
        }
    });

    applyView();
}

function applyView() {
    const isGraph = PAGE.view === 'graph';
    document.getElementById('stats-grid').style.display = isGraph ? '' : 'none';
    const tableWrap = document.getElementById('stats-table-wrap');
    if (tableWrap) tableWrap.style.display = isGraph ? 'none' : 'block';
    // Athlete picker is visible in both views — in table view it filters the table
}

async function loadAthletes() {
    try {
        const res  = await fetch('/stats/get-athletes/');
        const data = await res.json();
        PAGE.athletes = data.athletes || [];
    } catch (e) {
        console.error('loadAthletes failed:', e);
    }
}

function renderAthleteDropdown(query, open) {
    const dropdown = document.getElementById('trainer-athlete-dropdown');
    if (!dropdown) return;

    const q = (query || '').toLowerCase().trim();
    const filtered = q
        ? PAGE.athletes.filter(a => a.name.toLowerCase().includes(q))
        : PAGE.athletes;

    const parts = [];
    parts.push(
        `<div class="trainer-athlete-option trainer-own ${PAGE.selectedAthlete === null ? 'active' : ''}" data-id="">Eigene Stats</div>`
    );
    if (filtered.length === 0 && q) {
        parts.push('<div class="trainer-athlete-empty">Keine Athleten gefunden</div>');
    } else {
        filtered.forEach(a => {
            const isActive = PAGE.selectedAthlete?.id === a.id;
            parts.push(
                `<div class="trainer-athlete-option ${isActive ? 'active' : ''}" data-id="${a.id}">${escapeHtml(a.name)}</div>`
            );
        });
    }
    dropdown.innerHTML = parts.join('');
    if (open) dropdown.classList.add('open');

    dropdown.querySelectorAll('.trainer-athlete-option').forEach(opt => {
        opt.addEventListener('mousedown', e => {
            e.preventDefault();
            const id = opt.dataset.id;
            if (id) {
                const athlete = PAGE.athletes.find(a => a.id === parseInt(id));
                if (athlete) selectAthlete(athlete);
            } else {
                selectAthlete(null);
            }
            dropdown.classList.remove('open');
        });
    });
}

function selectAthlete(athlete) {
    PAGE.selectedAthlete = athlete;
    const search   = document.getElementById('trainer-athlete-search');
    const clearBtn = document.getElementById('trainer-athlete-clear');
    if (search)   search.value = athlete ? athlete.name : '';
    if (clearBtn) clearBtn.classList.toggle('visible', !!athlete);
    if (PAGE.view === 'table') {
        // Just re-filter cached rows; no fetch needed
        renderTrainerTable(PAGE.tableRows);
    } else {
        loadStats();
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* =========================================================
   DATA LOADING
========================================================= */

async function loadStats() {
    try {
        if (PAGE.view === 'table' && PAGE.isTrainer) {
            await loadTrainerTable();
        } else {
            await loadGraphStats();
        }
    } catch (e) {
        console.error('loadStats failed:', e);
    }
}

async function loadGraphStats() {
    setCardsLoading(true);
    try {
        const params = new URLSearchParams({ competition: String(PAGE.competition) });
        if (PAGE.selectedAthlete) params.set('user_id', String(PAGE.selectedAthlete.id));
        const res = await fetch('/stats/get-stats/?' + params.toString());
        statsData = await res.json();
        if (statsData.error) throw new Error(statsData.error);
        renderCharts();
        renderFacts(statsData.facts);
    } finally {
        setCardsLoading(false);
    }
}

async function loadTrainerTable() {
    const mode  = PAGE.competition ? 'competition' : 'training';
    const wrap  = document.getElementById('stats-table-wrap');
    const tbody = document.querySelector('#stats-table tbody');
    if (wrap) wrap.classList.add('loading');
    try {
        const res = await fetch(`/stats/get-table/?mode=${mode}`);
        if (!res.ok) {
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#666;padding:24px;">Fehler beim Laden der Daten</td></tr>';
            }
            return;
        }
        const data = await res.json();
        PAGE.tableRows = Array.isArray(data) ? data : [];
        renderTrainerTable(PAGE.tableRows);
    } finally {
        if (wrap) wrap.classList.remove('loading');
    }
}

// Numeric value used for column sort comparisons (NaN for "–"/missing)
function tableSortValue(row, key) {
    switch (key) {
        case 'athlete':         return (row.athlete || '').toLowerCase();
        case 'posten':          return Number(row.posten) || 0;
        case 'avg_choice_time': return row.avg_choice_time == null ? NaN : Number(row.avg_choice_time);
        case 'avg_error':       return row.avg_error       == null ? NaN : Number(row.avg_error);
        case 'schnellste':      return row.schnellste      == null ? NaN : Number(row.schnellste);
        case 'lt5':             return row.lt5             == null ? NaN : Number(row.lt5);
        case 'lt10':            return row.lt10            == null ? NaN : Number(row.lt10);
        case 'gt10':            return row.gt10            == null ? NaN : Number(row.gt10);
        case 'sensitivity':     return row.sensitivity == null || row.sensitivity === '-' ? NaN : Number(row.sensitivity);
        case 'roi_slope': {
            const m = /^-?\d+(\.\d+)?/.exec(String(row.roi_slope || ''));
            return m ? Number(m[0]) : NaN;
        }
        default: return 0;
    }
}

function renderTrainerTable(rows) {
    const tbody = document.querySelector('#stats-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#666;padding:24px;">Keine Daten vorhanden</td></tr>';
        updateTableSortIndicators();
        return;
    }

    // Always keep Kaderdurchschnitt as the top row
    const summary = rows.find(r => String(r.athlete || '').includes('Kaderdurchschnitt'));
    let athletes  = rows.filter(r => r !== summary);

    // Apply athlete filter from picker (in table view only)
    if (PAGE.selectedAthlete) {
        athletes = athletes.filter(r => (r.athlete || '').trim() === PAGE.selectedAthlete.name.trim());
    }

    // Apply sort
    const { key, dir } = PAGE.tableSort;
    if (key) {
        athletes.sort((a, b) => {
            const va = tableSortValue(a, key);
            const vb = tableSortValue(b, key);
            // Push NaN to the end regardless of sort direction
            const aMissing = (typeof va === 'number' && isNaN(va));
            const bMissing = (typeof vb === 'number' && isNaN(vb));
            if (aMissing && !bMissing) return 1;
            if (!aMissing && bMissing) return -1;
            if (aMissing && bMissing)  return 0;
            if (va < vb) return -1 * dir;
            if (va > vb) return  1 * dir;
            return 0;
        });
    }

    const ordered = summary ? [summary, ...athletes] : athletes;

    const fmtPct = v => (v == null ? '–' : `${Number(v).toFixed(1)}%`);
    const fmtSec = v => (v == null ? '–' : `${Number(v).toFixed(2)}s`);
    for (const row of ordered) {
        const isSummary = String(row.athlete || '').includes('Kaderdurchschnitt');
        const tr = document.createElement('tr');
        if (isSummary) tr.className = 'stats-table-summary';
        tr.innerHTML = `
            <td>${escapeHtml(row.athlete ?? '–')}</td>
            <td>${row.posten ?? '–'}</td>
            <td>${fmtSec(row.avg_choice_time)}</td>
            <td>${fmtSec(row.avg_error)}</td>
            <td style="color:#4CAF50">${fmtPct(row.schnellste)}</td>
            <td style="color:#FFC107">${fmtPct(row.lt5)}</td>
            <td style="color:#FF9800">${fmtPct(row.lt10)}</td>
            <td style="color:#F44336">${fmtPct(row.gt10)}</td>
            <td>${row.sensitivity ?? '–'}</td>
            <td>${row.roi_slope ?? '–'}</td>`;
        tbody.appendChild(tr);
    }
    updateTableSortIndicators();
}

function initTableSortHandlers() {
    const headers = document.querySelectorAll('#stats-table thead th[data-sort]');
    headers.forEach(th => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (PAGE.tableSort.key === key) {
                PAGE.tableSort.dir *= -1;
            } else {
                PAGE.tableSort.key = key;
                PAGE.tableSort.dir = (key === 'athlete') ? 1 : -1;
            }
            renderTrainerTable(PAGE.tableRows);
        });
    });
}

function updateTableSortIndicators() {
    const { key, dir } = PAGE.tableSort;
    document.querySelectorAll('#stats-table thead th[data-sort]').forEach(th => {
        const ind = th.querySelector('.stats-th-sort');
        if (!ind) return;
        if (th.dataset.sort !== key) { ind.textContent = ''; return; }
        ind.textContent = dir === 1 ? ' ↑' : ' ↓';
    });
}

function renderCharts() {
    if (!statsData) return;
    const modeLabel = PAGE.competition ? 'Wettkampf' : 'Training';
    const title = document.getElementById('stats-card-routes-title');
    if (title) title.textContent = `Routenwahl (${modeLabel})`;
    drawDonut();
    drawDonutLegend();
    drawAvgChart();
    drawActivityChart();
}

function drawDonutLegend() {
    const wrap = document.getElementById('stats-donut-legend');
    if (!wrap) return;
    wrap.innerHTML = CATEGORY_LABELS.map((_, i) => {
        // For the crown entry, show only the crown (no dot) coloured green
        if (i === 0) {
            return `<span class="stats-donut-legend-item">${categoryLabelHtml(i, '13px')}</span>`;
        }
        return `<span class="stats-donut-legend-item">
            <span class="stats-donut-legend-dot" style="background:${USER_COLORS[i]}"></span>
            ${categoryLabelHtml(i, '11px')}
        </span>`;
    }).join('');
}

/* =========================================================
   DONUT — route-choice quality
   (team in the outer ring, user in the inner ring with
   more saturated colors)
========================================================= */

function drawDonut() {
    const svg = document.getElementById('stats-donut-chart');
    svg.innerHTML = '';
    const W = svg.clientWidth  || 220;
    const H = svg.clientHeight || 220;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const cx      = W / 2, cy = H / 2;
    const halfMin = Math.min(W, H) / 2;
    // Two stacked rings; reserve room so stroke half-width never clips
    const ringW   = Math.max(6, halfMin * 0.13);
    const outerR  = halfMin - ringW / 2 - 3;
    const innerR  = outerR - ringW - 4;

    drawRing(svg, cx, cy, outerR, ringW, statsData.team, TEAM_COLORS, 'Team');
    drawRing(svg, cx, cy, innerR, ringW, statsData.user, USER_COLORS, 'Du');

    const totalFs = Math.max(11, Math.min(22, outerR * 0.28));
    const subFs   = Math.max(8,  Math.min(12, outerR * 0.14));

    const total = svgEl('text');
    total.setAttribute('x', cx); total.setAttribute('y', cy - subFs * 0.2);
    total.setAttribute('text-anchor', 'middle');
    total.setAttribute('fill', '#ddd');
    total.setAttribute('font-size', totalFs);
    total.setAttribute('font-weight', '700');
    total.textContent = statsData.user.total;
    svg.appendChild(total);

    const sub = svgEl('text');
    sub.setAttribute('x', cx); sub.setAttribute('y', cy + totalFs * 0.65);
    sub.setAttribute('text-anchor', 'middle');
    sub.setAttribute('fill', '#777');
    sub.setAttribute('font-size', subFs);
    sub.textContent = 'Posten';
    svg.appendChild(sub);
}

function drawRing(svg, cx, cy, r, strokeWidth, stats, colors, who) {
    if (!stats.total) {
        const c = svgEl('circle');
        c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
        c.setAttribute('fill', 'none');
        c.setAttribute('stroke', '#262626');
        c.setAttribute('stroke-width', strokeWidth);
        svg.appendChild(c);
        return;
    }

    const gapAngle = Math.min(0.08, 2.5 / r);   // ≈2.5px gap between segments
    let angle = -Math.PI / 2;                    // start at 12 o'clock

    CATEGORY_KEYS.forEach((key, i) => {
        const value = stats.counts[key] || 0;
        if (!value) return;
        const fullArc = (value / stats.total) * 2 * Math.PI;
        const arcLen  = Math.max(0.001, fullArc - gapAngle);
        const start   = angle;
        const end     = angle + arcLen;
        angle += fullArc;

        const seg = svgEl('path');
        seg.setAttribute('d', arcPath(cx, cy, r, start, end));
        seg.setAttribute('fill', 'none');
        seg.setAttribute('stroke', colors[i]);
        seg.setAttribute('stroke-width', strokeWidth);
        seg.setAttribute('stroke-linecap', 'butt');
        seg.setAttribute('class', 'stats-hover-target');

        const pct = (value / stats.total) * 100;
        bindTooltipHtml(seg, `${escapeHtml(who)} · ${categoryLabelHtml(i, '12px')}: ${pct.toFixed(2)}%`);
        svg.appendChild(seg);
    });
}

function arcPath(cx, cy, r, startAngle, endAngle) {
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
    // Full-circle paths need to be split into two halves or they collapse
    if (endAngle - startAngle >= 2 * Math.PI - 1e-3) {
        const mx = cx - r, my = cy;
        return `M ${x1} ${y1} A ${r} ${r} 0 1 1 ${mx} ${my} A ${r} ${r} 0 1 1 ${x2} ${y2}`;
    }
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

/* =========================================================
   BAR CHART — average choice time & average time lost
   behind the fastest route, team vs. user
========================================================= */

function drawAvgChart() {
    const svg = document.getElementById('stats-bar-chart');
    svg.innerHTML = '';
    const W = svg.clientWidth  || 320;
    const H = svg.clientHeight || 220;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    // Reserve space at top for the legend
    const ML = 36, MR = 14, MT = 24, MB = 26;
    const chartW = W - ML - MR;
    const chartH = H - MT - MB;

    const groups = [
        { label: 'Entscheidungszeit', team: statsData.team.avg_choice_time, user: statsData.user.avg_choice_time },
        { label: 'Routenwahlfehler',  team: statsData.team.avg_route_diff,  user: statsData.user.avg_route_diff  },
    ];

    const maxVal = Math.max(0.1, ...groups.flatMap(g => [g.team, g.user]));
    const step   = niceStep(maxVal, Math.max(1, Math.floor(chartH / 36)));
    const yMax   = Math.ceil(maxVal / step) * step;
    const toY    = v => MT + chartH - (yMax > 0 ? (v / yMax) * chartH : 0);

    for (let v = 0; v <= yMax + step * 0.01; v += step) {
        const y = toY(v);
        const line = svgEl('line');
        line.setAttribute('x1', ML); line.setAttribute('y1', y);
        line.setAttribute('x2', ML + chartW); line.setAttribute('y2', y);
        line.setAttribute('stroke', v === 0 ? '#444' : '#222');
        line.setAttribute('stroke-width', v === 0 ? '1' : '0.5');
        svg.appendChild(line);

        const lbl = svgEl('text');
        lbl.setAttribute('x', ML - 6); lbl.setAttribute('y', y + 3);
        lbl.setAttribute('text-anchor', 'end');
        lbl.setAttribute('fill', '#555');
        lbl.setAttribute('font-size', '9');
        lbl.textContent = `${v.toFixed(step < 1 ? 1 : 0)}s`;
        svg.appendChild(lbl);
    }

    const groupW = chartW / groups.length;
    const teamBarW = Math.min(56, groupW * 0.42);
    const userBarW = Math.max(10, teamBarW * 0.45);

    groups.forEach((g, gi) => {
        const groupCx = ML + gi * groupW + groupW / 2;
        // Draw team bar behind (wider), then user bar in front (narrower) — both centered on groupCx
        [
            { value: g.team, color: 'rgba(224,112,32,0.42)', who: 'Team', width: teamBarW },
            { value: g.user, color: '#e07020',               who: 'Du',   width: userBarW },
        ].forEach(bar => {
            const x = groupCx - bar.width / 2;
            const y = toY(bar.value);
            const rect = svgEl('rect');
            rect.setAttribute('x', x);
            rect.setAttribute('y', y);
            rect.setAttribute('width', bar.width);
            rect.setAttribute('height', Math.max(0, (MT + chartH) - y));
            rect.setAttribute('fill', bar.color);
            rect.setAttribute('rx', 2);
            rect.setAttribute('class', 'stats-hover-target');
            bindTooltip(rect, `${bar.who} · ${g.label}: ${bar.value.toFixed(2)}s`);
            svg.appendChild(rect);
        });

        // Only the individual (user) bar gets a value label, centred above it.
        // Team values are visible via hover tooltip.
        const userLbl = svgEl('text');
        userLbl.setAttribute('x', groupCx);
        userLbl.setAttribute('y', toY(g.user) - 4);
        userLbl.setAttribute('text-anchor', 'middle');
        userLbl.setAttribute('fill', '#ccc');
        userLbl.setAttribute('font-size', '9');
        userLbl.setAttribute('font-weight', '600');
        userLbl.setAttribute('pointer-events', 'none');
        userLbl.textContent = `${g.user.toFixed(1)}s`;
        svg.appendChild(userLbl);

        const glbl = svgEl('text');
        glbl.setAttribute('x', groupCx);
        glbl.setAttribute('y', MT + chartH + 17);
        glbl.setAttribute('text-anchor', 'middle');
        glbl.setAttribute('fill', '#888');
        glbl.setAttribute('font-size', '10');
        glbl.textContent = g.label;
        svg.appendChild(glbl);
    });

    // Legend at top: team (faded wide rect) | individual (solid narrow rect)
    drawAvgLegend(svg, W);
}

function drawAvgLegend(svg, W) {
    // Render the legend in the top-right of the SVG
    const items = [
        { label: 'Team',         color: 'rgba(224,112,32,0.42)', w: 14, h: 8 },
        { label: 'Individuell',  color: '#e07020',               w: 6,  h: 10 },
    ];
    let x = W - 12;
    const y = 4;
    // Build right to left
    items.slice().reverse().forEach(item => {
        const t = svgEl('text');
        t.setAttribute('y', y + 9);
        t.setAttribute('fill', '#888');
        t.setAttribute('font-size', '10');
        t.setAttribute('text-anchor', 'end');
        t.setAttribute('x', x);
        t.textContent = item.label;
        svg.appendChild(t);
        // approximate text width
        const textW = item.label.length * 5.2;
        x -= textW + 4;

        const rect = svgEl('rect');
        rect.setAttribute('width',  item.w);
        rect.setAttribute('height', item.h);
        rect.setAttribute('rx', 1.5);
        rect.setAttribute('fill', item.color);
        rect.setAttribute('x', x - item.w);
        rect.setAttribute('y', y + 1);
        svg.appendChild(rect);
        x -= item.w + 10;
    });
}

/* =========================================================
   ACTIVITY — completed control pairs per month
   (spans the user's full history, up to ~2 years)
========================================================= */

function drawActivityChart() {
    const svg = document.getElementById('stats-activity-chart');
    svg.innerHTML = '';
    const W = svg.clientWidth  || 320;
    const H = svg.clientHeight || 220;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const monthly = statsData.activity || [];
    if (!monthly.length) {
        const t = svgEl('text');
        t.setAttribute('x', W / 2); t.setAttribute('y', H / 2);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('fill', '#444');
        t.setAttribute('font-size', '11');
        t.textContent = 'Noch keine Aktivität';
        svg.appendChild(t);
        return;
    }

    // Decide bucket granularity: monthly when the span is short enough,
    // otherwise group by year. We also need the rendered bars to fit:
    // each bar needs ≥6px (label) of horizontal space.
    const ML = 26, MR = 12, MT = 14, MB = 26;
    const chartW = W - ML - MR;
    const chartH = H - MT - MB;

    const firstY  = parseInt(monthly[0].period.slice(0, 4), 10);
    const firstM  = parseInt(monthly[0].period.slice(5, 7), 10);
    const lastY   = parseInt(monthly[monthly.length - 1].period.slice(0, 4), 10);
    const lastM   = parseInt(monthly[monthly.length - 1].period.slice(5, 7), 10);
    const spanMonths = (lastY - firstY) * 12 + (lastM - firstM) + 1;
    const maxBarsMonthly = Math.max(6, Math.floor(chartW / 12));   // ≥12px per month bar
    const useYearly = spanMonths > Math.min(24, maxBarsMonthly);

    let bars, labelFor;
    if (useYearly) {
        const byYear = {};
        monthly.forEach(({ period, count }) => {
            const y = period.slice(0, 4);
            byYear[y] = (byYear[y] || 0) + count;
        });
        const ys = Object.keys(byYear);
        const ymin = Math.min(...ys.map(Number));
        const ymax = Math.max(...ys.map(Number));
        bars = [];
        for (let y = ymin; y <= ymax; y++) {
            bars.push({ key: String(y), count: byYear[String(y)] || 0, label: String(y) });
        }
        labelFor = (_, i, n) => bars[i].label;   // label every year
    } else {
        // Fill in zero months between first and last so the axis is contiguous
        bars = [];
        let y = firstY, m = firstM;
        const map = Object.fromEntries(monthly.map(o => [o.period, o.count]));
        while (y < lastY || (y === lastY && m <= lastM)) {
            const period = `${y}-${String(m).padStart(2, '0')}`;
            bars.push({ key: period, count: map[period] || 0, year: y, month: m });
            m++; if (m > 12) { m = 1; y++; }
        }
        // Sparser labels when there are many bars
        const stride = Math.max(1, Math.ceil(bars.length / Math.max(4, Math.floor(chartW / 60))));
        labelFor = (bar, i, n) => {
            if (bar.month === 1) return String(bar.year);
            if (i === 0 || i === n - 1)
                return `${String(bar.month).padStart(2, '0')}/${String(bar.year).slice(2)}`;
            if (i % stride !== 0) return null;
            return `${String(bar.month).padStart(2, '0')}/${String(bar.year).slice(2)}`;
        };
    }

    const maxCount = Math.max(1, ...bars.map(b => b.count));
    const step     = niceStep(maxCount, Math.max(1, Math.floor(chartH / 30))) || 1;
    const yMax     = Math.max(step, Math.ceil(maxCount / step) * step);
    const toY      = v => MT + chartH - (v / yMax) * chartH;

    for (let v = 0; v <= yMax + step * 0.01; v += step) {
        const y = toY(v);
        const line = svgEl('line');
        line.setAttribute('x1', ML); line.setAttribute('y1', y);
        line.setAttribute('x2', ML + chartW); line.setAttribute('y2', y);
        line.setAttribute('stroke', v === 0 ? '#444' : '#222');
        line.setAttribute('stroke-width', v === 0 ? '1' : '0.5');
        svg.appendChild(line);

        const lbl = svgEl('text');
        lbl.setAttribute('x', ML - 5); lbl.setAttribute('y', y + 3);
        lbl.setAttribute('text-anchor', 'end');
        lbl.setAttribute('fill', '#555');
        lbl.setAttribute('font-size', '9');
        lbl.textContent = String(Math.round(v));
        svg.appendChild(lbl);
    }

    const n     = bars.length;
    const slotW = chartW / n;
    const barW  = Math.max(2, Math.min(useYearly ? 40 : 22, slotW * 0.7));

    bars.forEach((bar, i) => {
        const x = ML + i * slotW + (slotW - barW) / 2;
        const y = toY(bar.count);
        const rect = svgEl('rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', y);
        rect.setAttribute('width', barW);
        rect.setAttribute('height', Math.max(0, (MT + chartH) - y));
        rect.setAttribute('fill', bar.count > 0 ? '#e07020' : '#262626');
        rect.setAttribute('rx', 1.5);
        if (bar.count > 0) {
            rect.setAttribute('class', 'stats-hover-target');
            const labelText = useYearly
                ? bar.label
                : `${String(bar.month).padStart(2, '0')}/${bar.year}`;
            bindTooltip(rect, `${labelText}: ${bar.count}`);
        }
        svg.appendChild(rect);

        const label = labelFor(bar, i, n);
        if (label) {
            const lbl = svgEl('text');
            lbl.setAttribute('x', x + barW / 2);
            lbl.setAttribute('y', MT + chartH + 15);
            lbl.setAttribute('text-anchor', 'middle');
            lbl.setAttribute('fill', '#777');
            lbl.setAttribute('font-size', '9');
            lbl.textContent = label;
            svg.appendChild(lbl);
        }
    });
}

/* =========================================================
   FACTS — quick personal highlights
========================================================= */

function renderFacts(facts) {
    const wrap = document.getElementById('stats-facts');
    wrap.innerHTML = '';
    const modeLabel = PAGE.competition ? 'Wettkampf' : 'Training';
    const items = [
        { value: facts.total_cp,          label: `Posten absolviert (${modeLabel})` },
        { value: `${facts.fastest_pct}%`, label: 'schnellste Route gewählt' },
        { value: facts.longest_streak,    label: 'längste Serie schnellster Routen' },
        { value: facts.current_streak,    label: 'aktuelle Serie' },
    ];
    items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'stats-fact';
        el.innerHTML = `<span class="stats-fact-value">${item.value}</span>
                        <span class="stats-fact-label">${item.label}</span>`;
        wrap.appendChild(el);
    });
}

/* =========================================================
   UTILS
========================================================= */

function svgEl(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'stats-tooltip';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
}

function bindTooltipHtml(el, html) {
    const show = e => {
        const t = ensureTooltip();
        t.innerHTML = html;
        t.style.left = (e.clientX + 12) + 'px';
        t.style.top  = (e.clientY + 12) + 'px';
        t.style.opacity = '1';
    };
    const hide = () => { if (tooltipEl) tooltipEl.style.opacity = '0'; };
    el.addEventListener('mouseenter', show);
    el.addEventListener('mousemove',  show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('touchstart', e => {
        if (e.touches.length) show({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    }, { passive: true });
    el.addEventListener('touchend', hide);
}

function bindTooltip(el, text) { bindTooltipHtml(el, escapeHtml(text)); }

function niceStep(range, maxSteps) {
    const raw = range / Math.max(maxSteps, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const r   = raw / mag;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
}
