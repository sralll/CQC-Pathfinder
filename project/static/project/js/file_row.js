const icon = (...args) => window.icon(...args);

export class FileRow {
    constructor(file, table, showTeamColumn) {
        this.file = file;
        this.table = table;
        this.showTeamColumn = showTeamColumn;
        this.element = this.createRow();
    }

    createRow() {
        const tr = document.createElement('tr');
        if (!this.file.can_edit) tr.classList.add('foreign-file-row');

        tr.innerHTML = `
            <td>
                <button id="publish-btn-${this.file.id}"
                    class="publish-btn ${this.file.published ? 'publish-btn-active' : ''} ${!this.file.can_edit || this.file.is_locked ? 'publish-btn-disabled' : ''}"
                    ${!this.file.can_edit || this.file.is_locked ? 'disabled' : ''}
                    ${this.file.is_locked ? `title="${gettext('File is currently being edited')}"` : ''}>
                    ${icon("globe")}
                </button>
            </td>
            <td class="col-infinity">
                <button id="infinity-btn-${this.file.id}"
                    class="publish-btn infinity-toggle-btn ${this.file.infinite_enabled ? 'publish-btn-active' : ''} ${!this.file.can_edit || this.file.is_locked || !this.file.has_mask ? 'publish-btn-disabled' : ''}"
                    ${!this.file.can_edit || this.file.is_locked || !this.file.has_mask ? 'disabled' : ''}
                    title="${this._infinityTitle()}">
                    ${icon("infinity")}
                </button>
            </td>
            <td class="file-name-cell">${this.file.name}</td>
            <td class="label-cell">${this.file.label ? `
                <div class="label-chip-wrap">
                    <span class="table-label-chip" style="background:${this.file.label.color}22;color:${this.file.label.color};border-color:${this.file.label.color}55;">${this.file.label.name}</span>
                    ${this.file.can_edit ? `<button class="label-remove-btn" title="${gettext('Remove label')}">×</button>` : ''}
                </div>` : ''}
            </td>
            <td style="text-align:left;">${this.file.cp_count}</td>
            <td>
                ${this.file.author || ''}
                ${this.file.is_locked ? `<span class="file-lock-warning" title="${this.file.locked_by_name} ${gettext('is editing')}">${icon("lock", "1em")}</span>` : ''}
            </td>
            <td class="col-team">${this.file.team_name || ''}</td>
            <td style="text-align:center;">
                <button class="action-btn version-btn" data-file-id="${this.file.id}">
                    ${icon("angles-down")}
                </button>
            </td>
            <td>${this.formatDate(this.file.last_edited)}</td>
            <td>
                ${this.file.can_edit ? `
                    <div class="file-action-group">
                        <button class="action-btn danger-btn delete-btn" ${this.file.is_locked ? `disabled title="${gettext('File is currently being edited')}"` : ''}>
                            ${icon("trash")}
                        </button>
                    </div>` : ''}
            </td>
        `;

        this.attachEvents(tr);
        return tr;
    }

    attachEvents(tr) {
        const publishBtn = tr.querySelector(`#publish-btn-${this.file.id}`);
        if (publishBtn && this.file.can_edit && !this.file.is_locked) {
            publishBtn.addEventListener('click', () => this.table.togglePublish(this));
        }

        const infinityBtn = tr.querySelector(`#infinity-btn-${this.file.id}`);
        if (infinityBtn && this.file.can_edit && !this.file.is_locked && this.file.has_mask) {
            infinityBtn.addEventListener('click', () => this.table.toggleInfinite(this));
        }

        const deleteBtn = tr.querySelector('.delete-btn');
        if (deleteBtn && !this.file.is_locked) {
            deleteBtn.addEventListener('click', () => this.table.deleteFile(this.file.id));
        }

        const nameCell = tr.querySelector('.file-name-cell');
        if (nameCell) {
            nameCell.addEventListener('click', () => this.table.openFile(this.file.id));
        }

        const versionBtn = tr.querySelector('.version-btn');
        if (versionBtn) {
            versionBtn.addEventListener('click', () => this.toggleHistory(tr));
        }

        // ── Label remove button ──────────────────────────────
        const labelRemoveBtn = tr.querySelector('.label-remove-btn');
        if (labelRemoveBtn) {
            labelRemoveBtn.addEventListener('click', e => {
                e.stopPropagation();
                window.removeLabelFromFile?.(this.file.id);
            });
        }

        // ── Label drop target (only editable files without a label) ──
        const labelCell = tr.querySelector('.label-cell');
        if (labelCell && this.file.can_edit && !this.file.label) {
            labelCell.addEventListener('dragover', e => {
                if (!window._draggedLabel) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                labelCell.classList.add("label-drop-zone");
            });
            labelCell.addEventListener('dragleave', () => {
                labelCell.classList.remove("label-drop-zone");
            });
            labelCell.addEventListener('drop', e => {
                e.preventDefault();
                labelCell.classList.remove("label-drop-zone");
                const label = window._draggedLabel;
                if (!label || typeof label.id === 'string') return; // ignore temp labels
                window.assignLabelToFile?.(this.file.id, label);
            });
        }
    }

    async toggleHistory(tr, preloadedSnapshots = null, hasMore = null) {
        const existing = tr.nextElementSibling;
        if (existing?.classList.contains('version-row')) {
            existing.remove();
            tr.querySelector('.version-btn').classList.remove('version-btn-open');
            return;
        }

        // Close any other open version rows
        document.querySelectorAll('.version-row').forEach(r => r.remove());
        document.querySelectorAll('.version-btn-open').forEach(b => b.classList.remove('version-btn-open'));

        tr.querySelector('.version-btn').classList.add('version-btn-open');

        const colCount = tr.cells.length;
        const loadingRow = document.createElement('tr');
        loadingRow.className = 'version-row';
        loadingRow.innerHTML = `<td colspan="${colCount}" style="text-align:center;padding:10px;">
            <x-icon name="spinner" class="spin" size="16px"></x-icon>
        </td>`;
        tr.after(loadingRow);

        try {
            let snapshots, fetchedHasMore;
            if (preloadedSnapshots !== null) {
                snapshots = preloadedSnapshots;
                fetchedHasMore = hasMore ?? false;
                loadingRow.remove();
            } else {
                const res     = await fetch(`/editor/snapshots/${this.file.id}/`);
                const fetched = await res.json();
                snapshots = fetched.snapshots ?? [];
                fetchedHasMore = fetched.has_more ?? false;
                loadingRow.remove();
            }
            const data = { snapshots, has_more: fetchedHasMore };

            if (!data.snapshots?.length) {
                const emptyRow = document.createElement('tr');
                emptyRow.className = 'version-row';
                emptyRow.innerHTML = `<td colspan="${colCount}" class="version-empty">${gettext('No versions')}</td>`;
                tr.after(emptyRow);
                return;
            }

            const container = document.createElement('tr');
            container.className = 'version-row';
            const td = document.createElement('td');
            td.colSpan = colCount;
            td.className = 'version-cell';

            const table = document.createElement('table');
            table.className = 'version-table';
            table.innerHTML = `
                <thead><tr>
                    <th>${gettext('Name')}</th>
                    <th>${gettext('Label')}</th>
                    <th style="text-align:center;">${gettext('Controls')}</th>
                    <th style="text-align:center;">${gettext('Routes')}</th>
                    <th>${gettext('Author')}</th>
                    <th class="col-team">${gettext('Team')}</th>
                    <th></th>
                    <th>${gettext('Saved')}</th>
                </tr></thead>
                <tbody>${data.snapshots.filter((s, i) => i > 0 || s.trigger === 'autosave').map(s => `
                    <tr class="snapshot-row" data-snapshot-id="${s.id}" style="cursor:pointer;" title="${gettext('Click to restore')}">
                        <td>${s.name || this.file.name}</td>
                        <td>${s.label__name
                            ? `<span class="table-label-chip" style="background:${s.label__color}22;color:${s.label__color};border-color:${s.label__color}55;">${s.label__name}</span>`
                            : ''}</td>
                        <td style="text-align:center;">${s.n_control_pairs}</td>
                        <td style="text-align:center;">${s.n_routes}</td>
                        <td>${s.author || s.created_by__first_name || '—'}</td>
                        <td class="col-team">${this.file.team_name || ''}</td>
                        <td><span class="version-trigger">${s.trigger || ''}</span></td>
                        <td>${this.formatDate(s.created_at)}</td>
                    </tr>`).join('')}
                </tbody>`;

            if (data.has_more) {
                const moreRow = document.createElement('tr');
                moreRow.innerHTML = `<td colspan="8" class="version-load-more">${gettext('Show all versions')}</td>`;
                moreRow.querySelector('td').addEventListener('click', async () => {
                    moreRow.querySelector('td').innerHTML =
                        `<x-icon name="spinner" class="spin" size="12px"></x-icon>`;
                    const res = await fetch(`/editor/snapshots/${this.file.id}/?all=1`);
                    const all = await res.json();
                    container.remove();
                    tr.querySelector('.version-btn').classList.remove('version-btn-open');
                    this.toggleHistory(tr, all.snapshots ?? [], false);
                });
                table.querySelector('tbody').appendChild(moreRow);
            }

            td.appendChild(table);
            container.appendChild(td);
            tr.after(container);

            table.querySelectorAll('.snapshot-row').forEach(row => {
                row.addEventListener('click', () => {
                    this.table.loadSnapshot(Number(row.dataset.snapshotId));
                });
                row.addEventListener('mouseenter', () => row.style.background = '#252525');
                row.addEventListener('mouseleave', () => row.style.background = '');
            });

            // Only scroll if the expanded content is clipped at the bottom
            requestAnimationFrame(() => {
                const scrollEl = document.querySelector('.modal-table-wrap') || document.querySelector('.modal-box');
                if (!scrollEl) return;
                const boxRect  = scrollEl.getBoundingClientRect();
                const rowBottom = container.getBoundingClientRect().bottom;
                if (rowBottom > boxRect.bottom) {
                    const rowTop = tr.getBoundingClientRect().top;
                    scrollEl.scrollTop += (rowTop - boxRect.top) - 32;
                }
            });
        } catch (e) {
            loadingRow.remove();
            console.error('Failed to load snapshots', e);
        }
    }

    _infinityTitle() {
        if (!this.file.has_mask) return gettext('Add a mask to this map first.');
        return this.file.infinite_enabled
            ? gettext('Infinite play is on — click to turn off')
            : gettext('Turn on infinite play for this map');
    }

    // Spinner while the navgraph builds (release only — retreat is instant).
    setInfinityBuilding(building) {
        const btn = this.element.querySelector(`#infinity-btn-${this.file.id}`);
        if (!btn) return;
        btn.disabled = building;
        btn.innerHTML = building
            ? `<x-icon name="spinner" class="spin" size="14px"></x-icon>`
            : icon("infinity");
    }

    updateInfiniteState(enabled) {
        this.file.infinite_enabled = enabled;
        const btn = this.element.querySelector(`#infinity-btn-${this.file.id}`);
        if (!btn) return;
        btn.disabled = false;
        btn.innerHTML = icon("infinity");
        btn.classList.toggle('publish-btn-active', enabled);
        btn.title = this._infinityTitle();
        if (enabled) window.emitPublishWave?.(btn);   // same ripple as publish
    }

    updatePublishState(published) {
        this.file.published = published;
        const btn = this.element.querySelector(`#publish-btn-${this.file.id}`);
        if (!btn) return;
        btn.classList.toggle('publish-btn-active', published);

                // Emit ripple wave from the publish button
        if (this.file.published) window.emitPublishWave?.(btn);
    }

    formatDate(date) {
        return new Date(date).toLocaleString('de-CH', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }
}
