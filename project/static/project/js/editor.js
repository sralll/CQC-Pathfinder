/* =========================================================
    PROJECT STATE
========================================================= */

let project = {
    id: null,
    name: 'Neues Projekt',
    scale: null,
    scaled: false,
    map_file: '',
    has_mask: false,
    blocked_terrain: null,
    control_pairs: []
};

let projectFiles = [];
let filteredFiles = [];
let filesLoadingPromise = null;
let currentProjectName = "Neues Projekt";

/* =========================================================
    CAMERA STATE
========================================================= */

const zoomMin = 0.2;
const zoomMax = 8;
const SNAP_DISTANCE_CONTROL_PAIR = 15;
const SNAP_DISTANCE_ROUTE_EDIT   = 5;
const CP_MOVE_THRESHOLD = 3;  // px — below: adjust route endpoints; above: clear routes
const R_CONTROL = 25;
const GAP = 8;
const RUN_SPEED = 4.75;         // average running speed in m/s
const PX_TO_M  = 0.48;         // pixels to metres conversion factor

const camera = { x: 0, y: 0, zoom: 0.67 };

/* =========================================================
    DOM REFERENCES
========================================================= */

const mapContainer = document.getElementById("map-container");

/* =========================================================
    SELECTION STATE
    Tracks which control pair / route is currently active.
========================================================= */

const selection = {
    ncp: 0,
    nr:  null,
};

/* =========================================================
    PAN UTILITY
    Pan is always available as a drag fallback in every tool.
    pan.stop() restores the cursor from the active tool's
    defaultCursor property so tools don't need to track it.
========================================================= */

const pan = (() => {
    let active = false;
    let startX = 0, startY = 0, camX = 0, camY = 0;

    return {
        start(clientX, clientY) {
            active = true;
            startX = clientX;
            startY = clientY;
            camX = camera.x;
            camY = camera.y;
            mapContainer.classList.add("panning");
            mapContainer.style.cursor = "grabbing";
        },
        update(e) {
            if (!active) return false;
            camera.x = camX + (e.clientX - startX);
            camera.y = camY + (e.clientY - startY);
            updateCameraTransform();
            return true;
        },
        stop() {
            if (!active) return false;
            active = false;
            mapContainer.classList.remove("panning");
            mapContainer.style.cursor = activeTool?.defaultCursor ?? "default";
            return true;
        },
        isActive() { return active; },
    };
})();

/* =========================================================
    PENDING GESTURE
    Separates a click from a drag. onDrag receives the
    original mousedown event so each tool can start pan
    or a drag operation anchored at the correct position.
========================================================= */

function makePendingGesture({ threshold = 3, onDrag, onClick }) {
    let pending = null;

    return {
        down(e, pt)  { pending = { e, pt }; },
        move(pt) {
            if (!pending) return false;
            if (Math.hypot(pt.x - pending.pt.x, pt.y - pending.pt.y) > threshold) {
                const saved = pending;
                pending = null;
                onDrag?.(saved.e, saved.pt);
                return true;
            }
            return false;
        },
        up(e, pt) {
            if (!pending) return;
            pending = null;
            onClick?.(e, pt);
        },
        cancel()    { pending = null; },
        isPending() { return pending !== null; },
    };
}

/* =========================================================
    TOOL: CONTROL PAIR
    Left-click selects a control pair.
    Drag on the active pair's circle moves the point.
    Drag on empty space pans.
========================================================= */

const ControlPairTool = (() => {
    let drag = null;

    function startDrag(target, pt) {
        const cp = project.control_pairs[target.ncp];
        if (!cp) return;
        const point = cp[target.pointType];
        drag = {
            controlPair: cp,
            pointType: target.pointType,
            offsetX: point.x - pt.x,
            offsetY: point.y - pt.y,
            originX: point.x,
            originY: point.y,
        };
        mapContainer.classList.add("dragging");
        mapContainer.style.cursor = "grabbing";
    }

    function updateDrag(pt) {
        if (!drag) return;
        let newX = pt.x + drag.offsetX;
        let newY = pt.y + drag.offsetY;
        const snap = findSnapTarget(drag.controlPair, drag.pointType, newX, newY);
        if (snap) { newX = snap.x; newY = snap.y; }
        drag.controlPair[drag.pointType].x = newX;
        drag.controlPair[drag.pointType].y = newY;
        updateControlPairGroup(drag.controlPair);
        updateCrosshair(newX, newY);

        const moved   = Math.hypot(newX - drag.originX, newY - drag.originY);
        const willDel = moved > CP_MOVE_THRESHOLD;
        const ncp     = drag.controlPair.order;
        mapContainer.querySelectorAll(`.route-polyline[data-ncp="${ncp}"], .route-bg[data-ncp="${ncp}"]`)
            .forEach(el => el.setAttribute("opacity", willDel ? "0.2" : "1"));
    }

    function stopDrag() {
        if (!drag) return;
        const cp        = drag.controlPair;
        const pointType = drag.pointType;
        const point     = cp[pointType];
        const moved     = Math.hypot(point.x - drag.originX, point.y - drag.originY);
        drag = null;
        mapContainer.classList.remove("dragging");
        mapContainer.style.cursor = "default";
        hideCrosshair();
        if (moved > CP_MOVE_THRESHOLD) {
            cp.routes = [];
        } else if (cp.routes.length) {
            const isStart = pointType === "start";
            cp.routes.forEach(r => {
                if (!r.rP?.length) return;
                const rpt = isStart ? r.rP[0] : r.rP[r.rP.length - 1];
                rpt.x = point.x;
                rpt.y = point.y;
                calcRouteLength(r);
                calcRouteRunTime(r);
            });
        }
        drawRoutes();
        updateRoutes();
        updateCPList();
    }

    const gesture = makePendingGesture({
        threshold: 0,
        onDrag(downEvent, downPt) {
            const target = getControlPairCircle(downEvent.target);
            if (target && target.ncp === selection.ncp) {
                startDrag(target, downPt);
            } else {
                pan.start(downEvent.clientX, downEvent.clientY);
            }
        },
        onClick(e) {
            clickControlPairGroup(e.target);
        },
    });

    return {
        defaultCursor: "default",
        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("mode-cp");
            selection.nr = null;
            updateRoutes();
        },
        onExit()  {
            mapContainer.classList.remove("mode-cp");
            gesture.cancel();
            stopDrag();
        },
        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseMove(e, pt) {
            if (drag) { updateDrag(pt); return; }
            if (gesture.move(pt)) return;
            const target = e.target;
            const group  = target.closest?.(".control-pair-group");
            if (group) {
                const selected = group.classList.contains("selected");
                if (target.classList?.contains("control-circle")) {
                    mapContainer.style.cursor = selected ? "grab" : "pointer";
                } else {
                    mapContainer.style.cursor = selected ? "default" : "pointer";
                }
            } else {
                mapContainer.style.cursor = "default";
            }
        },
        onMouseUp(e, pt) {
            if (drag) { stopDrag(); return; }
            gesture.up(e, pt);
        },
        onKeyDown(e) {},
    };
})();

/* =========================================================
    TOOL: ROUTE EDIT
    Activated from RouteTool when clicking on an active
    route segment. Adds waypoints on each click.
    Reconnects to the original tail when clicking near it.
    Escape cancels and returns to RouteTool.
========================================================= */

const RouteEditTool = (() => {
    let route        = null;
    let continuation = null;
    let originalPts  = null;
    let previewPt    = null;

    function reset() {
        route = null;
        continuation = null;
        originalPts  = null;
        previewPt    = null;
    }

    function drawPreview() {
        clearEditLayer();
        if (!route || !previewPt) return;
        const prev = route.rP[route.rP.length - 1];
        if (!prev) return;
        const layer = document.getElementById("edit-layer");
        const line  = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", prev.x);      line.setAttribute("y1", prev.y);
        line.setAttribute("x2", previewPt.x); line.setAttribute("y2", previewPt.y);
        line.setAttribute("stroke", "#E53935");
        line.setAttribute("stroke-width", "1");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("vector-effect", "non-scaling-stroke");
        layer.appendChild(line);
    }

    function drawOriginal() {
        if (!originalPts || originalPts.length < 2) return;
        const layer  = document.getElementById("route-layer");
        const points = originalPts.map(p => `${p.x},${p.y}`).join(" ");
        const poly   = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        poly.setAttribute("points", points);
        poly.setAttribute("fill", "none");
        poly.setAttribute("stroke", "rgba(229, 57, 53, 0.67)");
        poly.setAttribute("stroke-width", "1.5");
        poly.setAttribute("stroke-linecap", "round");
        poly.setAttribute("stroke-linejoin", "round");
        poly.setAttribute("vector-effect", "non-scaling-stroke");
        layer.appendChild(poly);
    }

    function snapToZiel(pt) {
        const cp = project.control_pairs.find(c => c.order === selection.ncp);
        if (!cp?.ziel) return pt;
        const dx = pt.x - cp.ziel.x;
        const dy = pt.y - cp.ziel.y;
        if (Math.hypot(dx, dy) <= SNAP_DISTANCE_ROUTE_EDIT) return { x: cp.ziel.x, y: cp.ziel.y };
        return pt;
    }

    function tryReconnect(x, y) {
        if (!continuation || !route) return false;
        for (let i = 0; i < continuation.length - 1; i++) {
            const a = continuation[i];
            const b = continuation[i + 1];
            const result = pointToSegmentDistance(x, y, a.x, a.y, b.x, b.y);
            if (result.distance < 2) {
                route.rP.push({ x: result.closestX, y: result.closestY });
                route.rP.push(...continuation.slice(i + 1));
                activateTool(RouteTool);
                return true;
            }
        }
        return false;
    }

    return {
        defaultCursor: "default",

        // Initialise the edit session. Must be called before activateTool().
        // Returns `this` so callers can write activateTool(RouteEditTool.init(...))
        init(cpOrder, routeOrder, insertPoint, segmentIndex) {
            const cp = project.control_pairs.find(cp => cp.order === cpOrder);
            if (!cp) return this;
            const r = cp.routes.find(r => r.order === routeOrder);
            if (!r) return this;

            route       = r;
            originalPts = structuredClone(r.rP);

            r.rP.splice(segmentIndex + 1, 0, { x: insertPoint.x, y: insertPoint.y });
            continuation = r.rP.slice(segmentIndex + 1);
            r.rP         = r.rP.slice(0, segmentIndex + 2);

            return this;
        },

        onEnter() {
            mapContainer.classList.add("editing-route");
            mapContainer.style.cursor = this.defaultCursor;
            drawRoutes();
            drawOriginal();
            updateRoutes();
        },

        onExit() {
            mapContainer.classList.remove("editing-route");
            clearEditLayer();
            hideCrosshair();
            if (route) { calcRouteLength(route); calcRouteRunTime(route); }
            reset();
            drawRoutes();
            updateRoutes();
            updateCPList();
        },

        onMouseDown(e, pt) {
            const snapped = snapToZiel(pt);
            if (tryReconnect(snapped.x, snapped.y)) return;
            route.rP.push({ x: snapped.x, y: snapped.y });
            calcRouteLength(route);
            drawRoutes();
            drawOriginal();
            updateRoutes();
            updateCPList();
        },

        onMouseMove(e, pt) {
            previewPt = snapToZiel(pt);
            updateCrosshair(previewPt.x, previewPt.y);
            drawPreview();
        },

        onMouseUp(e, pt) {},

        onKeyDown(e) {
            if (e.key === "Escape") activateTool(RouteTool);
        },
    };
})();

/* =========================================================
    TOOL: NEW ROUTE
    Click near cp.start to begin, click to add waypoints,
    click near cp.ziel to complete. Escape cancels.
========================================================= */

const NewRouteTool = (() => {
    let cp        = null;
    let route     = null;
    let previewPt = null;

    const SNAP_START = 25;

    function snapToStartPt(pt) {
        if (!cp?.start) return pt;
        if (Math.hypot(pt.x - cp.start.x, pt.y - cp.start.y) <= SNAP_START)
            return { x: cp.start.x, y: cp.start.y };
        return pt;
    }

    function snapToZielPt(pt) {
        if (!cp?.ziel) return pt;
        if (Math.hypot(pt.x - cp.ziel.x, pt.y - cp.ziel.y) <= SNAP_DISTANCE_ROUTE_EDIT)
            return { x: cp.ziel.x, y: cp.ziel.y };
        return pt;
    }

    function drawPreview() {
        clearEditLayer();
        if (!route?.rP?.length) return;
        const layer = document.getElementById("edit-layer");

        // Partial polyline so far (white bg + red fg)
        if (route.rP.length >= 2) {
            const pts = route.rP.map(p => `${p.x},${p.y}`).join(" ");
            for (const [stroke, width] of [["white", "3"], ["#E53935", "1.5"]]) {
                const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
                poly.setAttribute("points", pts);
                poly.setAttribute("fill", "none");
                poly.setAttribute("stroke", stroke);
                poly.setAttribute("stroke-width", width);
                poly.setAttribute("stroke-linecap", "round");
                poly.setAttribute("stroke-linejoin", "round");
                poly.setAttribute("vector-effect", "non-scaling-stroke");
                layer.appendChild(poly);
            }
        }

        // Preview line to cursor
        if (previewPt) {
            const prev = route.rP[route.rP.length - 1];
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", prev.x); line.setAttribute("y1", prev.y);
            line.setAttribute("x2", previewPt.x); line.setAttribute("y2", previewPt.y);
            line.setAttribute("stroke", "#E53935");
            line.setAttribute("stroke-width", "1");
            line.setAttribute("stroke-linecap", "round");
            line.setAttribute("vector-effect", "non-scaling-stroke");
            layer.appendChild(line);
        }
    }

    function completeRoute() {
        calcRouteLength(route);
        route.elevation = 0;
        calcRouteRunTime(route);
        cp.routes.push(route);
        selection.nr = route.order;
        drawRoutes();
        updateRoutes();
        // Start a fresh route
        route     = { id: null, order: cp.routes.length, rP: [], noA: null, pos: null, length: null, run_time: null, elevation: null };
        previewPt = null;
        clearEditLayer();
        updateCPList();
        requestAnimationFrame(() => {
            document.querySelector(".cp-route-row.selected")
                ?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
    }

    const gesture = makePendingGesture({
        onDrag(downEvent) { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e, pt) {
            if (!cp || !route) return;

            if (route.rP.length === 0) {
                if (!cp.start) return;
                const snappedStart = snapToStartPt(pt);
                if (Math.hypot(snappedStart.x - cp.start.x, snappedStart.y - cp.start.y) > 0.5) return;
                route.rP.push({ x: cp.start.x, y: cp.start.y });
            } else {
                const snapped = snapToZielPt(pt);
                route.rP.push({ x: snapped.x, y: snapped.y });
                if (cp.ziel && Math.hypot(snapped.x - cp.ziel.x, snapped.y - cp.ziel.y) < 1) {
                    completeRoute();
                    return;
                }
            }
            calcRouteLength(route);
            drawPreview();
            updateCPList();
        },
    });

    return {
        defaultCursor: "default",
        getPartialLength() { return route?.length ?? null; },

        init(controlPair) {
            cp        = controlPair;
            route     = { id: null, order: cp.routes.length, rP: [], noA: null, pos: null, length: null, run_time: null, elevation: null };
            previewPt = null;
            return this;
        },

        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("drawing-route");
            updateCPList();
        },

        onExit() {
            gesture.cancel();
            mapContainer.classList.remove("drawing-route");
            clearEditLayer();
            hideCrosshair();
            cp = null; route = null; previewPt = null;
            updateCPList();
        },

        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },

        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            if (!mapContainer.contains(e.target)) {
                hideCrosshair();
                clearEditLayer();
                return;
            }
            previewPt = route?.rP?.length ? snapToZielPt(pt) : snapToStartPt(pt);
            updateCrosshair(previewPt.x, previewPt.y);
            drawPreview();
        },

        onKeyDown(e) {
            if (e.key === "Escape") activateTool(RouteTool);
        },

        isActive() { return activeTool === this; },

        switchCp(controlPair) {
            clearEditLayer();
            hideCrosshair();
            cp        = controlPair;
            route     = { id: null, order: cp.routes.length, rP: [], noA: null, pos: null, length: null, run_time: null, elevation: null };
            previewPt = null;
            updateCPList();
        },
    };
})();

/* =========================================================
    TOOL: ROUTE
    Click a route to select it.
    Click the already-selected route to enter edit mode.
    Drag on empty space pans.
========================================================= */

const RouteTool = (() => {
    function handleClick(target, pt) {
        const obj = getClickedObject(target);
        if (!obj) return;

        if (obj.type === "route") {
            const sameRoute = obj.ncp === selection.ncp && obj.nr === selection.nr;
            if (sameRoute) {
                const editable = findEditableRoutePoint(pt.x, pt.y);
                if (editable) {
                    activateTool(RouteEditTool.init(
                        obj.ncp, obj.nr,
                        editable.insertPoint,
                        editable.segmentIndex
                    ));
                    return;
                }
            }
            selection.ncp = obj.ncp;
            selection.nr  = obj.nr;
            updateControlPairs(obj.ncp);
            updateRoutes();
            return;
        }

        if (obj.type === "control-pair") {
            clickControlPairGroup(obj.element);
            requestAnimationFrame(() => document.querySelector(".cp-route-list")
                ?.scrollIntoView({ block: "center", behavior: "smooth" }));
        }
    }

    const gesture = makePendingGesture({
        onDrag(downEvent)  { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e, pt)     { handleClick(e.target, pt); },
    });

    return {
        defaultCursor: "default",
        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("mode-route");
            updateRoutes();
            updateCPList();
        },
        onExit() {
            mapContainer.classList.remove("mode-route");
            gesture.cancel();
            document.getElementById("ui-layer").innerHTML = "";
            updateRoutes();
            updateCPList();
        },
        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },
        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            const target = e.target;
            if (target.classList?.contains("route-hit")) {
                mapContainer.style.cursor = "pointer";
            } else {
                const group = target.closest?.(".control-pair-group");
                mapContainer.style.cursor = (group && !group.classList.contains("selected")) ? "pointer" : "default";
            }
        },
        onKeyDown(e) {},
    };
})();

/* =========================================================
    TOOL: MASK (stub — drag always pans)
========================================================= */

const MaskTool = (() => {
    const gesture = makePendingGesture({
        onDrag(downEvent) { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e, pt)    { /* TODO */ },
    });
    return {
        defaultCursor: "crosshair",
        onEnter() { mapContainer.style.cursor = this.defaultCursor; },
        onExit()  { gesture.cancel(); },
        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseMove(e, pt) { gesture.move(pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },
        onKeyDown(e) {},
    };
})();

/* =========================================================
    TOOL: BLOCK (stub — drag always pans)
========================================================= */

const BlockTool = (() => {
    const gesture = makePendingGesture({
        onDrag(downEvent) { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e, pt)    { /* TODO */ },
    });
    return {
        defaultCursor: "crosshair",
        onEnter() { mapContainer.style.cursor = this.defaultCursor; },
        onExit()  { gesture.cancel(); },
        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseMove(e, pt) { gesture.move(pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },
        onKeyDown(e) {},
    };
})();

/* =========================================================
    TOOL: VIEW (no active tool — pan/zoom only)
========================================================= */

const ViewTool = (() => {
    const gesture = makePendingGesture({
        onDrag(downEvent) { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e) { clickControlPairGroup(e.target); },
    });
    return {
        defaultCursor: "grab",
        onEnter() { mapContainer.style.cursor = this.defaultCursor; },
        onExit()  { gesture.cancel(); },
        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },
        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            const group = e.target.closest?.(".control-pair-group");
            mapContainer.style.cursor = (group && !group.classList.contains("selected"))
                ? "pointer"
                : "grab";
        },
        onKeyDown(e) {},
    };
})();

/* =========================================================
    TOOL: PLACE CONTROL
    Two-click placement: first click sets start, second sets
    ziel. Then auto-advances to place the next control.
    Escape cancels the in-progress control.
========================================================= */

const PlaceControlTool = (() => {
    let cp          = null;
    let placing     = "start"; // "start" | "ziel"
    let tempStart   = null;
    let isOverwrite = false;
    let savedStart  = null;
    let savedZiel   = null;

    const STROKE = "rgb(160, 51, 240)";
    const SW     = "3";

    function svgEl(tag) { return document.createElementNS("http://www.w3.org/2000/svg", tag); }

    function snapToControlPoints(pt) {
        for (const c of project.control_pairs) {
            if (c === cp) continue;
            for (const field of ["start", "ziel"]) {
                const p = c[field];
                if (!p) continue;
                if (Math.hypot(pt.x - p.x, pt.y - p.y) <= SNAP_DISTANCE_CONTROL_PAIR)
                    return { x: p.x, y: p.y };
            }
        }
        return pt;
    }

    function drawCircleAt(layer, pt) {
        const circle = svgEl("circle");
        circle.setAttribute("cx", pt.x);
        circle.setAttribute("cy", pt.y);
        circle.setAttribute("r",  R_CONTROL);
        circle.setAttribute("fill", "transparent");
        circle.setAttribute("stroke", STROKE);
        circle.setAttribute("stroke-width", SW);
        circle.setAttribute("vector-effect", "non-scaling-stroke");
        layer.appendChild(circle);
    }

    function drawPreview(pt) {
        clearEditLayer();
        const layer = document.getElementById("edit-layer");

        // Cursor circle
        drawCircleAt(layer, pt);

        // Placed start circle + connection line (ziel phase)
        if (placing === "ziel" && tempStart) {
            drawCircleAt(layer, tempStart);

            const dx   = pt.x - tempStart.x;
            const dy   = pt.y - tempStart.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 2 * (R_CONTROL + GAP)) {
                const angle  = Math.atan2(dy, dx);
                const offset = R_CONTROL + GAP;
                const line = svgEl("line");
                line.setAttribute("x1", tempStart.x + Math.cos(angle) * offset);
                line.setAttribute("y1", tempStart.y + Math.sin(angle) * offset);
                line.setAttribute("x2", pt.x - Math.cos(angle) * offset);
                line.setAttribute("y2", pt.y - Math.sin(angle) * offset);
                line.setAttribute("stroke", STROKE);
                line.setAttribute("stroke-width", SW);
                line.setAttribute("vector-effect", "non-scaling-stroke");
                layer.appendChild(line);
            }
        }
    }

    function reset() {
        cp          = null;
        tempStart   = null;
        placing     = "start";
        isOverwrite = false;
        savedStart  = null;
        savedZiel   = null;
    }

    function cancelCurrent() {
        if (!cp) return;
        if (isOverwrite) {
            cp.start = savedStart;
            cp.ziel  = savedZiel;
            clearEditLayer();
            if (cp.start && cp.ziel) drawControlPairGroup(cp);
        } else {
            project.control_pairs = project.control_pairs.filter(c => c !== cp);
            clearEditLayer();
        }
        hideCrosshair();
        reset();
        updateCPList();
    }

    const gesture = makePendingGesture({
        onDrag(downEvent) { pan.start(downEvent.clientX, downEvent.clientY); },
        onClick(e, pt) {
            if (placing === "start") {
                const snapped = snapToControlPoints(pt);
                tempStart = { x: snapped.x, y: snapped.y };
                placing   = "ziel";
                updateCPList();
            } else {
                const snapped = snapToControlPoints(pt);
                cp.start = tempStart;
                cp.ziel  = { x: snapped.x, y: snapped.y };
                if (!isOverwrite) {
                    cp.order = project.control_pairs.length;
                    project.control_pairs.push(cp);
                } else {
                    cp.routes = [];
                }
                clearEditLayer();
                document.getElementById("control-layer")
                    .querySelector(`.control-pair-group[data-ncp="${cp.order}"]`)?.remove();
                drawControlPairGroup(cp);
                drawRoutes();
                updateRoutes();
                updateControlPairs(cp.order);
                const confirmedOrder = cp.order;
                reset();
                const isLast = !project.control_pairs.some(c => c.order > confirmedOrder);
                if (isLast) {
                    startNewPlacement();
                } else {
                    setTool(ToolMode.CONTROL_PAIR);
                }
            }
        },
    });

    return {
        defaultCursor: "default",

        init(controlPair, overwrite = false) {
            reset();
            cp          = controlPair;
            isOverwrite = overwrite;
            if (overwrite) {
                savedStart = cp.start ? { ...cp.start } : null;
                savedZiel  = cp.ziel  ? { ...cp.ziel  } : null;
                document.getElementById("control-layer")
                    .querySelector(`.control-pair-group[data-ncp="${cp.order}"]`)?.remove();
            }
            return this;
        },

        onEnter() {
            mapContainer.style.cursor = this.defaultCursor;
            mapContainer.classList.add("placing-control");
            mapContainer.querySelectorAll(".control-pair-group.selected")
                .forEach(el => el.classList.remove("selected"));
            selection.ncp = -1;
            updateCPList();
        },

        onExit() {
            gesture.cancel();
            mapContainer.classList.remove("placing-control");
            if (cp) cancelCurrent();
            else reset();
        },

        onMouseDown(e, pt) { gesture.down(e, pt); },
        onMouseUp(e, pt)   { gesture.up(e, pt); },

        onMouseMove(e, pt) {
            if (gesture.move(pt)) return;
            if (!mapContainer.contains(e.target)) {
                hideCrosshair();
                clearEditLayer();
                if (placing === "ziel" && tempStart) {
                    drawCircleAt(document.getElementById("edit-layer"), tempStart);
                }
                return;
            }
            const snapped = snapToControlPoints(pt);
            updateCrosshair(snapped.x, snapped.y);
            drawPreview(snapped);
        },

        onKeyDown(e) {
            if (e.key === "Escape") {
                cancelCurrent();
                setTool(ToolMode.CONTROL_PAIR);
            }
        },

        isPlacingZiel() { return placing === "ziel"; },
    };
})();

/* =========================================================
    TOOL REGISTRY
    ToolMode strings must match the data-tool attributes in
    the HTML toolbar segments.
========================================================= */

const ToolMode = {
    CONTROL_PAIR: "control_pair",
    ROUTE:        "route",
    MASK:         "mask",
    BLOCK:        "block",
    NONE:         "no_tool",
};

const TOOLS = {
    [ToolMode.CONTROL_PAIR]: ControlPairTool,
    [ToolMode.ROUTE]:        RouteTool,
    [ToolMode.MASK]:         MaskTool,
    [ToolMode.BLOCK]:        BlockTool,
    [ToolMode.NONE]:         ViewTool,
};

/* =========================================================
    ACTIVE TOOL & TOOL SWITCHER
========================================================= */

let activeTool = ControlPairTool;

function activateTool(toolObj) {
    if (activeTool === toolObj) return;
    activeTool.onExit?.();
    activeTool = toolObj;
    activeTool.onEnter?.();
    mapContainer.style.cursor = toolObj.defaultCursor ?? "default";
    updateSubtoolPanel(currentToolMode);
}

/* =========================================================
    INPUT DISPATCHER
    Pan intercepts move/up at the top level so every tool
    gets pan for free without duplicating the logic.
========================================================= */

function initInput() {
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);
    window.addEventListener("keydown",   onKeyDown);
    window.addEventListener("wheel",     onWheel, { passive: false });
}

function onMouseDown(e) {
    if (!mapContainer.contains(e.target)) return;
    activeTool.onMouseDown(e, screenToWorld(e.clientX, e.clientY));
}

function onMouseMove(e) {
    if (pan.update(e)) return;
    activeTool.onMouseMove(e, screenToWorld(e.clientX, e.clientY));
}

function onMouseUp(e) {
    if (pan.stop()) return;
    activeTool.onMouseUp(e, screenToWorld(e.clientX, e.clientY));
}

function onKeyDown(e) {
    activeTool.onKeyDown?.(e);
}

initInput();
updateCameraTransform();

/* =========================================================
    CONTROL PAIR — DRAW & INTERACT
========================================================= */

function drawControlPairGroup(controlPair) {
    const layer = document.getElementById("control-layer");
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("control-pair-group");
    if (controlPair.order === selection.ncp) group.classList.add("selected");
    group.dataset.ncp = controlPair.order;
    drawControlPair(controlPair, group);
    drawConnection(controlPair, group);
    layer.appendChild(group);
}

function drawControlPair(controlPair, parent) {
    const drawCircle = (point, pointType) => {
        if (!point) return;
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.classList.add("control-circle");
        circle.setAttribute("cx", point.x);
        circle.setAttribute("cy", point.y);
        circle.setAttribute("r", R_CONTROL);
        circle.setAttribute("fill", "transparent");
        circle.setAttribute("stroke", "rgb(160, 51, 240)");
        circle.setAttribute("stroke-width", "3");
        circle.setAttribute("vector-effect", "non-scaling-stroke");
        circle.dataset.ncp  = controlPair.order;
        circle.dataset.type = pointType;
        parent.appendChild(circle);
    };
    drawCircle(controlPair.start, "start");
    drawCircle(controlPair.ziel,  "ziel");
}

function drawConnection(controlPair, parent) {
    if (!controlPair?.start || !controlPair?.ziel) return;
    const { start, ziel } = controlPair;
    const dx   = ziel.x - start.x;
    const dy   = ziel.y - start.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 2 * (R_CONTROL + GAP)) return;

    const angle  = Math.atan2(dy, dx);
    const offset = R_CONTROL + GAP;
    const x1 = start.x + Math.cos(angle) * offset;
    const y1 = start.y + Math.sin(angle) * offset;
    const x2 = ziel.x  - Math.cos(angle) * offset;
    const y2 = ziel.y  - Math.sin(angle) * offset;

    const setLineAttrs = (line, stroke, width) => {
        line.setAttribute("x1", x1);     line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);     line.setAttribute("y2", y2);
        line.setAttribute("stroke", stroke);
        line.setAttribute("stroke-width", width);
        line.setAttribute("fill", "none");
        line.setAttribute("vector-effect", "non-scaling-stroke");
    };

    const hitLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    setLineAttrs(hitLine, "transparent", "12");
    hitLine.setAttribute("pointer-events", "stroke");
    hitLine.dataset.ncp = controlPair.order;
    hitLine.classList.add("hit");

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    setLineAttrs(line, "rgb(160, 51, 240)", "3");
    line.dataset.ncp = controlPair.order;

    drawConnectionArrow(start, ziel, angle, parent);
    parent.appendChild(line);
    parent.appendChild(hitLine);
}

function drawConnectionArrow(start, ziel, angle, parent) {
    const arrowSize  = 15;
    const arrowAngle = Math.PI / 6;
    const midX = (start.x + ziel.x + Math.cos(angle) * arrowSize / 2) / 2;
    const midY = (start.y + ziel.y + Math.sin(angle) * arrowSize / 2) / 2;

    const createLine = (x1, y1, x2, y2) => {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.classList.add("arrow");
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
        line.setAttribute("stroke", "rgb(160, 51, 240)");
        line.setAttribute("stroke-width", "3");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("vector-effect", "non-scaling-stroke");
        return line;
    };

    parent.appendChild(createLine(
        midX, midY,
        midX - Math.cos(angle - arrowAngle) * arrowSize,
        midY - Math.sin(angle - arrowAngle) * arrowSize
    ));
    parent.appendChild(createLine(
        midX, midY,
        midX - Math.cos(angle + arrowAngle) * arrowSize,
        midY - Math.sin(angle + arrowAngle) * arrowSize
    ));
}

function clickControlPairGroup(target) {
    if (!target?.closest) return false;
    const group = target.closest(".control-pair-group");
    if (!group) return false;
    const ncp     = Number(group.dataset.ncp);
    const changed = ncp !== selection.ncp;
    updateControlPairs(ncp);
    updateRoutes();
    if (changed) centerOnControlPair(ncp);
    return true;
}

function updateControlPairs(ncp) {
    mapContainer.querySelectorAll(".control-pair-group.selected")
        .forEach(el => el.classList.remove("selected"));
    const group = mapContainer.querySelector(`.control-pair-group[data-ncp="${ncp}"]`);
    if (!group) return false;
    selection.ncp = Number(ncp);
    const cp = project.control_pairs.find(c => c.order === selection.ncp);
    if (cp) updateControlPairGroup(cp);
    if (group.parentNode) group.parentNode.appendChild(group);
    updateCPList();
    return true;
}

function getControlPairCircle(target) {
    const circle = target?.closest(".control-circle");
    if (!circle) return null;
    return { ncp: Number(circle.dataset.ncp), pointType: circle.dataset.type };
}

/* =========================================================
    ROUTE — DRAW & INTERACT
========================================================= */

function createRoutePolyline(route, {
    stroke = "rgb(160, 51, 240)",
    strokeWidth = 3,
    opacity = 1,
    className = "",
    dataset = {},
    pointerEvents = "none"
} = {}) {
    if (!route?.rP || route.rP.length < 2) return null;
    const points = route.rP.map(p => `${p.x},${p.y}`).join(" ");
    const el = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    el.setAttribute("points", points);
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", stroke);
    el.setAttribute("stroke-width", strokeWidth);
    el.setAttribute("opacity", opacity);
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("vector-effect", "non-scaling-stroke");
    el.setAttribute("pointer-events", pointerEvents);
    if (className) el.classList.add(...className.split(" "));
    Object.entries(dataset).forEach(([k, v]) => { el.dataset[k] = v; });
    return el;
}

function drawRoutes() {
    const layer = document.getElementById("route-layer");
    layer.innerHTML = "";
    if (!project?.control_pairs) return;

    project.control_pairs.forEach(cp => {
        cp.routes.forEach(route => {
            const el = createRoutePolyline(route, {
                stroke: "white", strokeWidth: 3,
                className: "route-bg",
                dataset: { ncp: cp.order, nr: route.order },
            });
            if (el) layer.appendChild(el);
        });
    });

    project.control_pairs.forEach(cp => {
        cp.routes.forEach(route => {
            const el = createRoutePolyline(route, {
                stroke: "black", strokeWidth: 1.5,
                className: "route-polyline",
                dataset: { ncp: cp.order, nr: route.order },
            });
            if (el) layer.appendChild(el);
        });
    });
}

function updateRoutes() {
    mapContainer.querySelectorAll(".route-bg").forEach(el => {
        const isSelectedCp = Number(el.dataset.ncp) === selection.ncp;
        el.setAttribute("stroke", isSelectedCp ? "white" : "transparent");
    });

    mapContainer.querySelectorAll(".route-polyline").forEach(el => {
        const isSelectedCp = Number(el.dataset.ncp) === selection.ncp;
        el.setAttribute("opacity", isSelectedCp ? "1" : "0.1");
        el.setAttribute("stroke", "black");
    });

    // active route rendered on top
    const routeLayer = document.getElementById("route-layer");
    routeLayer.querySelectorAll(".route-active").forEach(el => el.remove());

    const cp    = project.control_pairs.find(cp => cp.order === selection.ncp);
    const route = cp?.routes.find(r => r.order === selection.nr);

    if (route) {
        const bg = createRoutePolyline(route, {
            stroke: "white", strokeWidth: 3,
            className: "route-active",
        });
        const fg = createRoutePolyline(route, {
            stroke: "#E53935", strokeWidth: 1.5,
            className: "route-active",
            dataset: { ncp: cp.order, nr: route.order },
        });
        if (bg) routeLayer.appendChild(bg);
        if (fg) routeLayer.appendChild(fg);
    }

    // transparent hit strips — only needed in route modes
    // active route appended last so its hit area is on top
    if (activeTool === RouteTool || activeTool === RouteEditTool) {
        const hitLayer = document.getElementById("ui-layer");
        hitLayer.innerHTML = "";
        if (!cp) return;
        const inactive = cp.routes.filter(r => r.order !== selection.nr);
        const active   = cp.routes.filter(r => r.order === selection.nr);
        [...inactive, ...active].forEach(r => {
            const hit = createRoutePolyline(r, {
                stroke: "transparent", strokeWidth: 4,
                className: "route-hit",
                pointerEvents: "stroke",
                dataset: { ncp: cp.order, nr: r.order },
            });
            if (hit) hitLayer.appendChild(hit);
        });
    }
}

function getClickedObject(target) {
    if (!target?.closest) return null;

    const route = target.closest(".route-hit");
    if (route) {
        return {
            type: "route",
            ncp:  Number(route.dataset.ncp),
            nr:   Number(route.dataset.nr),
            element: route,
        };
    }

    const group = target.closest(".control-pair-group");
    if (group) {
        return {
            type: "control-pair",
            ncp:  Number(group.dataset.ncp),
            element: group,
        };
    }

    return null;
}

function findEditableRoutePoint(x, y) {
    const cp = project.control_pairs.find(cp => cp.order === selection.ncp);
    if (!cp) return null;
    const route = cp.routes.find(r => r.order === selection.nr);
    if (!route?.rP || route.rP.length < 2) return null;

    for (let i = 0; i < route.rP.length - 1; i++) {
        const a      = route.rP[i];
        const b      = route.rP[i + 1];
        const result = pointToSegmentDistance(x, y, a.x, a.y, b.x, b.y);
        if (result.distance < 2) {
            return {
                route,
                segmentIndex: i,
                insertPoint: { x: result.closestX, y: result.closestY },
            };
        }
    }
    return null;
}

/* =========================================================
    ZOOM
========================================================= */

function onWheel(e) {
    if (!mapContainer.contains(e.target)) return;
    if (e.target.closest("#overview-sidebar")) return;
    e.preventDefault();
    const rect   = mapContainer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const worldX = (mouseX - camera.x) / camera.zoom;
    const worldY = (mouseY - camera.y) / camera.zoom;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    camera.zoom  = Math.max(zoomMin, Math.min(zoomMax, camera.zoom * factor));
    camera.x     = mouseX - worldX * camera.zoom;
    camera.y     = mouseY - worldY * camera.zoom;
    updateCameraTransform();
}

/* =========================================================
    UTILITIES
========================================================= */

function getCSRFToken() {
    return document.querySelector('meta[name="csrf-token"]').getAttribute('content');
}

function screenToWorld(clientX, clientY) {
    const rect = document.getElementById("map-container").getBoundingClientRect();
    return {
        x: (clientX - rect.left - camera.x) / camera.zoom,
        y: (clientY - rect.top  - camera.y) / camera.zoom,
    };
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx    = x2 - x1;
    const dy    = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    const t     = lenSq > 0
        ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
        : 0;
    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;
    return { distance: Math.hypot(px - closestX, py - closestY), closestX, closestY };
}

function clearEditLayer() {
    document.getElementById("edit-layer").innerHTML = "";
}

/* =========================================================
    FILES
========================================================= */

async function loadFiles() {
    if (filesLoadingPromise) return filesLoadingPromise;
    filesLoadingPromise = (async () => {
        try {
            const res  = await fetch('/editor/files/');
            const data = await res.json();
            window.activeTeam = data.active_team;
            projectFiles  = data.files || [];
            filteredFiles = [...projectFiles];
        } catch (err) {
            console.error("Failed to load files:", err);
        } finally {
            filesLoadingPromise = null;
        }
    })();
    return filesLoadingPromise;
}

function loadMap(filename) {
    document.getElementById('map-img').src = `/editor/map/${filename}`;
}

function saveFile()          { alert("Datei speichern (noch nicht implementiert)"); }
function copyFile()          { alert("Datei kopieren (noch nicht implementiert)"); }
function createLabel()       { alert("Label erstellen (noch nicht implementiert)"); }
function uploadSelectedMap() { alert("Map hochladen (noch nicht implementiert)"); }

/* =========================================================
    MODALS
========================================================= */

function closeFileModal() {
    document.getElementById("modal-project").classList.remove("open");
}

function createFile() {
    closeFileModal();
    openMapModal();
}

function openMapModal() {
    document.getElementById("modal-map").classList.add("open");
    initMapUpload();
}

function closeMapModal() {
    document.getElementById("modal-map").classList.remove("open");
}

function initMapUpload() {
    const dropzone = document.getElementById("map-dropzone");
    const input    = document.getElementById("map-file-input");
    if (!dropzone || !input) return;

    input.onchange   = (e) => handleMapFile(e.target.files?.[0]);
    dropzone.ondragover  = (e) => { e.preventDefault(); dropzone.classList.add("dragover"); };
    dropzone.ondragleave = ()  => dropzone.classList.remove("dragover");
    dropzone.ondrop      = (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
        handleMapFile(e.dataTransfer.files?.[0]);
    };
}

function handleMapFile(file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { alert("Datei zu gross (max. 15 MB)"); return; }
    document.getElementById("selected-map-info").style.display = "flex";
    document.querySelector(".selected-map-name").textContent = file.name;
    document.getElementById("upload-map-btn").disabled = false;
}

/* =========================================================
    NAV MENUS
========================================================= */

function initMenus() {
    const menuItems = document.querySelectorAll(".nav-menu-item");
    menuItems.forEach(menu => {
        menu.addEventListener("mouseenter", () => {
            menuItems.forEach(other => { if (other !== menu) other.classList.remove("open"); });
            menu.classList.add("open");
        });
        menu.addEventListener("mouseleave", () => menu.classList.remove("open"));
    });
}

/* =========================================================
    CAMERA
========================================================= */

function updateCameraTransform({ x = camera.x, y = camera.y, zoom = camera.zoom } = {}) {
    camera.x = x; camera.y = y; camera.zoom = zoom;

    document.getElementById("camera").style.transform =
        `translate(${x}px, ${y}px) scale(${zoom})`;

    const bg       = document.getElementById("map-background");
    const major    = 250 * zoom;
    const minor    = 50  * zoom;
    const majorDot = 2   * Math.sqrt(zoom);
    const minorDot = 1.5 * Math.sqrt(zoom);

    bg.style.backgroundSize = `${major}px ${major}px, ${minor}px ${minor}px`;
    bg.style.backgroundImage = `
        radial-gradient(circle, rgba(120,120,120,1) ${majorDot}px, transparent ${majorDot}px),
        radial-gradient(circle, rgba(120,120,120,1) ${minorDot}px, transparent ${minorDot}px)
    `;
    bg.style.backgroundPosition =
        `${x % major}px ${y % major}px, ${x % minor}px ${y % minor}px`;
}

function resetCamera() {
    camera.x = 0; camera.y = 0; camera.zoom = 1;
    updateCameraTransform();
}

function centerMap(imgWidth, imgHeight) {
    const rect  = mapContainer.getBoundingClientRect();
    camera.zoom = 1;
    camera.x    = (rect.width  - imgWidth)  / 2;
    camera.y    = (rect.height - imgHeight) / 2;
    updateCameraTransform();
}

function applyProjectScale() {
    const scaleLayer = document.getElementById("map-scale-layer");
    scaleLayer.style.transform       = `scale(${project.scale || 1})`;
    scaleLayer.style.transformOrigin = "top left";
}

/* =========================================================
    DRAW
========================================================= */

function startNewPlacement() {
    activeSubtool[ToolMode.CONTROL_PAIR] = "add";
    setTool(ToolMode.CONTROL_PAIR);
    activateTool(PlaceControlTool.init(
        { id: null, order: null, start: null, ziel: null, complex: true, routes: [] }
    ));
    requestAnimationFrame(() => document.querySelector(".cp-add-btn")?.scrollIntoView({ block: "nearest" }));
}

function startNewRoute() {
    const cp = project.control_pairs.find(c => c.order === selection.ncp);
    if (!cp) return;
    setTool(ToolMode.ROUTE);
    activateTool(NewRouteTool.init(cp));
}

function addAndPlaceControlPair() {
    const selectedCp = project.control_pairs.find(c => c.order === selection.ncp);
    if (selectedCp) {
        setTool(ToolMode.CONTROL_PAIR);
        activateTool(PlaceControlTool.init(selectedCp, true));
    } else {
        startNewPlacement();
    }
}

function drawCourse() {
    clearCourseLayers();
    if (!project?.control_pairs) return;
    project.control_pairs.forEach(cp => drawControlPairGroup(cp));
    drawRoutes();
    const selectedCp = project.control_pairs.find(c => c.order === selection.ncp);
    if (selectedCp) updateControlPairGroup(selectedCp);
    updateRoutes();
    updateCPList();
}

/* =========================================================
    CP LIST
========================================================= */

function updateCPList() {
    const list = document.getElementById("cp-list");
    if (!list) return;
    list.innerHTML = "";
    if (!project?.control_pairs?.length) return;

    project.control_pairs.forEach(cp => {
        const row = document.createElement("div");
        row.className = "cp-row" + (cp.order === selection.ncp ? " selected" : "");
        row.dataset.ncp = cp.order;

        row.innerHTML = `
            <span class="cp-grip" title="Drag to reorder"></span>
            <span class="cp-row-label">
                <span class="cp-posten-text">Posten ${cp.order + 1}${cp === lastDraggedCp ? `<span class="cp-original-label">${lastDraggedFromOrder + 1}</span>` : ""}</span>
                <span class="cp-route-count">${cp.routes.length} Routen</span>
            </span>
            <div class="cp-row-btns">
                <button class="cp-mode-btn ${cp.complex ? "active" : ""}" data-mode="multi" title="Multi-Route">
                    ${icon("m")}
                </button>
                <button class="cp-mode-btn ${!cp.complex ? "active" : ""}" data-mode="lr" title="Links/Rechts">
                    ${icon("arrows-split", undefined, "scaleY(-1)")}
                </button>
            </div>
            <button class="cp-delete-btn" title="Posten löschen">${icon("trash", "11px")}</button>
        `;

        row.querySelector(".cp-grip").addEventListener("mousedown", e => {
            e.preventDefault();
            e.stopPropagation();
            startCPDrag(e, cp);
        });

        row.addEventListener("click", e => {
            if (e.target.closest(".cp-mode-btn") || e.target.closest(".cp-grip") || e.target.closest(".cp-delete-btn")) return;
            updateControlPairs(cp.order);
            updateRoutes();
            if (activeTool === NewRouteTool) NewRouteTool.switchCp(cp);
            else updateCPList();
            centerOnControlPair(cp.order);
            if (activeTool === RouteTool || activeTool === RouteEditTool || activeTool === NewRouteTool) {
                requestAnimationFrame(() => document.querySelector(".cp-route-list")
                    ?.scrollIntoView({ block: "center", behavior: "smooth" }));
            }
        });

        row.querySelector(".cp-delete-btn").addEventListener("click", e => {
            e.stopPropagation();
            project.control_pairs = project.control_pairs.filter(c => c !== cp);
            project.control_pairs.forEach((c, i) => { c.order = i; });
            if (selection.ncp >= project.control_pairs.length) {
                selection.ncp = Math.max(0, project.control_pairs.length - 1);
            }
            drawCourse();
        });

        row.querySelectorAll(".cp-mode-btn").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                const complex = btn.dataset.mode === "multi";
                if (cp.complex === complex) return;
                if (!complex && cp.routes.length > 2) {
                    const counter = row.querySelector(".cp-route-count");
                    if (counter) {
                        counter.classList.remove("cp-route-count-flash");
                        void counter.offsetWidth;
                        counter.classList.add("cp-route-count-flash");
                    }
                    return;
                }
                cp.complex = complex;
                updateCPList();
            });
        });

        list.appendChild(row);

        // Route sub-list: only for selected CP in route mode
        const inRouteMode = activeTool === RouteTool || activeTool === RouteEditTool || activeTool === NewRouteTool;
        if (inRouteMode && cp.order === selection.ncp) {
            const routeList = document.createElement("div");
            routeList.className = "cp-route-list";

            const validTimes  = cp.routes.map(r => r.run_time).filter(t => t != null);
            const minRuntime  = validTimes.length ? Math.min(...validTimes) : null;

            cp.routes.forEach(route => {
                const rRow = document.createElement("div");
                rRow.className = "cp-route-row" + (route.order === selection.nr ? " selected" : "");

                const length  = route.length  != null ? route.length + "m" : "—";

                let runtimeHtml;
                if (route.run_time == null) {
                    runtimeHtml = `<span class="route-stat">—</span>`;
                } else if (route.run_time === minRuntime) {
                    runtimeHtml = `<span class="route-stat route-runtime-fastest">${route.run_time.toFixed(1)}s</span>`;
                } else {
                    const pct      = Math.round((route.run_time - minRuntime) / minRuntime * 100);
                    const tierCls  = pct < 5 ? "tier-warn" : pct < 10 ? "tier-alert" : "tier-danger";
                    runtimeHtml = `<span class="route-stat ${tierCls}">${route.run_time.toFixed(1)}' <span class="route-runtime-pct">+${pct}%</span></span>`;
                }

                rRow.innerHTML = `
                    <span class="route-name">Route ${route.order + 1}</span>
                    <span class="route-stats">
                        <span class="route-stat route-length">${length}</span>
                        ${runtimeHtml}
                    </span>
                    <label class="route-elevation-label">
                        <input class="route-elevation-input" type="number" min="0" step="1"
                            value="${route.elevation ?? ""}" placeholder="—">
                        <span>Hm</span>
                    </label>
                    <button class="cp-delete-btn" title="Route löschen">${icon("trash", "11px")}</button>
                `;

                rRow.querySelector(".cp-delete-btn").addEventListener("click", e => {
                    e.stopPropagation();
                    cp.routes = cp.routes.filter(r => r !== route);
                    cp.routes.forEach((r, i) => { r.order = i; });
                    if (selection.nr >= cp.routes.length) selection.nr = null;
                    drawRoutes();
                    updateRoutes();
                    updateCPList();
                });

                rRow.addEventListener("click", e => {
                    if (e.target.closest(".route-elevation-input") || e.target.closest(".cp-delete-btn")) return;
                    e.stopPropagation();
                    selection.nr = route.order;
                    updateRoutes();
                    updateCPList();
                });

                const elevInput = rRow.querySelector(".route-elevation-input");

                elevInput.addEventListener("focus", e => { e.target.select(); });

                elevInput.addEventListener("change", e => {
                    e.stopPropagation();
                    const val = e.target.value.trim();
                    const parsed = Number(val);
                    route.elevation = (val === "" || isNaN(parsed)) ? 0 : parsed;
                    calcRouteRunTime(route);
                    updateCPList();
                });

                routeList.appendChild(rRow);
            });

            const newRouteRow = document.createElement("div");
            const isDrawing   = activeTool === NewRouteTool;
            newRouteRow.className = "cp-route-row cp-route-row-new" + (isDrawing ? " drawing" : "");
            const partialLen  = isDrawing ? NewRouteTool.getPartialLength() : null;
            newRouteRow.innerHTML = `
                <span class="route-name">Neue Route</span>
                ${partialLen != null ? `<span class="route-stats"><span class="route-stat route-length">${partialLen}m</span></span>` : ""}
            `;
            newRouteRow.addEventListener("click", e => {
                e.stopPropagation();
                if (activeTool === NewRouteTool) activateTool(RouteTool);
                else startNewRoute();
            });
            routeList.appendChild(newRouteRow);

            list.appendChild(routeList);
        }
    });

    if (activeTool === PlaceControlTool && PlaceControlTool.isPlacingZiel()) {
        const placeholder = document.createElement("div");
        placeholder.className = "cp-row cp-row-pending";
        placeholder.innerHTML = `<span class="cp-row-label">Neuer Posten…</span>`;
        list.appendChild(placeholder);
        requestAnimationFrame(() => placeholder.scrollIntoView({ block: "nearest" }));
    }

    if (currentToolMode !== ToolMode.NONE) {
        const addBtn = document.createElement("button");
        addBtn.className = "cp-add-btn";
        addBtn.innerHTML = `${icon("plus", "0.8em")} Posten`;
        addBtn.addEventListener("click", startNewPlacement);
        list.appendChild(addBtn);
    }
}

/* =========================================================
    CP LIST DRAG-AND-DROP
========================================================= */

let cpDrag              = null;
let cpGhost             = null;
let cpSpacer            = null;
let lastDraggedCp       = null;
let lastDraggedFromOrder = null;

function startCPDrag(e, cp) {
    const selectedCp  = project.control_pairs.find(c => c.order === selection.ncp);
    const list        = document.getElementById("cp-list");
    const draggedRow  = list.querySelector(`.cp-row[data-ncp="${cp.order}"]`);
    const rowH        = draggedRow.offsetHeight;
    const rowW        = draggedRow.offsetWidth;
    const rect        = draggedRow.getBoundingClientRect();
    const grabOffsetX = e.clientX - rect.left;
    const grabOffsetY = e.clientY - rect.top;

    // Ghost follows the mouse
    cpGhost = draggedRow.cloneNode(true);
    Object.assign(cpGhost.style, {
        position:      "fixed",
        width:         rowW + "px",
        pointerEvents: "none",
        opacity:       "0.9",
        zIndex:        "9999",
        boxShadow:     "0 4px 12px rgba(0,0,0,0.5)",
        borderRadius:  "5px",
        left:          e.clientX - grabOffsetX + "px",
        top:           e.clientY - grabOffsetY + "px",
    });
    document.body.appendChild(cpGhost);

    // Spacer reserves the drop slot — insert where the row is, then hide the row
    cpSpacer = document.createElement("div");
    cpSpacer.className = "cp-drag-spacer";
    cpSpacer.style.height = rowH + "px";
    list.insertBefore(cpSpacer, draggedRow);
    draggedRow.style.display = "none";
    list.classList.add("cp-dragging");
    document.body.classList.add("cp-drag-active");

    const initialIndex  = project.control_pairs.indexOf(cp);
    const fromOrder     = cp.order;
    cpDrag = { cp, selectedCp, insertIndex: initialIndex, draggedRow, grabOffsetX, grabOffsetY, fromOrder };
    document.addEventListener("mousemove", onCPDragMove);
    document.addEventListener("mouseup",   onCPDragEnd);
}

function onCPDragMove(e) {
    if (!cpDrag) return;

    cpGhost.style.left = e.clientX - cpDrag.grabOffsetX + "px";
    cpGhost.style.top  = e.clientY - cpDrag.grabOffsetY + "px";

    const list = document.getElementById("cp-list");
    const rows = [...list.querySelectorAll(".cp-row")].filter(r => r.style.display !== "none");

    let insertIndex = rows.length;
    for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { insertIndex = i; break; }
    }

    if (cpDrag.insertIndex === insertIndex) return;
    cpDrag.insertIndex = insertIndex;

    if (cpSpacer.parentNode) cpSpacer.remove();
    if (insertIndex < rows.length) {
        list.insertBefore(cpSpacer, rows[insertIndex]);
    } else {
        list.appendChild(cpSpacer);
    }
}

function onCPDragEnd() {
    if (!cpDrag) return;
    document.removeEventListener("mousemove", onCPDragMove);
    document.removeEventListener("mouseup",   onCPDragEnd);

    if (cpGhost)  { cpGhost.remove();  cpGhost  = null; }
    if (cpSpacer) { cpSpacer.remove(); cpSpacer = null; }
    cpDrag.draggedRow.style.display = "";
    document.getElementById("cp-list").classList.remove("cp-dragging");
    document.body.classList.remove("cp-drag-active");

    const { cp, selectedCp, insertIndex, fromOrder } = cpDrag;
    cpDrag = null;

    if (insertIndex === null) return;

    const arr       = project.control_pairs;
    const fromIndex = arr.indexOf(cp);
    if (fromIndex === -1) return;

    arr.splice(fromIndex, 1);
    arr.splice(insertIndex, 0, cp);
    arr.forEach((c, i) => { c.order = i; });

    if (cp.order !== fromOrder) {
        lastDraggedCp        = cp;
        lastDraggedFromOrder = fromOrder;
    }

    if (selectedCp) selection.ncp = selectedCp.order;

    drawCourse();
    updateCPList();
}


function clearCourseLayers() {
    document.getElementById("control-layer").innerHTML = "";
    document.getElementById("route-layer").innerHTML   = "";
}

function updateControlPairGroup(controlPair) {
    const layer    = document.getElementById("control-layer");
    const oldGroup = layer.querySelector(`.control-pair-group[data-ncp="${controlPair.order}"]`);
    if (!oldGroup) return;
    oldGroup.remove();
    drawControlPairGroup(controlPair);
}

function centerOnControlPair(order) {
    const cp = project.control_pairs.find(cp => cp.order === order);
    if (!cp?.start || !cp?.ziel) return;

    const rect     = document.getElementById("map-container").getBoundingClientRect();
    const minX     = Math.min(cp.start.x, cp.ziel.x);
    const maxX     = Math.max(cp.start.x, cp.ziel.x);
    const minY     = Math.min(cp.start.y, cp.ziel.y);
    const maxY     = Math.max(cp.start.y, cp.ziel.y);
    const dist     = Math.hypot(cp.ziel.x - cp.start.x, cp.ziel.y - cp.start.y);
    const padding  = dist * 0.5;
    const zoomX    = rect.width  / (maxX - minX + padding * 2);
    const zoomY    = rect.height / (maxY - minY + padding * 2);
    const newZoom  = Math.min(Math.max(Math.min(zoomX, zoomY), zoomMin), zoomMax);
    const midX     = (minX + maxX) / 2;
    const midY     = (minY + maxY) / 2;

    animateCamera({
        x:    rect.width  / 2 - midX * newZoom,
        y:    rect.height / 2 - midY * newZoom,
        zoom: newZoom,
    }, 500);
}

function animateCamera(target, duration = 500) {
    const start     = { x: camera.x, y: camera.y, zoom: camera.zoom };
    const startTime = performance.now();

    function step(now) {
        const t = Math.min((now - startTime) / duration, 1);
        const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        updateCameraTransform({
            x:    start.x    + (target.x    - start.x)    * k,
            y:    start.y    + (target.y    - start.y)    * k,
            zoom: start.zoom + (target.zoom - start.zoom) * k,
        });
        if (t < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
}

/* =========================================================
    CROSSHAIR
========================================================= */

function updateCrosshair(x, y) {
    const el = document.getElementById("drag-crosshair");
    if (!el) return;
    el.setAttribute("transform", `translate(${x}, ${y})`);
    el.style.display = "block";
}

function hideCrosshair() {
    const el = document.getElementById("drag-crosshair");
    if (el) el.style.display = "none";
}

/* =========================================================
    ROUTE RUNTIME
========================================================= */

function calcRouteLength(route) {
    const pts = route.rP;
    if (!pts || pts.length < 2) { route.length = 0; return; }
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        total += Math.sqrt(dx * dx + dy * dy) * PX_TO_M;
    }
    route.length = Math.round(total);
}

function calcRouteRunTime(route) {
    const length    = route.length;
    const elevation = route.elevation;
    if (length == null || length === 0 || elevation == null) {
        route.run_time = null;
        return;
    }
    const gradient  = (elevation / length) * 100;
    const gapUp     = 0.0017 * gradient ** 2 + 0.02901 * gradient + 0.99387;
    const gapDown   = 0.0017 * gradient ** 2 - 0.02901 * gradient + 0.99387;
    const adjSpeed  = RUN_SPEED / ((gapUp + gapDown) / 2);
    route.run_time  = length / adjSpeed;
}

/* =========================================================
    SNAP
========================================================= */

function findSnapTarget(draggedControlPair, draggedPointType, x, y) {
    let bestTarget = null;
    let bestDist   = SNAP_DISTANCE_CONTROL_PAIR;

    project.control_pairs.forEach(cp => {
        ["start", "ziel"].forEach(type => {
            const pt = cp[type];
            if (!pt) return;
            if (cp === draggedControlPair && type === draggedPointType) return;
            const dist = Math.hypot(pt.x - x, pt.y - y);
            if (dist < bestDist) { bestDist = dist; bestTarget = { x: pt.x, y: pt.y }; }
        });
    });

    return bestTarget;
}

/* =========================================================
    MAP SPINNER
========================================================= */

function showMapSpinner() {
    const layer   = document.getElementById("ui-layer");
    layer.innerHTML = "";

    const spinner = document.createElementNS("http://www.w3.org/2000/svg", "g");
    spinner.id    = "map-spinner";

    const radii  = [64, 84, 104];
    const speeds = [1, 0.65, 0.38];
    const colors = ["#444", "#666", "#999"];
    const arcs   = [];

    const rect = document.getElementById("map-container").getBoundingClientRect();
    const cx   = (rect.width  / 2 - camera.x) / camera.zoom;
    const cy   = (rect.height / 2 - camera.y) / camera.zoom;

    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x",      -radii[2] - 12);
    bg.setAttribute("y",      -radii[2] - 12);
    bg.setAttribute("width",   2 * radii[2] + 24);
    bg.setAttribute("height",  2 * radii[2] + 24);
    bg.setAttribute("rx",      radii[2] + 10);
    bg.setAttribute("fill",   "#2a2a2a");
    spinner.appendChild(bg);

    radii.forEach((r, i) => {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", 0); circle.setAttribute("cy", 0); circle.setAttribute("r", r);
        circle.setAttribute("fill", "none");
        circle.setAttribute("stroke", colors[i]);
        circle.setAttribute("stroke-width", "5");
        circle.setAttribute("stroke-linecap", "round");
        circle.setAttribute("vector-effect", "non-scaling-stroke");
        const circ = 2 * Math.PI * r;
        circle.setAttribute("stroke-dasharray", `${circ * 0.35} ${circ * 0.65}`);
        arcs.push({ el: circle, speed: speeds[i], offset: i * 0.8 });
        spinner.appendChild(circle);
    });

    spinner.setAttribute("transform", `translate(${cx}, ${cy})`);
    layer.appendChild(spinner);

    let start = null;
    function animate(ts) {
        if (!start) start = ts;
        const elapsed = (ts - start) / 1000;
        arcs.forEach(arc => {
            arc.el.setAttribute("transform",
                `rotate(${(elapsed * arc.speed * 360 + arc.offset * 60) % 360})`
            );
        });
        if (document.getElementById("map-spinner")) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}

function hideMapSpinner() {
    document.getElementById("ui-layer").innerHTML = "";
}

/* =========================================================
    TOOLBAR
========================================================= */

const TOOL_ORDER = [
    ToolMode.CONTROL_PAIR,
    ToolMode.ROUTE,
    ToolMode.MASK,
    ToolMode.BLOCK,
    ToolMode.NONE,
];

let currentToolMode = ToolMode.CONTROL_PAIR;
let currentRotation = 0;

const TOOL_CONFIG = {
    "control_pair": { tx: 42, ty: 0 },
    "route":        { tx: 37, ty: 0 },
    "mask":         { tx: 40, ty: 0 },
    "block":        { tx: 40, ty: 0 },
    "no_tool":      { tx: 40, ty: 0 },
};

const wheel        = document.getElementById("toolbar-wheel");
const subtoolPanel = document.getElementById("subtool-panel");

/* =========================================================
    SUBTOOL STATE
========================================================= */

const SUBTOOL_DEFS = {
    [ToolMode.CONTROL_PAIR]: [
        { id: "drag", icon: "no_tool",        title: "Drag controls" },
        { id: "add",  icon: "circle-xmark-r", title: "Add control pair", transform: "rotate(45deg)" },
    ],
    [ToolMode.ROUTE]: [
        { id: "select", icon: "no_tool", title: "Select route" },
        { id: "new",    icon: "plus",    title: "New route" },
    ],
    [ToolMode.MASK]: [
        { id: "draw",  icon: "pencil",       title: "Draw" },
        { id: "erase", icon: "eraser",       title: "Erase" },
    ],
    [ToolMode.BLOCK]: [
        { id: "line",    icon: "slash",        title: "Line" },
        { id: "polygon", icon: "draw-polygon", title: "Polygon" },
        { id: "erase",   icon: "eraser",       title: "Erase" },
    ],
};

const activeSubtool = {
    [ToolMode.CONTROL_PAIR]: "drag",
    [ToolMode.ROUTE]:        "select",
    [ToolMode.MASK]:         "draw",
    [ToolMode.BLOCK]:        "line",
};

function getSubtool(mode) {
    return activeSubtool[mode] ?? null;
}

function setSubtool(mode, id) {
    activeSubtool[mode] = id;
    updateSubtoolPanel(mode);
}

function updateSubtoolPanel(mode) {
    subtoolPanel.innerHTML = "";
    const defs = SUBTOOL_DEFS[mode];
    if (!defs) return;

    let current;
    if (mode === ToolMode.CONTROL_PAIR) {
        current = activeTool === PlaceControlTool ? activeSubtool[mode] : "drag";
    } else if (mode === ToolMode.ROUTE) {
        current = activeTool === NewRouteTool ? "new" : "select";
    } else {
        current = activeSubtool[mode];
    }

    defs.forEach(def => {
        const btn = document.createElement("button");
        btn.className = "subtool-btn" + (def.id === current ? " active" : "");
        btn.title = def.title;
        btn.innerHTML = icon(def.icon, "18px", def.transform);

        if (mode === ToolMode.CONTROL_PAIR) {
            btn.addEventListener("click", () => {
                if (def.id === "add") {
                    activeSubtool[mode] = "add";
                    startNewPlacement();
                } else {
                    activeSubtool[mode] = "drag";
                    activateTool(ControlPairTool);
                    updateSubtoolPanel(mode);
                }
            });
        } else if (mode === ToolMode.ROUTE) {
            btn.addEventListener("click", () => {
                if (def.id === "new") {
                    startNewRoute();
                } else {
                    activateTool(RouteTool);
                    updateSubtoolPanel(mode);
                }
            });
        } else {
            btn.addEventListener("click", () => setSubtool(mode, def.id));
        }

        subtoolPanel.appendChild(btn);
    });
}

buildToolbar();
setTool(currentToolMode);

function setTool(mode) {
    currentToolMode = mode;
    activateTool(TOOLS[mode] ?? ViewTool);

    document.querySelectorAll(".tool-segment").forEach(seg => {
        const active = seg.dataset.tool === mode;
        seg.classList.toggle("active", active);
        const bg = seg.querySelector(".segment-bg");
        if (bg) bg.style.fill = active ? "#ff9800" : "";
        if (active) seg.parentNode.appendChild(seg);
    });

    const index        = TOOL_ORDER.indexOf(mode);
    const segmentAngle = 360 / TOOL_ORDER.length;
    let targetRotation = (-1 - index) * segmentAngle;
    let delta          = targetRotation - currentRotation;
    delta              = ((delta + 180) % 360 + 360) % 360 - 180;
    currentRotation   += delta;
    wheel.style.transform = `rotate(${currentRotation}deg)`;

    updateLabels();
    updateSubtoolPanel(mode);
    updateCPList();
}

document.querySelectorAll(".tool-segment").forEach(seg => {
    seg.addEventListener("click", () => setTool(seg.dataset.tool));
});

function buildToolbar() {
    const outerR       = 60;
    const innerR       = 20;
    const segmentAngle = 360 / TOOL_ORDER.length;

    document.querySelectorAll(".tool-segment").forEach(seg => {
        const index = Number(seg.dataset.index);
        const bgPath = createDonutSegment(0, 0, innerR, outerR, -segmentAngle / 2, segmentAngle / 2);
        seg.querySelector(".segment-bg").setAttribute("d", bgPath);
        seg.setAttribute("transform", `rotate(${index * segmentAngle})`);
        seg.querySelector(".label-wrap").setAttribute("transform", `rotate(${-index * segmentAngle})`);

        const toolName = seg.dataset.tool;
        const iconDef  = ICONS[toolName];
        const iconPath = seg.querySelector(".tool-icon");
        if (iconDef && iconPath) {
            const [,, W, H] = iconDef.viewBox.split(" ").map(Number);
            const scale = 25 / Math.max(W, H);
            iconPath.setAttribute("d", iconDef.d);
            iconPath.setAttribute("transform", `scale(${scale}) translate(${-W / 2} ${-H / 2})`);
        }
    });
}

function updateLabels() {
    document.querySelectorAll(".tool-segment").forEach(seg => {
        const index        = Number(seg.dataset.index);
        const segmentAngle = 360 / TOOL_ORDER.length;
        const angle        = -(index * segmentAngle) - currentRotation;
        const cfg          = TOOL_CONFIG[seg.dataset.tool];
        if (!cfg) return;
        seg.querySelector(".label-wrap").setAttribute(
            "transform",
            `translate(${cfg.tx} ${cfg.ty}) rotate(${angle})`
        );
    });
}

function polarToCartesian(cx, cy, r, deg) {
    const rad = deg * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function createDonutSegment(cx, cy, innerR, outerR, startDeg, endDeg) {
    const p1       = polarToCartesian(cx, cy, outerR, startDeg);
    const p2       = polarToCartesian(cx, cy, outerR, endDeg);
    const p3       = polarToCartesian(cx, cy, innerR, endDeg);
    const p4       = polarToCartesian(cx, cy, innerR, startDeg);
    const largeArc = endDeg - startDeg <= 180 ? 0 : 1;
    return [
        `M ${p1.x} ${p1.y}`,
        `A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
        `L ${p3.x} ${p3.y}`,
        `A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x} ${p4.y}`,
        "Z",
    ].join(" ");
}
