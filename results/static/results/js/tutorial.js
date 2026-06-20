/* =========================================================
   FIRST-PLAY TUTORIAL
   Step-by-step overlay modals shown on top of the normal play screen
   (only when the page was rendered in tutorial mode). Each step is tied to
   a `play:*` lifecycle event emitted by play.js. All logic is inert unless
   PLAY_CONFIG.tutorial is true, so the regular play flow is untouched.

   The course has 4 controls: [0 complex, 1 complex, 2 L/R, 3 complex]. Tips are
   wired by control INDEX (see the play:* listeners at the bottom):

   Control 0 (complex) — full walkthrough:
     1. cp-ready                  → "Find the fastest route …" (make a selection)
     3. selection made            → highlight BUTTON BAR, "detailed evaluation"
     4. stats panel opened        → legend explaining the evaluation graph (anchored
                                     higher on screen so it never overlaps the panel)
     5. step 4 dismissed          → how to continue (swipe/double-tap | space/enter/dblclick)
   Control 1 (complex) — direct picks are blocked until reveal (play.js
                          handleRouteHit), so the first map tap reveals the routes:
     2. routes revealed (1st tap) → highlight TIME BAR + 0.5s free-time warning
   Control 2 (L/R):
     6. cp-ready                  → L/R control explanation (less important)
   Control 3 (complex): no tip — the athlete just finishes the course.

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
    const mapContainer = document.getElementById('map-container');
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
                ? gettext('Find the fastest route on the empty map. Click directly where your route goes to select it immediately. If the selection is unambiguous at the clicked spot, the route is selected right away.')
                : gettext('Find the fastest route on the empty map. Tap directly where your route goes to select it immediately. If the selection is unambiguous at the tapped spot, the route is selected right away.'),
            zoom: isDesktop
                ? gettext('You can zoom in with the scroll wheel or trackpad.')
                : gettext('You can zoom in with pinch-zoom (two fingers).'),
            warn: gettext('If no or several routes are drawn at the chosen spot, they are revealed (or via the Show routes button). But then you only have a short time to make your decision.'),
        },
        2: {
            highlight: 'play-countdown',
            main: isDesktop
                ? gettext('Even though you may have picked a route directly, this is what happens if you miss it or click where two routes overlap:')
                : gettext('Even though you may have picked a route directly, this is what happens if you miss it or tap where two routes overlap:'),
            // Rendered as one flowing line: "<warnLead> ⚠ <warn>".
            warnLead: gettext('The routes are shown on the map, but'),
            warn: gettext('You have 0.5s to decide; after that every extra second counts fivefold!'),
        },
        3: {
            highlight: 'play-btn-bar',
            // Exception: let the tap reach the buttons below — tapping the bar
            // opens the stats panel and dismisses this tip at the same time.
            clickThrough: true,
            main: isDesktop
                ? gettext('Click the buttons to see a detailed evaluation.')
                : gettext('Tap the buttons to see a detailed evaluation.'),
        },
        4: {
            // Explains the route-evaluation graph (stats panel) once it opens,
            // and highlights that panel while the breakdown is shown.
            highlight: 'play-stats-panel',
            legend: [
                { icon: 'clock',        text: gettext('Decision time') },
                { icon: 'hourglass',    text: gettext('including a fivefold penalty for choosing the route too late') },
                { mark: '42s',          text: gettext('Total time of the route') },
                { mark: '185m',         text: gettext('Distance-based time') },
                { icon: 'elevation',    text: gettext('extra time due to additional elevation') },
                { icon: 'obstacle',     text: gettext('extra time due to stairs or other obstacles') },
                { icon: 'angle',        text: gettext('extra time due to sharp corners') },
            ],
        },
        5: {
            // The athlete may continue straight from this tip — key presses and a
            // double-click pass through to the map (advanceThrough); reaching the
            // next control auto-dismisses it (see the cp-starting listener).
            advanceThrough: true,
            main: isDesktop
                ? gettext('Continue with the space bar, Enter, or a double-click on the map.')
                : gettext('Continue with a double-tap or a left swipe on the map.'),
            gestures: !isDesktop,   // mobile: double-tap + swipe icons
            keys:     isDesktop,    // desktop: Space / Enter keycaps + double-click
        },
        6: {
            main: isDesktop
                ? gettext('At Left/Right controls, either click the buttons directly or click the route at the expected spot on the map, or click the map after deciding to reveal the routes.')
                : gettext('At Left/Right controls, either tap the buttons directly or tap the route at the expected spot on the map, or tap the map after deciding to reveal the routes.'),
            warn: gettext('After that you again have 0.5s before time counts fivefold.'),
        },
    };

    // Build the modal HTML from a step's fields (main text, the stats-graph
    // legend, the ⚠ line on its own line, and the mobile continue-gesture icons).
    function buildHtml(step) {
        let html = '';
        if (step.main) html += `<p class="tutorial-main">${step.main}</p>`;
        if (step.zoom) html += `<p class="tutorial-main tutorial-zoom">${step.zoom}</p>`;
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
        if (step.warnLead) {
            // Inline warn: a flowing sentence with the ⚠ icon mid-text
            // ("<lead> ⚠ <warn>") instead of the standalone warn line below.
            html += `<p class="tutorial-main">${step.warnLead} `
                  + `<span class="tutorial-warn tutorial-warn-inline">${iconOf('warning', '1.1em')}</span> `
                  + `${step.warn}</p>`;
        } else if (step.warn) {
            html += `<p class="tutorial-warn-line">`
                  + `<span class="tutorial-warn">${iconOf('warning', '1.2em')}</span>`
                  + `<span>${step.warn}</span></p>`;
        }
        if (step.gestures) {
            html += `<div class="tutorial-gestures">`
                  + `${iconOf('double-tap')}${iconOf('swipe')}</div>`;
        }
        if (step.keys) {
            // Desktop "how to continue": highlight the keys + the double-click method.
            html += `<div class="tutorial-keys">`
                  + `<kbd class="tutorial-key">${gettext('Space')}</kbd>`
                  + `<kbd class="tutorial-key">Enter</kbd>`
                  + `<span class="tutorial-key-method">${iconOf('double-tap')}</span>`
                  + `</div>`;
        }
        return html;
    }

    let currentStep   = 0;        // 0 = nothing showing
    let highlightedEl = null;
    let seenStep3     = false;    // the "view stats" hint shows only once
    let awaitingStats = false;    // step 3 dismissed → waiting for a button-bar tap
    let finished      = false;    // after the last step, no more modals ever
    let titleEl       = null;      // pre-start title shown over the loaded map

    function showTitle() {
        if (!mapContainer || titleEl) return;
        titleEl = document.createElement('div');
        titleEl.id = 'tutorial-title';
        titleEl.textContent = 'Tutorial';
        mapContainer.appendChild(titleEl);
    }

    function hideTitle() {
        titleEl?.remove();
        titleEl = null;
    }

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
        // The legend step (step 4) is tall and shows while the stats panel is
        // open at the bottom — anchor its box to the top so the two never collide.
        document.body.classList.toggle('tutorial-legend-step', !!step.legend);
        // Step 5 lets the continue gesture (keys / double-click) pass through the
        // backdrop to the map so the athlete can continue without dismissing first.
        document.body.classList.toggle('tutorial-advance-through', !!step.advanceThrough);
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
        // Pause the choice timer in play.js so reading a tip never costs time.
        document.dispatchEvent(new CustomEvent('tutorial:pause-timer'));
    }

    function hideStep() {
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('tutorial-clickthrough');
        document.body.classList.remove('tutorial-legend-step');
        document.body.classList.remove('tutorial-advance-through');
        clearHighlight();
        // Resume the choice timer (shifts the start forward by the paused span).
        document.dispatchEvent(new CustomEvent('tutorial:resume-timer'));
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
        if      (index === 0) showStep(1);   // first control (complex) → full walkthrough
        else if (index === 2) showStep(6);   // third control (L/R) → brief L/R reminder
        // Control 1's tip fires on reveal (not cp-ready); control 3 has no modal.
        // The athlete just plays the rest of the file.
    });

    document.addEventListener('play:map-loaded', () => {
        if (finished) return;
        showTitle();
    });

    document.addEventListener('play:cp-starting', () => {
        hideTitle();
        // Advancing to a new control dismisses any tip still showing — notably
        // step 5, which the athlete may have continued through directly.
        if (overlay.classList.contains('open')) hideStep();
    });

    document.addEventListener('play:routes-revealed', e => {
        if (finished) return;
        // Step 2 fires on the second control (index 1, complex): there direct
        // picks are blocked until reveal (play.js handleRouteHit), so the first
        // map tap reveals and we explain the 0.5s free-time / penalty time bar.
        if (e.detail?.index === 1 && currentStep <= 2) showStep(2);
    });

    document.addEventListener('play:selection-made', e => {
        if (finished) return;
        // The "tap for evaluation" hint is shown exactly once, after the first
        // selection on the walkthrough control (index 0).
        if (e.detail?.index === 0 && !seenStep3 && currentStep <= 3) showStep(3);
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
