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

const camera = { x: 0, y: 0, zoom: 0.67 };

let isDragging = false;
let dragStartX = 0, dragStartY = 0;
let startCamX = 0, startCamY = 0;

let activeDrag = null;
let ncp = null;

/* =========================================================
    DOM REFERENCES
========================================================= */

const mapContainer = document.getElementById("map-container");
const cameraEl = document.getElementById("camera");
const viewport = document.getElementById("viewport");

/* =========================================================
    INIT
========================================================= */

updateCameraTransform();

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
    PAN
========================================================= */

mapContainer.addEventListener("mousedown", (e) => {
    if (e.button !== 1 && e.button !== 0) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    startCamX = camera.x;
    startCamY = camera.y;
});

window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    mapContainer.classList.add("panning");
    camera.x = startCamX + (e.clientX - dragStartX);
    camera.y = startCamY + (e.clientY - dragStartY);
    updateCameraTransform();
});

window.addEventListener("mouseup", () => {
    isDragging = false;
    mapContainer.classList.remove("panning");
});

/* =========================================================
    ZOOM
========================================================= */

mapContainer.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = mapContainer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const worldX = (mouseX - camera.x) / camera.zoom;
    const worldY = (mouseY - camera.y) / camera.zoom;
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    camera.zoom = Math.max(zoomMin, Math.min(zoomMax, camera.zoom * zoomFactor));
    camera.x = mouseX - worldX * camera.zoom;
    camera.y = mouseY - worldY * camera.zoom;
    updateCameraTransform();
}, { passive: false });

/* =========================================================
    DRAW
========================================================= */

function drawCourse() {
    clearCourseLayers();
    if (!project?.control_pairs) return;
    project.control_pairs.forEach(controlPair => drawControlPairGroup(controlPair));
}

function clearCourseLayers() {
    document.getElementById("control-layer").innerHTML = "";
}

function drawControlPairGroup(controlPair) {
    const layer = document.getElementById("control-layer");
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("control-pair-group");
    group.dataset.order = controlPair.order;
    if (controlPair.order === ncp) group.classList.add("selected");

    drawConnection(controlPair, group);
    drawControlPair(controlPair, group);

    group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectControlPair(controlPair.order);
    });

    layer.appendChild(group);
}

function drawControlPair(controlPair, parent) {
    const drawCircle = (point, pointType) => {
        if (!point) return;
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", point.x);
        circle.setAttribute("cy", point.y);
        circle.setAttribute("r", 18);
        circle.setAttribute("fill", "none");
        circle.setAttribute("stroke", "rgb(160, 51, 240)");
        circle.setAttribute("stroke-width", "3");
        circle.setAttribute("vector-effect", "non-scaling-stroke");
        circle.dataset.order = controlPair.order;
        circle.dataset.pointType = pointType;
        circle.classList.add("control-pair-element", "control-circle");

        circle.addEventListener("mousedown", (event) => {
            event.stopPropagation();
            event.preventDefault();
            const pt = screenToWorld(event.clientX, event.clientY);
            activeDrag = {
                controlPair, pointType,
                offsetX: point.x - pt.x,
                offsetY: point.y - pt.y
            };
            document.body.style.cursor = "grabbing";
        });

        parent.appendChild(circle);
    };

    drawCircle(controlPair.start, "start");
    drawCircle(controlPair.ziel, "ziel");
}

function drawConnection(controlPair, parent) {
    if (!controlPair?.start || !controlPair?.ziel) return;

    const { start, ziel } = controlPair;
    const R_CONTROL = 25;
    const GAP = 5;
    const dx = ziel.x - start.x;
    const dy = ziel.y - start.y;
    const dist = Math.hypot(dx, dy);

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
    setLineAttrs(hitLine, "transparent", "15");
    hitLine.dataset.order = controlPair.order;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    setLineAttrs(line, "rgb(160, 51, 240)", "3");
    line.dataset.order = controlPair.order;
    line.classList.add("control-pair-element");

    parent.appendChild(hitLine);
    parent.appendChild(line);

    if (controlPair.order === ncp) drawConnectionArrow(start, ziel, angle, parent);
}

function drawConnectionArrow(start, ziel, angle, parent) {
    const arrowSize = 15;
    const arrowAngle = Math.PI / 6;
    const midX = (start.x + ziel.x + Math.cos(angle) * arrowSize / 2) / 2;
    const midY = (start.y + ziel.y + Math.sin(angle) * arrowSize / 2) / 2;

    const createLine = (x1, y1, x2, y2) => {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
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

/* =========================================================
    DRAG
========================================================= */

document.addEventListener("mousemove", (event) => {
    mapContainer.classList.toggle("dragging", !!activeDrag);
    if (!activeDrag) return;
    if (activeDrag.controlPair.order !== ncp) return;

    const pt = screenToWorld(event.clientX, event.clientY);
    const point = activeDrag.controlPair[activeDrag.pointType];
    let newX = pt.x + activeDrag.offsetX;
    let newY = pt.y + activeDrag.offsetY;

    const snapTarget = findSnapTarget(activeDrag.controlPair, activeDrag.pointType, newX, newY);
    if (snapTarget) { newX = snapTarget.x; newY = snapTarget.y; }

    point.x = newX;
    point.y = newY;

    updateControlPairGroup(activeDrag.controlPair);
    updateCrosshair(point.x, point.y);
});

document.addEventListener("mouseup", () => {
    activeDrag = null;
    document.body.style.cursor = "";
    mapContainer.classList.remove("dragging");
    updateSelectionVisuals();
    hideCrosshair();
});

function updateControlPairGroup(controlPair) {
    const layer = document.getElementById("control-layer");
    const oldGroup = layer.querySelector(`.control-pair-group[data-order="${controlPair.order}"]`);
    if (!oldGroup) return;
    oldGroup.remove();
    drawControlPairGroup(controlPair);
}

/* =========================================================
    SELECTION
========================================================= */

function selectControlPair(order) {
    ncp = order;
    drawCourse();
    const layer = document.getElementById("control-layer");
    const selected = layer.querySelector(`.control-pair-group[data-order="${order}"]`);
    if (selected) layer.appendChild(selected);
    updateSelectionVisuals();
}

function updateSelectionVisuals() {
    document.querySelectorAll(".control-pair-group").forEach(group => {
        group.classList.toggle("selected", Number(group.dataset.order) === ncp);
    });
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
        if (cp === draggedControlPair) return;
        ["start", "ziel"].forEach(type => {
            const pt = cp[type];
            if (!pt) return;
            const dist = Math.hypot(pt.x - x, pt.y - y);
            if (dist < bestDist) { bestDist = dist; bestTarget = pt; }
        });
    });

    return bestTarget;
}