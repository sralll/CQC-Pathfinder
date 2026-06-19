import { FileRow } from './file_row.js';

/**
 * Custom modal replacing browser alert() / confirm().
 * Returns a Promise<boolean> — true = confirmed, false = cancelled.
 * Options:
 *   message     {string}  — body text
 *   confirmText {string}  — label for the confirm button (default "OK")
 *   cancelText  {string}  — label for the cancel button; omit for alert-style (no cancel)
 *   danger      {boolean} — style the confirm button red (for destructive actions)
 */
function showModal({ message, confirmText = 'OK', cancelText = null, danger = false }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'dialog-overlay';

        overlay.innerHTML = `
            <div class="dialog-box">
                <p class="dialog-message">${message}</p>
                <div class="dialog-buttons">
                    ${cancelText ? `<button class="dialog-btn dialog-btn-cancel">${cancelText}</button>` : ''}
                    <button class="dialog-btn dialog-btn-confirm${danger ? ' dialog-btn-danger' : ''}">${confirmText}</button>
                </div>
            </div>
        `;

        const close = result => { overlay.remove(); resolve(result); };

        overlay.querySelector('.dialog-btn-confirm').addEventListener('click', () => close(true));
        overlay.querySelector('.dialog-btn-cancel')?.addEventListener('click', () => close(false));
        overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });

        document.body.appendChild(overlay);
        overlay.querySelector('.dialog-btn-confirm').focus();
    });
}
window.showModal = showModal;

export class FileTable {
    constructor(tbody) {
        this.tbody = tbody;
        this.files = [];
        this.rows = [];
    }

    setFiles(files) {
        this.files = files;
        this.rows = files.map(file => new FileRow(file, this));
        this.render();
    }

    render() {
        this.tbody.innerHTML = '';
        this.rows.forEach(row => this.tbody.appendChild(row.element));
    }

    sortBy(key, dir = 1) {
        this.rows.sort((a, b) => {
            let va = a.file[key];
            let vb = b.file[key];
            if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
        this.render();
    }

    async togglePublish(row) {
        const res  = await fetch(`/editor/publish/${row.file.id}/`, {
            method: 'POST',
            headers: { 'X-CSRFToken': getCSRFToken() }
        });
        const data = await res.json();
        if (!res.ok) {
            await showModal({ message: data.message || 'Fehler beim Veröffentlichen.' });
            return;
        }
        row.updatePublishState(data.published);

        // Mirror the published state onto the currently open editor session
        if (row.file.id === project?.id) {
            if (data.published) {
                window.setReadOnly?.(true, null, 'published');  // lock it
            } else {
                window.setReadOnly?.(false);                     // restore editing
            }
        }
    }

    async deleteFile(id) {
        if (!await showModal({ message: gettext('Delete project — are you sure?'), confirmText: gettext('Delete'), cancelText: gettext('Cancel'), danger: true })) return;
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
        window.showTableLoading?.();
        try {
            const res = await fetch(`/editor/delete/${id}/`, {
                method: 'POST',
                headers: { 'X-CSRFToken': csrf },
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                window.hideTableLoading?.();
                await showModal({ message: d.error || 'Löschen fehlgeschlagen.' });
                return;
            }
            await window.refreshFileTable?.();
        } catch (e) {
            console.error('deleteFile failed:', e);
            await showModal({ message: 'Löschen fehlgeschlagen.' });
        } finally {
            window.hideTableLoading?.();
        }
    }

    _applyProject(data) {
        // Reset any in-progress tool state (e.g. half-placed control pair) before
        // replacing the project — must happen before project is overwritten.
        window.setTool?.("no_tool");
        // Release lock on the previously open file before switching
        if (typeof window.checkinCurrentFile === 'function') {
            window.checkinCurrentFile();
        }
        closeFileModal();
        clearAllLayers();
        MaskLayer.clearMask();
        window.clearMaskUndoStacks?.();
        window.detachMaskGenerationUi?.();
        project = data.project;
        project.map_scale = Number.isFinite(Number(project.map_scale)) && Number(project.map_scale) > 0
            ? Number(project.map_scale)
            : 4000;
        window.markProjectPersistenceIds?.(project);
        const repairedOrders = window.normalizeProjectOrders?.(project) || false;
        window.setReadOnly?.(data.project.read_only, data.project.locked_by_name, data.project.read_only_reason);
        if (repairedOrders && !data.project.read_only) saveFile("repair_order");
        window.updateFilenameInput?.();
        window.updateNavPublishBtn?.();
        window.updateNavLabel?.();
        applyProjectScale();
        updateCameraTransform({ x: 0, y: 0, zoom: 0.67 });

        if (project.has_mask) {
            MaskLayer.loadMask(project.map_file);
        } else if (project.map_file && project.scale) {
            startMaskGeneration(project.map_file, project.scale);
        }

        showMapSpinner();

        const img = document.getElementById('map-img');
        img.style.display = 'none';
        img.onload = () => {
            hideMapSpinner();
            img.style.display = 'block';
            MaskLayer.applyMapDimensions();
            drawCourse();
            updateRoutes();   // ensure routes are visible after DOM is populated
            fitMapToCamera();
            undoStack = []; redoStack = []; actionCount = 0;
            pushUndoState();
            window._updateScalePanel?.();
        };
        img.onerror = () => { hideMapSpinner(); };
        img.src = `/editor/map/${project.map_file}`;
    }

    async openFile(id) {
        const res = await fetch(`/editor/open/${id}/`);
        const data = await res.json();
        if (data.error) { console.error('Error loading file:', data.error); return; }
        this._applyProject(data);
    }

    async loadSnapshot(snapshotId) {
        const res  = await fetch(`/editor/snapshots/${snapshotId}/load/`);
        const data = await res.json();
        if (data.error) { console.error('Error loading snapshot:', data.error); return; }
        this._applyProject(data);
    }
}
