/* =========================================================
   STATS — personal performance vs. team, route-choice
   quality, average times and activity over time
========================================================= */

let statsData = null;

const CATEGORY_KEYS    = ['fastest', 'less_5', 'between_5_10', 'more_10'];
const CATEGORY_LABELS  = [gettext('Fastest'), '< 5%', '5–10%', '> 10%'];
const USER_COLORS      = ['#4CAF50', '#FFC107', '#FF9800', '#F44336'];
const TEAM_COLORS      = ['rgba(76,175,80,0.32)', 'rgba(255,193,7,0.32)', 'rgba(255,152,0,0.32)', 'rgba(244,67,54,0.32)'];
const TEAM_BLUE        = '#2675c5';

// HTML labels: index 0 (Schnellste) becomes the crown icon
function categoryLabelHtml(i, size) {
    if (i === 0) {
        const sz = size || '11px';
        return `<span class="stats-donut-legend-icon">${typeof icon === 'function' ? icon('crown', sz) : ''}</span>`;
    }
    return escapeHtml(CATEGORY_LABELS[i]);
}

let tooltipEl = null;

const PAGE = {
    isTrainer:      false,
    mode:           'competition',   // 'competition' | 'training' | 'random'
    view:           'graph',         // 'graph' | 'table'
    selectedAthlete: null,           // { id, name } or null = own stats
    athletes:       [],
    athletesLoading: false,          // true while /stats/get-athletes is in flight
    tableRows:      [],              // raw rows from /stats/get-table
    tableSort:      { key: null, dir: 1 }, // dir 1 = ascending, -1 = descending
};

// Backwards-compat shim — older code reads PAGE.competition
Object.defineProperty(PAGE, 'competition', {
    get() { return PAGE.mode === 'competition'; },
});

const MODE_LABEL = {
    competition: gettext('Competition'),
    training:    gettext('Training'),
    random:      'Infinity',
};

const TRAINER_TABLE_HIDDEN_RANDOM_SORT_KEYS = new Set([
    'fortschritt',
    'time_sensitivity',
    'roi_slope',
]);

/* =========================================================
   INIT
========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    PAGE.isTrainer = document.getElementById('play-wrap').dataset.isTrainer === '1';
    initModeToggle();
    initExpandButtons();
    initInfoButtons();
    updateNavTitle();
    if (PAGE.isTrainer) {
        initTrainerControls();
        initTableSortHandlers();
        initTableRowNav();
        loadAthletes();   // fire and forget — dropdown populates async
    }
    await loadStats();
    window.addEventListener('resize', renderCharts);
});

function updateNavTitle() {
    const el = document.getElementById('stats-nav-title');
    if (!el) return;
    el.textContent = `${gettext('Statistics')} (${MODE_LABEL[PAGE.mode]})`;
}

function initModeToggle() {
    const slider = document.querySelector('.stats-3way');
    if (!slider) return;
    const thumb = document.getElementById('stats-3way-thumb');
    const setThumbIcon = mode => {
        const iconName = mode === 'training' ? 'book-open'
                       : mode === 'random'   ? 'infinity'
                       : 'trophy';
        if (typeof window.icon === 'function') {
            thumb.innerHTML = window.icon(iconName, '16px');
        }
    };
    setThumbIcon(PAGE.mode);

    slider.querySelectorAll('.stats-3way-stop').forEach(stop => {
        stop.addEventListener('click', () => {
            const m = stop.dataset.mode;
            if (m === PAGE.mode) return;
            PAGE.mode = m;
            slider.dataset.mode = m;
            setThumbIcon(m);
            updateNavTitle();
            updateTrainerTableColumns();
            loadStats();
        });
    });
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
    btn.title          = expanded ? gettext('Shrink') : gettext('Enlarge');
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

function closeInfoPopovers(except = null) {
    document.querySelectorAll('.stats-info-popover.open').forEach(popover => {
        if (popover === except) return;
        popover.classList.remove('open');
        const btn = popover.parentElement?.querySelector('.stats-info-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    });
}

function initInfoButtons() {
    document.querySelectorAll('.stats-info-btn').forEach(btn => {
        const popover = btn.parentElement?.querySelector('.stats-info-popover');
        if (!popover) return;
        btn.setAttribute('aria-expanded', 'false');
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const opening = !popover.classList.contains('open');
            closeInfoPopovers(popover);
            popover.classList.toggle('open', opening);
            btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
        });
        popover.addEventListener('click', e => e.stopPropagation());
    });

    document.addEventListener('click', () => closeInfoPopovers());
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeInfoPopovers();
    });
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

function setTrainerViewThumb(view) {
    const thumb = document.getElementById('stats-2way-thumb');
    if (typeof window.icon === 'function' && thumb) {
        thumb.innerHTML = window.icon(view === 'table' ? 'table-cells' : 'chart-pie', '16px');
    }
}

function switchTrainerView(view) {
    if (PAGE.view === view) return;
    PAGE.view = view;
    document.querySelectorAll('.trainer-view-btn')
        .forEach(b => b.classList.toggle('active', b.dataset.view === view));
    const slider = document.querySelector('.stats-2way');
    if (slider) slider.dataset.view = view;
    setTrainerViewThumb(view);
    applyView();
    loadStats();
}

function initTrainerControls() {
    setTrainerViewThumb(PAGE.view);

    document.querySelectorAll('.trainer-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('active')) return;
            if (btn.disabled) return;
            switchTrainerView(btn.dataset.view);
        });
    });

    const search   = document.getElementById('trainer-athlete-search');
    const clearBtn = document.getElementById('trainer-athlete-clear');
    const dropdown = document.getElementById('trainer-athlete-dropdown');

    search.addEventListener('focus', () => {
        // Clear the input on re-focus so the full list is shown again; the
        // previously selected athlete (if any) stays selected until the user
        // picks a different one or blurs without picking.
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
    updateTrainerTableColumns();
    // Athlete picker is visible in both views — in table view it filters the table
}

async function loadAthletes() {
    PAGE.athletesLoading = true;
    try {
        const res  = await fetch('/stats/get-athletes/');
        const data = await res.json();
        PAGE.athletes = data.athletes || [];
    } catch (e) {
        console.error('loadAthletes failed:', e);
    } finally {
        PAGE.athletesLoading = false;
        // If the user already opened the dropdown while loading, refresh it in
        // place so the freshly loaded athletes appear without re-clicking.
        const dropdown = document.getElementById('trainer-athlete-dropdown');
        const search   = document.getElementById('trainer-athlete-search');
        if (dropdown && dropdown.classList.contains('open')) {
            renderAthleteDropdown(search ? search.value : '', true);
        }
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
        `<div class="trainer-athlete-option trainer-own ${PAGE.selectedAthlete === null ? 'active' : ''}" data-id="">${gettext('Own stats')}</div>`
    );
    if (PAGE.athletesLoading && PAGE.athletes.length === 0) {
        parts.push(
            `<div class="trainer-athlete-loading"><span class="trainer-athlete-spinner"></span>${gettext('Loading athletes…')}</div>`
        );
    } else if (filtered.length === 0 && q) {
        parts.push(`<div class="trainer-athlete-empty">${gettext('No athletes found')}</div>`);
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
    if (search) {
        search.value = athlete ? athlete.name : '';
        // Leave the input — drop focus so the keyboard hides on mobile
        // and the dropdown's blur-handler closes it cleanly.
        search.blur();
    }
    if (clearBtn) clearBtn.classList.toggle('visible', !!athlete);
    if (PAGE.view === 'table') {
        renderTrainerTable(PAGE.tableRows);
    } else {
        loadStats();
    }
}

// Clicking an athlete row in the table jumps to that athlete's graphical
// overview (graph view) in the current mode.
function goToAthleteGraph(userId, name) {
    PAGE.selectedAthlete = { id: userId, name };
    const search   = document.getElementById('trainer-athlete-search');
    const clearBtn = document.getElementById('trainer-athlete-clear');
    if (search)   search.value = name;
    if (clearBtn) clearBtn.classList.add('visible');
    if (PAGE.view === 'graph') {
        loadStats();
    } else {
        switchTrainerView('graph');   // applyView() + loadStats()
    }
}

function initTableRowNav() {
    const tbody = document.querySelector('#stats-table tbody');
    if (!tbody) return;
    tbody.addEventListener('click', e => {
        // Only the athlete name (first column) navigates — not the data columns.
        const td = e.target.closest('td');
        if (!td || td.cellIndex !== 0) return;
        const tr = td.closest('tr[data-user-id]');
        if (!tr) return;
        const uid = parseInt(tr.dataset.userId, 10);
        if (!uid) return;
        goToAthleteGraph(uid, tr.dataset.athleteName || '');
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* =========================================================
   DATA LOADING
========================================================= */

// Monotonic request token. Every loadStats() bumps it; an in-flight fetch only
// applies its result if its token is still the latest one. This prevents an
// earlier (slower) request from overwriting the data of a newer one when the
// user switches modes/athletes quickly.
let loadSeq = 0;

async function loadStats() {
    const token = ++loadSeq;
    try {
        if (PAGE.view === 'table' && PAGE.isTrainer) {
            await loadTrainerTable(token);
        } else {
            await loadGraphStats(token);
        }
    } catch (e) {
        console.error('loadStats failed:', e);
    }
}

async function loadGraphStats(token) {
    setCardsLoading(true);
    try {
        const params = new URLSearchParams({ mode: PAGE.mode });
        if (PAGE.selectedAthlete) params.set('user_id', String(PAGE.selectedAthlete.id));
        const res = await fetch('/stats/get-stats/?' + params.toString());
        const data = await res.json();
        // A newer request superseded this one — discard the stale response.
        if (token !== loadSeq) return;
        statsData = data;
        if (statsData.error) throw new Error(statsData.error);
        renderCharts();
        renderFacts(statsData.facts);
    } finally {
        // Only the latest request controls the spinner, otherwise a stale
        // response clears it while a newer fetch is still in flight.
        if (token === loadSeq) setCardsLoading(false);
    }
}

async function loadTrainerTable(token) {
    const wrap  = document.getElementById('stats-table-wrap');
    const tbody = document.querySelector('#stats-table tbody');
    const colspan = trainerTableColumnCount();
    if (wrap) wrap.classList.add('loading');
    try {
        const res = await fetch(`/stats/get-table/?mode=${PAGE.mode}`);
        // A newer request superseded this one — discard the stale response.
        if (token !== loadSeq) return;
        if (!res.ok) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;color:#666;padding:24px;">${gettext('Error loading data')}</td></tr>`;
            }
            return;
        }
        const data = await res.json();
        if (token !== loadSeq) return;
        PAGE.tableRows = Array.isArray(data) ? data : [];
        renderTrainerTable(PAGE.tableRows);
    } finally {
        if (token === loadSeq && wrap) wrap.classList.remove('loading');
    }
}

function trainerTableHiddenSortKeys() {
    return PAGE.mode === 'random' ? TRAINER_TABLE_HIDDEN_RANDOM_SORT_KEYS : new Set();
}

function trainerTableColumnCount() {
    return PAGE.mode === 'random' ? 9 : 11;
}

function updateTrainerTableColumns() {
    const hiddenSortKeys = trainerTableHiddenSortKeys();
    document.querySelectorAll('#stats-table thead th[data-sort]').forEach(th => {
        th.hidden = hiddenSortKeys.has(th.dataset.sort);
    });
    if (hiddenSortKeys.has(PAGE.tableSort.key)) {
        PAGE.tableSort = { key: null, dir: 1 };
    }
    updateTableSortIndicators();
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
        case 'fortschritt':     return row.progress ? Number(row.progress.pct) : NaN;
        case 'error_potential_sensitivity':
        case 'sensitivity':
            return row.error_potential_sensitivity == null ? NaN : Number(row.error_potential_sensitivity);
        case 'time_sensitivity':
        case 'roi_slope':
            return row.time_sensitivity == null ? NaN : Number(row.time_sensitivity);
        default: return 0;
    }
}

function renderTrainerTable(rows) {
    const tbody = document.querySelector('#stats-table tbody');
    if (!tbody) return;
    const colspan = trainerTableColumnCount();
    tbody.innerHTML = '';
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;color:#666;padding:24px;">${gettext('No data available')}</td></tr>`;
        updateTableSortIndicators();
        return;
    }

    // Always keep the team-average summary as the top row.
    const summary = rows.find(r => r.is_summary);
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
    const fmtMs = v => {
        if (v == null || v === '-') return '–';
        const ms = Math.round(Number(v));
        if (!Number.isFinite(ms)) return '–';
        return `${ms >= 0 ? '+' : ''}${ms} ms/s`;
    };
    for (const row of ordered) {
        const isSummary = !!row.is_summary;
        const athleteName = isSummary ? gettext('Team average') : (row.athlete ?? '–');
        const tr = document.createElement('tr');
        if (isSummary) {
            tr.className = 'stats-table-summary';
        } else if (row.user_id) {
            tr.classList.add('stats-row-clickable');
            tr.dataset.userId      = row.user_id;
            tr.dataset.athleteName = row.athlete || '';
        }
        const cells = [
            `<td>${escapeHtml(athleteName)}</td>`,
            `<td>${row.posten ?? '–'}</td>`,
            `<td>${fmtSec(row.avg_choice_time)}</td>`,
            `<td>${fmtSec(row.avg_error)}</td>`,
            `<td style="color:#4CAF50">${fmtPct(row.schnellste)}</td>`,
            `<td style="color:#FFC107">${fmtPct(row.lt5)}</td>`,
            `<td style="color:#FF9800">${fmtPct(row.lt10)}</td>`,
            `<td style="color:#F44336">${fmtPct(row.gt10)}</td>`,
        ];
        if (PAGE.mode !== 'random') {
            cells.push(`<td class="stats-cell-prog">${fmtProgressBar(row.progress)}</td>`);
        }
        cells.push(`<td>${fmtMs(row.error_potential_sensitivity)}</td>`);
        if (PAGE.mode !== 'random') {
            cells.push(`<td>${fmtMs(row.time_sensitivity)}</td>`);
        }
        tr.innerHTML = cells.join('');
        tbody.appendChild(tr);
    }
    updateTableSortIndicators();
}

// Mini progress bar: grey = completed (training darker, competition lighter),
// blue = control pairs still to do. Width is fixed; resolution is approximate.
function fmtProgressBar(p) {
    if (!p) return '–';
    const t   = Math.max(0, Math.min(100, Number(p.training_pct)    || 0));
    const c   = Math.max(0, Math.min(100, Number(p.competition_pct) || 0));
    const pct = Number(p.pct) || 0;
    let tip = `${pct.toFixed(0)}% · ${gettext('Competition short')} ${c.toFixed(0)}% · ${gettext('Training short')} ${t.toFixed(0)}%`;
    return `<span class="stats-prog-bar" title="${escapeHtml(tip)}">`
         + `<span class="stats-prog-seg stats-prog-comp" style="width:${c}%"></span>`
         + `<span class="stats-prog-seg stats-prog-training" style="width:${t}%"></span>`
         + `<span class="stats-prog-seg stats-prog-todo"></span>`
         + `</span>`;
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
        if (th.dataset.sort !== key) { ind.innerHTML = ''; ind.classList.remove('active'); return; }
        ind.innerHTML = dir === 1 ? '↑' : '↓';
        ind.classList.add('active');
    });
}

function renderCharts() {
    if (!statsData) return;
    const modeLabel = MODE_LABEL[PAGE.mode];
    const title = document.getElementById('stats-card-routes-title');
    if (title) title.textContent = gettext('Route choice');
    drawDonut();
    drawDonutLegend();
    drawAvgChart();
    drawActivityChart();
    drawErrorScatterChart();
    drawSequenceEffectChart();
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

function chartTextSizes(svg) {
    const expanded = svg?.closest('.stats-card')?.classList.contains('expanded');
    return expanded
        ? { tick: 12, axis: 13, value: 13, group: 14, legend: 14, empty: 15, sensitivity: 14 }
        : { tick: 9,  axis: 9,  value: 9,  group: 10, legend: 10, empty: 11, sensitivity: 10 };
}

function approxTextWidth(text, fontSize) {
    return String(text || '').length * fontSize * 0.52;
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

    drawRing(svg, cx, cy, outerR, ringW, statsData.team, TEAM_COLORS, gettext('Team'));
    drawRing(svg, cx, cy, innerR, ringW, statsData.user, USER_COLORS, gettext('You'));

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
    sub.textContent = gettext('Controls');
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
        const d   = arcPath(cx, cy, r, start, end);
        seg.setAttribute('d', d);
        seg.setAttribute('fill', 'none');
        seg.setAttribute('stroke', colors[i]);
        seg.setAttribute('stroke-width', strokeWidth);
        seg.setAttribute('stroke-linecap', 'butt');
        seg.setAttribute('class', 'stats-hover-target stats-donut-arc');

        // Consecutive animation: each category gets its own 150 ms slot in a
        // 600 ms total, ordered green → yellow → orange → red. Both rings
        // (Team / Du) of the same category animate together.
        const arcLenPx  = Math.abs(arcLen) * r + 4;
        const slot      = 150; // ms
        const delay     = i * slot;
        seg.setAttribute('stroke-dasharray', `${arcLenPx} ${arcLenPx}`);
        seg.style.strokeDashoffset = `${arcLenPx}`;
        seg.style.transition = `stroke-dashoffset ${slot}ms cubic-bezier(0.4, 0, 0.2, 1) ${delay}ms`;
        requestAnimationFrame(() => { seg.style.strokeDashoffset = '0'; });

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
    const text = chartTextSizes(svg);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    // Reserve space at top for the legend
    const ML = 36, MR = 14, MT = 24, MB = 26;
    const chartW = W - ML - MR;
    const chartH = H - MT - MB;

    const groups = [
        { label: gettext('Decision time'),     team: statsData.team.avg_choice_time, user: statsData.user.avg_choice_time },
        { label: gettext('Route-choice error'), team: statsData.team.avg_route_diff,  user: statsData.user.avg_route_diff  },
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
        lbl.setAttribute('font-size', text.tick);
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
            { value: g.team, color: 'rgba(224,112,32,0.42)', who: gettext('Team'), width: teamBarW },
            { value: g.user, color: '#e07020',               who: gettext('You'),   width: userBarW },
        ].forEach(bar => {
            const x = groupCx - bar.width / 2;
            const y = toY(bar.value);
            const baseY = MT + chartH;
            const rect = svgEl('rect');
            rect.setAttribute('x', x);
            rect.setAttribute('y', y);
            rect.setAttribute('width', bar.width);
            rect.setAttribute('height', Math.max(0, baseY - y));
            rect.setAttribute('fill', bar.color);
            rect.setAttribute('rx', 2);
            rect.setAttribute('class', 'stats-hover-target stats-bar');
            // Grow-from-baseline animation
            rect.style.transformOrigin = `${x + bar.width / 2}px ${baseY}px`;
            rect.style.transform = 'scaleY(0)';
            requestAnimationFrame(() => { rect.style.transform = 'scaleY(1)'; });
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
        userLbl.setAttribute('font-size', text.value);
        userLbl.setAttribute('font-weight', '600');
        userLbl.setAttribute('pointer-events', 'none');
        userLbl.textContent = `${g.user.toFixed(1)}s`;
        svg.appendChild(userLbl);

        const glbl = svgEl('text');
        glbl.setAttribute('x', groupCx);
        glbl.setAttribute('y', MT + chartH + 17);
        glbl.setAttribute('text-anchor', 'middle');
        glbl.setAttribute('fill', '#888');
        glbl.setAttribute('font-size', text.group);
        glbl.textContent = g.label;
        svg.appendChild(glbl);
    });

    // Legend at top: team (faded wide rect) | individual (solid narrow rect)
    drawAvgLegend(svg, W, text);
}

function drawAvgLegend(svg, W, text = chartTextSizes(svg)) {
    // Render the legend in the top-right of the SVG
    const items = [
        { label: gettext('Team'),       color: 'rgba(224,112,32,0.42)', w: 14, h: 8 },
        { label: gettext('Individual'), color: '#e07020',               w: 6,  h: 10 },
    ];
    let x = W - 12;
    const y = 4;
    // Build right to left
    items.slice().reverse().forEach(item => {
        const t = svgEl('text');
        t.setAttribute('y', y + 9);
        t.setAttribute('fill', '#888');
        t.setAttribute('font-size', text.legend);
        t.setAttribute('text-anchor', 'end');
        t.setAttribute('x', x);
        t.textContent = item.label;
        svg.appendChild(t);
        // approximate text width
        const textW = approxTextWidth(item.label, text.legend);
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
    const text = chartTextSizes(svg);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    // statsData.activity is an array of ISO timestamp strings (one per result).
    const timestamps = (statsData.activity || []).map(s => new Date(s));
    if (!timestamps.length) {
        const t = svgEl('text');
        t.setAttribute('x', W / 2); t.setAttribute('y', H / 2);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('fill', '#444');
        t.setAttribute('font-size', text.empty);
        t.textContent = gettext('No activity yet');
        svg.appendChild(t);
        return;
    }

    const ML = 26, MR = 32, MT = 14, MB = 26;
    const chartW = W - ML - MR;
    const chartH = H - MT - MB;

    const minDate = new Date(Math.min(...timestamps));
    const maxDate = new Date(Math.max(...timestamps));
    const dayMs   = 24 * 60 * 60 * 1000;
    let spanDays  = Math.max(1, Math.ceil((maxDate - minDate) / dayMs) + 1);

    // Pick the smallest "nice" bin size such that the resulting bin count
    // is ≤ TARGET_BINS. Bins are an integer number of days.
    const TARGET_BINS = 50;
    const NICE_DAYS   = [1, 2, 3, 7, 14, 21, 30, 60, 90, 180, 365];
    let binDays = NICE_DAYS[NICE_DAYS.length - 1];
    for (const d of NICE_DAYS) {
        if (Math.ceil(spanDays / d) <= TARGET_BINS) { binDays = d; break; }
    }

    // Anchor the binning at minDate (midnight) so each bin starts cleanly.
    const start0 = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate()).getTime();
    const binCount = Math.max(1, Math.ceil((maxDate.getTime() - start0) / (binDays * dayMs)) + 1);
    const bins = new Array(binCount).fill(0);
    for (const t of timestamps) {
        const idx = Math.floor((t.getTime() - start0) / (binDays * dayMs));
        if (idx >= 0 && idx < binCount) bins[idx]++;
    }
    const qualityBins = buildActivityQualityBins(start0, binDays, binCount);

    const maxCount = Math.max(1, ...bins);
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
        lbl.setAttribute('font-size', text.tick);
        lbl.textContent = String(Math.round(v));
        svg.appendChild(lbl);
    }

    // X-axis labels: choose a stride so we end up with ~6-8 dated tick labels
    const targetLabels = Math.max(4, Math.min(8, Math.floor(chartW / 60)));
    const labelStride  = Math.max(1, Math.ceil(bins.length / targetLabels));
    const labelFmt = binDays <= 14
        ? d => `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.`
        : binDays <= 90
        ? d => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getFullYear()).slice(2)}`
        : d => String(d.getFullYear());

    const slotW = chartW / bins.length;
    const barW  = Math.max(1.5, slotW * 0.75);

    drawActivityAccuracyOverlay(svg, qualityBins, ML, MT, chartW, chartH, slotW, text);

    bins.forEach((count, i) => {
        const binStart = new Date(start0 + i * binDays * dayMs);
        const binEnd   = new Date(start0 + (i + 1) * binDays * dayMs - 1);
        const x = ML + i * slotW + (slotW - barW) / 2;
        const y = toY(count);
        const baseY = MT + chartH;
        const rect = svgEl('rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', y);
        rect.setAttribute('width', barW);
        rect.setAttribute('height', Math.max(0, baseY - y));
        rect.setAttribute('fill', count > 0 ? TEAM_BLUE : '#262626');
        rect.setAttribute('rx', 1.5);
        if (count > 0) {
            rect.setAttribute('class', 'stats-hover-target stats-activity-bar');
            rect.style.transformOrigin = `${x + barW / 2}px ${baseY}px`;
            rect.style.transform = 'scaleY(0)';
            requestAnimationFrame(() => { rect.style.transform = 'scaleY(1)'; });
            const range = binDays === 1
                ? labelFmt(binStart)
                : `${labelFmt(binStart)} – ${labelFmt(binEnd)}`;
            bindTooltip(rect, `${range}: ${count}`);
        }
        svg.appendChild(rect);

        if (i % labelStride === 0 || i === bins.length - 1) {
            const lbl = svgEl('text');
            lbl.setAttribute('x', x + barW / 2);
            lbl.setAttribute('y', MT + chartH + 15);
            lbl.setAttribute('text-anchor', 'middle');
            lbl.setAttribute('fill', '#777');
            lbl.setAttribute('font-size', text.tick);
            lbl.textContent = labelFmt(binStart);
            svg.appendChild(lbl);
        }
    });
}

function buildActivityQualityBins(start0, binDays, binCount) {
    const dayMs = 24 * 60 * 60 * 1000;
    const bins = Array.from({ length: binCount }, () => ({
        fastest: 0,
        less_5: 0,
        between_5_10: 0,
        more_10: 0,
        total: 0,
    }));
    (statsData.activity_quality || []).forEach(item => {
        const t = new Date(item.timestamp);
        if (Number.isNaN(t.getTime()) || !CATEGORY_KEYS.includes(item.bucket)) return;
        const idx = Math.floor((t.getTime() - start0) / (binDays * dayMs));
        if (idx < 0 || idx >= binCount) return;
        bins[idx][item.bucket] += 1;
        bins[idx].total += 1;
    });
    return bins;
}

function drawActivityAccuracyOverlay(svg, bins, ML, MT, chartW, chartH, slotW, text = chartTextSizes(svg)) {
    if (!bins.some(b => b.total > 0)) return;
    const toPctY = pct => MT + chartH - (pct / 100) * chartH;
    const rightX = ML + chartW;

    const cumulativeCounts = { fastest: 0, less_5: 0, between_5_10: 0, more_10: 0 };
    let cumulativeTotal = 0;
    const cumulative = bins.map(bin => {
        CATEGORY_KEYS.forEach(key => { cumulativeCounts[key] += bin[key]; });
        cumulativeTotal += bin.total;
        if (!cumulativeTotal) return null;
        let running = 0;
        return CATEGORY_KEYS.map(key => {
            const lower = running / cumulativeTotal * 100;
            running += cumulativeCounts[key];
            return { lower, upper: running / cumulativeTotal * 100 };
        });
    });

    CATEGORY_KEYS.forEach((key, idx) => {
        const path = svgEl('path');
        path.setAttribute('d', areaPathForSeries(
            cumulative.map(bin => bin ? bin[idx].lower : null),
            cumulative.map(bin => bin ? bin[idx].upper : null),
            ML,
            slotW,
            toPctY
        ));
        path.setAttribute('fill', USER_COLORS[idx]);
        path.setAttribute('fill-opacity', '0.33');
        path.setAttribute('stroke', 'none');
        path.setAttribute('class', 'stats-accuracy-area');
        svg.appendChild(path);
    });

    [0, 50, 100].forEach(pct => {
        const y = toPctY(pct);
        const tick = svgEl('line');
        tick.setAttribute('x1', rightX);
        tick.setAttribute('y1', y);
        tick.setAttribute('x2', rightX + 4);
        tick.setAttribute('y2', y);
        tick.setAttribute('stroke', '#444');
        tick.setAttribute('stroke-width', '0.7');
        svg.appendChild(tick);

        const lbl = svgEl('text');
        lbl.setAttribute('x', rightX + 7);
        lbl.setAttribute('y', y + 3);
        lbl.setAttribute('fill', '#666');
        lbl.setAttribute('font-size', text.tick);
        lbl.textContent = `${pct}%`;
        svg.appendChild(lbl);
    });
}

function areaPathForSeries(lowerValues, upperValues, ML, slotW, toY) {
    let d = '';
    let upper = [];
    let lower = [];

    const flush = () => {
        if (!upper.length) return;
        d += `${d ? ' ' : ''}M ${upper.map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ')}`;
        d += ` L ${lower.reverse().map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ')} Z`;
        upper = [];
        lower = [];
    };

    upperValues.forEach((upperValue, i) => {
        const lowerValue = lowerValues[i];
        if (upperValue == null || lowerValue == null) {
            flush();
            return;
        }
        const x = ML + i * slotW + slotW / 2;
        upper.push({ x, y: toY(upperValue) });
        lower.push({ x, y: toY(lowerValue) });
    });
    flush();
    return d;
}

/* =========================================================
   ERROR POTENTIAL - decision time vs. route runtime spread
========================================================= */

function errorPotentialPoints() {
    return (statsData?.error_potential?.points || [])
        .map(p => ({
            x: Number(p.x),
            y: Number(p.y),
            route_count: Number(p.route_count) || 0,
            max_error: Number(p.max_error),
        }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function drawErrorScatterChart() {
    const svg = document.getElementById('stats-error-scatter-chart');
    if (!svg) return;
    svg.innerHTML = '';
    const W = svg.clientWidth  || 320;
    const H = svg.clientHeight || 220;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const points = errorPotentialPoints();
    if (!points.length) {
        drawCenteredEmpty(svg, W, H, gettext('No data'));
        return;
    }
    if (points.length < 100) {
        drawCenteredEmpty(svg, W, H, gettext('not enough results'));
        return;
    }

    const ML = 42, MR = 14, MT = 14, MB = 32;
    const chartW = W - ML - MR;
    const chartH = H - MT - MB;
    const maxX = Math.max(0.1, percentile(points.map(p => p.x), 0.95));
    const maxY = Math.max(0.1, percentile(points.map(p => p.y), 0.95));
    const xStep = niceStep(maxX, Math.max(2, Math.floor(chartW / 70)));
    const yStep = niceStep(maxY, Math.max(2, Math.floor(chartH / 36)));
    const xMax = Math.ceil(maxX / xStep) * xStep;
    const yMax = Math.ceil(maxY / yStep) * yStep;
    const toX = v => ML + (xMax > 0 ? (v / xMax) * chartW : 0);
    const toY = v => MT + chartH - (yMax > 0 ? (v / yMax) * chartH : 0);

    drawGrid(svg, ML, MT, chartW, chartH, xMax, yMax, xStep, yStep, toX, toY);
    drawAxisLabels(svg, W, H, ML, MT, chartH, gettext('Error potential'), gettext('Decision time'));

    const visiblePoints = points.filter(p => p.x <= xMax && p.y <= yMax);
    const sample = samplePoints(visiblePoints, 1800);
    sample.forEach(p => {
        const c = svgEl('circle');
        c.setAttribute('cx', toX(p.x));
        c.setAttribute('cy', toY(p.y));
        c.setAttribute('r', sample.length > 900 ? 1.7 : 2.2);
        c.setAttribute('fill', '#e07020');
        c.setAttribute('fill-opacity', sample.length > 900 ? '0.28' : '0.42');
        c.setAttribute('class', 'stats-hover-target stats-scatter-point');
        bindTooltip(c, `${gettext('Potential')}: ${p.x.toFixed(2)}s · ${gettext('Time')}: ${p.y.toFixed(2)}s · ${gettext('Routes')}: ${p.route_count}`);
        svg.appendChild(c);
    });

    const userFit = regressionFit(statsData?.error_potential?.user_fit);
    const teamFit = regressionFit(statsData?.error_potential?.team_fit);
    if (teamFit) {
        drawTrendLine(svg, toX, toY, xMax, yMax, teamFit, TEAM_BLUE, `${gettext('Team')}: ${formatMsSensitivity(teamFit)} ms/s`);
    }
    if (userFit) {
        drawTrendLine(svg, toX, toY, xMax, yMax, userFit, '#f3b27d', `${gettext('Personal')}: ${formatMsSensitivity(userFit)} ms/s`);
    }
    drawSensitivityLabels(svg, W, MT, userFit, teamFit);
}

function drawErrorBinsChart() {
    const svg = document.getElementById('stats-error-bins-chart');
    if (!svg) return;
    svg.innerHTML = '';
    const W = svg.clientWidth  || 320;
    const H = svg.clientHeight || 220;
    const text = chartTextSizes(svg);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const points = errorPotentialPoints();
    if (!points.length) {
        drawCenteredEmpty(svg, W, H, gettext('No data'));
        return;
    }

    const bins = makeErrorBins(points, 6);
    const ML = 42, MR = 14, MT = 18, MB = 32;
    const chartW = W - ML - MR;
    const chartH = H - MT - MB;
    const maxAvg = Math.max(0.1, ...bins.map(b => b.avgY));
    const yStep = niceStep(maxAvg, Math.max(2, Math.floor(chartH / 36)));
    const yMax = Math.ceil(maxAvg / yStep) * yStep;
    const toY = v => MT + chartH - (yMax > 0 ? (v / yMax) * chartH : 0);

    for (let v = 0; v <= yMax + yStep * 0.01; v += yStep) {
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
        lbl.setAttribute('font-size', text.tick);
        lbl.textContent = `${v.toFixed(yStep < 1 ? 1 : 0)}s`;
        svg.appendChild(lbl);
    }

    const slotW = chartW / bins.length;
    const barW = Math.max(10, slotW * 0.64);
    bins.forEach((b, i) => {
        const cx = ML + i * slotW + slotW / 2;
        const y = toY(b.avgY);
        const baseY = MT + chartH;
        const rect = svgEl('rect');
        rect.setAttribute('x', cx - barW / 2);
        rect.setAttribute('y', y);
        rect.setAttribute('width', barW);
        rect.setAttribute('height', Math.max(0, baseY - y));
        rect.setAttribute('rx', 2);
        rect.setAttribute('fill', '#e07020');
        rect.setAttribute('fill-opacity', '0.78');
        rect.setAttribute('class', 'stats-hover-target stats-bar');
        rect.style.transformOrigin = `${cx}px ${baseY}px`;
        rect.style.transform = 'scaleY(0)';
        requestAnimationFrame(() => { rect.style.transform = 'scaleY(1)'; });
        bindTooltip(rect, `${formatBinLabel(b)}: ${b.avgY.toFixed(2)}s (${b.count})`);
        svg.appendChild(rect);

        const lbl = svgEl('text');
        lbl.setAttribute('x', cx);
        lbl.setAttribute('y', MT + chartH + 15);
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('fill', '#777');
        lbl.setAttribute('font-size', text.tick);
        lbl.textContent = formatShortBinLabel(b);
        svg.appendChild(lbl);
    });

    drawAxisLabels(svg, W, H, ML, MT, chartH, gettext('Potential'), gettext('Ø Time'));
}

function timeSensitivityPoints() {
    return (statsData?.time_sensitivity?.points || [])
        .map(p => ({
            x: Number(p.x),
            y: Number(p.y),
            choice_time: Number(p.choice_time),
            avg_choice_time: Number(p.avg_choice_time),
            result_count: Number(p.result_count) || 0,
        }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.choice_time));
}

function drawSequenceEffectChart() {
    const svg = document.getElementById('stats-sequence-chart');
    if (!svg) return;
    svg.innerHTML = '';
    const W = svg.clientWidth  || 320;
    const H = svg.clientHeight || 220;
    const text = chartTextSizes(svg);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const points = timeSensitivityPoints();
    if (!points.length) {
        drawCenteredEmpty(svg, W, H, gettext('No data'));
        return;
    }
    if (points.length < 100) {
        drawCenteredEmpty(svg, W, H, gettext('not enough results'));
        return;
    }

    const ML = 42, MR = 14, MT = 14, MB = 32;
    const chartW = W - ML - MR;
    const chartH = H - MT - MB;
    const xRange = niceRange(
        percentile(points.map(p => p.x), 0.025),
        percentile(points.map(p => p.x), 0.975),
        Math.max(2, Math.floor(chartW / 70)),
    );
    const maxY = Math.max(0.1, percentile(points.map(p => p.y), 0.95));
    const yStep = niceStep(maxY, Math.max(2, Math.floor(chartH / 36)));
    const yMax = Math.ceil(maxY / yStep) * yStep;
    const xMin = xRange.min;
    const xMax = xRange.max;
    const xStep = xRange.step;
    const toX = v => ML + (xMax > xMin ? ((v - xMin) / (xMax - xMin)) * chartW : chartW / 2);
    const toY = v => MT + chartH - (yMax > 0 ? (v / yMax) * chartH : 0);

    drawGridRange(svg, ML, MT, chartW, chartH, xMin, xMax, 0, yMax, xStep, yStep, toX, toY);
    drawAxisLabels(svg, W, H, ML, MT, chartH, gettext('Decision time difference'), gettext('Route-choice error'));

    const visiblePoints = points.filter(p => p.x >= xMin && p.x <= xMax && p.y <= yMax);
    const sample = samplePoints(visiblePoints, 1800);
    sample.forEach(p => {
        const c = svgEl('circle');
        c.setAttribute('cx', toX(p.x));
        c.setAttribute('cy', toY(p.y));
        c.setAttribute('r', sample.length > 900 ? 1.7 : 2.2);
        c.setAttribute('fill', '#e07020');
        c.setAttribute('fill-opacity', sample.length > 900 ? '0.28' : '0.42');
        c.setAttribute('class', 'stats-hover-target stats-scatter-point');
        const rel = `${p.x >= 0 ? '+' : ''}${p.x.toFixed(2)}s`;
        const avg = Number.isFinite(p.avg_choice_time) ? ` · Ø: ${p.avg_choice_time.toFixed(2)}s` : '';
        bindTooltip(c, `${gettext('Time vs Ø:')} ${rel} · ${gettext('Error')}: ${p.y.toFixed(2)}s · ${gettext('Time')}: ${p.choice_time.toFixed(2)}s${avg} · n=${p.result_count}`);
        svg.appendChild(c);
    });

    const fit = regressionFit(statsData?.time_sensitivity?.fit);
    if (fit) {
        const y0 = Math.max(0, Math.min(yMax, fit.intercept + fit.slope * xMin));
        const y1 = Math.max(0, Math.min(yMax, fit.intercept + fit.slope * xMax));
        const line = svgEl('line');
        line.setAttribute('x1', toX(xMin));
        line.setAttribute('y1', toY(y0));
        line.setAttribute('x2', toX(xMax));
        line.setAttribute('y2', toY(y1));
        line.setAttribute('stroke', '#f3b27d');
        line.setAttribute('stroke-width', '1.8');
        line.setAttribute('class', 'stats-hover-target stats-trend-line');
        bindTooltip(line, `${gettext('Time sensitivity')}: ${formatMsSensitivity(fit)} ms/s`);
        svg.appendChild(line);

        const label = svgEl('text');
        label.setAttribute('x', W - 14);
        label.setAttribute('y', MT + 10);
        label.setAttribute('text-anchor', 'end');
        label.setAttribute('fill', '#f3b27d');
        label.setAttribute('font-size', text.sensitivity);
        label.setAttribute('font-weight', '600');
        label.textContent = `${gettext('Sensitivity')}: ${formatMsSensitivity(fit)} ms/s`;
        svg.appendChild(label);
    }
}

function regressionFit(raw) {
    if (!raw || !Number.isFinite(Number(raw.slope)) || !Number.isFinite(Number(raw.intercept))) {
        return null;
    }
    return {
        slope: Number(raw.slope),
        intercept: Number(raw.intercept),
        n: Number(raw.n) || 0,
        sensitivity_ms: Number.isFinite(Number(raw.sensitivity_ms))
            ? Number(raw.sensitivity_ms)
            : Math.round(Number(raw.slope) * 1000),
    };
}

function formatMsSensitivity(fit) {
    const ms = Math.round(fit.sensitivity_ms);
    return `${ms >= 0 ? '+' : ''}${ms}`;
}

function drawSensitivityLabels(svg, W, MT, userFit, teamFit) {
    const text = chartTextSizes(svg);
    const rows = [];
    if (userFit) rows.push({ label: `Du: ${formatMsSensitivity(userFit)} ms/s`, color: '#f3b27d' });
    if (teamFit) rows.push({ label: `${gettext('Team')}: ${formatMsSensitivity(teamFit)} ms/s`, color: TEAM_BLUE });
    rows.forEach((row, i) => {
        const t = svgEl('text');
        t.setAttribute('x', W - 14);
        t.setAttribute('y', MT + text.sensitivity + i * (text.sensitivity + 3));
        t.setAttribute('text-anchor', 'end');
        t.setAttribute('fill', row.color);
        t.setAttribute('font-size', text.sensitivity);
        t.setAttribute('font-weight', '600');
        t.textContent = row.label;
        svg.appendChild(t);
    });
}

function drawCenteredEmpty(svg, W, H, text) {
    const sizes = chartTextSizes(svg);
    const t = svgEl('text');
    t.setAttribute('x', W / 2); t.setAttribute('y', H / 2);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', '#444');
    t.setAttribute('font-size', sizes.empty);
    t.textContent = text;
    svg.appendChild(t);
}

function drawGridRange(svg, ML, MT, chartW, chartH, xMin, xMax, yMin, yMax, xStep, yStep, toX, toY, xUnit = 's', yUnit = 's') {
    const text = chartTextSizes(svg);
    const yStart = Math.ceil(yMin / yStep) * yStep;
    for (let v = yStart; v <= yMax + yStep * 0.01; v += yStep) {
        const y = toY(v);
        const isZero = Math.abs(v) < 1e-9;
        const line = svgEl('line');
        line.setAttribute('x1', ML); line.setAttribute('y1', y);
        line.setAttribute('x2', ML + chartW); line.setAttribute('y2', y);
        line.setAttribute('stroke', isZero ? '#444' : '#222');
        line.setAttribute('stroke-width', isZero ? '1' : '0.5');
        svg.appendChild(line);

        const lbl = svgEl('text');
        lbl.setAttribute('x', ML - 6); lbl.setAttribute('y', y + 3);
        lbl.setAttribute('text-anchor', 'end');
        lbl.setAttribute('fill', '#555');
        lbl.setAttribute('font-size', text.tick);
        lbl.textContent = `${v.toFixed(yStep < 1 ? 1 : 0)}${yUnit}`;
        svg.appendChild(lbl);
    }

    const xStart = Math.ceil(xMin / xStep) * xStep;
    for (let v = xStart; v <= xMax + xStep * 0.01; v += xStep) {
        const x = toX(v);
        const isZero = Math.abs(v) < 1e-9;
        const line = svgEl('line');
        line.setAttribute('x1', x); line.setAttribute('y1', MT);
        line.setAttribute('x2', x); line.setAttribute('y2', MT + chartH);
        line.setAttribute('stroke', isZero ? '#444' : '#222');
        line.setAttribute('stroke-width', isZero ? '1' : '0.5');
        svg.appendChild(line);

        const lbl = svgEl('text');
        lbl.setAttribute('x', x); lbl.setAttribute('y', MT + chartH + 15);
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('fill', '#555');
        lbl.setAttribute('font-size', text.tick);
        lbl.textContent = `${v.toFixed(xStep < 1 ? 1 : 0)}${xUnit}`;
        svg.appendChild(lbl);
    }
}

function drawGrid(svg, ML, MT, chartW, chartH, xMax, yMax, xStep, yStep, toX, toY, xUnit = 's', yUnit = 's') {
    const text = chartTextSizes(svg);
    for (let v = 0; v <= yMax + yStep * 0.01; v += yStep) {
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
        lbl.setAttribute('font-size', text.tick);
        lbl.textContent = `${v.toFixed(yStep < 1 ? 1 : 0)}${yUnit}`;
        svg.appendChild(lbl);
    }

    for (let v = 0; v <= xMax + xStep * 0.01; v += xStep) {
        const x = toX(v);
        const line = svgEl('line');
        line.setAttribute('x1', x); line.setAttribute('y1', MT);
        line.setAttribute('x2', x); line.setAttribute('y2', MT + chartH);
        line.setAttribute('stroke', v === 0 ? '#444' : '#222');
        line.setAttribute('stroke-width', v === 0 ? '1' : '0.5');
        svg.appendChild(line);

        const lbl = svgEl('text');
        lbl.setAttribute('x', x); lbl.setAttribute('y', MT + chartH + 15);
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('fill', '#555');
        lbl.setAttribute('font-size', text.tick);
        lbl.textContent = `${v.toFixed(xStep < 1 ? 1 : 0)}${xUnit}`;
        svg.appendChild(lbl);
    }
}

function drawAxisLabels(svg, W, H, ML, MT, chartH, xLabel, yLabel) {
    const text = chartTextSizes(svg);
    const x = svgEl('text');
    x.setAttribute('x', W / 2);
    x.setAttribute('y', H - Math.max(3, text.axis * 0.25));
    x.setAttribute('text-anchor', 'middle');
    x.setAttribute('fill', '#777');
    x.setAttribute('font-size', text.axis);
    x.textContent = xLabel;
    svg.appendChild(x);

    const y = svgEl('text');
    const yx = 10;
    const yy = MT + chartH / 2;
    y.setAttribute('x', yx);
    y.setAttribute('y', yy);
    y.setAttribute('text-anchor', 'middle');
    y.setAttribute('transform', `rotate(-90 ${yx} ${yy})`);
    y.setAttribute('fill', '#777');
    y.setAttribute('font-size', text.axis);
    y.textContent = yLabel;
    svg.appendChild(y);
}

function samplePoints(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const step = points.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
        out.push(points[Math.floor(i * step)]);
    }
    return out;
}

function percentile(values, p) {
    const sorted = values
        .filter(v => Number.isFinite(v))
        .sort((a, b) => a - b);
    if (!sorted.length) return 0;
    if (sorted.length === 1) return sorted[0];
    const idx = (sorted.length - 1) * Math.max(0, Math.min(1, p));
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function niceRange(minVal, maxVal, maxSteps) {
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
        return { min: -1, max: 1, step: 1 };
    }
    if (Math.abs(maxVal - minVal) < 1e-9) {
        const pad = Math.max(1, Math.abs(maxVal) * 0.25);
        minVal -= pad;
        maxVal += pad;
    }
    minVal = Math.min(minVal, 0);
    maxVal = Math.max(maxVal, 0);
    const step = niceStep(maxVal - minVal, maxSteps);
    return {
        min: Math.floor(minVal / step) * step,
        max: Math.ceil(maxVal / step) * step,
        step,
    };
}

function linearRegression(points) {
    if (points.length < 3) return null;
    const n = points.length;
    const sx = points.reduce((s, p) => s + p.x, 0);
    const sy = points.reduce((s, p) => s + p.y, 0);
    const mx = sx / n;
    const my = sy / n;
    let sxx = 0, sxy = 0;
    points.forEach(p => {
        const dx = p.x - mx;
        sxx += dx * dx;
        sxy += dx * (p.y - my);
    });
    if (sxx <= 1e-9) return null;
    const slope = sxy / sxx;
    return { slope, intercept: my - slope * mx };
}

function drawTrendLine(svg, toX, toY, xMax, yMax, trend, color, tooltip) {
    const y0 = Math.max(0, Math.min(yMax, trend.intercept));
    const y1 = Math.max(0, Math.min(yMax, trend.intercept + trend.slope * xMax));
    const line = svgEl('line');
    line.setAttribute('x1', toX(0));
    line.setAttribute('y1', toY(y0));
    line.setAttribute('x2', toX(xMax));
    line.setAttribute('y2', toY(y1));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1.8');
    line.setAttribute('class', 'stats-hover-target stats-trend-line');
    bindTooltip(line, tooltip);
    svg.appendChild(line);
}

function valueExtent(values) {
    return {
        min: Math.min(...values),
        max: Math.max(...values),
    };
}

function drawMiniLegend(svg, W, items) {
    const text = chartTextSizes(svg);
    let x = W - 12;
    const y = 4;
    items.slice().reverse().forEach(item => {
        const t = svgEl('text');
        t.setAttribute('y', y + text.legend * 0.9);
        t.setAttribute('fill', '#888');
        t.setAttribute('font-size', text.legend);
        t.setAttribute('text-anchor', 'end');
        t.setAttribute('x', x);
        t.textContent = item.label;
        svg.appendChild(t);
        x -= approxTextWidth(item.label, text.legend) + 5;

        const line = svgEl('line');
        line.setAttribute('x1', x - 16);
        line.setAttribute('y1', y + text.legend * 0.5);
        line.setAttribute('x2', x - 2);
        line.setAttribute('y2', y + text.legend * 0.5);
        line.setAttribute('stroke', item.color);
        line.setAttribute('stroke-width', '1.8');
        line.setAttribute('class', 'stats-trend-line');
        svg.appendChild(line);
        x -= 26;
    });
}

function makeErrorBins(points, targetBins) {
    const maxX = Math.max(...points.map(p => p.x));
    const binCount = maxX <= 0 ? 1 : Math.min(targetBins, Math.max(1, Math.ceil(points.length / 4)));
    const width = maxX <= 0 ? 1 : maxX / binCount;
    const bins = Array.from({ length: binCount }, (_, i) => ({
        min: i * width,
        max: i === binCount - 1 ? maxX : (i + 1) * width,
        count: 0,
        sumY: 0,
        avgY: 0,
    }));
    points.forEach(p => {
        const idx = maxX <= 0 ? 0 : Math.min(binCount - 1, Math.floor(p.x / width));
        bins[idx].count += 1;
        bins[idx].sumY += p.y;
    });
    return bins.filter(b => b.count > 0).map(b => ({ ...b, avgY: b.sumY / b.count }));
}

function formatBinLabel(b) {
    return `${b.min.toFixed(1)}-${b.max.toFixed(1)}s`;
}

function formatShortBinLabel(b) {
    if (b.max <= 0) return '0s';
    return `${b.min.toFixed(0)}-${b.max.toFixed(0)}s`;
}

/* =========================================================
   FACTS — quick personal highlights
========================================================= */

function renderFacts(facts) {
    const wrap = document.getElementById('stats-facts');
    wrap.innerHTML = '';
    const modeLabel = MODE_LABEL[PAGE.mode];
    const items = [
        { value: facts.total_cp,          label: `${gettext('Controls completed')} (${modeLabel})` },
        { value: `${facts.fastest_pct}%`, label: gettext('fastest route chosen') },
        { value: facts.longest_streak,    label: gettext('longest streak of fastest routes') },
        { value: facts.current_streak,    label: gettext('current streak') },
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

    // Mobile: a tap shows the tooltip (see bindTooltipHtml's touchstart
    // handler) and ghost mouse events can keep it pinned open afterwards
    // since there's no real mouseleave on touch devices. Hide it as soon
    // as the user starts scrolling, on any scrollable ancestor (capture
    // catches scrolls on #play-wrap too) and on the first touchmove.
    const hideOnScroll = () => hideTooltip();
    document.addEventListener('scroll', hideOnScroll, { capture: true, passive: true });
    document.addEventListener('touchmove', hideOnScroll, { passive: true });

    return tooltipEl;
}

function hideTooltip() {
    if (tooltipEl) tooltipEl.style.opacity = '0';
}

function bindTooltipHtml(el, html) {
    const show = e => {
        const t = ensureTooltip();
        t.innerHTML = html;
        t.style.left = (e.clientX + 12) + 'px';
        t.style.top  = (e.clientY + 12) + 'px';
        t.style.opacity = '1';
    };
    el.addEventListener('mouseenter', show);
    el.addEventListener('mousemove',  show);
    el.addEventListener('mouseleave', hideTooltip);
    el.addEventListener('touchstart', e => {
        if (e.touches.length) show({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    }, { passive: true });
    el.addEventListener('touchend', hideTooltip);
}

function bindTooltip(el, text) { bindTooltipHtml(el, escapeHtml(text)); }

function niceStep(range, maxSteps) {
    const raw = range / Math.max(maxSteps, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const r   = raw / mag;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
}
