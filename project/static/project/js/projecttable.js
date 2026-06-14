import { FileTable } from './file_table.js';
const icon = (...args) => window.icon(...args);

/* =========================================================
    STATE
========================================================= */

const table = new FileTable(document.getElementById('file-tbody'));
window._fileTable = table;

let activeLabelFilter = null;
let activeAuthorFilters = [];
let activeTeamFilters = [];
let sortState = { key: "last_edited", dir: -1 };

/* =========================================================
    INIT
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    initButtons();
    initProjectTitle();
    initSearch();
    initMenus();
    initModal();
    initDropdownProtection();
    openFileModal();
});

/* =========================================================
    FILE MODAL
========================================================= */

window.openFileModal = openFileModal;
window.refreshFileTable = async function() {
    await loadFiles();
    applyFilters();
};
window.showTableLoading = showTableLoading;
window.hideTableLoading = hideTableLoading;
async function openFileModal() {
    document.getElementById("modal-project").classList.add("open");
    resetProjectTitleInput();
    showTableLoading();
    try {
        await loadFiles();
        sortState = { key: null, dir: 1 };
        applyFilters();
        renderAfterLoad();
    } catch (err) {
        console.error(err);
    } finally {
        hideTableLoading();
    }
}

function showTableLoading() {
    document.getElementById("file-thead").innerHTML = "";
    document.getElementById("file-tbody").innerHTML = "";
    document.getElementById("file-table").style.visibility = "hidden";
    document.getElementById("file-table-loading").style.display = "flex";
}

function hideTableLoading() {
    document.getElementById("file-table-loading").style.display = "none";
    document.getElementById("file-table").style.visibility = "visible";
}

function renderAfterLoad() {
    renderTableHeader();
    table.setFiles(filteredFiles);
    renderCards();
    renderMobileControls();
    updateSortIndicators();
    updateFilterIcons();
    updateClearButton?.();
}

function getTableConfig(files) {
    return { showTeamColumn: (files || []).some(f => f.team_shared_pool) };
}

/* =========================================================
    TABLE HEADER
========================================================= */

function renderTableHeader() {
    const thead = document.getElementById("file-thead");
    const { showTeamColumn } = getTableConfig(projectFiles);

    thead.innerHTML = `
        <tr>
            <th class="col-publish"></th>
            <th class="col-name" data-sort="name">
                <span class="sortable">Projekt <span id="sort-name" class="sort-indicator"></span></span>
            </th>
            <th class="col-label">
                <span class="filterable" id="label-filter-btn">Label
                    <span class="filter-indicator active-filter-icon">${icon("filter", "0.8em")}</span>
                </span>
            </th>
            <th class="col-cp" data-sort="cp_count" style="text-align:right;">
                <span class="sortable">Posten <span id="sort-cp_count" class="sort-indicator"></span></span>
            </th>
            <th class="col-author">
                <span class="filterable" id="author-filter-btn">Autor
                    <span class="filter-indicator active-filter-icon">${icon("filter", "0.8em")}</span>
                </span>
            </th>
            ${showTeamColumn ? `
            <th class="col-team">
                <span class="filterable" id="team-filter-btn">Kader
                    <span class="filter-indicator active-filter-icon">${icon("filter", "0.8em")}</span>
                </span>
            </th>` : ''}
            <th class="col-history" style="text-align:center;">${icon("history")}</th>
            <th class="col-date" data-sort="last_edited">
                <span class="sortable">Geändert <span id="sort-last_edited" class="sort-indicator"></span></span>
            </th>
            <th class="col-actions"></th>
        </tr>
    `;

    document.getElementById("file-table").classList.toggle("hide-team-column", !showTeamColumn);
    attachHeaderEvents();
    updateSortIndicators();
    updateFilterIcons();
}

/* =========================================================
    HEADER EVENTS
========================================================= */

function attachHeaderEvents() {
    document.querySelectorAll("[data-sort]").forEach(el => {
        el.onclick = () => setSort(el.dataset.sort);
    });
    document.getElementById("label-filter-btn")?.addEventListener("click", toggleLabelFilter);
    document.getElementById("author-filter-btn")?.addEventListener("click", toggleAuthorFilter);
    document.getElementById("team-filter-btn")?.addEventListener("click", toggleTeamFilter);
}

/* =========================================================
    SORTING
========================================================= */

function setSort(key) {
    if (sortState.key === key) sortState.dir *= -1;
    else { sortState.key = key; sortState.dir = -1; }
    applyFilters();
}

function applySorting(data) {
    const { key, dir } = sortState;

    const sortGroup = arr => {
        if (!key) return arr;
        return [...arr].sort((a, b) => {
            const get = f => {
                switch (key) {
                    case "name":        return (f.name || "").toLowerCase();
                    case "cp_count":    return f.cp_count || 0;
                    case "last_edited": return new Date(f.last_edited || 0).getTime();
                    default: return "";
                }
            };
            const va = get(a), vb = get(b);
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
    };

    // Own team always comes first; each group sorted independently
    const own   = data.filter(f => f.can_edit);
    const other = data.filter(f => !f.can_edit);
    return [...sortGroup(own), ...sortGroup(other)];
}

function getSortIcon(k) {
    if (sortState.key !== k) return "";
    const isDesc = (k === "name") ? (sortState.dir === 1) : (sortState.dir === -1);
    const arrow = isDesc ? "↓" : "↑";
    return `<span class="sort-icon-box active">${arrow}</span>`;
}

function updateSortIndicators() {
    ["name", "cp_count", "last_edited"].forEach(k => {
        const el = document.getElementById(`sort-${k}`);
        if (el) el.innerHTML = getSortIcon(k);
    });
}

/* =========================================================
    FILTERING
========================================================= */

function applyFilters() {
    const search = document.getElementById("project-search").value.toLowerCase();
    filteredFiles = projectFiles.filter(f => {
        const matchesSearch =
            (f.name || "").toLowerCase().includes(search) ||
            (f.author || "").toLowerCase().includes(search) ||
            (f.label?.name || "").toLowerCase().includes(search);
        const matchesLabel = !activeLabelFilter || f.label?.id === activeLabelFilter;
        const matchesAuthor = activeAuthorFilters.length === 0 || activeAuthorFilters.includes((f.author || "").trim());
        const matchesTeam = activeTeamFilters.length === 0 || activeTeamFilters.includes((f.team_name || "").trim());
        return matchesSearch && matchesLabel && matchesAuthor && matchesTeam;
    });
    filteredFiles = applySorting(filteredFiles);
    table.setFiles(filteredFiles);
    renderCards();
    renderMobileControls();
    updateFilterIcons();
    updateClearButton();
    updateSortIndicators();
}

/* =========================================================
    LABEL FILTER
========================================================= */

function toggleLabelFilter(event) {
    const dropdown = document.getElementById("label-filter-dropdown");
    if (dropdown.classList.contains("open")) { dropdown.classList.remove("open"); return; }
    closeAllFilters();
    renderLabelFilterDropdown();
    positionFilterDropdown(dropdown, event.currentTarget);
    dropdown.classList.add("open");
}

function renderLabelFilterDropdown() {
    const dropdown = document.getElementById("label-filter-dropdown");
    dropdown.innerHTML = `
        <div class="filter-clear">
            <div class="filter-clear-left" onclick="event.stopPropagation(); clearLabelFilter()"><b>Alle</b></div>
            <button class="filter-close-btn" onclick="event.stopPropagation(); closeAllFilters()" type="button">✕</button>
        </div>
        <div class="filter-options-list">
            ${getAllLabels().map(label => `
                <div class="filter-option" onclick="event.stopPropagation(); setLabelFilter(${label.id})">
                    ${label.name}
                    ${activeLabelFilter === label.id ? icon("square-check") : icon("square")}
                </div>
            `).join('')}
        </div>
    `;
}

window.setLabelFilter = function(labelId) {
    activeLabelFilter = activeLabelFilter === labelId ? null : labelId;
    applyFilters(); renderLabelFilterDropdown();
};
window.clearLabelFilter = function() { activeLabelFilter = null; applyFilters(); closeAllFilters(); };

/* =========================================================
    AUTHOR FILTER
========================================================= */

function toggleAuthorFilter(event) {
    const dropdown = document.getElementById("author-filter-dropdown");
    if (dropdown.classList.contains("open")) { dropdown.classList.remove("open"); return; }
    closeAllFilters();
    renderAuthorFilterDropdown();
    positionFilterDropdown(dropdown, event.currentTarget);
    dropdown.classList.add("open");
}

function renderAuthorFilterDropdown() {
    const dropdown = document.getElementById("author-filter-dropdown");
    dropdown.innerHTML = `
        <div class="filter-clear">
            <div class="filter-clear-left" onclick="event.stopPropagation(); clearAuthorFilters()"><b>Alle</b></div>
            <button class="filter-close-btn" onclick="event.stopPropagation(); closeAllFilters()" type="button">✕</button>
        </div>
        <div class="filter-options-list">
            ${getAllAuthors().map(author => `
                <div class="filter-option" onclick="event.stopPropagation(); toggleAuthorSelection('${author.replace(/'/g, "\\'")}')">
                    ${author}
                    ${activeAuthorFilters.includes(author) ? icon("square-check") : icon("square")}
                </div>
            `).join('')}
        </div>
    `;
}

window.toggleAuthorSelection = function(author) {
    activeAuthorFilters = activeAuthorFilters.includes(author)
        ? activeAuthorFilters.filter(a => a !== author)
        : [...activeAuthorFilters, author];
    applyFilters(); renderAuthorFilterDropdown();
};
window.clearAuthorFilters = function() { activeAuthorFilters = []; applyFilters(); closeAllFilters(); };

/* =========================================================
    TEAM FILTER
========================================================= */

function toggleTeamFilter(event) {
    const dropdown = document.getElementById("team-filter-dropdown");
    if (dropdown.classList.contains("open")) { dropdown.classList.remove("open"); return; }
    closeAllFilters();
    renderTeamFilterDropdown();
    positionFilterDropdown(dropdown, event.currentTarget);
    dropdown.classList.add("open");
}

function renderTeamFilterDropdown() {
    const dropdown = document.getElementById("team-filter-dropdown");
    const allTeams = getAllTeams();
    const userTeam = window.activeTeam;
    const orderedTeams = userTeam ? [userTeam, ...allTeams.filter(t => t !== userTeam)] : allTeams;
    dropdown.innerHTML = `
        <div class="filter-clear">
            <div class="filter-clear-left" onclick="event.stopPropagation(); clearTeamFilters()"><b>Alle</b></div>
            <button class="filter-close-btn" onclick="event.stopPropagation(); closeAllFilters()" type="button">✕</button>
        </div>
        <div class="filter-options-list">
            ${orderedTeams.map(team => `
                <div class="filter-option" onclick="event.stopPropagation(); toggleTeamSelection('${team.replace(/'/g, "\\'")}')">
                    <span class="${team === userTeam ? 'user-active-team' : ''}">${team}</span>
                    ${activeTeamFilters.includes(team) ? icon("square-check") : icon("square")}
                </div>
            `).join('')}
        </div>
    `;
}

window.toggleTeamSelection = function(team) {
    activeTeamFilters = activeTeamFilters.includes(team)
        ? activeTeamFilters.filter(t => t !== team)
        : [...activeTeamFilters, team];
    applyFilters(); renderTeamFilterDropdown();
};
window.clearTeamFilters = function() { activeTeamFilters = []; applyFilters(); closeAllFilters(); };

/* =========================================================
    FILTER HELPERS
========================================================= */

function getAllTeams() {
    return [...new Set(projectFiles.filter(f => f.team_name).map(f => f.team_name))].sort();
}

function getAllLabels() {
    return projectFiles
        .filter(f => f.can_edit)
        .map(f => f.label).filter(Boolean)
        .filter((label, i, self) => i === self.findIndex(l => l.id === label.id))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getAllAuthors() {
    return [...new Set(projectFiles.map(f => (f.author || "").trim()).filter(Boolean))].sort();
}

function updateFilterIcons() {
    document.querySelector(".col-author .active-filter-icon")?.classList.toggle("active", activeAuthorFilters.length > 0);
    document.querySelector(".col-label .active-filter-icon")?.classList.toggle("active", !!activeLabelFilter);
    document.querySelector(".col-team .active-filter-icon")?.classList.toggle("active", activeTeamFilters.length > 0);
}

function closeAllFilters() {
    document.querySelectorAll(".table-filter-dropdown").forEach(el => el.classList.remove("open"));
}
window.closeAllFilters = closeAllFilters;

function positionFilterDropdown(dropdown, target) {
    const rect = target.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
}

/* =========================================================
    SEARCH
========================================================= */

function initSearch() {
    const input = document.getElementById("project-search");
    input.addEventListener("input", applyFilters);
    input.addEventListener("input", updateClearButton);
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            input.blur();
        }
    });
    updateClearButton();
}

function clearSearch() {
    document.getElementById("project-search").value = "";
    activeLabelFilter = null;
    activeAuthorFilters = [];
    activeTeamFilters = [];
    sortState = { key: "last_edited", dir: -1 };
    applyFilters();
}

function updateClearButton() {
    const input = document.getElementById("project-search");
    const clearBtn = document.querySelector(".search-clear");
    const hasSearch = !!input.value.trim();
    const hasFilters = activeLabelFilter !== null || activeAuthorFilters.length > 0 || activeTeamFilters.length > 0;
    clearBtn.style.display = (hasSearch || hasFilters) ? "flex" : "none";
}

/* =========================================================
    MODAL
========================================================= */

function initModal() {
    const modalProject = document.getElementById("modal-project");
    modalProject.addEventListener("click", (e) => { if (e.target === modalProject) closeFileModal(); });

    const modalMap = document.getElementById("modal-map");
    modalMap.addEventListener("click", (e) => { if (e.target === modalMap) closeMapModal(); });
}

/* =========================================================
    BUTTONS
========================================================= */

function initButtons() {
    document.getElementById("menu-project")?.addEventListener("click", openFileModal);
    document.getElementById("nav-open-projects")?.addEventListener("click", openFileModal);
    document.getElementById("nav-copy-project")?.addEventListener("click", duplicateFile);
    document.getElementById("nav-save-project")?.addEventListener("click", saveFile);
    document.getElementById("new-project-btn")?.addEventListener("click", createFileWithTitle);
    document.getElementById("label-manage-btn")?.addEventListener("click", toggleLabelDropdown);
    document.getElementById("clear-search-btn")?.addEventListener("click", clearSearch);
    document.getElementById("label-dropdown-btn")?.addEventListener("click", toggleLabelDropdown);
    document.getElementById("close-map-modal-btn")?.addEventListener("click", closeMapModal);
    document.getElementById("browse-map-btn")?.addEventListener("click", () => document.getElementById("map-file-input")?.click());
    document.getElementById("ocad-upload-btn")?.addEventListener("click", uploadSelectedMap);
}

/* =========================================================
    MOBILE CARDS
========================================================= */

function renderCards() {
    const wrap = document.getElementById('file-cards');
    if (!wrap) return;
    wrap.innerHTML = '';

    if (filteredFiles.length === 0) {
        const msg = document.createElement('div');
        msg.className = 'file-card-empty';
        msg.textContent = 'Keine Projekte gefunden.';
        wrap.appendChild(msg);
        return;
    }

    const { showTeamColumn } = getTableConfig(projectFiles);

    filteredFiles.forEach(f => {
        const card = document.createElement('div');
        card.className = 'file-card' + (!f.can_edit ? ' file-card-foreign' : '');

        if (f.published) {
            card.style.background =
                `linear-gradient(to right,
                    rgba(255,140,0,0.35) 0%,
                    rgba(255,140,0,0.15) 40%,
                    rgba(255,140,0,0.04) 75%,
                    rgba(255,140,0,0)    100%), #1a1a1a`;
        }

        const publishBtn = f.can_edit && !f.is_locked
            ? `<button class="file-card-publish ${f.published ? 'file-card-publish-active' : ''}"
                       title="${f.published ? 'Veröffentlichung aufheben' : 'Veröffentlichen'}"
                       data-file-id="${f.id}">${icon("globe", "1em")}</button>`
            : (f.published
                ? `<span class="file-card-publish file-card-publish-active file-card-publish-disabled">${icon("globe", "1em")}</span>`
                : '');

        const labelHtml = f.label
            ? `<span style="background:${f.label.color}22;color:${f.label.color};
                border:1px solid ${f.label.color}55;border-radius:3px;
                padding:1px 5px;font-size:10px;font-weight:500;white-space:nowrap;">
                ${f.label.name}</span>
               <span class="file-card-sep">|</span>`
            : '';

        const teamHtml = showTeamColumn && f.team_name
            ? `<span>${f.team_name}</span>
               <span class="file-card-sep">·</span>`
            : '';

        const lockHtml = f.is_locked
            ? `<span class="file-card-lock" title="${f.locked_by_name || ''} bearbeitet gerade">${icon("lock", "0.9em")}</span>
               <span class="file-card-sep">·</span>`
            : '';

        card.innerHTML = `
            <div class="file-card-row1">
                ${publishBtn}
                <span class="file-card-name">${f.name}</span>
                <span class="file-card-cp">${f.cp_count} Posten</span>
            </div>
            <div class="file-card-row2">
                ${lockHtml}
                ${labelHtml}
                ${teamHtml}
                <span>${f.author || '—'}</span>
                <span class="file-card-date">${formatCardDate(f.last_edited)}</span>
            </div>`;

        const pubEl = card.querySelector('.file-card-publish[data-file-id]');
        if (pubEl) {
            pubEl.addEventListener('click', async (e) => {
                e.stopPropagation();
                const res  = await fetch(`/editor/publish/${f.id}/`, {
                    method: 'POST',
                    headers: { 'X-CSRFToken': getCSRFToken() }
                });
                const data = await res.json();
                if (!res.ok) {
                    await showModal({ message: data.message || 'Fehler beim Veröffentlichen.' });
                    return;
                }
                f.published = data.published;
                if (f.id === project?.id) {
                    if (data.published) window.setReadOnly?.(true, null, 'published');
                    else                window.setReadOnly?.(false);
                }
                renderCards();
                table.setFiles(filteredFiles);
            });
        }

        card.addEventListener('click', () => table.openFile(f.id));
        wrap.appendChild(card);
    });
}

function formatCardDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('de-CH', {
        day: '2-digit', month: '2-digit', year: '2-digit'
    });
}

/* =========================================================
    MOBILE SORT / FILTER CONTROLS
========================================================= */

function renderMobileControls() {
    const bar = document.getElementById('file-mobile-controls');
    if (!bar) return;
    bar.innerHTML = '';

    const sortRow = document.createElement('div');
    sortRow.className = 'file-ctrl-row';

    const sortFields = [
        { key: 'name',        label: 'Name'   },
        { key: 'cp_count',    label: 'Posten' },
        { key: 'last_edited', label: 'Datum'  },
    ];
    sortFields.forEach(({ key, label }) => {
        const btn   = document.createElement('button');
        const arrow = sortState.key === key ? (sortState.dir === -1 ? ' ↓' : ' ↑') : '';
        btn.className   = 'file-ctrl-btn' + (sortState.key === key ? ' active' : '');
        btn.textContent = label + arrow;
        btn.addEventListener('click', () => setSort(key));
        sortRow.appendChild(btn);
    });
    bar.appendChild(sortRow);

    const filterRow = document.createElement('div');
    filterRow.className = 'file-ctrl-row';

    const { showTeamColumn } = getTableConfig(projectFiles);

    const filterFields = [
        { field: 'label',  label: 'Label',  toggle: toggleLabelFilter  },
        { field: 'author', label: 'Autor',  toggle: toggleAuthorFilter },
        ...(showTeamColumn
            ? [{ field: 'team', label: 'Kader', toggle: toggleTeamFilter }]
            : []),
    ];
    filterFields.forEach(({ field, label, toggle }) => {
        const active = field === 'label'  ? activeLabelFilter !== null
                     : field === 'author' ? activeAuthorFilters.length > 0
                     :                      activeTeamFilters.length > 0;
        const btn = document.createElement('button');
        btn.className = 'file-ctrl-btn' + (active ? ' active' : '');
        btn.innerHTML = `${icon('filter', '0.8em')} ${label}`;
        btn.addEventListener('click', e => { e.stopPropagation(); toggle(e); });
        filterRow.appendChild(btn);
    });
    bar.appendChild(filterRow);
}

/* =========================================================
    LABEL MANAGEMENT
========================================================= */

const LABEL_COLORS = [
    '#c2824a',  // center
    '#c2a24a', '#7ac24a', '#5baa7a', '#4abac2', '#5b8db8', '#8a5bc2',  // ring
];

function labelChipStyle(color) {
    return `background:${color}22;color:${color};border:1px solid ${color}55;
            border-radius:4px;padding:2px 8px;font-size:12px;font-weight:500;white-space:nowrap;`;
}

function toggleLabelDropdown() {
    const existing = document.getElementById("label-manage-dropdown");
    if (existing) { existing.remove(); return; }
    renderLabelManageDropdown();
}

function renderLabelManageDropdown() {
    document.getElementById("label-manage-dropdown")?.remove();

    const btn    = document.getElementById("label-manage-btn");
    const labels = window.allLabels || [];
    const csrf   = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";

    const drop = document.createElement("div");
    drop.id = "label-manage-dropdown";
    drop.style.cssText = `
        position:fixed;z-index:10001;background:#1a1a1a;border:1px solid #333;
        border-radius:6px;min-width:260px;max-height:320px;overflow-y:auto;
        box-shadow:0 4px 16px #0008;padding:6px 0;
    `;

    // Position below the button
    const rect = btn.getBoundingClientRect();
    drop.style.top  = `${rect.bottom + 4}px`;
    drop.style.left = `${rect.left}px`;

    function closePickers() {
        document.querySelectorAll(".label-color-picker").forEach(p => p.remove());
        document.querySelectorAll("button[data-pal-btn]").forEach(b => { b._pickerOpen = false; });
    }

    function buildRows() {
        drop.innerHTML = "";
        closePickers();

        // ── Label rows ──────────────────────────────────────
        (window.allLabels || []).forEach(label => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 12px;";

            // Draggable chip (natural width — not stretched)
            const chip = document.createElement("span");
            chip.textContent = label.name;
            chip.style.cssText = labelChipStyle(label.color) + "font-size:13px;cursor:grab;";
            chip.draggable = true;
            chip.addEventListener("dragstart", e => {
                window._draggedLabel = label;
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("text/plain", label.name);
            });
            chip.addEventListener("dragend", () => { window._draggedLabel = null; });
            row.appendChild(chip);

            // Spacer pushes palette + delete to the right
            const spacer = document.createElement("span");
            spacer.style.flex = "1";
            row.appendChild(spacer);

            // ── Palette button + picker ─────────────────────
            const palBtn = document.createElement("button");
            palBtn.dataset.palBtn = "";
            palBtn.style.cssText = "background:none;border:none;cursor:pointer;padding:2px;color:#666;display:flex;align-items:center;";
            palBtn.innerHTML = icon("palette", "13px");
            palBtn.title = "Farbe wählen";

            palBtn.addEventListener("click", e => {
                e.stopPropagation();
                if (palBtn._pickerOpen) { closePickers(); return; }
                closePickers();

                // Regular hexagon honeycomb geometry (pointy-top, side = S px)
                const S       = 14;
                const W       = S * Math.sqrt(3);  // hex width ≈ 24.25
                const H       = 2 * S;             // hex height = 28
                const hexPath = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';
                const CW = 82, CH = 76;            // container size
                const cx = CW / 2, cy = CH / 2;   // container centre

                // 6 neighbour offsets (right → lower-right → lower-left → left → upper-left → upper-right)
                const offsets = [
                    [ W,     0      ],
                    [ W/2,   H*3/4  ],
                    [-W/2,   H*3/4  ],
                    [-W,     0      ],
                    [-W/2,  -H*3/4  ],
                    [ W/2,  -H*3/4  ],
                ];

                const picker = document.createElement("div");
                picker.className = "label-color-picker";
                picker.style.cssText = `
                    position:fixed;background:#1c1c1c;
                    clip-path:polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%);
                    z-index:10002;width:${CW}px;height:${CH}px;
                `;
                const r = palBtn.getBoundingClientRect();
                picker.style.top  = `${r.bottom + 4}px`;
                picker.style.left = `${Math.round(r.left + r.width / 2 - CW / 2)}px`;

                // Draw ring first so the centre hex renders on top
                const drawOrder = [...LABEL_COLORS.keys()].filter(i => i !== 0).concat(0);
                drawOrder.forEach(i => {
                    const c = LABEL_COLORS[i];
                    const [dx, dy] = i === 0 ? [0, 0] : offsets[i - 1];
                    const lx = cx + dx - W / 2;
                    const ty = cy + dy - H / 2;
                    const isSelected = c === label.color;
                    if (isSelected) {
                        const ring = document.createElement("div");
                        ring.style.cssText = `position:absolute;
                            width:${W + 4}px;height:${H + 4}px;
                            left:${Math.round(lx - 2)}px;top:${Math.round(ty - 2)}px;`;
                        picker.appendChild(ring);
                    }
                    const sw = document.createElement("div");
                    sw.style.cssText = `position:absolute;
                        width:${W}px;height:${H}px;
                        left:${Math.round(lx)}px;top:${Math.round(ty)}px;
                        clip-path:${hexPath};background:${c};cursor:pointer;
                        transition:transform 0.1s;`;
                    sw.addEventListener("mouseenter", () => { sw.style.transform = "scale(1.18)"; });
                    sw.addEventListener("mouseleave", () => { sw.style.transform = ""; });
                    sw.addEventListener("click", () => {
                        label.color = c;
                        projectFiles.forEach(f => { if (f.label?.id === label.id) f.label.color = c; });
                        closePickers();
                        buildRows();
                        applyFilters();
                        fetch(`/editor/labels/${label.id}/color/`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
                            body: JSON.stringify({ color: c }),
                        }).catch(err => console.warn('Color save failed:', err));
                    });
                    picker.appendChild(sw);
                });

                palBtn._pickerOpen = true;
                document.body.appendChild(picker);
                setTimeout(() => {
                    document.addEventListener("click", function h(ev) {
                        if (!picker.contains(ev.target)) {
                            picker.remove();
                            palBtn._pickerOpen = false;
                            document.removeEventListener("click", h);
                        }
                    });
                }, 0);
            });
            row.appendChild(palBtn);

            // ── Delete button ───────────────────────────────
            const delBtn = document.createElement("button");
            delBtn.style.cssText = "background:none;border:none;cursor:pointer;padding:2px;color:#666;display:flex;align-items:center;";
            delBtn.innerHTML = icon("trash", "12px");
            delBtn.title = "Label löschen";
            delBtn.addEventListener("click", () => {
                // Optimistic: remove immediately
                window.allLabels = (window.allLabels || []).filter(l => l.id !== label.id);
                projectFiles.forEach(f => { if (f.label?.id === label.id) f.label = null; });
                buildRows();
                applyFilters();
                // Fire & forget
                fetch(`/editor/labels/${label.id}/delete/`, {
                    method: 'POST', headers: { 'X-CSRFToken': csrf },
                }).catch(err => console.warn('Delete failed:', err));
            });
            row.appendChild(delBtn);
            drop.appendChild(row);
        });

        // ── Divider ─────────────────────────────────────────
        if ((window.allLabels || []).length) {
            const div = document.createElement("div");
            div.style.cssText = "border-top:1px solid #2a2a2a;margin:4px 0;";
            drop.appendChild(div);
        }

        // ── Add new label ────────────────────────────────────
        const addRow = document.createElement("div");
        addRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 12px;";

        const inp = document.createElement("input");
        inp.type        = "text";
        inp.maxLength   = 25;
        inp.placeholder = "Neues Label…";
        inp.style.cssText = `flex:1;background:#2a2a2a;border:1px solid #3a3a3a;border-radius:4px;
            color:#ccc;font-size:13px;padding:4px 8px;min-height:32px;outline:none;`;

        const addBtn = document.createElement("button");
        addBtn.textContent = "+";
        addBtn.style.cssText = `display:flex;align-items:center;justify-content:center;width:32px;height:32px;
            flex-shrink:0;background:#2a2a2a;border:1px solid #444;color:#999;border-radius:4px;
            font-size:16px;cursor:pointer;font-weight:bold;`;

        async function doCreate() {
            const name = inp.value.trim();
            if (!name) return;
            if ((window.allLabels || []).some(l => l.name.toLowerCase() === name.toLowerCase())) {
                inp.style.borderColor = "#c0392b";
                setTimeout(() => { inp.style.borderColor = "#3a3a3a"; }, 1200);
                return;
            }
            // Optimistic: add temp label immediately
            const tempId    = `_tmp_${Date.now()}`;
            const tempLabel = { id: tempId, name, color: '#5b8db8' };
            window.allLabels = [...(window.allLabels || []), tempLabel];
            inp.value = "";
            buildRows();
            // Confirm with server
            try {
                const res  = await fetch('/editor/labels/create/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
                    body: JSON.stringify({ name }),
                });
                const data = await res.json();
                if (res.ok && data.id) {
                    // Replace temp entry with real one
                    window.allLabels = (window.allLabels || []).map(l => l.id === tempId ? data : l);
                } else {
                    // Revert
                    window.allLabels = (window.allLabels || []).filter(l => l.id !== tempId);
                    inp.value = name;
                    inp.style.borderColor = "#c0392b";
                    setTimeout(() => { inp.style.borderColor = "#3a3a3a"; }, 1200);
                }
            } catch (err) {
                window.allLabels = (window.allLabels || []).filter(l => l.id !== tempId);
                console.warn('Create label failed:', err);
            }
            buildRows();
        }

        addBtn.addEventListener("click", doCreate);
        inp.addEventListener("keydown", e => { if (e.key === "Enter") doCreate(); });

        addRow.appendChild(inp);
        addRow.appendChild(addBtn);
        drop.appendChild(addRow);
    }

    buildRows();
    document.body.appendChild(drop);

    // Close when clicking outside
    // Note: e.target.isConnected guards against buildRows() clearing innerHTML
    // before the click bubbles to document — without this, the dropdown closes
    // on create/delete because the clicked button is removed from the DOM first.
    setTimeout(() => {
        document.addEventListener("click", function handler(e) {
            if (!e.target.isConnected) return;
            if (!drop.contains(e.target) && e.target !== btn
                    && !e.target.closest(".label-color-picker")) {
                drop.remove();
                closePickers();
                document.removeEventListener("click", handler);
            }
        });
    }, 0);
}

window.removeLabelFromFile = function(fileId) {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
    const file = projectFiles.find(f => f.id === fileId);
    if (!file) return;
    file.label = null;
    applyFilters();
    fetch(`/editor/files/${fileId}/label/`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
        body:    JSON.stringify({ label_id: null }),
    }).catch(err => console.warn('Remove label failed:', err));
};

window.assignLabelToFile = function(fileId, label) {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
    // Optimistic: update the in-memory file entry immediately
    const file = projectFiles.find(f => f.id === fileId);
    if (!file) return;
    file.label = { id: label.id, name: label.name, color: label.color };
    applyFilters();
    // Fire & forget
    fetch(`/editor/files/${fileId}/label/`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
        body:    JSON.stringify({ label_id: label.id }),
    }).catch(err => console.warn('Assign label failed:', err));
};

/* =========================================================
    DROPDOWN PROTECTION
========================================================= */

function initDropdownProtection() {
    document.addEventListener("click", (e) => {
        if (e.target.closest(".table-filter-dropdown") || e.target.closest(".filterable")) return;
        closeAllFilters();
    });
}

/* =========================================================
    PROJECT TITLE
========================================================= */

function initProjectTitle() {
    const input = document.getElementById("project-title-input");
    if (!input) return;
    // Input is solely for naming a new project — not synced to the current open file
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") createFileWithTitle();
    });
}

function resetProjectTitleInput() {
    const input = document.getElementById("project-title-input");
    if (input) { input.value = ""; input.focus(); }
}

async function createFileWithTitle() {
    const input = document.getElementById("project-title-input");
    const name  = input?.value.trim() ?? "";

    // ── Validate ────────────────────────────────────────────
    const markError = msg => {
        if (input) {
            input.classList.add("input-error");
            input.title = msg;
            setTimeout(() => { input.classList.remove("input-error"); input.title = ""; }, 1500);
        }
    };

    if (!name) { markError("Bitte einen Projektnamen eingeben."); input?.focus(); return; }

    const duplicate = (projectFiles || []).some(f => f.name === name);
    if (duplicate) { markError("Ein Projekt mit diesem Namen existiert bereits."); input?.focus(); return; }

    // ── Reset project state — server save happens after map is scaled ──
    project.id            = null;   // assigned on first real save (after scaling)
    project.name          = name;
    project.scale         = null;
    project.scaled        = false;
    project.map_file      = "";
    project.has_mask      = false;
    project.blocked_terrain = null;
    project.control_pairs = [];
    window.detachMaskGenerationUi?.();

    // Leftover state from previously opened files is cleared on map upload

    // ── Proceed to map upload ────────────────────────────────
    createFile();
}
