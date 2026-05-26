import { FileRow } from './file_row.js';

export class FileTable {

    constructor(tbody) {

        this.tbody = tbody;

        this.files = [];
        this.rows = [];
    }

    setFiles(files) {

        this.files = files;

        this.rows = files.map(file =>
            new FileRow(file, this)
        );

        this.render();
    }

    render() {

        this.tbody.innerHTML = '';

        this.rows.forEach(row => {
            this.tbody.appendChild(row.element);
        });
    }

    sortBy(key, dir = 1) {

        this.rows.sort((a, b) => {

            let va = a.file[key];
            let vb = b.file[key];

            if (typeof va === 'string') {
                va = va.toLowerCase();
                vb = vb.toLowerCase();
            }

            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;

            return 0;
        });

        this.render();
    }

    async togglePublish(row) {

        const res = await fetch(
            `/editor/publish/${row.file.id}/`,
            {
                method: 'POST',
                headers: {
                    'X-CSRFToken': getCSRFToken()
                }
            }
        );

        const data = await res.json();

        row.updatePublishState(data.published);
    }

    deleteFile(id) {

        console.log("delete", id);
    }
}

function getCSRFToken() {

    return document
        .querySelector('meta[name="csrf-token"]')
        .getAttribute('content');
}