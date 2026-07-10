/* =========================================================
   PLAY / RESULTS — project overview
   Patterns ported from projecttable.js
========================================================= */

/* =========================================================
   STATE
========================================================= */

let allFiles        = [];
let filteredFiles   = [];
let sharedPool      = false;
let multiTeam       = false;
let activeTeamName  = '';
let generatedInfiniteDone = 0;

// key = stable identifier used for filtering/matching (never translated);
// label = display text (translated).
const STATUS = {
    neu:      { key: 'neu',      label: gettext('new'),     color: '#0044CC', rgb: '0,68,204'    },
    begonnen: { key: 'begonnen', label: gettext('started'), color: '#E07020', rgb: '224,112,32'  },
    erledigt: { key: 'erledigt', label: gettext('done'),    color: '#1A8833', rgb: '26,136,51'   },
};

function fileStatus(f) {
    if (!f.user_cp_done || f.user_cp_done === 0) return STATUS.neu;
    if (f.user_cp_done >= f.cp_count)            return STATUS.erledigt;
    return STATUS.begonnen;
}

// Play mode: 'training' | 'competition' | 'infinity'. Default competition.
// In infinity mode the list is filtered to maps opted in to infinite play
// (infinite_enabled); status and control-pair progress are not applicable.
let playMode = 'competition';

// Base route for infinite play. With ?source=mask&file=… it plays a real
// uploaded map's mask; with no query it runs the procedurally-generated
// "generated map" (city gen).
const INFINITY_URL = '/play/infinity/';

// Synthetic first-row entry shown only in infinity mode. Clicking it launches
// procedural infinite play. Pinned to the top regardless of filters/sorting.
function generatedMapEntry() {
    return {
        synthetic:        true,
        id:               '__generated__',
        name:             gettext('Generated maps'),
        author:           'SYS',
        team_name:        activeTeamName,
        label:            null,
        infinite_enabled: true,
        infinite_done:    generatedInfiniteDone,
    };
}

let activeLabelFilter  = null;      // single ID or null (like editor)
let activeAuthorFilters = [];
let activeKaderFilters  = [];
let activeStatusFilters = ['neu', 'begonnen'];   // default selection on first load
let sortState = { key: 'last_edited', dir: -1 };

/* =========================================================
   INIT
========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    initSearch();
    initModeToggle();
    initDropdownProtection();
    await loadFiles();
});

async function loadFiles() {
    document.getElementById('play-loading').style.display = '';
    try {
        const res  = await fetch('/play/get-files/');
        const data = await res.json();
        allFiles       = data.files            || [];
        sharedPool     = data.shared_pool      || false;
        multiTeam      = data.multi_team       || false;
        activeTeamName = data.active_team_name || '';
        generatedInfiniteDone = Number(data.generated_infinite_done) || 0;
        renderHeader();
        applyFilters();
    } catch (e) {
        console.error('loadFiles failed:', e);
    } finally {
        document.getElementById('play-loading').style.display = 'none';
    }
}

/* =========================================================
   MODE TOGGLE  (training / competition / infinity)
========================================================= */

const MODE_ICON = { training: 'book-open', competition: 'trophy', infinity: 'infinity' };

function infinityMode() { return playMode === 'infinity'; }

function statusFilterActive() {
    return !infinityMode() && activeStatusFilters.length > 0;
}

function initModeToggle() {
    const slider = document.querySelector('.play-3way');
    if (!slider) return;
    const thumb = document.getElementById('play-mode-thumb');

    const setThumbIcon = mode => {
        if (typeof window.icon === 'function') {
            thumb.innerHTML = window.icon(MODE_ICON[mode] || 'trophy', '16px');
        }
    };

    // Restore persisted mode; default competition.
    const stored = sessionStorage.getItem('playMode');
    if (stored === 'training' || stored === 'competition' || stored === 'infinity') {
        playMode = stored;
    }
    slider.dataset.mode = playMode;
    setThumbIcon(playMode);

    slider.querySelectorAll('.play-3way-stop').forEach(stop => {
        stop.addEventListener('click', () => {
            const m = stop.dataset.mode;
            if (m === playMode) return;
            playMode = m;
            sessionStorage.setItem('playMode', playMode);
            slider.dataset.mode = playMode;
            setThumbIcon(playMode);
            // The Controls column is hidden in infinity mode — don't leave the
            // table sorted by a column that's no longer visible.
            if (infinityMode() && sortState.key === 'cp_count') {
                sortState = { key: 'last_edited', dir: -1 };
            }
            renderHeader();     // rebuild thead (column set depends on mode)
            applyFilters();     // re-filter (infinity → infinite_enabled only)
        });
    });
}

/* =========================================================
   SEARCH
========================================================= */

function initSearch() {
    const input = document.getElementById('play-search');
    input.addEventListener('input', applyFilters);
    input.addEventListener('input', updateClearButton);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        }
    });
    updateClearButton();
}

function updateClearButton() {
    const input    = document.getElementById('play-search');
    const clearBtn = document.getElementById('play-search-clear');
    const hasSearch  = !!input.value.trim();
    const hasFilters = activeLabelFilter !== null
        || activeAuthorFilters.length > 0
        || activeKaderFilters.length  > 0
        || statusFilterActive();
    clearBtn.classList.toggle('visible', hasSearch || hasFilters);
}

function clearSearch() {
    document.getElementById('play-search').value = '';
    activeLabelFilter   = null;
    activeAuthorFilters = [];
    activeKaderFilters  = [];
    activeStatusFilters = [];
    sortState = { key: 'last_edited', dir: -1 };
    applyFilters();
    updateClearButton();
}

/* =========================================================
   FILTERING + SORTING
========================================================= */

function applyFilters() {
    const search = document.getElementById('play-search').value.toLowerCase();

    filteredFiles = allFiles.filter(f => {
        // Infinity mode only lists maps opted in to infinite play.
        if (infinityMode() && !f.infinite_enabled) return false;
        const matchSearch =
            (f.name   || '').toLowerCase().includes(search) ||
            (f.author || '').toLowerCase().includes(search) ||
            (f.label?.name || '').toLowerCase().includes(search);
        const matchLabel  = !activeLabelFilter
            || f.label?.id === activeLabelFilter;
        const matchAuthor = !activeAuthorFilters.length
            || activeAuthorFilters.includes((f.author || '').trim());
        const matchKader  = !activeKaderFilters.length
            || activeKaderFilters.includes((f.team_name || '').trim());
        // Infinity has no completion status: every opted-in map must remain
        // available regardless of the status selection used in other modes.
        const matchStatus = !statusFilterActive()
            || activeStatusFilters.includes(fileStatus(f).key);
        return matchSearch && matchLabel && matchAuthor && matchKader && matchStatus;
    });

    filteredFiles = applySorting(filteredFiles);

    // The "generated map" entry is always first in infinity mode, unaffected
    // by search, filters or sorting.
    if (infinityMode()) {
        filteredFiles = [generatedMapEntry(), ...filteredFiles];
    }

    renderTable();
    renderCards();
    renderMobileControls();
    updateSortIndicators();
    updateFilterIcons();
    updateClearButton();
}

function applySorting(data) {
    const { key, dir } = sortState;

    const sortGroup = arr => {
        if (!key) return arr;
        return [...arr].sort((a, b) => {
            const get = f => {
                switch (key) {
                    case 'name':        return (f.name || '').toLowerCase();
                    case 'cp_count':    return f.cp_count || 0;
                    case 'last_edited': return new Date(f.last_edited || 0).getTime();
                    default: return '';
                }
            };
            const va = get(a), vb = get(b);
            // For name, flip so ↓ = A→Z (ascending); for numbers/dates ↓ = largest first
            const effectiveDir = key === 'name' ? -dir : dir;
            if (va < vb) return -1 * effectiveDir;
            if (va > vb) return  1 * effectiveDir;
            return 0;
        });
    };

    // Active team always on top; each group sorted independently
    const own   = data.filter(f => f.team_name === activeTeamName);
    const other = data.filter(f => f.team_name !== activeTeamName);
    return [...sortGroup(own), ...sortGroup(other)];
}

function setSort(key) {
    if (sortState.key === key) sortState.dir *= -1;
    else { sortState.key = key; sortState.dir = -1; }
    applyFilters();
}

/* =========================================================
   DESKTOP TABLE HEADER
========================================================= */

function renderHeader() {
    const thead = document.getElementById('play-thead');
    const kaderCol = multiTeam
        ? `<th class="col-kader">
               <span class="filterable" id="kader-filter-btn">${gettext('Team')}
                   <span class="filter-indicator active-filter-icon">${window.icon('filter', '0.8em')}</span>
               </span>
           </th>`
        : '';

    // Status and Controls are progress fields and do not apply to Infinity.
    const statusCol = infinityMode()
        ? ''
        : `<th class="col-status">
               <span class="filterable" id="status-filter-btn">${gettext('Status')}
                   <span class="filter-indicator active-filter-icon">${window.icon('filter', '0.8em')}</span>
               </span>
           </th>`;

    const cpCol = infinityMode()
        ? `<th class="col-cp col-infinity-done" style="text-align:center;">${gettext('Done')}</th>`
        : `<th class="col-cp" data-sort="cp_count" style="text-align:center;">
               <span class="sortable">${gettext('Controls')}
                   <span id="sort-cp_count" class="sort-indicator"></span>
               </span>
           </th>`;

    thead.innerHTML = `
        <tr>
            <th class="col-name" data-sort="name">
                <span class="sortable">${gettext('Name')}
                    <span id="sort-name" class="sort-indicator"></span>
                </span>
            </th>
            <th class="col-label">
                <span class="filterable" id="label-filter-btn">${gettext('Label')}
                    <span class="filter-indicator active-filter-icon">${window.icon('filter', '0.8em')}</span>
                </span>
            </th>
            ${statusCol}
            ${cpCol}
            <th class="col-author">
                <span class="filterable" id="author-filter-btn">${gettext('Author')}
                    <span class="filter-indicator active-filter-icon">${window.icon('filter', '0.8em')}</span>
                </span>
            </th>
            ${kaderCol}
            <th class="col-date" data-sort="last_edited">
                <span class="sortable">${gettext('Created')}
                    <span id="sort-last_edited" class="sort-indicator"></span>
                </span>
            </th>
        </tr>`;

    attachHeaderEvents();
    updateSortIndicators();
    updateFilterIcons();
}

function attachHeaderEvents() {
    document.querySelectorAll('[data-sort]').forEach(el => {
        el.onclick = () => setSort(el.dataset.sort);
    });
    document.getElementById('label-filter-btn')  ?.addEventListener('click', toggleLabelFilter);
    document.getElementById('author-filter-btn') ?.addEventListener('click', toggleAuthorFilter);
    document.getElementById('kader-filter-btn')  ?.addEventListener('click', toggleKaderFilter);
    document.getElementById('status-filter-btn') ?.addEventListener('click', toggleStatusFilter);
    document.getElementById('play-search-clear') ?.addEventListener('click', clearSearch);
}

/* =========================================================
   SORT INDICATORS
========================================================= */

function getSortIcon(k) {
    if (sortState.key !== k) return '';
    const arrow = sortState.dir === -1 ? '↓' : '↑';
    return `<span class="sort-icon-box active">${arrow}</span>`;
}

function updateSortIndicators() {
    ['name', 'cp_count', 'last_edited'].forEach(k => {
        const el = document.getElementById(`sort-${k}`);
        if (el) el.innerHTML = getSortIcon(k);
    });
}

/* =========================================================
   FILTER ICONS
========================================================= */

function updateFilterIcons() {
    document.querySelector('.col-label  .active-filter-icon')?.classList.toggle('active', activeLabelFilter !== null);
    document.querySelector('.col-author .active-filter-icon')?.classList.toggle('active', activeAuthorFilters.length > 0);
    document.querySelector('.col-kader  .active-filter-icon')?.classList.toggle('active', activeKaderFilters.length  > 0);
    document.querySelector('.col-status .active-filter-icon')?.classList.toggle('active', statusFilterActive());
}

/* =========================================================
   FILTER DROPDOWNS
========================================================= */

function closeAllFilters() {
    document.querySelectorAll('.play-filter-dropdown').forEach(el => el.classList.remove('open'));
}
window.closeAllFilters = closeAllFilters;

function positionFilterDropdown(dropdown, target) {
    const rect  = target.getBoundingClientRect();
    const viewW = window.innerWidth;
    const top   = rect.bottom + 4;

    // Measure actual dropdown width while hidden
    dropdown.style.visibility = 'hidden';
    dropdown.style.display    = 'block';
    const dropW = dropdown.offsetWidth;
    dropdown.style.display    = '';
    dropdown.style.visibility = '';

    // Align left by default; flip to right-align if it would overflow
    if (rect.left + dropW > viewW - 8) {
        dropdown.style.left  = 'auto';
        dropdown.style.right = `${viewW - rect.right}px`;
    } else {
        dropdown.style.left  = `${rect.left}px`;
        dropdown.style.right = 'auto';
    }
    dropdown.style.top = `${top}px`;
}

function initDropdownProtection() {
    document.addEventListener('click', e => {
        if (e.target.closest('.play-filter-dropdown') || e.target.closest('.filterable')) return;
        closeAllFilters();
    });
}

/* ── Label filter ──────────────────────────────────────── */

function toggleLabelFilter(event) {
    const dropdown = document.getElementById('label-filter-dropdown');
    if (dropdown.classList.contains('open')) { dropdown.classList.remove('open'); return; }
    closeAllFilters();
    renderLabelFilterDropdown();
    positionFilterDropdown(dropdown, event.currentTarget);
    dropdown.classList.add('open');
}

function renderLabelFilterDropdown() {
    const dropdown = document.getElementById('label-filter-dropdown');
    const labels = getAllLabels();
    dropdown.innerHTML = `
        <div class="filter-clear">
            <div class="filter-clear-left" onclick="event.stopPropagation(); clearLabelFilter()"><b>${gettext('All')}</b></div>
            <button class="filter-close-btn" onclick="event.stopPropagation(); closeAllFilters()" type="button"><x-icon name="xmark" size="1em"></x-icon></button>
        </div>
        <div class="filter-options-list">
        ${labels.map(label => `
            <div class="filter-option" onclick="event.stopPropagation(); setLabelFilter(${label.id})">
                <span style="background:${label.color}22;color:${label.color};border:1px solid ${label.color}55;
                      border-radius:4px;padding:1px 7px;font-size:11px;font-weight:500;">${label.name}</span>
                ${activeLabelFilter === label.id ? window.icon('square-check') : window.icon('square')}
            </div>
        `).join('')}
        </div>`;
}

window.setLabelFilter = function(labelId) {
    activeLabelFilter = activeLabelFilter === labelId ? null : labelId;
    applyFilters();
    renderLabelFilterDropdown();
};
window.clearLabelFilter = function() { activeLabelFilter = null; applyFilters(); closeAllFilters(); };

/* ── Author filter ─────────────────────────────────────── */

function toggleAuthorFilter(event) {
    const dropdown = document.getElementById('author-filter-dropdown');
    if (dropdown.classList.contains('open')) { dropdown.classList.remove('open'); return; }
    closeAllFilters();
    renderAuthorFilterDropdown();
    positionFilterDropdown(dropdown, event.currentTarget);
    dropdown.classList.add('open');
}

function renderAuthorFilterDropdown() {
    const dropdown = document.getElementById('author-filter-dropdown');
    dropdown.innerHTML = `
        <div class="filter-clear">
            <div class="filter-clear-left" onclick="event.stopPropagation(); clearAuthorFilters()"><b>${gettext('All')}</b></div>
            <button class="filter-close-btn" onclick="event.stopPropagation(); closeAllFilters()" type="button"><x-icon name="xmark" size="1em"></x-icon></button>
        </div>
        <div class="filter-options-list">
        ${getAllAuthors().map(author => `
            <div class="filter-option" onclick="event.stopPropagation(); toggleAuthorSelection('${author.replace(/'/g, "\\'")}')">
                ${author}
                ${activeAuthorFilters.includes(author) ? window.icon('square-check') : window.icon('square')}
            </div>
        `).join('')}
        </div>`;
}

window.toggleAuthorSelection = function(author) {
    activeAuthorFilters = activeAuthorFilters.includes(author)
        ? activeAuthorFilters.filter(a => a !== author)
        : [...activeAuthorFilters, author];
    applyFilters();
    renderAuthorFilterDropdown();
};
window.clearAuthorFilters = function() { activeAuthorFilters = []; applyFilters(); closeAllFilters(); };

/* ── Kader filter ──────────────────────────────────────── */

function toggleKaderFilter(event) {
    const dropdown = document.getElementById('kader-filter-dropdown');
    if (dropdown.classList.contains('open')) { dropdown.classList.remove('open'); return; }
    closeAllFilters();
    renderKaderFilterDropdown();
    positionFilterDropdown(dropdown, event.currentTarget);
    dropdown.classList.add('open');
}

function renderKaderFilterDropdown() {
    const dropdown = document.getElementById('kader-filter-dropdown');
    const allKader = getAllKader();
    const ordered  = activeTeamName
        ? [activeTeamName, ...allKader.filter(k => k !== activeTeamName)]
        : allKader;
    dropdown.innerHTML = `
        <div class="filter-clear">
            <div class="filter-clear-left" onclick="event.stopPropagation(); clearKaderFilters()"><b>${gettext('All')}</b></div>
            <button class="filter-close-btn" onclick="event.stopPropagation(); closeAllFilters()" type="button"><x-icon name="xmark" size="1em"></x-icon></button>
        </div>
        <div class="filter-options-list">
        ${ordered.map(kader => `
            <div class="filter-option" onclick="event.stopPropagation(); toggleKaderSelection('${kader.replace(/'/g, "\\'")}')">
                <span class="${kader === activeTeamName ? 'user-active-team' : ''}">${kader}</span>
                ${activeKaderFilters.includes(kader) ? window.icon('square-check') : window.icon('square')}
            </div>
        `).join('')}
        </div>`;
}

window.toggleKaderSelection = function(kader) {
    activeKaderFilters = activeKaderFilters.includes(kader)
        ? activeKaderFilters.filter(k => k !== kader)
        : [...activeKaderFilters, kader];
    applyFilters();
    renderKaderFilterDropdown();
};
window.clearKaderFilters = function() { activeKaderFilters = []; applyFilters(); closeAllFilters(); };

/* ── Status filter ─────────────────────────────────────── */

function toggleStatusFilter(event) {
    const dropdown = document.getElementById('status-filter-dropdown');
    if (dropdown.classList.contains('open')) { dropdown.classList.remove('open'); return; }
    closeAllFilters();
    renderStatusFilterDropdown();
    positionFilterDropdown(dropdown, event.currentTarget);
    dropdown.classList.add('open');
}

function renderStatusFilterDropdown() {
    const dropdown = document.getElementById('status-filter-dropdown');
    dropdown.innerHTML = `
        <div class="filter-clear">
            <div class="filter-clear-left" onclick="event.stopPropagation(); clearStatusFilters()"><b>${gettext('All')}</b></div>
            <button class="filter-close-btn" onclick="event.stopPropagation(); closeAllFilters()" type="button"><x-icon name="xmark" size="1em"></x-icon></button>
        </div>
        <div class="filter-options-list">
        ${Object.values(STATUS).map(s => `
            <div class="filter-option" onclick="event.stopPropagation(); toggleStatusSelection('${s.key}')">
                <span style="color:${s.color};font-weight:600;">${s.label}</span>
                ${activeStatusFilters.includes(s.key) ? window.icon('square-check') : window.icon('square')}
            </div>
        `).join('')}
        </div>`;
}

window.toggleStatusSelection = function(label) {
    activeStatusFilters = activeStatusFilters.includes(label)
        ? activeStatusFilters.filter(s => s !== label)
        : [...activeStatusFilters, label];
    applyFilters();
    renderStatusFilterDropdown();
};
window.clearStatusFilters = function() { activeStatusFilters = []; applyFilters(); closeAllFilters(); };

/* ── Filter data helpers ───────────────────────────────── */

function getAllLabels() {
    return allFiles
        .filter(f => f.team_name === activeTeamName)
        .map(f => f.label).filter(Boolean)
        .filter((l, i, self) => i === self.findIndex(x => x.id === l.id))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getAllAuthors() {
    return [...new Set(allFiles.map(f => (f.author || '').trim()).filter(Boolean))].sort();
}

function getAllKader() {
    return [...new Set(allFiles.map(f => (f.team_name || '').trim()).filter(Boolean))].sort();
}

/* =========================================================
   DESKTOP TABLE ROWS
========================================================= */

function renderTable() {
    const tbody = document.getElementById('play-tbody');
    tbody.innerHTML = '';

    if (filteredFiles.length === 0) {
        const colCount = 6 + (multiTeam ? 1 : 0) - (infinityMode() ? 1 : 0);
        const tr = document.createElement('tr');
        tr.className = 'play-empty-row';
        tr.innerHTML = `<td colspan="${colCount}">${gettext('No projects found.')}</td>`;
        tbody.appendChild(tr);
        return;
    }

    filteredFiles.forEach(f => {
        if (f.synthetic) {
            const tr = document.createElement('tr');
            tr.className = 'play-generated-row';
            // Columns match the infinity-mode header: name, label, done,
            // author, [team], date. Status and control-pair counts are omitted.
            const kaderCell = multiTeam
                ? `<td class="user-active-team">${f.team_name || '—'}</td>`
                : '';
            tr.innerHTML = `
                <td class="play-name-cell play-generated-name">${f.name}</td>
                <td></td>
                <td class="play-cp-cell play-infinity-done-cell">${infinityDoneText(f.infinite_done)}</td>
                <td>${f.author}</td>
                ${kaderCell}
                <td>—</td>`;
            tr.addEventListener('click', () => openFile(f));
            tbody.appendChild(tr);
            return;
        }

        const tr = document.createElement('tr');
        tr.dataset.id = f.id;
        if (multiTeam && f.team_name !== activeTeamName) tr.classList.add('play-other-team');

        const labelHtml = f.label
            ? `<span style="background:${f.label.color}22;color:${f.label.color};
                border:1px solid ${f.label.color}55;border-radius:4px;
                padding:1px 7px;font-size:11px;font-weight:500;white-space:nowrap;">
                ${f.label.name}</span>`
            : '';

        const kaderCell = multiTeam
            ? `<td class="${f.team_name === activeTeamName ? 'user-active-team' : ''}">${f.team_name || '—'}</td>`
            : '';

        const st = fileStatus(f);
        const statusCell = infinityMode()
            ? ''
            : `<td class="col-status-cell" style="color:${st.color};font-weight:600;">${st.label}</td>`;
        const cpCell = infinityMode()
            ? `<td class="play-cp-cell play-infinity-done-cell">${infinityDoneText(f.infinite_done)}</td>`
            : `<td class="play-cp-cell">${f.cp_count}</td>`;
        tr.innerHTML = `
            <td class="play-name-cell">${f.name}</td>
            <td>${labelHtml}</td>
            ${statusCell}
            ${cpCell}
            <td>${f.author || '—'}</td>
            ${kaderCell}
            <td>${formatDate(f.last_edited)}</td>`;

        tr.addEventListener('click', () => openFile(f));
        tbody.appendChild(tr);
    });
}

/* =========================================================
   MOBILE CARDS
========================================================= */

function renderCards() {
    const wrap = document.getElementById('play-cards');
    wrap.innerHTML = '';

    if (filteredFiles.length === 0) {
        const msg = document.createElement('div');
        msg.className = 'play-empty-card';
        msg.textContent = gettext('No projects found.');
        wrap.appendChild(msg);
        return;
    }

    filteredFiles.forEach(f => {
        if (f.synthetic) {
            const card = document.createElement('div');
            card.className = 'play-card play-generated-card';
            const kaderHtml = multiTeam && f.team_name
                ? `<span class="user-active-team">${f.team_name}</span>
                   <span class="play-card-sep">·</span>`
                : '';
            card.innerHTML = `
                <div class="play-card-row1">
                    <span class="play-card-name">${f.name}</span>
                </div>
                <div class="play-card-row2">
                    ${kaderHtml}
                    <span>${f.author}</span>
                </div>`;
            card.addEventListener('click', () => openFile(f));
            wrap.appendChild(card);
            return;
        }

        const card = document.createElement('div');
        card.className = 'play-card' + (multiTeam && f.team_name !== activeTeamName ? ' play-other-team' : '');
        const st = fileStatus(f);
        if (!infinityMode()) {
            // Smoother gradient: two intermediate stops so the fall-off is gradual,
            // and the colour reaches the dark base only at 100% rather than 65%.
            card.style.background =
                `linear-gradient(to left,
                    rgba(${st.rgb},0.45) 0%,
                    rgba(${st.rgb},0.25) 35%,
                    rgba(${st.rgb},0.08) 75%,
                    rgba(${st.rgb},0)    100%), #1a1a1a`;
            card.style.color = '#fff';
        }

        const labelHtml = f.label
            ? `<span style="background:${f.label.color}22;color:${f.label.color};
                border:1px solid ${f.label.color}55;border-radius:3px;
                padding:1px 5px;font-size:10px;font-weight:500;white-space:nowrap;">
                ${f.label.name}</span>
               <span class="play-card-sep">|</span>`
            : '';

        const kaderHtml = multiTeam && f.team_name
            ? `<span class="${f.team_name === activeTeamName ? 'user-active-team' : ''}">${f.team_name}</span>
               <span class="play-card-sep">·</span>`
            : '';

        const cpSpan = infinityMode()
            ? `<span class="play-card-cp">${infinityDoneText(f.infinite_done)}</span>`
            : `<span class="play-card-cp">${f.cp_count} ${f.cp_count === 1 ? gettext('Control') : gettext('Controls')}</span>`;
        card.innerHTML = `
            <div class="play-card-row1">
                <span class="play-card-name">${f.name}</span>
                ${cpSpan}
            </div>
            <div class="play-card-row2">
                ${labelHtml}
                ${kaderHtml}
                <span>${f.author || '—'}</span>
                <span class="play-card-date">${formatDate(f.last_edited)}</span>
            </div>`;

        card.addEventListener('click', () => openFile(f));
        wrap.appendChild(card);
    });
}

/* =========================================================
   MOBILE SORT / FILTER CONTROLS
========================================================= */

function renderMobileControls() {
    const bar = document.getElementById('play-mobile-controls');
    bar.innerHTML = '';

    // ── Row 1: sort buttons ───────────────────────────────
    const sortRow = document.createElement('div');
    sortRow.className = 'play-ctrl-row';

    const sortFields = [
        { key: 'name',        label: gettext('Name')     },
        ...(infinityMode() ? [] : [{ key: 'cp_count', label: gettext('Controls') }]),
        { key: 'last_edited', label: gettext('Date')     },
    ];
    sortFields.forEach(({ key, label }) => {
        const btn   = document.createElement('button');
        const arrow = sortState.key === key ? (sortState.dir === -1 ? ' ↓' : ' ↑') : '';
        btn.className   = 'play-ctrl-btn' + (sortState.key === key ? ' active' : '');
        btn.textContent = label + arrow;
        btn.addEventListener('click', () => setSort(key));
        sortRow.appendChild(btn);
    });
    bar.appendChild(sortRow);

    // ── Row 2: filter buttons ─────────────────────────────
    const filterRow = document.createElement('div');
    filterRow.className = 'play-ctrl-row';

    const filterFields = [
        { field: 'label',  label: gettext('Label'),  toggle: toggleLabelFilter  },
        { field: 'author', label: gettext('Author'), toggle: toggleAuthorFilter },
        ...(infinityMode()
            ? []
            : [{ field: 'status', label: gettext('Status'), toggle: toggleStatusFilter }]),
        ...(multiTeam
            ? [{ field: 'kader', label: gettext('Team'), toggle: toggleKaderFilter }]
            : []),
    ];
    filterFields.forEach(({ field, label, toggle }) => {
        const active = field === 'label'  ? activeLabelFilter !== null
                     : field === 'author' ? activeAuthorFilters.length > 0
                     : field === 'status' ? activeStatusFilters.length > 0
                     :                     activeKaderFilters.length  > 0;
        const btn = document.createElement('button');
        btn.className = 'play-ctrl-btn' + (active ? ' active' : '');
        btn.innerHTML = `${window.icon('filter', '0.8em')} ${label}`;
        btn.addEventListener('click', e => { e.stopPropagation(); toggle(e); });
        filterRow.appendChild(btn);
    });
    bar.appendChild(filterRow);
}

/* =========================================================
   NAVIGATION
========================================================= */

function openFile(f) {
    if (f.synthetic) {
        // "Generated maps" → procedurally-generated infinite play (no mask).
        window.location.href = INFINITY_URL;
        return;
    }
    if (infinityMode()) {
        // Launch infinite play on this map's mask (server-built navgraph).
        window.location.href = `/play/${f.id}/infinity/`;
        return;
    }
    window.location.href = `/play/${f.id}/${playMode}/`;
}

/* =========================================================
   UTILS
========================================================= */

function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function infinityDoneText(count) {
    return `${Math.max(0, Number(count) || 0)} ${gettext('done')}`;
}
