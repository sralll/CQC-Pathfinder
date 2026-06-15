/* =========================================================
   FIRST-PLAY TUTORIAL
   Step-by-step overlay modals shown on top of the normal play screen
   (only when the page was rendered in tutorial mode). Each step is tied to
   a `play:*` lifecycle event emitted by play.js. All logic is inert unless
   PLAY_CONFIG.tutorial is true, so the regular play flow is untouched.

   The six steps (German text verbatim):
     1. CP1 ready (complex)      → "Finde die schnellste Route …"
     2. routes revealed (1st tap)→ highlight TIME BAR, "0.67s …"
     3. selection made           → highlight BUTTON BAR, "detaillierte Auswertung"
     4. step 3 dismissed         → how to continue (swipe/double-tap | space/enter/dblclick)
     5. CP2 ready (L/R)          → L/R posten explanation + 0.67s reminder
     6. step 5 dismissed         → no more modals; (optionally) flip first-play flag
========================================================= */

(function () {
    if (!window.PLAY_CONFIG || !window.PLAY_CONFIG.tutorial) return;

    const overlay   = document.getElementById('tutorial-overlay');
    const box       = document.getElementById('tutorial-box');
    const textEl    = document.getElementById('tutorial-text');
    const closeBtn  = document.getElementById('tutorial-close');
    if (!overlay || !box || !textEl || !closeBtn) return;

    const isDesktop = document.body.classList.contains('desktop');
    const warn      = () => (typeof window.icon === 'function')
        ? `<span class="tutorial-warn">${window.icon('warning', '1.1em')}</span>`
        : '⚠';

    // ── Step content ──────────────────────────────────────────────
    // highlight: id of the element to spotlight while the modal is shown.
    const STEPS = {
        1: {
            html: `Finde für dich die schnellste Route. Sobald du dich entschieden hast, `
                + `tippe irgendwo auf den Bildschirm oder auf die leeren Knöpfe im Feld unten. `
                + `${warn()} Zuerst entscheiden, dann tippen.`,
        },
        2: {
            highlight: 'play-countdown',
            html: `Klicke auf die Route direkt auf der Karte oder auf die Knöpfe, `
                + `um deine Entscheidung zu bestätigen. `
                + `${warn()} Du hast 0.67s Zeit (die Leiste über den Knöpfen) — `
                + `wenn du zögerst, zählt jede zusätzliche Zeit 5-fach.`,
        },
        3: {
            highlight: 'play-btn-bar',
            html: `Tippe die Knöpfe an, um eine detaillierte Auswertung zu sehen.`,
        },
        4: {
            html: isDesktop
                ? `Fahre weiter mit Leertaste, Enter oder Doppelklick auf die Karte.`
                : `Fahre weiter mit Doppeltipp oder Swipe auf die Karte.`,
        },
        5: {
            html: `Bei L/R Posten entweder direkt die Knöpfe antippen, oder nach der `
                + `Entscheidung auf die Karte klicken, um die Routen anzuzeigen. `
                + `${warn()} Danach hast du wieder 0.67s, bevor die Zeit 5-fach zählt.`,
        },
    };

    let currentStep    = 0;     // 0 = nothing showing
    let highlightedEl  = null;

    function clearHighlight() {
        if (highlightedEl) {
            highlightedEl.classList.remove('tutorial-highlight');
            highlightedEl = null;
        }
    }

    function applyHighlight(id) {
        clearHighlight();
        if (!id) return;
        const el = document.getElementById(id);
        if (el) {
            el.classList.add('tutorial-highlight');
            highlightedEl = el;
        }
    }

    function showStep(n) {
        const step = STEPS[n];
        if (!step) return;
        currentStep = n;
        textEl.innerHTML = step.html;
        applyHighlight(step.highlight);
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
    }

    function hideStep() {
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
        clearHighlight();
        const closed = currentStep;
        currentStep = 0;
        return closed;
    }

    // ── Advancing (the ✕ continues the tutorial) ──────────────────
    function onClose() {
        const closed = hideStep();
        if (closed === 3) {
            // Step 3 dismissed → immediately show "how to continue".
            showStep(4);
        } else if (closed === 5) {
            // Last modal dismissed → tutorial finished.
            finishTutorial();
        }
        // Steps 1, 2, 4 wait for the next play lifecycle event to advance.
    }

    closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        onClose();
    });

    // ── Play lifecycle wiring ─────────────────────────────────────
    document.addEventListener('play:cp-ready', e => {
        const { complex } = e.detail || {};
        if (complex) showStep(1);   // first control (complex)
        else         showStep(5);   // second control (L/R)
    });

    document.addEventListener('play:routes-revealed', () => {
        // Step 2 only matters during the first (complex) control's reveal,
        // i.e. while we're still in the step-1→4 sequence.
        if (currentStep <= 2) showStep(2);
    });

    document.addEventListener('play:selection-made', () => {
        // Only show the "tap for evaluation" hint during the first control.
        if (currentStep <= 3) showStep(3);
    });

    // ── Completion ────────────────────────────────────────────────
    function finishTutorial() {
        // ===========================================================
        // ENABLE-BEFORE-LAUNCH:
        // Uncomment the markComplete() call below to actually consume the
        // first-play flag once the athlete finishes the tutorial. It is
        // disabled for now so the tutorial can be re-run repeatedly during
        // testing without resetting the Profile flags. The server endpoint
        // (results/views.py → tutorial_complete) is ALSO commented out and
        // must be uncommented too.
        // -----------------------------------------------------------
        // markComplete();
        // ===========================================================
    }

    function markComplete() {
        const device = isDesktop ? 'desktop' : 'mobile';
        const csrf   = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? '';
        fetch('/play/tutorial-complete/', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
            body:    JSON.stringify({ device }),
        }).catch(err => console.error('tutorial-complete failed:', err));
    }
})();
