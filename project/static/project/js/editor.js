/* =========================================================
    PROJECT STATE
========================================================= */

let project = {
    id: null,
    name: 'Neues Projekt',
    published: false,
    label: null,
    scale: null,
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

let editorSettings = { auto_pathfind: false, auto_jump: true };

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
    const disabledIds = ["nav-save-project"];
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

    // Sync project.name on every keystroke
    input.addEventListener("input", () => {
        if (project.id) project.name = input.value;
    });

    // Confirm rename on Enter
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    });

    // Save on blur — validate uniqueness first
    input.addEventListener("blur", () => {
        if (!project.id) return;
        const newName = input.value.trim();
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
    input.value    = project.id ? (project.name || "") : "";
    input.disabled = !project.id || readOnly;
}
window.updateFilenameInput = updateFilenameInput;

/* ---- Navbar publish button ---- */
function updateNavPublishBtn() {
    const btn = document.getElementById("nav-publish-btn");
    if (!btn) return;
    btn.disabled = !project.id;
    btn.classList.toggle("publish-btn-active", !!(project.id && project.published));
}
window.updateNavPublishBtn = updateNavPublishBtn;

async function toggleNavPublish() {
    if (!project.id) return;
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

function _applySettingsUI() {
    const apEl = document.getElementById('toggle-auto-pathfind');
    const ajEl = document.getElementById('toggle-auto-jump');
    if (apEl) apEl.checked = editorSettings.auto_pathfind;
    if (ajEl) ajEl.checked = editorSettings.auto_jump;
}

async function toggleEditorSetting(setting) {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
    try {
        const res  = await fetch('/editor/settings/toggle/', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
            body:    JSON.stringify({ setting }),
        });
        const data = await res.json();
        if (data.auto_pathfind !== undefined) editorSettings.auto_pathfind = data.auto_pathfind;
        if (data.auto_jump     !== undefined) editorSettings.auto_jump     = data.auto_jump;
    } catch (e) { console.warn('Failed to toggle setting', e); }
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

function pushUndoState(label = "Aktion") {
    undoStack.push(captureState(label));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack = [];
    actionCount++;
    if (actionCount % SNAPSHOT_EVERY === 0) saveSnapshot("autosave");
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

    // ── Settings toggles ──────────────────────────────────
    loadEditorSettings();
    document.getElementById('toggle-auto-pathfind')?.addEventListener('change', () => {
        toggleEditorSetting('auto_pathfind');
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
});

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
    if (_pendingSaves > 0) {
        e.preventDefault();
        e.returnValue = "Autosave noch nicht abgeschlossen. Bitte auf der Seite bleiben.";
    }
});

function _projectBody() {
    const cps = project.control_pairs;
    return {
        id:              project.id,
        name:            project.name,
        scale:           project.scale,
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
                    cpMap.routes.forEach(rMap => {
                        const r = cp.routes.find(r => r.order === rMap.order);
                        if (r) r.id = rMap.id;
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
    console.log("[online] event fired, _saveFailed:", _saveFailed);
    if (_saveFailed) {
        saveFile("reconnect");
    }
});

window.saveSnapshot = saveSnapshot;
function saveSnapshot(trigger = "autosave") {
    if (readOnly) return;
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

function _saveElement(payloadOrFn) {
    if (readOnly || !project.id) return Promise.resolve(null);
    _pendingSaves++;
    _saveQueue = _saveQueue.then(async () => {
        // Resolve payload lazily so callers can reference cp.id / route.id
        // that may have been written by an earlier queued save
        const payload = typeof payloadOrFn === 'function' ? payloadOrFn() : payloadOrFn;
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
        try {
            const res  = await fetch("/editor/save-element/", {
                method:  "POST",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
                body:    JSON.stringify({ file_id: project.id, ...payload }),
            });
            const d = await res.json();
            if (d?.last_edited) project.last_edited = d.last_edited;
            _clearSaveFailedWarning();
            return d;
        } catch (e) { console.warn("saveElement failed:", e); _showSaveFailedWarning(); return null; }
        finally    { _pendingSaves = Math.max(0, _pendingSaves - 1); }
    });
    return _saveQueue;
}

function saveControlPair(cp) {
    // Pass a function so cp.id is read at execution time (after any prior saves set it)
    _saveQueue = _saveElement(() => ({
        type: 'control_pair',
        control_pair: { db_id: cp.id ?? null, order: cp.order,
                        start: cp.start, ziel: cp.ziel, complex: cp.complex },
    })).then(data => { if (data?.db_id) cp.id = data.db_id; });
}

function saveRoute(cp, route) {
    // Lazy: cp.id may be set by a preceding saveControlPair in the queue
    _saveQueue = _saveElement(() => ({
        type: 'route', cp_db_id: cp.id ?? null,
        route: { db_id: route.id ?? null, order: route.order,
                 rP: route.rP, noA: route.noA, pos: route.pos,
                 length: route.length, run_time: route.run_time, elevation: route.elevation },
    })).then(data => { if (data?.db_id) route.id = data.db_id; });
}

function saveBlockedTerrain() {
    return _saveElement(() => ({ type: 'blocked_terrain', blocked_terrain: project.blocked_terrain }));
}

function _deleteElement(payloadOrFn) {
    if (readOnly || !project.id) return;
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

const zoomMin = 0.2;
const zoomMax = 8;
const SNAP_DISTANCE_CONTROL_PAIR = 15;
const SNAP_DISTANCE_ROUTE_EDIT   = 5;
const R_CONTROL = 25;
const GAP = 8;
const RUN_SPEED = 4.75;         // average running speed in m/s
const PX_TO_M  = 0.48;         // pixels to metres conversion factor

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
        updateControlPairGroup(drag.controlPair);
        updateCrosshair(newX, newY);

        const moved   = Math.hypot(newX - drag.originX, newY - drag.originY);
        const willDel = moved > SNAP_DISTANCE_CONTROL_PAIR;
        const ncp     = drag.controlPair.order;
        mapContainer.querySelectorAll(`.route-polyline[data-ncp="${ncp}"], .route-bg[data-ncp="${ncp}"]`)
            .forEach(el => el.setAttribute("opacity", willDel ? "0.2" : "1"));
    }

    function stopDrag() {
        if (!drag) return;
        const cp        = drag.controlPair;
        const pointType = drag.pointType;
        const point     = cp[pointType];
        const moved     = Math.hypot(point.x - drag.originX, point.y - drag.originY);
        drag = null;
        mapContainer.classList.remove("dragging");
        mapContainer.style.cursor = "default";
        hideCrosshair();
        if (moved > SNAP_DISTANCE_CONTROL_PAIR) {
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

    function drawPreview() {
        clearEditLayer();
        if (!route || !previewPt) return;
        const prev = route.rP[route.rP.length - 1];
        if (!prev) return;
        const layer = document.getElementById("edit-layer");
        const line  = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", prev.x);      line.setAttribute("y1", prev.y);
        line.setAttribute("x2", previewPt.x); line.setAttribute("y2", previewPt.y);
        line.setAttribute("stroke", "#E53935");
        line.setAttribute("stroke-width", "1");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("vector-effect", "non-scaling-stroke");
        layer.appendChild(line);
    }

    function drawOriginal() {
        if (!originalPts || originalPts.length < 2) return;
        const layer  = document.getElementById("route-layer");
        const points = originalPts.map(p => `${p.x},${p.y}`).join(" ");
        const poly   = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        poly.setAttribute("points", points);
        poly.setAttribute("fill", "none");
        poly.setAttribute("stroke", "rgba(229, 57, 53, 0.67)");
        poly.setAttribute("stroke-width", "1.5");
        poly.setAttribute("stroke-linecap", "round");
        poly.setAttribute("stroke-linejoin", "round");
        poly.setAttribute("vector-effect", "non-scaling-stroke");
        layer.appendChild(poly);
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
            drawOriginal();
            updateRoutes();
        },

        onExit() {
            mapContainer.classList.remove("editing-route");
            clearEditLayer();
            hideCrosshair();
            if (route) {
                calcRouteLength(route); calcRouteRunTime(route); calcRouteSide(cpRef, route);
                if (cpRef) saveRoute(cpRef, route);
            }
            reset();
            drawRoutes();
            updateRoutes();
            updateCPList();
        },

        onMouseDown(e, pt) {
            const snapped = snapToZiel(pt);
            if (tryReconnect(snapped.x, snapped.y)) return;
            route.rP.push({ x: snapped.x, y: snapped.y });
            calcRouteLength(route);
            drawRoutes();
            drawOriginal();
            updateRoutes();
            updateCPList();
        },

        onMouseMove(e, pt) {
            previewPt = snapToZiel(pt);
            updateCrosshair(previewPt.x, previewPt.y);
            drawPreview();
        },

        onMouseUp(e, pt) {},

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

    function drawPreview() {
        clearEditLayer();
        if (!route?.rP?.length) return;
        const layer = document.getElementById("edit-layer");

        // Partial polyline so far (white bg + red fg)
        if (route.rP.length >= 2) {
            const pts = route.rP.map(p => `${p.x},${p.y}`).join(" ");
            for (const [stroke, width] of [["white", "3"], ["#E53935", "1.5"]]) {
                const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
                poly.setAttribute("points", pts);
                poly.setAttribute("fill", "none");
                poly.setAttribute("stroke", stroke);
                poly.setAttribute("stroke-width", width);
                poly.setAttribute("stroke-linecap", "round");
                poly.setAttribute("stroke-linejoin", "round");
                poly.setAttribute("vector-effect", "non-scaling-stroke");
                layer.appendChild(poly);
            }
        }

        // Preview line to cursor
        if (previewPt) {
            const prev = route.rP[route.rP.length - 1];
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", prev.x); line.setAttribute("y1", prev.y);
            line.setAttribute("x2", previewPt.x); line.setAttribute("y2", previewPt.y);
            line.setAttribute("stroke", "#E53935");
            line.setAttribute("stroke-width", "1");
            line.setAttribute("stroke-linecap", "round");
            line.setAttribute("vector-effect", "non-scaling-stroke");
            layer.appendChild(line);
        }
    }

    function completeRoute() {
        pushUndoState("Route erstellt");
        calcRouteLength(route);
        route.elevation = 0;
        calcRouteRunTime(route);
        calcRouteSide(cp, route);
        cp.routes.push(route);
        saveRoute(cp, route);
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
                if (Math.hypot(snappedStart.x - cp.start.x, snappedStart.y - cp.start.y) > 0.5) return;
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
            drawPreview();
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

    let canvas        = null;
    let ctx           = null;
    let maskData      = null;
    let loaded        = false;
    let lastMapFile   = null;
    let lastPx        = null;
    let _strokeBefore = null;  // R-channel snapshot before current stroke (for diff)

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
        _strokeBefore = null;
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
        };
        img.onerror = () => { loaded = false; };
        img.src = `/pathfinding/get_mask/mask_${stem}.png`;
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

    // Edit maskData pixels in a circle, then re-render display
    function editCircle(cx, cy, maskValue) {
        if (!maskData) return;
        const W  = maskData.width, H = maskData.height;
        const x0 = Math.max(0,   Math.floor(cx - brushR));
        const x1 = Math.min(W-1, Math.ceil (cx + brushR));
        const y0 = Math.max(0,   Math.floor(cy - brushR));
        const y1 = Math.min(H-1, Math.ceil (cy + brushR));
        const r2 = brushR * brushR;
        const d  = maskData.data;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if ((x-cx)*(x-cx) + (y-cy)*(y-cy) <= r2) {
                    const i = (y * W + x) * 4;
                    d[i] = d[i+1] = d[i+2] = maskValue;
                    d[i+3] = 255;
                }
            }
        }
        // Re-render only the affected region
        const patch = ctx.createImageData(x1-x0+1, y1-y0+1);
        const pd = patch.data;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const si = (y * W + x) * 4;
                const pi = ((y-y0)*(x1-x0+1) + (x-x0)) * 4;
                if (d[si] < 10) {
                    pd[pi] = 220; pd[pi+1] = 0; pd[pi+2] = 0; pd[pi+3] = 255;
                } else {
                    pd[pi+3] = 0;
                }
            }
        }
        ctx.putImageData(patch, x0, y0);
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

    return {
        clearMask() {
            ensureCanvas();
            if (ctx && canvas.width && canvas.height)
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            maskData      = null;
            loaded        = false;
            lastMapFile   = null;
            _strokeBefore = null;
        },
        loadMask,
        applyMapDimensions,
        screenToMaskPx,
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
        draw(clientX, clientY)  { strokeLine(clientX, clientY, 0);   },
        erase(clientX, clientY) { strokeLine(clientX, clientY, 241); },

        // ── Diff-based undo support ────────────────────────────
        startStroke() {
            if (!maskData) return;
            // Snapshot just the R channel (G=B=R, A=255 always)
            const src = maskData.data, len = src.length / 4;
            _strokeBefore = new Uint8Array(len);
            for (let i = 0, j = 0; i < src.length; i += 4, j++) _strokeBefore[j] = src[i];
        },
        finishStroke() {
            if (!_strokeBefore || !maskData) { _strokeBefore = null; return null; }
            const src = maskData.data;
            const idxBuf = [], oldBuf = [], newBuf = [];
            for (let i = 0, j = 0; i < src.length; i += 4, j++) {
                const o = _strokeBefore[j], n = src[i];
                if (o !== n) { idxBuf.push(j); oldBuf.push(o); newBuf.push(n); }
            }
            _strokeBefore = null;
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
            // Write maskData to an offscreen canvas and save as PNG
            const off  = document.createElement("canvas");
            off.width  = maskData.width;
            off.height = maskData.height;
            off.getContext("2d").putImageData(maskData, 0, 0);
            const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
            off.toBlob(blob => {
                const form = new FormData();
                form.append("filename", mapFile);
                const stem = mapFile.replace(/\.[^.]+$/, "");
                form.append("file", blob, `mask_${stem}.png`);
                fetch("/editor/save-mask/", {
                    method:  "POST",
                    headers: { "X-CSRFToken": csrf },
                    body:    form,
                });
            }, "image/png");
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
    MaskLayer.saveMask(project.map_file);
}

function redoMask() {
    if (!maskRedoStack.length) return;
    const diff = maskRedoStack.pop();
    maskUndoStack.push(diff);
    MaskLayer.applyDiff(diff, false);  // forward: restore new values
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
            hideMaskGenBar();
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

const BLOCK_COLOR  = "rgb(160,51,240)";
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
        makeRow("Fläche", area.points, () => bt.areas.splice(idx, 1));
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

    function drawPreview() {
        clearEditLayer();
        if (!previewPt) return;
        const layer = document.getElementById("edit-layer");
        const S = sub();

        if (S === "line" && lineStart) {
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", lineStart.x);  line.setAttribute("y1", lineStart.y);
            line.setAttribute("x2", previewPt.x);  line.setAttribute("y2", previewPt.y);
            line.setAttribute("stroke", BLOCK_COLOR);
            line.setAttribute("stroke-width", "5");
            line.setAttribute("stroke-linecap", "butt");
            line.setAttribute("vector-effect", "non-scaling-stroke");
            layer.appendChild(line);
        }

        if (S === "polygon" && polyPoints.length > 0) {
            const allPts = [...polyPoints, previewPt];
            const pts    = allPts.map(p => `${p.x},${p.y}`).join(" ");

            if (polyPoints.length >= 2) {
                const fill = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
                fill.setAttribute("points", pts);
                fill.setAttribute("fill", "url(#block-hatch)");
                fill.setAttribute("fill-opacity", "1");
                fill.setAttribute("stroke", BLOCK_COLOR);
                fill.setAttribute("stroke-width", "1");
                fill.setAttribute("stroke-linejoin", "miter");
                fill.setAttribute("vector-effect", "non-scaling-stroke");
                layer.appendChild(fill);
            } else {
                const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                line.setAttribute("x1", polyPoints[0].x); line.setAttribute("y1", polyPoints[0].y);
                line.setAttribute("x2", previewPt.x);     line.setAttribute("y2", previewPt.y);
                line.setAttribute("stroke", BLOCK_COLOR);
                line.setAttribute("stroke-width", "1");
                line.setAttribute("vector-effect", "non-scaling-stroke");
                layer.appendChild(line);
            }

            // Circle around start point — indicates where to click to close
            const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            c.setAttribute("cx", polyPoints[0].x);
            c.setAttribute("cy", polyPoints[0].y);
            c.setAttribute("r",  BLOCK_SNAP);
            c.setAttribute("fill", "none");
            c.setAttribute("stroke", BLOCK_COLOR);
            c.setAttribute("stroke-width", "1");
            c.setAttribute("stroke-dasharray", "3 2");
            c.setAttribute("vector-effect", "non-scaling-stroke");
            layer.appendChild(c);
        }
    }

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
                mapContainer.style.cursor = hit ? "pointer" : "default";
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
                    drawPreview();
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

    const STROKE = "rgb(160, 51, 240)";
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

    function drawPreview(pt) {
        clearEditLayer();
        const layer = document.getElementById("edit-layer");

        // Cursor circle
        drawCircleAt(layer, pt);

        // Placed start circle + connection line (ziel phase)
        if (placing === "ziel" && tempStart) {
            drawCircleAt(layer, tempStart);

            const dx   = pt.x - tempStart.x;
            const dy   = pt.y - tempStart.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 2 * (R_CONTROL + GAP)) {
                const angle  = Math.atan2(dy, dx);
                const offset = R_CONTROL + GAP;
                const line = svgEl("line");
                line.setAttribute("x1", tempStart.x + Math.cos(angle) * offset);
                line.setAttribute("y1", tempStart.y + Math.sin(angle) * offset);
                line.setAttribute("x2", pt.x - Math.cos(angle) * offset);
                line.setAttribute("y2", pt.y - Math.sin(angle) * offset);
                line.setAttribute("stroke", STROKE);
                line.setAttribute("stroke-width", SW);
                line.setAttribute("vector-effect", "non-scaling-stroke");
                layer.appendChild(line);
            }
        }
    }

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
                const snapped = snapToControlPoints(pt);
                tempStart = { x: snapped.x, y: snapped.y };
                placing   = "ziel";
                updateCPList();
            } else {
                const snapped = snapToControlPoints(pt);
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
                reset();
                const isLast = !project.control_pairs.some(c => c.order > confirmedOrder);
                if (isLast) {
                    startNewPlacement();
                } else {
                    setTool(ToolMode.CONTROL_PAIR);
                }
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
            mapContainer.querySelectorAll(".control-pair-group.selected")
                .forEach(el => el.classList.remove("selected"));
            selection.ncp = -1;
            updateCPList();
        },

        onExit() {
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
                hideCrosshair();
                clearEditLayer();
                if (placing === "ziel" && tempStart) {
                    drawCircleAt(document.getElementById("edit-layer"), tempStart);
                }
                return;
            }
            const snapped = snapToControlPoints(pt);
            updateCrosshair(snapped.x, snapped.y);
            drawPreview(snapped);
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

    const rad    = d => d * Math.PI / 180;
    // Segments start at -135° → midpoints at -90(N), 0(E), 90(S), 180(W)
    const segA1  = i => -135 + i * SECTOR;
    const segMid = i => segA1(i) + SECTOR / 2;

    // Colors matching the sidebar tool wheel
    const COL_DARK   = "#252525";
    const COL_ORANGE = "#ff9800";
    const COL_HOVER  = "#ffbb44"; // slightly brighter on hover-of-hover

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
        cg.appendChild(centeredFO("no_tool"));
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
        outerG.innerHTML = "";
        if (!mode || mode === ToolMode.NONE) return;
        const defs = SUBTOOL_DEFS[mode];
        if (!defs?.length) return;
        const base = segA1(MENU_TOOLS.indexOf(mode));
        const sub  = SECTOR / defs.length;
        defs.forEach((def, si) => {
            const a1 = base + si*sub;
            outerG.appendChild(makeSegment(OR1, OR2, a1, a1+sub, a1+sub/2,
                def.icon, def.transform, "sub", def.id, COL_DARK));
        });
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
        overlayEl.addEventListener("mouseup",     e => { if (e.button===2) RCM.onUp(e); });
        overlayEl.addEventListener("contextmenu", e => e.preventDefault());

        document.body.appendChild(overlayEl);
        document.body.appendChild(menuEl);

        // Run an initial hover update so centre is already orange if cursor is there
        updateHover(x, y);
    }

    function closeMenu() {
        open = false;
        overlayEl?.remove(); overlayEl = null;
        menuEl?.remove();    menuEl    = null;
    }

    return {
        onDown(e) {
            if (readOnly) return;   // no tool-picker in locked/published files
            downAt = Date.now(); downPos = {x:e.clientX, y:e.clientY};
            hoveredTool = null; hoveredSub = null; open = false;
        },
        onMove(e) {
            if (!downPos) return;
            if (!open) {
                const moved = Math.hypot(e.clientX-downPos.x, e.clientY-downPos.y);
                if (moved > MOVE_PX || Date.now()-downAt > CLICK_MS) openMenu(downPos.x, downPos.y);
            }
            if (open) updateHover(e.clientX, e.clientY);
        },
        onUp(e) {
            // Guard against double-fire: overlay + window both emit mouseup
            if (!open && !downPos) return;
            const wasOpen = open, _tool = hoveredTool, _sub = hoveredSub;
            downPos = null;
            closeMenu();
            hoveredTool = null; hoveredSub = null;
            applySelection(wasOpen ? _tool : null, wasOpen ? _sub : null);
        },
        cancel() { downPos = null; closeMenu(); },
    };
})();

function initInput() {
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);
    window.addEventListener("keydown",   onKeyDown);
    window.addEventListener("wheel",     onWheel, { passive: false });
    window.addEventListener("contextmenu", e => e.preventDefault());
}

let _scaleDownPos    = null;   // screen pos at mousedown
let _scalePanStarted = false;  // true once pan.start() has been called in this gesture
const SCALE_PAN_THRESHOLD = 5;

function onMouseDown(e) {
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
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("control-pair-group");
    if (controlPair.order === selection.ncp) group.classList.add("selected");
    group.dataset.ncp = controlPair.order;
    drawControlPair(controlPair, group);
    drawConnection(controlPair, group);
    layer.appendChild(group);
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
        circle.setAttribute("stroke", "rgb(160, 51, 240)");
        circle.setAttribute("stroke-width", "3");
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
    setLineAttrs(line, "rgb(160, 51, 240)", "3");
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
        line.setAttribute("stroke", "rgb(160, 51, 240)");
        line.setAttribute("stroke-width", "3");
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

function clickControlPairGroup(target) {
    if (!target?.closest) return false;
    const group = target.closest(".control-pair-group");
    if (!group) return false;
    const ncp     = Number(group.dataset.ncp);
    const changed = ncp !== selection.ncp;
    updateControlPairs(ncp);
    updateRoutes();
    if (changed) centerOnControlPair(ncp);
    return true;
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

function createRoutePolyline(route, {
    stroke = "rgb(160, 51, 240)",
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

function drawRoutes() {
    const layer = document.getElementById("route-layer");
    layer.innerHTML = "";
    if (!project?.control_pairs) return;

    project.control_pairs.forEach(cp => {
        cp.routes.forEach(route => {
            const el = createRoutePolyline(route, {
                stroke: "white", strokeWidth: 3,
                className: "route-bg",
                dataset: { ncp: cp.order, nr: route.order },
            });
            if (el) layer.appendChild(el);
        });
    });

    project.control_pairs.forEach(cp => {
        cp.routes.forEach(route => {
            const el = createRoutePolyline(route, {
                stroke: "black", strokeWidth: 1.5,
                className: "route-polyline",
                dataset: { ncp: cp.order, nr: route.order },
            });
            if (el) layer.appendChild(el);
        });
    });
}

function updateRoutes() {
    mapContainer.querySelectorAll(".route-bg").forEach(el => {
        const isSelectedCp = Number(el.dataset.ncp) === selection.ncp;
        el.setAttribute("stroke", isSelectedCp ? "white" : "transparent");
    });

    mapContainer.querySelectorAll(".route-polyline").forEach(el => {
        const isSelectedCp = Number(el.dataset.ncp) === selection.ncp;
        el.setAttribute("opacity", isSelectedCp ? "1" : "0.1");
        el.setAttribute("stroke", "black");
    });

    // active route rendered on top
    const routeLayer = document.getElementById("route-layer");
    routeLayer.querySelectorAll(".route-active").forEach(el => el.remove());

    const cp    = project.control_pairs.find(cp => cp.order === selection.ncp);
    const route = cp?.routes.find(r => r.order === selection.nr);

    if (route) {
        const bg = createRoutePolyline(route, {
            stroke: "white", strokeWidth: 3,
            className: "route-active",
        });
        const fg = createRoutePolyline(route, {
            stroke: "#E53935", strokeWidth: 1.5,
            className: "route-active",
            dataset: { ncp: cp.order, nr: route.order },
        });
        if (bg) routeLayer.appendChild(bg);
        if (fg) routeLayer.appendChild(fg);
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

function screenToWorld(clientX, clientY) {
    const rect = document.getElementById("map-container").getBoundingClientRect();
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

function startMaskGeneration(mapFile, scale) {
    const bar    = document.getElementById("mask-gen-bar");
    const text   = document.getElementById("mask-gen-text");
    const cancel = document.getElementById("mask-gen-cancel");
    if (!bar) return;

    const prog = document.getElementById("mask-gen-progress");
    maskGenInProgress = true;
    if (currentToolMode === ToolMode.MASK) bar.style.display = "flex";
    text.textContent  = "Maske wird generiert…";
    if (prog) prog.value = 0;

    maskGenController = new AbortController();
    cancel.onclick = () => { bar.style.display = "none"; }; // hide only, fetch continues

    const csrfToken = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";

    fetch("/editor/generate-mask/", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
        body:    JSON.stringify({ filename: mapFile, scale }),
        signal:  maskGenController.signal,
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
                            if (d.current !== undefined) {
                                const pct = Math.round((d.current / d.total) * 100);
                                text.textContent = `Generiere Maske… ${pct}%`;
                                if (prog) prog.value = pct;
                            } else if (d.done) {
                                maskGenInProgress = false;
                                if (project.map_file === mapFile) {
                                    project.has_mask = true;
                                    // Lightweight endpoint — works even for published/locked files
                                    if (project.id) {
                                        const _csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
                                        fetch("/editor/mark-has-mask/", {
                                            method:  "POST",
                                            headers: { "Content-Type": "application/json", "X-CSRFToken": _csrf },
                                            body:    JSON.stringify({ file_id: project.id }),
                                        }).catch(e => console.warn("mark_has_mask failed:", e));
                                    }
                                    if (prog) prog.value = 100;
                                    text.textContent = "Maske fertig — wird geladen…";
                                    MaskLayer.loadMask(mapFile);
                                    MaskLayer.applyMapDimensions();
                                    setTimeout(hideMaskGenBar, 2000);
                                } else {
                                    hideMaskGenBar();
                                }
                            } else if (d.error) {
                                text.innerHTML = `<span style="color:#ff6666">Fehler: ${d.error}</span>`;
                            }
                        } catch (_) {}
                    }
                    return read();
                });
            }
            return read();
        })
        .catch(err => {
            if (err.name !== "AbortError")
                text.innerHTML = `<span style="color:#ff6666">Fehler: ${err.message}</span>`;
        });
}

function hideMaskGenBar() {
    const bar = document.getElementById("mask-gen-bar");
    if (bar) bar.style.display = "none";
}

function showMaskGenBarIfActive() {
    if (!maskGenInProgress) return;
    const bar = document.getElementById("mask-gen-bar");
    if (bar) bar.style.display = "flex";
}

function loadMap(filename) {
    document.getElementById('map-img').src = `/editor/map/${filename}`;
}

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

async function uploadSelectedMap() {
    const input = document.getElementById("map-file-input");
    const file  = input?.files?.[0];
    if (!file) return;

    const btn  = document.getElementById("upload-map-btn");
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";

    btn.disabled = true;   // keep the upload icon — spinner shown on the map itself

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
            alert(data.error || "Upload fehlgeschlagen.");
            btn.disabled = false;
            return;
        }

        // Clear leftover state from previously open files now that we're committing
        setReadOnly(false);
        checkinCurrentFile();
        updateFilenameInput();
        // New map replaces any previous editor state — wipe all undo history
        undoStack = []; redoStack = []; actionCount = 0;
        clearMaskUndoStacks();
        updateUndoMenu();

        // Update project state and save so the file exists on the server
        project.map_file = data.map_file;
        project.scaled   = false;
        project.scale    = null;
        saveFile("map_upload");

        // Close modal and load map in editor
        closeMapModal();
        _loadMapInEditor();

    } catch (e) {
        console.error("uploadSelectedMap:", e);
        alert("Upload fehlgeschlagen.");
        btn.disabled = false;
    }
}

function _loadMapInEditor() {
    const img = document.getElementById("map-img");
    if (!img || !project.map_file) return;

    // Clear all leftover SVG elements and the previous map image
    clearAllLayers();
    MaskLayer.clearMask?.();
    img.style.display = "none";
    img.src = "";

    showMapSpinner();

    img.onload = () => {
        hideMapSpinner();
        img.style.display = "block";
        applyProjectScale();
        MaskLayer.applyMapDimensions?.();
        drawCourse();
        fitMapToCamera();
        _updateScalePanel();
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

    if (project.map_file && !project.scaled) {
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
            _setScaleStatus("Klicke zweiten Punkt…  (Ctrl+Z: zurück)");
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

    const distInp  = document.getElementById("scale-distance-m");
    const ratioInp = document.getElementById("scale-ratio-input");
    const submitBtn = document.getElementById("scale-submit-btn");

    distInp.value  = "";
    ratioInp.value = "4000";
    submitBtn.disabled = true;

    const check = () => { submitBtn.disabled = !(parseFloat(distInp.value) > 0); };
    distInp.oninput  = check;
    ratioInp.oninput = check;

    const onEnter = e => { if (e.key === "Enter" && !submitBtn.disabled) submitBtn.click(); };
    distInp.onkeydown  = onEnter;
    ratioInp.onkeydown = onEnter;

    setTimeout(() => distInp.focus(), 50);

    submitBtn.onclick = () => {
        const meters   = parseFloat(distInp.value);
        const mapScale = parseFloat(ratioInp.value) || 4000;
        if (!(meters > 0) || !(_scalePixelDist > 0)) return;

        // Same formula as old coursesetter: inputValue * 4000 / mapScale / dist / 0.48
        project.scale    = meters * 4000 / mapScale / _scalePixelDist / 0.48;
        project.mapScale = mapScale;
        project.scaled   = true;

        modal.style.display = "none";
        _clearRuler();
        _cancelScaleDrawing();
        applyProjectScale();
        fitMapToCamera();
        saveFile("scale");
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
        startMaskGeneration(project.map_file, project.scale);
    };
}

// ── Mouse interception for ruler drawing ───────────────────

function _scaleHandleUp(e) {
    const pt = screenToWorld(e.clientX, e.clientY);

    if (!_scaleP1) {
        // First point
        _scaleP1 = pt;
        _drawRuler(pt, pt);
        _setScaleStatus("Klicke zweiten Punkt…  (Ctrl+Z: zurück)");
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
    closeFileModal();
    openMapModal();
}

function openMapModal() {
    document.getElementById("modal-map").classList.add("open");
    // Reset any leftover selection from a previous upload
    document.getElementById("selected-map-info").style.display = "none";
    document.querySelector(".selected-map-name").textContent = "";
    const uploadBtn = document.getElementById("upload-map-btn");
    if (uploadBtn) uploadBtn.disabled = true;
    const fileInput = document.getElementById("map-file-input");
    if (fileInput) fileInput.value = "";
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

function handleMapFile(file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { alert("Datei zu gross (max. 15 MB)"); return; }
    document.getElementById("selected-map-info").style.display = "flex";
    document.querySelector(".selected-map-name").textContent = file.name;
    document.getElementById("upload-map-btn").disabled = false;
}

/* =========================================================
    NAV MENUS
========================================================= */

function initMenus() {
    const menuItems = document.querySelectorAll(".nav-menu-item");
    menuItems.forEach(menu => {
        menu.addEventListener("mouseenter", () => {
            menuItems.forEach(other => { if (other !== menu) other.classList.remove("open"); });
            menu.classList.add("open");
        });
        menu.addEventListener("mouseleave", () => menu.classList.remove("open"));
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
    const rect  = mapContainer.getBoundingClientRect();
    const mapW  = img.naturalWidth  * (project.scale || 1);
    const mapH  = img.naturalHeight * (project.scale || 1);
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
    updateCPList();
    console.log("redrawn");
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
        row.className = "cp-row" + (cp.order === selection.ncp ? " selected" : "");
        row.dataset.ncp = cp.order;

        row.innerHTML = `
            ${readOnly ? '' : `<span class="cp-grip" title="Drag to reorder"></span>`}
            <span class="cp-row-label">
                <span class="cp-posten-text">Posten ${cp.order + 1}</span>
                <span class="cp-route-count">${cp.routes.length} Routen</span>
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
                if (!complex && cp.routes.length > 2) {
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

        // Route sub-list: shown in route mode AND in no_tool/view mode
        const inRouteMode = activeTool === RouteTool || activeTool === RouteEditTool || activeTool === NewRouteTool
                         || activeTool === ViewTool;
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
                    runtimeHtml = `<span class="route-stat ${tierCls}">${route.run_time.toFixed(1)}' <span class="route-runtime-pct">+${pct}%</span></span>`;
                }

                rRow.innerHTML = `
                    <span class="route-name">Route ${route.order + 1}</span>
                    <span class="route-stats">
                        <span class="route-stat route-length">${length}</span>
                        ${runtimeHtml}
                    </span>
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
                newRouteRow.className = "cp-route-row cp-route-row-new" + (isDrawing ? " drawing" : "");
                const partialLen  = isDrawing ? NewRouteTool.getPartialLength() : null;
                newRouteRow.innerHTML = `
                    <span class="route-name">Neue Route</span>
                    ${partialLen != null ? `<span class="route-stats"><span class="route-stat route-length">${partialLen}m</span></span>` : ""}
                `;
                newRouteRow.addEventListener("click", e => {
                    e.stopPropagation();
                    if (activeTool === NewRouteTool) activateTool(RouteTool);
                    else startNewRoute();
                });
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
        addBtn.className = "cp-add-btn";
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
    for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        total += Math.sqrt(dx * dx + dy * dy) * PX_TO_M;
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

function calcRouteRunTime(route) {
    const length    = route.length;
    const elevation = route.elevation;
    if (length == null || length === 0 || elevation == null) {
        route.run_time = null;
        return;
    }
    const gradient  = (elevation / length) * 100;
    const gapUp     = 0.0017 * gradient ** 2 + 0.02901 * gradient + 0.99387;
    const gapDown   = 0.0017 * gradient ** 2 - 0.02901 * gradient + 0.99387;
    const adjSpeed  = RUN_SPEED / ((gapUp + gapDown) / 2);
    route.run_time  = length / adjSpeed;
}

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

    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x",      -radii[2] - 12);
    bg.setAttribute("y",      -radii[2] - 12);
    bg.setAttribute("width",   2 * radii[2] + 24);
    bg.setAttribute("height",  2 * radii[2] + 24);
    bg.setAttribute("rx",      radii[2] + 10);
    bg.setAttribute("fill",   "#2a2a2a");
    spinner.appendChild(bg);

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
        { id: "drag", icon: "no_tool",        title: "Drag controls" },
    ],
    [ToolMode.ROUTE]: [
        { id: "new",    icon: "plus",   title: "New route" },
        { id: "select", icon: "pencil", title: "Select route" },
    ],
    [ToolMode.MASK]: [
        { id: "pan",   icon: "no_tool",      title: "Pan" },
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
        if (bg) bg.style.fill = active ? "#ff9800" : "";
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

        const toolName = seg.dataset.tool;
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
