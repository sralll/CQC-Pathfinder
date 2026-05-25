let projectFiles = [];
let filteredFiles = [];
let filesLoadingPromise = null;
let currentProjectName = "Neues Projekt";
let openVersionsFileId = null;

let activeLabelFilter = null;
let activeAuthorFilters = [];
let sortState = {
    key: null,
    dir: -1 // 1 = asc, -1 = desc
};

let filterState = {
    label: null,
    author: null
};

loadFiles(); openFileModal();

function toggleLabelFilter(event) {

    const dropdown = document.getElementById("label-filter-dropdown");

    // close if already open
    if (dropdown.classList.contains("open")) {
        dropdown.classList.remove("open");
        return;
    }

    closeAllFilters();

    dropdown.innerHTML = `
        <div class="filter-clear"
            onclick="clearLabelFilter()">
            <b>Alle</b>
        </div>
    ` + getAllLabels().map(label => `
        <div class="filter-option"
            onclick="setLabelFilter(${label.id})">

            ${label.name}

            ${
                activeLabelFilter === label.id
                    ? '<i class="fa-solid fa-square-check"></i>'
                    : '<i class="fa-regular fa-square"></i>'
            }
        </div>
    `).join('');

    positionFilterDropdown(dropdown, event.currentTarget);

    dropdown.classList.add("open");
}

function clearAuthorFilters() {
    activeAuthorFilters = [];
    applyFilters();
    closeAllFilters();
    updateFilterIcons();
    update();
}

function clearLabelFilter() {
    activeLabelFilter = null;
    applyFilters();
    closeAllFilters();
    updateFilterIcons();
    update();
}


function updateFilterIcons() {

    // AUTHOR
    document
        .querySelector(".col-author .active-filter-icon")
        ?.classList.toggle(
            "active",
            activeAuthorFilters.length > 0
        );

    // LABEL
    document
        .querySelector(".col-label .active-filter-icon")
        ?.classList.toggle(
            "active",
            !!activeLabelFilter
        );
}

function toggleAuthorFilter(event) {

    const dropdown = document.getElementById("author-filter-dropdown");

    // toggle only if already open on same button
    if (dropdown.classList.contains("open")) {
        dropdown.classList.remove("open");
        return;
    }

    closeAllFilters();

    dropdown.innerHTML = `
    <div class="filter-clear"
        onclick="clearAuthorFilters()">
        <b>Alle</b>
    </div>
    ` + getAllAuthors().map(author => `
        <div class="filter-option"
            onclick="toggleAuthorSelection('${author.replace(/'/g, "\\'")}')">

            ${author}

            ${
                activeAuthorFilters.includes(author)
                    ? '<i class="fa-solid fa-square-check"></i>'
                    : '<i class="fa-regular fa-square"></i>'
            }
        </div>
    `).join('');
    
    positionFilterDropdown(dropdown, event.currentTarget);

    dropdown.classList.add("open");
}

function toggleAuthorSelection(author) {

    if (activeAuthorFilters.includes(author)) {

        activeAuthorFilters =
            activeAuthorFilters.filter(a => a !== author);

    } else {

        activeAuthorFilters.push(author);
    }

    applyFilters();

    // rerender dropdown to update checkboxes
    const dropdown = document.getElementById("author-filter-dropdown");

    dropdown.innerHTML = `
        <div class="filter-clear"
            onclick="clearAuthorFilters()">
            <b>Alle</b>
        </div>
        ` + getAllAuthors().map(a => `
        <div class="filter-option"
            onclick="toggleAuthorSelection('${a}')">

            ${a}

            ${
                activeAuthorFilters.includes(a)
                    ? '<i class="fa-solid fa-square-check"></i>'
                    : '<i class="fa-regular fa-square"></i>'
            }
        </div>
    `).join('');
    updateFilterIcons();
    update();
}

function getAllLabels() {

    return projectFiles
        .map(f => f.label)
        .filter(Boolean)
        .filter((label, index, self) =>
            index === self.findIndex(l => l.id === label.id)
        )
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getAllAuthors() {

    return [...new Set(
        projectFiles
            .map(f => (f.author || "").trim())
            .filter(Boolean)
    )].sort();
}

function closeAllFilters() {

    document
        .querySelectorAll(".table-filter-dropdown")
        .forEach(el => el.classList.remove("open"));
    
    updateFilterIcons();
    update();
}

function positionFilterDropdown(dropdown, target) {

    const rect = target.getBoundingClientRect();

    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
}

function setLabelFilter(labelId) {

    activeLabelFilter =
        activeLabelFilter === labelId
            ? null
            : labelId;

    applyFilters();
    update();

    // rerender dropdown checkboxes
    const dropdown = document.getElementById("label-filter-dropdown");

    dropdown.innerHTML = `
        <div class="filter-clear"
            onclick="clearLabelFilter()">
            <b>Alle</b>
        </div>
    ` + getAllLabels().map(label => `
        <div class="filter-option"
            onclick="setLabelFilter(${label.id})">

            ${label.name}

            ${
                activeLabelFilter === label.id
                    ? '<i class="fa-solid fa-square-check"></i>'
                    : '<i class="fa-regular fa-square"></i>'
            }
        </div>
    `).join('');
}

document.addEventListener("click", (e) => {

    // clicked inside filter dropdown or filter button
    if (
        e.target.closest(".table-filter-dropdown") ||
        e.target.closest(".filterable")
    ) {
        return;
    }

    closeAllFilters();
});

document.querySelectorAll(".table-filter-dropdown")
    .forEach(dropdown => {

        dropdown.addEventListener("click", (e) => {
            e.stopPropagation();
        });

    });

function sortFiles(data) {
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
                    return new Date(f.last_edited || 0).getTime();

                case "author":
                    return (f.author || "").toLowerCase();

                default:
                    return 0;
            }
        };

        let va = get(a);
        let vb = get(b);

        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
    });
}

function setSort(key) {

    if (sortState.key === key) {
        sortState.dir *= -1; // toggle direction
    } else {
        sortState.key = key;
        sortState.dir = 1;
    }
    closeAllVersions();
    renderFiles();
}

function updateSortIndicators() {

    const keys = ["name", "cp_count", "last_edited", "author"];

    keys.forEach(k => {

        const el = document.getElementById(`sort-${k}`);
        if (!el) return;

        el.innerHTML =
            sortState.key === k
                ? (
                    sortState.dir === 1
                        ? '<span class="sort-icon-box"><i class="fa-solid fa-chevron-down"></i></span>'
                        : '<span class="sort-icon-box"><i class="fa-solid fa-chevron-up"></i></span>'
                )
                : "";
    });
}

function closeAllVersions() {
    openVersionsFileId = null;

    filteredFiles = filteredFiles.map(f => ({
        ...f,
        showVersions: false
    }));
}

function toggleMenu(id) {
    document.querySelectorAll('.nav-menu-item').forEach(el => {
        if (el.id !== id) el.classList.remove('open');
    });
    document.getElementById(id).classList.toggle('open');
}

function toggleTeamDropdown() {
    var d = document.getElementById('teamDropdown');
    d.style.display = d.style.display === 'block' ? 'none' : 'block';
}

document.addEventListener('click', function(e) {
    if (!e.target.closest('.nav-menu-item')) {
        document.querySelectorAll('.nav-menu-item').forEach(el => el.classList.remove('open'));
    }
    if (!e.target.closest('.team-btn') && !e.target.closest('#teamDropdown')) {
        var d = document.getElementById('teamDropdown');
        if (d) d.style.display = 'none';
    }
});

document.getElementById("project-search")
    .addEventListener("input", applyFilters);

function applyFilters() {

    const search =
        document
            .getElementById("project-search")
            .value
            .toLowerCase();

    filteredFiles = projectFiles.filter(f => {

        const matchesSearch =
            (f.name || "").toLowerCase().includes(search) ||
            (f.author || "").toLowerCase().includes(search) ||
            (f.label?.name || "").toLowerCase().includes(search);

        const matchesLabel =
            !activeLabelFilter ||
            f.label?.id === activeLabelFilter;

        const matchesAuthor =
            activeAuthorFilters.length === 0 ||
            activeAuthorFilters.includes(
                (f.author || "").trim()
            );

        return (
            matchesSearch &&
            matchesLabel &&
            matchesAuthor
        );
    });

    openVersionsFileId = null;

    renderFiles();
}

async function loadFiles() {

    // already loading → reuse same promise
    if (filesLoadingPromise) {
        return filesLoadingPromise;
    }

    filesLoadingPromise = (async () => {

        try {
            const res = await fetch('/editor/files/');
            const data = await res.json();

            projectFiles = data.files;
            filteredFiles = [...projectFiles];

        } catch (err) {
            console.error("Failed to load files:", err);
        } finally {

            // loading finished
            filesLoadingPromise = null;
        }

    })();

    return filesLoadingPromise;
}

const projectMenu = document.getElementById("menu-project");

projectMenu.addEventListener("click", () => {
    openFileModal();
});

const menuItems = document.querySelectorAll(".nav-menu-item");

menuItems.forEach(menu => {

    // Open hovered menu
    menu.addEventListener("mouseenter", () => {

        // Close all others
        menuItems.forEach(other => {
            if (other !== menu) {
                other.classList.remove("open");
            }
        });

        // Open current
        menu.classList.add("open");
    });

    // Close when mouse leaves
    menu.addEventListener("mouseleave", () => {
        menu.classList.remove("open");
    });

});


const modal = document.getElementById("modal-project");

modal.addEventListener("click", (event) => {

    if (event.target === modal) {
        closeFileModal();
    }
});

function lockTableWidths() {
    const table = document.getElementById("file-table");
    const cols = table.querySelectorAll("th");

    const widths = Array.from(cols).map(th => th.getBoundingClientRect().width);

    const colElements = table.querySelectorAll("colgroup col");

    widths.forEach((w, i) => {
        if (colElements[i]) {
            colElements[i].style.width = `${w}px`;
        }
    });

    table.style.tableLayout = "fixed";
}

function renderFiles() {

    const tbody = document.getElementById('file-tbody');

    const data = sortFiles(filteredFiles);

    tbody.innerHTML = data.map(f => `
        <tr>
            <td>
                <button
                    class="publish-btn ${f.published ? 'publish-btn-active' : ''}"
                    title="Publizieren"
                    onclick="togglePublish(${f.id})">
                    <i class="fa-solid fa-globe"></i>
                </button>
            </td>

            <td class="file-name-cell">${f.name}</td>

            <td>${f.label ? `<span class="table-label-chip">${f.label.name}</span>` : ''}</td>

            <td style="text-align:center;">${f.cp_count}</td>

            <td style="text-align:center;">
                <button class="action-btn"
                    title="Versionen"
                    onclick="toggleVersions(${f.id})">
                    <i class="fa-solid fa-angles-down"></i>
                </button>
            </td>

            <td>
                ${new Date(f.last_edited).toLocaleString('de-CH', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                })}
            </td>

            <td>${f.author}</td>

            <td>
                <div class="file-action-group">

                    <button class="action-btn danger-btn"
                        title="Löschen"
                        onclick="deleteFile(${f.id})">
                        <i class="fa-solid fa-trash"></i>
                    </button>

                    <button class="action-btn"
                        title="Batch-Pathfinding">
                        <i class="fa-solid fa-industry"></i>
                    </button>

                </div>
            </td>
        </tr>

        ${
            f.showVersions && f.versions
                ? f.versions.map(v => `
                    <tr class="version-row">

                        <td></td>

                        <td class="version-cell">↳ ${v.name}</td>

                        <td></td>

                        <td style="text-align:center;" class="version-cell">
                            ${v.cp_count}
                        </td>

                        <td></td>

                        <td class="version-cell">
                            ${new Date(v.last_edited).toLocaleString('de-CH', {
                                day: '2-digit',
                                month: '2-digit',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                            })}
                        </td>

                        <td class="version-cell">
                            ${v.author}
                        </td>

                        <td></td>

                    </tr>
                `).join('')
                : ''
        }

    `).join('');

    updateSortIndicators();
}

function toggleVersions(fileId) {

    // toggle currently open row
    openVersionsFileId =
        openVersionsFileId === fileId
            ? null
            : fileId;

    filteredFiles = filteredFiles.map(f => {

        const isOpen = f.id === openVersionsFileId;

        // temporary dummy data
        if (isOpen) {
            f.versions = [
                {
                    name: `${f.name} v1`,
                    cp_count: Math.floor(Math.random() * 20) + 5,
                    last_edited: new Date(),
                    author: "Lars"
                },
                {
                    name: `${f.name} v2`,
                    cp_count: Math.floor(Math.random() * 20) + 5,
                    last_edited: new Date(Date.now() - 86400000),
                    author: "Anna"
                },
                {
                    name: `${f.name} Backup`,
                    cp_count: Math.floor(Math.random() * 20) + 5,
                    last_edited: new Date(Date.now() - 86400000 * 3),
                    author: "System"
                }
            ];
        }

        return {
            ...f,
            showVersions: isOpen
        };
    });

    renderFiles();
}
function selectFile(id, name) {
    document.getElementById('nav-filename').textContent = name;
    closeFileModal();
}

function clearSearch() {

    const input = document.getElementById("project-search");

    input.value = "";
    input.focus();

    // clear filters
    activeLabelFilter = null;
    activeAuthorFilters = [];

    closeAllFilters();

    applyFilters();

    updateFilterIndicators();
}

const input = document.getElementById("project-search");
const clearBtn = document.querySelector(".search-clear");

const update = () => {

    const hasSearch = !!input.value.trim();

    const hasFilters =
        activeLabelFilter !== null ||
        activeAuthorFilters.length > 0;

    clearBtn.style.display =
        (hasSearch || hasFilters)
            ? "block"
            : "none";
};

input.addEventListener("input", update);
update(); // initial state

async function openFileModal() {

    const modal = document.getElementById('modal-project');

    modal.classList.add('open');

    // optional loading indicator
    document.getElementById('file-tbody').innerHTML = `
        <tr>
            <td colspan="8" style="text-align:center;">
                <i class="fa-solid fa-spinner fa-spin-pulse" style="padding: 10px; font-size: 1.5rem"></i>
            </td>
        </tr>
    `;

    // wait if still loading
    if (filesLoadingPromise) {
        await loadFiles();
    }

    renderFiles();
}

function closeFileModal() {
    document.getElementById('modal-project').classList.remove('open');
}

function renderLabels() {

    const container = document.getElementById("label-list");

    container.innerHTML = labels.map(label => `
        <div class="label-row">

            <span>${label.name}</span>

            <button
                class="label-delete-btn"
                onclick="deleteLabel(${label.id})"
            >
                <i class="fa-solid fa-xmark"></i>
            </button>

        </div>
    `).join('');
}

function toggleLabelDropdown() {

    document
        .getElementById("label-dropdown-menu")
        .classList
        .toggle("open");
}

const projectTitleInput = document.getElementById("project-title-input");

function setProjectName(name) {
    currentProjectName = name?.trim() || "Neues Projekt";

    if (projectTitleInput) {
        projectTitleInput.value = currentProjectName;
    }
}

function syncProjectNameFromInput() {
    if (!projectTitleInput) return;

    currentProjectName = projectTitleInput.value;
}

function normalizeProjectName() {
    if (!projectTitleInput) return;

    if (!projectTitleInput.value.trim()) {
        currentProjectName = "Neues Projekt";
        projectTitleInput.value = currentProjectName;
    }
}

function getProjectName() {
    return currentProjectName.trim() || "Neues Projekt";
}

document.addEventListener("DOMContentLoaded", () => {

    setProjectName(currentProjectName);

    // allow empty while typing
    projectTitleInput.addEventListener(
        "input",
        syncProjectNameFromInput
    );

    // restore default only after leaving field
    projectTitleInput.addEventListener(
        "blur",
        normalizeProjectName
    );
})