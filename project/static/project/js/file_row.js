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
                    class="publish-btn ${this.file.published ? 'publish-btn-active' : ''} ${!this.file.can_edit ? 'publish-btn-disabled' : ''}"
                    ${!this.file.can_edit ? 'disabled' : ''}>
                    ${icon("broadcast")}
                </button>
            </td>
            <td class="file-name-cell">${this.file.name}</td>
            <td>${this.file.label ? `<span class="table-label-chip">${this.file.label.name}</span>` : ''}</td>
            <td style="text-align:center;">${this.file.cp_count}</td>
            <td>${this.file.author}</td>
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
                        <button class="action-btn danger-btn delete-btn">
                            ${icon("trash")}
                        </button>
                        <button class="action-btn">
                            ${icon("industry")}
                        </button>
                    </div>` : ''}
            </td>
        `;

        this.attachEvents(tr);
        return tr;
    }

    attachEvents(tr) {
        const publishBtn = tr.querySelector(`#publish-btn-${this.file.id}`);
        if (publishBtn && this.file.can_edit) {
            publishBtn.addEventListener('click', () => this.table.togglePublish(this));
        }

        const deleteBtn = tr.querySelector('.delete-btn');
        if (deleteBtn) {
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
    }

    async toggleHistory(tr) {
        const existing = tr.nextElementSibling;
        if (existing?.classList.contains('version-row')) {
            existing.remove();
            tr.querySelector('.version-btn').classList.remove('version-btn-open');
            return;
        }

        // Block if cache already knows there are no snapshots
        const cached = window.snapshotsCache?.get(this.file.id);
        if (cached && cached.length === 0) return;

        // Close any other open version rows
        document.querySelectorAll('.version-row').forEach(r => r.remove());
        document.querySelectorAll('.version-btn-open').forEach(b => b.classList.remove('version-btn-open'));

        tr.querySelector('.version-btn').classList.add('version-btn-open');

        const colCount = tr.cells.length;
        const loadingRow = document.createElement('tr');
        loadingRow.className = 'version-row';
        loadingRow.innerHTML = `<td colspan="${colCount}" class="version-loading">
            <x-icon name="spinner" class="spin" size="12px"></x-icon> Wird geladen…
        </td>`;
        tr.after(loadingRow);

        try {
            let snapshots;
            if (window.snapshotsCache?.has(this.file.id)) {
                snapshots = window.snapshotsCache.get(this.file.id);
                loadingRow.remove();
            } else {
                const res     = await fetch(`/editor/snapshots/${this.file.id}/`);
                const fetched = await res.json();
                snapshots = fetched.snapshots ?? [];
                if (window.snapshotsCache) {
                    window.snapshotsCache.set(this.file.id, snapshots);
                    window.snapshotsCache.set(`${this.file.id}_has_more`, fetched.has_more ?? false);
                }
                loadingRow.remove();
            }
            const hasMore = window.snapshotsCache?.get(`${this.file.id}_has_more`) ?? snapshots.length >= 10;
            const data = { snapshots, has_more: hasMore };

            if (!data.snapshots?.length) {
                const emptyRow = document.createElement('tr');
                emptyRow.className = 'version-row';
                emptyRow.innerHTML = `<td colspan="${colCount}" class="version-empty">Keine Snapshots vorhanden</td>`;
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
                    <th>Name</th>
                    <th>Label</th>
                    <th style="text-align:center;">Posten</th>
                    <th style="text-align:center;">Routen</th>
                    <th>Autor</th>
                    <th class="col-team">Kader</th>
                    <th></th>
                    <th>Gespeichert</th>
                </tr></thead>
                <tbody>${data.snapshots.map(s => `
                    <tr class="snapshot-row" data-snapshot-id="${s.id}" style="cursor:pointer;" title="Klicken zum Wiederherstellen">
                        <td>${this.file.name}</td>
                        <td>${this.file.label ? `<span class="table-label-chip">${this.file.label.name}</span>` : ''}</td>
                        <td style="text-align:center;">${s.n_control_pairs}</td>
                        <td style="text-align:center;">${s.n_routes}</td>
                        <td>${s.created_by__first_name || '—'}</td>
                        <td class="col-team">${this.file.team_name || ''}</td>
                        <td><span class="version-trigger">${s.trigger || ''}</span></td>
                        <td>${this.formatDate(s.created_at)}</td>
                    </tr>`).join('')}
                </tbody>`;

            if (data.has_more) {
                const moreRow = document.createElement('tr');
                moreRow.innerHTML = `<td colspan="7" class="version-load-more">Alle Versionen anzeigen</td>`;
                moreRow.querySelector('td').addEventListener('click', async () => {
                    moreRow.querySelector('td').textContent = '…';
                    const res  = await fetch(`/editor/snapshots/${this.file.id}/?all=1`);
                    const all  = await res.json();
                    if (window.snapshotsCache) {
                        window.snapshotsCache.set(this.file.id, all.snapshots ?? []);
                        window.snapshotsCache.set(`${this.file.id}_has_more`, false);
                    }
                    // Re-open to show all
                    container.remove();
                    tr.querySelector('.version-btn').classList.remove('version-btn-open');
                    this.toggleHistory(tr);
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

    updatePublishState(published) {
        this.file.published = published;
        const btn = this.element.querySelector(`#publish-btn-${this.file.id}`);
        if (!btn) return;
        btn.classList.toggle('publish-btn-active', published);
    }

    formatDate(date) {
        return new Date(date).toLocaleString('de-CH', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }
}