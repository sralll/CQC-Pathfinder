import { FileTable } from './file_table.js';

/* =========================================================
    GLOBAL STATE
========================================================= */

let projectFiles = [];
let filteredFiles = [];
let filesLoadingPromise = null;

let currentProjectName = "Neues Projekt";
let openVersionsFileId = null;

let activeLabelFilter = null;
let activeAuthorFilters = [];
let activeTeamFilters = [];

let sortState = {
    key: null,
    dir: 1
};

const table =
    new FileTable(
        document.getElementById('file-tbody')
    );

/* =========================================================
    INIT
========================================================= */

document.addEventListener("DOMContentLoaded", async () => {

    initProjectTitle();
    initSearch();
    initMenus();
    initModal();
    initDropdownProtection();

    await loadFiles();

    renderAfterLoad(); 

    openFileModal();
});
/* =========================================================
    LOAD FILES
========================================================= */

async function loadFiles() {

    if (filesLoadingPromise) {
        return filesLoadingPromise;
    }

    filesLoadingPromise = (async () => {

        try {

            const res = await fetch('/editor/files/');
            const data = await res.json();

            window.activeTeam = data.active_team;
            projectFiles = data.files || [];
            filteredFiles = [...projectFiles];

        } catch (err) {

            console.error("Failed to load files:", err);

        } finally {
            filesLoadingPromise = null;
        }

    })();

    return filesLoadingPromise;
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
        <div class="filter-clear"
            onclick="clearLabelFilter()">
            <b>Alle</b>
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
        <div class="filter-clear"
            onclick="event.stopPropagation(); clearAuthorFilters()">

            <b>Alle</b>

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

    // remove it from list (avoid duplicates)
    const otherTeams = allTeams.filter(t => t !== userTeam);

    const orderedTeams = userTeam
        ? [userTeam, ...otherTeams]
        : otherTeams;

    dropdown.innerHTML = `
        <div class="filter-clear"
            onclick="event.stopPropagation(); clearTeamFilters()">

            <b>Alle</b>

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
    GET ALL TEAMS
========================================================= */

function getAllTeams() {
    return [...new Set(projectFiles
        .filter(f => f.team_name)
        .map(f => f.team_name)
    )].sort();
}

/* =========================================================
    FILTER HELPERS
========================================================= */

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

function positionFilterDropdown(
    dropdown,
    target
) {

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

window.clearSearch = function() {

    const input =
        document.getElementById(
            "project-search"
        );

    input.value = "";

    activeLabelFilter = null;
    activeAuthorFilters = [];
    activeTeamFilters = [];

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

    const modal =
        document.getElementById(
            "modal-project"
        );

    modal.addEventListener(
        "click",
        (event) => {

            if (event.target === modal) {
                closeFileModal();
            }
        }
    );
}

function openFileModal() {

    document
        .getElementById("modal-project")
        .classList.add("open");
}

function closeFileModal() {

    document
        .getElementById("modal-project")
        .classList.remove("open");
}

/* =========================================================
    MENUS
========================================================= */

function initMenus() {

    const menuItems =
        document.querySelectorAll(
            ".nav-menu-item"
        );

    menuItems.forEach(menu => {

        menu.addEventListener(
            "mouseenter",
            () => {

                menuItems.forEach(other => {

                    if (other !== menu) {
                        other.classList.remove("open");
                    }
                });

                menu.classList.add("open");
            }
        );

        menu.addEventListener(
            "mouseleave",
            () => {
                menu.classList.remove("open");
            }
        );
    });
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

    input.value = currentProjectName;

    input.addEventListener(
        "input",
        () => {

            currentProjectName =
                input.value;
        }
    );

    input.addEventListener(
        "blur",
        () => {

            if (
                !input.value.trim()
            ) {

                currentProjectName =
                    "Neues Projekt";

                input.value =
                    currentProjectName;
            }
        }
    );
}