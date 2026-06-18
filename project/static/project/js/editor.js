/* =========================================================
    PROJECT STATE
========================================================= */

let project = {
    id: null,
    name: 'Neues Projekt',
    published: false,
    label: null,
    scale: null,
    map_scale: 4000,
    scaled: false,
    map_file: '',
    has_mask: false,
    blocked_terrain: null,
    control_pairs: []
};

let projectFiles = [];
let filteredFiles = [];
let filesLoadingPromise = null;
let currentProjectName = "Neues Projekt";

/* =========================================================
    EDITOR SETTINGS
========================================================= */

let editorSettings = { auto_pathfind: 0, auto_jump: true };  // auto_pathfind: 0–4 routes (0 = off)

/* =========================================================
    READ-ONLY STATE
========================================================= */

let readOnly = false;

function setReadOnly(isReadOnly, lockedByName, reason) {
    readOnly = !!isReadOnly;
    document.getElementById("read-only-banner")?.remove();

    // Keep filename input and nav buttons in sync with read-only state
    updateFilenameInput();
    updateNavPublishBtn();
    updateNavLabel();

    // Fade and disable write-only menu items in Projekte dropdown
    const disabledIds = ["nav-save-project", "nav-import-courses"];
    disabledIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.opacity        = readOnly ? "0.35" : "";
        el.style.pointerEvents  = readOnly ? "none" : "";
        el.style.cursor         = readOnly ? "default" : "";
    });

    if (readOnly) {
        setTool(ToolMode.NONE);
        const bar = document.createElement("div");
        bar.id = "read-only-banner";
        bar.style.cssText = `
            position:fixed;top:28px;left:50%;transform:translateX(-50%);
            background:#5a3a00;color:#ffd;padding:6px 16px;border-radius:0 0 6px 6px;
            font-size:12px;z-index:9999;display:flex;align-items:center;gap:8px;pointer-events:none;
        `;
        const msg = reason === 'published'
            ? 'Diese Datei ist veröffentlicht'
            : `${lockedByName || 'jemand anderes'} bearbeitet diese Datei`;
        bar.innerHTML = `<span>🔒 Schreibgeschützt — ${msg}</span>`;
        document.body.appendChild(bar);
    }
}
window.setReadOnly = setReadOnly;

/* =========================================================
    NAVBAR FILENAME INPUT (rename)
========================================================= */

function initFilenameInput() {
    const input = document.getElementById("navbar-filename-input");
    if (!input) return;

    // Sync project.name on every keystroke (works for both saved + fresh files)
    input.addEventListener("input", () => {
        project.name = input.value;
    });

    // Confirm rename on Enter
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    });

    // Save on blur — validate uniqueness first. For a fresh (unsaved) file we
    // just keep the typed name in JS state; it gets persisted whenever the
    // first save fires (map upload, etc.).
    input.addEventListener("blur", () => {
        const newName = input.value.trim();
        if (!project.id) {
            project.name = newName || project.name || 'Neues Projekt';
            input.value  = project.name;
            return;
        }
        if (!newName) {
            // Empty — revert
            input.value = project.name;
            return;
        }
        // Check for name collision with another file
        const conflict = (projectFiles || []).some(
            f => f.name === newName && f.id !== project.id
        );
        if (conflict) {
            input.classList.add("input-error");
            input.value  = project.name;           // revert display
            // revert json too (project.name was set on input event)
            // find original name from projectFiles
            const original = (projectFiles || []).find(f => f.id === project.id);
            if (original) project.name = original.name;
            input.value = project.name;
            setTimeout(() => input.classList.remove("input-error"), 1200);
            return;
        }
        project.name = newName;
        input.value  = newName;
        saveFile("rename");  // server creates snapshot via _trigger = "rename"
    });
}

function updateFilenameInput() {
    const input = document.getElementById("navbar-filename-input");
    if (!input) return;
    // Always reflect the in-memory project name — even for new files that
    // haven't been saved to the DB yet. The JS state already carries a
    // default name ('Neues Projekt') that is meaningful to the user.
    input.value    = project.name || "";
    input.disabled = readOnly;
}
window.updateFilenameInput = updateFilenameInput;

/* ---- Navbar publish button ---- */
function updateNavPublishBtn() {
    const btn = document.getElementById("nav-publish-btn");
    if (!btn) return;
    // Always enabled — for a fresh file we'll save first inside the click handler
    btn.disabled = false;
    btn.classList.toggle("publish-btn-active", !!(project.id && project.published));
}
window.updateNavPublishBtn = updateNavPublishBtn;

async function toggleNavPublish() {
    // For a fresh file the project hasn't been persisted yet — save first so
    // we have an id to publish against.
    if (!project.id) {
        await saveFile("publish-init");
        if (!project.id) return;   // save still failed; bail
    }
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
    const res  = await fetch(`/editor/publish/${project.id}/`, {
        method: 'POST', headers: { 'X-CSRFToken': csrf },
    });
    const data = await res.json();
    if (!res.ok) { await window.showModal({ message: data.message || 'Fehler beim Veröffentlichen.' }); return; }
    project.published = data.published;
    updateNavPublishBtn();
    if (data.published) {
        setReadOnly(true, null, 'published');
    } else {
        setReadOnly(false);
    }
    if (data.published) {
        const btn = document.getElementById("nav-publish-btn");
        if (btn) emitPublishWave(btn);
    }
}
window.toggleNavPublish = toggleNavPublish;

/* ---- Navbar label slot ---- */
function updateNavLabel() {
    const chip = document.getElementById("nav-label-chip");
    if (!chip) return;
    if (!project.id) { chip.innerHTML = ""; return; }
    const label = project.label;
    if (label) {
        chip.innerHTML = `<span class="table-label-chip" style="background:${label.color}22;color:${label.color};border-color:${label.color}55;">${label.name}</span>`;
    } else {
        chip.innerHTML = `<span class="nav-label-empty">Label…</span>`;
    }
}
window.updateNavLabel = updateNavLabel;

function openNavLabelPicker(slotEl) {
    if (!project.id) return;
    document.getElementById("nav-label-picker")?.remove();

    const labels = window.allLabels || [];
    const csrf   = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
    const rect   = slotEl.getBoundingClientRect();

    const drop = document.createElement("div");
    drop.id = "nav-label-picker";
    drop.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.bottom+4}px;
        background:#1a1a1a;border:1px solid #333;border-radius:6px;
        min-width:160px;padding:4px 0;z-index:10001;box-shadow:0 4px 16px #0008;`;

    const assignAndClose = async (label) => {
        drop.remove();
        const prevLabel = project.label;
        project.label = label;
        updateNavLabel();
        // Persist via existing endpoint
        const res = await fetch(`/editor/files/${project.id}/label/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
            body: JSON.stringify({ label_id: label ? label.id : null }),
        });
        if (!res.ok) { project.label = prevLabel; updateNavLabel(); return; }
        saveSnapshot("Label");
        // Also update projectFiles so the file table stays in sync
        const f = (projectFiles || []).find(f => f.id === project.id);
        if (f) f.label = label;
    };

    // Remove label option (if one is set)
    if (project.label) {
        const rem = document.createElement("div");
        rem.style.cssText = "padding:5px 12px;font-size:12px;color:#888;cursor:pointer;";
        rem.textContent = "Kein Label";
        rem.onmouseenter = () => rem.style.background = "#222";
        rem.onmouseleave = () => rem.style.background = "";
        rem.onclick = () => assignAndClose(null);
        drop.appendChild(rem);
        const sep = document.createElement("div");
        sep.style.cssText = "border-top:1px solid #2a2a2a;margin:4px 0;";
        drop.appendChild(sep);
    }

    if (labels.length === 0) {
        const none = document.createElement("div");
        none.style.cssText = "padding:5px 12px;font-size:12px;color:#555;font-style:italic;";
        none.textContent = "Keine Labels vorhanden";
        drop.appendChild(none);
    }

    labels.forEach(label => {
        const row = document.createElement("div");
        row.style.cssText = "padding:5px 12px;cursor:pointer;display:flex;align-items:center;";
        row.onmouseenter = () => row.style.background = "#222";
        row.onmouseleave = () => row.style.background = "";
        const chip = document.createElement("span");
        chip.className = "table-label-chip";
        chip.textContent = label.name;
        chip.style.cssText = `background:${label.color}22;color:${label.color};border-color:${label.color}55;font-size:12px;`;
        row.appendChild(chip);
        row.onclick = () => assignAndClose(label);
        drop.appendChild(row);
    });

    document.body.appendChild(drop);
    setTimeout(() => {
        document.addEventListener("click", function h(e) {
            if (!drop.contains(e.target) && e.target !== slotEl) {
                drop.remove(); document.removeEventListener("click", h);
            }
        });
    }, 0);
}
window.openNavLabelPicker = openNavLabelPicker;

async function loadEditorSettings() {
    try {
        const res  = await fetch('/editor/settings/');
        const data = await res.json();
        if (data.auto_pathfind !== undefined) editorSettings.auto_pathfind = data.auto_pathfind;
        if (data.auto_jump     !== undefined) editorSettings.auto_jump     = data.auto_jump;
        _applySettingsUI();
    } catch (e) { console.warn('Failed to load editor settings', e); }
}

// Reflect an auto-pathfind value (0–4) onto the multi-stop switch: knob stop
// (--i), on/off track color (data-value) and the numeric label.
function _renderAutoPathfindUI(v) {
    const n = Math.max(0, Math.min(4, parseInt(v, 10) || 0));
    const apPill = document.getElementById('auto-pathfind-pill');
    const apVal  = document.getElementById('auto-pathfind-value');
    if (apPill) {
        apPill.style.setProperty('--i', n);
        apPill.dataset.value = n;
    }
    if (apVal) apVal.textContent = n;
}

function _applySettingsUI() {
    const apEl = document.getElementById('slider-auto-pathfind');
    const ajEl = document.getElementById('toggle-auto-jump');
    if (apEl) apEl.value = editorSettings.auto_pathfind;
    _renderAutoPathfindUI(editorSettings.auto_pathfind);
    if (ajEl) ajEl.checked = editorSettings.auto_jump;
}

// Persist a setting. For auto_pathfind, `value` (0–4) is sent; for boolean
// settings (auto_jump) the server toggles and `value` is ignored.
async function saveEditorSetting(setting, value) {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
    try {
        const res  = await fetch('/editor/settings/toggle/', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
            body:    JSON.stringify({ setting, value }),
        });
        const data = await res.json();
        if (data.auto_pathfind !== undefined) editorSettings.auto_pathfind = data.auto_pathfind;
        if (data.auto_jump     !== undefined) editorSettings.auto_jump     = data.auto_jump;
        _applySettingsUI();
        if (editorSettings.auto_pathfind) drainPendingAutoPathfindQueue();
        if (setting === 'auto_pathfind') {
            if (editorSettings.auto_pathfind) {
                showMaskGenBarIfActive();
            } else if (currentToolMode !== ToolMode.MASK) {
                hideMaskGenBar();
            }
        }
    } catch (e) { console.warn('Failed to save setting', e); }
}

function toggleEditorSetting(setting) { return saveEditorSetting(setting); }

function setAutoPathfindRoutes(n) {
    const value = Math.max(0, Math.min(4, parseInt(n, 10) || 0));
    // Reflect immediately so the value label tracks the drag before the server replies.
    editorSettings.auto_pathfind = value;
    _renderAutoPathfindUI(value);
    return saveEditorSetting('auto_pathfind', value);
}

/* =========================================================
    UNDO / REDO & AUTOSAVE
========================================================= */

const UNDO_MAX       = 50;
const SNAPSHOT_EVERY = 10;

let undoStack   = [];
let redoStack   = [];
let actionCount = 0;

function captureState(label = "") {
    return {
        project:       structuredClone(project),
        selection:     { ncp: selection.ncp, nr: selection.nr },
        toolMode:      currentToolMode,
        subtools:      structuredClone(activeSubtool),
        inNewRoute:    activeTool === NewRouteTool,
        newRouteCpNcp: activeTool === NewRouteTool ? selection.ncp : null,
        label,
    };
}

function pushUndoState(label = "Geladen") {
    undoStack.push(captureState(label));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack = [];
    actionCount++;
    if (actionCount % SNAPSHOT_EVERY === 0) {
        if (_shouldDeferAutoPathfindSaves()) _markAutoPathfindBatchDirty();
        else saveSnapshot("autosave");
    }
    updateUndoMenu();
}

function restoreState(state) {
    if (readOnly) return;
    activeTool.onExit?.();
    project = structuredClone(state.project);
    selection.ncp = state.selection.ncp;
    selection.nr  = state.selection.nr;
    Object.assign(activeSubtool, state.subtools ?? {});
    setTool(state.toolMode);
    drawCourse();
    drawBlockedTerrain();
    updateCPList();
    if (state.inNewRoute) {
        const cp = project.control_pairs.find(c => c.order === state.newRouteCpNcp);
        if (cp) { selection.ncp = cp.order; startNewRoute(); }
    }
}

function undo() {
    if (readOnly) return;
    if (!undoStack.length) return;
    cancelAllPathing();
    if (undoStack[undoStack.length - 1].isMaskUndo) {
        redoStack.push({ label: "Maske bearbeitet", isMaskUndo: true });
        undoStack.pop();
        undoMask();
        updateUndoMenu();
        return;
    }
    redoStack.push(captureState("Rückgängig"));
    restoreState(undoStack.pop());
    saveFile("undo");
    updateUndoMenu();
    drawCourse();
}

function redo() {
    if (readOnly) return;
    if (!redoStack.length) return;
    cancelAllPathing();
    if (redoStack[redoStack.length - 1].isMaskUndo) {
        undoStack.push({ label: "Maske bearbeitet", isMaskUndo: true });
        redoStack.pop();
        redoMask();
        updateUndoMenu();
        return;
    }
    undoStack.push(captureState("Wiederholen"));
    restoreState(redoStack.pop());
    saveFile("redo");
    updateUndoMenu();
}

function updateUndoMenu() {
    const el = document.getElementById("undo-dropdown");
    if (!el) return;
    if (!undoStack.length) {
        el.innerHTML = `<div style="color:#555;font-style:italic;padding:7px 14px;">Keine Aktionen</div>`;
        return;
    }
    el.innerHTML = [...undoStack].reverse().map((state, i) => `
        <div class="undo-entry" data-undo-index="${i}"
             style="padding:5px 14px;color:${i === 0 ? '#ddd' : '#888'};font-size:12px;cursor:pointer;white-space:nowrap;">
            ${state.label || '—'}
        </div>`).join('');
}

// Jump to a specific point in the undo stack (reversedIndex = 0 is most recent)
function jumpToUndoState(reversedIndex) {
    if (readOnly) return;
    if (reversedIndex < 0 || reversedIndex >= undoStack.length) return;
    const targetIndex = undoStack.length - 1 - reversedIndex;
    const targetState = undoStack[targetIndex];
    undoStack = undoStack.slice(0, targetIndex);   // remove target + everything above it
    redoStack = [];
    restoreState(targetState);
    saveFile("jump");
    updateUndoMenu();
}

// Delegate clicks on undo entries + scroll to top when menu opens
document.addEventListener("DOMContentLoaded", () => {
    // ── Undo dropdown ─────────────────────────────────────
    const dropdown = document.getElementById("undo-dropdown");
    if (dropdown) {
        const menuItem = document.getElementById("menu-history");
        if (menuItem) {
            menuItem.addEventListener("mouseenter", () => { dropdown.scrollTop = 0; });
        }
        dropdown.addEventListener("click", e => {
            const entry = e.target.closest(".undo-entry");
            if (!entry) return;
            const idx = parseInt(entry.dataset.undoIndex, 10);
            if (!isNaN(idx)) jumpToUndoState(idx);
        });
        dropdown.addEventListener("mouseover", e => {
            const entry = e.target.closest(".undo-entry");
            if (!entry) return;
            dropdown.querySelectorAll(".undo-entry").forEach(el => el.style.background = "");
            entry.style.background = "#2a2a2a";
        });
        dropdown.addEventListener("mouseleave", () => {
            dropdown.querySelectorAll(".undo-entry").forEach(el => el.style.background = "");
        });
    }

    // ── Filename rename input ─────────────────────────────
    initFilenameInput();

    // ── Navbar label slot ─────────────────────────────────
    document.getElementById('nav-label-slot')?.addEventListener('click', function() {
        openNavLabelPicker(this);
    });
    initCourseImport();

    // ── Settings toggles ──────────────────────────────────
    loadEditorSettings();
    const apSlider = document.getElementById('slider-auto-pathfind');
    // Live-update the label while dragging; only persist on release.
    apSlider?.addEventListener('input', () => {
        _renderAutoPathfindUI(apSlider.value);
    });
    apSlider?.addEventListener('change', () => {
        setAutoPathfindRoutes(apSlider.value);
    });
    document.getElementById('toggle-auto-jump')?.addEventListener('change', () => {
        toggleEditorSetting('auto_jump');
    });

    // ── P key → open file modal ───────────────────────────
    window.addEventListener("keydown", e => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target.matches('input, textarea, select')) return;
        if (e.key === 'p' || e.key === 'P') {
            e.preventDefault();
            if (typeof window.openFileModal === 'function') window.openFileModal();
        }
    }, true);

    // ── Enter → confirm OCD import when options are visible ─
    window.addEventListener("keydown", e => {
        if (e.key !== "Enter") return;
        if (!document.getElementById("modal-map")?.classList.contains("open")) return;
        const ocadBtn = document.getElementById("ocad-upload-btn");
        if (ocadBtn && document.getElementById("ocad-import-options")?.style.display !== "none") {
            e.preventDefault();
            ocadBtn.click();
            return;
        }
    });

    // ── Mobile: pin layout to the VISIBLE viewport ────────────
    // On mobile the browser's URL bar collapses/expands, changing the visible
    // height. CSS dvh/svh handle most browsers, but where supported we sync the
    // real visualViewport height into a CSS custom property so the side panel +
    // tool wheel always clear the browser chrome. --editor-vh is 1% of the
    // visible viewport; CSS multiplies it (e.g. *33 for the side panel).
    initMobileViewportHeight();
});

function initMobileViewportHeight() {
    if (!document.body.classList.contains("mobile")) return;
    const wrap = document.getElementById("editor-wrap");
    if (!wrap || !window.visualViewport) return;
    const apply = () => {
        const h = window.visualViewport.height;
        if (h > 0) wrap.style.setProperty("--editor-vh", `${h / 100}px`);
    };
    apply();
    window.visualViewport.addEventListener("resize", apply);
    window.addEventListener("orientationchange", () => setTimeout(apply, 200));
}

let _saveQueue    = Promise.resolve();
let _pendingSaves = 0;

function checkinCurrentFile() {
    if (!project?.id) return;
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
    const fd = new FormData();
    fd.append('file_id', project.id);
    fd.append('csrfmiddlewaretoken', csrf);
    navigator.sendBeacon('/editor/checkin/', fd);
}
window.checkinCurrentFile = checkinCurrentFile;

window.addEventListener("beforeunload", e => {
    checkinCurrentFile();
    if (_pendingSaves > 0 || _hasDeferredAutoPathfindSave()) {
        e.preventDefault();
        e.returnValue = "Autosave noch nicht abgeschlossen. Bitte auf der Seite bleiben.";
    }
});

function _projectBody() {
    const cps = (project.control_pairs || []).map(cp => ({
        id: cp.id ?? null,
        order: cp.order,
        start: cp.start,
        ziel: cp.ziel,
        complex: !!cp.complex,
        routes: (cp.routes || []).map(route => ({
            id: route.id ?? null,
            order: route.order,
            rP: route.rP,
            noA: route.noA,
            pos: route.pos,
            length: route.length,
            run_time: route.run_time,
            elevation: route.elevation,
        })),
    }));
    return {
        id:              project.id,
        name:            project.name,
        scale:           project.scale,
        map_scale:       Number.isFinite(Number(project.map_scale)) && Number(project.map_scale) > 0
                            ? Number(project.map_scale)
                            : 4000,
        scaled:          project.scaled,
        map_file:        project.map_file,
        has_mask:        project.has_mask,
        blocked_terrain: project.blocked_terrain,
        control_pairs:   cps,
        last_edited:     project.last_edited ?? null,
        n_control_pairs: cps.length,
        n_routes:        cps.reduce((s, cp) => s + (cp.routes?.length ?? 0), 0),
    };
}

/* =========================================================
    OFFLINE JSON EXPORT (escape hatch)
    --------------------------------------------------------
    If autosave / connectivity fails, the user can rescue the
    UNSAVED, in-memory project structure by appending "#download"
    to the current editor URL (e.g. /editor/#download).
    This is handled fully client-side — no reload, no network —
    so the exact in-memory state is preserved rather than lost
    to a navigation. There is intentionally no on-screen button.
========================================================= */

function downloadProjectJson() {
    // Export the exact in-memory `project` object as-is — whatever state it is
    // currently in — rather than the curated autosave payload.
    if (!project) {
        console.warn("downloadProjectJson: no project in memory — nothing to export.");
        return;
    }

    const body = project;

    // Build a meaningful, filesystem-safe filename: project-<id-or-name>-<timestamp>.json
    const pad   = n => String(n).padStart(2, "0");
    const now   = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
                + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const ident = (project.name || "unnamed").trim().replace(/[^\w\-]+/g, "_").slice(0, 60) || "unnamed";
    const filename = `project-${ident}-${stamp}.json`;

    const url = URL.createObjectURL(
        new Blob([JSON.stringify(body, null, 2)], { type: "application/json" })
    );
    const a = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    console.info(`downloadProjectJson: exported "${filename}".`);
}
window.downloadProjectJson = downloadProjectJson;

function _handleDownloadHash() {
    if ((location.hash || "").toLowerCase() !== "#download") return;
    // Clear the hash first (no navigation) so the export can be re-triggered.
    try {
        history.replaceState(null, "", location.pathname + location.search);
    } catch (_) { /* replaceState unavailable — proceed with export anyway */ }
    downloadProjectJson();
}

window.addEventListener("hashchange", _handleDownloadHash);
// Run once on load in case the page opened directly with #download in the URL.
_handleDownloadHash();

function markProjectPersistenceIds(targetProject = project) {
    const fileId = targetProject?.id ?? null;
    for (const cp of targetProject?.control_pairs || []) {
        cp._fileId = cp.id ? fileId : null;
        for (const route of cp.routes || []) {
            route._fileId = route.id ? fileId : null;
            route._cpDbId = route.id ? cp.id : null;
        }
    }
}
window.markProjectPersistenceIds = markProjectPersistenceIds;

function normalizeProjectOrders(targetProject = project) {
    if (!Array.isArray(targetProject?.control_pairs)) return false;
    let changed = false;

    targetProject.control_pairs.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));
    targetProject.control_pairs.forEach((cp, index) => {
        if (cp.order !== index) changed = true;
        cp.order = index;

        if (!Array.isArray(cp.routes)) {
            cp.routes = [];
            return;
        }
        cp.routes.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));
        cp.routes.forEach((route, routeIndex) => {
            if (route.order !== routeIndex) changed = true;
            route.order = routeIndex;
        });
    });

    return changed;
}
window.normalizeProjectOrders = normalizeProjectOrders;

function saveFile(trigger = "save") {
    if (readOnly && trigger !== "duplicate") return;
    _pendingSaves++;
    _saveQueue = _saveQueue.then(async () => {
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
        try {
            const res  = await fetch("/editor/save/", {
                method:  "POST",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
                body:    JSON.stringify({ ..._projectBody(), _trigger: trigger }),
            });
            const data = await res.json();
            if (res.status === 409) {
                // Another user modified the file — warn and pause further saves
                if (!document.getElementById("conflict-warning")) {
                    const bar = document.createElement("div");
                    bar.id = "conflict-warning";
                    bar.style.cssText = `
                        position:fixed;top:28px;left:50%;transform:translateX(-50%);
                        background:#7a1010;color:#fff;padding:8px 16px;border-radius:0 0 6px 6px;
                        font-size:12px;z-index:9999;display:flex;align-items:center;gap:10px;
                    `;
                    bar.innerHTML = `<span>${data.message}</span>
                        <button onclick="this.closest('#conflict-warning').remove();location.reload();"
                            style="background:#fff;color:#7a1010;border:none;border-radius:4px;
                                   padding:2px 8px;cursor:pointer;font-size:11px;">
                            Neu laden
                        </button>
                        <button onclick="this.closest('#conflict-warning').remove();"
                            style="background:transparent;color:#ccc;border:none;cursor:pointer;font-size:14px;">✕</button>`;
                    document.body.appendChild(bar);
                }
                return; // stop this save; future saves will retry with new last_edited after reload
            }
            if (data.id)          project.id          = data.id;
            if (data.last_edited) project.last_edited = data.last_edited;
            // Write back DB ids so subsequent granular saves update rather than create
            if (data.id_map) {
                data.id_map.forEach(cpMap => {
                    const cp = project.control_pairs.find(c => c.order === cpMap.order);
                    if (!cp) return;
                    cp.id = cpMap.id;
                    cp._fileId = project.id;
                    cpMap.routes.forEach(rMap => {
                        const r = cp.routes.find(r => r.order === rMap.order);
                        if (r) {
                            r.id = rMap.id;
                            r._fileId = project.id;
                            r._cpDbId = cp.id;
                        }
                    });
                });
            }
            _clearSaveFailedWarning();
            if (trigger === "save" || trigger === "manual") {
                saveSnapshot("Manuell gespeichert");
                if (document.getElementById("modal-project")?.classList.contains("open")) {
                    window.refreshFileTable?.();
                }
            }
        } catch (e) {
            console.warn("saveFile failed:", e);
            _showSaveFailedWarning();
        }
        finally { _pendingSaves = Math.max(0, _pendingSaves - 1); }
    });
    return _saveQueue;
}

let _saveFailed = false;

function _showSaveFailedWarning() {
    if (_saveFailed) return;
    _saveFailed = true;
    if (document.getElementById("save-failed-warning")) return;
    const bar = document.createElement("div");
    bar.id = "save-failed-warning";
    bar.style.cssText = `
        position:fixed;top:28px;left:50%;transform:translateX(-50%);
        background:#5a4000;color:#ffd;padding:8px 16px;border-radius:0 0 6px 6px;
        font-size:12px;z-index:9999;display:flex;align-items:center;gap:10px;
    `;
    bar.innerHTML = `<span>⚠ Verbindung unterbrochen — Änderungen werden nicht gespeichert</span>`;
    document.body.appendChild(bar);
}

function _clearSaveFailedWarning() {
    if (!_saveFailed) return;
    _saveFailed = false;
    document.getElementById("save-failed-warning")?.remove();
}

window.addEventListener("online", () => {
    if (_saveFailed) {
        saveFile("reconnect");
    }
});

window.saveSnapshot = saveSnapshot;
function saveSnapshot(trigger = "autosave") {
    if (readOnly) return;
    if (trigger === "autosave" && _shouldDeferAutoPathfindSaves()) {
        _markAutoPathfindBatchDirty();
        return Promise.resolve(null);
    }
    _saveQueue = _saveQueue.then(async () => {
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
        try {
            await fetch("/editor/save-snapshot/", {
                method:  "POST",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
                body:    JSON.stringify({ ..._projectBody(), trigger }),
            });
        } catch (e) { console.warn("saveSnapshot failed:", e); _showSaveFailedWarning(); }
    });
    return _saveQueue;
}

/* =========================================================
    GRANULAR ELEMENT SAVES
========================================================= */

function _saveElement(payloadOrFn, fileId = project.id) {
    if (readOnly || !fileId) return Promise.resolve(null);
    _pendingSaves++;
    _saveQueue = _saveQueue.then(async () => {
        // Resolve payload lazily so callers can reference cp.id / route.id
        // that may have been written by an earlier queued save
        const payload = typeof payloadOrFn === 'function' ? payloadOrFn() : payloadOrFn;
        if (!payload) return null;
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
        try {
            const res  = await fetch("/editor/save-element/", {
                method:  "POST",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
                body:    JSON.stringify({ file_id: fileId, ...payload }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok || d?.error) throw new Error(d?.error || `HTTP ${res.status}`);
            if (Number(project.id) === Number(fileId) && d?.last_edited) project.last_edited = d.last_edited;
            _clearSaveFailedWarning();
            return d;
        } catch (e) { console.warn("saveElement failed:", e); _showSaveFailedWarning(); return null; }
        finally    { _pendingSaves = Math.max(0, _pendingSaves - 1); }
    });
    return _saveQueue;
}

// Held off the cp object so structuredClone(project) (undo snapshots) doesn't
// choke on the Promise — DOMException: Promise could not be cloned.
const _cpInFlightSave = new WeakMap();

function saveControlPair(cp, fileId = project.id) {
    if (!cp || !fileId) return Promise.resolve(null);
    if (_shouldDeferAutoPathfindSaves()) {
        _markAutoPathfindBatchDirty();
        return Promise.resolve({ deferred: true });
    }
    const inFlight = _cpInFlightSave.get(cp);
    if (inFlight && Number(inFlight.fileId) === Number(fileId)) return inFlight.promise;
    // Pass a function so cp.id is read at execution time (after any prior saves set it)
    const promise = _saveElement(() => ({
        type: 'control_pair',
        control_pair: { db_id: Number(cp._fileId) === Number(fileId) ? (cp.id ?? null) : null, order: cp.order,
                        start: cp.start, ziel: cp.ziel, complex: cp.complex },
    }), fileId).then(data => {
        if (data?.db_id) {
            cp.id = data.db_id;
            cp._fileId = fileId;
        }
        return data;
    }).finally(() => {
        const current = _cpInFlightSave.get(cp);
        if (current && current.promise === promise) _cpInFlightSave.delete(cp);
    });
    _cpInFlightSave.set(cp, { promise, fileId });
    return promise;
}

function ensureControlPairSaved(cp, fileId = project.id) {
    if (!cp || !fileId) return Promise.resolve(null);
    if (cp.id && Number(cp._fileId) === Number(fileId)) return Promise.resolve({ db_id: cp.id });
    return saveControlPair(cp, fileId);
}

function saveRoute(cp, route) {
    const fileId = project.id;
    if (!cp || !route || !fileId) return Promise.resolve(null);
    if (_shouldDeferAutoPathfindSaves()) {
        _markAutoPathfindBatchDirty();
        return Promise.resolve({ deferred: true });
    }
    return ensureControlPairSaved(cp, fileId).then(() => {
        if (!cp.id || Number(cp._fileId) !== Number(fileId)) return null;
        return _saveElement(() => ({
            type: 'route', cp_db_id: cp.id,
            route: {
                db_id: (Number(route._fileId) === Number(fileId) && Number(route._cpDbId) === Number(cp.id)) ? (route.id ?? null) : null,
                order: route.order,
                rP: route.rP, noA: route.noA, pos: route.pos,
                length: route.length, run_time: route.run_time, elevation: route.elevation,
            },
        }), fileId);
    }).then(data => {
        if (data?.db_id) {
            route.id = data.db_id;
            route._fileId = fileId;
            route._cpDbId = cp.id;
        }
        return data;
    });
}

function saveBlockedTerrain() {
    return _saveElement(() => ({ type: 'blocked_terrain', blocked_terrain: project.blocked_terrain }));
}

function _deleteElement(payloadOrFn) {
    if (readOnly || !project.id) return;
    if (_shouldDeferAutoPathfindSaves()) {
        _markAutoPathfindBatchDirty();
        return;
    }
    _pendingSaves++;
    _saveQueue = _saveQueue.then(async () => {
        const payload = typeof payloadOrFn === 'function' ? payloadOrFn() : payloadOrFn;
        if (!payload) { _pendingSaves = Math.max(0, _pendingSaves - 1); return; } // nothing to delete
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
        try {
            const res = await fetch("/editor/delete-element/", {
                method:  "POST",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
                body:    JSON.stringify({ file_id: project.id, ...payload }),
            });
            const d = await res.json();
            if (d?.last_edited) project.last_edited = d.last_edited;
            _clearSaveFailedWarning();
        } catch (e) { console.warn("deleteElement failed:", e); _showSaveFailedWarning(); }
        finally    { _pendingSaves = Math.max(0, _pendingSaves - 1); }
    });
}

function deleteControlPair(cp) {
    _deleteElement(() => cp.id ? { type: 'control_pair', db_id: cp.id } : null);
}

function deleteRoute(cp, route) {
    _deleteElement(() => (route.id && cp.id) ? { type: 'route', db_id: route.id, cp_db_id: cp.id } : null);
}

// Keyboard shortcuts for undo/redo
async function duplicateFile() {
    if (!project.id) return;

    // Unique name: "Kopie von [original]", "Kopie von [original] 2", ...
    // Strip any existing "Kopie von " prefix so we don't nest them.
    const originalName = project.name.replace(/^Kopie von (.+?)( \d+)?$/, '$1');
    const existing     = new Set((projectFiles || []).map(f => f.name));
    let dupName = `Kopie von ${originalName}`;
    let counter = 2;
    while (existing.has(dupName)) { dupName = `Kopie von ${originalName} ${counter++}`; }

    // Mutate project in-place: clear all IDs so saveFile creates new records.
    // Locked/published files must also be duplicatable — clear those states here.
    project.id   = null;
    project.name = dupName;
    project.control_pairs.forEach(cp => {
        cp.id = null;
        (cp.routes || []).forEach(r => { r.id = null; });
    });

    // Clear read-only (lock/publish) — the duplicate is a fresh file owned by us
    setReadOnly(false);

    // Show "Duplizieren…" placeholder while the DB write is in progress
    const filenameInput = document.getElementById("navbar-filename-input");
    if (filenameInput) {
        filenameInput.value       = "duplizieren…";
        filenameInput.style.fontStyle = "italic";
        filenameInput.disabled    = true;
    }

    // saveFile("duplicate") bypasses the readOnly guard and creates a fresh file.
    // Await so subsequent calls have the new project.id.
    await saveFile("duplicate");

    // Restore normal input state now that project.id is set
    if (filenameInput) filenameInput.style.fontStyle = "";
    updateFilenameInput();
    saveSnapshot("autosave");
    window.refreshFileTable?.();
}

window.addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (_scalingActive || _scaleP1 || document.getElementById("modal-scale")?.style.display === "flex") {
            _undoScalePoint();
        } else {
            undo();
        }
    }
    if (e.key === "y" || (e.key === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    if (e.key === "s") { e.preventDefault(); if (!readOnly) saveFile("manual"); }
    if (e.key === "n") { e.preventDefault(); if (!readOnly) createFile(); }
    if (e.key === "d") { e.preventDefault(); duplicateFile(); }
}, true);  // capture phase so it fires before tool keydown handlers and overrides browser defaults

/* =========================================================
    CAMERA STATE
========================================================= */

const zoomMin = 0.1;
const zoomMax = 8;
const SNAP_DISTANCE_CONTROL_PAIR = 15;
const SNAP_DISTANCE_ROUTE_EDIT   = 5;
const R_CONTROL = 25;
const GAP = 8;
const RUN_SPEED = 4.75;         // average running speed in m/s
const PX_TO_M  = 0.48;         // pixels to metres conversion factor
const REFERENCE_MAP_SCALE = 4000;
const PATHING_MASK_TRAIN_SCALE = 0.710;
const CONTROL_POINT_PASSABLE_SNAP_M = 10;

function projectMapScale() {
    const value = Number(project?.map_scale);
    return Number.isFinite(value) && value > 0 ? value : REFERENCE_MAP_SCALE;
}

function routeMetresPerEditorPx() {
    return PX_TO_M * (projectMapScale() / REFERENCE_MAP_SCALE);
}

const camera = { x: 0, y: 0, zoom: 0.67 };

/* =========================================================
    DOM REFERENCES
========================================================= */

const mapContainer = document.getElementById("map-container");

/* =========================================================
    SELECTION STATE
    Tracks which control pair / route is currently active.
========================================================= */

const selection = {
    ncp: 0,
    nr:  null,
};

/* =========================================================
    PAN UTILITY
    Pan is always available as a drag fallback in every tool.
    pan.stop() restores the cursor from the active tool's
    defaultCursor property so tools don't need to track it.
========================================================= */

const pan = (() => {
    let active = false;
    let startX = 0, startY = 0, camX = 0, camY = 0;

    return {
        start(clientX, clientY) {
            active = true;
            startX = clientX;
            startY = clientY;
            camX = camera.x;
            camY = camera.y;
            mapContainer.classList.add("panning");
            mapContainer.style.cursor = "grabbing";
            hideCrosshair();
        },
        update(e) {
            if (!active) return false;
            camera.x = camX + (e.clientX - startX);
            camera.y = camY + (e.clientY - startY);
            updateCameraTransform();
            return true;
        },
        stop() {
            if (!active) return false;
            active = false;
            mapContainer.classList.remove("panning");
            mapContainer.style.cursor = activeTool?.defaultCursor ?? "default";
            return true;
        },
        isActive() { return active; },
    };
})();

/* =========================================================
    PENDING GESTURE
    Separates a click from a drag. onDrag receives the
    original mousedown event so each tool can start pan
    or a drag operation anchored at the correct position.
========================================================= */

function makePendingGesture({ threshold = 3, onDrag, onClick }) {
    let pending = null;

    return {
        down(e, pt)  { pending = { e, pt }; },
        move(pt) {
            if (!pending) return false;
            if (Math.hypot(pt.x - pending.pt.x, pt.y - pending.pt.y) > threshold) {
                const saved = pending;
                pending = null;
                onDrag?.(saved.e, saved.pt);
                return true;
            }
            return false;
        },
        up(e, pt) {
            if (!pending) return;
            pending = null;
            onClick?.(e, pt);
        },
        cancel()    { pending = null; },
        isPending() { return pending !== null; },
    };
}

/* =========================================================
    TOOL: CONTROL PAIR
    Left-click selects a control pair.
    Drag on the active pair's circle moves the point.
    Drag on empty space pans.
========================================================= */

const ControlPairTool = (() => {
    let drag = null;

    function startDrag(target, pt) {
        const cp = project.control_pairs[target.ncp];
        if (!cp) return;
        const point = cp[target.pointType];
        drag = {
            controlPair: cp,
            pointType: target.pointType,
            offsetX: point.x - pt.x,
            offsetY: point.y - pt.y,
            originX: point.x,
            originY: point.y,
        };
        pushUndoState("Posten verschoben");
        setRouteDeletePreview(null);
        mapContainer.classList.add("dragging");
        mapContainer.style.cursor = "grabbing";
    }

    function updateDrag(pt) {
        if (!drag) return;
        let newX = pt.x + drag.offsetX;
        let newY = pt.y + drag.offsetY;
        const snap = findSnapTarget(drag.controlPair, drag.pointType, newX, newY);
        if (snap) { newX = snap.x; newY = snap.y; }
        drag.controlPair[drag.pointType].x = newX;
        drag.controlPair[drag.pointType].y = newY;
        updateControlPairDragVisual(drag.controlPair);   // PERF: in-place, no node churn
        updateCrosshair(newX, newY);

        const moved   = Math.hypot(newX - drag.originX, newY - drag.originY);
        const willDel = moved > SNAP_DISTANCE_CONTROL_PAIR;
        setRouteDeletePreview(willDel ? drag.controlPair.order : null);
    }

    function stopDrag() {
        if (!drag) return;
        const cp        = drag.controlPair;
        const pointType = drag.pointType;
        const point     = cp[pointType];
        const snappedPoint = _movePointToNearestPassableIfImpassable(point);
        if (snappedPoint && Math.hypot(snappedPoint.x - point.x, snappedPoint.y - point.y) >= 0.01) {
            point.x = snappedPoint.x;
            point.y = snappedPoint.y;
        }
        const moved     = Math.hypot(point.x - drag.originX, point.y - drag.originY);
        drag = null;
        setRouteDeletePreview(null);
        mapContainer.classList.remove("dragging");
        mapContainer.style.cursor = "default";
        hideCrosshair();
        const clearedRoutes = moved > SNAP_DISTANCE_CONTROL_PAIR;
        if (clearedRoutes) {
            cp.routes.forEach(r => deleteRoute(cp, r));
            cp.routes = [];
        } else if (cp.routes.length) {
            const isStart = pointType === "start";
            cp.routes.forEach(r => {
                if (!r.rP?.length) return;
                const rpt = isStart ? r.rP[0] : r.rP[r.rP.length - 1];
                rpt.x = point.x;
                rpt.y = point.y;
                calcRouteLength(r);
                calcRouteNoA(r);
                calcRouteRunTime(r);
                calcRouteSide(cp, r);
            });
        }
        drawRoutes();
        updateRoutes();
        updateCPList();
        if (moved > 0) {
            saveControlPair(cp);
            if (moved <= SNAP_DISTANCE_CONTROL_PAIR) cp.routes.forEach(r => saveRoute(cp, r));
        }
        if (clearedRoutes) requestAutoPathfindForControlPair(cp);
    }

    const gesture = makePendingGesture({
        threshold: 0,
        onDrag(downEvent, downPt) {
            const target = getControlPairCircle(downEvent.target);
            if (target && target.ncp === selection.ncp) {
                startDrag(target, downPt);
            } else {
                pan.start(downEvent.clientX, downEvent.clientY);
            }
        },
        onClick(e) {
            clickControlPairGroup(e.target);
        },
    });

    return {
        defaultCursor: "default",
        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("mode-cp");
            selection.nr = null;
            updateRoutes();
        },
        onExit()  {
            mapContainer.classList.remove("mode-cp");
            gesture.cancel();
            stopDrag();
        },
        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseMove(e, pt) {
            if (drag) { updateDrag(pt); return; }
            if (gesture.move(pt)) return;
            const target = e.target;
            const group  = target.closest?.(".control-pair-group");
            if (group) {
                const selected = group.classList.contains("selected");
                if (target.classList?.contains("control-circle")) {
                    mapContainer.style.cursor = selected ? "grab" : "pointer";
                } else {
                    mapContainer.style.cursor = selected ? "default" : "pointer";
                }
            } else {
                mapContainer.style.cursor = "default";
            }
        },
        onMouseUp(e, pt) {
            if (drag) { stopDrag(); return; }
            gesture.up(e, pt);
        },
        onKeyDown(e) {},
    };
})();

/* =========================================================
    TOOL: ROUTE EDIT
    Activated from RouteTool when clicking on an active
    route segment. Adds waypoints on each click.
    Reconnects to the original tail when clicking near it.
    Escape cancels and returns to RouteTool.
========================================================= */

const RouteEditTool = (() => {
    let route        = null;
    let cpRef        = null;
    let continuation = null;
    let originalPts  = null;
    let previewPt    = null;

    function reset() {
        route = null;
        cpRef = null;
        continuation = null;
        originalPts  = null;
        previewPt    = null;
    }

    // PERF: persistent preview nodes — original-route polyline + line to cursor.
    const _ev = {};
    function evEnsure() {
        if (!_ev.orig) {
            _ev.orig = svgNode("polyline", { fill: "none", stroke: "rgba(229, 57, 53, 0.67)",
                "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round",
                "vector-effect": "non-scaling-stroke", "pointer-events": "none" });
            _ev.orig.classList.add("route-edit-original-preview");
            _ev.line = svgNode("line", { stroke: "#E53935", "stroke-width": "1",
                "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" });
        }
        ensureInLayer(_ev.orig, "edit-layer");
        ensureInLayer(_ev.line, "edit-layer");
    }

    function drawPreview() {
        evEnsure();
        drawOriginal();
        if (!route || !previewPt) { hideNode(_ev.line); return; }
        const prev = route.rP[route.rP.length - 1];
        if (!prev) { hideNode(_ev.line); return; }
        _ev.line.setAttribute("x1", prev.x);      _ev.line.setAttribute("y1", prev.y);
        _ev.line.setAttribute("x2", previewPt.x); _ev.line.setAttribute("y2", previewPt.y);
        showNode(_ev.line);
    }

    const scheduleDraw = makeRafScheduler(drawPreview);   // PERF-FIX #2

    function drawOriginal() {
        evEnsure();
        if (!originalPts || originalPts.length < 2) { hideNode(_ev.orig); return; }
        _ev.orig.setAttribute("points", originalPts.map(p => `${p.x},${p.y}`).join(" "));
        showNode(_ev.orig);
    }

    function snapToZiel(pt) {
        const cp = project.control_pairs.find(c => c.order === selection.ncp);
        if (!cp?.ziel) return pt;
        const dx = pt.x - cp.ziel.x;
        const dy = pt.y - cp.ziel.y;
        if (Math.hypot(dx, dy) <= SNAP_DISTANCE_ROUTE_EDIT) return { x: cp.ziel.x, y: cp.ziel.y };
        return pt;
    }

    function tryReconnect(x, y) {
        if (!continuation || !route) return false;
        for (let i = 0; i < continuation.length - 1; i++) {
            const a = continuation[i];
            const b = continuation[i + 1];
            const result = pointToSegmentDistance(x, y, a.x, a.y, b.x, b.y);
            if (result.distance < 2) {
                route.rP.push({ x: result.closestX, y: result.closestY });
                route.rP.push(...continuation.slice(i + 1));
                activateTool(RouteTool);
                return true;
            }
        }
        return false;
    }

    function addEditPoint(pt) {
        if (!route) return;
        const snapped = snapToZiel(pt);
        if (tryReconnect(snapped.x, snapped.y)) return;
            route.rP.push({ x: snapped.x, y: snapped.y });
            calcRouteLength(route);
            drawRoutes();
            clearEditLayer();
            drawOriginal();
            updateRoutes();
            updateCPList();
        }

    const gesture = makePendingGesture({
        onDrag(downEvent) {
            pan.start(downEvent.clientX, downEvent.clientY);
        },
        onClick(e, pt) {
            addEditPoint(pt);
        },
    });

    return {
        defaultCursor: "default",

        // Initialise the edit session. Must be called before activateTool().
        // Returns `this` so callers can write activateTool(RouteEditTool.init(...))
        init(cpOrder, routeOrder, insertPoint, segmentIndex) {
            const cp = project.control_pairs.find(cp => cp.order === cpOrder);
            if (!cp) return this;
            const r = cp.routes.find(r => r.order === routeOrder);
            if (!r) return this;

            route       = r;
            cpRef       = cp;
            originalPts = structuredClone(r.rP);
            pushUndoState("Route bearbeitet");

            r.rP.splice(segmentIndex + 1, 0, { x: insertPoint.x, y: insertPoint.y });
            continuation = r.rP.slice(segmentIndex + 1);
            r.rP         = r.rP.slice(0, segmentIndex + 2);

            return this;
        },

        onEnter() {
            mapContainer.classList.add("editing-route");
            mapContainer.style.cursor = this.defaultCursor;
            drawRoutes();
            clearEditLayer();
            drawOriginal();
            updateRoutes();
        },

        onExit() {
            mapContainer.classList.remove("editing-route");
            scheduleDraw.cancel();   // PERF-FIX #2
            gesture.cancel();
            clearEditLayer();
            hideCrosshair();
            if (route) {
                calcRouteLength(route); calcRouteNoA(route); calcRouteRunTime(route); calcRouteSide(cpRef, route);
                if (cpRef) saveRoute(cpRef, route);
            }
            reset();
            drawRoutes();
            updateRoutes();
            updateCPList();
        },

        onMouseDown(e, pt) {
            gesture.down(e, pt);
        },

        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            previewPt = snapToZiel(pt);
            updateCrosshair(previewPt.x, previewPt.y);
            scheduleDraw();   // PERF-FIX #2 (was drawPreview())
        },

        onMouseUp(e, pt) {
            gesture.up(e, pt);
        },

        onKeyDown(e) {
            if (e.key === "Escape") activateTool(RouteTool);
        },
    };
})();

/* =========================================================
    TOOL: NEW ROUTE
    Click near cp.start to begin, click to add waypoints,
    click near cp.ziel to complete. Escape cancels.
========================================================= */

const NewRouteTool = (() => {
    let cp        = null;
    let route     = null;
    let previewPt = null;

    const SNAP_START = 25;

    function snapToStartPt(pt) {
        if (!cp?.start) return pt;
        if (Math.hypot(pt.x - cp.start.x, pt.y - cp.start.y) <= SNAP_START)
            return { x: cp.start.x, y: cp.start.y };
        return pt;
    }

    function snapToZielPt(pt) {
        if (!cp?.ziel) return pt;
        if (Math.hypot(pt.x - cp.ziel.x, pt.y - cp.ziel.y) <= SNAP_DISTANCE_ROUTE_EDIT)
            return { x: cp.ziel.x, y: cp.ziel.y };
        return pt;
    }

    // PERF: persistent preview nodes — partial polyline (white bg + red fg) and
    // the line to the cursor — updated in place instead of clear+recreate.
    const _rv = {};
    function rvEnsure() {
        if (!_rv.bg) {
            _rv.bg   = svgNode("polyline", { fill: "none", stroke: "white",   "stroke-width": "3",
                "stroke-linecap": "round", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" });
            _rv.fg   = svgNode("polyline", { fill: "none", stroke: "#E53935", "stroke-width": "1.5",
                "stroke-linecap": "round", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" });
            _rv.line = svgNode("line", { stroke: "#E53935", "stroke-width": "1",
                "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" });
        }
        ensureInLayer(_rv.bg,   "edit-layer");
        ensureInLayer(_rv.fg,   "edit-layer");
        ensureInLayer(_rv.line, "edit-layer");
    }

    function drawPreview() {
        rvEnsure();
        if (!route?.rP?.length) { hideNode(_rv.bg); hideNode(_rv.fg); hideNode(_rv.line); return; }

        // Partial polyline so far (white bg + red fg)
        if (route.rP.length >= 2) {
            const pts = route.rP.map(p => `${p.x},${p.y}`).join(" ");
            _rv.bg.setAttribute("points", pts); showNode(_rv.bg);
            _rv.fg.setAttribute("points", pts); showNode(_rv.fg);
        } else {
            hideNode(_rv.bg); hideNode(_rv.fg);
        }

        // Preview line to cursor
        if (previewPt) {
            const prev = route.rP[route.rP.length - 1];
            _rv.line.setAttribute("x1", prev.x);      _rv.line.setAttribute("y1", prev.y);
            _rv.line.setAttribute("x2", previewPt.x); _rv.line.setAttribute("y2", previewPt.y);
            showNode(_rv.line);
        } else {
            hideNode(_rv.line);
        }
    }

    const scheduleDraw = makeRafScheduler(drawPreview);   // PERF-FIX #2

    function completeRoute() {
        pushUndoState("Route erstellt");
        calcRouteLength(route);
        route.elevation = 0;
        calcRouteNoA(route);
        calcRouteRunTime(route);
        calcRouteSide(cp, route);
        cp.routes.push(route);
        saveRoute(cp, route);
        _autoUpgradeComplex(cp);
        selection.nr = route.order;
        drawRoutes();
        updateRoutes();
        // Start a fresh route
        route     = { id: null, order: cp.routes.length, rP: [], noA: null, pos: null, length: null, run_time: null, elevation: null };
        previewPt = null;
        clearEditLayer();
        updateCPList();
        requestAnimationFrame(() => {
            document.querySelector(".cp-route-row.selected")
                ?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
    }

    const gesture = makePendingGesture({
        onDrag(downEvent) { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e, pt) {
            if (!cp || !route) return;

            if (route.rP.length === 0) {
                if (!cp.start) return;
                const snappedStart = snapToStartPt(pt);
                const isStartClick = Math.hypot(snappedStart.x - cp.start.x, snappedStart.y - cp.start.y) <= 0.5;
                if (!isStartClick) {
                    const targetCp = getControlPairFromElement(e.target);
                    if (targetCp && targetCp !== cp) {
                        const changed = targetCp.order !== selection.ncp;
                        updateControlPairs(targetCp.order);
                        updateRoutes();
                        if (changed) centerOnControlPair(targetCp.order);
                        NewRouteTool.switchCp(targetCp);
                    }
                    return;
                }
                route.rP.push({ x: cp.start.x, y: cp.start.y });
            } else {
                const snapped = snapToZielPt(pt);
                route.rP.push({ x: snapped.x, y: snapped.y });
                if (cp.ziel && Math.hypot(snapped.x - cp.ziel.x, snapped.y - cp.ziel.y) < 1) {
                    completeRoute();
                    return;
                }
            }
            calcRouteLength(route);
            drawPreview();
            updateCPList();
        },
    });

    return {
        defaultCursor: "default",
        getPartialLength() { return route?.length ?? null; },

        init(controlPair) {
            cp        = controlPair;
            route     = { id: null, order: cp.routes.length, rP: [], noA: null, pos: null, length: null, run_time: null, elevation: null };
            previewPt = null;
            return this;
        },

        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("drawing-route");
            updateCPList();
        },

        onExit() {
            scheduleDraw.cancel();   // PERF-FIX #2
            gesture.cancel();
            mapContainer.classList.remove("drawing-route");
            clearEditLayer();
            hideCrosshair();
            cp = null; route = null; previewPt = null;
            updateCPList();
        },

        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },

        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            if (!mapContainer.contains(e.target)) {
                hideCrosshair();
                clearEditLayer();
                return;
            }
            previewPt = route?.rP?.length ? snapToZielPt(pt) : snapToStartPt(pt);
            updateCrosshair(previewPt.x, previewPt.y);
            scheduleDraw();   // PERF-FIX #2 (was drawPreview())
        },

        onKeyDown(e) {
            if (e.key === "Escape") activateTool(RouteTool);
        },

        isActive() { return activeTool === this; },

        switchCp(controlPair) {
            clearEditLayer();
            hideCrosshair();
            cp        = controlPair;
            route     = { id: null, order: cp.routes.length, rP: [], noA: null, pos: null, length: null, run_time: null, elevation: null };
            previewPt = null;
            updateCPList();
        },
    };
})();

/* =========================================================
    TOOL: ROUTE
    Click a route to select it.
    Click the already-selected route to enter edit mode.
    Drag on empty space pans.
========================================================= */

const RouteTool = (() => {
    function handleClick(target, pt) {
        const obj = getClickedObject(target);
        if (!obj) return;

        if (obj.type === "route") {
            const sameRoute = obj.ncp === selection.ncp && obj.nr === selection.nr;
            if (sameRoute) {
                const editable = findEditableRoutePoint(pt.x, pt.y);
                if (editable) {
                    activateTool(RouteEditTool.init(
                        obj.ncp, obj.nr,
                        editable.insertPoint,
                        editable.segmentIndex
                    ));
                    return;
                }
            }
            selection.ncp = obj.ncp;
            selection.nr  = obj.nr;
            updateControlPairs(obj.ncp);
            updateRoutes();
            return;
        }

        if (obj.type === "control-pair") {
            clickControlPairGroup(obj.element);
            requestAnimationFrame(() => document.querySelector(".cp-route-list")
                ?.scrollIntoView({ block: "center", behavior: "smooth" }));
        }
    }

    const gesture = makePendingGesture({
        onDrag(downEvent)  { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e, pt)     { handleClick(e.target, pt); },
    });

    return {
        defaultCursor: "default",
        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("mode-route");
            updateRoutes();
            updateCPList();
        },
        onExit() {
            mapContainer.classList.remove("mode-route");
            gesture.cancel();
            document.getElementById("ui-layer").innerHTML = "";
            updateRoutes();
            updateCPList();
        },
        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },
        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            const target = e.target;
            if (target.classList?.contains("route-hit")) {
                mapContainer.style.cursor = "pointer";
            } else {
                const group = target.closest?.(".control-pair-group");
                mapContainer.style.cursor = (group && !group.classList.contains("selected")) ? "pointer" : "default";
            }
        },
        onKeyDown(e) {},
    };
})();

/* =========================================================
    MASK LAYER
    Isolated module — no other tool touches this.
    Loads mask PNG, renders black→red, supports draw/erase.
========================================================= */

const MaskLayer = (() => {
    let brushR = 5;
    const BRUSH_MIN = 1;
    const BRUSH_MAX = 25;
    const MASK_IMPASSABLE = 0;
    const MASK_FAST = 241;
    const MASK_EXPANSION = 255 - 24;

    let canvas        = null;
    let ctx           = null;
    let maskData      = null;
    let loaded        = false;
    let lastMapFile   = null;
    let lastPx        = null;
    // PERF-FIX #4: record only the pixels touched during the current stroke
    // (pixelIndex -> value-before-stroke) instead of snapshotting the whole R
    // channel on mousedown and re-scanning the whole image on mouseup. The map
    // size is bounded by the painted area, not by the full WxH mask.
    let _strokePixels = null;
    let _saveTimer    = null;
    let _saveInFlight = false;
    let _saveQueued   = false;
    let _saveMapFile  = null;

    function ensureCanvas() {
        if (!canvas) {
            canvas = document.getElementById("mask-canvas");
            ctx    = canvas?.getContext("2d");
        }
    }

    // Re-render display canvas from maskData (black→red, rest→transparent)
    function renderDisplay() {
        if (!ctx || !maskData) return;
        const disp = ctx.createImageData(maskData.width, maskData.height);
        const s = maskData.data, d = disp.data;
        for (let i = 0; i < s.length; i += 4) {
            if (s[i] < 10) {   // black = impassable
                d[i] = 220; d[i+1] = 0; d[i+2] = 0; d[i+3] = 255;
            } else {
                d[i+3] = 0;    // transparent
            }
        }
        ctx.putImageData(disp, 0, 0);
    }

    function loadMask(mapFile) {
        ensureCanvas();
        if (!ctx || mapFile === lastMapFile) return;
        lastMapFile   = mapFile;
        _strokePixels = null;
        // Clear stale diffs — they were computed for a different canvas
        if (typeof clearMaskUndoStacks === "function") clearMaskUndoStacks();
        loaded = false;
        const stem = mapFile.replace(/\.[^.]+$/, "");
        const img  = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            canvas.width  = img.naturalWidth;
            canvas.height = img.naturalHeight;
            applyMapDimensions();
            // Store original greyscale mask data
            const tmp = document.createElement("canvas");
            tmp.width = img.naturalWidth; tmp.height = img.naturalHeight;
            const tc = tmp.getContext("2d");
            tc.drawImage(img, 0, 0);
            maskData = tc.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
            renderDisplay();
            loaded = true;
            // Hand the freshly-decoded greyscale to the client-side pathing
            // worker so the next CP auto-fire can answer without re-decoding.
            try { sendMaskToPathingWorker(mapFile, maskData); } catch (e) { console.warn("pathing worker: send mask failed", e); }
        };
        img.onerror = () => { loaded = false; };
        img.src = `/media/masks/mask_${stem}.png`;
    }

    function screenToMaskPx(clientX, clientY) {
        const w      = screenToWorld(clientX, clientY);
        const sc     = project.scale || 1;
        const mapImg = document.getElementById("map-img");
        const mapX = w.x / sc;
        const mapY = w.y / sc;
        const ratioX = canvas.width  / (mapImg.naturalWidth  || canvas.width);
        const ratioY = canvas.height / (mapImg.naturalHeight || canvas.height);
        return { x: mapX * ratioX, y: mapY * ratioY };
    }

    function darkenPixel(idx, value) {
        const d = maskData.data;
        if (d[idx] <= value) return false;
        if (_strokePixels) { const j = idx >> 2; if (!_strokePixels.has(j)) _strokePixels.set(j, d[idx]); }   // PERF-FIX #4
        d[idx] = d[idx+1] = d[idx+2] = value;
        d[idx+3] = 255;
        return true;
    }

    // Edit maskData pixels in a circle, then re-render display
    function editCircle(cx, cy, maskValue) {
        if (!maskData) return;
        const W  = maskData.width, H = maskData.height;
        const x0 = Math.max(0,   Math.floor(cx - brushR));
        const x1 = Math.min(W-1, Math.ceil (cx + brushR));
        const y0 = Math.max(0,   Math.floor(cy - brushR));
        const y1 = Math.min(H-1, Math.ceil (cy + brushR));
        const px0 = Math.max(0,   x0 - 1);
        const px1 = Math.min(W-1, x1 + 1);
        const py0 = Math.max(0,   y0 - 1);
        const py1 = Math.min(H-1, y1 + 1);
        const r2 = brushR * brushR;
        const d  = maskData.data;
        const touchedBlack = [];
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if ((x-cx)*(x-cx) + (y-cy)*(y-cy) <= r2) {
                    const j = y * W + x;
                    const i = j * 4;
                    if (_strokePixels && !_strokePixels.has(j)) _strokePixels.set(j, d[i]);   // PERF-FIX #4
                    d[i] = d[i+1] = d[i+2] = maskValue;
                    d[i+3] = 255;
                    if (maskValue === MASK_IMPASSABLE) touchedBlack.push(j);
                }
            }
        }
        if (maskValue === MASK_IMPASSABLE) {
            for (const idx of touchedBlack) {
                const x = idx % W;
                const y = Math.floor(idx / W);
                for (let dy = -1; dy <= 1; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= H) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx;
                        if (nx < 0 || nx >= W) continue;
                        const ni = (ny * W + nx) * 4;
                        if (d[ni] !== MASK_IMPASSABLE) darkenPixel(ni, MASK_EXPANSION);
                    }
                }
            }
        }
        // Re-render only the affected region
        const patch = ctx.createImageData(px1-px0+1, py1-py0+1);
        const pd = patch.data;
        for (let y = py0; y <= py1; y++) {
            for (let x = px0; x <= px1; x++) {
                const si = (y * W + x) * 4;
                const pi = ((y-py0)*(px1-px0+1) + (x-px0)) * 4;
                if (d[si] < 10) {
                    pd[pi] = 220; pd[pi+1] = 0; pd[pi+2] = 0; pd[pi+3] = 255;
                } else {
                    pd[pi+3] = 0;
                }
            }
        }
        ctx.putImageData(patch, px0, py0);
    }

    function strokeLine(clientX, clientY, maskValue) {
        const cur = screenToMaskPx(clientX, clientY);
        if (!lastPx) {
            editCircle(cur.x, cur.y, maskValue);
        } else {
            const dx   = cur.x - lastPx.x;
            const dy   = cur.y - lastPx.y;
            const dist = Math.hypot(dx, dy);
            const step = Math.max(1, brushR * 0.5);
            const n    = Math.ceil(dist / step);
            for (let i = 0; i <= n; i++) {
                const t = n === 0 ? 1 : i / n;
                editCircle(lastPx.x + dx * t, lastPx.y + dy * t, maskValue);
            }
        }
        lastPx = cur;
    }

    function applyMapDimensions() {
        if (!canvas) return;
        const mapImg = document.getElementById("map-img");
        if (mapImg.naturalWidth) {
            canvas.style.width  = mapImg.naturalWidth  + "px";
            canvas.style.height = mapImg.naturalHeight + "px";
        } else {
            mapImg.addEventListener("load", applyMapDimensions, { once: true });
        }
    }

    function nearestPassableMapPoint(point, maxMetres = CONTROL_POINT_PASSABLE_SNAP_M) {
        if (!maskData || !point) return null;
        const W = maskData.width;
        const H = maskData.height;
        const data = maskData.data;
        const gx = Math.round(Number(point.x) / PATHING_MASK_TRAIN_SCALE);
        const gy = Math.round(Number(point.y) / PATHING_MASK_TRAIN_SCALE);
        if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
        if (gx < 0 || gx >= W || gy < 0 || gy >= H) return null;

        function passable(x, y) {
            return x >= 0 && x < W && y >= 0 && y < H && data[(y * W + x) * 4] >= 10;
        }

        if (passable(gx, gy)) return { x: point.x, y: point.y };

        const maxMapPx = maxMetres / PX_TO_M;
        const maxGridPx = Math.ceil(maxMapPx / PATHING_MASK_TRAIN_SCALE);
        let best = null;
        let bestD2 = Infinity;
        for (let r = 1; r <= maxGridPx; r++) {
            for (let dy = -r; dy <= r; dy++) {
                const ys = gy + dy;
                const xs = [gx - r, gx + r];
                for (const x of xs) {
                    if (!passable(x, ys)) continue;
                    const d2 = (x - gx) * (x - gx) + dy * dy;
                    if (d2 < bestD2) { bestD2 = d2; best = { x, y: ys }; }
                }
            }
            for (let dx = -r + 1; dx <= r - 1; dx++) {
                const xs = gx + dx;
                const ys = [gy - r, gy + r];
                for (const y of ys) {
                    if (!passable(xs, y)) continue;
                    const d2 = dx * dx + (y - gy) * (y - gy);
                    if (d2 < bestD2) { bestD2 = d2; best = { x: xs, y }; }
                }
            }
            if (best) {
                const snappedMap = {
                    x: best.x * PATHING_MASK_TRAIN_SCALE,
                    y: best.y * PATHING_MASK_TRAIN_SCALE,
                };
                const movedM = Math.hypot(snappedMap.x - point.x, snappedMap.y - point.y) * PX_TO_M;
                return movedM <= maxMetres ? snappedMap : null;
            }
        }
        return null;
    }

    return {
        clearMask() {
            ensureCanvas();
            if (ctx && canvas.width && canvas.height)
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            maskData      = null;
            loaded        = false;
            lastMapFile   = null;
            _strokePixels = null;
        },
        loadMask,
        applyMapDimensions,
        screenToMaskPx,
        nearestPassableMapPoint,
        isLoaded:    () => loaded,
        resetStroke: ()  => { lastPx = null; },
        getBrush:    ()      => brushR,
        getBrushMin: ()      => BRUSH_MIN,
        getBrushMax: ()      => BRUSH_MAX,
        setBrush:    (r)     => { brushR = Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, r)); },
        adjustBrush: (delta) => { brushR = Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, brushR - delta)); },
        brushScreenRadius() {
            if (!canvas) return 0;
            const mapImg = document.getElementById("map-img");
            const ratioX = canvas.width / (mapImg.naturalWidth || canvas.width);
            return brushR / ratioX * (project.scale || 1) * camera.zoom;
        },
        draw(clientX, clientY)  { strokeLine(clientX, clientY, MASK_IMPASSABLE); },
        erase(clientX, clientY) { strokeLine(clientX, clientY, MASK_FAST); },

        // ── Diff-based undo support ────────────────────────────
        startStroke() {
            if (!maskData) return;
            // PERF-FIX #4: begin with an empty change-record; pixels are captured
            // lazily as the brush touches them (see editCircle / darkenPixel).
            _strokePixels = new Map();
        },
        finishStroke() {
            if (!_strokePixels || !maskData) { _strokePixels = null; return null; }
            const src = maskData.data;
            const idxBuf = [], oldBuf = [], newBuf = [];
            // PERF-FIX #4: iterate only the touched pixels, not the whole image.
            for (const [j, o] of _strokePixels) {
                const n = src[j * 4];
                if (o !== n) { idxBuf.push(j); oldBuf.push(o); newBuf.push(n); }
            }
            _strokePixels = null;
            if (!idxBuf.length) return null;
            return {
                indices: new Uint32Array(idxBuf),
                oldVals: new Uint8Array(oldBuf),
                newVals: new Uint8Array(newBuf),
            };
        },
        applyDiff(diff, reverse) {
            if (!diff || !maskData) return;
            const vals   = reverse ? diff.oldVals : diff.newVals;
            const d      = maskData.data;
            const maxIdx = maskData.width * maskData.height - 1;
            for (let k = 0; k < diff.indices.length; k++) {
                const j = diff.indices[k];
                if (j > maxIdx) continue;   // skip stale indices from a different canvas size
                const i = j * 4;
                d[i] = d[i+1] = d[i+2] = vals[k];
            }
            renderDisplay();
        },

        saveMask(mapFile) {
            if (!maskData) return;
            _saveMapFile = mapFile;
            _saveQueued = true;
            if (_saveTimer) clearTimeout(_saveTimer);
            _saveTimer = setTimeout(() => {
                _saveTimer = null;
                runQueuedSave();
            }, 120);

            function runQueuedSave() {
                if (_saveInFlight || !_saveQueued || !maskData) return;
                _saveQueued = false;
                _saveInFlight = true;
                const requestIdle = window.requestIdleCallback || (cb => setTimeout(cb, 0));
                requestIdle(() => saveNow(_saveMapFile), { timeout: 500 });
            }

            function saveNow(filename) {
                if (!maskData) { _saveInFlight = false; return; }
                const off  = document.createElement("canvas");
                off.width  = maskData.width;
                off.height = maskData.height;
                off.getContext("2d").putImageData(maskData, 0, 0);
                const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
                off.toBlob(blob => {
                    if (!blob) {
                        _saveInFlight = false;
                        if (_saveQueued) runQueuedSave();
                        return;
                    }
                    const form = new FormData();
                    form.append("filename", filename);
                    const stem = filename.replace(/\.[^.]+$/, "");
                    form.append("file", blob, `mask_${stem}.png`);
                    fetch("/editor/save-mask/", {
                        method:  "POST",
                        headers: { "X-CSRFToken": csrf },
                        body:    form,
                    }).catch(err => console.warn("Mask save failed:", err))
                      .finally(() => {
                          _saveInFlight = false;
                          if (_saveQueued) runQueuedSave();
                      });
                }, "image/png");
            }
        },
    };
})();

/* =========================================================
    MASK UNDO / REDO  (diff-based, independent of project undo)
========================================================= */

const MASK_UNDO_MAX  = 30;
let maskUndoStack    = [];
let maskRedoStack    = [];

function clearMaskUndoStacks() {
    maskUndoStack = [];
    maskRedoStack = [];
    // Also remove any mask sentinels from the main undo/redo stacks
    undoStack = undoStack.filter(s => !s.isMaskUndo);
    redoStack = redoStack.filter(s => !s.isMaskUndo);
    updateUndoMenu();
}
window.clearMaskUndoStacks = clearMaskUndoStacks;

function pushMaskDiff(diff) {
    if (!diff) return;
    maskUndoStack.push(diff);
    if (maskUndoStack.length > MASK_UNDO_MAX) maskUndoStack.shift();
    maskRedoStack = [];
    // Mirror into main undo stack so it appears in the dropdown
    undoStack.push({ label: "Maske bearbeitet", isMaskUndo: true });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack = [];
    updateUndoMenu();
}

function undoMask() {
    if (!maskUndoStack.length) return;
    const diff = maskUndoStack.pop();
    maskRedoStack.push(diff);
    MaskLayer.applyDiff(diff, true);   // reverse: restore old values
    sendMaskDiffToPathingWorker(project.map_file, diff, true);
    MaskLayer.saveMask(project.map_file);
}

function redoMask() {
    if (!maskRedoStack.length) return;
    const diff = maskRedoStack.pop();
    maskUndoStack.push(diff);
    MaskLayer.applyDiff(diff, false);  // forward: restore new values
    sendMaskDiffToPathingWorker(project.map_file, diff, false);
    MaskLayer.saveMask(project.map_file);
}

/* =========================================================
    TOOL: MASK
========================================================= */

const MaskTool = (() => {
    let painting = false;

    function sub() { return getSubtool(ToolMode.MASK); }
    function brushCursorEl() { return document.getElementById("mask-brush-cursor"); }

    return {
        defaultCursor: "grab",

        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("mode-mask");
            document.body.classList.add("mode-mask");
            showMaskGenBarIfActive();

            const maskCanvas    = document.getElementById("mask-canvas");
            const opacitySlider = document.getElementById("mask-opacity-slider");
            const sizeSlider    = document.getElementById("mask-size-slider");

            if (opacitySlider) {
                if (!maskCanvas.style.opacity) maskCanvas.style.opacity = "0.67";
                opacitySlider.value   = maskCanvas.style.opacity;
                opacitySlider.oninput = () => { maskCanvas.style.opacity = opacitySlider.value; };
            }
            if (sizeSlider) {
                sizeSlider.min   = MaskLayer.getBrushMin();
                sizeSlider.max   = MaskLayer.getBrushMax();
                sizeSlider.value = MaskLayer.getBrush();
                sizeSlider.oninput = () => {
                    MaskLayer.setBrush(Number(sizeSlider.value));
                    const el = document.getElementById("mask-brush-cursor");
                    if (el && el.style.display === "block") {
                        const r = MaskLayer.brushScreenRadius();
                        el.style.width  = r * 2 + "px";
                        el.style.height = r * 2 + "px";
                    }
                };
            }
        },

        onExit() {
            mapContainer.classList.remove("mode-mask", "mask-editing");
            document.body.classList.remove("mode-mask");
            if (!editorSettings.auto_pathfind) hideMaskGenBar();
            painting = false;
            MaskLayer.resetStroke();
            brushCursorEl().style.display = "none";
        },

        onMouseDown(e, pt) {
            if (!mapContainer.contains(e.target)) return;
            if (e.button !== 0) return;
            if (sub() === "pan") { pan.start(e.clientX, e.clientY); return; }
            painting = true;
            MaskLayer.resetStroke();
            MaskLayer.startStroke();   // snapshot R channel before any painting
            if (sub() === "draw")  MaskLayer.draw(e.clientX, e.clientY);
            if (sub() === "erase") MaskLayer.erase(e.clientX, e.clientY);
        },

        onMouseMove(e, pt) {
            if (pan.update(e)) return;
            const s = sub();
            if (s === "draw" || s === "erase") {
                mapContainer.style.cursor = "default";
                mapContainer.classList.add("mask-editing");
                const r  = MaskLayer.brushScreenRadius();
                const el = brushCursorEl();
                el.style.display = "block";
                el.style.left    = e.clientX + "px";
                el.style.top     = e.clientY + "px";
                el.style.width   = r * 2 + "px";
                el.style.height  = r * 2 + "px";
                if (painting) {
                    if (s === "draw")  MaskLayer.draw(e.clientX, e.clientY);
                    if (s === "erase") MaskLayer.erase(e.clientX, e.clientY);
                }
            } else {
                mapContainer.style.cursor = "grab";
                mapContainer.classList.remove("mask-editing");
                brushCursorEl().style.display = "none";
            }
        },

        onMouseUp(e, pt) {
            if (pan.stop()) return;
            const wasPainting = painting;
            painting = false;
            MaskLayer.resetStroke();
            if (wasPainting && project.map_file) {
                const diff = MaskLayer.finishStroke();
                pushMaskDiff(diff);              // mask-specific undo stack
                sendMaskDiffToPathingWorker(project.map_file, diff, false);
                MaskLayer.saveMask(project.map_file);
                project.has_mask = true;
            }
        },

        onKeyDown(e) {},
    };
})();

/* =========================================================
    TOOL: BLOCK
========================================================= */

// Editor accent color — also drives blocked terrain, place-CP preview, and route
// polyline fallback. Kept in sync with --cp-color in map_objects.css.
const CP_COLOR     = "#a033f0";
const BLOCK_COLOR  = CP_COLOR;
const BLOCK_SNAP   = 8;   // world-space snap distance (SVG units)

function ensureBlockedTerrain() {
    if (!project.blocked_terrain || typeof project.blocked_terrain !== "object") {
        project.blocked_terrain = { lines: [], areas: [] };
    }
    project.blocked_terrain.lines = project.blocked_terrain.lines || [];
    project.blocked_terrain.areas = project.blocked_terrain.areas || [];
}

function centerOnBlockObject(pts) {
    if (!editorSettings.auto_jump) return;
    // pts = [{x,y}, ...]
    const padding = 80;
    const minX = Math.min(...pts.map(p => p.x));
    const maxX = Math.max(...pts.map(p => p.x));
    const minY = Math.min(...pts.map(p => p.y));
    const maxY = Math.max(...pts.map(p => p.y));
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const rect  = mapContainer.getBoundingClientRect();
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    const newZoom = Math.min(Math.max(Math.min(
        rect.width  / (w + padding * 2),
        rect.height / (h + padding * 2)
    ), zoomMin), zoomMax);
    animateCamera({
        x:    rect.width  / 2 - midX * newZoom,
        y:    rect.height / 2 - midY * newZoom,
        zoom: newZoom,
    });
}

function updateBlockList() {
    const list = document.getElementById("block-list");
    if (!list) return;
    list.innerHTML = "";
    ensureBlockedTerrain();
    const bt = project.blocked_terrain;

    const makeRow = (label, pts, onDelete) => {
        const row = document.createElement("div");
        row.className = "cp-row";
        row.style.cssText = "cursor:pointer;";
        row.innerHTML = `
            <span class="cp-row-label" style="color:#a050e8;font-style:italic;">${label}</span>
            <button class="cp-delete-btn" title="Löschen">${icon("trash", "11px")}</button>
        `;
        row.addEventListener("click", e => {
            if (e.target.closest(".cp-delete-btn")) return;
            centerOnBlockObject(pts);
        });
        row.querySelector(".cp-delete-btn").addEventListener("click", e => {
            e.stopPropagation();
            onDelete();
            drawBlockedTerrain();
            updateBlockList();
        });
        list.appendChild(row);
    };

    bt.lines.forEach((seg, idx) => {
        makeRow("Linie", [seg.start, seg.end], () => bt.lines.splice(idx, 1));
    });

    bt.areas.forEach((area, idx) => {
        makeRow("Fl\u00e4che", area.points, () => bt.areas.splice(idx, 1));
    });
}

function drawBlockedTerrain() {
    const layer = document.getElementById("blocked-layer");
    if (!layer) return;
    layer.innerHTML = "";
    ensureBlockedTerrain();
    const bt = project.blocked_terrain;
    updateBlockList();

    bt.lines.forEach((seg, idx) => {
        // Wide hit strip
        const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
        hit.setAttribute("x1", seg.start.x); hit.setAttribute("y1", seg.start.y);
        hit.setAttribute("x2", seg.end.x);   hit.setAttribute("y2", seg.end.y);
        hit.setAttribute("stroke", "transparent");
        hit.setAttribute("stroke-width", "10");
        hit.setAttribute("pointer-events", "stroke");
        hit.dataset.blockIdx = idx; hit.dataset.blockType = "line";
        hit.classList.add("block-hit");
        // Visual line
        const vis = document.createElementNS("http://www.w3.org/2000/svg", "line");
        vis.setAttribute("x1", seg.start.x); vis.setAttribute("y1", seg.start.y);
        vis.setAttribute("x2", seg.end.x);   vis.setAttribute("y2", seg.end.y);
        vis.setAttribute("stroke", BLOCK_COLOR);
        vis.setAttribute("stroke-width", "5");
        vis.setAttribute("stroke-linecap", "butt");
        vis.setAttribute("vector-effect", "non-scaling-stroke");
        layer.appendChild(vis);
        layer.appendChild(hit);
    });

    bt.areas.forEach((area, idx) => {
        if (area.points.length < 3) return;
        const pts = area.points.map(p => `${p.x},${p.y}`).join(" ");
        // Fill with hatch
        const fill = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        fill.setAttribute("points", pts);
        fill.setAttribute("fill", "url(#block-hatch)");
        fill.setAttribute("fill-opacity", "1");
        fill.setAttribute("stroke", BLOCK_COLOR);
        fill.setAttribute("stroke-width", "1");
        fill.setAttribute("stroke-linejoin", "miter");
        fill.setAttribute("vector-effect", "non-scaling-stroke");
        fill.setAttribute("pointer-events", "fill");
        fill.dataset.blockIdx = idx; fill.dataset.blockType = "area";
        fill.classList.add("block-hit");
        layer.appendChild(fill);
    });
}

const _blockEraserCursor = (() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 576 512"><path fill="%23ff6666" d="M178.5 416l123 0 65.3-65.3-173.5-173.5-126.7 126.7 112 112zM224 480l-45.5 0c-17 0-33.3-6.7-45.3-18.7L17 345C6.1 334.1 0 319.4 0 304s6.1-30.1 17-41L263 17C273.9 6.1 288.6 0 304 0s30.1 6.1 41 17L527 199c10.9 10.9 17 25.6 17 41s-6.1 30.1-17 41l-135 135 120 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-288 0z"/></svg>`;
    return `url("data:image/svg+xml,${svg}") 0 0, pointer`;
})();

const BlockTool = (() => {
    let lineStart  = null;   // {x,y} world — line mode first point
    let polyPoints = [];     // [{x,y}] world — polygon points so far
    let previewPt  = null;   // current cursor in world coords

    function sub() { return getSubtool(ToolMode.BLOCK); }

    function snapToBlockSnap(pt) {
        ensureBlockedTerrain();
        const bt = project.blocked_terrain;

        // Collect all candidate snap points
        const candidates = [];

        // Polygon close-snap: first point of current in-progress polygon
        if (sub() === "polygon" && polyPoints.length >= 2)
            candidates.push(polyPoints[0]);

        // Existing line endpoints
        bt.lines.forEach(seg => {
            candidates.push(seg.start, seg.end);
        });

        // Existing polygon vertices
        bt.areas.forEach(area => {
            area.points.forEach(p => candidates.push(p));
        });

        // In-progress polygon points (other than first, already added)
        if (sub() === "polygon" && polyPoints.length > 1) {
            polyPoints.slice(1).forEach(p => candidates.push(p));
        }

        // Find closest within BLOCK_SNAP screen pixels
        let best = null, bestDist = BLOCK_SNAP;
        candidates.forEach(c => {
            const d = Math.hypot(pt.x - c.x, pt.y - c.y);
            if (d < bestDist) { bestDist = d; best = c; }
        });

        return best ?? pt;
    }

    // PERF: persistent preview nodes — line-mode line, polygon fill, polygon
    // single-segment line, and the start-point "close here" circle.
    const _bv = {};
    function bvEnsure() {
        if (!_bv.line) {
            _bv.line     = svgNode("line", { stroke: BLOCK_COLOR, "stroke-width": "5",
                "stroke-linecap": "butt", "vector-effect": "non-scaling-stroke" });
            _bv.poly     = svgNode("polygon", { fill: "url(#block-hatch)", "fill-opacity": "1",
                stroke: BLOCK_COLOR, "stroke-width": "1", "stroke-linejoin": "miter", "vector-effect": "non-scaling-stroke" });
            _bv.polyLine = svgNode("line", { stroke: BLOCK_COLOR, "stroke-width": "1", "vector-effect": "non-scaling-stroke" });
            _bv.startC   = svgNode("circle", { r: BLOCK_SNAP, fill: "none", stroke: BLOCK_COLOR,
                "stroke-width": "1", "stroke-dasharray": "3 2", "vector-effect": "non-scaling-stroke" });
        }
        ensureInLayer(_bv.poly,     "edit-layer");
        ensureInLayer(_bv.line,     "edit-layer");
        ensureInLayer(_bv.polyLine, "edit-layer");
        ensureInLayer(_bv.startC,   "edit-layer");   // on top
    }

    function drawPreview() {
        bvEnsure();
        const S = sub();
        if (!previewPt) { hideNode(_bv.line); hideNode(_bv.poly); hideNode(_bv.polyLine); hideNode(_bv.startC); return; }

        // Line mode
        if (S === "line" && lineStart) {
            _bv.line.setAttribute("x1", lineStart.x); _bv.line.setAttribute("y1", lineStart.y);
            _bv.line.setAttribute("x2", previewPt.x); _bv.line.setAttribute("y2", previewPt.y);
            showNode(_bv.line);
        } else {
            hideNode(_bv.line);
        }

        // Polygon mode
        if (S === "polygon" && polyPoints.length > 0) {
            const pts = [...polyPoints, previewPt].map(p => `${p.x},${p.y}`).join(" ");
            if (polyPoints.length >= 2) {
                _bv.poly.setAttribute("points", pts); showNode(_bv.poly);
                hideNode(_bv.polyLine);
            } else {
                _bv.polyLine.setAttribute("x1", polyPoints[0].x); _bv.polyLine.setAttribute("y1", polyPoints[0].y);
                _bv.polyLine.setAttribute("x2", previewPt.x);     _bv.polyLine.setAttribute("y2", previewPt.y);
                showNode(_bv.polyLine);
                hideNode(_bv.poly);
            }
            // Circle around start point — indicates where to click to close
            _bv.startC.setAttribute("cx", polyPoints[0].x);
            _bv.startC.setAttribute("cy", polyPoints[0].y);
            showNode(_bv.startC);
        } else {
            hideNode(_bv.poly); hideNode(_bv.polyLine); hideNode(_bv.startC);
        }
    }

    const scheduleDraw = makeRafScheduler(drawPreview);   // PERF-FIX #2

    function handleClick(pt, evtTarget) {
        const S = sub();
        ensureBlockedTerrain();
        pt = snapToBlockSnap(pt);  // always use snapped coords

        if (S === "line") {
            if (!lineStart) {
                lineStart = { x: pt.x, y: pt.y };
            } else {
                pushUndoState("Sperrlinie hinzugefügt");
                project.blocked_terrain.lines.push({ start: lineStart, end: { x: pt.x, y: pt.y } });
                lineStart = null;
                clearEditLayer();
                drawBlockedTerrain();
                saveBlockedTerrain();
            }
        }

        if (S === "polygon") {
            if (polyPoints.length >= 3 && pt === polyPoints[0]) {
                pushUndoState("Sperrgebiet hinzugefügt");
                project.blocked_terrain.areas.push({ points: [...polyPoints] });
                polyPoints = [];
                clearEditLayer();
                drawBlockedTerrain();
                saveBlockedTerrain();
            } else {
                polyPoints.push({ x: pt.x, y: pt.y });
            }
        }

        if (S === "erase") {
            const hit = evtTarget?.closest?.(".block-hit");
            if (hit) {
                const idx  = Number(hit.dataset.blockIdx);
                const type = hit.dataset.blockType;
                pushUndoState("Sperrelement gelöscht");
                if (type === "line")  project.blocked_terrain.lines.splice(idx, 1);
                if (type === "area")  project.blocked_terrain.areas.splice(idx, 1);
                drawBlockedTerrain();
                saveBlockedTerrain();
            }
        }
    }

    const gesture = makePendingGesture({
        onDrag(downEvent) { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e, pt)    {
            if (!mapContainer.contains(e.target)) return;
            handleClick(pt, e.target);
        },
    });

    return {
        defaultCursor: "default",

        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("mode-block");
            document.body.classList.add("mode-block");
            selection.ncp = -1;
            mapContainer.querySelectorAll(".control-pair-group.selected")
                .forEach(el => el.classList.remove("selected"));
            drawBlockedTerrain();
        },

        onExit() {
            mapContainer.classList.remove("mode-block");
            document.body.classList.remove("mode-block");
            scheduleDraw.cancel();   // PERF-FIX #2
            gesture.cancel();
            clearEditLayer();
            hideCrosshair();
            lineStart = null; polyPoints = []; previewPt = null;
        },

        onMouseDown(e, pt) { if (e.button !== 0) return; gesture.down(e, pt); },
        onMouseUp(e, pt)   { if (e.button !== 0) return; gesture.up(e, pt); },

        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            const S = sub();
            if (S === "erase") {
                hideCrosshair();
                const hit = e.target?.closest?.(".block-hit");
                mapContainer.style.cursor = hit ? _blockEraserCursor : "default";
                return;
            }
            if (S === "line" || S === "polygon") {
                mapContainer.style.cursor = "default";
                if (!mapContainer.contains(e.target)) {
                    hideCrosshair();
                    clearEditLayer();
                    return;
                }
                previewPt = snapToBlockSnap(pt);
                updateCrosshair(previewPt.x, previewPt.y);
                if ((S === "line" && lineStart) || (S === "polygon" && polyPoints.length > 0)) {
                    scheduleDraw();   // PERF-FIX #2 (was drawPreview())
                }
            }
        },

        onKeyDown(e) {
            if (e.key === "Escape") {
                lineStart = null; polyPoints = [];
                clearEditLayer();
            }
        },
    };
})();

/* =========================================================
    TOOL: VIEW (no active tool — pan/zoom only)
========================================================= */

const ViewTool = (() => {
    const gesture = makePendingGesture({
        onDrag(downEvent) { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e) { clickControlPairGroup(e.target); },
    });
    return {
        defaultCursor: "grab",
        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            updateRoutes();
        },
        onExit()  { gesture.cancel(); },
        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },
        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            const group = e.target.closest?.(".control-pair-group");
            mapContainer.style.cursor = (group && !group.classList.contains("selected"))
                ? "pointer"
                : "grab";
        },
        onKeyDown(e) {},
    };
})();

/* =========================================================
    TOOL: PLACE CONTROL
    Two-click placement: first click sets start, second sets
    ziel. Then auto-advances to place the next control.
    Escape cancels the in-progress control.
========================================================= */

const PlaceControlTool = (() => {
    let cp          = null;
    let placing     = "start"; // "start" | "ziel"
    let tempStart   = null;
    let isOverwrite = false;
    let savedStart  = null;
    let savedZiel   = null;

    const STROKE = CP_COLOR;
    const SW     = "3";

    function svgEl(tag) { return document.createElementNS("http://www.w3.org/2000/svg", tag); }

    function snapToControlPoints(pt) {
        for (const c of project.control_pairs) {
            if (c === cp) continue;
            for (const field of ["start", "ziel"]) {
                const p = c[field];
                if (!p) continue;
                if (Math.hypot(pt.x - p.x, pt.y - p.y) <= SNAP_DISTANCE_CONTROL_PAIR)
                    return { x: p.x, y: p.y };
            }
        }
        return pt;
    }

    function drawCircleAt(layer, pt) {
        const circle = svgEl("circle");
        circle.setAttribute("cx", pt.x);
        circle.setAttribute("cy", pt.y);
        circle.setAttribute("r",  R_CONTROL);
        circle.setAttribute("fill", "transparent");
        circle.setAttribute("stroke", STROKE);
        circle.setAttribute("stroke-width", SW);
        circle.setAttribute("vector-effect", "non-scaling-stroke");
        layer.appendChild(circle);
    }

    // PERF: persistent preview nodes (cursor circle, placed-start circle,
    // connection line) — updated in place instead of clear+recreate per frame.
    const _pv = {};
    function pvEnsure() {
        if (!_pv.cursor) {
            const mkCircle = () => svgNode("circle", { r: R_CONTROL, fill: "transparent",
                stroke: STROKE, "stroke-width": SW, "vector-effect": "non-scaling-stroke" });
            _pv.cursor = mkCircle();
            _pv.start  = mkCircle();
            _pv.line   = svgNode("line", { stroke: STROKE, "stroke-width": SW, "vector-effect": "non-scaling-stroke" });
        }
        ensureInLayer(_pv.cursor, "edit-layer");
        ensureInLayer(_pv.start,  "edit-layer");
        ensureInLayer(_pv.line,   "edit-layer");
    }

    function drawPreview(pt) {
        pvEnsure();

        // Cursor circle
        _pv.cursor.setAttribute("cx", pt.x);
        _pv.cursor.setAttribute("cy", pt.y);
        showNode(_pv.cursor);

        // Placed start circle + connection line (ziel phase)
        if (placing === "ziel" && tempStart) {
            _pv.start.setAttribute("cx", tempStart.x);
            _pv.start.setAttribute("cy", tempStart.y);
            showNode(_pv.start);

            const dx   = pt.x - tempStart.x;
            const dy   = pt.y - tempStart.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 2 * (R_CONTROL + GAP)) {
                const angle  = Math.atan2(dy, dx);
                const offset = R_CONTROL + GAP;
                _pv.line.setAttribute("x1", tempStart.x + Math.cos(angle) * offset);
                _pv.line.setAttribute("y1", tempStart.y + Math.sin(angle) * offset);
                _pv.line.setAttribute("x2", pt.x - Math.cos(angle) * offset);
                _pv.line.setAttribute("y2", pt.y - Math.sin(angle) * offset);
                showNode(_pv.line);
            } else {
                hideNode(_pv.line);
            }
        } else {
            hideNode(_pv.start);
            hideNode(_pv.line);
        }
    }

    // PERF-FIX #2: coalesce preview redraws; latest snapped point is read here.
    let _previewSnapped = null;
    const scheduleDraw = makeRafScheduler(() => { if (_previewSnapped) drawPreview(_previewSnapped); });

    function reset() {
        cp          = null;
        tempStart   = null;
        placing     = "start";
        isOverwrite = false;
        savedStart  = null;
        savedZiel   = null;
    }

    function cancelCurrent() {
        if (!cp) return;
        if (isOverwrite) {
            cp.start = savedStart;
            cp.ziel  = savedZiel;
            clearEditLayer();
            if (cp.start && cp.ziel) drawControlPairGroup(cp);
        } else {
            project.control_pairs = project.control_pairs.filter(c => c !== cp);
            clearEditLayer();
        }
        hideCrosshair();
        reset();
        updateCPList();
    }

    const gesture = makePendingGesture({
        onDrag(downEvent) { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e, pt) {
            if (placing === "start") {
                const snapped = _movePointToNearestPassableIfImpassable(snapToControlPoints(pt));
                tempStart = { x: snapped.x, y: snapped.y };
                placing   = "ziel";
                updateCPList();
            } else {
                const snapped = _movePointToNearestPassableIfImpassable(snapToControlPoints(pt));
                pushUndoState(isOverwrite ? "Posten neu gezeichnet" : "Posten erstellt");
                cp.start = tempStart;
                cp.ziel  = { x: snapped.x, y: snapped.y };
                if (!isOverwrite) {
                    cp.order = project.control_pairs.length;
                    project.control_pairs.push(cp);
                } else {
                    cp.routes.forEach(r => deleteRoute(cp, r));
                    cp.routes = [];
                }
                saveControlPair(cp);
                clearEditLayer();
                document.getElementById("control-layer")
                    .querySelector(`.control-pair-group[data-ncp="${cp.order}"]`)?.remove();
                drawControlPairGroup(cp);
                drawRoutes();
                updateRoutes();
                updateControlPairs(cp.order);
                const confirmedOrder = cp.order;
                const confirmedCp    = cp;
                reset();

                // auto-fire client Î¸* only. The worker generates the
                // simplified A* polyline (route 1) and the Î¸* polyline
                // (route 2) so the user can visually diff what Î¸* added on
                // top of A*.
                requestAutoPathfindForControlPair(confirmedCp);

                const isLast = !project.control_pairs.some(c => c.order > confirmedOrder);
                if (isLast) {
                    startNewPlacement();
                } else {
                    setTool(ToolMode.CONTROL_PAIR);
                }
                requestAnimationFrame(() => {
                    if (!project.control_pairs.includes(confirmedCp)) return;
                    ensureControlPairGroupDrawn(confirmedCp);
                    updateControlPairs(confirmedOrder);
                });
            }
        },
    });

    return {
        defaultCursor: "default",

        init(controlPair, overwrite = false) {
            reset();
            cp          = controlPair;
            isOverwrite = overwrite;
            if (overwrite) {
                savedStart = cp.start ? { ...cp.start } : null;
                savedZiel  = cp.ziel  ? { ...cp.ziel  } : null;
                document.getElementById("control-layer")
                    .querySelector(`.control-pair-group[data-ncp="${cp.order}"]`)?.remove();
            }
            return this;
        },

        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("placing-control");
            // Keep selection.ncp AND the .selected CSS class on the group, so the
            // just-created control pair stays highlighted after auto-startNewPlacement
            // and its routes (auto-generated) remain visible in the cp-list sub-list
            // during the next placement.
            updateCPList();
        },

        onExit() {
            scheduleDraw.cancel();   // PERF-FIX #2
            gesture.cancel();
            mapContainer.classList.remove("placing-control");
            if (cp) cancelCurrent();
            else reset();
        },

        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },

        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            if (!mapContainer.contains(e.target)) {
                scheduleDraw.cancel();   // PERF-FIX #2: no late preview redraw
                hideCrosshair();
                pvEnsure();
                hideNode(_pv.cursor);
                hideNode(_pv.line);
                if (placing === "ziel" && tempStart) {
                    _pv.start.setAttribute("cx", tempStart.x);
                    _pv.start.setAttribute("cy", tempStart.y);
                    showNode(_pv.start);
                } else {
                    hideNode(_pv.start);
                }
                return;
            }
            const snapped = snapToControlPoints(pt);
            updateCrosshair(snapped.x, snapped.y);
            _previewSnapped = snapped;
            scheduleDraw();   // PERF-FIX #2 (was drawPreview(snapped))
        },

        onKeyDown(e) {
            if (e.key === "Escape") {
                cancelCurrent();
                setTool(ToolMode.CONTROL_PAIR);
            }
        },

        isPlacingZiel() { return placing === "ziel"; },
    };
})();

/* =========================================================
    TOOL REGISTRY
    ToolMode strings must match the data-tool attributes in
    the HTML toolbar segments.
========================================================= */

const ToolMode = {
    CONTROL_PAIR: "control_pair",
    ROUTE:        "route",
    MASK:         "mask",
    BLOCK:        "block",
    NONE:         "no_tool",
};

const TOOLS = {
    [ToolMode.CONTROL_PAIR]: ControlPairTool,
    [ToolMode.ROUTE]:        RouteTool,
    [ToolMode.MASK]:         MaskTool,
    [ToolMode.BLOCK]:        BlockTool,
    [ToolMode.NONE]:         ViewTool,
};

/* =========================================================
    ACTIVE TOOL & TOOL SWITCHER
========================================================= */

let activeTool = ControlPairTool;

function activateTool(toolObj) {
    if (activeTool === toolObj) return;
    activeTool.onExit?.();
    activeTool = toolObj;
    activeTool.onEnter?.();
    mapContainer.style.cursor = toolObj.defaultCursor ?? "default";
    updateSubtoolPanel(currentToolMode);
}

/* =========================================================
    INPUT DISPATCHER
    Pan intercepts move/up at the top level so every tool
    gets pan for free without duplicating the logic.
========================================================= */

/* =========================================================
    RADIAL CONTEXT MENU
    Right-click (quick) → no_tool
    Right-click hold/drag → floating circular tool+subtool picker
========================================================= */

const RCM = (() => {
    // 4 tools in N/E/S/W positions; no_tool lives in the centre circle
    const IR1 = 30, IR2 = 78;
    const OR1 = IR2, OR2 = 130;          // outer ring directly attached (OR1 == IR2)
    const CLICK_MS = 200, MOVE_PX = 8;

    const MENU_TOOLS = [ToolMode.CONTROL_PAIR, ToolMode.ROUTE, ToolMode.MASK, ToolMode.BLOCK];
    // Clockwise from North: CP(N) Route(E) Mask(S) Block(W)
    const TOOL_ICON  = {
        [ToolMode.CONTROL_PAIR]: "control_pair",
        [ToolMode.ROUTE]:        "route",
        [ToolMode.MASK]:         "mask",
        [ToolMode.BLOCK]:        "block",
    };
    const N = 4, SECTOR = 90;
    // Segments start at -135° so each midpoint is exactly N/E/S/W
    // N mid=-90°, E mid=0°, S mid=90°, W mid=180°

    let menuEl = null, overlayEl = null;
    let downAt = 0, downPos = null;
    let hoveredTool = null, hoveredSub = null, open = false;
    let sticky = false;
    let lastRightUpTime = 0;
    let escHandler = null;
    const DBLCLICK_MS = 400;

    const rad    = d => d * Math.PI / 180;
    // Segments start at -135° → midpoints at -90(N), 0(E), 90(S), 180(W)
    const segA1  = i => -135 + i * SECTOR;
    const segMid = i => segA1(i) + SECTOR / 2;

    // Colors matching the sidebar tool wheel
    const COL_DARK   = "#252525";
    const COL_ORANGE = "#e07020";
    const COL_HOVER  = "#f08030"; // slightly brighter on hover-of-hover

    function slicePath(r1, r2, a1, a2) {
        const large = (a2 - a1) >= 180 ? 1 : 0;
        const c = (r, a) => [r*Math.cos(rad(a)), r*Math.sin(rad(a))];
        const [ax,ay] = c(r1,a1), [bx,by] = c(r2,a1);
        const [cx2,cy2] = c(r2,a2), [dx,dy] = c(r1,a2);
        return `M${ax} ${ay}L${bx} ${by}A${r2} ${r2} 0 ${large} 1 ${cx2} ${cy2}L${dx} ${dy}A${r1} ${r1} 0 ${large} 0 ${ax} ${ay}Z`;
    }

    const svgNS = "http://www.w3.org/2000/svg";
    const svgEl = (tag, attrs={}) => {
        const e = document.createElementNS(svgNS, tag);
        Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k, v));
        return e;
    };

    const ICON_SZ = 36;
    function iconFO(angleDeg, r, iconName, transform) {
        const a  = rad(angleDeg);
        const fo = svgEl("foreignObject", {
            x: r*Math.cos(a) - ICON_SZ/2, y: r*Math.sin(a) - ICON_SZ/2,
            width: ICON_SZ, height: ICON_SZ,
        });
        const div = document.createElement("div");
        div.style.cssText = `display:flex;align-items:center;justify-content:center;width:${ICON_SZ}px;height:${ICON_SZ}px;`;
        div.innerHTML = icon(iconName, "26px", transform);
        div.querySelectorAll("svg, path, rect, circle, polygon").forEach(e => e.style.fill = "white");
        fo.appendChild(div);
        return fo;
    }
    function centeredFO(iconName, transform) {
        const sz = ICON_SZ;
        const fo = svgEl("foreignObject", { x:-sz/2, y:-sz/2, width:sz, height:sz });
        const div = document.createElement("div");
        div.style.cssText = `display:flex;align-items:center;justify-content:center;width:${sz}px;height:${sz}px;`;
        div.innerHTML = icon(iconName, "26px", transform);
        div.querySelectorAll("svg, path, rect, circle, polygon").forEach(e => e.style.fill = "white");
        fo.appendChild(div);
        return fo;
    }

    function setIconColor(g, color) {
        g.querySelectorAll("foreignObject svg, foreignObject path, foreignObject rect, foreignObject circle, foreignObject polygon")
         .forEach(e => e.style.fill = color);
    }

    // No stroke — segments bound directly edge-to-edge
    function makeSegment(r1, r2, a1, a2, mid, iconName, transform, key, val, fill) {
        const g = svgEl("g"); g.dataset[key] = val;
        const path = svgEl("path", { d: slicePath(r1, r2, a1, a2), fill, stroke:"none" });
        g.appendChild(path);
        g.appendChild(iconFO(mid, (r1+r2)/2, iconName, transform));
        if (fill !== COL_DARK) setIconColor(g, "black");
        return g;
    }

    function buildMenu(x, y) {
        const size = (OR2 + 22) * 2;
        const svg  = svgEl("svg");
        svg.id = "rcm";
        svg.style.cssText = `position:fixed;left:${x-size/2}px;top:${y-size/2}px;`
            + `width:${size}px;height:${size}px;pointer-events:none;z-index:99999;`;
        svg.setAttribute("viewBox", `${-size/2} ${-size/2} ${size} ${size}`);

        // Inner ring — 4 segments, N/E/S/W
        const innerG = svgEl("g"); innerG.id = "rcm-inner";
        MENU_TOOLS.forEach((mode, i) => {
            const fill = mode === currentToolMode ? COL_ORANGE : COL_DARK;
            innerG.appendChild(makeSegment(IR1, IR2, segA1(i), segA1(i)+SECTOR,
                segMid(i), TOOL_ICON[mode], undefined, "mode", mode, fill));
        });
        svg.appendChild(innerG);

        // Outer ring (populated on hover)
        const outerG = svgEl("g"); outerG.id = "rcm-outer";
        svg.appendChild(outerG);

        // Centre circle — clicking here → no_tool
        const cFill = currentToolMode === ToolMode.NONE ? COL_ORANGE : COL_DARK;
        const cg = svgEl("g"); cg.id = "rcm-center";
        cg.appendChild(svgEl("circle", { cx:0, cy:0, r:IR1, fill:cFill, stroke:"none" }));
        cg.appendChild(centeredFO("lock"));
        if (cFill !== COL_DARK) setIconColor(cg, "black");
        svg.appendChild(cg);

        // Guide line on top
        const guide = svgEl("line", { id:"rcm-guide", x1:0, y1:0, x2:0, y2:0,
            stroke:"#000", "stroke-width":"1.2", "stroke-opacity":"0.6" });
        svg.appendChild(guide);

        return svg;
    }

    function rebuildOuter(mode) {
        const outerG = menuEl?.querySelector("#rcm-outer");
        if (!outerG) return;
        const oldGroups = outerG.querySelectorAll(".rcm-subtools");
        oldGroups.forEach(g => {
            g.classList.remove("rcm-subtools-enter");
            g.classList.add("rcm-subtools-exit");
            g.addEventListener("animationend", () => g.remove(), { once: true });
        });
        if (!mode || mode === ToolMode.NONE) return;
        const defs = SUBTOOL_DEFS[mode];
        if (!defs?.length) return;
        const subtoolsG = svgEl("g", { class: "rcm-subtools rcm-subtools-enter" });
        const base = segA1(MENU_TOOLS.indexOf(mode));
        const sub  = SECTOR / defs.length;
        defs.forEach((def, si) => {
            const a1 = base + si*sub;
            subtoolsG.appendChild(makeSegment(OR1, OR2, a1, a1+sub, a1+sub/2,
                def.icon, def.transform, "sub", def.id, COL_DARK));
        });
        outerG.appendChild(subtoolsG);
    }

    function hitTest(cx, cy) {
        if (!menuEl) return null;
        const r    = menuEl.getBoundingClientRect();
        const dx   = cx-(r.left+r.width/2), dy = cy-(r.top+r.height/2);
        const dist = Math.hypot(dx, dy);
        const norm = ((Math.atan2(dy,dx)*180/Math.PI)+135+360)%360; // offset so 0 = start of N segment

        // Centre circle → no_tool
        if (dist < IR1) return { ring:"center", mode: ToolMode.NONE, sub: null };

        const toolIdx = Math.floor(norm/SECTOR) % N;
        const mode    = MENU_TOOLS[toolIdx];
        const defs    = SUBTOOL_DEFS[mode];

        let sub = null;
        if (defs?.length) {
            const rel = (norm - toolIdx*SECTOR + 360) % 360;
            sub = defs[Math.min(Math.floor(rel/(SECTOR/defs.length)), defs.length-1)].id;
        }

        if (dist < IR2) return { ring:"inner",    mode, sub:null };
        if (dist < OR2) return { ring:(dist < OR1 ? "gap" : "outer"), mode, sub };
        return                 { ring:"extended",  mode, sub };
    }

    function segFill(isCurrentTool, isHovered) {
        if (isHovered && isCurrentTool) return COL_HOVER;  // brighter if already orange
        if (isHovered || isCurrentTool)  return COL_ORANGE;
        return COL_DARK;
    }

    function applySegmentState(g, isCurrentTool, isHovered, baseColor) {
        const fill = isHovered || isCurrentTool ? segFill(isCurrentTool, isHovered) : baseColor;
        const p = g.querySelector("path") || g.querySelector("circle");
        if (p) p.setAttribute("fill", fill);
        setIconColor(g, (isHovered || isCurrentTool) ? "black" : "white");
    }

    function updateHover(cx, cy) {
        if (!menuEl) return;

        const guide = menuEl.querySelector("#rcm-guide");
        if (guide) {
            const r = menuEl.getBoundingClientRect();
            guide.setAttribute("x2", cx-(r.left+r.width/2));
            guide.setAttribute("y2", cy-(r.top+r.height/2));
        }

        const hit     = hitTest(cx, cy);
        const newTool = hit?.mode ?? null;
        const newSub  = (hit && hit.ring !== "inner" && hit.ring !== "center") ? hit.sub : null;

        // Always keep the centre circle in sync (unconditional — it's cheap)
        const centerEl = menuEl.querySelector("#rcm-center circle");
        const centerFO = menuEl.querySelector("#rcm-center foreignObject");
        if (centerEl) {
            const isCenter  = hit?.ring === "center";
            const isCurNone = currentToolMode === ToolMode.NONE;
            centerEl.setAttribute("fill", (isCenter || isCurNone)
                ? (isCenter && isCurNone ? COL_HOVER : COL_ORANGE) : COL_DARK);
            if (centerFO) {
                const lit = isCenter || isCurNone;
                centerFO.querySelectorAll("svg, path, rect, circle, polygon")
                    .forEach(e => e.style.fill = lit ? "black" : "white");
            }
        }

        if (newTool !== hoveredTool) {
            hoveredTool = newTool;

            // Update inner tool segments
            menuEl.querySelectorAll("[data-mode]").forEach(g => {
                const isCurrent = g.dataset.mode === currentToolMode;
                const isHov     = g.dataset.mode === hoveredTool;
                applySegmentState(g, isCurrent, isHov, COL_DARK);
            });

            rebuildOuter(hoveredTool === ToolMode.NONE ? null : hoveredTool);
            menuEl.querySelectorAll("[data-sub]").forEach(g => {
                applySegmentState(g, false, g.dataset.sub === newSub, COL_DARK);
            });
        }
        if (newSub !== hoveredSub) {
            hoveredSub = newSub;
            menuEl.querySelectorAll("[data-sub]").forEach(g => {
                applySegmentState(g, false, g.dataset.sub === hoveredSub, COL_DARK);
            });
        }
    }

    function applySelection(tool, sub) {
        if (!tool || tool === ToolMode.NONE) { setTool(ToolMode.NONE); return; }
        if (sub) {
            activeSubtool[tool] = sub;
            if      (tool === ToolMode.CONTROL_PAIR && sub === "add") { setTool(tool); startNewPlacement(); }
            else if (tool === ToolMode.ROUTE        && sub === "new") { startNewRoute(); }
            else { setTool(tool); setSubtool(tool, sub); }
        } else {
            // Inner-ring selections always activate the "add" subtool for CP and Route
            if (tool === ToolMode.ROUTE) {
                activeSubtool[ToolMode.ROUTE] = "new";
                startNewRoute();
            } else if (tool === ToolMode.CONTROL_PAIR) {
                activeSubtool[ToolMode.CONTROL_PAIR] = "add";
                setTool(ToolMode.CONTROL_PAIR);
                startNewPlacement();
            } else {
                setTool(tool);
            }
        }
    }

    function openMenu(x, y) {
        open   = true;
        menuEl = buildMenu(x, y);

        overlayEl = document.createElement("div");
        overlayEl.style.cssText = "position:fixed;inset:0;z-index:99998;background:transparent;cursor:default;";
        overlayEl.addEventListener("mousemove",   e => updateHover(e.clientX, e.clientY));
        overlayEl.addEventListener("mouseup",     e => {
            if (e.button === 2 && sticky) { stickySelect(); return; }
            if (e.button === 2) RCM.onUp(e);
        });
        overlayEl.addEventListener("contextmenu", e => e.preventDefault());
        overlayEl.addEventListener("click", e => {
            if (!sticky) return;
            e.preventDefault();
            e.stopPropagation();
            stickySelect();
        });
        overlayEl.addEventListener("wheel", e => {
            if (hoveredTool !== ToolMode.MASK) return;
            if (hoveredSub !== "draw" && hoveredSub !== "erase") return;
            e.preventDefault();
            MaskLayer.adjustBrush(e.deltaY > 0 ? 1 : -1);
            const sizeSlider = document.getElementById("mask-size-slider");
            if (sizeSlider) sizeSlider.value = MaskLayer.getBrush();
            let ring = menuEl?.querySelector("#rcm-brush-ring");
            if (!ring) {
                ring = svgEl("circle", { id:"rcm-brush-ring", cx:0, cy:0, fill:"none",
                    stroke:"white", "stroke-width":"1.5", "stroke-dasharray":"4 3", opacity:"0.7" });
                menuEl?.appendChild(ring);
            }
            ring.setAttribute("r", MaskLayer.brushScreenRadius());
        }, { passive: false });

        escHandler = e => {
            if (e.key === "Escape" && open) {
                e.preventDefault();
                sticky = false;
                downPos = null;
                closeMenu();
                hoveredTool = null; hoveredSub = null;
            }
        };
        document.addEventListener("keydown", escHandler);

        document.body.appendChild(overlayEl);
        document.body.appendChild(menuEl);

        // Run an initial hover update so centre is already orange if cursor is there
        updateHover(x, y);
    }

    function closeMenu() {
        open = false;
        sticky = false;
        overlayEl?.remove(); overlayEl = null;
        menuEl?.remove();    menuEl    = null;
        if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
    }

    function stickySelect() {
        const _tool = hoveredTool, _sub = hoveredSub;
        closeMenu();
        hoveredTool = null; hoveredSub = null;
        applySelection(_tool, _sub);
    }

    return {
        onDown(e) {
            if (readOnly) return;
            if (sticky && open) return;
            downAt = Date.now(); downPos = {x:e.clientX, y:e.clientY};
            hoveredTool = null; hoveredSub = null; open = false;
        },
        onMove(e) {
            if (sticky && open) { updateHover(e.clientX, e.clientY); return; }
            if (!downPos) return;
            if (!open) {
                const moved = Math.hypot(e.clientX-downPos.x, e.clientY-downPos.y);
                if (moved > MOVE_PX || Date.now()-downAt > CLICK_MS) openMenu(downPos.x, downPos.y);
            }
            if (open) updateHover(e.clientX, e.clientY);
        },
        onUp(e) {
            if (sticky && open) return;
            // Guard against double-fire: overlay + window both emit mouseup
            if (!open && !downPos) return;
            const now = Date.now();
            if (!open && now - lastRightUpTime < DBLCLICK_MS) {
                sticky = true;
                openMenu(downPos.x, downPos.y);
                downPos = null;
                lastRightUpTime = 0;
                return;
            }
            lastRightUpTime = now;
            const wasOpen = open, _tool = hoveredTool, _sub = hoveredSub;
            downPos = null;
            closeMenu();
            hoveredTool = null; hoveredSub = null;
            applySelection(wasOpen ? _tool : null, wasOpen ? _sub : null);
        },
        cancel() { downPos = null; lastRightUpTime = 0; closeMenu(); },
    };
})();

function initInput() {
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);
    window.addEventListener("keydown",   onKeyDown);
    window.addEventListener("wheel",     onWheel, { passive: false });
    window.addEventListener("contextmenu", e => e.preventDefault());
    // PERF-FIX #1: keep the cached map rect fresh. Resize/scroll cover window
    // layout changes; ResizeObserver catches sidebar/panel toggles that resize
    // the container without firing a window resize.
    window.addEventListener("resize", invalidateMapRect);
    window.addEventListener("scroll", invalidateMapRect, true);
    const _mc = document.getElementById("map-container");
    if (window.ResizeObserver && _mc) new ResizeObserver(invalidateMapRect).observe(_mc);
    initTouchInput();
}

function initTouchInput() {
    let lastTouchDist = 0;
    let lastTouchMid = null;
    let touchPanning = false;

    mapContainer.addEventListener("touchstart", e => {
        if (!mapContainer.contains(e.target) || e.target.closest("#overview-sidebar")) return;
        if (e.touches.length === 2) {
            e.preventDefault();
            const t = e.touches;
            lastTouchDist = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
            lastTouchMid = { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
        } else if (e.touches.length === 1) {
            touchPanning = true;
            lastTouchMid = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
    }, { passive: false });

    mapContainer.addEventListener("touchmove", e => {
        if (!mapContainer.contains(e.target) || e.target.closest("#overview-sidebar")) return;
        if (e.touches.length === 2) {
            e.preventDefault();
            const t = e.touches;
            const dist = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
            const mid = { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
            const rect = mapContainer.getBoundingClientRect();
            const cx = mid.x - rect.left, cy = mid.y - rect.top;
            const wx = (cx - camera.x) / camera.zoom, wy = (cy - camera.y) / camera.zoom;
            const factor = dist / (lastTouchDist || dist);
            camera.zoom = Math.max(zoomMin, Math.min(zoomMax, camera.zoom * factor));
            camera.x = cx - wx * camera.zoom + (mid.x - lastTouchMid.x);
            camera.y = cy - wy * camera.zoom + (mid.y - lastTouchMid.y);
            updateCameraTransform();
            lastTouchDist = dist;
            lastTouchMid = mid;
            touchPanning = false;
        } else if (e.touches.length === 1 && touchPanning) {
            e.preventDefault();
            const dx = e.touches[0].clientX - lastTouchMid.x;
            const dy = e.touches[0].clientY - lastTouchMid.y;
            camera.x += dx;
            camera.y += dy;
            updateCameraTransform();
            lastTouchMid = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
    }, { passive: false });

    mapContainer.addEventListener("touchend", () => {
        lastTouchDist = 0;
        lastTouchMid = null;
        touchPanning = false;
    });
}

let _scaleDownPos    = null;   // screen pos at mousedown
let _scalePanStarted = false;  // true once pan.start() has been called in this gesture
const SCALE_PAN_THRESHOLD = 5;

function onMouseDown(e) {
    invalidateMapRect();   // PERF-FIX #1: refresh cached rect at the start of every gesture
    if (e.button === 2) { if (mapContainer.contains(e.target)) RCM.onDown(e); return; }
    if (e.button !== 0) return;
    if (!mapContainer.contains(e.target)) return;
    // Prevent the browser from selecting text in the navbar or elsewhere when
    // the user drags out of the map container during a pan or placement gesture.
    e.preventDefault();
    // Scaling mode owns the mouse entirely — no tool sees these events
    if (_scalingActive) {
        _scaleDownPos    = { x: e.clientX, y: e.clientY };
        _scalePanStarted = false;
        return;
    }
    if (CourseAlignMode.isActive() && CourseAlignMode.onMouseDown(e, screenToWorld(e.clientX, e.clientY))) return;
    activeTool.onMouseDown(e, screenToWorld(e.clientX, e.clientY));
}

function onMouseMove(e) {
    RCM.onMove(e);
    if (_scalingActive) {
        // Click-vs-pan decision based on screen-pixel movement
        if (_scaleDownPos && !_scalePanStarted) {
            const moved = Math.hypot(e.clientX - _scaleDownPos.x, e.clientY - _scaleDownPos.y);
            if (moved > SCALE_PAN_THRESHOLD) {
                pan.start(_scaleDownPos.x, _scaleDownPos.y);
                _scalePanStarted = true;
            }
        }
        if (pan.update(e)) return;   // pan in progress; freeze ruler
        _scaleHandleMove(e);
        return;
    }

    if (pan.update(e)) return;
    if (CourseAlignMode.isActive() && CourseAlignMode.onMouseMove(e, screenToWorld(e.clientX, e.clientY))) return;
    activeTool.onMouseMove(e, screenToWorld(e.clientX, e.clientY));
}

function onMouseUp(e) {
    if (e.button === 2) { RCM.onUp(e); return; }
    if (e.button !== 0) return;

    if (_scalingActive) {
        if (_scalePanStarted) {
            pan.stop();
            // pan.stop sets cursor to activeTool.defaultCursor — restore default
            mapContainer.style.cursor = "default";
        } else if (_scaleDownPos && mapContainer.contains(e.target)) {
            _scaleHandleUp(e);
        }
        _scaleDownPos    = null;
        _scalePanStarted = false;
        return;
    }

    if (pan.stop()) return;
    if (CourseAlignMode.isActive() && CourseAlignMode.onMouseUp(e, screenToWorld(e.clientX, e.clientY))) return;
    activeTool.onMouseUp(e, screenToWorld(e.clientX, e.clientY));
}

function onKeyDown(e) {
    activeTool.onKeyDown?.(e);
}

initInput();
updateCameraTransform();

/* =========================================================
    CONTROL PAIR — DRAW & INTERACT
========================================================= */

function drawControlPairGroup(controlPair) {
    const layer = document.getElementById("control-layer");
    layer.querySelector(`.control-pair-group[data-ncp="${controlPair.order}"]`)?.remove();
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("control-pair-group");
    if (controlPair.order === selection.ncp) group.classList.add("selected");
    group.dataset.ncp = controlPair.order;
    drawControlPair(controlPair, group);
    drawConnection(controlPair, group);
    layer.appendChild(group);
}

function ensureControlPairGroupDrawn(controlPair) {
    if (!controlPair?.start || !controlPair?.ziel) return;
    drawControlPairGroup(controlPair);
}

function drawControlPair(controlPair, parent) {
    const drawCircle = (point, pointType) => {
        if (!point) return;
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.classList.add("control-circle");
        circle.setAttribute("cx", point.x);
        circle.setAttribute("cy", point.y);
        circle.setAttribute("r", R_CONTROL);
        circle.setAttribute("fill", "transparent");
        // stroke + stroke-width are overridden by CSS (.control-pair-group rules
        // in map_objects.css); kept here as a fallback. Color source of truth: --cp-color.
        circle.setAttribute("stroke", CP_COLOR);
        circle.setAttribute("stroke-width", "2");
        circle.setAttribute("vector-effect", "non-scaling-stroke");
        circle.dataset.ncp  = controlPair.order;
        circle.dataset.type = pointType;
        parent.appendChild(circle);
    };
    drawCircle(controlPair.start, "start");
    drawCircle(controlPair.ziel,  "ziel");
}

function drawConnection(controlPair, parent) {
    if (!controlPair?.start || !controlPair?.ziel) return;
    const { start, ziel } = controlPair;
    const dx   = ziel.x - start.x;
    const dy   = ziel.y - start.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 2 * (R_CONTROL + GAP)) return;

    const angle  = Math.atan2(dy, dx);
    const offset = R_CONTROL + GAP;
    const x1 = start.x + Math.cos(angle) * offset;
    const y1 = start.y + Math.sin(angle) * offset;
    const x2 = ziel.x  - Math.cos(angle) * offset;
    const y2 = ziel.y  - Math.sin(angle) * offset;

    const setLineAttrs = (line, stroke, width) => {
        line.setAttribute("x1", x1);     line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);     line.setAttribute("y2", y2);
        line.setAttribute("stroke", stroke);
        line.setAttribute("stroke-width", width);
        line.setAttribute("fill", "none");
        line.setAttribute("vector-effect", "non-scaling-stroke");
    };

    const hitLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    setLineAttrs(hitLine, "transparent", "12");
    hitLine.setAttribute("pointer-events", "stroke");
    hitLine.dataset.ncp = controlPair.order;
    hitLine.classList.add("hit");

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    // stroke + width are overridden by CSS; source of truth is --cp-color in map_objects.css.
    setLineAttrs(line, CP_COLOR, "2");
    line.dataset.ncp = controlPair.order;

    drawConnectionArrow(start, ziel, angle, parent);
    parent.appendChild(line);
    parent.appendChild(hitLine);
}

function drawConnectionArrow(start, ziel, angle, parent) {
    const arrowSize  = 15;
    const arrowAngle = Math.PI / 6;
    const midX = (start.x + ziel.x + Math.cos(angle) * arrowSize / 2) / 2;
    const midY = (start.y + ziel.y + Math.sin(angle) * arrowSize / 2) / 2;

    const createLine = (x1, y1, x2, y2) => {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.classList.add("arrow");
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
        // stroke + width are overridden by CSS; source of truth is --cp-color in map_objects.css.
        line.setAttribute("stroke", CP_COLOR);
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("vector-effect", "non-scaling-stroke");
        return line;
    };

    parent.appendChild(createLine(
        midX, midY,
        midX - Math.cos(angle - arrowAngle) * arrowSize,
        midY - Math.sin(angle - arrowAngle) * arrowSize
    ));
    parent.appendChild(createLine(
        midX, midY,
        midX - Math.cos(angle + arrowAngle) * arrowSize,
        midY - Math.sin(angle + arrowAngle) * arrowSize
    ));
}

// PERF: in-place update of a control-pair group during drag. Moves the existing
// circle/line/arrow nodes (attribute updates) instead of remove()+recreate, which
// churns the DOM every frame and wakes password-manager MutationObservers into a
// full-document re-walk. Falls back to a full rebuild only when the connection's
// visibility must flip (endpoints crossing the minimum gap) — a rare 1-2 frames.
function updateControlPairDragVisual(cp) {
    if (!cp?.start || !cp?.ziel) { updateControlPairGroup(cp); return; }
    const group = document.getElementById("control-layer")
        ?.querySelector(`.control-pair-group[data-ncp="${cp.order}"]`);
    if (!group) { updateControlPairGroup(cp); return; }

    const circles = group.querySelectorAll(".control-circle");
    if (circles.length !== 2) { updateControlPairGroup(cp); return; }

    const { start, ziel } = cp;
    const dx = ziel.x - start.x, dy = ziel.y - start.y;
    const dist = Math.hypot(dx, dy);
    const showConn = dist > 2 * (R_CONTROL + GAP);

    const line   = group.querySelector("line:not(.hit):not(.arrow)");
    const hit    = group.querySelector("line.hit");
    const arrows = group.querySelectorAll("line.arrow");
    const haveConn = !!line && !!hit && arrows.length === 2;

    // Connection appearing/disappearing changes the node set — rebuild once.
    if (showConn !== haveConn) { updateControlPairGroup(cp); return; }

    circles.forEach(c => {
        const p = cp[c.dataset.type];
        if (p) { c.setAttribute("cx", p.x); c.setAttribute("cy", p.y); }
    });

    if (showConn) {
        const angle = Math.atan2(dy, dx), offset = R_CONTROL + GAP;
        const x1 = start.x + Math.cos(angle) * offset, y1 = start.y + Math.sin(angle) * offset;
        const x2 = ziel.x  - Math.cos(angle) * offset, y2 = ziel.y  - Math.sin(angle) * offset;
        for (const l of [line, hit]) {
            l.setAttribute("x1", x1); l.setAttribute("y1", y1);
            l.setAttribute("x2", x2); l.setAttribute("y2", y2);
        }
        const arrowSize = 15, arrowAngle = Math.PI / 6;
        const midX = (start.x + ziel.x + Math.cos(angle) * arrowSize / 2) / 2;
        const midY = (start.y + ziel.y + Math.sin(angle) * arrowSize / 2) / 2;
        const setArrow = (l, sign) => {
            l.setAttribute("x1", midX); l.setAttribute("y1", midY);
            l.setAttribute("x2", midX - Math.cos(angle + sign * arrowAngle) * arrowSize);
            l.setAttribute("y2", midY - Math.sin(angle + sign * arrowAngle) * arrowSize);
        };
        setArrow(arrows[0], -1);   // matches drawConnectionArrow's two lines
        setArrow(arrows[1], +1);
    }
}

function clickControlPairGroup(target) {
    const cp = getControlPairFromElement(target);
    if (!cp) return false;
    const ncp     = cp.order;
    const changed = ncp !== selection.ncp;
    updateControlPairs(ncp);
    updateRoutes();
    if (changed) centerOnControlPair(ncp);
    return true;
}

function getControlPairFromElement(target) {
    if (!target?.closest) return null;
    const group = target.closest(".control-pair-group");
    if (!group) return null;
    const ncp = Number(group.dataset.ncp);
    if (!Number.isFinite(ncp)) return null;
    return project.control_pairs.find(c => c.order === ncp) || null;
}

function updateControlPairs(ncp) {
    mapContainer.querySelectorAll(".control-pair-group.selected")
        .forEach(el => el.classList.remove("selected"));
    const group = mapContainer.querySelector(`.control-pair-group[data-ncp="${ncp}"]`);
    if (!group) return false;
    selection.ncp = Number(ncp);
    const cp = project.control_pairs.find(c => c.order === selection.ncp);
    if (cp) updateControlPairGroup(cp);
    if (group.parentNode) group.parentNode.appendChild(group);
    updateCPList();
    return true;
}

function getControlPairCircle(target) {
    const circle = target?.closest(".control-circle");
    if (!circle) return null;
    return { ncp: Number(circle.dataset.ncp), pointType: circle.dataset.type };
}

/* =========================================================
    ROUTE — DRAW & INTERACT
========================================================= */

const GENERATED_ROUTE_ANIM_COLOR = "#E53935";
const GENERATED_ROUTE_HOLD_MS = 5000;
const GENERATED_ROUTE_FALLBACK_DRAW_MS = 1000;
const GENERATED_ROUTE_RUNTIME_SECONDS_PER_ANIM_SECOND = 60;
let _generatedRouteAnimFrame = null;
let _routeDeletePreviewNcp = null;

function setRouteDeletePreview(ncp) {
    const next = Number.isFinite(Number(ncp)) ? Number(ncp) : null;
    if (_routeDeletePreviewNcp === next) return;
    _routeDeletePreviewNcp = next;
    updateRoutes();
}

function routeDeletePreviewOpacity(ncp, fallback = 1) {
    return Number(ncp) === _routeDeletePreviewNcp ? 0.2 : fallback;
}

function routePolylineLength(route) {
    const pts = route?.rP || [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return total;
}

function generatedRouteDrawMs(route) {
    const rt = Number(route?.run_time);
    if (Number.isFinite(rt) && rt > 0) {
        return Math.max(120, (rt / GENERATED_ROUTE_RUNTIME_SECONDS_PER_ANIM_SECOND) * 1000);
    }
    return GENERATED_ROUTE_FALLBACK_DRAW_MS;
}

function routePointAtProgress(route, progress) {
    const pts = route?.rP || [];
    if (pts.length === 0) return null;
    if (pts.length === 1) return pts[0];
    const target = routePolylineLength(route) * Math.max(0, Math.min(1, progress));
    let walked = 0;
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const seg = Math.hypot(b.x - a.x, b.y - a.y);
        if (walked + seg >= target) {
            const t = seg > 0 ? (target - walked) / seg : 1;
            return {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            };
        }
        walked += seg;
    }
    return pts[pts.length - 1];
}

function routeAnimationPhase(route, now = performance.now()) {
    const anim = route?._generatedRouteAnim;
    if (!anim) return null;
    const elapsed = now - anim.start;
    if (elapsed < anim.drawMs) {
        return {
            kind: "drawing",
            progress: Math.max(0, Math.min(1, elapsed / anim.drawMs)),
            remaining: Math.max(0, anim.drawMs - elapsed),
        };
    }
    if (elapsed < anim.drawMs + (anim.holdMs || 0)) {
        return { kind: "holding" };
    }
    delete route._generatedRouteAnim;
    return null;
}

function ensureRouteLayers() {
    const root = document.getElementById("route-layer");
    if (!root) return {};
    let base = root.querySelector(":scope > #route-base-layer");
    let active = root.querySelector(":scope > #route-active-layer");
    let anim = root.querySelector(":scope > #route-animation-layer");
    if (!base || !active || !anim) {
        root.innerHTML = "";
        base = document.createElementNS("http://www.w3.org/2000/svg", "g");
        active = document.createElementNS("http://www.w3.org/2000/svg", "g");
        anim = document.createElementNS("http://www.w3.org/2000/svg", "g");
        base.id = "route-base-layer";
        active.id = "route-active-layer";
        anim.id = "route-animation-layer";
        root.appendChild(base);
        root.appendChild(active);
        root.appendChild(anim);
    }
    Array.from(root.children).forEach(child => {
        if (!["route-base-layer", "route-active-layer", "route-animation-layer"].includes(child.id)) {
            child.remove();
        }
    });
    return { root, base, active, anim };
}

function createRoutePolyline(route, {
    stroke = CP_COLOR,
    strokeWidth = 3,
    opacity = 1,
    className = "",
    dataset = {},
    pointerEvents = "none"
} = {}) {
    if (!route?.rP || route.rP.length < 2) return null;
    const points = route.rP.map(p => `${p.x},${p.y}`).join(" ");
    const el = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    el.setAttribute("points", points);
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", stroke);
    el.setAttribute("stroke-width", strokeWidth);
    el.setAttribute("opacity", opacity);
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("vector-effect", "non-scaling-stroke");
    el.setAttribute("pointer-events", pointerEvents);
    if (className) el.classList.add(...className.split(" "));
    Object.entries(dataset).forEach(([k, v]) => { el.dataset[k] = v; });
    return el;
}

function applyDashDraw(el, route, phase) {
    let len = routePolylineLength(route);
    try {
        if (typeof el.getTotalLength === "function") len = el.getTotalLength();
    } catch (_) {}
    len = Math.max(1, len);
    const offset = len * (1 - (phase?.progress || 0));
    el.style.strokeDasharray = String(len);
    el.style.strokeDashoffset = String(offset);
    el.style.transition = "none";
}

function renderGeneratedRouteAnimation(layer, route, cp, phase) {
    if (!layer || !route?.rP?.length || !phase) return;
    const dataset = { ncp: cp.order, nr: route.order };
    const previewOpacity = routeDeletePreviewOpacity(cp.order);
    if (phase.kind === "drawing") {
        const bg = createRoutePolyline(route, {
            stroke: "white",
            strokeWidth: 3,
            opacity: previewOpacity,
            className: "route-generated-anim",
            dataset,
        });
        const fg = createRoutePolyline(route, {
            stroke: GENERATED_ROUTE_ANIM_COLOR,
            strokeWidth: 1.8,
            opacity: previewOpacity,
            className: "route-generated-anim",
            dataset,
        });
        if (bg) {
            layer.appendChild(bg);
            applyDashDraw(bg, route, phase);
        }
        if (fg) {
            layer.appendChild(fg);
            applyDashDraw(fg, route, phase);
        }
        const front = routePointAtProgress(route, phase.progress);
        if (front) {
            const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            dot.setAttribute("cx", front.x);
            dot.setAttribute("cy", front.y);
            dot.setAttribute("r", "4.5");
            dot.setAttribute("fill", GENERATED_ROUTE_ANIM_COLOR);
            dot.setAttribute("stroke", "white");
            dot.setAttribute("stroke-width", "1.4");
            dot.setAttribute("opacity", String(previewOpacity));
            dot.setAttribute("vector-effect", "non-scaling-stroke");
            dot.setAttribute("pointer-events", "none");
            dot.classList.add("route-generated-anim");
            layer.appendChild(dot);
        }
        return;
    }
}

function hasActiveGeneratedRouteAnimations() {
    if (!project?.control_pairs) return false;
    const now = performance.now();
    return project.control_pairs.some(cp => (cp.routes || []).some(route => {
        const phase = routeAnimationPhase(route, now);
        return phase?.kind === "drawing";
    }));
}

function scheduleGeneratedRouteAnimationFrame() {
    if (_generatedRouteAnimFrame !== null) return;
    const tick = () => {
        _generatedRouteAnimFrame = null;
        drawRoutes();
        updateRoutes();
        if (hasActiveGeneratedRouteAnimations()) {
            _generatedRouteAnimFrame = requestAnimationFrame(tick);
        }
    };
    _generatedRouteAnimFrame = requestAnimationFrame(tick);
}

function drawRoutes() {
    const { base, active, anim } = ensureRouteLayers();
    if (!base || !anim) return;
    base.innerHTML = "";
    if (active) active.innerHTML = "";
    anim.innerHTML = "";
    if (!project?.control_pairs) return;
    const now = performance.now();

    project.control_pairs.forEach(cp => {
        cp.routes.forEach(route => {
            const phase = routeAnimationPhase(route, now);
            if (phase?.kind === "drawing") return;
            const el = createRoutePolyline(route, {
                stroke: "white", strokeWidth: 3,
                className: "route-bg",
                dataset: { ncp: cp.order, nr: route.order },
            });
            if (el) base.appendChild(el);
        });
    });

    project.control_pairs.forEach(cp => {
        cp.routes.forEach(route => {
            const phase = routeAnimationPhase(route, now);
            if (phase?.kind === "drawing") {
                renderGeneratedRouteAnimation(anim, route, cp, phase);
                return;
            }
            const isHolding = phase?.kind === "holding";
            const el = createRoutePolyline(route, {
                stroke: isHolding ? GENERATED_ROUTE_ANIM_COLOR : "black",
                strokeWidth: 1.5,
                className: isHolding ? "route-polyline route-holding" : "route-polyline",
                dataset: { ncp: cp.order, nr: route.order },
            });
            if (el) base.appendChild(el);
        });
    });
}

function updateRoutes() {
    const { root: routeLayer, active: activeLayer } = ensureRouteLayers();
    mapContainer.querySelectorAll(".route-bg").forEach(el => {
        const isSelectedCp = Number(el.dataset.ncp) === selection.ncp;
        const ncp = Number(el.dataset.ncp);
        el.setAttribute("stroke", isSelectedCp ? "white" : "transparent");
        el.setAttribute("opacity", String(routeDeletePreviewOpacity(ncp)));
    });

    mapContainer.querySelectorAll(".route-polyline").forEach(el => {
        const ncp = Number(el.dataset.ncp);
        const isSelectedCp = ncp === selection.ncp;
        const isHolding = el.classList.contains("route-holding");
        el.setAttribute("opacity", String(routeDeletePreviewOpacity(ncp, isSelectedCp || isHolding ? 1 : 0.1)));
        if (!isHolding) el.setAttribute("stroke", "black");
    });

    // active route rendered on top
    (activeLayer || routeLayer)?.querySelectorAll(".route-active").forEach(el => el.remove());

    const cp    = project.control_pairs.find(cp => cp.order === selection.ncp);
    const route = cp?.routes.find(r => r.order === selection.nr);

    if (route && routeAnimationPhase(route)?.kind !== "drawing") {
        const bg = createRoutePolyline(route, {
            stroke: "white", strokeWidth: 3,
            opacity: routeDeletePreviewOpacity(cp.order),
            className: "route-active",
        });
        const fg = createRoutePolyline(route, {
            stroke: "#E53935", strokeWidth: 1.5,
            opacity: routeDeletePreviewOpacity(cp.order),
            className: "route-active",
            dataset: { ncp: cp.order, nr: route.order },
        });
        if (bg) (activeLayer || routeLayer).appendChild(bg);
        if (fg) (activeLayer || routeLayer).appendChild(fg);
    }

    // transparent hit strips — only needed in route modes
    // active route appended last so its hit area is on top
    if (activeTool === RouteTool || activeTool === RouteEditTool) {
        const hitLayer = document.getElementById("ui-layer");
        hitLayer.innerHTML = "";
        if (!cp) return;
        const inactive = cp.routes.filter(r => r.order !== selection.nr);
        const active   = cp.routes.filter(r => r.order === selection.nr);
        [...inactive, ...active].forEach(r => {
            const hit = createRoutePolyline(r, {
                stroke: "transparent", strokeWidth: 4,
                className: "route-hit",
                pointerEvents: "stroke",
                dataset: { ncp: cp.order, nr: r.order },
            });
            if (hit) hitLayer.appendChild(hit);
        });
    }
}

function getClickedObject(target) {
    if (!target?.closest) return null;

    const route = target.closest(".route-hit");
    if (route) {
        return {
            type: "route",
            ncp:  Number(route.dataset.ncp),
            nr:   Number(route.dataset.nr),
            element: route,
        };
    }

    const group = target.closest(".control-pair-group");
    if (group) {
        return {
            type: "control-pair",
            ncp:  Number(group.dataset.ncp),
            element: group,
        };
    }

    return null;
}

function findEditableRoutePoint(x, y) {
    const cp = project.control_pairs.find(cp => cp.order === selection.ncp);
    if (!cp) return null;
    const route = cp.routes.find(r => r.order === selection.nr);
    if (!route?.rP || route.rP.length < 2) return null;

    for (let i = 0; i < route.rP.length - 1; i++) {
        const a      = route.rP[i];
        const b      = route.rP[i + 1];
        const result = pointToSegmentDistance(x, y, a.x, a.y, b.x, b.y);
        if (result.distance < 2) {
            return {
                route,
                segmentIndex: i,
                insertPoint: { x: result.closestX, y: result.closestY },
            };
        }
    }
    return null;
}

/* =========================================================
    ZOOM
========================================================= */

function onWheel(e) {
    if (!mapContainer.contains(e.target)) return;
    if (e.target.closest("#overview-sidebar")) return;
    e.preventDefault();
    const rect   = mapContainer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const worldX = (mouseX - camera.x) / camera.zoom;
    const worldY = (mouseY - camera.y) / camera.zoom;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    camera.zoom  = Math.max(zoomMin, Math.min(zoomMax, camera.zoom * factor));
    camera.x     = mouseX - worldX * camera.zoom;
    camera.y     = mouseY - worldY * camera.zoom;
    updateCameraTransform();

    // Update brush cursor size if mask draw/erase is active
    const brushEl = document.getElementById("mask-brush-cursor");
    if (brushEl && brushEl.style.display === "block") {
        const r = MaskLayer.brushScreenRadius();
        brushEl.style.width  = r * 2 + "px";
        brushEl.style.height = r * 2 + "px";
    }
}

/* =========================================================
    UTILITIES
========================================================= */

function getCSRFToken() {
    return document.querySelector('meta[name="csrf-token"]').getAttribute('content');
}

// PERF-FIX #1: cache #map-container's bounding rect. It only changes on layout
// (resize / page scroll / sidebar toggle), never on pan or zoom (those transform
// #camera, not the container). Reading getBoundingClientRect() on every mousemove
// forced a synchronous reflow each frame while drawing, because the previous
// frame had just mutated the overlay SVG. Cached + invalidated, that cost is gone.
let _mapRectCache = null;
function getMapRect() {
    if (!_mapRectCache)
        _mapRectCache = document.getElementById("map-container").getBoundingClientRect();
    return _mapRectCache;
}
function invalidateMapRect() { _mapRectCache = null; }

// PERF-FIX #2: coalesce expensive live-preview redraws to at most one per
// animation frame. High-Hz pointers fire mousemove 120-240x/s; without this each
// event rebuilt the edit-layer. The scheduled fn always reads the latest preview
// state (module vars), so skipping intermediate events is visually lossless.
function makeRafScheduler(fn) {
    let id = 0;
    const run = () => { id = 0; fn(); };
    const sched = () => { if (!id) id = requestAnimationFrame(run); };
    sched.cancel = () => { if (id) { cancelAnimationFrame(id); id = 0; } };
    return sched;
}

// PERF (password-manager mitigation): the live-preview tools used to wipe their
// layer (innerHTML="") and recreate SVG nodes every frame. Those childList
// mutations wake page-wide MutationObservers from autofill extensions (Bitwarden
// et al.), which then re-walk the WHOLE document looking for form fields — that
// DOM walk, not our drawing, was the real per-move CPU cost. These helpers let a
// tool keep long-lived preview nodes and only UPDATE attributes / toggle the SVG
// `display` attribute, so no nodes are added/removed during hover/draw/drag.
function svgNode(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
}
function showNode(el) { if (el) el.removeAttribute("display"); }
function hideNode(el) { if (el) el.setAttribute("display", "none"); }
// Re-attach a persistent node if a clearEditLayer()/innerHTML reset detached it.
function ensureInLayer(el, layerId) {
    if (el && !el.isConnected) document.getElementById(layerId)?.appendChild(el);
}

function screenToWorld(clientX, clientY) {
    const rect = getMapRect();   // PERF-FIX #1 (cached; see getMapRect)
    return {
        x: (clientX - rect.left - camera.x) / camera.zoom,
        y: (clientY - rect.top  - camera.y) / camera.zoom,
    };
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx    = x2 - x1;
    const dy    = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    const t     = lenSq > 0
        ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
        : 0;
    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;
    return { distance: Math.hypot(px - closestX, py - closestY), closestX, closestY };
}

function clearEditLayer() {
    document.getElementById("edit-layer").innerHTML = "";
}

/* =========================================================
    FILES
========================================================= */

async function loadFiles() {
    if (filesLoadingPromise) return filesLoadingPromise;
    filesLoadingPromise = (async () => {
        try {
            const res  = await fetch('/editor/files/');
            const data = await res.json();
            window.activeTeam = data.active_team;
            projectFiles  = data.files || [];
            filteredFiles = [...projectFiles];
            window.allLabels  = data.labels || [];
        } catch (err) {
            console.error("Failed to load files:", err);
        } finally {
            filesLoadingPromise = null;
        }
    })();
    return filesLoadingPromise;
}

/* =========================================================
    MASK GENERATION PIPELINE
========================================================= */

let maskGenController  = null;
let maskGenInProgress  = false;
let maskGenSessionSeq  = 0;
let activeMaskGenSession = null;

function maskGenerationEventMatchesSession(event, session) {
    const eventFileId = Number(event.file_id);
    if (!session || !Number.isFinite(eventFileId)) return false;
    if (eventFileId !== session.fileId) return false;
    if (event.filename && event.filename !== session.mapFile) return false;
    if (event.map_file && event.map_file !== session.mapFile) return false;
    if (activeMaskGenSession?.seq !== session.seq) return false;
    if (Number(project.id) !== session.fileId) return false;
    if (project.map_file !== session.mapFile) return false;
    return true;
}

async function startMaskGeneration(mapFile, scale, fileId = null) {
    const bar    = document.getElementById("mask-gen-bar");
    const text   = document.getElementById("mask-gen-text");
    const cancel = document.getElementById("mask-gen-cancel");
    if (!bar) return;

    const seq = ++maskGenSessionSeq;
    const requestedMapFile = mapFile;
    const requestedScale = scale;
    const prog = document.getElementById("mask-gen-progress");
    maskGenInProgress = true;
    if (currentToolMode === ToolMode.MASK || editorSettings.auto_pathfind) bar.style.display = "flex";
    text.textContent  = "Maske wird generiert…";
    if (prog) prog.value = 0;

    if (!fileId) {
        await _saveQueue;
        if (!project.id && !readOnly) await saveFile("mask_generation");
        fileId = project.id;
    }
    fileId = Number(fileId);
    if (!Number.isFinite(fileId)) {
        if (seq === maskGenSessionSeq) {
            maskGenInProgress = false;
            text.innerHTML = `<span style="color:#ff6666">Fehler: Datei wurde noch nicht gespeichert.</span>`;
        }
        return;
    }

    const session = { seq, fileId, mapFile: requestedMapFile };
    if (Number(project.id) !== fileId || project.map_file !== requestedMapFile) {
        if (seq === maskGenSessionSeq) maskGenInProgress = false;
        return;
    }
    activeMaskGenSession = session;

    const controller = new AbortController();
    maskGenController = controller;
    cancel.onclick = () => { bar.style.display = "none"; }; // hide only, fetch continues

    const csrfToken = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";

    fetch("/editor/generate-mask/", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
        body:    JSON.stringify({ filename: requestedMapFile, scale: requestedScale, file_id: fileId }),
        signal:  controller.signal,
    })
        .then(res => {
            if (!res.ok) return res.text().then(t => { throw new Error(t); });
            const reader  = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer    = "";

            function read() {
                return reader.read().then(({ done, value }) => {
                    if (done) return;
                    buffer += decoder.decode(value, { stream: true });
                    const parts = buffer.split("\n\n");
                    buffer = parts.pop();
                    for (const part of parts) {
                        const line = part.split("\n").find(l => l.startsWith("data: "));
                        if (!line) continue;
                        try {
                            const d = JSON.parse(line.slice(5).trim());
                            if (!maskGenerationEventMatchesSession(d, session)) {
                                if (
                                    activeMaskGenSession?.seq === session.seq &&
                                    Number(d.file_id) === session.fileId &&
                                    (d.done || d.error)
                                ) {
                                    maskGenInProgress = false;
                                    activeMaskGenSession = null;
                                }
                                continue;
                            }
                            if (d.current !== undefined) {
                                const pct = Math.round((d.current / d.total) * 100);
                                text.textContent = `Generiere Maske… ${pct}%`;
                                if (prog) prog.value = pct;
                            } else if (d.done) {
                                // Mask PNG is written. Load preview & mark
                                // has_mask. (Navgraph pipeline was removed.)
                                maskGenInProgress = false;
                                activeMaskGenSession = null;
                                if (project.map_file === requestedMapFile && Number(project.id) === fileId) {
                                    project.has_mask = true;
                                    if (fileId) {
                                        const _csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
                                        fetch("/editor/mark-has-mask/", {
                                            method:  "POST",
                                            headers: { "Content-Type": "application/json", "X-CSRFToken": _csrf },
                                            body:    JSON.stringify({ file_id: fileId }),
                                        }).catch(e => console.warn("mark_has_mask failed:", e));
                                    }
                                    if (prog) prog.value = 100;
                                    text.textContent = "Maske fertig";
                                    MaskLayer.loadMask(requestedMapFile);
                                    MaskLayer.applyMapDimensions();
                                    drainPendingAutoPathfindQueue();
                                    setTimeout(hideMaskGenBar, 1500);
                                }
                            } else if (d.error) {
                                maskGenInProgress = false;
                                activeMaskGenSession = null;
                                text.innerHTML = `<span style="color:#ff6666">Fehler: ${d.error}</span>`;
                                const spinnerEl = bar.querySelector('x-icon[name="spinner"]');
                                if (spinnerEl) spinnerEl.style.display = "none";
                            }
                        } catch (_) {}
                    }
                    return read();
                });
            }
            return read();
        })
        .catch(err => {
            if (err.name !== "AbortError" && activeMaskGenSession?.seq === seq) {
                text.innerHTML = `<span style="color:#ff6666">Fehler: ${err.message}</span>`;
                const spinnerEl = bar.querySelector('x-icon[name="spinner"]');
                if (spinnerEl) spinnerEl.style.display = "none";
            }
        });
}

function hideMaskGenBar() {
    const bar = document.getElementById("mask-gen-bar");
    if (bar) bar.style.display = "none";
}

function detachMaskGenerationUi() {
    maskGenSessionSeq++;
    activeMaskGenSession = null;
    maskGenInProgress = false;
    hideMaskGenBar();
}
window.detachMaskGenerationUi = detachMaskGenerationUi;

function showMaskGenBarIfActive() {
    if (!maskGenInProgress) return;
    const bar = document.getElementById("mask-gen-bar");
    if (bar) bar.style.display = "flex";
}

function showRasterizingBar() {
    const bar    = document.getElementById("mask-gen-bar");
    const text   = document.getElementById("mask-gen-text");
    const prog   = document.getElementById("mask-gen-progress");
    const cancel = document.getElementById("mask-gen-cancel");
    if (!bar) return;
    if (text) text.textContent = "Karte wird rasterisiert…";
    if (prog) prog.style.display = "none";
    if (cancel) cancel.style.display = "none";
    bar.style.display = "flex";
}

function hideRasterizingBar() {
    const bar    = document.getElementById("mask-gen-bar");
    const prog   = document.getElementById("mask-gen-progress");
    const cancel = document.getElementById("mask-gen-cancel");
    if (prog) prog.style.display = "";
    if (cancel) cancel.style.display = "";
    if (bar && !maskGenInProgress) bar.style.display = "none";
}

function loadMap(filename) {
    document.getElementById('map-img').src = `/editor/map/${filename}`;
}

function initCourseImport() {
    const menuItem = document.getElementById("nav-import-courses");
    const input = document.getElementById("course-import-input");
    if (!menuItem || !input) return;
    menuItem.addEventListener("click", e => {
        e.stopImmediatePropagation();
        e.stopPropagation();
        if (readOnly) return;
        input.value = "";
        input.click();
    });
    input.addEventListener("click", e => e.stopPropagation());
    input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (file) importCourseFile(file);
    });
}

function getCourseImportTargetSize() {
    const scale = project.scale || 1;
    const img = document.getElementById("map-img");
    if (img?.naturalWidth && img?.naturalHeight) {
        return { width: img.naturalWidth * scale, height: img.naturalHeight * scale };
    }
    return null;
}

function importedCoursePoint(point) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
    return { x: Number(point.x), y: Number(point.y) };
}

function importedCourseRoute(route, cp, order) {
    const rP = (route?.rP || []).map(importedCoursePoint).filter(Boolean);
    const next = {
        id: null,
        order,
        rP,
        noA: route?.noA ?? null,
        pos: route?.pos ?? null,
        length: route?.length ?? null,
        run_time: route?.run_time ?? null,
        elevation: route?.elevation ?? 0,
    };
    calcRouteLength(next);
    calcRouteNoA(next);
    calcRouteRunTime(next);
    calcRouteSide(cp, next);
    return next;
}

function applyImportedCourses(controlPairs, mode = "append") {
    const incoming = Array.isArray(controlPairs) ? controlPairs : [];
    if (!incoming.length) {
        alert("Keine OCAD-Bahn in dieser Datei gefunden.");
        return false;
    }

    cancelAllPathing();
    pushUndoState("OCAD-Bahn importiert");
    if (mode === "replace") {
        project.control_pairs = [];
        selection.ncp = 0;
        selection.nr = null;
    }

    const offset = project.control_pairs.length;
    const imported = incoming.map((cp, i) => {
        const next = {
            id: null,
            order: offset + i,
            start: importedCoursePoint(cp.start),
            ziel: importedCoursePoint(cp.ziel),
            complex: true,
            routes: [],
            _ocadBahnImported: true,
        };
        next.routes = (cp.routes || [])
            .map((route, routeIndex) => importedCourseRoute(route, next, routeIndex))
            .filter(route => route.rP.length >= 2);
        next.complex = true;
        return next;
    }).filter(cp => cp.start && cp.ziel);

    if (!imported.length) {
        alert("Keine passenden OCAD-Posten in dieser Datei gefunden.");
        return false;
    }

    project.control_pairs.push(...imported);
    normalizeProjectOrders();
    selection.ncp = imported[0].order;
    selection.nr = imported[0].routes.length ? 0 : null;
    activeSubtool[ToolMode.CONTROL_PAIR] = "drag";
    setTool(ToolMode.CONTROL_PAIR);
    drawCourse();
    updateCPList();
    startCourseAlignment(imported);
    return true;
}

function startCourseAlignment(controlPairs) {
    CourseAlignMode.start(controlPairs);
}

function chooseOcadBahnImportMode() {
    if (!project.control_pairs.length) return Promise.resolve("replace");
    const opts = {
        message: "Bestehende Posten ersetzen oder OCAD-Bahn zusätzlich importieren?",
        confirmText: "Ersetzen",
        cancelText: "Zusätzlich",
    };
    if (typeof window.showModal === "function") {
        return window.showModal(opts).then(replace => replace ? "replace" : "append");
    }
    return new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.className = "dialog-overlay";
        overlay.innerHTML = `
            <div class="dialog-box">
                <p class="dialog-message">${opts.message}</p>
                <div class="dialog-buttons">
                    <button type="button" class="dialog-btn dialog-btn-cancel">Zusätzlich</button>
                    <button type="button" class="dialog-btn dialog-btn-confirm">Ersetzen</button>
                </div>
            </div>
        `;
        const close = mode => {
            overlay.remove();
            resolve(mode);
        };
        overlay.querySelector(".dialog-btn-confirm")?.addEventListener("click", () => close("replace"));
        overlay.querySelector(".dialog-btn-cancel")?.addEventListener("click", () => close("append"));
        overlay.addEventListener("click", e => {
            if (e.target === overlay) close("append");
        });
        document.body.appendChild(overlay);
        overlay.querySelector(".dialog-btn-confirm")?.focus();
    });
}

const CourseAlignMode = (() => {
    let state = null;
    let drag = null;

    function panel() {
        return document.getElementById("course-align-panel");
    }

    function pointRefs(cps) {
        const refs = [];
        const seen = new WeakSet();
        const add = point => {
            if (!point || seen.has(point)) return;
            seen.add(point);
            refs.push(point);
        };
        cps.forEach(cp => {
            add(cp.start);
            add(cp.ziel);
            (cp.routes || []).forEach(route => (route.rP || []).forEach(add));
        });
        return refs;
    }

    function snapshot(refs = state?.refs || []) {
        return refs.map(ref => ({ ref, x: ref.x, y: ref.y }));
    }

    function restoreGeometry(points) {
        for (const item of points || []) {
            item.ref.x = item.x;
            item.ref.y = item.y;
        }
    }

    function restore(points) {
        restoreGeometry(points);
        recalc();
        redraw();
    }

    function recalc() {
        for (const cp of state?.cps || []) {
            for (const route of cp.routes || []) {
                calcRouteLength(route);
                calcRouteNoA(route);
                calcRouteRunTime(route);
                calcRouteSide(cp, route);
            }
        }
    }

    function redraw() {
        drawCourse();
        refreshHighlights();
    }

    function applyTranslation(base, dx, dy) {
        for (const item of base) {
            item.ref.x = item.x + dx;
            item.ref.y = item.y + dy;
        }
    }

    function syncAnchorAliases() {
        state.anchor1 = state.anchors[0] || null;
        state.anchor2 = state.anchors[1] || null;
        state.anchor3 = state.anchors[2] || null;
    }

    function queueAnchor(target) {
        const existing = state.anchors.findIndex(anchor => anchor.point === target.point);
        if (existing >= 0) state.anchors.splice(existing, 1);
        state.anchors.push(target);
        while (state.anchors.length > 3) state.anchors.shift();
        syncAnchorAliases();
    }

    function applyAnchorDests(anchorDests) {
        restoreGeometry(state.initial);
        if (anchorDests.length === 1) {
            const sourceA = sourcePoint(anchorDests[0].anchor.point);
            if (sourceA) {
                applyTranslation(state.initial, anchorDests[0].dest.x - sourceA.x, anchorDests[0].dest.y - sourceA.y);
            }
        } else if (anchorDests.length === 2) {
            const sourceA = sourcePoint(anchorDests[0].anchor.point);
            const sourceB = sourcePoint(anchorDests[1].anchor.point);
            if (sourceA && sourceB) {
                applySimilarityFromAnchors(state.initial, sourceA, sourceB, anchorDests[0].dest, anchorDests[1].dest);
            }
        } else if (anchorDests.length >= 3) {
            const sourceA = sourcePoint(anchorDests[0].anchor.point);
            const sourceB = sourcePoint(anchorDests[1].anchor.point);
            const sourceC = sourcePoint(anchorDests[2].anchor.point);
            if (sourceA && sourceB && sourceC) {
                applyAffineFromAnchors(state.initial, sourceA, sourceB, sourceC, anchorDests[0].dest, anchorDests[1].dest, anchorDests[2].dest);
            }
        }
        recalc();
        redraw();
    }

    function removeLastAnchor() {
        if (!state?.anchors?.length) return;
        const kept = state.anchors.slice(0, -1);
        const anchorDests = kept.map(anchor => ({
            anchor,
            dest: { x: anchor.point.x, y: anchor.point.y },
        }));
        state.anchors = kept;
        syncAnchorAliases();
        applyAnchorDests(anchorDests);
        state.stageBaseline = snapshot();
        renderPanel();
        refreshHighlights();
    }

    function sourcePoint(ref) {
        return state?.initial?.find(item => item.ref === ref) || null;
    }

    function applySimilarityFromAnchors(base, sourceA, sourceB, destA, destB) {
        const sourceVector = { x: sourceB.x - sourceA.x, y: sourceB.y - sourceA.y };
        const destVector = { x: destB.x - destA.x, y: destB.y - destA.y };
        const sourceLen = Math.hypot(sourceVector.x, sourceVector.y);
        const destLen = Math.hypot(destVector.x, destVector.y);
        if (sourceLen < 1 || destLen < 1) return false;
        const scale = destLen / sourceLen;
        const angle = Math.atan2(destVector.y, destVector.x) - Math.atan2(sourceVector.y, sourceVector.x);
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        for (const item of base) {
            const x = item.x - sourceA.x;
            const y = item.y - sourceA.y;
            item.ref.x = destA.x + scale * (x * c - y * s);
            item.ref.y = destA.y + scale * (x * s + y * c);
        }
        return true;
    }

    function applyAffineFromAnchors(base, sourceA, sourceB, sourceC, destA, destB, destC) {
        const ux = sourceB.x - sourceA.x;
        const uy = sourceB.y - sourceA.y;
        const vx = sourceC.x - sourceA.x;
        const vy = sourceC.y - sourceA.y;
        const det = ux * vy - uy * vx;
        if (Math.abs(det) < 1) return false;
        const U = { x: destB.x - destA.x, y: destB.y - destA.y };
        const V = { x: destC.x - destA.x, y: destC.y - destA.y };
        for (const item of base) {
            const dx = item.x - sourceA.x;
            const dy = item.y - sourceA.y;
            const a = (dx * vy - dy * vx) / det;
            const b = (ux * dy - uy * dx) / det;
            item.ref.x = destA.x + a * U.x + b * V.x;
            item.ref.y = destA.y + a * U.y + b * V.y;
        }
        return true;
    }

    function cpForTarget(target) {
        const hit = getControlPairCircle(target);
        if (!hit || !state?.cpOrders.has(hit.ncp)) return null;
        const cp = project.control_pairs.find(item => item.order === hit.ncp);
        const point = cp?.[hit.pointType];
        if (!cp || !point) return null;
        return { cp, point, pointType: hit.pointType };
    }

    function setSelectionForTarget(target) {
        selection.ncp = target.cp.order;
        selection.nr = target.cp.routes?.length ? 0 : null;
        updateControlPairs(target.cp.order);
        updateRoutes();
    }

    function stepLabel() {
        if (!state) return "";
        return "Bahn ausrichten";
    }

    function stageText() {
        if (!state) return "";
        if (!state.anchor1) return "1. Punkt waehlen und ziehen";
        if (!state.anchor2) return "2. Punkt waehlen und ziehen";
        if (!state.anchor3) return "3. Punkt waehlen und ziehen";
        return "Naechster Punkt ersetzt Anker 1";
    }

    function setRouteImport(enabled) {
        if (!state) return;
        state.includeRoutes = !!enabled;
        for (const entry of state.routeBackups || []) {
            entry.cp.routes = state.includeRoutes ? entry.routes : [];
            entry.cp.complex = true;
        }
        if (!state.includeRoutes && state.cpOrders.has(selection.ncp)) {
            selection.nr = null;
        } else if (state.includeRoutes && state.cpOrders.has(selection.ncp)) {
            const selected = project.control_pairs.find(cp => cp.order === selection.ncp);
            if (selected?.routes?.length && selection.nr == null) selection.nr = 0;
        }
        recalc();
        drawCourse();
        updateCPList();
        updateRoutes();
    }

    function renderPanel() {
        const el = panel();
        if (!el) return;
        if (!state) {
            el.style.display = "none";
            el.innerHTML = "";
            return;
        }
        el.style.display = "flex";
        el.innerHTML = `
            <div class="course-align-head">
                <span>${stepLabel()}</span>
            </div>
            <div class="course-align-status">${stageText()}</div>
            <label class="course-align-option">
                <input type="checkbox" id="course-align-routes" ${state.includeRoutes ? "checked" : ""}>
                <span>Routen importieren</span>
            </label>
            <div class="course-align-actions">
                <button type="button" id="course-align-reset">Reset</button>
                <button type="button" id="course-align-remove-anchor" ${state.anchors.length ? "" : "disabled"}>Anker zurück</button>
                <button type="button" id="course-align-confirm">Importieren</button>
            </div>
        `;
        el.querySelector("#course-align-routes")?.addEventListener("change", e => setRouteImport(e.target.checked));
        el.querySelector("#course-align-confirm")?.addEventListener("click", confirmStep);
        el.querySelector("#course-align-reset")?.addEventListener("click", reset);
        el.querySelector("#course-align-remove-anchor")?.addEventListener("click", removeLastAnchor);
    }

    function refreshHighlights() {
        if (!state) return;
        const layer = document.getElementById("control-layer");
        for (const order of state.cpOrders) {
            const group = layer?.querySelector(`.control-pair-group[data-ncp="${order}"]`);
            group?.classList.add("course-align-member");
            group?.querySelectorAll(".course-align-anchor")
                .forEach(el => el.classList.remove("course-align-anchor"));
        }
        for (const order of state.cpOrders) {
            layer?.querySelector(`.control-pair-group[data-ncp="${order}"]`)
                ?.classList.add("course-align-member");
        }
        for (const anchor of state.anchors || []) {
            layer?.querySelector(`.control-circle[data-ncp="${anchor.cp.order}"][data-type="${anchor.pointType}"]`)
                ?.classList.add("course-align-anchor");
        }
    }

    function saveAndExit(trigger = "ocad_bahn_align") {
        if (!state) return;
        recalc();
        setRouteImport(state.includeRoutes);
        for (const cp of state.cps || []) delete cp._ocadBahnImported;
        saveFile(trigger);
        saveSnapshot("OCAD-Bahn ausgerichtet");
        state = null;
        drag = null;
        document.body.classList.remove("course-align-active");
        mapContainer.style.cursor = activeTool?.defaultCursor ?? "default";
        renderPanel();
        drawCourse();
    }

    function confirmStep() {
        if (!state) return;
        finish();
    }

    function finish() {
        saveAndExit("ocad_bahn_align");
    }

    function focusImported() {
        if (!state?.refs?.length) return;
        const xs = state.refs.map(p => p.x).filter(Number.isFinite);
        const ys = state.refs.map(p => p.y).filter(Number.isFinite);
        if (!xs.length || !ys.length) return;
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const rect = mapContainer.getBoundingClientRect();
        const width = Math.max(1, maxX - minX);
        const height = Math.max(1, maxY - minY);
        const zoom = Math.min(
            Math.max(Math.min(rect.width / width, rect.height / height) * 0.82, zoomMin),
            zoomMax,
        );
        updateCameraTransform({
            x: rect.width / 2 - ((minX + maxX) / 2) * zoom,
            y: rect.height / 2 - ((minY + maxY) / 2) * zoom,
            zoom,
        });
    }

    function reset() {
        if (!state) return;
        restore(state.initial);
        state.anchors = [];
        syncAnchorAliases();
        state.stageBaseline = snapshot();
        renderPanel();
        refreshHighlights();
    }

    function onMouseDown(e, pt) {
        if (!state) return false;
        const target = cpForTarget(e.target);
        if (!target) {
            pan.start(e.clientX, e.clientY);
            return true;
        }

        setSelectionForTarget(target);
        const base = snapshot();
        queueAnchor(target);
        if (state.anchors.length === 1) {
            drag = {
                kind: "translate",
                base,
                anchor: { x: target.point.x, y: target.point.y },
            };
        } else if (state.anchors.length === 2) {
            const sourceA = sourcePoint(state.anchor1?.point);
            const sourceB = sourcePoint(target.point);
            if (!sourceA || !sourceB || target.point === state.anchor1.point) return true;
            drag = {
                kind: "similarity",
                base: state.initial,
                sourceA,
                sourceB,
            };
        } else {
            const sourceA = sourcePoint(state.anchor1?.point);
            const sourceB = sourcePoint(state.anchor2?.point);
            const sourceC = sourcePoint(target.point);
            if (!sourceA || !sourceB || !sourceC || target.point === state.anchor1.point || target.point === state.anchor2.point) return true;
            drag = {
                kind: "affine",
                base: state.initial,
                sourceA,
                sourceB,
                sourceC,
            };
        }
        mapContainer.style.cursor = "grabbing";
        renderPanel();
        refreshHighlights();
        return true;
    }

    function onMouseMove(e, pt) {
        if (!state) return false;
        if (drag?.kind === "translate") {
            applyTranslation(drag.base, pt.x - drag.anchor.x, pt.y - drag.anchor.y);
            recalc();
            redraw();
            return true;
        }
        if (drag?.kind === "similarity") {
            if (applySimilarityFromAnchors(drag.base, drag.sourceA, drag.sourceB, state.anchor1.point, pt)) {
                recalc();
                redraw();
            }
            return true;
        }
        if (drag?.kind === "affine") {
            if (applyAffineFromAnchors(drag.base, drag.sourceA, drag.sourceB, drag.sourceC, state.anchor1.point, state.anchor2.point, pt)) {
                recalc();
                redraw();
            }
            return true;
        }
        const target = cpForTarget(e.target);
        mapContainer.style.cursor = target ? "grab" : "default";
        return true;
    }

    function onMouseUp() {
        if (!state) return false;
        if (drag) {
            drag = null;
            mapContainer.style.cursor = "grab";
            state.stageBaseline = snapshot();
            renderPanel();
            refreshHighlights();
            return true;
        }
        return true;
    }

    return {
        start(cps) {
            const valid = (cps || []).filter(cp => cp?.start && cp?.ziel);
            if (!valid.length) {
                saveFile("ocad_bahn_import");
                saveSnapshot("OCAD-Bahn importiert");
                return;
            }
            state = {
                cps: valid,
                cpOrders: new Set(valid.map(cp => cp.order)),
                refs: pointRefs(valid),
                initial: null,
                stageBaseline: null,
                anchors: [],
                anchor1: null,
                anchor2: null,
                anchor3: null,
                includeRoutes: true,
                routeBackups: valid.map(cp => ({
                    cp,
                    routes: cp.routes || [],
                    complex: true,
                })),
            };
            state.initial = snapshot();
            state.stageBaseline = snapshot();
            document.body.classList.add("course-align-active");
            activeSubtool[ToolMode.CONTROL_PAIR] = "drag";
            setTool(ToolMode.CONTROL_PAIR);
            selection.ncp = valid[0].order;
            selection.nr = valid[0].routes?.length ? 0 : null;
            renderPanel();
            redraw();
            focusImported();
        },
        isActive() { return !!state; },
        onMouseDown,
        onMouseMove,
        onMouseUp,
        refreshHighlights,
        isImportedOrder(order) {
            return !!state?.cpOrders?.has(order);
        },
    };
})();

async function importCourseFile(file) {
    if (readOnly) return;
    if (!/\.ocd$/i.test(file.name)) {
        alert("Bitte eine OCD-Datei auswaehlen.");
        return;
    }
    if (file.size > 50 * 1024 * 1024) {
        alert("Datei zu gross (max. 50 MB)");
        return;
    }
    const targetSize = getCourseImportTargetSize();
    if (!targetSize) {
        alert("Bitte zuerst eine Karte oeffnen oder hochladen.");
        return;
    }

    const mode = await chooseOcadBahnImportMode();
    const menuItem = document.getElementById("nav-import-courses");
    if (menuItem) {
        menuItem.style.opacity = "0.45";
        menuItem.style.pointerEvents = "none";
    }
    try {
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
        const fd = new FormData();
        fd.append("file", file);
        fd.append("target_width", String(targetSize.width));
        fd.append("target_height", String(targetSize.height));
        fd.append("map_scale", String(projectMapScale()));
        const res = await fetch("/editor/import-courses/", {
            method: "POST",
            headers: { "X-CSRFToken": csrf },
            body: fd,
        });
        const data = await res.json();
        if (!res.ok) {
            alert(data.error || "OCAD-Bahn-Import fehlgeschlagen.");
            return;
        }
        applyImportedCourses(data.control_pairs, mode);
    } catch (e) {
        console.warn("importCourseFile:", e);
        alert("OCAD-Bahn-Import fehlgeschlagen.");
    } finally {
        if (menuItem) {
            menuItem.style.opacity = "";
            menuItem.style.pointerEvents = "";
        }
    }
}

let mapUploadGeneration = 0;
let localImagePreviewState = { generation: 0, prevSrc: null, prevDisplay: "", blobUrl: null };

function emitPublishWave(btn) {
    const rect = btn.getBoundingClientRect();
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    const el = document.createElement("div");
    el.className = "publish-wave";
    el.style.left = cx + "px";
    el.style.top  = cy + "px";
    document.body.appendChild(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
}
window.emitPublishWave = emitPublishWave;

function clearMapDisplayForUpload({ clearLayers = true } = {}) {
    const img = document.getElementById("map-img");
    if (img) {
        img.onload = null;
        img.onerror = null;
        img.style.display = "none";
        img.removeAttribute("src");
    }
    MaskLayer.clearMask?.();
    if (clearLayers) clearAllLayers();
}
window.clearMapDisplayForUpload = clearMapDisplayForUpload;

function resetProjectForOcadUpload() {
    const keepName = (project.name || currentProjectName || "Neues Projekt").trim() || "Neues Projekt";
    const keepLabel = project.label || null;

    setReadOnly(false);
    checkinCurrentFile();
    if (activeTool !== ControlPairTool) activateTool(ControlPairTool);
    // Drop pathing worker debug PNGs from the previous project.
    try { _clearDebugCorridors(); } catch (e) {}

    project = {
        id: null,
        name: keepName,
        published: false,
        label: keepLabel,
        scale: null,
        map_scale: 4000,
        scaled: false,
        map_file: "",
        has_mask: false,
        blocked_terrain: null,
        control_pairs: [],
    };
    selection.ncp = 0;
    selection.nr = null;

    undoStack = [];
    redoStack = [];
    actionCount = 0;
    clearMaskUndoStacks();
    updateUndoMenu();
    _pendingAutoPathfindCps.clear();

    clearMapDisplayForUpload({ clearLayers: true });
    updateFilenameInput();
    updateNavPublishBtn();
    updateNavLabel();
    updateCPList();
    _updateScalePanel();

    activeSubtool[ToolMode.CONTROL_PAIR] = "add";
    setTool(ToolMode.CONTROL_PAIR);
}

async function uploadSelectedMap() {
    const input = document.getElementById("map-file-input");
    const file  = _droppedMapFile || input?.files?.[0];
    _droppedMapFile = null;
    if (!file) return;

    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
    const isOcad = /\.(ocd|ocad)$/i.test(file.name);

    const ocadBtn = document.getElementById("ocad-upload-btn");
    if (ocadBtn) ocadBtn.disabled = true;
    closeMapModal();
    const uploadGeneration = ++mapUploadGeneration;
    const targetProjectId = isOcad ? project.id : null;
    if (isOcad) {
        // resetProjectForOcadUpload wipes ui-layer (including any spinner), so
        // the spinner must be (re-)shown afterwards to survive the reset.
        resetProjectForOcadUpload();
        showMapSpinner();
        showRasterizingBar();
    } else {
        showMapSpinner();
        showLocalImagePreview(file, uploadGeneration);
    }

    try {
        const fd = new FormData();
        fd.append("file", file);
        const res  = await fetch("/editor/upload-map/", {
            method: "POST",
            headers: { "X-CSRFToken": csrf },
            body: fd,
        });
        const data = await res.json();
        if (!res.ok || !data.map_file) {
            hideMapSpinner();
            if (isOcad) hideRasterizingBar();
            if (!isOcad) revertLocalImagePreview(uploadGeneration);
            alert(data.error || "Upload fehlgeschlagen.");
            if (ocadBtn) ocadBtn.disabled = false;
            return;
        }

        // Clear leftover state from previously open files now that we're committing
        if (!isOcad) {
            setReadOnly(false);
            checkinCurrentFile();
            updateFilenameInput();
        // New map replaces any previous editor state — wipe all undo history
            undoStack = []; redoStack = []; actionCount = 0;
            clearMaskUndoStacks();
            _pendingAutoPathfindCps.clear();
            updateUndoMenu();
        }

        // Update project state and save so the file exists on the server
        if (targetProjectId) project.id = targetProjectId;
        project.map_file = data.map_file;
        const uploadedScale = Number(data.scale);
        const uploadedMapScale = Number(data.map_scale);
        project.scale    = Number.isFinite(uploadedScale) && uploadedScale > 0 ? uploadedScale : null;
        project.map_scale = Number.isFinite(uploadedMapScale) && uploadedMapScale > 0 ? uploadedMapScale : 4000;
        project.scaled   = !!data.scaled && !!project.scale;
        project.has_mask = !!data.has_mask;
        const importPosten = !isOcad || _ocadImportChoices.posten;
        const importRouten = !isOcad || _ocadImportChoices.routen;
        if (importPosten && !project.control_pairs.length && Array.isArray(data.control_pairs) && data.control_pairs.length) {
            project.control_pairs = data.control_pairs.map((cp, i) => ({
                order:   i,
                start:   cp.start,
                ziel:    cp.ziel,
                complex: importRouten ? !!cp.complex : false,
                routes:  importRouten && Array.isArray(cp.routes) ? cp.routes : [],
            }));
            recalculateProjectRoutes();
            selection.ncp = 0;
            selection.nr  = 0;
        } else if (!project.control_pairs.length) {
            project.control_pairs = [];
            selection.ncp = 0;
            selection.nr  = 0;
        }
        const mapUploadSave = saveFile("map_upload");

        if (isOcad) {
            // OCAD: keep the spinner visible until the server-rendered raster is available,
            // then kick off the normal UNet mask pipeline.
            _loadMapInEditor(() => {
                hideRasterizingBar();
                if (data.auto_generate_mask && project.map_file === data.map_file && project.scale) {
                    Promise.resolve(mapUploadSave).then(() => {
                        if (project.map_file === data.map_file && project.scale && project.id) {
                            startMaskGeneration(project.map_file, project.scale, project.id);
                        }
                    });
                }
            }, { preserveLayers: true, silentLoad: true });
        }
        // For PNG/JPEG the blob URL is already on screen — no second download needed.

    } catch (e) {
        console.error("uploadSelectedMap:", e);
        hideMapSpinner();
        if (isOcad) hideRasterizingBar();
        if (!isOcad) revertLocalImagePreview(uploadGeneration);
        alert("Upload fehlgeschlagen.");
        if (ocadBtn) ocadBtn.disabled = false;
    }
}

function showLocalImagePreview(file, generation) {
    const img = document.getElementById("map-img");
    if (!img) return;

    const prevSrc = img.getAttribute("src") || null;
    const prevDisplay = img.style.display || "";
    const prevScale = project.scale;
    const prevMapScale = project.map_scale;
    const prevScaled = project.scaled;
    const prevHasMask = project.has_mask;
    if (localImagePreviewState.blobUrl) URL.revokeObjectURL(localImagePreviewState.blobUrl);

    const blobUrl = URL.createObjectURL(file);
    localImagePreviewState = { generation, prevSrc, prevDisplay, prevScale, prevMapScale, prevScaled, prevHasMask, blobUrl };

    // New raster needs fresh calibration; clear stale scale/mask state so the
    // immediate fit uses raw pixel dimensions instead of the previous map's scale.
    project.scale = null;
    project.map_scale = 4000;
    project.scaled = false;
    project.has_mask = false;

    img.onload = () => {
        if (localImagePreviewState.generation !== generation) return;
        hideMapSpinner();
        img.style.display = "block";
        applyProjectScale();
        MaskLayer.applyMapDimensions?.();
        drawCourse();
        fitMapDimensionsToCamera(img.naturalWidth, img.naturalHeight);
        _updateScalePanel();
    };
    img.onerror = () => {
        if (localImagePreviewState.generation !== generation) return;
        hideMapSpinner();
        console.warn("Local image preview failed to load");
    };
    img.src = blobUrl;
}

function revertLocalImagePreview(generation) {
    if (localImagePreviewState.generation !== generation) return;
    const img = document.getElementById("map-img");
    if (!img) return;
    if (localImagePreviewState.blobUrl) URL.revokeObjectURL(localImagePreviewState.blobUrl);
    img.onload = null;
    img.onerror = null;
    project.scale = localImagePreviewState.prevScale ?? null;
    project.map_scale = localImagePreviewState.prevMapScale ?? 4000;
    project.scaled = localImagePreviewState.prevScaled ?? false;
    project.has_mask = localImagePreviewState.prevHasMask ?? false;
    const prevSrc = localImagePreviewState.prevSrc;
    // Only restore server-side srcs; an earlier blob URL would already be revoked.
    if (prevSrc && !prevSrc.startsWith("blob:")) {
        img.src = prevSrc;
        img.style.display = localImagePreviewState.prevDisplay;
    } else {
        img.removeAttribute("src");
        img.style.display = "none";
    }
    localImagePreviewState = { generation: 0, prevSrc: null, prevDisplay: "", blobUrl: null };
}

function _loadMapInEditor(afterLoad = null, options = {}) {
    const img = document.getElementById("map-img");
    if (!img || !project.map_file) return;
    const preserveLayers = !!options.preserveLayers;
    const silentLoad = !!options.silentLoad;

    // Clear all leftover SVG elements and the previous map image
    if (!preserveLayers) {
        clearAllLayers();
        MaskLayer.clearMask?.();
    }
    img.style.display = "none";
    img.removeAttribute("src");

    if (!silentLoad) showMapSpinner();

    img.onload = () => {
        hideMapSpinner();
        img.style.display = "block";
        applyProjectScale();
        MaskLayer.applyMapDimensions?.();
        drawCourse();
        if (!preserveLayers) fitMapToCamera();
        _updateScalePanel();
        if (typeof afterLoad === "function") afterLoad();
    };
    img.onerror = () => { hideMapSpinner(); console.warn("Map image failed to load"); };
    img.src = `/editor/map/${project.map_file}`;
}

/* =========================================================
    SCALE / RULER TOOL
========================================================= */

let _scalingActive   = false;
let _scaleP1         = null;
let _scalePixelDist  = 0;

window._updateScalePanel = _updateScalePanel;
function _updateScalePanel() {
    const panel    = document.getElementById("scale-panel");
    const toolWrap = document.getElementById("radial-toolbar-wrap");
    if (!panel || !toolWrap) return;

    // A local blob-URL preview counts as a visible map even before the backend
    // has confirmed a server-side filename, so calibration starts immediately.
    const mapImg = document.getElementById("map-img");
    const hasVisibleMap = !!project.map_file || !!(mapImg?.getAttribute("src"));

    if (hasVisibleMap && !project.scaled) {
        panel.style.display    = "flex";
        toolWrap.style.display = "none";
        // Auto-activate — no button click needed
        if (!_scalingActive && !_scaleP1) _startScaleDrawing();
    } else {
        panel.style.display    = "none";
        toolWrap.style.display = "";
        _cancelScaleDrawing();
    }
}

function _startScaleDrawing() {
    _scalingActive = true;
    _scaleP1       = null;
    _clearRuler();
    mapContainer.style.cursor = "default";
    _setScaleStatus("Klicke ersten Punkt auf der Karte…");
}

function _cancelScaleDrawing() {
    _scalingActive = false;
    _scaleP1       = null;
    _clearRuler();
    hideCrosshair();
    mapContainer.style.cursor = "";
}

function _setScaleStatus(msg) {
    const el = document.getElementById("scale-status");
    if (el) el.textContent = msg;
}

// ── Ctrl+Z undo for scaling points ────────────────────────

function _undoScalePoint() {
    const modal = document.getElementById("modal-scale");
    if (modal?.style.display === "flex") {
        // Close modal, go back to waiting for second point
        modal.style.display = "none";
        _scalingActive = true;
        mapContainer.style.cursor = "default";
        if (_scaleP1) {
            _drawRuler(_scaleP1, _scaleP1);
            _setScaleStatus("Klicke zweiten Punkt…");
        }
    } else if (_scaleP1) {
        // Undo first point
        _scaleP1 = null;
        _clearRuler();
        _scalingActive = true;
        _setScaleStatus("Klicke ersten Punkt auf der Karte…");
    }
}

// ── Ruler SVG ─────────────────────────────────────────────

function _clearRuler() {
    document.getElementById("scale-ruler")?.remove();
}

function _drawRuler(p1, p2) {
    _clearRuler();
    const ns  = "http://www.w3.org/2000/svg";
    const uiL = document.getElementById("ui-layer");
    if (!uiL) return;

    const g = document.createElementNS(ns, "g");
    g.id = "scale-ruler";

    const attrs = (el, map) => { Object.entries(map).forEach(([k,v]) => el.setAttribute(k, v)); return el; };
    const line  = (x1,y1,x2,y2,extra) => attrs(document.createElementNS(ns,"line"),
        { x1,y1,x2,y2, "vector-effect":"non-scaling-stroke", ...extra });

    // Baseline (semi-transparent)
    g.appendChild(line(p1.x,p1.y,p2.x,p2.y,{
        stroke:"#000", "stroke-width":"5", "stroke-opacity":"0.2" }));
    // Minor ticks (every 6px cycle: 2px dash, 4px gap)
    g.appendChild(line(p1.x,p1.y,p2.x,p2.y,{
        stroke:"#111", "stroke-width":"8", "stroke-dasharray":"2 4" }));
    // Major ticks (every 30px cycle — every 5th minor)
    g.appendChild(line(p1.x,p1.y,p2.x,p2.y,{
        stroke:"#000", "stroke-width":"15", "stroke-dasharray":"3 27" }));

    uiL.appendChild(g);
}

// ── Scale modal ────────────────────────────────────────────

function _openScaleModal() {
    const modal = document.getElementById("modal-scale");
    if (!modal) return;
    modal.style.display = "flex";
    hideCrosshair();

    const distInp   = document.getElementById("scale-distance-m");
    const c1Inp     = document.getElementById("scale-coord-1");
    const c2Inp     = document.getElementById("scale-coord-2");
    const ratioInp  = document.getElementById("scale-ratio-input");
    const submitBtn = document.getElementById("scale-submit-btn");

    distInp.value  = "";
    c1Inp.value    = "";
    c2Inp.value    = "";
    ratioInp.value = String(projectMapScale());
    submitBtn.disabled = true;

    const check = () => {
        submitBtn.disabled = !(resolveScaleMeters(distInp.value, c1Inp.value, c2Inp.value) > 0);
    };
    distInp.oninput  = check;
    c1Inp.oninput    = check;
    c2Inp.oninput    = check;
    ratioInp.oninput = check;

    const onEnter = e => { if (e.key === "Enter" && !submitBtn.disabled) submitBtn.click(); };
    distInp.onkeydown  = onEnter;
    c1Inp.onkeydown    = onEnter;
    c2Inp.onkeydown    = onEnter;
    ratioInp.onkeydown = onEnter;

    setTimeout(() => distInp.focus(), 50);

    submitBtn.onclick = () => {
        const meters   = resolveScaleMeters(distInp.value, c1Inp.value, c2Inp.value);
        const mapScale = parseFloat(ratioInp.value) || 4000;
        if (!(meters > 0) || !(_scalePixelDist > 0)) return;

        // Same formula as old coursesetter: inputValue * 4000 / mapScale / dist / 0.48
        project.scale    = meters * 4000 / mapScale / _scalePixelDist / 0.48;
        project.map_scale = mapScale;
        project.scaled   = true;
        recalculateProjectRoutes();

        modal.style.display = "none";
        _clearRuler();
        _cancelScaleDrawing();
        applyProjectScale();
        fitMapToCamera();
        const scaleSave = saveFile("scale");
        saveSnapshot("autosave");
        _updateScalePanel();
        // Scaling is a point of no return — clear all undo history
        undoStack = []; redoStack = []; actionCount = 0;
        clearMaskUndoStacks();
        updateUndoMenu();
        // Start in add-control-pair mode
        activeSubtool[ToolMode.CONTROL_PAIR] = "add";
        setTool(ToolMode.CONTROL_PAIR);
        startNewPlacement();
        // Kick off mask generation silently in the background
        const maskMapFile = project.map_file;
        const maskScale = project.scale;
        Promise.resolve(scaleSave).then(() => {
            if (project.map_file === maskMapFile && project.scale === maskScale && project.id) {
                startMaskGeneration(maskMapFile, maskScale, project.id);
            }
        });
    };
}

// ── Mouse interception for ruler drawing ───────────────────

// Resolve scaling distance in metres from EITHER a typed distance OR two
// coordinate points. A distance value wins when present; otherwise both
// coordinate points must parse and we compute their great-circle distance.
function resolveScaleMeters(distValue, coord1Value, coord2Value) {
    const direct = parseScaleDistance(distValue);
    if (direct > 0) return direct;
    const p1 = parseScaleCoordinate(coord1Value);
    const p2 = parseScaleCoordinate(coord2Value);
    if (p1 && p2) return haversineMeters(p1, p2);
    return NaN;
}

// Parse a plain distance like "1234", "1234.5", "1234,5" or "1234 m".
function parseScaleDistance(value) {
    const text = String(value || "").trim();
    if (!text) return NaN;
    if (!/^\d+(?:[.,]\d+)?(?:\s*m)?$/i.test(text)) return NaN;
    const num = parseFloat(text.replace(",", "."));
    return num > 0 ? num : NaN;
}

// Parse a single "lat, lon" coordinate point. Returns {lat, lon} or null.
function parseScaleCoordinate(value) {
    const m = String(value || "")
        .match(/(-?\d+(?:[.,]\d+)?)\s*,\s*(-?\d+(?:[.,]\d+)?)/);
    if (!m) return null;
    const lat = Number(m[1].replace(",", "."));
    const lon = Number(m[2].replace(",", "."));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
}

function haversineMeters(a, b) {
    const toRad = deg => deg * Math.PI / 180;
    const R = 6371008.8;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function _scaleHandleUp(e) {
    const pt = screenToWorld(e.clientX, e.clientY);

    if (!_scaleP1) {
        // First point
        _scaleP1 = pt;
        _drawRuler(pt, pt);
        _setScaleStatus("Klicke zweiten Punkt…");
    } else {
        // Second point
        _scalePixelDist = Math.hypot(pt.x - _scaleP1.x, pt.y - _scaleP1.y);
        _drawRuler(_scaleP1, pt);
        _scalingActive = false;
        mapContainer.style.cursor = "";
        _openScaleModal();
    }
}

function _scaleHandleMove(e) {
    if (!_scalingActive) return;
    const pt = screenToWorld(e.clientX, e.clientY);
    updateCrosshair(pt.x, pt.y);
    if (_scaleP1) _drawRuler(_scaleP1, pt);
}

/* =========================================================
    MODALS
========================================================= */

function closeFileModal() {
    document.getElementById("modal-project").classList.remove("open");
}

function createFile() {
    detachMaskGenerationUi();
    closeFileModal();
    openMapModal();
}

function openMapModal() {
    document.getElementById("modal-map").classList.add("open");
    // Reset any leftover selection from a previous upload
    document.getElementById("map-dropzone").style.display = "";
    document.getElementById("ocad-import-options").style.display = "none";
    const fileInput = document.getElementById("map-file-input");
    if (fileInput) fileInput.value = "";
    _droppedMapFile = null;
    _ocadImportChoices = { posten: true, routen: true };
    initMapUpload();
}

function closeMapModal() {
    document.getElementById("modal-map").classList.remove("open");
}

function initMapUpload() {
    const dropzone = document.getElementById("map-dropzone");
    const input    = document.getElementById("map-file-input");
    if (!dropzone || !input) return;

    input.onchange   = (e) => handleMapFile(e.target.files?.[0]);
    dropzone.ondragover  = (e) => { e.preventDefault(); dropzone.classList.add("dragover"); };
    dropzone.ondragleave = ()  => dropzone.classList.remove("dragover");
    dropzone.ondrop      = (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
        handleMapFile(e.dataTransfer.files?.[0]);
    };
}

let _droppedMapFile = null;
let _ocadImportChoices = { posten: true, routen: true };

function handleMapFile(file) {
    if (!file) return;
    const isOcad = /\.(ocd|ocad)$/i.test(file.name);
    const maxSize = (isOcad ? 50 : 15) * 1024 * 1024;
    if (file.size > maxSize) {
        alert(isOcad ? "Datei zu gross (max. 50 MB)" : "Datei zu gross (max. 15 MB)");
        return;
    }
    _droppedMapFile = file;

    if (isOcad) {
        _showOcadImportOptions(file);
    } else {
        uploadSelectedMap();
    }
}

async function _showOcadImportOptions(file) {
    document.getElementById("map-dropzone").style.display = "none";
    const panel = document.getElementById("ocad-import-options");
    panel.style.display = "flex";
    panel.querySelector(".ocad-import-file-name").textContent = file.name;

    const postenRow   = document.getElementById("ocad-import-posten-row");
    const routenRow   = document.getElementById("ocad-import-routen-row");
    const postenCb    = document.getElementById("ocad-import-posten");
    const routenCb    = document.getElementById("ocad-import-routen");
    const importBtn   = document.getElementById("ocad-upload-btn");
    const checkingMsg = panel.querySelector(".ocad-import-checking");

    postenRow.style.display = "none";
    routenRow.style.display = "none";
    checkingMsg.style.display = "";
    importBtn.disabled = true;
    _ocadImportChoices = { posten: false, routen: false };

    let hasControls = false;
    let hasRoutes = false;
    try {
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/editor/analyze-ocad/", {
            method: "POST",
            headers: { "X-CSRFToken": csrf },
            body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "OCAD-Analyse fehlgeschlagen.");
        hasControls = !!data.has_controls;
        hasRoutes = hasControls && !!data.has_routes;
    } catch (e) {
        console.warn("OCAD content check failed:", e);
    }

    if (_droppedMapFile !== file) return;

    checkingMsg.style.display = "none";
    importBtn.disabled = false;

    postenRow.style.display = hasControls ? "" : "none";
    routenRow.style.display = hasRoutes ? "" : "none";

    postenCb.checked = hasControls;
    routenCb.checked = hasRoutes;
    routenCb.disabled = !hasControls;
    routenRow.querySelector("span").classList.toggle("ocad-check-disabled", !hasControls);
    _ocadImportChoices = { posten: hasControls, routen: hasRoutes };

    postenCb.onchange = () => {
        _ocadImportChoices.posten = postenCb.checked;
        if (!postenCb.checked) {
            routenCb.checked = false;
            routenCb.disabled = true;
            routenRow.querySelector("span").classList.add("ocad-check-disabled");
            _ocadImportChoices.routen = false;
        } else if (hasRoutes) {
            routenCb.disabled = false;
            routenRow.querySelector("span").classList.remove("ocad-check-disabled");
        }
    };
    routenCb.onchange = () => {
        _ocadImportChoices.routen = routenCb.checked;
    };
}

/* =========================================================
    NAV MENUS
========================================================= */

function initMenus() {
    const menuItems = document.querySelectorAll(".nav-menu-item");
    const isMobile = document.body.classList.contains("mobile");

    if (isMobile) {
        menuItems.forEach(menu => {
            if (menu.id === "menu-project") return;
            menu.addEventListener("click", (e) => {
                // Clicks on the sub-dropdown content are handled by their own
                // listeners — don't toggle the menu, but still keep the
                // surrounding hamburger panel open.
                if (e.target.closest(".nav-dropdown")) { e.stopPropagation(); return; }
                // Toggling a main menu option must NOT collapse the hamburger
                // panel: stop the click from bubbling to the document-level
                // closeAllHam handler in base.html.
                e.stopPropagation();
                const wasOpen = menu.classList.contains("open");
                menuItems.forEach(other => other.classList.remove("open"));
                menu.classList.toggle("open", !wasOpen);
            });
        });
        document.addEventListener("click", (e) => {
            if (!e.target.closest(".nav-menu-item")) {
                menuItems.forEach(m => m.classList.remove("open"));
            }
        });

        // ── Mobile project-menu hamburger ─────────────────────
        // "P..." still opens the file modal (wired in projecttable.js); the
        // hamburger reveals the remaining project options (Duplizieren /
        // Speichern). Toggle a dedicated class so it doesn't collide with the
        // desktop hover-driven .open state.
        const projectMenu = document.getElementById("menu-project");
        const projectHam  = document.getElementById("nav-project-ham");
        if (projectMenu && projectHam) {
            projectHam.addEventListener("click", (e) => {
                e.stopPropagation();           // don't trigger openFileModal / document close
                projectMenu.classList.toggle("project-menu-open");
            });
            // Tapping an option (Duplizieren / Speichern) closes the menu after
            // its own handler runs; clicks inside the dropdown shouldn't bubble
            // up to #menu-project's openFileModal handler.
            const projectDropdown = document.getElementById("project-dropdown");
            projectDropdown?.addEventListener("click", () => {
                projectMenu.classList.remove("project-menu-open");
            });
            document.addEventListener("click", (e) => {
                if (!e.target.closest("#menu-project")) {
                    projectMenu.classList.remove("project-menu-open");
                }
            });
        }
    } else {
        menuItems.forEach(menu => {
            menu.addEventListener("mouseenter", () => {
                menuItems.forEach(other => { if (other !== menu) other.classList.remove("open"); });
                menu.classList.add("open");
            });
            menu.addEventListener("mouseleave", () => menu.classList.remove("open"));
        });
    }

    document.getElementById("batch-switch-lr")?.addEventListener("click", () => {
        if (readOnly || !project?.control_pairs?.length) return;
        pushUndoState("Postentypen angepasst");
        let changed = 0;
        project.control_pairs.forEach(cp => {
            if (cp.complex && cp.routes.length == 2) {
                cp.complex = false;
                saveControlPair(cp);
                changed++;
            } else if (!cp.complex && cp.routes.length != 2) {
                cp.complex = true;
                saveControlPair(cp);
                changed++;
            }
        });
        if (changed) { updateCPList(); drawCourse(); }
    });

    document.getElementById("batch-auto-pathfind")?.addEventListener("click", () => {
        if (readOnly || !project?.control_pairs?.length) return;
        pushUndoState("Batch Pathing");
        const batchTargets = project.control_pairs.filter(cp => (
            cp.start && cp.ziel && project.map_file && _canAutoPathfindCP(cp)
        ));
        if (!batchTargets.length) return;
        const useBatchSave = _maskReadyForAutoPathfind();
        if (useBatchSave) _beginAutoPathfindBatchSave();
        batchTargets.forEach(cp => requestAutoPathfindForControlPair(cp));
        if (useBatchSave) _finishAutoPathfindBatchSaveIfIdle();
    });
}

/* =========================================================
    CAMERA
========================================================= */

function updateCameraTransform({ x = camera.x, y = camera.y, zoom = camera.zoom } = {}) {
    camera.x = x; camera.y = y; camera.zoom = zoom;

    document.getElementById("camera").style.transform =
        `translate(${x}px, ${y}px) scale(${zoom})`;

    const bg       = document.getElementById("map-background");
    const major    = 250 * zoom;
    const minor    = 50  * zoom;
    const majorDot = 2   * Math.sqrt(zoom);
    const minorDot = 1.5 * Math.sqrt(zoom);

    bg.style.backgroundSize = `${major}px ${major}px, ${minor}px ${minor}px`;
    bg.style.backgroundImage = `
        radial-gradient(circle, rgba(120,120,120,1) ${majorDot}px, transparent ${majorDot}px),
        radial-gradient(circle, rgba(120,120,120,1) ${minorDot}px, transparent ${minorDot}px)
    `;
    bg.style.backgroundPosition =
        `${x % major}px ${y % major}px, ${x % minor}px ${y % minor}px`;
}

function resetCamera() {
    camera.x = 0; camera.y = 0; camera.zoom = 1;
    updateCameraTransform();
}

function centerMap(imgWidth, imgHeight) {
    const rect  = mapContainer.getBoundingClientRect();
    camera.zoom = 1;
    camera.x    = (rect.width  - imgWidth)  / 2;
    camera.y    = (rect.height - imgHeight) / 2;
    updateCameraTransform();
}

function fitMapToCamera() {
    const img = document.getElementById("map-img");
    if (!img || !img.naturalWidth) return;
    fitMapDimensionsToCamera(img.naturalWidth, img.naturalHeight);
}

function fitMapDimensionsToCamera(width, height) {
    if (!(width > 0) || !(height > 0)) return;
    const rect  = mapContainer.getBoundingClientRect();
    const mapW  = width  * (project.scale || 1);
    const mapH  = height * (project.scale || 1);
    const MARGIN = 0.92;
    const zoom  = Math.min(
        Math.max(rect.width  / mapW * MARGIN, zoomMin),
        Math.min(rect.height / mapH * MARGIN, zoomMax),
    );
    const x = (rect.width  - mapW * zoom) / 2;
    const y = (rect.height - mapH * zoom) / 2;
    updateCameraTransform({ x, y, zoom });
}

function applyProjectScale() {
    const scaleLayer = document.getElementById("map-scale-layer");
    scaleLayer.style.transform       = `scale(${project.scale || 1})`;
    scaleLayer.style.transformOrigin = "top left";
}

/* =========================================================
    DRAW
========================================================= */

function startNewPlacement() {
    activeSubtool[ToolMode.CONTROL_PAIR] = "add";
    setTool(ToolMode.CONTROL_PAIR);
    activateTool(PlaceControlTool.init(
        { id: null, order: null, start: null, ziel: null, complex: true, routes: [] }
    ));
    requestAnimationFrame(() => document.querySelector(".cp-add-btn")?.scrollIntoView({ block: "nearest" }));
}

function startNewRoute() {
    let cp = project.control_pairs.find(c => c.order === selection.ncp);
    if (!cp && project.control_pairs.length) {
        // Fall back to the last control pair if none is selected
        cp = project.control_pairs[project.control_pairs.length - 1];
        selection.ncp = cp.order;
        updateCPList();
    }
    if (!cp) return;
    updateControlPairs(cp.order);  // highlight the selected CP in the map
    setTool(ToolMode.ROUTE);
    activateTool(NewRouteTool.init(cp));
}

// (visibility-graph pathing removed)

const _activePathfindByCp = new Map();   // legacy — kept so undefined references don't throw if other code paths still mention it
let _autoPathfindInFlight = 0;           // for UI badge
let _pathfindUiUpdateFrame = null;

function _setAutoPathfindBusy(busy) {
    _autoPathfindInFlight = Math.max(0, _autoPathfindInFlight + (busy ? 1 : -1));
    document.body.classList.toggle("auto-pathfind-busy", _autoPathfindInFlight > 0);
}

function _queuePathfindUiUpdate() {
    if (_pathfindUiUpdateFrame !== null) return;
    _pathfindUiUpdateFrame = requestAnimationFrame(() => {
        _pathfindUiUpdateFrame = null;
        updateCPList();
    });
}

function _setPathfindBusyForCp(cp, busy) {
    _setAutoPathfindBusy(busy);
    if (!cp) {
        _queuePathfindUiUpdate();
        return;
    }
    const count = Math.max(0, (_activePathfindByCp.get(cp) || 0) + (busy ? 1 : -1));
    if (count) _activePathfindByCp.set(cp, count);
    else _activePathfindByCp.delete(cp);
    _queuePathfindUiUpdate();
}

function _clearPathfindBusyForCp(cp) {
    if (!cp) {
        _queuePathfindUiUpdate();
        return;
    }
    _autoPathfindRunningCps.delete(cp);
    _queuePathfindUiUpdate();
}

function _isPathfindBusyForCp(cp) {
    return !!(cp && (_activePathfindByCp.get(cp) || _autoPathfindRunningCps.has(cp)));
}

function _canExpectAnotherPathfindRoute(cp) {
    if (!cp) return false;
    return (cp.routes?.length || 0) < autoPathfindMaxRoutes();
}

function _routeFromPolyline(cp, polyline) {
    if (!polyline || polyline.length < 2) return null;
    const route = {
        id:       null,
        order:    cp.routes.length,
        rP:       polyline.map(([x, y]) => ({ x, y })),
        noA:      null,
        pos:      null,
        length:   null,
        run_time: null,
        elevation: 0,
    };
    calcRouteLength(route);
    calcRouteNoA(route);
    calcRouteRunTime(route);
    calcRouteSide(cp, route);
    return route;
}

function projectStillContainsRoute(cp, route) {
    return !!(cp && route && project?.control_pairs?.includes(cp) && cp.routes?.includes(route));
}

function _markGeneratedRouteAnimation(cp, route) {
    if (!route?.rP?.length) return;
    const anim = {
        start: performance.now(),
        drawMs: generatedRouteDrawMs(route),
        holdMs: GENERATED_ROUTE_HOLD_MS,
    };
    route._generatedRouteAnim = anim;
    scheduleGeneratedRouteAnimationFrame();
    setTimeout(() => {
        if (route._generatedRouteAnim !== anim) return;
        if (!projectStillContainsRoute(cp, route)) return;
        drawRoutes();
        updateRoutes();
    }, anim.drawMs);
    setTimeout(() => {
        if (route._generatedRouteAnim !== anim) return;
        delete route._generatedRouteAnim;
        if (!projectStillContainsRoute(cp, route)) return;
        drawRoutes();
        updateRoutes();
    }, anim.drawMs + anim.holdMs);
}

function _autoUpgradeComplex(cp) {
    if (!cp.complex && cp.routes.length != 2) {
        cp.complex = true;
        saveControlPair(cp);
        updateCPList();
    }
}

function _appendRouteObject(cp, route, { animate = false } = {}) {
    if (!route) return null;
    route.order = cp.routes.length;
    cp.routes.push(route);
    if (animate) _markGeneratedRouteAnimation(cp, route);
    saveRoute(cp, route);
    _autoUpgradeComplex(cp);
    return route;
}

function _appendRouteFromPolyline(cp, polyline, options = {}) {
    return _appendRouteObject(cp, _routeFromPolyline(cp, polyline), options);
}

function _fastestRouteRunTime(cp) {
    let fastest = Infinity;
    for (const route of cp?.routes || []) {
        const rt = Number(route?.run_time);
        if (Number.isFinite(rt) && rt > 0 && rt < fastest) fastest = rt;
    }
    return fastest;
}

function _slowestRouteRunTime(cp) {
    let slowest = -Infinity;
    for (const route of cp?.routes || []) {
        const rt = Number(route?.run_time);
        if (Number.isFinite(rt) && rt > 0 && rt > slowest) slowest = rt;
    }
    return slowest;
}

function _syncRoutesToControlEndpoint(cp, pointType) {
    const isStart = pointType === "start";
    const point = cp?.[pointType];
    if (!point) return;
    for (const route of cp.routes || []) {
        if (!route.rP?.length) continue;
        const endpoint = isStart ? route.rP[0] : route.rP[route.rP.length - 1];
        endpoint.x = point.x;
        endpoint.y = point.y;
        calcRouteLength(route);
        calcRouteNoA(route);
        calcRouteRunTime(route);
        calcRouteSide(cp, route);
        saveRoute(cp, route);
    }
}

function _snapControlPairEndpointsToPassableMask(cp) {
    if (!cp || !MaskLayer.isLoaded?.()) return false;
    let changed = false;
    for (const pointType of ["start", "ziel"]) {
        const point = cp[pointType];
        const snapped = MaskLayer.nearestPassableMapPoint?.(point, CONTROL_POINT_PASSABLE_SNAP_M);
        if (!point || !snapped) continue;
        if (Math.hypot(snapped.x - point.x, snapped.y - point.y) < 0.01) continue;
        point.x = snapped.x;
        point.y = snapped.y;
        _syncRoutesToControlEndpoint(cp, pointType);
        changed = true;
    }
    if (!changed) return false;
    saveControlPair(cp);
    updateControlPairGroup(cp);
    drawRoutes();
    updateRoutes();
    updateCPList();
    return true;
}

function _movePointToNearestPassableIfImpassable(point) {
    if (!point || !MaskLayer.isLoaded?.()) return point;
    return MaskLayer.nearestPassableMapPoint?.(point, CONTROL_POINT_PASSABLE_SNAP_M) || point;
}

function pathingRoutesPayload(routes) {
    const out = [];
    for (const route of routes || []) {
        const rP = (route?.rP || [])
            .map(p => ({ x: Number(p?.x), y: Number(p?.y) }))
            .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (rP.length >= 2) out.push({ rP });
    }
    return out;
}

function pathingPointPayload(point) {
    return { x: Number(point?.x), y: Number(point?.y) };
}

function pathingBlockedTerrainPayload(blockedTerrain) {
    const out = { lines: [], areas: [] };
    for (const line of blockedTerrain?.lines || []) {
        const start = pathingPointPayload(line?.start);
        const end = pathingPointPayload(line?.end);
        if (Number.isFinite(start.x) && Number.isFinite(start.y) && Number.isFinite(end.x) && Number.isFinite(end.y)) {
            out.lines.push({ start, end });
        }
    }
    for (const area of blockedTerrain?.areas || []) {
        const points = (area?.points || [])
            .map(pathingPointPayload)
            .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (points.length >= 3) out.areas.push({ points });
    }
    return out;
}

function assertPathingMessageCloneable(message) {
    if (typeof structuredClone !== "function") return;
    try {
        structuredClone(message);
    } catch (err) {
        for (const [key, value] of Object.entries(message || {})) {
            try { structuredClone(value); }
            catch (fieldErr) {
                console.warn("[theta-client] non-cloneable pathing field:", key, fieldErr);
                break;
            }
        }
        throw err;
    }
}

/* =========================================================
    CLIENT-SIDE Î¸*  (Web Worker, pure JS port of pathing/theta.py)
    Worker lives once per editor session, owns the active mask + connectivity
    labels. CP auto-fire posts {start, ziel, blockedTerrain}; the worker
    replies with {path, timings}. Timings prefixed [theta-client] in console
    so they line up with the [theta] lines the server emits in stdout.
========================================================= */

let _pathingWorker = null;
let _pathingMaskKey = null;        // basename of the mask currently in the worker
const _pathingPending = new Map(); // msgId -> {resolve}
let _pathingMsgSeq = 0;
const _pendingAutoPathfindCps = new Set();
const _autoPathfindRunningCps = new Set();
let _autoPathfindBatchSaveActive = false;
let _autoPathfindBatchSaveDirty = false;
let _autoPathfindBatchSaveFinishing = false;
// Number of routes auto-generation creates per control pair — driven by the
// nav-bar slider (0 = off, max 4). Replaces the former hard-coded limit of 4.
function autoPathfindMaxRoutes() {
    return Math.max(0, Math.min(4, editorSettings.auto_pathfind | 0));
}
let _pathfindGeneration = 0;

function _beginAutoPathfindBatchSave() {
    if (readOnly) return;
    _autoPathfindBatchSaveActive = true;
}

function _shouldDeferAutoPathfindSaves() {
    return _autoPathfindBatchSaveActive
        && !readOnly
        && (_autoPathfindRunningCps.size > 0 || _pathingPending.size > 0 || _autoPathfindInFlight > 0);
}

function _markAutoPathfindBatchDirty() {
    if (_autoPathfindBatchSaveActive) _autoPathfindBatchSaveDirty = true;
}

function _hasDeferredAutoPathfindSave() {
    return _autoPathfindBatchSaveActive && _autoPathfindBatchSaveDirty;
}

function _autoPathfindBatchHasWork() {
    return _autoPathfindRunningCps.size > 0
        || _pathingPending.size > 0
        || _autoPathfindInFlight > 0;
}

function _resetAutoPathfindBatchSave() {
    _autoPathfindBatchSaveActive = false;
    _autoPathfindBatchSaveDirty = false;
}

function _finishAutoPathfindBatchSaveIfIdle() {
    if (!_autoPathfindBatchSaveActive || _autoPathfindBatchSaveFinishing) return;
    if (_autoPathfindBatchHasWork()) return;

    const shouldSave = _autoPathfindBatchSaveDirty;
    _resetAutoPathfindBatchSave();
    if (!shouldSave) return;

    _autoPathfindBatchSaveFinishing = true;
    saveFile("batch_auto_pathfind").finally(() => {
        _autoPathfindBatchSaveFinishing = false;
    });
}

function _resolveAllPathingPending(error) {
    for (const [msgId, slot] of _pathingPending.entries()) {
        _pathingPending.delete(msgId);
        slot.resolve({ type: "path", msgId, error });
    }
    _activePathfindByCp.clear();
    while (_autoPathfindInFlight > 0) _setAutoPathfindBusy(false);
    _queuePathfindUiUpdate();
}

function cancelAllPathing() {
    _pathfindGeneration++;
    _pendingAutoPathfindCps.clear();
    _autoPathfindRunningCps.clear();
    _resetAutoPathfindBatchSave();
    _resolveAllPathingPending("cancelled");
}

function _canAutoPathfindCP(cp) {
    if (readOnly || !editorSettings.auto_pathfind) return false;
    if (!cp || !cp.start || !cp.ziel) return false;
    if (!project.control_pairs.includes(cp)) return false;
    if (!cp.complex && (cp.routes?.length || 0) >= autoPathfindMaxRoutes()) return false;
    return true;
}

function _maskReadyForAutoPathfind() {
    return !!(project.map_file && project.has_mask && _pathingMaskKey === project.map_file);
}

function _fireAutoPathfindForCP(cp, source = "editor_auto") {
    if (!_canAutoPathfindCP(cp) || !_maskReadyForAutoPathfind()) return false;
    if (_autoPathfindRunningCps.has(cp)) return true;
    _pendingAutoPathfindCps.delete(cp);
    _autoPathfindRunningCps.add(cp);
    (async () => {
        try {
            const targetRoutes = autoPathfindMaxRoutes();
            let rejectedBlockers = [];
            let rejectedAttemptsForSlot = 0;
            while (_canAutoPathfindCP(cp) && _maskReadyForAutoPathfind() && (cp.routes?.length || 0) < targetRoutes) {
                const before = cp.routes?.length || 0;
                const result = await thetaCPClient(cp, source, { blockedRoutes: rejectedBlockers });
                if (result?.distinct === false || result?.tooSlow === true) {
                    if (result.blockedRoute) rejectedBlockers.push(result.blockedRoute);
                    rejectedAttemptsForSlot++;
                    if (rejectedAttemptsForSlot <= 1) continue;
                    break;
                }
                if (result?.error) {
                    if (!["max auto routes", "not distinct", "too slow"].includes(result.error)) {
                        console.warn("theta (client) auto-fire failed", result.error);
                    }
                    break;
                }
                if ((cp.routes?.length || 0) <= before) break;
                rejectedBlockers = [];
                rejectedAttemptsForSlot = 0;
            }
        } catch (e) {
            console.warn("theta (client) auto-fire failed", e);
        } finally {
            _autoPathfindRunningCps.delete(cp);
            _queuePathfindUiUpdate();
            _finishAutoPathfindBatchSaveIfIdle();
        }
    })();
    return true;
}

function requestAutoPathfindForControlPair(cp) {
    if (!_canAutoPathfindCP(cp)) {
        _pendingAutoPathfindCps.delete(cp);
        if ((cp?.routes?.length || 0) >= autoPathfindMaxRoutes()) _clearPathfindBusyForCp(cp);
        _finishAutoPathfindBatchSaveIfIdle();
        return;
    }
    if (_fireAutoPathfindForCP(cp)) return;
    _pendingAutoPathfindCps.add(cp);
}

function drainPendingAutoPathfindQueue() {
    if (!_maskReadyForAutoPathfind() || !editorSettings.auto_pathfind || readOnly) return;
    for (const cp of [..._pendingAutoPathfindCps]) {
        if (!_canAutoPathfindCP(cp)) {
            _pendingAutoPathfindCps.delete(cp);
            continue;
        }
        _fireAutoPathfindForCP(cp);
    }
    _finishAutoPathfindBatchSaveIfIdle();
}

function _ensurePathingWorker() {
    if (_pathingWorker) return _pathingWorker;
    try {
        _pathingWorker = new Worker("/static/project/js/pathing/worker.js", { type: "module" });
    } catch (e) {
        console.warn("pathing worker: failed to instantiate", e);
        return null;
    }
    _pathingWorker.addEventListener("message", (e) => {
        const m = e.data;
        if (!m || m.type !== "path") return;
        const slot = _pathingPending.get(m.msgId);
        if (!slot) return;
        _pathingPending.delete(m.msgId);
        slot.resolve(m);
    });
    _pathingWorker.addEventListener("error", (e) => {
        const message = e.message || "worker crashed";
        console.warn("pathing worker error:", message, e);
        _resolveAllPathingPending(message);
        try { _pathingWorker?.terminate(); } catch (_) {}
        _pathingWorker = null;
        _pathingMaskKey = null;
    });
    _pathingWorker.addEventListener("messageerror", (e) => {
        console.warn("pathing worker message error:", e);
        _resolveAllPathingPending("worker message error");
    });
    return _pathingWorker;
}

function sendMaskToPathingWorker(mapFile, imgData) {
    const w = _ensurePathingWorker();
    if (!w || !imgData) return;
    // Extract greyscale channel into a fresh Uint8Array we can transfer.
    const W = imgData.width, H = imgData.height;
    const greys = new Uint8Array(W * H);
    const d = imgData.data;
    for (let i = 0, j = 0; i < greys.length; i++, j += 4) greys[i] = d[j];
    _pathingMaskKey = mapFile;
    w.postMessage(
        { type: "maskReady", filename: mapFile, width: W, height: H, buffer: greys.buffer },
        [greys.buffer],
    );
    drainPendingAutoPathfindQueue();
}

function sendMaskDiffToPathingWorker(mapFile, diff, reverse = false) {
    const w = _ensurePathingWorker();
    if (!w || !mapFile || !diff?.indices?.length) return;
    if (_pathingMaskKey !== mapFile) return;
    const values = reverse ? diff.oldVals : diff.newVals;
    if (!values || values.length !== diff.indices.length) return;
    const indicesCopy = new Uint32Array(diff.indices);
    const valuesCopy = new Uint8Array(values);
    w.postMessage(
        {
            type: "maskDiff",
            filename: mapFile,
            indices: indicesCopy.buffer,
            values: valuesCopy.buffer,
        },
        [indicesCopy.buffer, valuesCopy.buffer],
    );
}

async function thetaCPClient(cp, source = "editor_auto", options = {}) {
    if (!cp || !cp.start || !cp.ziel || !project.map_file) return { error: "missing inputs" };
    if (readOnly) return { error: "read only" };
    const gen = _pathfindGeneration;
    const isAuto = source === "editor_auto";
    if (isAuto && !cp.complex && cp.routes.length >= autoPathfindMaxRoutes()) return { error: "max auto routes" };
    const w = _ensurePathingWorker();
    if (!w) return { error: "worker unavailable" };
    if (_pathingMaskKey !== project.map_file) return { error: "mask not yet loaded into worker" };
    _snapControlPairEndpointsToPassableMask(cp);

    const msgId = ++_pathingMsgSeq;
    const wallStart = performance.now();
    const existingRoutesPayload = pathingRoutesPayload(cp.routes);
    const blockedRoutesPayload = pathingRoutesPayload(options.blockedRoutes);
    const pathfindMessage = {
        type: "pathfind",
        msgId,
        start: pathingPointPayload(cp.start),
        ziel: pathingPointPayload(cp.ziel),
        mapScale: Number.isFinite(Number(project.scale)) ? Number(project.scale) : null,
        existingRoutes: existingRoutesPayload,
        blockedRoutes: blockedRoutesPayload,
        blockedTerrain: pathingBlockedTerrainPayload(project.blocked_terrain),
    };
    assertPathingMessageCloneable(pathfindMessage);
    _setPathfindBusyForCp(cp, true);
    let reply;
    try {
        reply = await new Promise((resolve, reject) => {
            _pathingPending.set(msgId, { resolve });
            try {
                w.postMessage(pathfindMessage);
            } catch (err) {
                _pathingPending.delete(msgId);
                reject(err);
            }
        });
    } finally {
        _setPathfindBusyForCp(cp, false);
    }
    const wallMs = Math.round(performance.now() - wallStart);

    if (reply.error) {
        console.warn(`[theta-client] ${wallMs}ms wall — ${reply.error}`);
        if (!reply.path) return { error: reply.error };
    }
    const path = reply.path;
    const hasThetaPath = path && path.length >= 2;
    if (!hasThetaPath) return { error: reply.error || "empty path" };
    const candidateRoute = _routeFromPolyline(cp, path);
    if (!candidateRoute) return { error: "empty path" };
    if (reply.timings) {
        const ms = Object.fromEntries(Object.entries(reply.timings).map(([k, v]) => [k, Math.round(v)]));
        console.log(`[theta-client] ${wallMs}ms wall (worker total ${ms.total}ms)`, ms);
    }

    //   2) Î¸* with the standard simplify_theta_path post-processing.
    // Append only the final theta* polyline; raw A* stays in the debug PNG.
    const existingRouteCount = cp.routes?.length || 0;
    if (isAuto && existingRouteCount > 0 && reply.distinct === false) {
        console.log(`[theta-client] candidate route rejected: ${reply.distinctReason || "not distinct"}`);
        return {
            path,
            timings: reply.timings,
            distinct: false,
            distinctReason: reply.distinctReason || "not distinct",
            blockedRoute: candidateRoute,
            error: "not distinct",
        };
    }
    if (isAuto && existingRouteCount === 1) {
        const fastestRunTime = _fastestRouteRunTime(cp);
        if (Number.isFinite(fastestRunTime) && candidateRoute.run_time > fastestRunTime * 1.5) {
            console.log(
                `[theta-client] candidate route rejected: second route runtime ${Math.round(candidateRoute.run_time)}s > 150% of fastest ${Math.round(fastestRunTime)}s`,
            );
            return {
                path,
                timings: reply.timings,
                tooSlow: true,
                runTime: candidateRoute.run_time,
                fastestRunTime,
                blockedRoute: candidateRoute,
                error: "too slow",
            };
        }
    } else if (isAuto && existingRouteCount >= 2) {
        const slowestRunTime = _slowestRouteRunTime(cp);
        if (Number.isFinite(slowestRunTime) && candidateRoute.run_time > slowestRunTime * 1.1) {
            console.log(
                `[theta-client] candidate route rejected: runtime ${Math.round(candidateRoute.run_time)}s > 110% of slowest accepted ${Math.round(slowestRunTime)}s`,
            );
            return {
                path,
                timings: reply.timings,
                tooSlow: true,
                runTime: candidateRoute.run_time,
                slowestRunTime,
                blockedRoute: candidateRoute,
                error: "too slow",
            };
        }
    }

    if (gen !== _pathfindGeneration) return { error: "cancelled" };

    pushUndoState("automatische Route");
    _appendRouteObject(cp, candidateRoute, { animate: true });
    selection.nr = cp.routes.length - 1;
    drawRoutes();
    updateRoutes();
    updateCPList();

    const debugEntries = await buildPathDebugDownloads(cp, reply);
    if (debugEntries.length) {
        _setDebugCorridors(cp.order, debugEntries, {
            offsetX: reply.debugOffsetX, offsetY: reply.debugOffsetY,
            width:   reply.debugWidth,   height:  reply.debugHeight,
        });
        updateCPList();
    }

    return { path, timings: reply.timings, distinct: true, error: reply.error || null };
}

// Latest corridor-constrained debug grid per CP — object URLs are revoked
// when replaced or when the editor closes the map. updateCPList renders a
// small "Korridor ⬇" link on the CP that owns the freshest blob.
const _debugCorridors = new Map();   // cp.order → {url, filename, meta}

function renderPathDebugBlobFromGrid(buffer, width, height, path = null, color = [255, 64, 64]) {
    if (!buffer || !(width > 0) || !(height > 0)) return Promise.resolve(null);
    const grid = new Uint8Array(buffer);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(width, height);
    const d = img.data;
    for (let i = 0, j = 0; i < grid.length; i++, j += 4) {
        const v = grid[i];
        d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (path && path.length >= 4) {
        const lineWidth = Math.max(2, Math.round(Math.min(width, height) / 220));
        ctx.save();
        ctx.strokeStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
        ctx.lineWidth = lineWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(path[0], path[1]);
        for (let i = 2; i + 1 < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
        ctx.stroke();
        ctx.fillStyle = "#00ff80";
        ctx.beginPath();
        ctx.arc(path[0], path[1], lineWidth * 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffcc00";
        ctx.beginPath();
        ctx.arc(path[path.length - 2], path[path.length - 1], lineWidth * 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

async function buildPathDebugDownloads(cp, reply) {
    const W = reply.debugWidth;
    const H = reply.debugHeight;
    const base = `cp${cp.order}_${Math.round(cp.start.x)}-${Math.round(cp.start.y)}_to_${Math.round(cp.ziel.x)}-${Math.round(cp.ziel.y)}`;
    const specs = [
        ["A* raw", "astar_raw", reply.debugBaseGridBuffer, reply.debugPaths?.astar_raw, [255, 64, 64]],
    ];
    const links = [];
    for (const [label, slug, buffer, path, color] of specs) {
        let blob = null;
        blob = await renderPathDebugBlobFromGrid(buffer, W, H, path, color);
        if (!blob) continue;
        links.push({
            label,
            url: URL.createObjectURL(blob),
            filename: `${slug}_${base}.png`,
        });
    }
    return links;
}

function _setDebugCorridors(cpOrder, links, meta) {
    const old = _debugCorridors.get(cpOrder);
    if (old) {
        for (const link of old.links || []) {
            try { URL.revokeObjectURL(link.url); } catch (e) {}
        }
    }
    _debugCorridors.set(cpOrder, { links, meta });
}

function _clearDebugCorridors() {
    for (const entry of _debugCorridors.values()) {
        for (const link of entry.links || []) {
            try { URL.revokeObjectURL(link.url); } catch (e) {}
        }
    }
    _debugCorridors.clear();
}

function routeListDebugLink(cpOrder) {
    const entry = _debugCorridors.get(cpOrder);
    if (!entry?.links?.length) return "";
    const { links, meta } = entry;
    const title = `Debug grid: ${meta.width}x${meta.height}px @ (${meta.offsetX},${meta.offsetY})`;
    return `<span class="cp-route-debug-links" title="${title}">
        ${links.map(link => `<a class="cp-route-debug-link" href="${link.url}" download="${link.filename}" title="${link.label}" aria-label="${link.label}" onclick="event.stopPropagation()">${icon("mask", "0.9em")}</a>`).join("")}
    </span>`;
}

function addAndPlaceControlPair() {
    if (readOnly) return;
    const selectedCp = project.control_pairs.find(c => c.order === selection.ncp);
    if (selectedCp) {
        setTool(ToolMode.CONTROL_PAIR);
        activateTool(PlaceControlTool.init(selectedCp, true));
    } else {
        startNewPlacement();
    }
}

function drawCourse() {
    clearCourseLayers();
    if (!project?.control_pairs) return;
    project.control_pairs.forEach(cp => drawControlPairGroup(cp));
    drawRoutes();
    drawBlockedTerrain();
    const selectedCp = project.control_pairs.find(c => c.order === selection.ncp);
    if (selectedCp) updateControlPairGroup(selectedCp);
    updateRoutes();
    CourseAlignMode.refreshHighlights();
    updateCPList();
}

/* =========================================================
    CP LIST
========================================================= */

function updateCPList() {
    const list = document.getElementById("cp-list");
    if (!list) return;
    list.innerHTML = "";
    if (!project?.control_pairs?.length) return;

    project.control_pairs.forEach(cp => {
        const row = document.createElement("div");
        row.className = "cp-row"
            + (cp.order === selection.ncp ? " selected" : "")
            + (CourseAlignMode.isImportedOrder(cp.order) ? " ocad-bahn-new" : "");
        row.dataset.ncp = cp.order;
        textRouten = cp.routes.length === 1 ? "Route" : "Routen";
        const cpBusy = _isPathfindBusyForCp(cp);
        row.innerHTML = `
            ${readOnly ? '' : `<span class="cp-grip" title="Drag to reorder"></span>`}
            <span class="cp-row-label">
                <span class="cp-posten-text">Posten ${cp.order + 1}</span>
                <span class="cp-route-count">${cp.routes.length} ${textRouten}</span>
                ${cpBusy ? `<x-icon name="spinner" class="spin cp-busy-spinner" size="1em"></x-icon>` : ''}
            </span>
            <div class="cp-row-btns">
                <button class="cp-mode-btn ${cp.complex ? "active" : ""}" data-mode="multi" title="Multi-Route"
                    ${readOnly ? 'disabled' : ''}>
                    ${icon("m")}
                </button>
                <button class="cp-mode-btn ${!cp.complex ? "active" : ""}" data-mode="lr" title="Links/Rechts"
                    ${readOnly ? 'disabled' : ''}>
                    ${icon("arrows-split", undefined, "scaleY(-1)")}
                </button>
            </div>
            ${readOnly ? '' : `<button class="cp-delete-btn" title="Posten löschen">${icon("trash", "11px")}</button>`}
        `;

        row.querySelector(".cp-grip")?.addEventListener("mousedown", e => {
            e.preventDefault();
            e.stopPropagation();
            startCPDrag(e, cp);
        });

        row.addEventListener("click", e => {
            if (e.target.closest(".cp-mode-btn") || e.target.closest(".cp-grip") || e.target.closest(".cp-delete-btn")) return;
            updateControlPairs(cp.order);
            updateRoutes();
            if (activeTool === NewRouteTool) NewRouteTool.switchCp(cp);
            else updateCPList();
            centerOnControlPair(cp.order);
            if (activeTool === RouteTool || activeTool === RouteEditTool || activeTool === NewRouteTool) {
                requestAnimationFrame(() => document.querySelector(".cp-route-list")
                    ?.scrollIntoView({ block: "center", behavior: "smooth" }));
            }
        });

        row.querySelector(".cp-delete-btn")?.addEventListener("click", e => {
            e.stopPropagation();
            pushUndoState("Posten gelöscht");
            deleteControlPair(cp);
            project.control_pairs = project.control_pairs.filter(c => c !== cp);
            project.control_pairs.forEach((c, i) => { c.order = i; });
            if (selection.ncp >= project.control_pairs.length) {
                selection.ncp = Math.max(0, project.control_pairs.length - 1);
            }
            drawCourse();
        });

        row.querySelectorAll(".cp-mode-btn").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                const complex = btn.dataset.mode === "multi";
                if (cp.complex === complex) return;
                if (!complex && cp.routes.length !== 2) {
                    const counter = row.querySelector(".cp-route-count");
                    if (counter) {
                        counter.classList.remove("cp-route-count-flash");
                        void counter.offsetWidth;
                        counter.classList.add("cp-route-count-flash");
                    }
                    return;
                }
                pushUndoState("Postentyp geändert");
                cp.complex = complex;
                saveControlPair(cp);
                updateCPList();
            });
        });

        list.appendChild(row);

        // Route sub-list: shown in route mode, view mode, AND control_pair mode
        // (so newly created control pairs reveal their auto-generated routes).
        const inRouteMode = activeTool === RouteTool || activeTool === RouteEditTool || activeTool === NewRouteTool
                         || activeTool === ViewTool
                         || activeTool === ControlPairTool || activeTool === PlaceControlTool;
        if (inRouteMode && cp.order === selection.ncp) {
            const routeList = document.createElement("div");
            routeList.className = "cp-route-list";

            const validTimes  = cp.routes.map(r => r.run_time).filter(t => t != null);
            const minRuntime  = validTimes.length ? Math.min(...validTimes) : null;

            cp.routes.forEach(route => {
                const rRow = document.createElement("div");
                rRow.className = "cp-route-row" + (route.order === selection.nr ? " selected" : "");

                const length  = route.length  != null ? route.length + "m" : "—";

                let runtimeHtml;
                if (route.run_time == null) {
                    runtimeHtml = `<span class="route-stat">—</span>`;
                } else if (route.run_time === minRuntime) {
                    runtimeHtml = `<span class="route-stat route-runtime-fastest">${route.run_time.toFixed(1)}s</span>`;
                } else {
                    const pct      = Math.round((route.run_time - minRuntime) / minRuntime * 100);
                    const tierCls  = pct < 5 ? "tier-warn" : pct < 10 ? "tier-alert" : "tier-danger";
                    runtimeHtml = `<span class="route-stat ${tierCls}">${route.run_time.toFixed(1)}s <span class="route-runtime-pct">+${pct}%</span></span>`;
                }

                rRow.innerHTML = `
                    <span class="route-name">Route ${route.order + 1}</span>
                    <span class="route-stats">
                        <span class="route-stat route-length">${length}</span>
                        ${runtimeHtml}
                    </span>
                    ${routeListDebugLink(cp.order)}
                    <label class="route-elevation-label">
                        <input class="route-elevation-input" type="number" min="0" step="1"
                            value="${route.elevation ?? ""}" placeholder="—"
                            ${readOnly ? 'disabled' : ''}>
                        <span>Hm</span>
                    </label>
                    ${readOnly ? '' : `<button class="cp-delete-btn" title="Route löschen">${icon("trash", "11px")}</button>`}
                `;

                rRow.querySelector(".cp-delete-btn")?.addEventListener("click", e => {
                    e.stopPropagation();
                    pushUndoState("Route gelöscht");
                    deleteRoute(cp, route);
                    cp.routes = cp.routes.filter(r => r !== route);
                    cp.routes.forEach((r, i) => { r.order = i; });
                    if (selection.nr >= cp.routes.length) selection.nr = null;
                    drawRoutes();
                    updateRoutes();
                    updateCPList();
                });

                rRow.addEventListener("click", e => {
                    if (e.target.closest(".route-elevation-input") || e.target.closest(".cp-delete-btn")) return;
                    e.stopPropagation();
                    selection.nr = route.order;
                    updateRoutes();
                    updateCPList();
                });

                const elevInput = rRow.querySelector(".route-elevation-input");

                elevInput.addEventListener("focus", e => { e.target.select(); });

                elevInput.addEventListener("change", e => {
                    e.stopPropagation();
                    const val = e.target.value.trim();
                    const parsed = Number(val);
                    route.elevation = (val === "" || isNaN(parsed)) ? 0 : parsed;
                    calcRouteRunTime(route);
                    pushUndoState("Höhe geändert");
                    saveRoute(cp, route);
                    updateCPList();
                });

                routeList.appendChild(rRow);
            });

            if (!readOnly) {
                const newRouteRow = document.createElement("div");
                const isDrawing   = activeTool === NewRouteTool;
                newRouteRow.className = "cp-route-row cp-route-row-new cp-route-row-split" + (isDrawing ? " drawing" : "");
                const partialLen  = isDrawing ? NewRouteTool.getPartialLength() : null;
                const canThetaPathfind = !!(cp.start && cp.ziel && project.map_file);
                const pathfindBusy = _isPathfindBusyForCp(cp);
                const expectAnotherRoute = pathfindBusy && _canExpectAnotherPathfindRoute(cp);
                const pathfindTitle = pathfindBusy
                    ? (expectAnotherRoute ? "Routensuche läuft - weitere Route möglich" : "Routensuche läuft - keine weitere Route erwartet")
                    : "+ automatische Route";
                const pathfindIcon = pathfindBusy
                    ? `<x-icon name="spinner" class="spin" size="1em"></x-icon>`
                    : icon("wand-magic-sparkles", "1em");
                newRouteRow.innerHTML = `
                    <button type="button" class="cp-new-route-draw-btn">
                        <span>Neue Route</span>
                        ${partialLen != null ? `<span class="route-stat route-length">${partialLen}m</span>` : ""}
                    </button>
                    ${canThetaPathfind ? `<button type="button" class="cp-new-route-pathfind-btn" title="${pathfindTitle}" aria-label="${pathfindTitle}" ${pathfindBusy ? 'disabled aria-busy="true"' : ""}>${pathfindIcon}</button>` : ""}
                `;
                newRouteRow.querySelector(".cp-new-route-draw-btn")?.addEventListener("click", e => {
                    e.stopPropagation();
                    if (activeTool === NewRouteTool) activateTool(RouteTool);
                    else startNewRoute();
                });
                const thetaBtn = newRouteRow.querySelector(".cp-new-route-pathfind-btn");
                if (thetaBtn) {
                    thetaBtn.addEventListener("click", e => {
                        e.stopPropagation();
                        if (thetaBtn.disabled) return;
                        if (activeTool === NewRouteTool) activateTool(RouteTool);
                        selection.ncp = cp.order;
                        thetaCPClient(cp, "editor_button");
                    });
                }
                routeList.appendChild(newRouteRow);
            }

            list.appendChild(routeList);
        }
    });

    if (activeTool === PlaceControlTool && PlaceControlTool.isPlacingZiel()) {
        const placeholder = document.createElement("div");
        placeholder.className = "cp-row cp-row-pending";
        placeholder.innerHTML = `<span class="cp-row-label">Neuer Posten…</span>`;
        list.appendChild(placeholder);
        requestAnimationFrame(() => placeholder.scrollIntoView({ block: "nearest" }));
    }

    if (currentToolMode !== ToolMode.NONE) {
        const addBtn = document.createElement("button");
        const isAddingControlPair = currentToolMode === ToolMode.CONTROL_PAIR
            && activeSubtool[ToolMode.CONTROL_PAIR] === "add";
        addBtn.className = "cp-add-btn" + (isAddingControlPair ? " adding" : "");
        addBtn.innerHTML = `${icon("plus", "0.8em")} Posten`;
        addBtn.addEventListener("click", startNewPlacement);
        list.appendChild(addBtn);
    }
}

/* =========================================================
    CP LIST DRAG-AND-DROP
========================================================= */

let cpDrag              = null;
let cpGhost  = null;
let cpSpacer = null;

function startCPDrag(e, cp) {
    const selectedCp  = project.control_pairs.find(c => c.order === selection.ncp);
    const list        = document.getElementById("cp-list");
    const draggedRow  = list.querySelector(`.cp-row[data-ncp="${cp.order}"]`);
    const rowH        = draggedRow.offsetHeight;
    const rowW        = draggedRow.offsetWidth;
    const rect        = draggedRow.getBoundingClientRect();
    const grabOffsetX = e.clientX - rect.left;
    const grabOffsetY = e.clientY - rect.top;

    // Ghost follows the mouse
    cpGhost = draggedRow.cloneNode(true);
    Object.assign(cpGhost.style, {
        position:      "fixed",
        width:         rowW + "px",
        pointerEvents: "none",
        opacity:       "0.9",
        zIndex:        "9999",
        boxShadow:     "0 4px 12px rgba(0,0,0,0.5)",
        borderRadius:  "5px",
        left:          e.clientX - grabOffsetX + "px",
        top:           e.clientY - grabOffsetY + "px",
    });
    document.body.appendChild(cpGhost);

    // Spacer reserves the drop slot — insert where the row is, then hide the row
    cpSpacer = document.createElement("div");
    cpSpacer.className = "cp-drag-spacer";
    cpSpacer.style.height = rowH + "px";
    list.insertBefore(cpSpacer, draggedRow);
    draggedRow.style.display = "none";
    list.classList.add("cp-dragging");
    document.body.classList.add("cp-drag-active");

    const initialIndex  = project.control_pairs.indexOf(cp);
    const fromOrder     = cp.order;
    cpDrag = { cp, selectedCp, insertIndex: initialIndex, draggedRow, grabOffsetX, grabOffsetY, fromOrder };
    document.addEventListener("mousemove", onCPDragMove);
    document.addEventListener("mouseup",   onCPDragEnd);
}

function onCPDragMove(e) {
    if (!cpDrag) return;

    cpGhost.style.left = e.clientX - cpDrag.grabOffsetX + "px";
    cpGhost.style.top  = e.clientY - cpDrag.grabOffsetY + "px";

    const list = document.getElementById("cp-list");
    const rows = [...list.querySelectorAll(".cp-row")].filter(r => r.style.display !== "none");

    let insertIndex = rows.length;
    for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { insertIndex = i; break; }
    }

    if (cpDrag.insertIndex === insertIndex) return;
    cpDrag.insertIndex = insertIndex;

    if (cpSpacer.parentNode) cpSpacer.remove();
    if (insertIndex < rows.length) {
        list.insertBefore(cpSpacer, rows[insertIndex]);
    } else {
        list.appendChild(cpSpacer);
    }
}

function onCPDragEnd() {
    if (!cpDrag) return;
    document.removeEventListener("mousemove", onCPDragMove);
    document.removeEventListener("mouseup",   onCPDragEnd);

    if (cpGhost)  { cpGhost.remove();  cpGhost  = null; }
    if (cpSpacer) { cpSpacer.remove(); cpSpacer = null; }
    cpDrag.draggedRow.style.display = "";
    document.getElementById("cp-list").classList.remove("cp-dragging");
    document.body.classList.remove("cp-drag-active");

    const { cp, selectedCp, insertIndex, fromOrder } = cpDrag;
    cpDrag = null;

    if (insertIndex === null) return;

    const arr       = project.control_pairs;
    const fromIndex = arr.indexOf(cp);
    if (fromIndex === -1) return;

    arr.splice(fromIndex, 1);
    arr.splice(insertIndex, 0, cp);
    arr.forEach((c, i) => { c.order = i; });

    if (fromIndex !== insertIndex) pushUndoState("Postenreihenfolge geändert");

    // Bulk-reorder atomically (sequential saves would clash on the unique constraint)
    const orderPairs = arr.filter(c => c.id).map(c => ({ db_id: c.id, order: c.order }));
    if (orderPairs.length && project.id) {
        _pendingSaves++;
        _saveQueue = _saveQueue.then(async () => {
            const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
            try {
                await fetch("/editor/save-cp-order/", {
                    method:  "POST",
                    headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
                    body:    JSON.stringify({ file_id: project.id, order: orderPairs }),
                });
            } catch (e) { console.warn("save-cp-order failed:", e); }
            finally    { _pendingSaves = Math.max(0, _pendingSaves - 1); }
        });
    }

    if (selectedCp) selection.ncp = selectedCp.order;

    drawCourse();
    updateCPList();
}


function clearCourseLayers() {
    document.getElementById("control-layer").innerHTML = "";
    document.getElementById("route-layer").innerHTML   = "";
}

function clearAllLayers() {
    ["control-layer","route-layer","edit-layer","blocked-layer","line-layer","ui-layer"]
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = "";
        });
    hideCrosshair();
}

function updateControlPairGroup(controlPair) {
    const layer    = document.getElementById("control-layer");
    const oldGroup = layer.querySelector(`.control-pair-group[data-ncp="${controlPair.order}"]`);
    if (!oldGroup) return;
    oldGroup.remove();
    drawControlPairGroup(controlPair);
}

function centerOnControlPair(order) {
    if (!editorSettings.auto_jump) return;
    const cp = project.control_pairs.find(cp => cp.order === order);
    if (!cp?.start || !cp?.ziel) return;

    const rect     = document.getElementById("map-container").getBoundingClientRect();
    const minX     = Math.min(cp.start.x, cp.ziel.x);
    const maxX     = Math.max(cp.start.x, cp.ziel.x);
    const minY     = Math.min(cp.start.y, cp.ziel.y);
    const maxY     = Math.max(cp.start.y, cp.ziel.y);
    const dist     = Math.hypot(cp.ziel.x - cp.start.x, cp.ziel.y - cp.start.y);
    const padding  = dist * 0.5;
    const zoomX    = rect.width  / (maxX - minX + padding * 2);
    const zoomY    = rect.height / (maxY - minY + padding * 2);
    const newZoom  = Math.min(Math.max(Math.min(zoomX, zoomY), zoomMin), zoomMax);
    const midX     = (minX + maxX) / 2;
    const midY     = (minY + maxY) / 2;

    animateCamera({
        x:    rect.width  / 2 - midX * newZoom,
        y:    rect.height / 2 - midY * newZoom,
        zoom: newZoom,
    }, 500);
}

function animateCamera(target, duration = 500) {
    const start     = { x: camera.x, y: camera.y, zoom: camera.zoom };
    const startTime = performance.now();

    function step(now) {
        const t = Math.min((now - startTime) / duration, 1);
        const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        updateCameraTransform({
            x:    start.x    + (target.x    - start.x)    * k,
            y:    start.y    + (target.y    - start.y)    * k,
            zoom: start.zoom + (target.zoom - start.zoom) * k,
        });
        if (t < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
}

/* =========================================================
    CROSSHAIR
========================================================= */

function updateCrosshair(x, y) {
    const el = document.getElementById("drag-crosshair");
    if (!el) return;
    el.setAttribute("transform", `translate(${x}, ${y})`);
    el.style.display = "block";
}

function hideCrosshair() {
    const el = document.getElementById("drag-crosshair");
    if (el) el.style.display = "none";
}

/* =========================================================
    ROUTE RUNTIME
========================================================= */

function calcRouteLength(route) {
    const pts = route.rP;
    if (!pts || pts.length < 2) { route.length = 0; return; }
    let total = 0;
    const metresPerPx = routeMetresPerEditorPx();
    for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        total += Math.sqrt(dx * dx + dy * dy) * metresPerPx;
    }
    route.length = Math.round(total);
}

function calcRouteSide(cp, route) {
    const rP = route.rP;
    if (!rP?.length || !cp.start || !cp.ziel) { route.pos = null; return; }
    const dx = cp.ziel.x - cp.start.x;
    const dy = cp.ziel.y - cp.start.y;
    let sum = 0;
    for (const p of rP) {
        sum += dx * (p.y - cp.start.y) - dy * (p.x - cp.start.x);
    }
    route.pos = sum / rP.length;
}

// ── NoA constants — kept in sync with project/runtime.py ───────────────────
// Window length is coupled to the map's scale so the algorithm produces
// comparable corner counts across maps at different zoom levels.
const NOA_CLUSTER_WINDOW_M       = 20;
const NOA_COUNTER_TURN_WINDOW_M  = 10;
const NOA_ARTIFACT_WINDOW_M      = 5;
const NOA_MIN_SEGMENT_M          = 1.5;
const NOA_CORNER_DEG             = 90;
const NOA_EPSILON_DEG            = 2;
const NOA_MIN_EFFECT_DEG         = 45;
const NOA_COUNTER_MIN_DEG        = 45;

function noaMetresToRouteUnits(metres) {
    return metres / routeMetresPerEditorPx();
}

function normalizeTurnRad(angle) {
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    return angle;
}

function roundNoA(value) {
    return Math.round(value * 10) / 10;
}

function simplifiedNoAPoints(points) {
    const minStep = noaMetresToRouteUnits(NOA_MIN_SEGMENT_M);
    const out = [];

    for (const p of points || []) {
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        const current = { x: p.x, y: p.y };
        const prev = out[out.length - 1];
        if (!prev || Math.hypot(current.x - prev.x, current.y - prev.y) >= minStep) {
            out.push(current);
        }
    }

    const last = points?.[points.length - 1];
    if (out.length && last && Number.isFinite(last.x) && Number.isFinite(last.y)) {
        out[out.length - 1] = { x: last.x, y: last.y };
    }
    return out;
}

/* Count corners along route.rP using a windowed cumulative-turn rule:
 *  • A single junction turn ≥ NOA_CORNER_DEG counts as one corner immediately,
 *    even if another sharp turn is right next to it (no skip-ahead).
 *  • Smaller turns accumulate into a sliding window of `noaDistanceWindow(scale)`
 *    pixels. When the sum reaches the corner threshold, one corner is counted
 *    and the window is cleared.
 *  • Turns more than `window` pixels behind drop off, so isolated small bends
 *    along long straight stretches never sum to a corner.
 */
function calcRouteNoA_oldWindowed(route) {
    const rP = route.rP;
    if (!rP || rP.length < 3) { route.noA = 0; return; }

    const scale       = (typeof project !== 'undefined') ? project.scale : null;
    const window      = noaDistanceWindow(scale);
    const minLeg      = noaMinLeg(scale);
    const minSpan     = noaMinSpan(scale);
    const cornerRad   = NOA_CORNER_DEG  * Math.PI / 180;
    const epsRad      = NOA_EPSILON_DEG * Math.PI / 180;

    // Cumulative pixel-distance + per-segment heading + per-segment length.
    const cum      = [0];
    const headings = [];
    const segLen   = [];
    for (let i = 1; i < rP.length; i++) {
        const dx = rP[i].x - rP[i - 1].x;
        const dy = rP[i].y - rP[i - 1].y;
        const len = Math.hypot(dx, dy);
        cum.push(cum[i - 1] + len);
        segLen.push(len);
        headings.push((dx === 0 && dy === 0) ? null : Math.atan2(dy, dx));
    }

    // Collect non-trivial turns with their local-leg lengths.
    const turns = [];
    for (let i = 1; i < headings.length; i++) {
        const h1 = headings[i - 1], h2 = headings[i];
        if (h1 === null || h2 === null) continue;
        let t = Math.abs(h2 - h1);
        if (t > Math.PI) t = 2 * Math.PI - t;
        if (t < epsRad) continue;
        // cum[i] is the cumulative distance to the start of segment i — i.e.
        // the junction point between segment i-1 and segment i.
        turns.push({ pos: cum[i], t, legBefore: segLen[i - 1], legAfter: segLen[i] });
    }

    let noA = 0;
    let win = [];   // active sliding window: [{ pos, t }]

    for (const { pos, t, legBefore, legAfter } of turns) {
        while (win.length && pos - win[0].pos > window) win.shift();

        // A "sharp" turn only counts on its own when BOTH adjacent legs are
        // long enough to be visible in the editor — pixel-level zigzag
        // artefacts have legs of 1-2 px and end up folded into the window.
        if (t >= cornerRad && Math.min(legBefore, legAfter) >= minLeg) {
            noA++;
            win = [];
            continue;
        }

        win.push({ pos, t });
        let sum = 0;
        for (const w of win) sum += w.t;
        const span = win.length > 0 ? pos - win[0].pos : 0;
        // Cumulative corner only fires once the accumulating turns also span
        // a visible stretch of polyline — prevents 3-4 sharp 1-px zigzag
        // jitters from being read as a sweeping turn.
        if (sum >= cornerRad && span >= minSpan) {
            noA++;
            win = [];
        }
    }

    route.noA = noA;
}

function calcRouteNoA(route) {
    const rP = simplifiedNoAPoints(route.rP);
    if (!rP || rP.length < 3) { route.noA = 0; return; }

    const epsRad = NOA_EPSILON_DEG * Math.PI / 180;

    const cum      = [0];
    const headings = [];
    const segLen   = [];
    const metresPerPx = routeMetresPerEditorPx();
    for (let i = 1; i < rP.length; i++) {
        const dx = rP[i].x - rP[i - 1].x;
        const dy = rP[i].y - rP[i - 1].y;
        const len = Math.hypot(dx, dy) * metresPerPx;
        cum.push(cum[i - 1] + len);
        segLen.push(len);
        headings.push((dx === 0 && dy === 0) ? null : Math.atan2(dy, dx));
    }

    const turns = [];
    for (let i = 1; i < headings.length; i++) {
        const h1 = headings[i - 1], h2 = headings[i];
        if (h1 === null || h2 === null) continue;
        const signed = normalizeTurnRad(h2 - h1);
        const abs = Math.abs(signed);
        if (abs < epsRad) continue;
        if (Math.min(segLen[i - 1], segLen[i]) < NOA_MIN_SEGMENT_M) continue;
        turns.push({ pos: cum[i], signedDeg: signed * 180 / Math.PI, absDeg: abs * 180 / Math.PI });
    }

    let noA = 0;
    for (let i = 0; i < turns.length;) {
        const cluster = [turns[i++]];
        while (i < turns.length && turns[i].pos - cluster[0].pos <= NOA_CLUSTER_WINDOW_M) {
            cluster.push(turns[i++]);
        }

        const span = cluster[cluster.length - 1].pos - cluster[0].pos;
        const totalAbs = cluster.reduce((sum, turn) => sum + turn.absDeg, 0);
        const net = Math.abs(cluster.reduce((sum, turn) => sum + turn.signedDeg, 0));
        const maxTurn = Math.max(...cluster.map(turn => turn.absDeg));
        if (span <= NOA_ARTIFACT_WINDOW_M && net < NOA_MIN_EFFECT_DEG && totalAbs >= NOA_CORNER_DEG) continue;

        const directionDeg = Math.max(maxTurn, net);
        if (directionDeg >= NOA_MIN_EFFECT_DEG || totalAbs >= NOA_CORNER_DEG) {
            noA += directionDeg / NOA_CORNER_DEG;
        }

        let counterDeg = 0;
        for (let j = 0; j < cluster.length; j++) {
            let localAbs = 0;
            let localNet = 0;
            for (let k = j; k < cluster.length; k++) {
                if (cluster[k].pos - cluster[j].pos > NOA_COUNTER_TURN_WINDOW_M) break;
                localAbs += cluster[k].absDeg;
                localNet += cluster[k].signedDeg;
            }
            counterDeg = Math.max(counterDeg, localAbs - Math.abs(localNet));
        }
        if (counterDeg >= NOA_COUNTER_MIN_DEG) {
            noA += counterDeg / (2 * NOA_CORNER_DEG);
        }
    }

    route.noA = roundNoA(noA);
}

function calcRouteRunTime(route) {
    const length    = route.length;
    const elevation = route.elevation;
    if (length == null || length === 0) {
        route.run_time = null;
        return;
    }
    const noAPenalty = route.noA || 0;
    // elevation = 0 is the calibration point: no grade penalty, pure flat speed.
    // Also avoids the formula artefact where gapUp/gapDown ≈ 0.994 at grade 0
    // would make flat terrain slightly faster than RUN_SPEED.
    if (!elevation) {
        route.run_time = length / RUN_SPEED + noAPenalty;
        return;
    }
    const gradient  = (elevation / length) * 100;
    const gapUp     = 0.0017 * gradient ** 2 + 0.02901 * gradient + 0.99387;
    const gapDown   = 0.0017 * gradient ** 2 - 0.02901 * gradient + 0.99387;
    const adjSpeed  = RUN_SPEED / ((gapUp + gapDown) / 2);
    route.run_time  = length / adjSpeed + noAPenalty;
}

function recalculateProjectRoutes(targetProject = project) {
    for (const cp of targetProject?.control_pairs || []) {
        for (const route of cp.routes || []) {
            calcRouteLength(route);
            calcRouteNoA(route);
            calcRouteRunTime(route);
            calcRouteSide(cp, route);
        }
    }
}
window.recalculateProjectRoutes = recalculateProjectRoutes;

/* =========================================================
    SNAP
========================================================= */

function findSnapTarget(draggedControlPair, draggedPointType, x, y) {
    let bestTarget = null;
    let bestDist   = SNAP_DISTANCE_CONTROL_PAIR;

    project.control_pairs.forEach(cp => {
        ["start", "ziel"].forEach(type => {
            const pt = cp[type];
            if (!pt) return;
            if (cp === draggedControlPair && type === draggedPointType) return;
            const dist = Math.hypot(pt.x - x, pt.y - y);
            if (dist < bestDist) { bestDist = dist; bestTarget = { x: pt.x, y: pt.y }; }
        });
    });

    return bestTarget;
}

/* =========================================================
    MAP SPINNER
========================================================= */

function showMapSpinner() {
    const layer   = document.getElementById("ui-layer");
    layer.innerHTML = "";

    const spinner = document.createElementNS("http://www.w3.org/2000/svg", "g");
    spinner.id    = "map-spinner";

    const radii  = [64, 84, 104];
    const speeds = [1, 0.65, 0.38];
    const colors = ["#444", "#666", "#999"];
    const arcs   = [];

    const rect = document.getElementById("map-container").getBoundingClientRect();
    const cx   = (rect.width  / 2 - camera.x) / camera.zoom;
    const cy   = (rect.height / 2 - camera.y) / camera.zoom;

    radii.forEach((r, i) => {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", 0); circle.setAttribute("cy", 0); circle.setAttribute("r", r);
        circle.setAttribute("fill", "none");
        circle.setAttribute("stroke", colors[i]);
        circle.setAttribute("stroke-width", "5");
        circle.setAttribute("stroke-linecap", "round");
        circle.setAttribute("vector-effect", "non-scaling-stroke");
        const circ = 2 * Math.PI * r;
        circle.setAttribute("stroke-dasharray", `${circ * 0.35} ${circ * 0.65}`);
        arcs.push({ el: circle, speed: speeds[i], offset: i * 0.8 });
        spinner.appendChild(circle);
    });

    spinner.setAttribute("transform", `translate(${cx}, ${cy})`);
    layer.appendChild(spinner);

    let start = null;
    function animate(ts) {
        if (!start) start = ts;
        const elapsed = (ts - start) / 1000;
        arcs.forEach(arc => {
            arc.el.setAttribute("transform",
                `rotate(${(elapsed * arc.speed * 360 + arc.offset * 60) % 360})`
            );
        });
        if (document.getElementById("map-spinner")) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}

function hideMapSpinner() {
    document.getElementById("ui-layer").innerHTML = "";
}

/* =========================================================
    TOOLBAR
========================================================= */

const TOOL_ORDER = [
    ToolMode.CONTROL_PAIR,
    ToolMode.ROUTE,
    ToolMode.MASK,
    ToolMode.BLOCK,
    ToolMode.NONE,
];

let currentToolMode = ToolMode.CONTROL_PAIR;
let currentRotation = 0;

const TOOL_CONFIG = {
    "control_pair": { tx: 42, ty: 0 },
    "route":        { tx: 37, ty: 0 },
    "mask":         { tx: 40, ty: 0 },
    "block":        { tx: 40, ty: 0 },
    "no_tool":      { tx: 40, ty: 0 },
};

const wheel        = document.getElementById("toolbar-wheel");
const subtoolPanel = document.getElementById("subtool-panel");

/* =========================================================
    SUBTOOL STATE
========================================================= */

const SUBTOOL_DEFS = {
    [ToolMode.CONTROL_PAIR]: [
        { id: "add",  icon: "circle-xmark-r", title: "Add control pair", transform: "rotate(45deg)" },
        { id: "drag", icon: "drag-fist",      title: "Drag controls" },
    ],
    [ToolMode.ROUTE]: [
        { id: "new",    icon: "plus",   title: "New route" },
        { id: "select", icon: "pencil", title: "Select route" },
    ],
    [ToolMode.MASK]: [
        { id: "pan",   icon: "lock",      title: "Pan" },
        { id: "draw",  icon: "pencil",       title: "Draw" },
        { id: "erase", icon: "eraser",       title: "Erase" },
    ],
    [ToolMode.BLOCK]: [
        { id: "line",    icon: "slash",        title: "Line" },
        { id: "polygon", icon: "draw-polygon", title: "Polygon" },
        { id: "erase",   icon: "eraser",       title: "Erase" },
    ],
};

const activeSubtool = {
    [ToolMode.CONTROL_PAIR]: "add",
    [ToolMode.ROUTE]:        "new",
    [ToolMode.MASK]:         "pan",
    [ToolMode.BLOCK]:        "line",
};

function getSubtool(mode) {
    return activeSubtool[mode] ?? null;
}

function setSubtool(mode, id) {
    activeSubtool[mode] = id;
    updateSubtoolPanel(mode);
    if (mode === ToolMode.MASK && activeTool === MaskTool) {
        const editing = id === "draw" || id === "erase";
        mapContainer.style.cursor = editing ? "default" : "grab";
        mapContainer.classList.toggle("mask-editing", editing);
        if (!editing) document.getElementById("mask-brush-cursor").style.display = "none";
    }
}

function updateSubtoolPanel(mode) {
    subtoolPanel.innerHTML = "";
    if (readOnly) return;           // no subtools in locked/published files
    const defs = SUBTOOL_DEFS[mode];
    if (!defs) return;

    let current;
    if (mode === ToolMode.CONTROL_PAIR) {
        current = activeTool === PlaceControlTool ? activeSubtool[mode] : "drag";
    } else if (mode === ToolMode.ROUTE) {
        current = (activeTool === RouteTool || activeTool === RouteEditTool) ? "select" : "new";
    } else {
        current = activeSubtool[mode];
    }

    defs.forEach(def => {
        const btn = document.createElement("button");
        btn.className = "subtool-btn" + (def.id === current ? " active" : "");
        btn.title = def.title;
        btn.innerHTML = icon(def.icon, "18px", def.transform);

        if (mode === ToolMode.CONTROL_PAIR) {
            btn.addEventListener("click", () => {
                if (def.id === "add") {
                    activeSubtool[mode] = "add";
                    startNewPlacement();
                } else {
                    activeSubtool[mode] = "drag";
                    activateTool(ControlPairTool);
                    updateSubtoolPanel(mode);
                }
            });
        } else if (mode === ToolMode.ROUTE) {
            btn.addEventListener("click", () => {
                if (def.id === "new") {
                    startNewRoute();
                } else {
                    activateTool(RouteTool);
                    updateSubtoolPanel(mode);
                }
            });
        } else {
            btn.addEventListener("click", () => setSubtool(mode, def.id));
        }

        subtoolPanel.appendChild(btn);
    });
}

buildToolbar();
setTool(currentToolMode);

subtoolPanel.addEventListener("wheel", e => {
    const s = getSubtool(ToolMode.MASK);
    if (currentToolMode !== ToolMode.MASK || (s !== "draw" && s !== "erase")) return;
    e.preventDefault();
    e.stopPropagation();
    MaskLayer.adjustBrush(e.deltaY > 0 ? 1 : -1);
    const sizeSlider = document.getElementById("mask-size-slider");
    if (sizeSlider) sizeSlider.value = MaskLayer.getBrush();
    const brushEl = document.getElementById("mask-brush-cursor");
    if (brushEl && brushEl.style.display === "block") {
        const r = MaskLayer.brushScreenRadius();
        brushEl.style.width  = r * 2 + "px";
        brushEl.style.height = r * 2 + "px";
    }
}, { passive: false });

function setTool(mode) {
    if (readOnly && mode !== ToolMode.NONE) return;
    const prevMode  = currentToolMode;
    currentToolMode = mode;
    // Auto-activate the default "add" subtool when switching INTO these modes
    // (prevMode guard prevents recursion since start* calls setTool again)
    if (mode === ToolMode.ROUTE && prevMode !== ToolMode.ROUTE && activeSubtool[ToolMode.ROUTE] === "new") {
        startNewRoute();
        return;
    }
    if (mode === ToolMode.CONTROL_PAIR && prevMode !== ToolMode.CONTROL_PAIR && activeSubtool[ToolMode.CONTROL_PAIR] === "add") {
        startNewPlacement();
        return;
    }
    activateTool(TOOLS[mode] ?? ViewTool);

    document.querySelectorAll(".tool-segment").forEach(seg => {
        const active = seg.dataset.tool === mode;
        seg.classList.toggle("active", active);
        const bg = seg.querySelector(".segment-bg");
        if (bg) bg.style.fill = active ? "#e07020" : "";
        if (active) seg.parentNode.appendChild(seg);
    });

    const index        = TOOL_ORDER.indexOf(mode);
    const segmentAngle = 360 / TOOL_ORDER.length;
    let targetRotation = (-1 - index) * segmentAngle;
    let delta          = targetRotation - currentRotation;
    delta              = ((delta + 180) % 360 + 360) % 360 - 180;
    currentRotation   += delta;
    wheel.style.transform = `rotate(${currentRotation}deg)`;

    updateLabels();
    updateSubtoolPanel(mode);
    updateCPList();
    updateRoutes();
}

document.querySelectorAll(".tool-segment").forEach(seg => {
    seg.addEventListener("click", () => setTool(seg.dataset.tool));
});

function buildToolbar() {
    const outerR       = 60;
    const innerR       = 20;
    const segmentAngle = 360 / TOOL_ORDER.length;

    document.querySelectorAll(".tool-segment").forEach(seg => {
        const index = Number(seg.dataset.index);
        const bgPath = createDonutSegment(0, 0, innerR, outerR, -segmentAngle / 2, segmentAngle / 2);
        seg.querySelector(".segment-bg").setAttribute("d", bgPath);
        seg.setAttribute("transform", `rotate(${index * segmentAngle})`);
        seg.querySelector(".label-wrap").setAttribute("transform", `rotate(${-index * segmentAngle})`);

        const toolName = seg.dataset.tool === ToolMode.NONE ? "lock" : seg.dataset.tool;
        const iconDef  = ICONS[toolName];
        const iconPath = seg.querySelector(".tool-icon");
        if (iconDef && iconPath) {
            const [,, W, H] = iconDef.viewBox.split(" ").map(Number);
            const scale = 25 / Math.max(W, H);
            iconPath.setAttribute("d", iconDef.d);
            iconPath.setAttribute("transform", `scale(${scale}) translate(${-W / 2} ${-H / 2})`);
            iconPath.setAttribute("fill-rule", iconDef.fillRule || "nonzero");
        }
    });
}

function updateLabels() {
    document.querySelectorAll(".tool-segment").forEach(seg => {
        const index        = Number(seg.dataset.index);
        const segmentAngle = 360 / TOOL_ORDER.length;
        const angle        = -(index * segmentAngle) - currentRotation;
        const cfg          = TOOL_CONFIG[seg.dataset.tool];
        if (!cfg) return;
        seg.querySelector(".label-wrap").setAttribute(
            "transform",
            `translate(${cfg.tx} ${cfg.ty}) rotate(${angle})`
        );
    });
}

function polarToCartesian(cx, cy, r, deg) {
    const rad = deg * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function createDonutSegment(cx, cy, innerR, outerR, startDeg, endDeg) {
    const p1       = polarToCartesian(cx, cy, outerR, startDeg);
    const p2       = polarToCartesian(cx, cy, outerR, endDeg);
    const p3       = polarToCartesian(cx, cy, innerR, endDeg);
    const p4       = polarToCartesian(cx, cy, innerR, startDeg);
    const largeArc = endDeg - startDeg <= 180 ? 0 : 1;
    return [
        `M ${p1.x} ${p1.y}`,
        `A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
        `L ${p3.x} ${p3.y}`,
        `A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x} ${p4.y}`,
        "Z",
    ].join(" ");
}
