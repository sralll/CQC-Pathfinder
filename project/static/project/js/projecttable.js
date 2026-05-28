import { FileTable } from './file_table.js';

const table =
    new FileTable(
        document.getElementById('file-tbody')
    );

let activeLabelFilter = null;
let activeAuthorFilters = [];
let activeTeamFilters = [];
let sortState = {
    key: null,
    dir: 1
};

/* =========================================================
    OPEN FILE MODAL
========================================================= */

async function openFileModal() {
    document
        .getElementById("modal-project")
        .classList.add("open");

    // hide table + show spinner
    showTableLoading();

    try {

        // fetch files
        await loadFiles();

        // render AFTER fetch
        renderAfterLoad();

    } catch (err) {

        console.error(err);

    } finally {

        // show table
        hideTableLoading();
    }
};

document.addEventListener("DOMContentLoaded", () => {
    initButtons();
    initProjectTitle();
    initSearch();
    initMenus();
    initModal();
    initDropdownProtection();

    openFileModal();
});

function showTableLoading() {

    const table =
        document.getElementById("file-table");

    const loading =
        document.getElementById("file-table-loading");

    document.getElementById("file-thead").innerHTML = "";
    document.getElementById("file-tbody").innerHTML = "";

    table.style.visibility = "hidden";
    loading.style.display = "flex";
}

function hideTableLoading() {

    document
        .getElementById("file-table-loading")
        .style.display = "none";

    document
        .getElementById("file-table")
        .style.visibility = "visible";
}


function renderAfterLoad() {

    renderTableHeader();
    table.setFiles(filteredFiles);

    updateSortIndicators();
    updateFilterIcons();
    updateClearButton?.();
}

function getTableConfig(projectFiles) {

    return {
        showTeamColumn: (projectFiles || []).some(f => f.team_shared_pool)
    };
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
                <span class="sortable">
                    Projekt
                    <span id="sort-name" class="sort-indicator"></span>
                </span>
            </th>

            <th class="col-label">
                <span class="filterable" id="label-filter-btn">
                    Label
                    <span class="filter-indicator">
                        <i class="fa-solid fa-filter active-filter-icon"></i>
                    </span>
                </span>
            </th>

            <th class="col-cp" data-sort="cp_count" style="text-align:center;">
                <span class="sortable">
                    Posten
                    <span id="sort-cp_count" class="sort-indicator"></span>
                </span>
            </th>

            <th class="col-author">
                <span class="filterable" id="author-filter-btn">
                    Autor
                    <span class="filter-indicator">
                        <i class="fa-solid fa-filter active-filter-icon"></i>
                    </span>
                </span>
            </th>

            ${showTeamColumn ? `
                <th class="col-team">
                    <span class="filterable" id="team-filter-btn">
                        Kader
                        <span class="filter-indicator">
                            <i class="fa-solid fa-filter active-filter-icon"></i>
                        </span>
                    </span>
                </th>
            ` : ""}

            <th class="col-history" style="text-align:center;">
                <i class="fa-solid fa-clock-rotate-left"></i>
            </th>

            <th class="col-date" data-sort="last_edited">
                <span class="sortable">
                    Geändert
                    <span id="sort-last_edited" class="sort-indicator"></span>
                </span>
            </th>

            <th class="col-actions"></th>

        </tr>
    `;

    const table = document.getElementById("file-table");

    table.classList.toggle("hide-team-column", !showTeamColumn);

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

    document.getElementById("label-filter-btn")
        ?.addEventListener("click", toggleLabelFilter);

    document.getElementById("author-filter-btn")
        ?.addEventListener("click", toggleAuthorFilter);

    const teamBtn = document.getElementById("team-filter-btn");
    if (teamBtn) {
        teamBtn.addEventListener("click", toggleTeamFilter);
    }
}

/* =========================================================
    SORTING
========================================================= */

function setSort(key) {

    if (sortState.key === key) {

        sortState.dir *= -1;

    } else {

        sortState.key = key;
        sortState.dir = -1;
    }

    applyFilters();
}

function applySorting(data) {

    const { key, dir } = sortState;

    if (!key) return data;

    return [...data].sort((a, b) => {

        const get = (f) => {

            switch (key) {

                case "name":
                    return (f.name || "").toLowerCase();

                case "cp_count":
                    return f.cp_count || 0;

                case "last_edited":
                    return new Date(
                        f.last_edited || 0
                    ).getTime();

                default:
                    return "";
            }
        };

        const va = get(a);
        const vb = get(b);

        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;

        return 0;
    });
}

function getSortIcon(k) {

    const isNameColumn = (k === "name");

    const dir = sortState.dir;

    if (sortState.key !== k) return "";

    // date behaves normally
    if (isNameColumn) {

        return dir === 1
            ? '<span class="sort-icon-box"><i class="fa-solid fa-chevron-down"></i></span>'
            : '<span class="sort-icon-box"><i class="fa-solid fa-chevron-up"></i></span>';
    }

    // other columns inverted
    return dir === -1
        ? '<span class="sort-icon-box"><i class="fa-solid fa-chevron-down"></i></span>'
        : '<span class="sort-icon-box"><i class="fa-solid fa-chevron-up"></i></span>';
}
function updateSortIndicators() {

    const keys = [
        "name",
        "cp_count",
        "last_edited"
    ];

    keys.forEach(k => {

        const el = document.getElementById(`sort-${k}`);

        if (!el) return;

        el.innerHTML = getSortIcon(k);
    });
}

/* =========================================================
    FILTERING
========================================================= */

function applyFilters() {

    const search =
        document
            .getElementById("project-search")
            .value
            .toLowerCase();

    filteredFiles =
        projectFiles.filter(f => {

            const matchesSearch =
                (f.name || "")
                    .toLowerCase()
                    .includes(search)

                ||

                (f.author || "")
                    .toLowerCase()
                    .includes(search)

                ||

                (f.label?.name || "")
                    .toLowerCase()
                    .includes(search);

            const matchesLabel =
                !activeLabelFilter
                ||
                f.label?.id === activeLabelFilter;

            const matchesAuthor =
                activeAuthorFilters.length === 0
                ||
                activeAuthorFilters.includes(
                    (f.author || "").trim()
                );

            const matchesTeam =
                activeTeamFilters.length === 0 ||
                activeTeamFilters.includes(
                    (f.team_name || "").trim()
                );

            return (
                matchesSearch
                &&
                matchesLabel
                &&
                matchesAuthor
                &&
                matchesTeam
            );
        });

    filteredFiles =
        applySorting(filteredFiles);

    table.setFiles(filteredFiles);

    updateFilterIcons();
    updateClearButton();
    updateSortIndicators();
}

window.closeAllFilters = function() {

    document
        .querySelectorAll(".table-filter-dropdown")
        .forEach(el =>
            el.classList.remove("open")
        );
}

/* =========================================================
    LABEL FILTER
========================================================= */

function toggleLabelFilter(event) {

    const dropdown =
        document.getElementById(
            "label-filter-dropdown"
        );

    if (
        dropdown.classList.contains("open")
    ) {

        dropdown.classList.remove("open");
        return;
    }

    closeAllFilters();

    renderLabelFilterDropdown();

    positionFilterDropdown(
        dropdown,
        event.currentTarget
    );

    dropdown.classList.add("open");
}

function renderLabelFilterDropdown() {

    const dropdown =
        document.getElementById(
            "label-filter-dropdown"
        );

    dropdown.innerHTML = `
            <div class="filter-clear">

                <div
                    class="filter-clear-left"
                    onclick="event.stopPropagation(); clearLabelFilter()">

                    <b>Alle</b>

                </div>

                <button
                    class="filter-close-btn"
                    onclick="event.stopPropagation(); closeAllFilters()"
                    type="button">

                    ✕

                </button>

            </div>

        ${getAllLabels().map(label => `
            <div class="filter-option"
                onclick="event.stopPropagation(); setLabelFilter(${label.id})">

                ${label.name}

                ${
                    activeLabelFilter === label.id
                        ? '<i class="fa-solid fa-square-check"></i>'
                        : '<i class="fa-regular fa-square"></i>'
                }

            </div>
        `).join('')}
    `;
}

window.setLabelFilter = function(labelId) {

    activeLabelFilter =
        activeLabelFilter === labelId
            ? null
            : labelId;

    applyFilters();
    renderLabelFilterDropdown();
};

window.clearLabelFilter = function() {

    activeLabelFilter = null;

    applyFilters();

    closeAllFilters();
};

/* =========================================================
    AUTHOR FILTER
========================================================= */

function toggleAuthorFilter(event) {

    const dropdown =
        document.getElementById(
            "author-filter-dropdown"
        );

    if (
        dropdown.classList.contains("open")
    ) {

        dropdown.classList.remove("open");
        return;
    }

    closeAllFilters();

    renderAuthorFilterDropdown();

    positionFilterDropdown(
        dropdown,
        event.currentTarget
    );

    dropdown.classList.add("open");
}

function renderAuthorFilterDropdown() {

    const dropdown =
        document.getElementById(
            "author-filter-dropdown"
        );

    dropdown.innerHTML = `
            <div class="filter-clear">

                <div
                    class="filter-clear-left"
                    onclick="event.stopPropagation(); clearAuthorFilters()">

                    <b>Alle</b>

                </div>

                <button
                    class="filter-close-btn"
                    onclick="event.stopPropagation(); closeAllFilters()"
                    type="button">

                    ✕

                </button>

            </div>

        ${getAllAuthors().map(author => `

            <div class="filter-option"
                onclick="event.stopPropagation(); toggleAuthorSelection('${author.replace(/'/g, "\\'")}')">

                ${author}

                ${
                    activeAuthorFilters.includes(author)
                        ? '<i class="fa-solid fa-square-check"></i>'
                        : '<i class="fa-regular fa-square"></i>'
                }

            </div>

        `).join('')}
    `;
}

window.toggleAuthorSelection = function(author) {

    if (
        activeAuthorFilters.includes(author)
    ) {

        activeAuthorFilters =
            activeAuthorFilters.filter(
                a => a !== author
            );

    } else {

        activeAuthorFilters.push(author);
    }

    applyFilters();

    renderAuthorFilterDropdown();
};

window.clearAuthorFilters = function() {

    activeAuthorFilters = [];

    applyFilters();

    closeAllFilters();
};

/* =========================================================
    TEAM FILTER
========================================================= */

function toggleTeamFilter(event) {

    const dropdown =
        document.getElementById(
            "team-filter-dropdown"
        );

    if (
        dropdown.classList.contains("open")
    ) {

        dropdown.classList.remove("open");
        return;
    }

    closeAllFilters();

    renderTeamFilterDropdown();

    positionFilterDropdown(
        dropdown,
        event.currentTarget
    );

    dropdown.classList.add("open");
}

function renderTeamFilterDropdown() {

    const dropdown =
        document.getElementById("team-filter-dropdown");

    const allTeams = getAllTeams();

    const userTeam = window.activeTeam;

    const otherTeams =
        allTeams.filter(t => t !== userTeam);

    const orderedTeams = userTeam
        ? [userTeam, ...otherTeams]
        : otherTeams;

    dropdown.innerHTML = `
        <div class="filter-clear">

            <div
                class="filter-clear-left"
                onclick="event.stopPropagation(); clearTeamFilters()">

                <b>Alle</b>

            </div>

            <button
                class="filter-close-btn"
                onclick="event.stopPropagation(); closeAllFilters()"
                type="button">

                ✕

            </button>

        </div>

        ${orderedTeams.map(team => {

            const isActiveFilter =
                activeTeamFilters.includes(team);

            const isUserTeam =
                team === userTeam;

            return `
                <div class="filter-option"
                    onclick="event.stopPropagation(); toggleTeamSelection('${team.replace(/'/g, "\\'")}')">

                    <span class="${isUserTeam ? 'user-active-team' : ''}">
                        ${team}
                    </span>

                    ${
                        isActiveFilter
                            ? '<i class="fa-solid fa-square-check"></i>'
                            : '<i class="fa-regular fa-square"></i>'
                    }

                </div>
            `;
        }).join('')}
    `;
}

window.toggleTeamSelection = function(team) {

    if (
        activeTeamFilters.includes(team)
    ) {

        activeTeamFilters =
            activeTeamFilters.filter(
                t => t !== team
            );

    } else {

        activeTeamFilters.push(team);
    }

    applyFilters();

    renderTeamFilterDropdown();
};

window.clearTeamFilters = function() {

    activeTeamFilters = [];

    applyFilters();

    closeAllFilters();
};

/* =========================================================
    FILTER HELPERS
========================================================= */

function getAllTeams() {
    return [...new Set(projectFiles
        .filter(f => f.team_name)
        .map(f => f.team_name)
    )].sort();
}

function getAllLabels() {

    return projectFiles
        .map(f => f.label)
        .filter(Boolean)
        .filter((label, index, self) =>
            index === self.findIndex(
                l => l.id === label.id
            )
        )
        .sort((a, b) =>
            a.name.localeCompare(b.name)
        );
}

function getAllAuthors() {

    return [...new Set(
        projectFiles
            .map(f =>
                (f.author || "").trim()
            )
            .filter(Boolean)
    )].sort();
}

function updateFilterIcons() {

    document
        .querySelector(".col-author .active-filter-icon")
        ?.classList.toggle(
            "active",
            activeAuthorFilters.length > 0
        );

    document
        .querySelector(".col-label .active-filter-icon")
        ?.classList.toggle(
            "active",
            !!activeLabelFilter
        );

    document
    .querySelector(".col-team .active-filter-icon")
    ?.classList.toggle(
        "active",
        activeTeamFilters.length > 0
    );
}

function closeAllFilters() {

    document
        .querySelectorAll(
            ".table-filter-dropdown"
        )
        .forEach(el =>
            el.classList.remove("open")
        );
}

function positionFilterDropdown(dropdown, target) {

    const rect =
        target.getBoundingClientRect();

    dropdown.style.left =
        `${rect.left}px`;

    dropdown.style.top =
        `${rect.bottom + 4}px`;
}

/* =========================================================
    SEARCH
========================================================= */

function initSearch() {

    const input =
        document.getElementById(
            "project-search"
        );

    input.addEventListener(
        "input",
        applyFilters
    );

    input.addEventListener(
        "input",
        updateClearButton
    );

    updateClearButton();
}

function clearSearch() {
    const input =
        document.getElementById(
            "project-search"
        );

    input.value = "";

    activeLabelFilter = null;
    activeAuthorFilters = [];
    activeTeamFilters = [];

    sortState = {
        key: null,
        dir: 1
    };

    applyFilters();
};

function updateClearButton() {

    const input =
        document.getElementById(
            "project-search"
        );

    const clearBtn =
        document.querySelector(
            ".search-clear"
        );

    const hasSearch =
        !!input.value.trim();

    const hasFilters =
        activeLabelFilter !== null
        ||
        activeAuthorFilters.length > 0
        ||
        activeTeamFilters.length > 0;

    clearBtn.style.display =
        (hasSearch || hasFilters)
            ? "block"
            : "none";
}

/* =========================================================
    MODAL
========================================================= */

function initModal() {

    const modalProject =
        document.getElementById(
            "modal-project"
        );

    modalProject.addEventListener(
        "click",
        (event) => {

            if (event.target === modalProject) {
                closeFileModal();
            }
        }
    );

    const modalMap =
        document.getElementById(
            "modal-map"
        );

    modalMap.addEventListener(
        "click",
        (event) => {

            if (event.target === modalMap) {
                closeMapModal();
            }
        }
    );
}

function initButtons() {

    // navbar
    document
        .getElementById("menu-project")
        ?.addEventListener("click", openFileModal);

    document
        .getElementById("nav-open-projects")
        ?.addEventListener("click", openFileModal);

    document
        .getElementById("nav-create-project")
        ?.addEventListener("click", createFile);

    document
        .getElementById("nav-copy-project")
        ?.addEventListener("click", copyFile);

    document
        .getElementById("nav-save-project")
        ?.addEventListener("click", saveFile);

    // toolbar
    document
        .getElementById("create-project-btn")
        ?.addEventListener("click", createFile);

    document
        .getElementById("save-project-btn")
        ?.addEventListener("click", saveFile);

    document
        .getElementById("clear-search-btn")
        ?.addEventListener("click", clearSearch);

    document
        .getElementById("label-dropdown-btn")
        ?.addEventListener("click", toggleLabelDropdown);

    document
        .getElementById("create-label-btn")
        ?.addEventListener("click", createLabel);

    // map modal
    document
        .getElementById("close-map-modal-btn")
        ?.addEventListener("click", closeMapModal);

    document
        .getElementById("browse-map-btn")
        ?.addEventListener("click", () => {

            document
                .getElementById("map-file-input")
                ?.click();
        });

    document
        .getElementById("upload-map-btn")
        ?.addEventListener("click", uploadSelectedMap);
}

function toggleLabelDropdown() {
    alert("Label Dropdown (noch nicht implementiert)");
}   


/* =========================================================
    DROPDOWN PROTECTION
========================================================= */

function initDropdownProtection() {

    document.addEventListener(
        "click",
        (e) => {

            if (
                e.target.closest(".table-filter-dropdown")
                ||
                e.target.closest(".filterable")
            ) {
                return;
            }

            closeAllFilters();
        }
    );
}

/* =========================================================
    PROJECT TITLE
========================================================= */

function initProjectTitle() {

    const input =
        document.getElementById(
            "project-title-input"
        );

    if (!input) return;

    input.value = project.name;

    input.addEventListener("input", () => {
        project.name = input.value;
        }
    );

    input.addEventListener("blur", () => {
            if (!input.value.trim()) {
                project.name = "Neues Projekt";
                input.value = project.name;
            }
        }
    );
}