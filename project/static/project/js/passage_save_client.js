// Abortable, single-flight persistence for the level-passages document.
//
// The editor treats the local document as the source of truth after the
// initial project load: every committed passage action sends one complete
// save-element request, a newer request aborts the one still in flight, and
// server responses never overwrite local state. This file is a classic script
// for editor.html (loaded before editor.js) and is also imported directly by
// the Node contract suite, so it must stay DOM-free.

(function (root) {
    "use strict";

    /**
     * @param {{fetchImpl: typeof fetch, getCsrfToken: () => string, url?: string}} options
     * @returns {{save: (payload: object) => Promise<{status: string, data: object|null, error?: Error}>, pending: () => boolean}}
     */
    function createPassageSaveClient({ fetchImpl, getCsrfToken, url = "/editor/save-element/" }) {
        let controller = null;

        function save(payload) {
            if (controller) controller.abort();
            const own = new AbortController();
            controller = own;
            return (async () => {
                try {
                    const response = await fetchImpl(url, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-CSRFToken": getCsrfToken(),
                        },
                        body: JSON.stringify(payload),
                        signal: own.signal,
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok || data?.error) return { status: "error", data };
                    return { status: "saved", data };
                } catch (error) {
                    // A newer save superseded this one; the newest request owns
                    // persistence and this outcome is not a failure.
                    if (own.signal.aborted) return { status: "superseded", data: null };
                    return { status: "failed", data: null, error };
                } finally {
                    if (controller === own) controller = null;
                }
            })();
        }

        return { save, pending: () => controller !== null };
    }

    root.createPassageSaveClient = createPassageSaveClient;
})(typeof globalThis !== "undefined" ? globalThis : window);
