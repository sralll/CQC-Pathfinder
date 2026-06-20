(function () {
    const page = document.getElementById("guide-page");
    const toggle = document.querySelector(".guide-theme-toggle");
    if (!page || !toggle) return;

    const storageKey = "cqc-guide-theme";
    const saved = localStorage.getItem(storageKey);
    const initialTheme = saved === "light" || saved === "dark" ? saved : "dark";

    function applyTheme(theme) {
        page.dataset.theme = theme;
        document.body.classList.toggle("guide-light", theme === "light");
        toggle.setAttribute(
            "aria-label",
            theme === "dark" ? "Helle Darstellung aktivieren" : "Dunkle Darstellung aktivieren"
        );
        toggle.setAttribute(
            "title",
            theme === "dark" ? "Helle Darstellung aktivieren" : "Dunkle Darstellung aktivieren"
        );
    }

    applyTheme(initialTheme);

    toggle.addEventListener("click", function () {
        const nextTheme = page.dataset.theme === "dark" ? "light" : "dark";
        localStorage.setItem(storageKey, nextTheme);
        applyTheme(nextTheme);
    });
})();

/* =========================================================
   SEARCH — instant client-side filter over the article.
   Hides non-matching content while keeping the heading path
   to every match (and revealing a matched heading's subtree).
========================================================= */
(function () {
    const input = document.getElementById("guide-search-input");
    const clearBtn = document.getElementById("guide-search-clear");
    const article = document.querySelector(".guide-article");
    const noResults = document.getElementById("guide-no-results");
    if (!input || !article) return;

    // Each section is an ordered list of items with a heading level:
    //   2 = section heading (.guide-section-heading), 3 = h3, 4 = h4,
    //   99 = content block (p / ul / shortcut table) tied to the nearest heading.
    const sections = Array.from(article.querySelectorAll(".guide-section")).map(section => {
        const items = [];
        section.childNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            const el = node;
            let level = 99;
            if (el.classList.contains("guide-section-heading")) level = 2;
            else if (el.tagName === "H3") level = 3;
            else if (el.tagName === "H4") level = 4;
            items.push({ el, level, text: el.textContent.toLowerCase() });
        });
        return { section, items };
    });

    function hide(el, on) { el.classList.toggle("guide-hide", on); }

    function apply() {
        const q = input.value.trim().toLowerCase();
        clearBtn.classList.toggle("visible", input.value.length > 0);

        if (!q) {
            sections.forEach(({ section, items }) => {
                hide(section, false);
                items.forEach(it => hide(it.el, false));
            });
            if (noResults) noResults.hidden = true;
            return;
        }

        let anyVisible = false;

        sections.forEach(({ section, items }) => {
            items.forEach(it => { it.own = it.text.includes(q); });

            // A heading matches if it or anything in its subtree matches.
            items.forEach((it, i) => {
                if (it.level >= 99) return;
                it.subtree = it.own;
                for (let j = i + 1; j < items.length && !it.subtree; j++) {
                    if (items[j].level <= it.level) break;
                    if (items[j].own) it.subtree = true;
                }
            });

            // Walk with a heading stack so a matched heading reveals its subtree
            // and every match keeps its ancestor headings visible.
            const stack = [];
            let sectionMatch = false;
            items.forEach(it => {
                if (it.level < 99) {
                    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
                    it.show = it.subtree || stack.some(h => h.own);
                    stack.push(it);
                } else {
                    it.show = it.own || stack.some(h => h.own);
                }
                hide(it.el, !it.show);
                if (it.show) sectionMatch = true;
            });

            hide(section, !sectionMatch);
            if (sectionMatch) anyVisible = true;
        });

        if (noResults) noResults.hidden = anyVisible;
    }

    input.addEventListener("input", apply);
    input.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { input.value = ""; apply(); }
    });
    clearBtn.addEventListener("click", function () {
        input.value = "";
        apply();
        input.focus();
    });
})();
