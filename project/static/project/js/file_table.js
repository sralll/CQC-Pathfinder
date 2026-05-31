import { FileRow } from './file_row.js';

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
        const res = await fetch(`/editor/publish/${row.file.id}/`, {
            method: 'POST',
            headers: { 'X-CSRFToken': getCSRFToken() }
        });
        const data = await res.json();
        row.updatePublishState(data.published);
    }

    deleteFile(id) {
        console.log("delete", id);
    }

    _applyProject(data) {
        closeFileModal();
        clearAllLayers();
        MaskLayer.clearMask();
        maskGenInProgress = false;
        hideMaskGenBar();
        project = data.project;
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
            undoStack = []; redoStack = []; actionCount = 0;
            pushUndoState();
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