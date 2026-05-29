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
const SNAP_DISTANCE = 15;
const DRAG_THRESHOLD = 2;
const R_CONTROL = 25;
const GAP = 8;

const camera = { x: 0, y: 0, zoom: 0.67 };

let toolPreview = null;

/* =========================================================
    DOM REFERENCES
========================================================= */

const mapContainer = document.getElementById("map-container");

/* =========================================================
    TOOL MODES
========================================================= */

const ToolMode = {

    CONTROL_PAIR: "control_pair",
    ROUTE: "route",
    MASK: "mask",
    BLOCK: "block",
    NONE: "none",
};

/* =========================================================
    INTERACTION STATES
========================================================= */

const Interaction = {

    NONE: "none",

    PANNING: "panning",

    DRAGGING:
        "dragging",

    EDITING_ROUTE:
        "editing_route",
};

/* =========================================================
    INPUT STATE
========================================================= */

const inputState = {

    // active editor tool
    tool: ToolMode.CONTROL_PAIR,

    // current mouse interaction
    interaction: Interaction.NONE,

    hoveredRoute: null,

    ncp: 0,
    nr: 0,

    drag: null,

    pendingDrag: null,

    routeEdit: {

        route: null,

        continuation: null,

        originalRoute: null,

        insertIndex: null,

        previewPoint: null,
    },

    pan: {

        startX: 0,
        startY: 0,

        camX: 0,
        camY: 0,
    },
};

/* =========================================================
    CENTRAL INPUT HANDLER
========================================================= */
initInput();
updateCameraTransform();

function initInput() {

    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    window.addEventListener("wheel", onWheel, {passive: false});
}

function handleMouseDown(e) {
    if (!mapContainer.contains(e.target)) return;

    const pt = screenToWorld(e.clientX, e.clientY);

    // left mouse only
    //if (e.button !== 0) return;

    // live interactions
    switch (inputState.interaction) {

        case "editing_route":
            handleRouteEditClick(pt);
            return;
    }

    // -------------------------------------------------
    // tool-specific behavior
    // -------------------------------------------------

    switch (inputState.tool) {

        case ToolMode.CONTROL_PAIR:
            handleControlPairToolMouseDown(e, pt);
            return;

        case ToolMode.ROUTE:
            handleRouteToolMouseDown(e, pt);
            return;

        case ToolMode.MASK:
            handleMaskToolMouseDown(e, pt);
            return;

        case ToolMode.BLOCK:
            handleBlockToolMouseDown(e, pt);
            return;
    }
}

function handleControlPairToolMouseDown(e, pt) {

    const dragTarget = getControlPair(e.target);
    
    inputState.pending = {
        startX: pt.x,
        startY: pt.y,

        screenX: e.clientX,
        screenY: e.clientY,

        target: dragTarget,
        clickTarget: e.target
    };
}

function handleRouteToolMouseDown(e, pt) {

    inputState.pending = {
        mode: "route",

        startX: pt.x,
        startY: pt.y,

        screenX: e.clientX,
        screenY: e.clientY,

        clickedObject: getClickedObject(e.target),
        worldPoint: pt
    };
}

function getClickedObject(target) {

    if (!target?.closest) {
        return null;
    }

    // ---------------------------------
    // route
    // ---------------------------------

    const route =
        target.closest(".route-hit");

    if (route) {

        return {
            type: "route",
            ncp: Number(route.dataset.ncp),
            nr: Number(route.dataset.nr),
            element: route
        };
    }

    // ---------------------------------
    // control pair
    // ---------------------------------

    const group =
        target.closest(".control-pair-group");

    if (group) {

        return {
            type: "control-pair",
            ncp: Number(group.dataset.ncp),
            element: group
        };
    }

    return null;
}

function getRoute(target) {
    const route = target?.closest(".route-hit");

    if (!route) {
        return null;
    }

    return {
        ncp: Number(route.dataset.ncp),
        nr: Number(route.dataset.nr)
    };
}

function handleRouteEditClick(pt) {

    // reconnect continuation
    if (tryReconnectEdit(pt.x, pt.y)) {return}

    // normal insertion
    addRoutePoint(pt.x, pt.y);

    drawRoutes();
    drawOriginalEditRoute();
    updateRoutes();
}

function handleMaskMouseDown(e, pt) {
    console.log("later");
}

function handleBlockMouseDown(e, pt) {
    console.log("later");
}

function handleMouseMove(e) {
    const pt = screenToWorld(e.clientX, e.clientY);

    // live interactions take priority
    switch (inputState.interaction) {
        case Interaction.PANNING:
            updatePanning(e);
            return;
        case Interaction.DRAGGING:
            updateDraggingPoint(pt);
            return;
        case Interaction.EDITING_ROUTE:
            updateEditPreview(pt);
            return;
    }

    // delayed interaction start
    if (inputState.pending && inputState.interaction === Interaction.NONE) {
        handlePendingMouseMove(pt, e);
    }

    updateCursor(e.target);
}

function handlePendingMouseMove(pt, e) {
    const dx = pt.x - inputState.pending.startX;
    const dy = pt.y - inputState.pending.startY;

    if (Math.hypot(dx, dy) <= 3) return;

    switch (inputState.tool) {
        case ToolMode.CONTROL_PAIR:
            handleControlPairToolPendingMove(pt, e);
            break;
        case ToolMode.ROUTE:
            handleRouteToolPendingMove(pt, e);
            break;
        case ToolMode.MASK:
        case ToolMode.BLOCK:
            startPanning(inputState.pending.screenX, inputState.pending.screenY);
            break;
    }

    inputState.pending = null;
}

/* =========================================================
    CONTROL PAIR TOOL
========================================================= */

function handleControlPairToolPendingMove(pt, e) {
    if (inputState.pending.target && inputState.pending.target.ncp === inputState.ncp) {
        startDraggingPoint(inputState.pending.target, pt);
    } else {
        startPanning(inputState.pending.screenX, inputState.pending.screenY);
    }
}

/* =========================================================
    ROUTE TOOL
========================================================= */

function handleRouteToolPendingMove(pt, e) {
    // no draggable elements in route tool — always pan
    startPanning(inputState.pending.screenX, inputState.pending.screenY);
}

/* =========================================================
    MASK TOOL
========================================================= */

function handleMaskToolPendingMove(pt, e) {
    console.log("mask drag — later");
}

/* =========================================================
    BLOCK TOOL
========================================================= */

function handleBlockToolPendingMove(pt, e) {
    console.log("block drag — later");
}

function handleMouseUp(e) {
    const pending = inputState.pending;

    // live interactions take priority
    if (inputState.interaction === Interaction.PANNING) {
        stopPanning();
        inputState.pending = null;
        return;
    }

    if (inputState.interaction === Interaction.DRAGGING) {
        stopDraggingPoint();
        inputState.pending = null;
        return;
    }

    // only handle clicks (no drag occurred)
    if (pending && inputState.interaction === Interaction.NONE) {
        switch (inputState.tool) {
            case ToolMode.CONTROL_PAIR:
                handleControlPairToolMouseUp(e, pending);
                break;
            case ToolMode.ROUTE:
                handleRouteToolMouseUp(e, pending);
                break;
            case ToolMode.MASK:
                handleMaskToolMouseUp(e, pending);
                break;
            case ToolMode.BLOCK:
                handleBlockToolMouseUp(e, pending);
                break;
        }
    }

    inputState.pending = null;
}

/* =========================================================
    CONTROL PAIR TOOL
========================================================= */

function handleControlPairToolMouseUp(e, pending) {
    clickControlPairGroup(pending.clickTarget);
}

/* =========================================================
    ROUTE TOOL
========================================================= */

function handleRouteToolMouseUp(e, pending) {
    const obj = pending.clickedObject;
    if (!obj) return;

    switch (obj.type) {

        case "route":
            handleRouteClick(obj, pending);
            break;

        case "control-pair":
            clickControlPairGroup(obj.element);
            break;
    }
}

function handleRouteClick(obj, pending) {
    const sameRoute = obj.ncp === inputState.ncp && obj.nr === inputState.nr;

    if (sameRoute) {
        const pt = pending.worldPoint;
        const editTarget = findEditableRoutePoint(pt.x, pt.y);

        if (editTarget) {
            enterRouteEditMode(obj.ncp, obj.nr, editTarget.insertPoint, editTarget.segmentIndex);
            return;
        }
    }

    // select route
    inputState.ncp = obj.ncp;
    inputState.nr = obj.nr;
    updateControlPairs(obj.ncp);
    updateRoutes();
}

/* =========================================================
    MASK TOOL
========================================================= */

function handleMaskToolMouseUp(e, pending) {
    console.log("mask click — later");
}

/* =========================================================
    BLOCK TOOL
========================================================= */

function handleBlockToolMouseUp(e, pending) {
    console.log("block click — later");
}

// enter pan mode
function startPanning(clientX, clientY) {

    inputState.interaction = Interaction.PANNING;

    inputState.pan.startX = clientX;
    inputState.pan.startY = clientY;

    inputState.pan.camX = camera.x;
    inputState.pan.camY = camera.y;

    mapContainer.classList.add("panning");

    updateCursor();
}

// live pan
function updatePanning(e) {

    camera.x =
        inputState.pan.camX +
        (e.clientX - inputState.pan.startX);

    camera.y =
        inputState.pan.camY +
        (e.clientY - inputState.pan.startY);
        
    updateCameraTransform();
}


// exit oan mode
function stopPanning() {

    if (
        inputState.interaction !== Interaction.PANNING
    ) {
        return;
    }

    inputState.interaction = Interaction.NONE;

    mapContainer.classList.remove("panning");

    updateCursor();
}

// zoom function
function onWheel(e) {
    e.preventDefault();

    const rect = mapContainer.getBoundingClientRect();

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Mouse position in world coordinates before zoom
    const worldX = (mouseX - camera.x) / camera.zoom;
    const worldY = (mouseY - camera.y) / camera.zoom;

    // Zoom direction
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;

    // Apply zoom with limits
    camera.zoom = Math.max(
        zoomMin,
        Math.min(zoomMax, camera.zoom * zoomFactor)
    );

    // Keep mouse position fixed during zoom
    camera.x = mouseX - worldX * camera.zoom;
    camera.y = mouseY - worldY * camera.zoom;

    updateCameraTransform();
}

/*_________________________MANUAL__________________________________*/

// draw group
function drawControlPairGroup(controlPair) {
    const layer = document.getElementById("control-layer");
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("control-pair-group");
    if (controlPair.order === inputState.ncp) {
        group.classList.add("selected");
    }
    group.dataset.ncp = controlPair.order;

    drawControlPair(controlPair, group);
    drawConnection(controlPair, group);

    layer.appendChild(group);
}

//draw control pair circles
function drawControlPair(controlPair, parent) {

    const drawCircle = (point, pointType) => {

        if (!point) return;

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");

        // draw attributes
        circle.classList.add("control-circle");

        circle.setAttribute("cx", point.x);
        circle.setAttribute("cy", point.y);
        circle.setAttribute("r", R_CONTROL);
        circle.setAttribute("fill", "transparent");
        circle.setAttribute("stroke", "rgb(160, 51, 240)");
        circle.setAttribute("stroke-width", "3");
        circle.setAttribute("vector-effect", "non-scaling-stroke");

        //data
        circle.dataset.ncp = controlPair.order;
        circle.dataset.type = pointType;

        parent.appendChild(circle);
    };

    drawCircle(controlPair.start, "start");
    drawCircle(controlPair.ziel, "ziel");
}

//draw control pair connection line
function drawConnection(controlPair, parent) {
    if (!controlPair?.start || !controlPair?.ziel) return;

    const { start, ziel } = controlPair;
    const dx = ziel.x - start.x;
    const dy = ziel.y - start.y;
    const dist = Math.hypot(dx, dy);

    //don't draw line if too short
    if (dist <= 2 * (R_CONTROL + GAP)) return;

    const angle = Math.atan2(dy, dx);
    const offset = R_CONTROL + GAP;
    const x1 = start.x + Math.cos(angle) * offset;
    const y1 = start.y + Math.sin(angle) * offset;
    const x2 = ziel.x - Math.cos(angle) * offset;
    const y2 = ziel.y - Math.sin(angle) * offset;

    const setLineAttrs = (line, stroke, width) => {
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
        line.setAttribute("stroke", stroke);
        line.setAttribute("stroke-width", width);
        line.setAttribute("fill", "none");
        line.setAttribute("vector-effect", "non-scaling-stroke");
    };

    const hitLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    setLineAttrs(hitLine, "transparent", "12")
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

// draw direction indicator for active control
function drawConnectionArrow(start, ziel, angle, parent) {
    const arrowSize = 15;
    const arrowAngle = Math.PI / 6;
    const midX = (start.x + ziel.x + Math.cos(angle) * arrowSize / 2) / 2;
    const midY = (start.y + ziel.y + Math.sin(angle) * arrowSize / 2) / 2;

    const createLine = (x1, y1, x2, y2) => {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.classList.add("arrow")
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
        line.setAttribute("stroke", "rgb(160, 51, 240)");
        line.setAttribute("stroke-width", "3");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("vector-effect", "non-scaling-stroke");
        return line;
    };

    parent.appendChild(createLine(midX, midY, midX - Math.cos(angle - arrowAngle) * arrowSize, midY - Math.sin(angle - arrowAngle) * arrowSize));
    parent.appendChild(createLine(midX, midY, midX - Math.cos(angle + arrowAngle) * arrowSize, midY - Math.sin(angle + arrowAngle) * arrowSize));
}

// click control pair on map
function clickControlPairGroup(target) {

    if (!target?.closest) {return false;}

    const group = target.closest(".control-pair-group");

    if (!group) {return false;}

    const ncp = Number(group.dataset.ncp);

    const changed = ncp !== inputState.ncp;
    
    updateControlPairs(ncp);
    updateRoutes();

    if (changed) {centerOnControlPair(ncp);}

    return true;
}

// update selected control pair
function updateControlPairs(ncp) {

    mapContainer.querySelectorAll(".control-pair-group.selected")
        .forEach(el => el.classList.remove("selected"));

    const group = mapContainer.querySelector(
        `.control-pair-group[data-ncp="${ncp}"]`
    );

    if (!group) return false;

    inputState.ncp = Number(ncp);

    updateControlPairGroup(project.control_pairs[ncp]);

    return true;
}

// base function to draw routes
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

    Object.entries(dataset).forEach(([k, v]) => {
        el.dataset[k] = v;
    });

    return el;
}

// draw all routes
function drawRoutes() {
    const layer = document.getElementById("route-layer");

    layer.innerHTML = "";

    if (!project?.control_pairs) return;

    // background
    project.control_pairs.forEach(cp => {
        cp.routes.forEach(route => {

            const el = createRoutePolyline(route, {
                stroke: "white",
                strokeWidth: 2.5,
                className: "route-bg",
                dataset: {
                    ncp: cp.order,
                    nr: route.order,
                }
            });

            if (el) layer.appendChild(el);
        });
    });

    // routes
    project.control_pairs.forEach(cp => {
        cp.routes.forEach(route => {

            const el = createRoutePolyline(route, {
                stroke: "black",
                strokeWidth: 1.5,
                className: "route-polyline",
                dataset: {
                    ncp: cp.order,
                    nr: route.order,
                }
            });

            if (el) layer.appendChild(el);
        });
    });
}

// reaction when clicking a route on map
function clickRoute(target) {

    if (!target?.closest) {
        return null;
    }

    const route =
        target.closest(".route-hit");

    if (!route) {
        return null;
    }

    const ncp =
        Number(route.dataset.ncp);

    const nr =
        Number(route.dataset.nr);

    const changed =
        ncp !== inputState.ncp ||
        nr !== inputState.nr;

    if (changed) {

        inputState.ncp = ncp;
        inputState.nr = nr;

        updateControlPairs(ncp);
        updateRoutes();
    }

    return {
        ncp,
        nr,
        changed
    };
}

// show relevant routes
function updateRoutes() {

    // backgrounds
    mapContainer.querySelectorAll(".route-bg").forEach(el => {

        const isSelectedCp =
            Number(el.dataset.ncp) === inputState.ncp;

        el.setAttribute(
            "stroke",
            isSelectedCp ? "white" : "transparent"
        );
    });

    // normal route appearance
    mapContainer.querySelectorAll(".route-polyline").forEach(el => {

        const isSelectedCp =
            Number(el.dataset.ncp) === inputState.ncp;

        el.setAttribute(
            "opacity",
            isSelectedCp ? "1" : "0.1"
        );

        el.setAttribute("stroke", "black");
    });

    // draw active route ON TOP
    const routeLayer =
        document.getElementById("route-layer");

    routeLayer.querySelectorAll(".route-active")
        .forEach(el => el.remove());

    const cp = project.control_pairs.find(
        cp => cp.order === inputState.ncp
    );

    const route = cp?.routes.find(
        r => r.order === inputState.nr
    );

    if (route) {

        const active = createRoutePolyline(route, {
            stroke: "yellow",
            strokeWidth: 1.5,
            className: "route-active",
            dataset: {
                ncp: cp.order,
                nr: route.order
            }
        });

        if (active) {
            routeLayer.appendChild(active);
        }
    }

    // hit layer
    if (inputState.tool === "route") {
        const hitlayer =
            document.getElementById("ui-layer");

        hitlayer.innerHTML = "";

        if (!cp) return;

        cp.routes.forEach(route => {

            const hit = createRoutePolyline(route, {
                stroke: "transparent",
                strokeWidth: 6,
                className: "route-hit",
                pointerEvents: "stroke",
                dataset: {
                    ncp: cp.order,
                    nr: route.order
                }
            });

            if (hit) {
                hitlayer.appendChild(hit);
            }
        });
    }
}

//start dragging mode of a control pair
function startDraggingPoint(target, pt) {

    const controlPair = project.control_pairs[target.ncp];

    if (!controlPair) return;

    const point = controlPair[target.pointType];

    inputState.interaction = Interaction.DRAGGING;

    inputState.drag = {
        controlPair,
        pointType: target.pointType,
        offsetX: point.x - pt.x,
        offsetY: point.y - pt.y,
    };

    mapContainer.classList.add("dragging");

    updateCursor();
}

// live update for the dragging control pair
function updateDraggingPoint(pt) {

    const drag = inputState.drag;

    if (!drag) return;

    let newX = pt.x + drag.offsetX;
    let newY = pt.y + drag.offsetY;

    const snap = findSnapTarget(
        drag.controlPair,
        drag.pointType,
        newX,
        newY
    );

    if (snap) {
        newX = snap.x;
        newY = snap.y;
    }

    drag.controlPair[drag.pointType].x = newX;
    drag.controlPair[drag.pointType].y = newY;

    updateControlPairGroup(drag.controlPair);

    updateCrosshair(newX, newY);
}

// exit dragging mode
function stopDraggingPoint() {

    inputState.interaction =
        Interaction.NONE;

    inputState.drag = null;

    mapContainer.classList.remove("dragging");

    hideCrosshair();

    updateCursor();
}

/*________________________________________*/

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
        y: (clientY - rect.top - camera.y) / camera.zoom
    };
}

/* =========================================================
    FILES
========================================================= */

async function loadFiles() {
    if (filesLoadingPromise) return filesLoadingPromise;
    filesLoadingPromise = (async () => {
        try {
            const res = await fetch('/editor/files/');
            const data = await res.json();
            window.activeTeam = data.active_team;
            projectFiles = data.files || [];
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

function saveFile() { alert("Datei speichern (noch nicht implementiert)"); }
function copyFile() { alert("Datei kopieren (noch nicht implementiert)"); }
function createLabel() { alert("Label erstellen (noch nicht implementiert)"); }
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
    const input = document.getElementById("map-file-input");
    if (!dropzone || !input) return;

    input.onchange = (e) => handleMapFile(e.target.files?.[0]);
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add("dragover"); };
    dropzone.ondragleave = () => dropzone.classList.remove("dragover");
    dropzone.ondrop = (e) => {
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
    camera.x = x;
    camera.y = y;
    camera.zoom = zoom;

    document.getElementById("camera").style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;

    const bg = document.getElementById("map-background");
    const major = 250 * zoom;
    const minor = 50 * zoom;
    const majorDot = 2 * Math.sqrt(zoom);
    const minorDot = 1.5 * Math.sqrt(zoom);

    bg.style.backgroundSize = `${major}px ${major}px, ${minor}px ${minor}px`;
    bg.style.backgroundImage = `
        radial-gradient(circle, rgba(120,120,120,1) ${majorDot}px, transparent ${majorDot}px),
        radial-gradient(circle, rgba(120,120,120,1) ${minorDot}px, transparent ${minorDot}px)
    `;
    bg.style.backgroundPosition = `${x % major}px ${y % major}px, ${x % minor}px ${y % minor}px`;
}

function resetCamera() {
    camera.x = 0; camera.y = 0; camera.zoom = 1;
    updateCameraTransform();
}

function centerMap(imgWidth, imgHeight) {
    const rect = mapContainer.getBoundingClientRect();
    camera.zoom = 1;
    camera.x = (rect.width - imgWidth) / 2;
    camera.y = (rect.height - imgHeight) / 2;
    updateCameraTransform();
}

function applyProjectScale() {
    const scaleLayer = document.getElementById("map-scale-layer");
    scaleLayer.style.transform = `scale(${project.scale || 1})`;
    scaleLayer.style.transformOrigin = "top left";
}

/* =========================================================
    DRAW
========================================================= */

// init
function drawCourse() {
    clearCourseLayers();
    if (!project?.control_pairs) return;
    project.control_pairs.forEach(controlPair => drawControlPairGroup(controlPair));
    drawRoutes();
    updateControlPairGroup(project.control_pairs[inputState.ncp]);
    updateRoutes();
}

function clearCourseLayers() {
    document.getElementById("control-layer").innerHTML = "";
    document.getElementById("route-layer").innerHTML = "";
}

function updateControlPairGroup(controlPair) {
    const layer = document.getElementById("control-layer");
    const oldGroup = layer.querySelector(`.control-pair-group[data-ncp="${controlPair.order}"]`);

    if (!oldGroup) return;

    oldGroup.remove();
    drawControlPairGroup(controlPair);
}

function centerOnControlPair(order) {
    const cp = project.control_pairs.find(cp => cp.order === order);
    if (!cp || !cp.start || !cp.ziel) return;

    const rect = document.getElementById('map-container').getBoundingClientRect();

    const minX = Math.min(cp.start.x, cp.ziel.x);
    const maxX = Math.max(cp.start.x, cp.ziel.x);
    const minY = Math.min(cp.start.y, cp.ziel.y);
    const maxY = Math.max(cp.start.y, cp.ziel.y);

    const worldW = maxX - minX;
    const worldH = maxY - minY;
    const dist = Math.hypot(cp.ziel.x - cp.start.x, cp.ziel.y - cp.start.y);

    // padding is 40% of the control pair distance in world units
    const worldPadding = dist * 0.5;

    const zoomX = rect.width / (worldW + worldPadding * 2);
    const zoomY = rect.height / (worldH + worldPadding * 2);
    const clampedZoom = Math.min(Math.max(Math.min(zoomX, zoomY), zoomMin), zoomMax);

    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const newX = rect.width / 2 - midX * clampedZoom;
    const newY = rect.height / 2 - midY * clampedZoom;

    animateCamera({
        x: newX,
        y: newY,
        zoom: clampedZoom
    }, 500);
}

function animateCamera(target, duration = 500) {

    const start = {
        x: camera.x,
        y: camera.y,
        zoom: camera.zoom
    };

    const startTime = performance.now();

    function step(now) {

        const t = Math.min(
            (now - startTime) / duration,
            1
        );

        // ease in/out
        const k =
            t < 0.5
                ? 2 * t * t
                : 1 - Math.pow(-2 * t + 2, 2) / 2;

        updateCameraTransform({
            x: start.x + (target.x - start.x) * k,
            y: start.y + (target.y - start.y) * k,
            zoom: start.zoom + (target.zoom - start.zoom) * k
        });

        if (t < 1) {
            requestAnimationFrame(step);
        }
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
    const g = document.getElementById("drag-crosshair");
    if (g) g.style.display = "none";
}

/* =========================================================
    SNAP
========================================================= */

function findSnapTarget(draggedControlPair, draggedPointType, x, y) {

    let bestTarget = null;

    let bestDist = SNAP_DISTANCE;

    project.control_pairs.forEach(cp => {

        ["start", "ziel"].forEach(type => {

            const pt = cp[type];

            if (!pt) return;

            // ignore currently dragged point
            if (
                cp === draggedControlPair &&
                type === draggedPointType
            ) {
                return;
            }

            const dist = Math.hypot(
                pt.x - x,
                pt.y - y
            );

            if (dist < bestDist) {

                bestDist = dist;

                bestTarget = {
                    x: pt.x,
                    y: pt.y
                };
            }
        });
    });

    return bestTarget;
}

function showMapSpinner() {
    const layer = document.getElementById('ui-layer');
    layer.innerHTML = '';

    const spinner = document.createElementNS("http://www.w3.org/2000/svg", "g");
    spinner.id = 'map-spinner';

    const radii = [64, 84, 104];
    const speeds = [1, 0.65, 0.38];
    const colors = ['#444', '#666', '#999'];
    const arcs = [];

    const rect = document.getElementById('map-container').getBoundingClientRect();
    const cx = (rect.width / 2 - camera.x) / camera.zoom;
    const cy = (rect.height / 2 - camera.y) / camera.zoom;
    spinner.setAttribute('transform', `translate(${cx}, ${cy})`);

    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", -radii[2]-12);
    bg.setAttribute("y", -radii[2]-12);
    bg.setAttribute("width", 2*radii[2]+24);
    bg.setAttribute("height", 2*radii[2]+24);
    bg.setAttribute("rx", radii[2]+10);
    bg.setAttribute("fill", "#2a2a2a");
    spinner.appendChild(bg);

    radii.forEach((r, i) => {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", 0);
        circle.setAttribute("cy", 0);
        circle.setAttribute("r", r);
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

    spinner.setAttribute('transform', `translate(${cx}, ${cy})`);
    layer.appendChild(spinner);

    let start = null;

    function animate(ts) {
        if (!start) start = ts;
        const elapsed = (ts - start) / 1000;
        arcs.forEach(arc => {
            const angle = (elapsed * arc.speed * 360 + arc.offset * 60) % 360;
            arc.el.setAttribute('transform', `rotate(${angle})`);
        });
        if (document.getElementById('map-spinner')) {
            requestAnimationFrame(animate);
        }
    }

    requestAnimationFrame(animate);
}

function hideMapSpinner() {
    document.getElementById('ui-layer').innerHTML = '';
}

function enterRouteEditMode(
    cpOrder,
    routeOrder,
    insertPoint,
    segmentIndex
) {

    inputState.interaction = Interaction.EDITING_ROUTE;
    document.getElementById('map-container').classList.add('editing-route');
    
    const cp = project.control_pairs.find(
        cp => cp.order === cpOrder
    );

    if (!cp) return;

    const route = cp.routes.find(
        r => r.order === routeOrder
    );

    if (!route) return;

    inputState.routeEdit.route = route;

    inputState.routeEdit.originalRoute =
        structuredClone(route.rP);

    route.rP.splice(
        segmentIndex + 1,
        0,
        {
            x: insertPoint.x,
            y: insertPoint.y
        }
    );

    inputState.routeEdit.continuation =
        route.rP.slice(segmentIndex + 1);

    route.rP =
        route.rP.slice(0, segmentIndex + 2);

    inputState.routeEdit.insertIndex =
        route.rP.length - 1;

    drawRoutes();
    drawOriginalEditRoute();
    updateRoutes();
}

function updateEditPreview(pt) {

    inputState.routeEdit.previewPoint = pt;

    drawEditPreview();
}

function exitRouteEditMode() {

    inputState.tool = ToolMode.ROUTE;
    inputState.interaction = Interaction.NONE;
    
    document.getElementById('map-container').classList.remove('editing-route');

    inputState.routeEdit.route = null;
    inputState.routeEdit.continuation = null;
    inputState.routeEdit.previewPoint = null;
    inputState.routeEdit.originalRoute = null;
    inputState.routeEdit.insertIndex = null;

    clearEditLayer();

    drawRoutes();
    updateRoutes();

    updateCursor();
}

function updateCursor() {

    if (inputState.interaction === Interaction.PANNING) {
        mapContainer.style.cursor = "grabbing";
        return;
    }

    if (inputState.interaction === Interaction.DRAGGING) {
        mapContainer.style.cursor = "grabbing";
        return;
    }

    if (inputState.tool === ToolMode.ROUTE) {
        mapContainer.style.cursor = "crosshair";
        return;
    }

    mapContainer.style.cursor = "default";
}

function getControlPair(target) {

    const circle =
        target?.closest(".control-circle");

    if (!circle) return null;

    return {
        ncp: Number(circle.dataset.ncp),
        pointType: circle.dataset.type
    };
}

function findClickedSelectedRoute(x, y) {

    const cp = project.control_pairs.find(
        cp => cp.order === inputState.selectedControlPair
    );

    if (!cp) return null;

    const route = cp.routes.find(
        r => r.order === inputState.selectedRoute
    );

    if (!route) return null;

    if (!route.rP || route.rP.length < 2) return null;

    const HIT_DISTANCE = 8 / camera.zoom;

    let best = null;
    let bestDist = HIT_DISTANCE;

    for (let i = 0; i < route.rP.length - 1; i++) {

        const p1 = route.rP[i];
        const p2 = route.rP[i + 1];

        const dist = distancePointToSegment(
            x,
            y,
            p1.x,
            p1.y,
            p2.x,
            p2.y
        );

        if (dist < bestDist) {

            bestDist = dist;

            best = {
                route,
                segmentIndex: i,
            };
        }
    }

    return best;
}

function distancePointToSegment(px, py, x1, y1, x2, y2) {

    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {
        return Math.hypot(px - x1, py - y1);
    }

    const t = Math.max(
        0,
        Math.min(
            1,
            (
                ((px - x1) * dx + (py - y1) * dy) /
                (dx * dx + dy * dy)
            )
        )
    );

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    return Math.hypot(
        px - projX,
        py - projY
    );
}

function clearEditLayer() {
    document.getElementById("edit-layer").innerHTML = "";
}

function drawEditPreview() {

    clearEditLayer();

    const route = inputState.routeEdit.route;
    const preview = inputState.routeEdit.previewPoint;

    if (!route || !preview) return;

    const prev =
        route.rP[route.rP.length - 1];

    if (!prev) return;

    const layer =
        document.getElementById("edit-layer");

    const line =
        document.createElementNS(
            "http://www.w3.org/2000/svg",
            "line"
        );

    line.setAttribute("x1", prev.x);
    line.setAttribute("y1", prev.y);

    line.setAttribute("x2", preview.x);
    line.setAttribute("y2", preview.y);

    line.setAttribute("stroke", "yellow");
    line.setAttribute("stroke-width", "1");
    line.setAttribute("stroke-linecap", "round");

    line.setAttribute(
        "vector-effect",
        "non-scaling-stroke"
    );

    layer.appendChild(line);
}

function tryReconnectEdit(x, y) {

    const continuation = inputState.routeEdit.continuation;

    const route = inputState.routeEdit.route;

    if (!continuation || !route) {return false;}

    for (
        let i = 0;
        i < continuation.length - 1;
        i++
    ) {

        const a = continuation[i];
        const b = continuation[i + 1];

        const result =
            pointToSegmentDistance(
                x,
                y,
                a.x,
                a.y,
                b.x,
                b.y
            );

        if (result.distance < 2) {

            // reconnect point on segment
            route.rP.push({
                x: result.closestX,
                y: result.closestY
            });

            // append remaining continuation
            route.rP.push(
                ...continuation.slice(i + 1)
            );

            exitRouteEditMode();

            return true;
        }
    }

    return false;
}

function addRoutePoint(x, y) {

    const route = inputState.routeEdit.route;

    if (!route) return;

    route.rP.push({ x, y });
}

function findEditableRoutePoint(x, y) {

    const cp = project.control_pairs.find(
        cp => cp.order === inputState.ncp
    );

    if (!cp) return null;

    const route = cp.routes.find(
        r => r.order === inputState.nr
    );

    if (!route) return null;

    const rP = route.rP;

    for (let i = 0; i < rP.length - 1; i++) {

        const a = rP[i];
        const b = rP[i + 1];

        const result = pointToSegmentDistance(
            x, y,
            a.x, a.y,
            b.x, b.y
        );

        if (result.distance < 2) {

            return {
                route,
                segmentIndex: i,
                insertPoint: {
                    x: result.closestX,
                    y: result.closestY
                }
            };
        }
    }

    return null;
}

function pointToSegmentDistance(
    px, py,
    x1, y1,
    x2, y2
) {

    const dx = x2 - x1;
    const dy = y2 - y1;

    const lenSq = dx * dx + dy * dy;

    let t = 0;

    if (lenSq > 0) {
        t = (
            ((px - x1) * dx + (py - y1) * dy)
            / lenSq
        );
    }

    t = Math.max(0, Math.min(1, t));

    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;

    const dist = Math.hypot(
        px - closestX,
        py - closestY
    );

    return {
        distance: dist,
        closestX,
        closestY,
    };
}


// draw old route in route editor
function drawOriginalEditRoute() {

    if (
        inputState.tool !== ToolMode.ROUTE
    ) return;

    const original =
        inputState.routeEdit.originalRoute;

    if (!original || original.length < 2) {
        return;
    }

    const layer =
        document.getElementById("route-layer");

    const points =
        original
            .map(p => `${p.x},${p.y}`)
            .join(" ");

    const polyline =
        document.createElementNS(
            "http://www.w3.org/2000/svg",
            "polyline"
        );

    polyline.setAttribute("points", points);

    polyline.setAttribute("fill", "none");

    polyline.setAttribute(
        "stroke",
        "rgba(255, 152, 0, 0.67)"
    );

    polyline.setAttribute(
        "stroke-width",
        "1.5"
    );

    polyline.setAttribute(
        "stroke-linecap",
        "round"
    );

    polyline.setAttribute(
        "stroke-linejoin",
        "round"
    );

    polyline.setAttribute(
        "vector-effect",
        "non-scaling-stroke"
    );

    layer.appendChild(polyline);
}

/*___________________SIDEBAR____________________*/

const TOOL_ORDER = [
    ToolMode.CONTROL_PAIR,
    ToolMode.ROUTE,
    ToolMode.MASK,
    ToolMode.BLOCK,
    ToolMode.NONE,
];

let currentTool = ToolMode.CONTROL_PAIR;
let currentRotation = 0;


const TOOL_CONFIG = {

    "control_pair": {
        tx: 42,
        ty: 0,
    },

    "route": {
        tx: 37,
        ty: 0,
    },

    "mask": {
        tx: 40,
        ty: 0,
    },

    "block": {
        tx: 40,
        ty: 0,
    },

    "no_tool": {
        tx: 40,
        ty: 0,
    },
};

const wheel = document.getElementById("toolbar-wheel");

buildToolbar();
setTool(currentTool);

function setTool(tool) {

    currentTool = tool;

    document
        .querySelectorAll(".tool-segment")
        .forEach(seg => {

            const active =
                seg.dataset.tool === tool;

            seg.classList.toggle(
                "active",
                active
            );

            seg.querySelector(".segment-bg").style.display = "none";

            seg.getBoundingClientRect();

            seg.querySelector(".segment-bg").style.display = "";

            /*
                Bring active segment to front
            */

            if (active) {
                seg.parentNode.appendChild(seg);
            }
        });

    const index = TOOL_ORDER.indexOf(tool);

    const segmentAngle =
        360 / TOOL_ORDER.length;

    let targetRotation =
        (-1 - index) * segmentAngle;

    let delta =
        targetRotation - currentRotation;

    delta =
        ((delta + 180) % 360 + 360) % 360 - 180;

    currentRotation += delta;

    wheel.style.transform =
        `rotate(${currentRotation}deg)`;

    updateLabels();
}


document
    .querySelectorAll(".tool-segment")
    .forEach(seg => {

        seg.addEventListener("click", () => {

            setTool(seg.dataset.tool);
        });
    });

function buildToolbar() {

    const outerR = 60;
    const innerR = 20;

    const segmentAngle = 360 / TOOL_ORDER.length;

    document
        .querySelectorAll(".tool-segment")
        .forEach(seg => {

            const index =
                Number(seg.dataset.index);

            const startDeg = -segmentAngle / 2;
            const endDeg = segmentAngle / 2;

            const path =
                createDonutSegment(
                    0,
                    0,
                    innerR,
                    outerR,
                    startDeg,
                    endDeg
                );

            seg.querySelector("path")
               .setAttribute("d", path);

            /*
                Position segment
            */

            seg.setAttribute(
                "transform",
                `rotate(${index * segmentAngle})`
            );

            /*
                Initial text orientation
            */

            const labelWrap =
                seg.querySelector(".label-wrap");

            labelWrap.setAttribute(
                "transform",
                `
                rotate(${-index * segmentAngle})
                `
            );
        });
}


function updateLabels() {

    document
        .querySelectorAll(".tool-segment")
        .forEach(seg => {

            const tool =
                seg.dataset.tool;

            const index =
                Number(seg.dataset.index);

            const segmentAngle =
                360 / TOOL_ORDER.length;

            const labelWrap =
                seg.querySelector(".label-wrap");

            const angle =
                -(index * segmentAngle)
                - currentRotation;

            const cfg =
                TOOL_CONFIG[tool];

            labelWrap.setAttribute(
                "transform",
                `
                translate(${cfg.tx} ${cfg.ty})
                rotate(${angle})
                `
            );
        });
}

function polarToCartesian(cx, cy, r, deg) {

    const rad = deg * Math.PI / 180;

    return {
        x: cx + r * Math.cos(rad),
        y: cy + r * Math.sin(rad)
    };
}

function createDonutSegment(
    cx,
    cy,
    innerR,
    outerR,
    startDeg,
    endDeg
) {

    const p1 =
        polarToCartesian(cx, cy, outerR, startDeg);

    const p2 =
        polarToCartesian(cx, cy, outerR, endDeg);

    const p3 =
        polarToCartesian(cx, cy, innerR, endDeg);

    const p4 =
        polarToCartesian(cx, cy, innerR, startDeg);

    const largeArc =
        endDeg - startDeg <= 180 ? 0 : 1;

    return `
        M ${p1.x} ${p1.y}
        A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x} ${p2.y}
        L ${p3.x} ${p3.y}
        A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x} ${p4.y}
        Z
    `;
}