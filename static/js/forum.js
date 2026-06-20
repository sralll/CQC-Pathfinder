/* Forum interactions: upvote toggling (threads + comments), the collapsible
   "new thread" compose form, inline editing of own threads/comments, and the
   instant client-side search. Plain vanilla JS, no deps. */
(function () {
    function csrfToken() {
        const m = document.querySelector('meta[name="csrf-token"]');
        return m ? m.getAttribute('content') : '';
    }

    // ── Upvote toggle (event-delegated; same markup for threads & comments) ──
    document.addEventListener('click', function (e) {
        const btn = e.target.closest('.vote');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();

        const url = btn.dataset.voteUrl;
        if (!url || btn.dataset.pending) return;
        btn.dataset.pending = '1';

        fetch(url, {
            method: 'POST',
            headers: {
                'X-CSRFToken': csrfToken(),
                'X-Requested-With': 'XMLHttpRequest',
            },
        })
            .then(function (r) {
                if (!r.ok) throw new Error('vote failed');
                return r.json();
            })
            .then(function (data) {
                btn.classList.toggle('voted', data.voted);
                const count = btn.querySelector('.vote-count');
                if (count) count.textContent = data.count;
            })
            .catch(function () { /* leave UI unchanged on failure */ })
            .finally(function () { delete btn.dataset.pending; });
    });

    // ── Inline edit toggle for own threads/comments (event-delegated) ──
    document.addEventListener('click', function (e) {
        const editBtn = e.target.closest('.fe-edit');
        if (editBtn) {
            const box = editBtn.closest('.fe-editable');
            if (!box) return;
            box.querySelector('.fe-view').hidden = true;
            const form = box.querySelector('.fe-form');
            form.hidden = false;
            const field = form.querySelector('input, textarea');
            if (field) {
                field.focus();
                // place caret at the end rather than selecting everything
                const len = field.value.length;
                try { field.setSelectionRange(len, len); } catch (err) { /* noop */ }
            }
            return;
        }
        const cancelBtn = e.target.closest('.fe-cancel');
        if (cancelBtn) {
            e.preventDefault();
            const box = cancelBtn.closest('.fe-editable');
            if (!box) return;
            const form = box.querySelector('.fe-form');
            form.reset();            // restore the original server-rendered values
            form.hidden = true;
            box.querySelector('.fe-view').hidden = false;
        }
    });

    // ── Compose form toggle (forum index only) ──
    const newBtn = document.getElementById('forum-new-btn');
    const compose = document.getElementById('forum-compose');
    if (newBtn && compose) {
        newBtn.addEventListener('click', function () {
            const willOpen = compose.hasAttribute('hidden');
            compose.toggleAttribute('hidden');
            if (willOpen) {
                const title = compose.querySelector('input[name="title"]');
                if (title) title.focus();
            }
        });
        const cancel = compose.querySelector('.forum-cancel');
        if (cancel) {
            cancel.addEventListener('click', function () {
                compose.setAttribute('hidden', '');
            });
        }
    }

    // ── Instant client-side search over the loaded threads (forum index) ──
    const searchInput = document.getElementById('forum-search-input');
    if (searchInput) {
        const cards = Array.from(document.querySelectorAll('.thread-card'));
        // Pre-compute a lowercase haystack (title + body + author) per card.
        cards.forEach(function (card) {
            const parts = ['.thread-card-title', '.thread-snippet', '.thread-meta .author']
                .map(function (sel) {
                    const el = card.querySelector(sel);
                    return el ? el.textContent : '';
                });
            card._haystack = parts.join(' ').toLowerCase();
        });

        const clearBtn = document.getElementById('forum-search-clear');
        const countEl = document.getElementById('forum-count');
        const noResults = document.getElementById('forum-no-results');

        function germanCount(n) {
            return n + ' ' + (n === 1 ? gettext('topic') : gettext('topics'));
        }

        function applySearch() {
            const raw = searchInput.value;
            const q = raw.trim().toLowerCase();
            let visible = 0;
            cards.forEach(function (card) {
                const match = !q || card._haystack.indexOf(q) !== -1;
                // Inline display so it beats the `.thread-card { display: flex }`
                // rule (the `hidden` attribute would lose that specificity battle).
                card.style.display = match ? '' : 'none';
                if (match) visible++;
            });
            if (clearBtn) clearBtn.classList.toggle('visible', raw.length > 0);
            if (countEl) countEl.textContent = germanCount(visible);
            if (noResults) {
                if (cards.length && visible === 0) {
                    noResults.textContent = interpolate(gettext('No topics found for “%s”.'), [raw.trim()]);
                    noResults.hidden = false;
                } else {
                    noResults.hidden = true;
                }
            }
        }

        searchInput.addEventListener('input', applySearch);
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                searchInput.value = '';
                applySearch();
            }
        });
        if (clearBtn) {
            clearBtn.addEventListener('click', function () {
                searchInput.value = '';
                applySearch();
                searchInput.focus();
            });
        }
    }
})();
