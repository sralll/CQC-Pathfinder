//GLOBAL VARIABLES

// parameters
const R_CONTROL = 25;		    //radius of control circle
const SNAP_THRESHHOLD = 25;	    //distance to snap cursor
const MARKER_LENGTH = 5;        //small cross marker size
const TRAIN_SCALE = 0.710;      //scale for training mask, 1:1.4
const DRAG_THRESHOLD_PX = 7;    // minimum pixels to move before panning starts
const RUN_SPEED = 4.75;         // average running speed in m/s
const MAX_HISTORY = 100;        // Undo stack size
const BLOCK_AREA_SNAP_DIST = 8; // distance to snap to start of blocking polygon
const PICK_RADIUS = 6;          // px in map coordinates

const CONTINUATION_COLOR = "rgba(255, 255, 0, 0.4)";
const CONTINUATION_WIDTH = 1.5;

// state variables and flags
let mode = "placeControls";	    //main mode of editor
var subMode = null;             //submode for CV editing
var subModeB = "line";          //submode for blocked terrain editing
let cv_mask = false;            //flag for existing CV mask
let projectSaved = true;        //set to false whenever the user makes changes


let loading = false;            //flag for loading state
let batchPollInterval = null;   //interval ID for polling batch progress
let batchPollingActive = false; // guard flag
let activeBatchFilenames = new Set();
let mouse = {button: false};    //mouse click state
let isEditing = false;          //flag for editing mask
let hasDragged = false;         //flag for drag detection in main mouse event
let isDragging = false;         //flag for map dragging
let cDraw = rDraw = sDraw = false;  //flags for drawing control, route, sperre
let isEditingElevation = false; //flag for elevation editing
let nnController = null;        //controller for neural network fetch aborting
let pfController = null;        //controller for pathfinding fetch aborting
let loadedFileName = null;      // name of currently loaded file (for better UX on reload)
let editRoute = null;           // active route being edited
let editContinuation = null;    // remaining points after split
let editInsertIndex = null;     // index where split happened

// timers
let startTime = null;           //loading animation timer

// variables
let BrushRadius = 2;            //brush radius for CV editing

//objects
let image = new Image();        //main map image
let imgBitmap = null;           //bitmap memory holder
let mask = null;                //mask image from UNet

let cqc = {
    published: false,
    mapFile	: null,
    scaled	: null,
    sP		: {
        p1: {
            x: null,
            y: null,
        },
        p2: {
            x: null,
            y: null,
        },
        dist: null
    },
    scale	: 1,
    cP		: [],
    blockedTerrain: {
        lines: [],
        areas: []
    },
};

let undoStack = [];             //undo stack
let redoStack = [];             //redo stack

// coordinates
let liveX, liveY;			    //cursor live position relative to canvas (inverse of transformation matrix)
let transX = transY = 0;	    //translation of map
let scale = 1; 				    //map scale
var ncP = nR = nRP = 0;         //counters for control points, routes, route points	


// temporary coordinates
let xClick, yClick;			    //coordinates on mouse click
let dragStartX = 0;             //starting position for dragging
let dragStartY = 0;             //starting position for dragging
let currentBlockLine = null;    // for drawing new blocked line
let currentBlockArea = null;    // for drawing new blocked area

// get DOM elements
const routeCanvas = document.getElementById("routeCanvas"); let rc = routeCanvas.getContext("2d");
const maskCanvas = document.getElementById("maskCanvas"); let mc = maskCanvas.getContext("2d");
const editLiveCanvas = document.getElementById('editLiveCanvas'); let ec = editLiveCanvas.getContext("2d");
const editCanvas = document.createElement('canvas'); let editCtx = editCanvas.getContext('2d');
editCtx.imageSmoothingEnabled = false;

const addCVBlocked = document.getElementById("buttonAddCVblocked");
const removeCVBlocked = document.getElementById("buttonRemoveCVBlocked");
const buttonCV = document.getElementById("buttonCV");
const instructionBox = document.getElementById("divI");
const alertBox = document.getElementById("alertBox");
const buttonBlock = document.getElementById("buttonBlock");
const blockArea = document.getElementById("blockArea");
const blockLine = document.getElementById("blockLine");
const blockRemove = document.getElementById("blockRemove");
const buttonRoute = document.getElementById("buttonRoute");
const cpt = document.getElementById('controlPairsTable');
const divM = document.getElementById('divM');
const divC = document.getElementById('divC');
const headC = document.getElementById('headC');
const cth = document.getElementById('tableHC');
const tableC = document.getElementById('tableC');
const buttonControl = document.getElementById("buttonControl");
const tableR = document.getElementById('divR');
const rpt = document.getElementById('routesTable');
const filenameInput = document.getElementById('filename');
const modalP = document.getElementById('modalP');
const modalCV = document.getElementById('modalCV');
const openMap = document.getElementById('buttonMap');
const closeMap = document.getElementById('closeMap');
const modalM = document.getElementById('modalM');
const table = document.getElementById('fileTable');
const tbody = table.querySelector('tbody');
const mapInput = document.getElementById('fileInput');
const uploadSpinner = document.getElementById("uploadSpinner");
const mapUploadForm = document.getElementById('uploadForm');
const uploadButton = document.getElementById('uploadButton');
const scaleInputDiv = document.getElementById('scaleInputDiv');
const scalingInfo = document.getElementById("scalingInfo");
const scaleInput = document.getElementById("scaleInput");
const mapScaleInput = document.getElementById("mapScaleInput");
const projectNameDisplay = document.getElementById("projectName");

//Main mouseevent listener
routeCanvas.addEventListener("mousemove", mouseEvent, {passive: true});
routeCanvas.addEventListener("mousedown", mouseEvent, {passive: true});
routeCanvas.addEventListener("mouseup", mouseEvent, {passive: true});

//wheel event listeners for zooming
routeCanvas.addEventListener('wheel', (event) => {
    event.preventDefault(); //prevent scrolling as usual
    if (event.deltaY < 0) { //check scroll direction
        if(scale<10){ //scale limit
            scale *= 1.1; //zoom in
            calcTransf(1.1, event); //calculate new transformation matrix

        }
    } else { 
        if (scale > 0.1) { // minimum scale limit
            scale /= 1.1; //zoom out
            calcTransf(1/1.1, event); //calculate new transformation matrix
        }
    }
    
    draw(rc); //update canvas, tables
});

maskCanvas.addEventListener('wheel', (event) => {
    event.preventDefault(); //prevent scrolling as usual
    if (event.deltaY < 0) { //check scroll direction
        if(scale<10){ //scale limit
            scale *= 1.1; //zoom in
            calcTransf(1.1, event); //calculate new transformation matrix

        }
    } else { 
        if (scale > 0.1) { // minimum scale limit
            scale /= 1.1; //zoom out
            calcTransf(1/1.1, event); //calculate new transformation matrix
        }
    }
    
    draw(rc); //update canvas, tables
    editingCursor(event);
});

//Keypress shortcuts
document.addEventListener("keydown", function(e) {

    // Ignore typing in inputs
    if (
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.isContentEditable
    ) return;

    const isCtrl = e.ctrlKey || e.metaKey;

    // ===============================
    // UNDO / REDO (HIGHEST PRIORITY)
    // ===============================
    if (isCtrl && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        undo();
        draw(rc);
        return;
    }

    if (isCtrl && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
        e.preventDefault();
        redo();
        draw(rc);
        return;
    }

    // Block all other Ctrl-modified keys
    if (isCtrl) return;

    if (modalP.style.display === 'block') {
        if (e.key === 'Escape') {
            closeProjects();
            return;
        }
    }

    if (modalM.style.display === 'block') {
        if (cqc.scaled) {
            if (e.key === 'Escape') {
                closeMapModal();
                return;
            }
        }
    }

    if (modalM.style.display === 'block' && e.key === 'Enter') {
        e.preventDefault(); // prevent default form submit or focus change
        if (mapInput.files.length > 0) uploadButton.click();
        return;
    }

    switch (e.key.toLowerCase()) {
        case 'd':
            pushUndoState();
            delControl();
            break;

        case 'n':
            if (cqc.cP.length > ncP) {
                ncP += 1;
                nR = 0;
                nRP = 0;
                if (cqc.cP.length > ncP) setMapTransformForControlPair(ncP);
            }
            break;

        case 'p':
            setModeC();
            break;

        case 'r':
            setModeR();
            break;

        case 'v':
            mode = "mapCV";
            break;

        case 'a':
            if (mode === "mapCV") {
                subMode = "add";
            }
            break;

        case 's':
            mode = "drawSperre";
            break;

        case 'l':
            if (mode === "drawSperre") {
                subModeB = "line";
            }
            break;

        case 'f':
            if (mode === "drawSperre") {
                subModeB = "area";
            }
            break;

        case 'e':
            if (mode === "mapCV") {
                subMode = "remove";
            } else if (mode === "drawSperre") {
                subModeB = "remove";
            }
            break;

        case 'm':
            modalM.style.display = 'block';
            break;

        case 'z':
            if (mode === "drawRoutes" && cqc.cP.length > 0) {
                send_pathfinding();
            }
            break;
    }

        //number keys to jump to control pairs
        if (e.key >= '1' && e.key <= '9') {  // keys '1' to '9'
            setcP(Number(e.key) - 1);
            return;
        }

    draw(rc); //update canvas, tables
});

// Warn user when leaving the page if there are unsaved changes
window.addEventListener("beforeunload", function (e) {
    if (!projectSaved) {
        // Some browsers require setting e.returnValue to a non-empty string
        e.preventDefault();
        e.returnValue = ""; 
        // The browser will show a generic "Changes you made may not be saved" warning
        return "";
    }
});

// close modals
modalP.addEventListener('click', (event) => {
    if (event.target === modalP) {
        closeProjects();
    }
});

modalM.addEventListener('click', (event) => {
    if (event.target === modalM) {
        modalM.style.display = 'none';
        filenameInput.value = '';
    }
});

// CV buttons interaction
addCVBlocked.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (event.deltaY < 0) { //check scroll direction
        if(BrushRadius<10){ //scale limit
            BrushRadius += 1; //zoom in
        }
    } else { 
        if (BrushRadius > 1) { // minimum scale limit
            BrushRadius -= 1; //zoom out
        }
    }
    });

addCVBlocked.addEventListener('click', () => {
    subMode = "add";
    draw(rc);
});

removeCVBlocked.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (event.deltaY < 0) { //check scroll direction
        if(BrushRadius<10){ //scale limit
            BrushRadius += 1; //zoom in
        }
    } else { 
        if (BrushRadius > 1) { // minimum scale limit
            BrushRadius -= 1; //zoom out
        }
    }
});

removeCVBlocked.addEventListener('click', () => {
    subMode = "remove";
    draw(rc);
});

// Mask canvas editing listeners
maskCanvas.addEventListener("mousedown", startDraw);
maskCanvas.addEventListener("mousemove", editing);
maskCanvas.addEventListener("mouseup", stopDrawSave);
maskCanvas.addEventListener("mouseleave", stopDraw);
maskCanvas.addEventListener('mousemove', editingCursor);

// Scale input handling
scaleInput.addEventListener("keydown", handleScaleEnter);

draw(rc);

// Backend CSRF token
function getCSRFToken() {
    return document.querySelector('meta[name="csrf-token"]').getAttribute('content');
}

// object constructors
function gen_rP() {
    return {
        x: null,
        y: null
    }
}

function gen_route() {
    return {
        length: null,
        noA: null,
        elevation: 0,
        runTime: null,
        pos: null,
        rP: [],
    }
}

function gen_cP() {
    return {
        start: {
            x: null,
            y: null,
        },
        ziel: {
            x: null,
            y: null,
        },
        complex: true,
        route: []
    };
}

function gen_sP() {
    return {
        p1: {
            x: null,
            y: null,
        },
        p2: {
            x: null,
            y: null,
        },
        dist: null
    };
}

// Save state marker
function markUnsaved() {
    projectSaved = false;
}

function markSaved() {
    projectSaved = true;
}

// undo functions
function getEditorState() {
    return {
        cqc: structuredClone(cqc),
        ui: {
            ncP,
            nR,
            nRP,
            cDraw,
            sDraw,
            rDraw,
            isDragging,
            mode,
            subMode,
            subModeB,
            isEditing,
            isEditingElevation,
            currentBlockArea: currentBlockArea ? structuredClone(currentBlockArea) : null,
            currentBlockLine: currentBlockLine ? structuredClone(currentBlockLine) : null,
        },
        meta: {
            projectSaved,
        }
    };
}

function applyEditorState(state) {

    // --- restore main data ---
    cqc = structuredClone(state.cqc);

    // --- restore UI / editor state ---
    ({
        ncP,
        nR,
        nRP,
        cDraw,
        sDraw,
        rDraw,
        isDragging,
        mode,
        subMode,
        subModeB,
        isEditing,
        isEditingElevation,
    } = state.ui);

    currentBlockArea = state.ui.currentBlockArea
        ? structuredClone(state.ui.currentBlockArea)
        : null;

    currentBlockLine = state.ui.currentBlockLine
        ? structuredClone(state.ui.currentBlockLine)
        : null;

    // --- restore meta ---
    projectSaved = state.meta.projectSaved;

    // --- redraw everything ---
    draw(rc);
}

function pushUndoState() {
    undoStack.push(getEditorState());

    if (undoStack.length > MAX_HISTORY) {
        undoStack.shift();
    }

    redoStack.length = 0;  // invalidate redo chain
    projectSaved = false;
}

function undo() {
    if (undoStack.length === 0) return;

    redoStack.push(getEditorState());
    const prev = undoStack.pop();
    applyEditorState(prev);
}

function redo() {
    if (redoStack.length === 0) return;

    undoStack.push(getEditorState());
    const next = redoStack.pop();
    applyEditorState(next);
}

//main mouse event function
function mouseEvent(event) {
    liveCursor(event); //get inverse transformed mouse coordinates (relative to map)
    if (event.type === "mousedown") {
        mouse.button = true;
        isDragging = false;
        hasDragged = false;

        dragStartX = event.offsetX;
        dragStartY = event.offsetY;

        xClick = liveX;
        yClick = liveY;

        routeCanvas.style.cursor = "default";
    }
    if (event.type === "mousemove" && mouse.button) {

        const dx = event.offsetX - dragStartX;
        const dy = event.offsetY - dragStartY;

        if (!hasDragged && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
            hasDragged = true;
            isDragging = true;
            routeCanvas.style.cursor = "grabbing";
        }

        if (hasDragged) {
            pan({ x: dx, y: dy });
            dragStartX = event.offsetX;
            dragStartY = event.offsetY;
        }
    }

    if (event.type === "mouseup") {
        mouse.button = false;
        isDragging = false;

        if (!hasDragged) {
            // REAL click
            switch (mode) {
                case "placeControls":
                    makeControl(event);
                    break;
                case "drawRoutes":
                    // 1. reconnect if clicking dashed route
                    if (tryReconnectEdit(xClick, yClick)) break;

                    // 2. try split on active route
                    if (tryEditRoutePoint(xClick, yClick)) break;

                    // 3. normal point insertion
                    makeRP(event);
                    break;
                case "scaleMap":
                    makeScale(event);
                    break;
                case "drawSperre":
                    switch (subModeB) {
                        case "line":
                            makeBlockLine(event);
                            break;
                        case "area":
                            makeBlockArea(event);
                            break;
                        case "remove":
                            removeSperre(event);
                            break;
                    }
                    break;
            }
        }

        routeCanvas.style.cursor = "default";
    }
    draw(rc);
}

function liveCursor(event){
    //unsnapped live position
    liveX = (event.clientX-transX)/scale;
    liveY = (event.clientY-transY)/scale;

    switch (mode){
        case "placeControls": //when drawing controls
            if (ncP > 0 && !cDraw){ //snap to second control
                let snapDist = distance({x: liveX, y: liveY}, cqc.cP[ncP-1].ziel);
                if (snapDist < SNAP_THRESHHOLD){
                    liveX = cqc.cP[ncP-1].ziel.x;
                    liveY = cqc.cP[ncP-1].ziel.y;
                }
            }
        break;

        case "drawRoutes": //when drawing routes
            if (ncP < cqc.cP.length){
                if (!rDraw){ //snap to first control
                    let snapDist = distance({x: liveX, y: liveY}, cqc.cP[ncP].start);
                    if(snapDist < SNAP_THRESHHOLD){
                        liveX = cqc.cP[ncP].start.x;
                        liveY = cqc.cP[ncP].start.y;
                    }
                }
                if (rDraw){ //snap to second control
                    let snapDist = distance({x: liveX, y: liveY}, cqc.cP[ncP].ziel);
                    if(snapDist < SNAP_THRESHHOLD/5){
                        liveX = cqc.cP[ncP].ziel.x;
                        liveY = cqc.cP[ncP].ziel.y;
                    }
                }
            }
        break;
    }
}

// navigation
function openProjects() {
    modalP.style.display = 'block';
    projectNameDisplay.textContent = loadedFileName ? loadedFileName : "Neues Projekt";
    loadFileList();  // Load file list when the modal opens
}

function closeProjects() {
    modalP.style.display = 'none';
    filenameInput.value = '';
    stopBatchProgressPolling();
}

function closeMapModal() {
    modalM.style.display = 'none';
    filenameInput.value = '';
}

function openMapModal() {
    modalM.style.display = 'block';
}

function setModeC() {
    mode = "placeControls";
    alertBox.innerHTML = '';
    draw(rc); //update canvas, tables
}

function setModeR() {
    nRP = 0;
    nR = 0;
    mode = "drawRoutes";
    alertBox.innerHTML = '';

    const cps = cqc.cP;
    const maxIndex = cps.length - 1;

    // safety: empty list
    if (maxIndex < 0) {
        ncP = 0;
    } 
    else {
        const current = cps[ncP];
        if (!current || !current.ziel) {
            ncP = maxIndex;
        }
    }

    draw(rc); // update canvas, tables
}

function setModeS() {
    mode = "drawSperre";
    alertBox.innerHTML = '';
    draw(rc); //update canvas, tables
}

function setR(index) {
    if (!rDraw) {
        nR = index;
    }
    draw(rc); //update canvas, tables
}

function setcP(index) {
    if (!cDraw) {
        ncP = index;
    }

    if (cqc.cP.length > ncP) {setMapTransformForControlPair(ncP)};

    nR = 0; //start at first route when switching control pairs
    draw(rc); //update canvas, tables
}


// main editing
function makeControl(event){
    if (!sDraw) {
        if (cDraw){ //depending on if it is the first or second
            pushUndoState();
            makeZiel(event); //draw a second control
            markUnsaved();
        } else {
            pushUndoState();
            makeStart(event); //draw a first control
        }
    }
}

function makeStart(event) {
    if (cqc.cP.length <= ncP){ //check if current control pair array entry exists
        cqc.cP.push(gen_cP()); //add new control pair array element
    } else { //delete entries in already filled array
        cqc.cP[ncP].start.x = null;
        cqc.cP[ncP].start.y = null;
        cqc.cP[ncP].ziel.x = null;
        cqc.cP[ncP].ziel.y = null;
    }
    //write click coordinates to control pair start coordinates
    cqc.cP[ncP].start.x = xClick;
    cqc.cP[ncP].start.y = yClick;
    cDraw = true; //set control draw state
}

function makeZiel(event) {
    //add second control coordinates to object
    cqc.cP[ncP].ziel.x = xClick;
    cqc.cP[ncP].ziel.y = yClick;
    cDraw = false; //reset control draw state
    ncP += 1; //increase control pair counter
}

function makeRP(event) {
    const willFinishRoute =
        rDraw &&
        xClick === cqc.cP[ncP].ziel.x &&
        yClick === cqc.cP[ncP].ziel.y;

    pushUndoState();

    if (!rDraw) {
        if (
            xClick !== cqc.cP[ncP].start.x ||
            yClick !== cqc.cP[ncP].start.y
        ) return;

        if (cqc.cP[ncP].route.length > nR) {
            cqc.cP[ncP].route.splice(nR, 1, gen_route());
        } else {
            if (!cqc.cP[ncP].complex && cqc.cP[ncP].route.length > 1) {
                alertBox.innerHTML = "Bei Links/Rechts-Posten maximal 2 Routen";
                return;
            }
            cqc.cP[ncP].route.push(gen_route());
        }

        rDraw = true;
        nRP = 0;
    }

    // ---- add route point ----
    cqc.cP[ncP].route[nR].rP.push(gen_rP());
    cqc.cP[ncP].route[nR].rP[nRP].x = xClick;
    cqc.cP[ncP].route[nR].rP[nRP].y = yClick;
    nRP += 1;

    if (willFinishRoute) {
        calcSide();
        calcLength();
        calcDir();
        nR += 1;
        nRP = 0;
        rDraw = false;
        markUnsaved();
    }
}

function tryReconnectEdit(x, y) {
    if (!editContinuation || !editRoute) return false;

    for (let i = 0; i < editContinuation.length; i++) {
        if (isNear(editContinuation[i], x, y)) {

            pushUndoState();

            // append remaining original points
            editRoute.rP.push(...editContinuation.slice(i));

            // cleanup edit state
            editContinuation = null;
            editRoute = null;
            rDraw = false;
            nRP = 0;

            calcSide();
            calcLength();
            calcDir();
            markUnsaved();

            return true;
        }
    }
    return false;
}

function tryEditRoutePoint(x, y) {
    const route = cqc.cP[ncP]?.route[nR];
    if (!route) return false;

    const rP = route.rP;

    for (let i = 1; i < rP.length - 1; i++) { // avoid start/end
        if (isNear(rP[i], x, y)) {

            pushUndoState();

            editRoute = route;

            // split
            editContinuation = rP.slice(i);   // incl clicked point
            route.rP = rP.slice(0, i + 1);    // keep clicked point

            editInsertIndex = route.rP.length;
            rDraw = true;
            nRP = route.rP.length;

            return true;
        }
    }
    return false;
}

function makeScale(event) {
    if (sDraw){
        if (nsP <1) {
            //cqc.sP.push(gen_sP()); //add new scale pair array element
            cqc.sP.p1.x = xClick;
            cqc.sP.p1.y = yClick;
        }
        if (nsP == 1) {
            cqc.sP.p2.x = xClick;
            cqc.sP.p2.y = yClick;
            cqc.sP.dist = Math.sqrt((cqc.sP.p2.x - cqc.sP.p1.x)**2 + (cqc.sP.p2.y - cqc.sP.p1.y)**2);
            sDraw = false;
            modalM.style.display = 'block';
            scalingInfo.style.display = 'none';
            scaleInputDiv.style.display = 'flex';
            alertBox.innerHTML = '';
            scaleInput.focus();
            markUnsaved();
        }
        nsP += 1;
    }
}

function makeBlockLine(event) {
    // FIRST click → start line
    if (!currentBlockLine) {
        pushUndoState();
        currentBlockLine = {
            start: { x: liveX, y: liveY },
            end: null
        };
        return;
    }

    // SECOND click → finish line
    currentBlockLine.end = { x: liveX, y: liveY };

    cqc.blockedTerrain.lines.push(currentBlockLine);
    markUnsaved();
    currentBlockLine = null; // reset for next line
}

function makeBlockArea(event) {
    const p = { x: liveX, y: liveY };

    pushUndoState();

    // FIRST click → start polygon (no undo yet)
    if (!currentBlockArea) {
        currentBlockArea = { points: [p] };
        return;
    }

    const start = currentBlockArea.points[0];
    const willClose =
        currentBlockArea.points.length > 2 &&
        distance(p, start) < BLOCK_AREA_SNAP_DIST;

    // FINISH polygon (atomic action)
    if (willClose) {

        cqc.blockedTerrain.areas.push(currentBlockArea);
        currentBlockArea = null;

        markUnsaved();
        return;
    }

    // INTERMEDIATE point (no undo!)
    currentBlockArea.points.push(p);
}

function removeSperre(event) {
    const click = { x: liveX, y: liveY };
    const threshold = 10 / cqc.scale; // adjust for zoom

    let closest = { type: null, index: -1, dist: Infinity, subIndex: -1 };

    // --- Check lines ---
    cqc.blockedTerrain.lines.forEach((line, i) => {
        const d = distanceToSegment(click.x, click.y, line.start.x, line.start.y, line.end.x, line.end.y);
        if (d < closest.dist && d < threshold) {
            closest = { type: "line", index: i, dist: d };
        }
    });

    // --- Check polygons ---
    cqc.blockedTerrain.areas.forEach((area, i) => {
        const pts = area.points;
        if (pointInPolygon(click.x, click.y, pts)) {
            // inside polygon → highest priority
            closest = { type: "area", index: i, dist: 0 };
        } else {
            // optionally, check edges for click near boundary
            for (let j = 0; j < pts.length; j++) {
                const next = (j + 1) % pts.length;
                const d = distanceToSegment(click.x, click.y, pts[j].x, pts[j].y, pts[next].x, pts[next].y);
                if (d < closest.dist && d < threshold) {
                    closest = { type: "area", index: i, dist: d };
                }
            }
        }
    });

    // --- Remove closest if found ---
    if (closest.type === "line") {
        pushUndoState();
        cqc.blockedTerrain.lines.splice(closest.index, 1);
    } else if (closest.type === "area") {
        pushUndoState();
        cqc.blockedTerrain.areas.splice(closest.index, 1);
    }

    draw(rc); // update canvas
}

function setMapTransformForControlPair(ncP) {
    const start = cqc.cP[ncP].start;
    const ziel  = cqc.cP[ncP].ziel;

    // --- 1. Center point between controls ---
    const cx = (start.x + ziel.x) / 2;
    const cy = (start.y + ziel.y) / 2;

    // --- 2. Distance between controls ---
    const dx = ziel.x - start.x;
    const dy = ziel.y - start.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // --- 3. Determine zoom ---
    // You can tune this later
    const marginFactor = 1.5;

    const zoomX = routeCanvas.width  / (dist * marginFactor);
    const zoomY = routeCanvas.height / (dist * marginFactor);

    // Take the limiting zoom (incl. hard limits)
    scale = Math.min(zoomX, zoomY, 5);
    scale = Math.max(scale, 0.3);

    // --- 4. Compute translation ---
    // canvas center minus transformed center point
    transX = routeCanvas.width  / 2 - cx * scale;
    transY = routeCanvas.height / 2 - cy * scale;
}

function blockingArea() {
    subModeB = "area";
    draw(rc);
}

function blockingLine() {
    subModeB = "line";
    draw(rc);
}

function removeBlock() {
    subModeB = "remove";
    draw(rc);
}

function delControl() {
    switch (mode) {
        case "placeControls": //when drawing controls
            if(cqc.cP.length > 0) { //check if control array is not empty
                cqc.cP.splice(ncP,1); //delete current control pair
                if (!cDraw) {
                    if (ncP > 0) {
                        ncP -= 1; //jump back to previous control
                        setMapTransformForControlPair(ncP);
                    }
                } else {
                    cDraw = false; //abort active drawing mode
                }
            }
        break;
        
        case "drawRoutes": //when drawing routes
            if(cqc.cP[ncP].route.length > 0) {//check if route array is not empty
                if (!rDraw) { //outside route drawing mode
                    cqc.cP[ncP].route.splice(nR,1); //delete current route
                    if (nR > 0) {
                        nR -= 1; //jump back to previous route
                    }
                } else { //in route drawing mode
                    if (nRP > 0) {
                        cqc.cP[ncP].route[nR].rP.splice(nRP-1,1); //delete latest control point
                        nRP -= 1; //jump back to previous route point
                        if (nRP == 0) { //if all route pairs deleted
                            rDraw = false; //exit route drawing mode
                        }
                    }
                }
            }
        break;
        case "drawSperre": //when drawing blocked areas
            if (subModeB === "area" && currentBlockArea) {
                const pts = currentBlockArea.points;
                pts.pop(); // delete last point
            }
        break;
    }
    draw(rc); //update canvas, tables
}

function scaleMap() {
    modalM.style.display = 'none';
    sDraw = true;
    cDraw = false;
    mode = "scaleMap";
    nsP = 0;
    alertBox.innerHTML = 'Karte skalieren';
}

function submitScale() {
    const inputValue = scaleInput.value;
    const mapScale = mapScaleInput.value;

    if (isNaN(inputValue) || inputValue <= 0) {
        alert("Please enter a valid positive number!");
        return;
    }

    if (isNaN(mapScale) || mapScale <= 0) {
        alert("Please enter a valid positive number!");
        return;
    }

    cqc.scale = inputValue * 4000 / mapScale / cqc.sP.dist / 0.48; // DPI relation

    // Close the modal
    modalM.style.display = "none";
    scaleInput.value = "";
    scaleInputDiv.style.display = 'none';
    mode = "placeControls";
    transX = transY = 0; //reset translation
    cqc.scaled = true;
    draw(rc); //update canvas, tables
}

function handleScaleEnter(event) {
    if (event.key === "Enter" && scaleInput.style.display !== "none") {
        submitScale();
    }
}

// projects
function loadFileList() {
    // Show loading spinner
    tbody.innerHTML = `
        <tr>
            <td colspan="8" style="text-align: center; padding: 20px;">
                <i style="font-size: 2rem; padding: 0px 5px" class="fa-solid fa-spinner fa-spin-pulse"></i>
            </td>
        </tr>
    `;

    fetch('/coursesetter/get-files/')
        .then(response => response.json())
        .then(data => {
            const files = data.files;

            const userKaderName = data.user_kader;
            const userSharedPool = data.user_shared_pool;

            // Sort: own kader first, then date descending
            files.sort((a, b) => {
                const aOwn = a.kader === userKaderName ? 1 : 0;
                const bOwn = b.kader === userKaderName ? 1 : 0;
                if (bOwn - aOwn !== 0) return bOwn - aOwn;
                return new Date(b.modified) - new Date(a.modified);
            });

            // --- Build table header dynamically ---
            const thead = table.querySelector('thead');
            thead.innerHTML = '';
            const headerRow = document.createElement('tr');

            // Always visible columns
            ['Projekt', 'Posten', 'Letzte Änderungen', 'Autor'].forEach(text => {
                const th = document.createElement('th');
                th.textContent = text;
                th.classList.add('tableHeadProjects');
                headerRow.appendChild(th);
            });

            // Conditionally add "Kader"
            if (userSharedPool) {
                const thKader = document.createElement('th');
                thKader.textContent = 'Kader';
                thKader.classList.add('tableHeadProjects');
                headerRow.appendChild(thKader);
            }

            // Add 3 extra empty header columns
            for (let i = 0; i < 5; i++) {
                const th = document.createElement('th');
                th.classList.add('tableHeadProjects');
                headerRow.appendChild(th);
            }

            thead.appendChild(headerRow);

            // --- Clear tbody ---
            tbody.innerHTML = '';

            files.forEach(file => {
                const row = document.createElement('tr');
                row.classList.add('tableRowProjects');

                // Project name
                const fileNameCell = document.createElement('td');
                fileNameCell.classList.add('tableCellProjects');
                fileNameCell.textContent = file.filename || 'Unknown';
                
                // --- Add click event to populate the input field ---
                fileNameCell.style.cursor = 'pointer'; // show pointer on hover
                fileNameCell.addEventListener('click', () => {
                    if (filenameInput) filenameInput.value = file.filename;
                });

                // Optional: add hover effect
                fileNameCell.addEventListener('mouseenter', () => {
                    fileNameCell.style.backgroundColor = '#f0f0f0';
                });
                fileNameCell.addEventListener('mouseleave', () => {
                    fileNameCell.style.backgroundColor = '';
                });

                row.appendChild(fileNameCell);

                // cP count
                const cpCountCell = document.createElement('td');
                cpCountCell.classList.add('tableCellProjects');
                cpCountCell.textContent = file.cPCount;
                cpCountCell.style.textAlign = 'center';
                row.appendChild(cpCountCell);

                // Last modified
                const lastModifiedCell = document.createElement('td');
                lastModifiedCell.classList.add('tableCellProjects');
                const date = new Date(file.modified);
                lastModifiedCell.textContent = date.toLocaleString();
                row.appendChild(lastModifiedCell);

                // Author
                const authorCell = document.createElement('td');
                authorCell.classList.add('tableCellProjects');
                authorCell.textContent = file.author;
                row.appendChild(authorCell);

                // Kader (conditionally displayed)
                const kaderCell = document.createElement('td');
                kaderCell.classList.add('tableCellProjects');
                if (userSharedPool) {
                    // Always show the kader for own files or shared pool files
                    kaderCell.textContent = file.kader || '';
                }
                row.appendChild(kaderCell);

                // Load button
                const loadCell = document.createElement('td');
                const loadButton = document.createElement('button');
                loadButton.innerHTML = '<i class="fa-solid fa-folder-open"></i>';
                loadButton.title = "Öffnen";
                loadButton.addEventListener('click', () => loadFile(file.filename));
                loadButton.style.padding = "2px 0px";
                loadCell.appendChild(loadButton);
                row.appendChild(loadCell);

                // Delete button
                const deleteCell = document.createElement('td');
                if (file.editable) {
                    const deleteButton = document.createElement('button');
                    deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
                    deleteButton.title = "Löschen";
                    deleteButton.addEventListener('click', () => deleteFile(file.filename));
                    deleteButton.style.padding = "2px 0px";
                    deleteCell.appendChild(deleteButton);
                }
                row.appendChild(deleteCell);

                // Publish button / state
                const publishCell = document.createElement('td');
                const publishButton = document.createElement('button');
                publishButton.innerHTML = '<i class="fa-solid fa-globe"></i>';
                publishButton.style.borderRadius = "5px";
                publishButton.style.padding = "3px 0px";

                if (file.editable) {
                    publishButton.addEventListener('click', () => publishProject(file.filename, publishButton));
                    publishButton.style.border = "1px solid black";
                    publishButton.style.backgroundColor = file.published ? "rgba(255,165,0,1)" : "white";
                } else {
                    publishButton.style.cursor = "default";
                    publishButton.style.backgroundColor = file.published ? "rgba(255,165,0,0.5)" : "white";
                    publishButton.disabled = true;
                    publishButton.title = "Publizieren";
                    publishButton.style.border = "1px solid rgba(255,165,0,0.0)";
                    publishButton.style.pointerEvents = "none";  // disables hover & clicks
                }

                publishCell.appendChild(publishButton);
                row.appendChild(publishCell);

                // Batch pathfinding button
                const batchPFCell = document.createElement('td');
                const batchProgressCell = document.createElement('td');

                if (file.editable) {
                    if (file.batch_progress && file.batch_progress.total) {
                        const progressSpan = document.createElement('span');
                        progressSpan.dataset.batchFilename = file.filename;
                        progressSpan.innerHTML = renderBatchProgressBar(file.batch_progress.done, file.batch_progress.total);
                        progressSpan.style.color = "#757575";
                        batchProgressCell.appendChild(progressSpan);
                    } else {
                        const batchPFButton = document.createElement('button');
                        batchPFButton.innerHTML = '<i class="fa-solid fa-industry"></i>';
                        batchPFButton.style.padding = "2px 0px";
                        batchPFButton.title = "Batch Pathfinding (2 Routen pro Postenpaar)";
                        batchPFButton.addEventListener('click', () => runBatchFromProjectFile(file.filename, batchPFButton, batchPFCell, batchProgressCell, file.cPCount));
                        batchPFCell.appendChild(batchPFButton);
                    }
                }

                row.appendChild(batchPFCell);
                row.appendChild(batchProgressCell);
                
                // Append row
                tbody.appendChild(row);
            });
            
            if (data.files.some(f => f.batch_progress && f.batch_progress.total)) {
                startBatchProgressPolling();
            }
        })
        .catch(error => {
            console.error('Error loading file list:', error);
            alert('Failed to load file list');
        });
}

function startBatchProgressPolling() {
    if (batchPollInterval) return;
    batchPollingActive = true;
    
    // Reset our tracker every time we start polling
    activeBatchFilenames.clear();

    batchPollInterval = setInterval(async () => {
        if (!batchPollingActive) return;

        const progressSpans = document.querySelectorAll('[data-batch-filename]');
        if (progressSpans.length === 0) {
            stopBatchProgressPolling();
            return;
        }

        try {
            const response = await fetch('/coursesetter/get-files/');
            const data = await response.json();
            const fileMap = Object.fromEntries(data.files.map(f => [f.filename, f]));

            progressSpans.forEach(span => {
                const filename = span.dataset.batchFilename;
                const file = fileMap[filename];
                if (!file) return;

                const hasProgress = file.batch_progress && file.batch_progress.total;

                if (hasProgress) {
                    // 1. If it has progress, update the bar and mark it as active
                    span.innerHTML = renderBatchProgressBar(file.batch_progress.done, file.batch_progress.total);
                    activeBatchFilenames.add(filename);
                } 
                else if (activeBatchFilenames.has(filename)) {
                    // 2. ONLY if it WAS active before, but now has NO progress, it is finished
                    activeBatchFilenames.delete(filename); // Clean up
                    
                    console.log(`Finished processing: ${filename}`);
                    
                    // Specific "Cleanup" actions
                    stopBatchProgressPolling();
                    loadFileList(); 
                }
            });
        } catch (err) {
            console.error("Progress poll failed:", err);
        }
    }, 3000);
}

function stopBatchProgressPolling() {
    batchPollingActive = false; // disarms any in-flight async callbacks
    clearInterval(batchPollInterval);
    batchPollInterval = null;
}

async function runBatchFromProjectFile(filename, batchPFButton, batchPFCell, batchProgressCell, ncP) {
    // Immediately show empty progress bar
    batchPFButton.style.display = 'none';
    const progressSpan = document.createElement('span');
    progressSpan.dataset.batchFilename = filename;  // needed for poller to find it
    progressSpan.innerHTML = renderBatchProgressBar(0, ncP);
    progressSpan.style.color = "#757575";
    batchProgressCell.appendChild(progressSpan);
    try {
        const response = await fetch("/pathfinding/batch/", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": getCSRFToken()
            },
            body: JSON.stringify({ filename: filename })
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Server error occurred");
        }
        // Start polling now that batch is confirmed running
        startBatchProgressPolling(() => renderFilesTable());
    } catch (err) {
        console.error("Error in batch pathfinding:", err);
        alert("Fehler: " + err.message);
        batchPFButton.style.display = 'block';
        batchProgressCell.innerHTML = '';
    }
}

function loadFile(filename) {
    const encodedFilename = encodeURIComponent(filename);
    const url = `/coursesetter/load-file/${encodedFilename}/`;

    fetch(url)
    .then(response => response.json())
    .then(data => {
        cqc = data.content; 
        loadedFileName = data.metadata.filename;

        // 2. Use the content for your processing logic
        normalizeCQC(cqc);
        
        // Note: has_mask is now inside data.content
        cv_mask = cqc.has_mask || false; 
        mask = null;

        loading = true;
        requestAnimationFrame(drawLoadingAnimation);

        closeProjects();
        
        ncP = nRP = nR = 0;
        transX = transY = 0;

        // Load image and draw immediately after it's ready
        image.onload = async () => {
            imgBitmap = await createImageBitmap(image);
            loading = false;
        };
        image.crossOrigin = "anonymous";
        image.src = cqc.mapFile; // mapFile is inside the content object

        // Load mask in parallel
        if (cv_mask) {
            const mapFilename = cqc.mapFile.split('/').pop().split('.')[0];
            const maskUrl = `/pathfinding/get_mask/mask_${mapFilename}.png`;

            const tempMask = new Image();
            tempMask.onload = () => {
                mask = tempMask;
                processMaskImage(mask);
            };
            tempMask.crossOrigin = "anonymous";
            tempMask.src = maskUrl;
        } else {
            mask = null;
            mode = "placeControls";
        }
        draw(rc);
        alertBox.innerHTML = '';
    })
    .catch(error => {
        console.error('Error loading the file:', error);
    });
}

submitSaveButton.addEventListener('click', async () => {
    const filename = filenameInput.value.trim();

    cqc.cP.forEach((cp, i) => {
        cp.route.forEach((r, j) => {
            const length = r.length;
            const elevation = r.elevation;

            const gradient = (elevation / length) * 100; // Gradient in %
            const GAP_p = 0.0017 * (gradient) ** 2 + 0.02901 * gradient + 0.99387;
            const GAP_n = 0.0017 * (gradient) ** 2 - 0.02901 * gradient + 0.99387;
            const GAP = RUN_SPEED / ((GAP_p + GAP_n) / 2);
            r.runTime = length / GAP; // Time = distance / adjusted speed
        });
    });

    if (filename === '') {
        alert('Ungültiger Name');
        return;
    }

    try {
        const encodedFilename = encodeURIComponent(filename);
        const url = `/coursesetter/file-exists/${encodedFilename}/`;
        // First fetch: Check if file exists
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Failed to check file existence');
        }

        const data = await response.json();
        if (data.exists) {
            const overwrite = confirm(`Projekt "${filename}" existiert bereits. Überschreiben?`);
            if (!overwrite) return;
        }

        // Second fetch: Save the file
        const saveResponse = await fetch('/coursesetter/save-file/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json',
                "X-CSRFToken": getCSRFToken(),
            },
            body: JSON.stringify({
                filename: `${filename}`,
                data: cqc
            })
        });

        if (!saveResponse.ok) {
            throw new Error('Failed to save file');
        }

        // Successfully saved
        markSaved();
        filenameInput.value = '';
        loadFileList();

    } catch (error) {
        console.error(error);
        alert(error.message);
    }
});

function deleteFile(filename) {
    if (confirm(`Projekt "${filename}" löschen?`)) {
        fetch(`/coursesetter/delete-file/${filename}/`, {
            method: 'DELETE',
            headers: {"X-CSRFToken": getCSRFToken()}
        })
        .then(response => response.json())
            .then(data => {
                loadFileList();  // Reload the file list after deletion
            })
            .catch(error => {
                console.error('Error:', error);
                alert('Failed to delete file');
            });
    }
}

function publishProject(filename, button) {
    const filenameWithoutExtension = filename.replace('.json', '');

    fetch(`/coursesetter/toggle-publish/${filenameWithoutExtension}/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            "X-CSRFToken": getCSRFToken()
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            if (button) {
                button.style.backgroundColor = data.published ? "orange" : "white";
            }
        }
    })
    .catch(err => {
        console.error(err);
        alert('Serverfehler beim Veröffentlichen.');
    });
}

function downloadJSON(data, filename = 'data.json') {
    // Convert the JavaScript object to a JSON string
    const jsonString = JSON.stringify(data, null, 2); // Pretty print with 2 spaces

    // Create a Blob from the JSON string
    const blob = new Blob([jsonString], { type: 'application/json' });

    // Create an invisible download link
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;

    // Programmatically click the link to trigger the download
    link.click();

    // Clean up the URL object after the download
    URL.revokeObjectURL(link.href);
}

// map functions
mapUploadForm.addEventListener('submit', function(event) {
    event.preventDefault(); // Prevent default form submission

    const file = mapInput.files[0];

    if (!file) {
        alert('Please select an image file to upload.');
        return;
    }

    const allowedTypes = ['image/jpeg', 'image/png']; // Use MIME types
    if (!allowedTypes.includes(file.type)) {
        alert('Kartenformat nicht unterstützt');
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    uploadSpinner.style.display = "flex";

    fetch('/coursesetter/upload/', {
        method: 'POST',
        headers: {
            "X-CSRFToken": getCSRFToken()
        },
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        mapInput.value = '';

        loading = true;
        requestAnimationFrame(drawLoadingAnimation);

        // Extract filename from the returned S3 key or URL
        const mapFilename = data.filename || data.mapFile.split('/').pop();

        // Replace direct S3 URL with Django protected view URL
        const protectedMapUrl = `/coursesetter/get_map/${mapFilename}`;
        cqc.mapFile = protectedMapUrl;
        
        image.onload = async () => {
            imgBitmap = await createImageBitmap(image);
            loading = false;
        };
        
        image.src = cqc.mapFile;
        scalingInfo.style.display = 'flex';
        scaleInputDiv.style.display = 'none';
        uploadSpinner.style.display = "none";

        cqc.scaled = data.scaled;
        cqc.scale = 1;
        cDraw = false;
        cqc.cP = [];
        nsP = 0;
        nRP = 0;
        ncP = 0;
        cv_mask = false;
        mask = null;
        alertBox.innerHTML = '';
        draw(rc); //update canvas, tables
    })
    .catch(error => {
        console.error('Error uploading file:', error);
        scalingInfo.textContent = 'Upload failed.';
    });
});

// neural net
function runUNet() {
    if (cv_mask) {
        mode = "mapCV";
        draw(rc);
        return;
    }

    const mapPath = cqc.mapFile;
    if (!mapPath) {
        alertBox.innerHTML = `<span style="color: red;">Keine Karte geladen</span>`;
        return;
    }

    const scale = cqc.scale;
    const prediction_time = Math.round(
        5 + scale / 0.7104 * image.naturalWidth * image.naturalHeight * 4 / 1_000_000
    );

    alertBox.innerHTML = `
        <span>
            <i style="font-size: 1rem; padding: 0px 5px"
               class="fa-solid fa-spinner fa-spin-pulse"></i>
            Geschätzte Dauer für neurales Netzwerk: ${prediction_time}s
            <button onclick="cancelNN()">
                <i class="fa-solid fa-x fa-sm" style="font-size: 0.8rem;"></i>
            </button>
        </span>
    `;

    const filename = mapPath.split('/').pop();
    const url = `/pathfinding/run_unet/?filename=${encodeURIComponent(filename)}&scale=${encodeURIComponent(scale)}`;

    nnController = new AbortController();
    const signal = nnController.signal;

    fetch(url, { signal })
        .then(response => {
            if (!response.ok) {
                return response.text().then(t => { throw new Error(t); });
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";

            function read() {
                return reader.read().then(({ done, value }) => {
                    if (done) return;

                    buffer += decoder.decode(value, { stream: true });
                    let parts = buffer.split("\n\n");
                    buffer = parts.pop(); // keep last incomplete chunk

                    for (const part of parts) {
                        try {
                            const dataLines = part
                                .split("\n")
                                .filter(l => l.startsWith("data: "));

                            if (!dataLines.length) continue;

                            const dataString = dataLines
                                .map(l => l.slice(5).trim())
                                .join("\n");

                            if (!dataString) continue;
                            if (dataString.length > 500_000) continue;

                            const data = JSON.parse(dataString);

                            if (data.current !== undefined && data.total !== undefined) {
                                alertBox.innerHTML = renderUNetProgress(data.current, data.total);
                            } else if (data.done) {
                                cv_mask = true;
                                markUnsaved();

                                const basename = filename.split('.').slice(0, -1).join('.');
                                const maskUrl = `/pathfinding/get_mask/mask_${basename}.png`;

                                if (!mask) {
                                    mask = new Image();
                                    mask.crossOrigin = "anonymous";
                                }

                                mask.onload = () => {
                                    alertBox.innerHTML = "UNet-Maske generiert";
                                    processMaskImage(mask);
                                    draw(rc);
                                };

                                mask.src = maskUrl;
                                mode = "mapCV";
                            } else if (data.error) {
                                alertBox.innerHTML = `<span style="color:red;">${data.error}</span>`;
                            }

                        } catch (e) {
                            console.warn("Skipped invalid SSE chunk:", e);
                        }
                    }

                    return read();
                });
            }

            return read();
        })
        .catch(err => {
            if (err.name === "AbortError") return;
            alertBox.innerHTML = `<span style="color:red;">Error: ${err.message}</span>`;
        });
}

function cancelNN() {
    if (nnController) {
        nnController.abort();
        nnController = null;
        alertBox.innerHTML = `<span style="color:red;">Neurales Netzwerk abgebrochen</span>`;
    }
}

// editing mask functions
function addCVBlock() {
    subMode = "add";
    draw(rc);
}

function removeCVBlock() {
    subMode = "remove";
    draw(rc);
}

function saveCanvas() {
    const updatedCanvas = updateMaskFromEdits(mask);

    // Extract base name from cqc.mapFile
    const fullPath = cqc.mapFile;  // e.g., "/media/maps/forest_map.jpg"
    const baseName = fullPath.split('/').pop().split('.')[0];  // "forest_map"
    const maskFilename = `mask_${baseName}.png`;

    updatedCanvas.toBlob(blob => {
        const formData = new FormData();
        formData.append('mask', blob, maskFilename);

        fetch('/pathfinding/upload-mask/', {
            method: 'POST',
            body: formData,
            headers: {
                'X-CSRFToken': getCSRFToken()
            },
            credentials: 'include'
        })
        .then(response => {
            if (!response.ok) throw new Error('Upload failed');
            return response.json();
        })
        .then(data => {
            alertBox.innerHTML = "Maske gespeichert";
            markUnsaved();
        })
        .catch(error => {
            alertBox.innerHTML = error;
        });
    }, 'image/png');
}

function updateMaskFromEdits(mask) {
    const w = mask.width, h = mask.height;

    // Draw original mask into a new canvas to get its data
    const originalCanvas = document.createElement('canvas');
    originalCanvas.width = w;
    originalCanvas.height = h;
    const originalCtx = originalCanvas.getContext('2d');
    originalCtx.drawImage(mask, 0, 0);
    const maskImageData = originalCtx.getImageData(0, 0, w, h);
    const maskData = maskImageData.data;

    // Get editCanvas pixel data (red drawing)
    const editedImageData = editCtx.getImageData(0, 0, w, h);
    const editedData = editedImageData.data;

    // Process pixel-by-pixel
    for (let i = 0; i < maskData.length; i += 4) {
        const origR = maskData[i], origG = maskData[i + 1], origB = maskData[i + 2], origA = maskData[i + 3];
        const editR = editedData[i], editG = editedData[i + 1], editB = editedData[i + 2], editA = editedData[i + 3];

        const wasBlack = (origR === 0 && origG === 0 && origB === 0 && origA > 0);
        const isRed = (editR === 255 && editG === 0 && editB === 0 && editA === 255);

        if (isRed && !wasBlack) {
            maskData[i] = 0;
            maskData[i + 1] = 0;
            maskData[i + 2] = 0;
            maskData[i + 3] = 255;
        } else if (!isRed && wasBlack) {
            maskData[i] = 230; //tune
            maskData[i + 1] = 230;
            maskData[i + 2] = 230;
            maskData[i + 3] = 255;
        }
        // Else: leave as-is
    }

    // Write the updated mask data back to originalCanvas or wherever needed
    originalCtx.putImageData(maskImageData, 0, 0);

    // Return the updated canvas or blob if needed
    return originalCanvas;
}

function processMaskImage(mask) {
    // Create off-screen editCanvas
    editCanvas.width = mask.width;
    editCanvas.height = mask.height;
    const scaledWidth = mask.naturalWidth * TRAIN_SCALE;
    const scaledHeight = mask.naturalHeight * TRAIN_SCALE;
    // Draw and extract pixel data
    editCtx.drawImage(mask, 0, 0);
    const imgData = editCtx.getImageData(0, 0, mask.width, mask.height);
    const data = imgData.data;

    // Create a new blank ImageData
    const newImageData = editCtx.createImageData(mask.width, mask.height);
    const newData = newImageData.data;

    // Copy only black pixels as red
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (r === 0 && g === 0 && b === 0 && a > 0) {
            newData[i] = 255;     // Red
            newData[i + 1] = 0;
            newData[i + 2] = 0;
            newData[i + 3] = 255; // Fully opaque
        } else {
            newData[i + 3] = 0;   // Transparent
        }
    }

    // ✅ Write filtered data to editCanvas
    editCtx.putImageData(newImageData, 0, 0);

    mc.clearRect(0,0,maskCanvas.width, maskCanvas.height);
}

function startDraw(event) {
    isEditing = true;
    editing(event); // draw immediately on click
    editingCursor(event);
}

function stopDraw() {
    isEditing = false;
    mc.beginPath(); // reset path
    draw(rc);
}

function stopDrawSave() {
    isEditing = false;
    mc.beginPath(); // reset path
    draw(rc);
    saveCanvas();
}

function editingCursor(event) {
    ec.clearRect(0, 0, editLiveCanvas.width, editLiveCanvas.height);

    const rect = editLiveCanvas.getBoundingClientRect();

    // Calculate cursor position relative to the canvas and account for transforms
    mc.setTransform(1, 0, 0, 1, 0, 0); // reset transform
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (subMode == "add") {
        ec.beginPath();
        ec.arc(x, y, BrushRadius*scale*TRAIN_SCALE, 0, Math.PI * 2);
        ec.strokeStyle = "black";
        ec.lineWidth = 1;
        ec.stroke();
    } else if (subMode == "remove") {
        ec.beginPath();
        ec.arc(x, y, BrushRadius*scale*TRAIN_SCALE, 0, Math.PI * 2);
        ec.strokeStyle = "black";
        ec.lineWidth = 1;
        ec.stroke();   
    }
}

function drawPixelCircle(ctx, centerX, centerY, radius, color = [255, 0, 0, 255]) {
    const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    const data = imageData.data;

    const r2 = radius * radius;

    const xStart = Math.max(0, Math.floor(centerX - radius));
    const xEnd = Math.min(ctx.canvas.width, Math.ceil(centerX + radius));
    const yStart = Math.max(0, Math.floor(centerY - radius));
    const yEnd = Math.min(ctx.canvas.height, Math.ceil(centerY + radius));

    for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
            const dx = x - centerX;
            const dy = y - centerY;
            if (dx * dx + dy * dy <= r2) {
                const index = (y * ctx.canvas.width + x) * 4;
                data[index] = color[0];     // R
                data[index + 1] = color[1]; // G
                data[index + 2] = color[2]; // B
                data[index + 3] = color[3]; // A
            }
        }
    }

    ctx.putImageData(imageData, 0, 0);
}

function eraseCircle(editCtx, centerX, centerY, radius) {
    const imgData = editCtx.getImageData(0, 0, editCtx.canvas.width, editCtx.canvas.height);
    const data = imgData.data;
    const w = imgData.width;
    const h = imgData.height;

    const rSq = radius * radius;

    // Loop over a square bounding box around the circle
    const xStart = Math.max(0, Math.floor(centerX - radius));
    const xEnd = Math.min(w - 1, Math.ceil(centerX + radius));
    const yStart = Math.max(0, Math.floor(centerY - radius));
    const yEnd = Math.min(h - 1, Math.ceil(centerY + radius));

    for (let y = yStart; y <= yEnd; y++) {
        for (let x = xStart; x <= xEnd; x++) {
            const dx = x - centerX;
            const dy = y - centerY;
            if (dx*dx + dy*dy <= rSq) {
                const idx = 4 * (y * w + x);
                // Set pixel fully transparent:
                data[idx + 3] = 0;
            }
        }
    }

    editCtx.putImageData(imgData, 0, 0);
}

function drawCircle(mc, x, y, radius, color = 'red') {
    mc.beginPath();
    mc.arc(x, y, radius, 0, 2 * Math.PI);
    mc.fillStyle = color;
    mc.fill();
}

function editing(event) {
    if (!isEditing) return;

    const rect = maskCanvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / scale - transX / scale;
    const y = (event.clientY - rect.top) / scale - transY / scale;

    if (subMode === "add") {
        editCtx.fillStyle = "rgba(255,0,0,1)";
        drawPixelCircle(editCtx, Math.round(x/TRAIN_SCALE), Math.round(y/TRAIN_SCALE), BrushRadius)
        // Show live feedback directly on mc (screen canvas)
        mc.save();
        mc.setTransform(1, 0, 0, 1, 0, 0); // reset transform
        mc.fillStyle = "rgba(255,0,0,1)";
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;
        drawCircle(mc, canvasX, canvasY, BrushRadius*scale*TRAIN_SCALE);
        mc.restore();

    } else if (subMode === "remove") {
        eraseCircle(editCtx, Math.round(x/TRAIN_SCALE), Math.round(y/TRAIN_SCALE), BrushRadius);

        // Normal smooth erase circle on mc:
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;
        mc.save();
        mc.setTransform(1, 0, 0, 1, 0, 0);
        mc.beginPath();
        mc.arc(canvasX, canvasY, BrushRadius*scale*TRAIN_SCALE, 0, 2 * Math.PI);
        mc.globalCompositeOperation = 'destination-out';
        mc.fill();
        mc.globalCompositeOperation = 'source-over';
        mc.restore();
    }
}

function drawMask() {
    if (!editCanvas) return;
    if (mode == "mapCV" && !loading) {
        // Ensure maskCanvas always matches routeCanvas dimensions
        if (maskCanvas.width !== routeCanvas.width || maskCanvas.height !== routeCanvas.height) {
            maskCanvas.width = routeCanvas.width;
            maskCanvas.height = routeCanvas.height;
        }

        if (mask != undefined && mask != null) {
            mc.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
            mc.save();
            mc.setTransform(scale, 0, 0, scale, transX, transY);
            const scaledWidth = mask.naturalWidth * TRAIN_SCALE;
            const scaledHeight = mask.naturalHeight * TRAIN_SCALE;
            mc.drawImage(editCanvas, 0, 0, scaledWidth, scaledHeight);
            mc.restore(); // safer than manually resetting to identity
        }
    }
}

// pathfinding
function addFinalPathAsRoute(finalPath) {

    if (!finalPath || !Array.isArray(finalPath)) {
    console.error("Invalid finalPath provided");
    return;
  }
  
  if (!cqc || !cqc.cP || !cqc.cP[ncP]) {
    console.error("Global cqc.cP[ncP] not defined");
    return;
  }

  if (!Number.isInteger(nR)) {
    console.error("Invalid route index nR");
    return;
  }
  
  pushUndoState();
  const newRoute = gen_route();

  newRoute.rP = finalPath.map(([x, y]) => {
    const point = gen_rP();
    point.x = x;
    point.y = y;
    return point;
  });

  newRoute.length = newRoute.rP.length;
  newRoute.noA = 0;
  newRoute.elevation = 0;
  newRoute.runTime = null;
  newRoute.pos = null;

  if (!Array.isArray(cqc.cP[ncP].route)) {
    cqc.cP[ncP].route = [];
  }

  // Insert newRoute at insertIndex
    cqc.cP[ncP].route.push(newRoute);
    nR = cqc.cP[ncP].route.length - 1; // Set nR to the index of the new route
    calcLength();
    calcSide();
    calcDir();

    draw(rc);
}

function send_pathfinding() {
    alertBox.innerHTML = 'Pathfinding vorbereiten <i style="font-size: 1rem; padding: 0px 10px" class="fa-solid fa-spinner fa-spin-pulse"></i> <button id="cancelPF" onclick="cancelPathfinding()"><i class="fa-solid fa-x fa-sm" style="font-size: 0.8rem;"></i></button>';

    if (cqc.cP[ncP].complex == false && cqc.cP[ncP].route.length == 2) {
        alertBox.innerHTML = "Bei Links/Rechts-Posten maximal 2 Routen";
        return;
    }

    // Create AbortController
    pfController = new AbortController();
    const signal = pfController.signal;

    fetch("/pathfinding/find/", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-CSRFToken": getCSRFToken(),
        },
        body: JSON.stringify({
            ...cqc.cP[ncP],
            mapFile: cqc.mapFile,
            blockedTerrain: cqc.blockedTerrain,
        }),
        signal
    }).then(response => {
        if (!response.ok) {
            throw new Error("Network response was not ok");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        function read() {
            return reader.read().then(({ done, value }) => {
                if (done) {
                    pfController = null; // clear controller
                    return;
                }

                buffer += decoder.decode(value, { stream: true });

                // Split on SSE messages
                let parts = buffer.split("\n\n");
                buffer = parts.pop(); // incomplete last part

                for (const part of parts) {
                    const dataLines = part.split("\n").filter(line => line.startsWith("data: "));
                    if (dataLines.length === 0) continue;

                    const dataString = dataLines.map(line => line.slice(5).trim()).join("\n");

                    try {
                        const data = JSON.parse(dataString);

                        if (data.waypoint !== undefined && data.total !== undefined) {
                            alertBox.innerHTML = renderProgressBar(data.waypoint, data.total);
                        } else if (data.final_path !== undefined) {
                            alertBox.innerHTML = "Route generiert";
                            addFinalPathAsRoute(data.final_path);
                            markUnsaved();
                        } else if (data.error) {
                            alertBox.innerHTML = data.error;
                        }

                    } catch (e) {
                        console.error("Error parsing SSE JSON", e);
                    }
                }

                return read();
            });
        }

        return read();
    }).catch(err => {
        if (err.name === "AbortError") {
            alertBox.innerHTML = "<span style='color:red;'>Pathfinding abgebrochen</span>";
        } else {
            alertBox.innerHTML = err.message;
            console.error("Fetch error:", err);
        }
        pfController = null;
    });
}

function cancelPathfinding() {
    if (pfController) {
        pfController.abort(); // abort the fetch
        pfController = null;
    }
}

// MAIN DRAW 
function draw(tc) {
    if (!isEditingElevation) {
        resizeCanvas(); //change canvas according to window changes
        tc.setTransform(1,0,0,1,0,0); //reset transformation matrix (for clearing)
        tc.clearRect(0,0,routeCanvas.width,routeCanvas.height); //clear canvas
        tc.setTransform(scale, 0, 0, scale, transX, transY); //go back to transformation matrix
        if (cqc.mapFile) { //check if image is loaded
            drawScaledImage(image); //draw background map
        }
        drawRoutes(); //draw routes
        drawStart(); //draw all start controls
        drawZiel(); //draw all finish controls
        drawConnection(); //draw connecting lines
        drawBlockedLines();
        drawBlockedAreas();
        liveDraw(); //draw live elements
        drawMask();
        updateTableC(), updateTableR(); updateTableI(); updateTableM();//draw tables
    }
}

function resizeCanvas() {
    //follow window size change
    routeCanvas.width = window.innerWidth;
    routeCanvas.height = window.innerHeight;
    maskCanvas.width = window.innerWidth;
    maskCanvas.height = window.innerHeight;
    editLiveCanvas.width = window.innerWidth;
    editLiveCanvas.height = window.innerHeight;
}

function drawScaledImage(image) {
    const src = imgBitmap ?? image;  // use bitmap if available
    const scaledWidth = src.width * cqc.scale;
    const scaledHeight = src.height * cqc.scale;
    rc.drawImage(src, 0, 0, scaledWidth, scaledHeight);
}

// update tables
function updateTableI() {
    if (instructionBox.innerHTML == "") {
        instructionBox.style.display = "none";
    } else {
        instructionBox.style.display = "block";
    }
}

function updateTableM() {
    if (mode == "mapCV") {
        routeCanvas.style.opacity = 0.5;
        maskCanvas.style.display = "block";
        editLiveCanvas.style.display = "block";
        buttonCV.style.backgroundColor = "green";
        addCVBlocked.style.visibility = "visible";
        removeCVBlocked.style.visibility = "visible";
        addCVBlocked.style.backgroundColor = "white";
        removeCVBlocked.style.backgroundColor = "white";
        blockArea.style.visibility = "hidden";
        blockLine.style.visibility = "hidden";
        buttonBlock.style.backgroundColor = "white";
        blockRemove.style.visibility = "hidden";


        if (subMode == "add") {
            addCVBlocked.style.backgroundColor = "yellow";
        } else if (subMode == "remove") {
            removeCVBlocked.style.backgroundColor = "yellow";
        }

    } else if (mode == "drawSperre") {
        routeCanvas.style.opacity = 1;
        maskCanvas.style.display = "none";
        buttonCV.style.backgroundColor = "white";
        buttonBlock.style.backgroundColor = "green";
        addCVBlocked.style.visibility = "hidden";
        removeCVBlocked.style.visibility = "hidden";
        blockArea.style.visibility = "visible";
        blockLine.style.visibility = "visible";
        blockRemove.style.visibility = "visible";
        
        if (subModeB == "line") {
            blockLine.style.backgroundColor = "yellow";
            blockArea.style.backgroundColor = "white";
            blockRemove.style.backgroundColor = "white";

        } else if (subModeB == "area") {
            blockArea.style.backgroundColor = "yellow";
            blockLine.style.backgroundColor = "white";
            blockRemove.style.backgroundColor = "white";

        } else {
            blockRemove.style.backgroundColor = "yellow";
            blockLine.style.backgroundColor = "white";
            blockArea.style.backgroundColor = "white";
        }

    } else {
        routeCanvas.style.opacity = 1;
        maskCanvas.style.display = "none";
        editLiveCanvas.style.display = "none";
        buttonCV.style.backgroundColor = "white";
        addCVBlocked.style.visibility = "hidden";
        removeCVBlocked.style.visibility = "hidden";
        blockArea.style.visibility = "hidden";
        blockLine.style.visibility = "hidden";
        buttonBlock.style.backgroundColor = "white";
        blockRemove.style.visibility = "hidden";
    }
}

function updateTableC() {
    const tableBody = document.querySelector('#controlPairsTable tbody');
    tableBody.innerHTML = ''; //clear existing rows
    //add a row for each control pair
    cqc.cP.forEach((cp, i) => {
        const row = document.createElement('tr');
        row.classList.add('tableRowMain');
        const td = document.createElement('td');
        td.classList.add('tableCellMain');
        td.textContent = `Posten ${i+1}`; //write control numbers
        td.addEventListener('click', function() {setcP(i);}); //function to jump to the respective control pair
        td.style.setProperty('--td-background-color', '#D6EEEE'); //hover color change

        if (i == ncP) {
            td.style.backgroundColor  = "yellow"; //highlight current control pair
        }
        else {
            td.style.backgroundColor  = "white"; //highlight current control pair
        }
        //add cells, rows
        row.appendChild(td);

        const tdtc = document.createElement('td');
        tdtc.classList.add('tableCellMain');
        tdtc.textContent = 'M'; //write control numbers
        if (cqc.cP[i].complex) {
            tdtc.style.backgroundColor  = "#6699ff"; //highlight current control pair
        }
        else {
            tdtc.style.backgroundColor  = "white"; //highlight current control pair
        }

        tdtc.onclick = () => {
            cqc.cP[i].complex = true;
            draw(rc); //update canvas, tables
        };

        row.appendChild(tdtc);

        const tdtb = document.createElement('td');
        tdtb.classList.add('tableCellMain');
        tdtb.textContent = 'L/R'; //write control numbers
        if (!cqc.cP[i].complex) {
            tdtb.style.backgroundColor  = "#6699ff"; //highlight current control pair
        }
        else {
            tdtb.style.backgroundColor  = "white"; //highlight current control pair
        }
        tdtb.onclick = () => {
            if(cqc.cP[i].route.length > 2) { //check if route array is not empty
                alert("Bei Links/Rechts-Posten maximal 2 Routen");
            }
            else {
                cqc.cP[i].complex = false;
                markUnsaved();
                draw(rc); //update canvas, tables
            }
        };

        row.appendChild(tdtb);

        tableBody.appendChild(row);
    });

    //add last row for new control
    const row = document.createElement('tr');
    row.classList.add('tableRowMain');
    const td = document.createElement('td');
    td.classList.add('tableCellMain');
    const nb = document.createElement('nobr'); //prevent line break for longer text
    nb.textContent = "neuer Posten";
    nb.addEventListener('click', function() {setcP(cqc.cP.length);}); //function to jump to the last control pair
    nb.style.setProperty('--td-background-color', '#D6EEEE'); //hover color change

    if (cqc.cP.length == ncP) {
        td.style.backgroundColor  = "yellow"; //highlight if drawing new control pair
    }
    else {
        td.style.backgroundColor  = "white"; //highlight current control pair
    }
    //add cells, rows
    td.appendChild(nb);
    row.appendChild(td);
    tableBody.appendChild(row);
        
    //table and div size formatting
    headC.style.height = cth.offsetHeight + 'px';
    cth.style.width = divC.offsetWidth + 'px';
        
    //go to bottom of scrollable content on new entries
    if (ncP >= cqc.cP.length) {
        tableC.scrollTop = tableC.scrollHeight;
    }
    
    const availableHeight = window.innerHeight - divM.offsetHeight/2*3; //available height for table div

    // Set table height: minimum of content height or availableHeight
    if (cpt.scrollHeight < availableHeight) {
        tableC.style.height = cpt.scrollHeight + "px";
    } else {
        tableC.style.height = availableHeight + "px";
    }
    
    //change background color according to tool mode
    if (mode == "placeControls"){
        buttonControl.style.backgroundColor = "green";
    } else {
        buttonControl.style.backgroundColor = "white";
    }
}

function updateTableR() {
    const tableBody = document.querySelector('#routesTable tbody');
    tableBody.innerHTML = ''; //clear existing rows
    
    if (mode == "drawRoutes"){
        buttonRoute.style.backgroundColor = "green";
    } else {
        buttonRoute.style.backgroundColor = "white";
    }
    
    if (typeof cqc.cP[ncP] == 'undefined') {
        return;
    }
    
    cqc.cP[ncP].route.forEach((r, i) => {
        //create table cells
        const row = document.createElement('tr');
        row.classList.add('tableRowMain');
        const td = document.createElement('td');
        td.classList.add('tableCellMain');
        const tdd = document.createElement('td');
        tdd.classList.add('tableCellMain');
        const tde = document.createElement('td');
        tde.classList.add('tableCellMain');
        const inputE = document.createElement('input');
        inputE.classList.add('elevationinput');

        inputE.addEventListener('focus', () => {
            inputE.select();
            isEditingElevation = true;
            inputE.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    isEditingElevation = false;
                    inputE.blur(); // Remove focus from the input field
                }
            });
        });

        inputE.addEventListener('blur', () => {
            isEditingElevation = false;
            if (!isNaN(inputE.value)) {
                cqc.cP[ncP].route[i].elevation = inputE.value;
            }
        });

        inputE.placeholder = cqc.cP[ncP].route[i].elevation;
        inputE.value = cqc.cP[ncP].route[i].elevation || ''; // optional if you want it prefilled

        //fill table cells
        td.textContent = `Route ${i+1}`;
        tdd.textContent = cqc.cP[ncP].route[i].length;
        
        td.addEventListener('click', function() {setR(i);}); //function to jump to route
        td.style.setProperty('--td-background-color', '#D6EEEE'); //set hover
        
        //highlight current route
        if (i == nR) {
            td.style.backgroundColor  = "yellow";
            tdd.style.backgroundColor  = "yellow";
            tde.style.backgroundColor  = "yellow";
        }
        else {
            td.style.backgroundColor  = "white";
            tdd.style.backgroundColor  = "white";
            tde.style.backgroundColor  = "white";
        }
        //add rows, cells
        tde.appendChild(inputE);
        row.appendChild(td);
        row.appendChild(tdd);
        row.appendChild(tde);
        tableBody.appendChild(row);
    });
    
    //add additional row for new route
    if (mode == "drawRoutes") {
        const row = document.createElement('tr');
        row.classList.add('tableRowMain');
        const tdR = document.createElement('td');
        tdR.classList.add('tableCellMain');

        const nb = document.createElement('nobr'); //prevent line break
        nb.textContent = "neue Route";
        nb.addEventListener('click', function() {setR(cqc.cP[ncP].route.length);}); //function for new route
        nb.style.setProperty('--td-background-color', '#D6EEEE'); //set hover
        //highlight current route
        if (cqc.cP[ncP].route.length == nR) {
            tdR.style.backgroundColor  = "yellow";
        }
        else {
            tdR.style.backgroundColor  = "white";
        }
        //add row, cell
        tdR.appendChild(nb);
        row.appendChild(tdR);

        const tdZ = document.createElement('td');
        tdZ.classList.add('tableCellMain');
        tdZ.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
        tdZ.style.backgroundColor  = "white";
        tdZ.style.setProperty('--td-background-color', '#D6EEEE'); //set hover
        tdZ.title = "Zaubern (Z)";
        tdZ.addEventListener('click', send_pathfinding); //function for new route
        row.appendChild(tdZ);
        tableBody.appendChild(row);
    }	

    //limit div height
    if (rpt.scrollHeight < 600) {
        tableR.style.height = rpt.scrollHeight + "px";
    }
    else {
        tableR.style.height = "600px";
    }
}

//draw cursors depending on mode
function liveDraw() {
    switch (mode){
        case "placeControls": //when drawing controls
            if (!isDragging) { //don't draw circle when dragging
                rc.strokeStyle = "rgb(160, 51, 240,0.8)";
                rc.lineWidth = 3;
                rc.beginPath();
                rc.arc(liveX, liveY, R_CONTROL, 0, 2 * Math.PI);
                rc.stroke();
                
                drawCursor(rc);
                
                if(cDraw) { //live draw connection line to live cursor position
                    let angleC = Math.atan2(liveY - cqc.cP[ncP].start.y, liveX - cqc.cP[ncP].start.x);
                    let distC = distance({x: liveX, y: liveY}, cqc.cP[ncP].start);

                    if (distC > 2*(R_CONTROL+10)){
                        rc.strokeStyle = "rgb(160, 51, 240,0.8)";
                        rc.lineWidth = 2;
                        //connection line with offset
                        rc.beginPath();
                        rc.moveTo(
                            cqc.cP[ncP].start.x + Math.cos(angleC)*(R_CONTROL+10),
                            cqc.cP[ncP].start.y + Math.sin(angleC)*(R_CONTROL+10)
                        );
                        rc.lineTo(
                            liveX - Math.cos(angleC)*(R_CONTROL+10),
                            liveY - Math.sin(angleC)*(R_CONTROL+10)
                        );
                        rc.stroke();
                    }
                }

            }
        break;
        case "drawRoutes": //when drawing routes
            drawCursor(rc);
            if(rDraw){ //live draw route segment preview to cursor
                rc.lineWidth = 1;
                rc.strokeStyle = "yellow";
                rc.beginPath();
                rc.moveTo(cqc.cP[ncP].route[nR].rP[nRP-1].x,cqc.cP[ncP].route[nR].rP[nRP-1].y);
                rc.lineTo(liveX,liveY);
                rc.stroke();
            }
        break;
        case "scaleMap": //when scaling map
            drawCursor(rc);
            if (nsP == 1) {
                const tickSpacing = 20; // Distance between ticks
                const smallTickLength = 20; // Length of small ticks
                const largeTickLength = 40; // Length of large ticks

                // Compute direction vector
                const dx = liveX - cqc.sP.p1.x;
                const dy = liveY - cqc.sP.p1.y;
                const length = Math.sqrt(dx * dx + dy * dy);
                const unitX = dx / length;
                const unitY = dy / length;

                // Draw the scale line
                rc.lineWidth = 5;
                rc.strokeStyle = "black";
                rc.beginPath();
                rc.moveTo(cqc.sP.p1.x, cqc.sP.p1.y);
                rc.lineTo(liveX, liveY);
                rc.stroke();

                // Draw tick marks along the line
                for (let i = 0; i <= length; i += tickSpacing) {
                    const tickX = cqc.sP.p1.x + unitX * i;
                    const tickY = cqc.sP.p1.y + unitY * i;
                    
                    // Every 5th tick is larger
                    const isLargeTick = (i / tickSpacing) % 5 === 0;
                    const tickLength = isLargeTick ? largeTickLength : smallTickLength;

                    // Perpendicular vector for tick direction
                    const perpX = -unitY * tickLength;
                    const perpY = unitX * tickLength;

                    rc.beginPath();
                    rc.moveTo(tickX - perpX / 2, tickY - perpY / 2);
                    rc.lineTo(tickX + perpX / 2, tickY + perpY / 2);
                    rc.stroke();
                }
            }
        break;
        case "mapCV":
            drawCursor(mc);
        break;
        case "drawSperre":
            if (subModeB == "remove") {
                    rc.beginPath();
                    rc.arc(liveX, liveY, 10, 0, 2 * Math.PI);
                    rc.strokeStyle = "black";
                    rc.lineWidth = 0.5;
                    rc.stroke();
            }
            else {
                drawCursor(rc);
            }
            if (currentBlockLine) {
                rc.beginPath();
                rc.strokeStyle = "rgb(160, 51, 240,1)";
                rc.lineWidth = 5*cqc.scale;

                rc.moveTo(currentBlockLine.start.x, currentBlockLine.start.y);
                rc.lineTo(liveX, liveY);

                rc.stroke();
            }
            // live polygon preview
            if (currentBlockArea) {
                const pts = currentBlockArea.points;

                if (pts.length >= 1) {
                    rc.beginPath();
                    rc.moveTo(pts[0].x, pts[0].y);

                    for (let i = 1; i < pts.length; i++) {
                        rc.lineTo(pts[i].x, pts[i].y);
                    }

                    // rubber-band to cursor
                    rc.lineTo(liveX, liveY);

                    // close visually (cursor → start)
                    if (pts.length >= 2) {
                        rc.lineTo(pts[0].x, pts[0].y);

                        // ✅ LIVE fill (lighter alpha)
                        rc.fillStyle = "rgba(160, 51, 240, 0.15)";
                        rc.fill();
                    }

                    // ✅ outline
                    rc.strokeStyle = "rgba(160, 51, 240, 1)";
                    rc.lineWidth = 1 * cqc.scale;
                    rc.stroke();
                }
            }
        break;
    }
}

function drawCursor(tc) {
    tc.strokeStyle = "#000";
    tc.lineWidth = 1;
    tc.beginPath();
    tc.moveTo(liveX-MARKER_LENGTH,liveY-MARKER_LENGTH);
    tc.lineTo(liveX+MARKER_LENGTH,liveY+MARKER_LENGTH);
    tc.stroke();
    tc.beginPath();
    tc.moveTo(liveX-MARKER_LENGTH,liveY+MARKER_LENGTH);
    tc.lineTo(liveX+MARKER_LENGTH,liveY-MARKER_LENGTH);
    tc.stroke();
}

function drawStart() {
    for (let i = 0; i < cqc.cP.length; i++) { //iterate over all first controls
        rc.beginPath();

        rc.arc(cqc.cP[i].start.x, cqc.cP[i].start.y, R_CONTROL, 0, 2 * Math.PI); //draw circle
        if (i == ncP && !cDraw){
            rc.lineWidth = 5; //current control
        } else {
            rc.lineWidth = 3; //all other controls
        }
        rc.strokeStyle = "rgb(160, 51, 240,0.8)";
        rc.stroke();
    }
}

function drawZiel() {
    for (let i = 0; i < cqc.cP.length; i++) { //iterate over all second controls
        if (cqc.cP[i].ziel.x) {
        rc.beginPath();
        rc.arc(cqc.cP[i].ziel.x, cqc.cP[i].ziel.y, R_CONTROL, 0, 2 * Math.PI); //draw circle
        if (i == ncP){
            rc.lineWidth = 5; //current control
        } else {
            rc.lineWidth = 3; //all other controls
        }
        rc.strokeStyle = "rgb(160, 51, 240,0.8)";
        rc.stroke();
        }
    }
}

function drawConnection() {
    for (let i = 0; i < cqc.cP.length; i++) {
        if (cqc.cP[i].ziel.x) {
            const start = cqc.cP[i].start;
            const ziel = cqc.cP[i].ziel;

            const angleC = Math.atan2(ziel.y - start.y, ziel.x - start.x);
            const distC = Math.sqrt(Math.pow(ziel.x - start.x, 2) + Math.pow(ziel.y - start.y, 2));

            if (distC > 2 * (R_CONTROL + 10)) {
                rc.beginPath();
                rc.lineWidth = i == ncP ? 5 : 3; // Thicker line for selected pair
                rc.moveTo(start.x + Math.cos(angleC) * (R_CONTROL + 10), start.y + Math.sin(angleC) * (R_CONTROL + 10));
                rc.lineTo(ziel.x - Math.cos(angleC) * (R_CONTROL + 10), ziel.y - Math.sin(angleC) * (R_CONTROL + 10));
                rc.stroke();

                // Only draw arrow for the selected pair
                if (i == ncP) {
                    drawConnectionArrow(start, ziel, angleC);
                }
            }
        }
    }
}

function drawRoutes() {
    cqc.cP.forEach((pair, indexC) => {
        if (indexC !== ncP) {

            // Draw grey path on top
            rc.beginPath();
            rc.globalAlpha = 0.5;
            pair.route.forEach(route => {
                route.rP.forEach((point, idx) => {
                    if (idx === 0) {
                        rc.moveTo(point.x, point.y);
                    } else {
                        rc.lineTo(point.x, point.y);
                    }
                });
            });
            rc.strokeStyle = 'black';
            rc.lineWidth = 2;
            rc.stroke();
            rc.globalAlpha = 1;
        }
    });

    // Draw the selected route (black on white)
    if (cqc.cP[ncP]) { 
        rc.beginPath();
        cqc.cP[ncP].route.forEach(route => {
            route.rP.forEach((point, idx) => {
                if (idx === 0) {
                    rc.moveTo(point.x, point.y);
                } else {
                    rc.lineTo(point.x, point.y);
                }
            });
        });
        rc.strokeStyle = 'white';
        rc.lineWidth = 4;
        rc.stroke();

        rc.beginPath();
        cqc.cP[ncP].route.forEach(route => {
            route.rP.forEach((point, idx) => {
                if (idx === 0) {
                    rc.moveTo(point.x, point.y);
                } else {
                    rc.lineTo(point.x, point.y);
                }
            });
        });
        rc.strokeStyle = 'black';
        rc.lineWidth = 2;
        rc.stroke();
    }

    // Draw the red yellow on top
    if (cqc.cP[ncP] && cqc.cP[ncP].route[nR]) {  
        rc.beginPath();
        cqc.cP[ncP].route[nR].rP.forEach((point, idx) => {
            if (idx === 0) {
                rc.moveTo(point.x, point.y);
            } else {
                rc.lineTo(point.x, point.y);
            }
        });

        rc.strokeStyle = 'yellow';
        rc.lineWidth = 2;
        rc.stroke();
    }

    drawRouteContinuation(rc);
}

function drawRouteContinuation(rc) {
    if (!editContinuation || !editRoute) return;

    rc.save();

    rc.beginPath();

    editContinuation.forEach((point, idx) => {
        if (idx === 0) {
            rc.moveTo(point.x, point.y);
        } else {
            rc.lineTo(point.x, point.y);
        }
    });

    rc.strokeStyle = CONTINUATION_COLOR;
    rc.lineWidth = CONTINUATION_WIDTH;
    rc.stroke();

    rc.restore();
}

function drawConnectionArrow(start, ziel, angle) {
    const arrowSize = 25; // Arrow length
    const arrowAngle = Math.PI / 6; // 30° angle

    // Midpoint of the connection line
    const midX = (start.x + ziel.x) / 2;
    const midY = (start.y + ziel.y) / 2;

    // Calculate arrow line endpoints
    const arrowX1 = midX - Math.cos(angle - arrowAngle) * arrowSize;
    const arrowY1 = midY - Math.sin(angle - arrowAngle) * arrowSize;
    
    const arrowX2 = midX - Math.cos(angle + arrowAngle) * arrowSize;
    const arrowY2 = midY - Math.sin(angle + arrowAngle) * arrowSize;

    // Draw arrow for selected pair
    rc.beginPath();
    rc.moveTo(midX, midY);
    rc.lineTo(arrowX1, arrowY1);
    rc.moveTo(midX, midY);
    rc.lineTo(arrowX2, arrowY2);
    rc.lineWidth = 5;
    rc.stroke();
}

function drawBlockedLines() {
    rc.strokeStyle = "rgb(160, 51, 240,1)";
    rc.lineWidth = 6;

    cqc.blockedTerrain.lines.forEach(line => {
        rc.beginPath();
        rc.moveTo(line.start.x, line.start.y);
        rc.lineTo(line.end.x, line.end.y);
        rc.stroke();
    });
}

function drawBlockedAreas() {
    cqc.blockedTerrain.areas.forEach(area => {
        const pts = area.points;
        if (!pts || pts.length < 3) return;

        rc.beginPath();
        rc.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            rc.lineTo(pts[i].x, pts[i].y);
        }
        rc.closePath();

        rc.fillStyle = "rgb(160, 51, 240,0.5)";
        rc.fill();

        // --- Hatch fill --- (only for athletes)
        //fillPolygonHatch(pts, 45, 13*cqc.scale);
        //fillPolygonHatch(pts, -45, 13*cqc.scale);

    });
}

// helper functions
function pan(amount) {
    transX += amount.x, transY += amount.y; //change translation 
    draw(rc); //update canvas, tables
}

function calcTransf(amount,e) {
    transX = e.offsetX - (e.offsetX - transX)*amount;
    transY = e.offsetY - (e.offsetY - transY)*amount;
    return transX, transY;
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function isNear(p, x, y, r = PICK_RADIUS) {
    return Math.hypot(p.x - x, p.y - y) <= r;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) {
        // line is a point
        return Math.hypot(px - x1, py - y1);
    }

    // Project point onto the segment
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx*dx + dy*dy)));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    return Math.hypot(px - projX, py - projY);
}

function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y;
        const xj = pts[j].x, yj = pts[j].y;

        const intersect = ((yi > y) !== (yj > y)) &&
                          (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function calcLength() {
    let route = cqc.cP[ncP].route[nR];

    let routeLength = 0;

    // Iterate through each pair of consecutive points in the route
    for (let i = 1; i < route.rP.length; i++) {
        // Calculate the distance between the current and previous points
        const deltaX = route.rP[i].x - route.rP[i - 1].x;
        const deltaY = route.rP[i].y - route.rP[i - 1].y;
        const segmentLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY)*0.48;

        // Add the segment length to the total length
        routeLength += segmentLength;
    }

    // Round the total length and assign it to the appropriate data structure
    routeLength = Math.round(routeLength);
    // Assign the calculated length to your data structure (for example, rData)
    cqc.cP[ncP].route[nR].length = routeLength;
}

function calcDir() {
    let route = cqc.cP[ncP].route[nR];
    // Initialize sharp angle counter
    let sharpAngle = 0;
    // Iterate through each pair of consecutive segments in the route
    for (let i = 1; i < route.rP.length - 1; i++) {
        // Calculate the vectors for the current and previous segments
        const prevVector = [
            route.rP[i].x - route.rP[i - 1].x,
            route.rP[i].y - route.rP[i - 1].y
        ];
        const currentVector = [
            route.rP[i + 1].x - route.rP[i].x,
            route.rP[i + 1].y - route.rP[i].y
        ];

        // Calculate the dot product between the current and previous vectors
        const dotProduct = prevVector[0] * currentVector[0] + prevVector[1] * currentVector[1];

        // Calculate the magnitudes of the vectors
        const prevMagnitude = Math.sqrt(prevVector[0] * prevVector[0] + prevVector[1] * prevVector[1]);
        const currentMagnitude = Math.sqrt(currentVector[0] * currentVector[0] + currentVector[1] * currentVector[1]);

        // Calculate the cosine of the angle between the vectors
        const cosTheta = dotProduct / (prevMagnitude * currentMagnitude);

        // Calculate the angle in radians
        const theta = Math.acos(cosTheta);

        // Convert the angle to degrees
        const chAngle = theta * (180 / Math.PI);

        // Check if the angle is sharp (greater than 60 degrees) and increment the sharp angle counter
        if (chAngle > 60) {
            sharpAngle += 1;
        }
    }
    // Store the sharp angle count for the current route in the appropriate data structure
    cqc.cP[ncP].route[nR].noA = sharpAngle;
}

function calcSide() {
    const pair = cqc.cP[ncP];
    const route = pair.route[nR];
    const routePoints = route.rP;

    const start = pair.start;
    const ziel = pair.ziel;
    const dx = ziel.x - start.x;
    const dy = ziel.y - start.y;

    let sum = 0;
    for (const p of routePoints) {
        const px = p.x - start.x;
        const py = p.y - start.y;
        sum += dx * py - dy * px;
    }

    route.pos = sum / routePoints.length;
}

function fillPolygonHatch(points, angleDeg = 45, spacing = 2) {
    rc.save();

    // build polygon path
    rc.beginPath();
    rc.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        rc.lineTo(points[i].x, points[i].y);
    }
    rc.closePath();
    rc.clip();

    // calculate bounds
    const bounds = polygonBounds(points);
    const diag = Math.hypot(
        bounds.maxX - bounds.minX,
        bounds.maxY - bounds.minY
    );

    // rotate hatch lines
    rc.translate(bounds.minX, bounds.minY);
    rc.rotate(angleDeg * Math.PI / 180);

    rc.strokeStyle = "red";
    rc.lineWidth = 2;

    for (let x = -diag; x < diag * 2; x += spacing) {
        rc.beginPath();
        rc.moveTo(x, -diag);
        rc.lineTo(x, diag * 2);
        rc.stroke();
    }

    rc.restore();
}

function polygonBounds(points) {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    points.forEach(p => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    });

    return { minX, minY, maxX, maxY };
}

function drawLoadingAnimation(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = (timestamp - startTime) / 1000; // seconds

    const centerX = routeCanvas.width / 2;
    const centerY = routeCanvas.height / 2;
    const baseRadius = routeCanvas.height/20
    const radiusList = [baseRadius-10, baseRadius, baseRadius+10];
    const speedList = [1, 0.7, 0.4]; // radians per second
    const colorList = ['#666', '#999', '#ccc'];

    // Clear canvas
    rc.clearRect(0, 0, routeCanvas.width, routeCanvas.height);

    for (let i = 0; i < 3; i++) {
        const radius = radiusList[i];
        const angle = elapsed * speedList[i] * Math.PI * 2;
        const startAngle = angle;
        const endAngle = angle + Math.PI * 1.2;
        rc.setTransform(1,0,0,1,0,0);
        rc.beginPath();
        rc.strokeStyle = colorList[i];
        rc.lineWidth = 4;
        rc.arc(centerX, centerY, radius, startAngle, endAngle);
        rc.stroke();
    }

    if (loading) {
        requestAnimationFrame(drawLoadingAnimation);
    } else {
        draw(rc);
    }
}

function normalizeCQC(cqc) {
    if (!cqc.blockedTerrain) {
        cqc.blockedTerrain = { lines: [], areas: [] };
    } else {
        cqc.blockedTerrain.lines ??= [];
        cqc.blockedTerrain.areas ??= [];
    }
}

function renderProgressBar(current, total, width = 30) {
  // Calculate how many boxes to fill
  const filledCount = Math.round((current / total) * width);
  const emptyCount = width - filledCount;

  const filledBoxes = "█".repeat(filledCount);
  const emptyBoxes = "░".repeat(emptyCount);

  return 'θ* pathfinding ' + filledBoxes + emptyBoxes + `<i style="font-size: 1rem; padding: 0px 10px" class="fa-solid fa-spinner fa-spin-pulse"></i> <button id="cancelPF"><i class="fa-solid fa-x fa-sm" style="font-size: 0.8rem;"></i></button>`;
}

function renderUNetProgress(current, total, width = 30) {
  const filledCount = Math.round((current / total) * width);
  const emptyCount = width - filledCount;

  const filledBoxes = "█".repeat(filledCount);
  const emptyBoxes = "░".repeat(emptyCount);

  return (
    'Fortschritt ' +
    filledBoxes +
    emptyBoxes +
    `<i style="font-size: 1rem; padding: 0px 10px"
        class="fa-solid fa-spinner fa-spin-pulse"></i> <button onclick="cancelNN()"><i class="fa-solid fa-x fa-sm" style="font-size: 0.8rem;"></i></button>`
  );
}

function renderBatchProgressBar(current, total, width = 15) {
    const filledCount = Math.round((current / total) * width);
    const emptyCount = width - filledCount;
    const filledBoxes = "█".repeat(filledCount);
    const emptyBoxes = "░".repeat(emptyCount);
    return `${filledBoxes}${emptyBoxes} ${current}/${total}`;
}