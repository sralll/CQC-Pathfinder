export class FileRow {

    constructor(file, table, showTeamColumn) {

        this.file = file;
        this.table = table;
        this.showTeamColumn = showTeamColumn;

        this.element = this.createRow();
    }

    createRow() {

        const tr = document.createElement('tr');

        if (!this.file.can_edit) {
            tr.classList.add('foreign-file-row');
        }

        tr.innerHTML = `

            <td>
                <button
                    id="publish-btn-${this.file.id}"
                    class="
                        publish-btn
                        ${this.file.published ? 'publish-btn-active' : ''}
                        ${!this.file.can_edit ? 'publish-btn-disabled' : ''}
                    "
                    ${!this.file.can_edit ? 'disabled' : ''}
                >
                    <i class="fa-solid fa-globe"></i>
                </button>
            </td>

            <td class="file-name-cell">
                ${this.file.name}
            </td>

            <td>
                ${
                    this.file.label
                        ? `<span class="table-label-chip">${this.file.label.name}</span>`
                        : ''
                }
            </td>

            <td style="text-align:center;">
                ${this.file.cp_count}
            </td>

            <td>
                ${this.file.author}
            </td>

            <!-- ALWAYS PRESENT -->
            <td class="col-team">
                ${this.file.team_name || ''}
            </td>

            <td style="text-align:center;">
                <button class="action-btn version-btn">
                    <i class="fa-solid fa-angles-down"></i>
                </button>
            </td>

            <td>
                ${this.formatDate(this.file.last_edited)}
            </td>

            <td>
                ${
                    this.file.can_edit
                        ? `
                            <div class="file-action-group">
                                <button class="action-btn danger-btn delete-btn">
                                    <i class="fa-solid fa-trash"></i>
                                </button>

                                <button class="action-btn">
                                    <i class="fa-solid fa-industry"></i>
                                </button>
                            </div>
                        `
                        : ''
                }
            </td>
        `;

        this.attachEvents(tr);
        return tr;
    }

    attachEvents(tr) {

        const publishBtn =
            tr.querySelector(`#publish-btn-${this.file.id}`);

        if (publishBtn && this.file.can_edit) {
            publishBtn.addEventListener('click', () => {
                this.table.togglePublish(this);
            });
        }

        const deleteBtn =
            tr.querySelector('.delete-btn');

        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                this.table.deleteFile(this.file.id);
            });
        }
    }

    updatePublishState(published) {

        this.file.published = published;

        const btn =
            this.element.querySelector(`#publish-btn-${this.file.id}`);

        if (!btn) return;

        btn.classList.toggle(
            'publish-btn-active',
            published
        );
    }

    formatDate(date) {

        return new Date(date).toLocaleString('de-CH', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
}