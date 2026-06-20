/* =========================================================
   RESULTS OVERVIEW — file list with completion counts
   Same filter/sort structure as the play listing (results.js),
   plus a "Resultate" column showing how many users completed
   every control pair in the file.
========================================================= */

/* =========================================================
   STATE
========================================================= */

let allFiles        = [];
let filteredFiles   = [];
let sharedPool      = false;
let multiTeam       = false;
let activeTeamName  = '';

let activeLabelFilter   = null;
let activeAuthorFilters = [];
let activeKaderFilters  = [];
let sortState = { key: 'last_edited', dir: -1 };

/* =========================================================
   INIT
========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    initSearch();
    initDropdownProtection();
    await loadFiles();
});

async function loadFiles() {
    document.getElementById('play-loading').style.display = '';
    try {
        const res  = await fetch('/results/get-list/');
        const data = await res.json();
        allFiles       = data.files            || [];
        sharedPool     = data.shared_pool      || false;
        multiTeam      = data.multi_team       || false;
        activeTeamName = data.active_team_name || '';
        renderHeader();
        applyFilters();
    } catch (e) {
        console.error('loadFiles failed:', e);
    } finally {
        document.getElementById('play-loading').style.display = 'none';
    }
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
    const input   = document.getElementById('play-search');
    const clearBtn = document.getElementById('play-search-clear');
    const hasSearch  = !!input.value.trim();
    const hasFilters = activeLabelFilter !== null
        || activeAuthorFilters.length > 0
        || activeKaderFilters.length  > 0;
    clearBtn.classList.toggle('visible', hasSearch || hasFilters);
}

function clearSearch() {
    document.getElementById('play-search').value = '';
    activeLabelFilter   = null;
    activeAuthorFilters = [];
    activeKaderFilters  = [];
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
        const matchSearch =
            (f.name   || '').toLowerCase().includes(search) ||
            (f.author || '').toLowerCase().includes(search) ||
            (f.label?.name || '').toLowerCase().includes(search);
        const matchLabel  = !activeLabelFilter  || f.label?.id === activeLabelFilter;
        const matchAuthor = !activeAuthorFilters.length || activeAuthorFilters.includes((f.author || '').trim());
        const matchKader  = !activeKaderFilters.length  || activeKaderFilters.includes((f.team_name || '').trim());
        return matchSearch && matchLabel && matchAuthor && matchKader;
    });

    filteredFiles = applySorting(filteredFiles);

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
                    case 'name':           return (f.name || '').toLowerCase();
                    case 'cp_count':       return f.cp_count       || 0;
                    case 'results_count':  return f.results_count  || 0;
                    case 'last_edited':    return new Date(f.last_edited || 0).getTime();
                    default: return '';
                }
            };
            const va = get(a), vb = get(b);
            const effectiveDir = key === 'name' ? -dir : dir;
            if (va < vb) return -1 * effectiveDir;
            if (va > vb) return  1 * effectiveDir;
            return 0;
        });
    };
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
    const thead   = document.getElementById('play-thead');
    const kaderCol = multiTeam
        ? `<th class="col-kader">
               <span class="filterable" id="kader-filter-btn">${gettext('Team')}
                   <span class="filter-indicator active-filter-icon">${window.icon('filter', '0.8em')}</span>
               </span>
           </th>`
        : '';

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
            <th class="col-results" data-sort="results_count" style="text-align:center;">
                <span class="sortable">${gettext('Results')}
                    <span id="sort-results_count" class="sort-indicator"></span>
                </span>
            </th>
            <th class="col-cp" data-sort="cp_count" style="text-align:center;">
                <span class="sortable">${gettext('Controls')}
                    <span id="sort-cp_count" class="sort-indicator"></span>
                </span>
            </th>
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
    ['name', 'cp_count', 'results_count', 'last_edited'].forEach(k => {
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
    dropdown.style.visibility = 'hidden';
    dropdown.style.display    = 'block';
    const dropW = dropdown.offsetWidth;
    dropdown.style.display    = '';
    dropdown.style.visibility = '';
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
    dropdown.innerHTML = `
        <div class="filter-clear">
            <div class="filter-clear-left" onclick="event.stopPropagation(); clearLabelFilter()"><b>${gettext('All')}</b></div>
            <button class="filter-close-btn" onclick="event.stopPropagation(); closeAllFilters()" type="button"><x-icon name="xmark" size="1em"></x-icon></button>
        </div>
        <div class="filter-options-list">
        ${getAllLabels().map(label => `
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
    applyFilters(); renderLabelFilterDropdown();
};
window.clearLabelFilter = function() { activeLabelFilter = null; applyFilters(); closeAllFilters(); };

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
    applyFilters(); renderAuthorFilterDropdown();
};
window.clearAuthorFilters = function() { activeAuthorFilters = []; applyFilters(); closeAllFilters(); };

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
    const ordered  = activeTeamName
        ? [activeTeamName, ...getAllKader().filter(k => k !== activeTeamName)]
        : getAllKader();
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
    applyFilters(); renderKaderFilterDropdown();
};
window.clearKaderFilters = function() { activeKaderFilters = []; applyFilters(); closeAllFilters(); };

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
        const colCount = 6 + (multiTeam ? 1 : 0);
        const tr = document.createElement('tr');
        tr.className = 'play-empty-row';
        tr.innerHTML = `<td colspan="${colCount}">${gettext('No projects found.')}</td>`;
        tbody.appendChild(tr);
        return;
    }

    filteredFiles.forEach(f => {
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

        tr.innerHTML = `
            <td class="play-name-cell">${f.name}</td>
            <td>${labelHtml}</td>
            <td class="play-cp-cell">${f.results_count || 0}</td>
            <td class="play-cp-cell">${f.cp_count}</td>
            <td>${f.author || '—'}</td>
            ${kaderCell}
            <td>${formatDate(f.last_edited)}</td>`;

        tr.addEventListener('click', () => openFile(f.id));
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
        const card = document.createElement('div');
        card.className = 'play-card' + (multiTeam && f.team_name !== activeTeamName ? ' play-other-team' : '');

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

        const rc = f.results_count || 0;

        card.innerHTML = `
            <div class="play-card-row1">
                <span class="play-card-name">${f.name}</span>
                <span class="play-card-cp">${rc} ${rc === 1 ? gettext('result') : gettext('results')}</span>
            </div>
            <div class="play-card-row2">
                ${labelHtml}
                ${kaderHtml}
                <span>${f.author || '—'}</span>
                <span class="play-card-date">${formatDate(f.last_edited)}</span>
            </div>`;

        card.addEventListener('click', () => openFile(f.id));
        wrap.appendChild(card);
    });
}

/* =========================================================
   MOBILE SORT / FILTER CONTROLS
========================================================= */

function renderMobileControls() {
    const bar = document.getElementById('play-mobile-controls');
    bar.innerHTML = '';

    const sortRow = document.createElement('div');
    sortRow.className = 'play-ctrl-row';
    [
        { key: 'name',           label: gettext('Name')    },
        { key: 'results_count',  label: gettext('Results') },
        { key: 'cp_count',       label: gettext('Controls') },
        { key: 'last_edited',    label: gettext('Date') },
    ].forEach(({ key, label }) => {
        const btn   = document.createElement('button');
        const arrow = sortState.key === key ? (sortState.dir === -1 ? ' ↓' : ' ↑') : '';
        btn.className   = 'play-ctrl-btn' + (sortState.key === key ? ' active' : '');
        btn.textContent = label + arrow;
        btn.addEventListener('click', () => setSort(key));
        sortRow.appendChild(btn);
    });
    bar.appendChild(sortRow);

    const filterRow = document.createElement('div');
    filterRow.className = 'play-ctrl-row';
    [
        { field: 'label',  label: gettext('Label'),  toggle: toggleLabelFilter  },
        { field: 'author', label: gettext('Author'), toggle: toggleAuthorFilter },
        ...(multiTeam ? [{ field: 'kader', label: gettext('Team'), toggle: toggleKaderFilter }] : []),
    ].forEach(({ field, label, toggle }) => {
        const active = field === 'label'  ? activeLabelFilter !== null
                     : field === 'author' ? activeAuthorFilters.length > 0
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
   NAVIGATION  (click handling added later)
========================================================= */

function openFile(id) {
    window.location.href = `/results/${id}/`;
}

/* =========================================================
   UTILS
========================================================= */

function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
