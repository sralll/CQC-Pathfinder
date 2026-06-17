/* =========================================================
   FIRST-PLAY TUTORIAL
   Step-by-step overlay modals shown on top of the normal play screen
   (only when the page was rendered in tutorial mode). Each step is tied to
   a `play:*` lifecycle event emitted by play.js. All logic is inert unless
   PLAY_CONFIG.tutorial is true, so the regular play flow is untouched.

   The steps (German text verbatim):
     1. CP1 ready (complex)       → "Finde die schnellste Route …"
     2. routes revealed (1st tap) → highlight TIME BAR, "0.67s …"
     3. selection made            → highlight BUTTON BAR, "detaillierte Auswertung"
     4. stats panel opened        → legend explaining the evaluation graph
     5. step 4 dismissed          → how to continue (swipe/double-tap | space/enter/dblclick)
     6. CP2 ready (L/R)           → L/R posten explanation + 0.67s reminder

   ┌──────────────────────────────────────────────────────────────────────┐
   │ EDIT THE TUTORIAL TEXT in the STEPS object below.                      │
   │   main    = the main sentence(s)                                       │
   │   warn    = the ⚠ line (own line, warning icon in front)               │
   │   legend  = stats-graph rows: { icon:'<name>', text } | { mark, text } │
   │   gestures= (mobile step 5 only) shows the double-tap + swipe icons    │
   └──────────────────────────────────────────────────────────────────────┘
========================================================= */

(function () {
    if (!window.PLAY_CONFIG || !window.PLAY_CONFIG.tutorial) return;

    const overlay   = document.getElementById('tutorial-overlay');
    const box       = document.getElementById('tutorial-box');
    const textEl    = document.getElementById('tutorial-text');
    const closeBtn  = document.getElementById('tutorial-close');
    if (!overlay || !box || !textEl || !closeBtn) return;

    const isDesktop = document.body.classList.contains('desktop');
    const iconOf    = (name, size) =>
        (typeof window.icon === 'function') ? window.icon(name, size) : '';

    // ── Step content ──────────────────────────────────────────────
    // highlight: id of the element to spotlight while the modal is shown.
    // main: text.  legend: stats-graph rows.  warn: ⚠ line.  gestures: icons.
    const STEPS = {
        1: {
            main: isDesktop
                ? 'Finde die schnellste Route auf der leeren Karte. Klicke entweder direkt an die Stelle, wo deine Route durchgeht, um sie direkt auszuwählen.'
                + ' Falls deine Auswahl nicht eindeutig auf eine Route schliessen kann (keine Route, wo du geklickt hast, oder mehrere Routen an derselben Stelle), werden die Routen aufgedeckt.'
                + ' Oder du kannst auch direkt auf den Knopf unten klicken, um die Routen anzuzeigen. '
                : 'Finde die schnellste Route auf der leeren Karte. Tippe entweder direkt an die Stelle, wo deine Route durchgeht, um sie direkt auszuwählen.'
                + ' Falls deine Auswahl nicht eindeutig auf eine Route schliessen kann (keine Route, wo du getippt hast, oder mehrere Routen an derselben Stelle), werden die Routen aufgedeckt.'
                + ' Oder du kannst auch direkt auf den Knopf unten tippen, um die Routen anzuzeigen.',
            warn: 'Sobald die Routen angezeigt sind, hast du nur wenig Zeit zum entscheiden!',
        },
        2: {
            highlight: 'play-countdown',
            main: isDesktop
                ? `Klicke auf die aufgedeckte Route direkt auf der Karte oder auf die Knöpfe, `
                + `um deine Entscheidung zu bestätigen.`
                : `Tippe auf die aufgedeckte Route direkt auf der Karte oder auf die Knöpfe, `
                + `um deine Entscheidung zu bestätigen.`,
            warn: `Du hast 0.67s Zeit zu entscheiden, danach zählt jede zusätzliche Zeit 5-fach!`,
        },
        3: {
            highlight: 'play-btn-bar',
            // Exception: let the tap reach the buttons below — tapping the bar
            // opens the stats panel and dismisses this tip at the same time.
            clickThrough: true,
            main: isDesktop
                ? `Klicke die Knöpfe an, um eine detaillierte Auswertung zu sehen.`
                : `Tippe die Knöpfe an, um eine detaillierte Auswertung zu sehen.`,
        },
        4: {
            // Explains the route-evaluation graph (stats panel) once it opens,
            // and highlights that panel while the breakdown is shown.
            highlight: 'play-stats-panel',
            legend: [
                { icon: 'clock',        text: `Entscheidungszeit` },
                { icon: 'hourglass',    text: `inklusive 5-fach Strafe wegen zu später Routenwahl` },
                { mark: '40s',          text: `Gesamtzeit der Route` },
                { mark: '186m: +39s',   text: `Distanz-basierte Zeit` },
                { icon: 'elevation',    text: `zusätzliche Zeit wegen zusätzlicher Höhe (deine Trainer tragen meistens nur den Höhenunterschied zwischen Routen ein)` },
                { icon: 'angle',        text: `zusätzliche Zeit wegen scharfen Ecken` },
            ],
        },
        5: {
            main: isDesktop
                ? `Fahre weiter mit Leertaste, Enter oder Doppelklick auf die Karte.`
                : `Fahre weiter mit Doppeltipp oder Links-Swipe auf die Karte.`,
            gestures: !isDesktop,   // show double-tap + swipe icons below the text
        },
        6: {
            main: isDesktop
                ? `Bei L/R Posten entweder direkt die Knöpfe oder die Route an der erwarteten Stelle auf der Karte anklicken, oder nach der `
                + `Entscheidung auf die Karte klicken, um die Routen anzuzeigen.`
                : `Bei L/R Posten entweder direkt die Knöpfe antippen oder die Route an der erwarteten Stelle auf der Karte anklicken, oder nach der  `
                + `Entscheidung auf die Karte klicken, um die Routen anzuzeigen.`,
            warn: `Danach hast du wieder 0.67s, bevor die Zeit 5-fach zählt.`,
        },
    };

    // Build the modal HTML from a step's fields (main text, the stats-graph
    // legend, the ⚠ line on its own line, and the mobile continue-gesture icons).
    function buildHtml(step) {
        let html = '';
        if (step.main) html += `<p class="tutorial-main">${step.main}</p>`;
        if (step.legend) {
            html += `<div class="tutorial-legend">`;
            for (const row of step.legend) {
                const mark = row.icon
                    ? `<span class="tutorial-legend-icon">${iconOf(row.icon, '1.1em')}</span>`
                    : `<span class="tutorial-legend-val">${row.mark}</span>`;
                html += `<div class="tutorial-legend-row">${mark}<span>${row.text}</span></div>`;
            }
            html += `</div>`;
        }
        if (step.warn) {
            html += `<p class="tutorial-warn-line">`
                  + `<span class="tutorial-warn">${iconOf('warning', '1.2em')}</span>`
                  + `<span>${step.warn}</span></p>`;
        }
        if (step.gestures) {
            html += `<div class="tutorial-gestures">`
                  + `${iconOf('double-tap')}${iconOf('swipe')}</div>`;
        }
        return html;
    }

    let currentStep   = 0;        // 0 = nothing showing
    let highlightedEl = null;
    let seenStep3     = false;    // the "view stats" hint shows only once
    let awaitingStats = false;    // step 3 dismissed → waiting for a button-bar tap
    let finished      = false;    // after the last step, no more modals ever

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
        if (n === 3) seenStep3 = true;
        textEl.innerHTML = buildHtml(step);
        applyHighlight(step.highlight);
        // Only step 3 lets clicks through to the elements below; all others
        // absorb clicks so nothing underneath is interactive.
        document.body.classList.toggle('tutorial-clickthrough', !!step.clickThrough);
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
    }

    function hideStep() {
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('tutorial-clickthrough');
        clearHighlight();
        const closed = currentStep;
        currentStep = 0;
        return closed;
    }

    // ── Advancing (the ✕ or a click on the dim backdrop continues) ────
    function onClose() {
        const closed = hideStep();
        if (closed === 3) {
            // Step 3 dismissed → do NOT show "how to continue" yet. Wait until
            // the user actually taps the button bar to view stats.
            awaitingStats = true;
        } else if (closed === 4) {
            // Graph explained → now show "how to continue".
            showStep(5);
        } else if (closed === 6) {
            // Last modal dismissed → tutorial finished.
            finishTutorial();
        }
        // Steps 1, 2, 5 wait for the next play lifecycle event to advance.
    }

    closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        onClose();
    });

    // The overlay absorbs clicks (so nothing underneath is clickable), but a
    // click on the dim backdrop does NOT close it — only the ✕ does.
    overlay.addEventListener('click', e => { e.stopPropagation(); });

    // While the click-through step (step 3) is open, the ONLY allowed action is
    // opening the details menu by tapping the bar. Block keyboard advance
    // (space / enter) so the athlete can't skip to the next control. Capture
    // phase, so this runs before play.js's own keydown handler.
    document.addEventListener('keydown', e => {
        if (STEPS[currentStep]?.clickThrough && (e.key === ' ' || e.key === 'Enter')) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // ── Play lifecycle wiring ─────────────────────────────────────
    document.addEventListener('play:cp-ready', e => {
        if (finished) return;
        // Wire by control INDEX, not by `complex`: a real tutorial file may have
        // several complex controls, and tip 1 must not re-fire on each one.
        const { index } = e.detail || {};
        if      (index === 0) showStep(1);   // first control → full walkthrough
        else if (index === 1) showStep(6);   // second control → brief reminder
        // index >= 2 → no modal; the athlete just plays the rest of the file.
    });

    document.addEventListener('play:routes-revealed', () => {
        if (finished) return;
        // Step 2 only matters during the first (complex) control's reveal.
        if (currentStep <= 2) showStep(2);
    });

    document.addEventListener('play:selection-made', () => {
        if (finished) return;
        // The "tap for evaluation" hint is shown exactly once, on the first
        // control — never again on the second control.
        if (!seenStep3 && currentStep <= 3) showStep(3);
    });

    document.addEventListener('play:stats-viewed', () => {
        if (finished) return;
        // The user opened the stats panel — either by tapping straight through
        // the step-3 tip (currentStep === 3) or after dismissing it with the ✕
        // (awaitingStats). Either way: explain the evaluation graph (step 4).
        // "How to continue" (step 5) follows when that modal is dismissed.
        if (awaitingStats || currentStep === 3) {
            awaitingStats = false;
            showStep(4);
        }
    });

    // ── Completion ────────────────────────────────────────────────
    function finishTutorial() {
        finished = true;            // hard stop: no further modals
        // Consume the first-play flag for this device type so the tutorial
        // won't auto-trigger again (server: results/views.py → tutorial_complete).
        // The dedicated /play/tutorial/ route still works for manual re-testing.
        markComplete();
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
