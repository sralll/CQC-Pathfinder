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
let sortState = { key: null, dir: 1 };

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
            <th class="col-cp" data-sort="cp_count" style="text-align:center;">
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
    if (!key) return data;
    return [...data].sort((a, b) => {
        const get = f => {
            switch (key) {
                case "name": return (f.name || "").toLowerCase();
                case "cp_count": return f.cp_count || 0;
                case "last_edited": return new Date(f.last_edited || 0).getTime();
                default: return "";
            }
        };
        const va = get(a), vb = get(b);
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
    });
}

function getSortIcon(k) {
    if (sortState.key !== k) return "";
    const down = `<span class="sort-icon-box">${icon("chevron-down", "0.7em")}</span>`;
    const up   = `<span class="sort-icon-box">${icon("chevron-up",   "0.7em")}</span>`;
    return (k === "name") ? (sortState.dir === 1 ? down : up) : (sortState.dir === -1 ? down : up);
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
        ${getAllLabels().map(label => `
            <div class="filter-option" onclick="event.stopPropagation(); setLabelFilter(${label.id})">
                ${label.name}
                ${activeLabelFilter === label.id ? icon("square-check") : icon("square")}
            </div>
        `).join('')}
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
        ${getAllAuthors().map(author => `
            <div class="filter-option" onclick="event.stopPropagation(); toggleAuthorSelection('${author.replace(/'/g, "\\'")}')">
                ${author}
                ${activeAuthorFilters.includes(author) ? icon("square-check") : icon("square")}
            </div>
        `).join('')}
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
        ${orderedTeams.map(team => `
            <div class="filter-option" onclick="event.stopPropagation(); toggleTeamSelection('${team.replace(/'/g, "\\'")}')">
                <span class="${team === userTeam ? 'user-active-team' : ''}">${team}</span>
                ${activeTeamFilters.includes(team) ? icon("square-check") : icon("square")}
            </div>
        `).join('')}
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
    return projectFiles.map(f => f.label).filter(Boolean)
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
    updateClearButton();
}

function clearSearch() {
    document.getElementById("project-search").value = "";
    activeLabelFilter = null;
    activeAuthorFilters = [];
    activeTeamFilters = [];
    sortState = { key: null, dir: 1 };
    applyFilters();
}

function updateClearButton() {
    const input = document.getElementById("project-search");
    const clearBtn = document.querySelector(".search-clear");
    const hasSearch = !!input.value.trim();
    const hasFilters = activeLabelFilter !== null || activeAuthorFilters.length > 0 || activeTeamFilters.length > 0;
    clearBtn.style.display = (hasSearch || hasFilters) ? "block" : "none";
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
    document.getElementById("create-label-btn")?.addEventListener("click", createLabel);
    document.getElementById("close-map-modal-btn")?.addEventListener("click", closeMapModal);
    document.getElementById("browse-map-btn")?.addEventListener("click", () => document.getElementById("map-file-input")?.click());
    document.getElementById("upload-map-btn")?.addEventListener("click", uploadSelectedMap);
}

/* =========================================================
    LABEL MANAGEMENT
========================================================= */

const LABEL_COLORS = [
    '#5b8db8', '#5baa7a', '#c2824a', '#8a5bc2', '#c2a24a',
    '#4abac2', '#c24a7a', '#6b82c2', '#7ac24a', '#c24ab8',
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
        position:fixed;z-index:9999;background:#1a1a1a;border:1px solid #333;
        border-radius:6px;min-width:260px;box-shadow:0 4px 16px #0008;
        padding:6px 0;
    `;

    // Position below the button
    const rect = btn.getBoundingClientRect();
    drop.style.top  = `${rect.bottom + 4}px`;
    drop.style.left = `${rect.left}px`;

    function closePickers() {
        document.querySelectorAll(".label-color-picker").forEach(p => p.remove());
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
            palBtn.style.cssText = "background:none;border:none;cursor:pointer;padding:2px;color:#666;display:flex;align-items:center;";
            palBtn.innerHTML = icon("palette", "13px");
            palBtn.title = "Farbe wählen";

            palBtn.addEventListener("click", e => {
                e.stopPropagation();
                closePickers();

                const picker = document.createElement("div");
                picker.className = "label-color-picker";
                picker.style.cssText = `
                    position:fixed;background:#222;border:1px solid #444;
                    border-radius:6px;padding:6px;z-index:10000;
                    display:flex;gap:4px;flex-wrap:wrap;width:134px;
                `;
                const r = palBtn.getBoundingClientRect();
                picker.style.top  = `${r.bottom + 4}px`;
                picker.style.left = `${r.left - 50}px`;

                LABEL_COLORS.forEach(c => {
                    const sw = document.createElement("div");
                    sw.style.cssText = `width:20px;height:20px;border-radius:4px;background:${c};cursor:pointer;
                        border:2px solid ${c === label.color ? '#fff' : 'transparent'};`;
                    sw.addEventListener("click", () => {
                        // Optimistic: update immediately
                        label.color = c;
                        projectFiles.forEach(f => { if (f.label?.id === label.id) f.label.color = c; });
                        closePickers();
                        buildRows();
                        applyFilters();
                        // Fire & forget
                        fetch(`/editor/labels/${label.id}/color/`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
                            body: JSON.stringify({ color: c }),
                        }).catch(err => console.warn('Color save failed:', err));
                    });
                    picker.appendChild(sw);
                });

                document.body.appendChild(picker);
                setTimeout(() => {
                    document.addEventListener("click", function h(ev) {
                        if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener("click", h); }
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
        addRow.style.cssText = "display:flex;align-items:stretch;gap:6px;padding:5px 12px;";

        const inp = document.createElement("input");
        inp.type        = "text";
        inp.maxLength   = 25;
        inp.placeholder = "Neues Label…";
        inp.style.cssText = `flex:1;background:#2a2a2a;border:1px solid #3a3a3a;border-radius:4px;
            color:#ccc;font-size:12px;padding:0 7px;outline:none;`;

        const addBtn = document.createElement("button");
        addBtn.textContent = "+";
        addBtn.style.cssText = `background:#2b2b2b;border:1px solid #444;color:#5baa7a;border-radius:4px;
            padding:0 9px;font-size:15px;cursor:pointer;font-weight:bold;line-height:1;`;

        async function doCreate() {
            const name = inp.value.trim();
            if (!name) return;
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

    // ── Pre-create on server to reserve an ID ──────────────
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
    let newId;
    try {
        const res  = await fetch("/editor/save/", {
            method:  "POST",
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
            body:    JSON.stringify({
                id: null, last_edited: null, name,
                scale: null, scaled: false, map_file: "",
                has_mask: false, blocked_terrain: null, control_pairs: [],
            }),
        });
        const data = await res.json();
        if (!res.ok || !data.id) { markError("Serverfehler beim Erstellen."); return; }
        newId = data.id;
    } catch (e) {
        console.error("createFileWithTitle:", e);
        markError("Verbindungsfehler."); return;
    }

    // ── Reset project state with the new ID ─────────────────
    project.id            = newId;
    project.name          = name;
    project.scale         = null;
    project.scaled        = false;
    project.map_file      = "";
    project.has_mask      = false;
    project.blocked_terrain = null;
    project.control_pairs = [];
    if (typeof window.updateFilenameInput === 'function') window.updateFilenameInput();

    // ── Proceed to map upload ────────────────────────────────
    createFile();
}