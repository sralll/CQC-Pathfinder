let ncP = 0;
let ncP_max = 0;
let results = {};
let prog_distance = [];
let shortest_route_runtime = [];
let tabledata = {};
let avg_times = [];
let selectedUsers = [];
let selectedCumulativeDiffs = {};
let startTime = null; // To track the start time of the animation
let image = new Image();
let startTransform = null; // To store the starting transformation matrix
let targetTransform = null; // To store the target transformation matrix
const rControl = 25;		//radius of control circle

const userColors = [
    '#ff1e1e', // red
    '#00c000', // blue
    '#2626ff', // green
    '#00c0c0', // purple
    '#c618c6', // orange
    '#ff9901', // yellow
];

const routeColor = ["#FFFF00", "#FF0000", "#FF00FF", "#0000FF", "#00FFFF", "#00FF00"];

const canvas = document.getElementById('OLchart');
const ctx = canvas.getContext('2d');


const canvasMap = document.getElementById('resultMapCanvas');
const ctxM = canvasMap.getContext('2d');

canvasMap.height = 600;
canvasMap.width = 400;

const canvasMapHeight = canvasMap.clientHeight;
const canvasMapWidth = canvasMap.clientWidth;

// --- Helper: Parse URL parameters ---
function getUrlParameter(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
}

window.onload = function () {
    resultsSpinner = document.getElementById("resultsSpinner");
    resultsSpinner.style.display = "flex";
    fetch('/get_published_files/')
        .then(response => response.json())
        .then(filenames => {
            const dropdown = document.getElementById('jsonDropdown');

            // Populate filenames, skipping the default option which is already in the HTML
            filenames.forEach(filename => {
                const displayName = filename.replace('.json', '');
                const option = document.createElement('option');
                option.value = filename;
                option.textContent = displayName;
                dropdown.appendChild(option);
            });

            // Check if a filename is passed via URL
            const gameParam = getUrlParameter('game');
            if (gameParam) {
                const filenameWithExtension = gameParam;
                const optionExists = filenames.includes(filenameWithExtension);
                if (optionExists) {
                    dropdown.value = filenameWithExtension;
                    dropdown.dispatchEvent(new Event('change')); // Trigger the loading
                }
            }
            resultsSpinner.style.display = "none";
        })
        .catch(error => console.error('Error fetching filenames:', error));
};

function home() {
    window.location.href = "/";
}

// --- Handle dropdown change ---
document.getElementById('jsonDropdown').addEventListener('change', function () {
    const selectedFilename = this.value;

    if (selectedFilename != ""){
    const tableBody = document.getElementById('userTableBody');
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 20px;">
                    <i style="font-size: 2rem; padding: 0px 5px" class="fa-solid fa-spinner fa-spin-pulse"></i>
                </td>
            </tr>
        `;
    }

    // Clear canvas
    const canvas = document.getElementById('OLchart');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Clear previously selected checkboxes
    document.querySelectorAll('.userCheckbox').forEach(cb => cb.checked = false);

    // Reset global variables
    prog_distance = [];
    results = [];
    shortest_route_runtime = [];
    tabledata = [];
    avg_times = [];
    selectedUsers = [];
    ncP = 0;

    document.getElementById("resultLegend").innerHTML = "";
    document.getElementById("currentControl").textContent = `Posten 1`;

    if (!selectedFilename) return;

    const dbName = selectedFilename.replace('.json', '');

    fetch(`/fetch_plot_data/${dbName}/`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("Server error:", data.error);
                return;
            }

            // Assign data to global variables
            prog_distance = data.distances;
            results = data.results;
            shortest_route_runtime = data.shortest_route_runtime;
            tabledata = data.tableData;
            avg_times = data.avg_times;
        })
        .then(() => {
            const tableBody = document.getElementById('userTableBody');
            tableBody.innerHTML = '';

            tabledata.forEach(user => {
                const userTimes = calculateUserTimes(user);

                const row = document.createElement('tr');
                row.innerHTML = `
                    <td><input type="checkbox" class="userCheckbox" data-user-id="${user.user_id}" id="userCheckbox${user.user_id}"></td>
                    <td class="tableName">${user.full_name}</td>
                    <td class="tableTime">${formatTime(user.total_choice_time)}</td>
                    <td class="tableTime">${formatTime(user.total_diff_runtime)}</td>
                    <td class="tableTime">${formatTime(user.total_sum)}</td>
                `;
                tableBody.appendChild(row);
            });

            // Attach event listeners to checkboxes
            document.querySelectorAll('.userCheckbox').forEach(checkbox => {
                checkbox.addEventListener('change', event => {
                    const userId = parseInt(event.target.dataset.userId);

                    if (event.target.checked) {
                        if (!selectedUsers.includes(userId)) {
                            selectedUsers.push(userId);
                        }
                    } else {
                        selectedUsers = selectedUsers.filter(id => id !== userId);
                    }

                    selectedUsers.sort((a, b) => {
                        const indexA = tabledata.findIndex(user => user.user_id === a);
                        const indexB = tabledata.findIndex(user => user.user_id === b);
                        return indexA - indexB;
                    });

                    const completionTable = document.getElementById('completionTable');
                    const canvasWidth = completionTable.offsetWidth;
                    canvas.width = canvasWidth;
                    canvas.style.width = canvasWidth + 'px';

                    const scaling = calcPlotScaling();
                    draw(scaling);
                });
            });
        })
        .catch(err => {
            console.error("Fetch failed:", err);
        });
    loadGameData(dbName);
});


function calcPlotScaling() {
    const cumulativeDiffs = [];

    selectedUsers.forEach(userId => {
        const user = results.find(u => u.user_id === userId);
        if (!user) return;

        let cumulative = 0;
        let userCumulative = [];
        user.controls.forEach((control, i) => {
            const avg_time = avg_times[i]?.average_fastest_time || 0;
            const diff = control.choice_time +
                        control.selected_route_runtime -
                        control.shortest_route_runtime -
                        avg_time;

            cumulative += diff;
            cumulativeDiffs.push(cumulative);
            userCumulative.push(cumulative);
        });
        selectedCumulativeDiffs[userId] = userCumulative;
    });
    if (cumulativeDiffs.length === 0) {
        return { min: 0, max: 0, offset: 0, scale: 1, marginTop: 0, marginBottom: 0 };
    }

    const min = Math.min(0, ...cumulativeDiffs);
    const max = Math.max(0, ...cumulativeDiffs);
    const range = max - min || 1;

    const canvasHeight = canvas.height;
    const topMargin = 0.05 * canvasHeight;
    const bottomMargin = 0.05 * canvasHeight;
    const usableHeight = canvasHeight - topMargin - bottomMargin;

    const scale = usableHeight / range;
    const offset = min; // Still subtract min so 0 is at top of usable area

    return {
        min,
        max,
        offset,
        scale,
        topMargin,
        bottomMargin,
    };
}

function loadGameData(filename) {
    const encodedFilename = encodeURIComponent(filename);
    const url = `/play/load-file/${encodedFilename}/`;

    // Start spinner
    loading = true;
    requestAnimationFrame(drawLoadingAnimation);

    fetch(url)
        .then(response => response.json())
        .then(response => {
            cqc = response.data;               // original JSON file contents
            missingCPs = response.missingCPs;  // list of missing control points

            if (missingCPs.length === 0) {
                missingCPs = Array.from({ length: cqc.cP.length }, (_, i) => i);
                duplicateGame = true;
            } else {
                duplicateGame = false;
            }

            game_file = filename.replace('.json', '');
            cqc_filename = filename;

            // Load image
            image = new Image();
            image.src = cqc.mapFile;

            image.onload = () => {
                loading = false; // Stop spinner
            };

            image.onerror = () => {
                loading = false;
                alert("Failed to load image");
            };
        })
        .catch(error => {
            loading = false;
            alert("Failed to load game data");
            console.error("Error loading file:", error);
        });
}

function drawLoadingAnimation(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = (timestamp - startTime) / 1000; // seconds

    const centerX = resultMapCanvas.width / 2;
    const centerY = resultMapCanvas.height / 2;
    const baseRadius = resultMapCanvas.height/20
    const radiusList = [baseRadius-10, baseRadius, baseRadius+10];
    const speedList = [1, 0.7, 0.4]; // radians per second
    const colorList = ['#666', '#999', '#ccc'];

    // Clear canvas
    ctxM.clearRect(0, 0, resultMapCanvas.width, resultMapCanvas.height);

    for (let i = 0; i < 3; i++) {
        const radius = radiusList[i];
        const angle = elapsed * speedList[i] * Math.PI * 2;
        const startAngle = angle;
        const endAngle = angle + Math.PI * 1.2;
        ctxM.setTransform(1,0,0,1,0,0);
        ctxM.beginPath();
        ctxM.strokeStyle = colorList[i];
        ctxM.lineWidth = 4;
        ctxM.arc(centerX, centerY, radius, startAngle, endAngle);
        ctxM.stroke();
    }

    if (loading) {
        requestAnimationFrame(drawLoadingAnimation);
    } else {
        calcTransform(ncP); // Just use first control point for now
        ctxM.setTransform(...targetTransform);
        drawMap();
        drawBlockedLines();
        drawBlockedAreas();
        drawCP(ncP);
        const routeColors = drawRoutes(ncP);
        drawLegend(ncP, routeColors);
    }
}

function nextControlResults() {
    if (ncP < cqc.cP.length - 1) {
        ncP++;
        calcTransform(ncP); // Just use first control point for now
        ctxM.setTransform(...targetTransform);
        drawMap();
        drawBlockedLines();
        drawBlockedAreas();
        drawCP(ncP);
        const routeColors = drawRoutes(ncP);
        drawLegend(ncP, routeColors);
        document.getElementById("currentControl").textContent = `Posten ${ncP+1}`;
        
        const scaling = calcPlotScaling();
        draw(scaling);
    }
}

function prevControlResults() {
    if (ncP > 0) {
        ncP--;
        calcTransform(ncP); // Just use first control point for now
        ctxM.setTransform(...targetTransform);
        drawMap();
        drawBlockedLines();
        drawBlockedAreas();
        drawCP(ncP);
        const routeColors = drawRoutes(ncP);
        drawLegend(ncP, routeColors);
        document.getElementById("currentControl").textContent = `Posten ${ncP+1}`;
        const scaling = calcPlotScaling();
        draw(scaling);
    }
}

function drawMap() {
    ctxM.drawImage(image, 0, 0);
}

function drawCP(ncP) {
    ctxM.beginPath();
    ctxM.arc(cqc.cP[ncP].start.x/cqc.scale, cqc.cP[ncP].start.y/cqc.scale, rControl/cqc.scale, 0, 2 * Math.PI);
    ctxM.strokeStyle = "rgb(160, 51, 240,0.8)";
    ctxM.lineWidth = 3/cqc.scale;
    ctxM.stroke();

    ctxM.beginPath(ncP);
    ctxM.arc(cqc.cP[ncP].ziel.x/cqc.scale, cqc.cP[ncP].ziel.y/cqc.scale, rControl/cqc.scale, 0, 2 * Math.PI);
    ctxM.strokeStyle = "rgb(160, 51, 240,0.8)";
    ctxM.lineWidth = 3/cqc.scale;
    ctxM.stroke();

    const angleC = Math.atan2(cqc.cP[ncP].ziel.y - cqc.cP[ncP].start.y, cqc.cP[ncP].ziel.x - cqc.cP[ncP].start.x);
    const distC = Math.sqrt(
        Math.pow(cqc.cP[ncP].ziel.x - cqc.cP[ncP].start.x, 2) +
        Math.pow(cqc.cP[ncP].ziel.y - cqc.cP[ncP].start.y, 2)
    );
    if (distC > 2 * (rControl)) {
        ctxM.beginPath();
        ctxM.lineWidth = 3/cqc.scale;
        ctxM.strokeStyle = "rgb(160, 51, 240,0.8)";
        ctxM.moveTo(cqc.cP[ncP].start.x/cqc.scale + Math.cos(angleC) * (rControl + 0)/cqc.scale,
            cqc.cP[ncP].start.y/cqc.scale + Math.sin(angleC) * (rControl + 0)/cqc.scale);
        ctxM.lineTo(cqc.cP[ncP].ziel.x/cqc.scale - Math.cos(angleC) * (rControl + 0)/cqc.scale,
            cqc.cP[ncP].ziel.y/cqc.scale - Math.sin(angleC) * (rControl + 0)/cqc.scale);
        ctxM.stroke();
    }
}

function reduceColors(length) {
    let indices = Array.from({ length: routeColor.length }, (_, i) => i);

    for (let i = 0; indices.length != cqc.cP[ncP].route.length; i++) {
        const j = Math.floor(Math.random() * (indices.length));
        indices.splice(j, 1);
    }

    return indices;
}

function drawRoutes(ncP)  {
    ctxM.beginPath();
    cqc.cP[ncP].route.forEach((route, nR) => {
        ctxM.beginPath();
        route.rP.forEach((point, idx) => {
            if (idx === 0) {
                ctxM.moveTo(point.x / cqc.scale, point.y / cqc.scale);
            } else {
                ctxM.lineTo(point.x / cqc.scale, point.y / cqc.scale);
            }
        });
        ctxM.strokeStyle = "white";
        ctxM.lineWidth = 4 / cqc.scale;
        ctxM.stroke();
    });

    const sortedIndices = generateSortedIndicesByPos(cqc.cP[ncP].route);
    const colorPicker = reduceColors(cqc.cP[ncP].route.length);

    // Build a mapping: routeIndex → color
    const routeColors = {};

    // Draw routes in randomized order
    sortedIndices.forEach((index, indexColor) => {
        const route = cqc.cP[ncP].route[index];
        const color = routeColor[colorPicker[indexColor]];
        routeColors[index] = color;

        ctxM.beginPath();
        route.rP.forEach((point, idx) => {
            if (idx === 0) {
                ctxM.moveTo(point.x / cqc.scale, point.y / cqc.scale);
            } else {
                ctxM.lineTo(point.x / cqc.scale, point.y / cqc.scale);
            }
        });

        ctxM.strokeStyle = color;
        ctxM.lineWidth = 3 / cqc.scale;
        ctxM.stroke();
    });

    return routeColors; // <— return mapping
}

function drawLegend(ncP, routeColors) {
    const legendContainer = document.getElementById("resultLegend");
    legendContainer.innerHTML = ""; // clear old stuff

    const routes = cqc.cP[ncP].route;
    const wrapper = document.createElement("div");

    // Prepare buckets for each route + N/A
    const routeBuckets = routes.map(() => []);
    const noRouteUsers = [];

    // Distribute users once
    results.forEach(user => {
        const control = user.controls.find(c => c.index === ncP);
        if (control) {
            if (control.selected_route !== null && control.selected_route !== undefined) {
                if (routeBuckets[control.selected_route]) {
                    routeBuckets[control.selected_route].push({
                        name: user.full_name,
                        choice_time: control.choice_time
                    });
                }
            } else {
                noRouteUsers.push({
                    name: user.full_name,
                    choice_time: control.choice_time
                });
            }
        }
    });

    // Draw all route categories
    routes.forEach((route, routeIndex) => {
        const routeColorValue = routeColors[routeIndex] || "black";

        const header = document.createElement("h3");
        header.textContent = `Route ${routeIndex + 1} (${route.length}m, ${route.elevation}Hm, ${route.runTime.toFixed(0)}s)`;
        header.style.fontWeight = "bold";
        header.style.fontSize = "1.2em";
        header.style.margin = "8px 0 4px";
        header.style.padding = "4px";
        header.style.backgroundColor = hexToRgba(routeColorValue, 0.66);

        const subUl = document.createElement("ul");
        subUl.style.marginLeft = "20px";
        subUl.style.listStyleType = "disc";
        subUl.style.maxHeight = "200px";
        subUl.style.overflowY = "auto";

        routeBuckets[routeIndex].forEach(u => {
            const subLi = document.createElement("li");
            subLi.textContent = `${u.name} (${u.choice_time.toFixed(2)}s)`;
            subLi.style.fontWeight = "normal";
            subLi.style.fontSize = "1em";
            subLi.style.color = "black";
            subUl.appendChild(subLi);
        });

        wrapper.appendChild(header);
        wrapper.appendChild(subUl);
    });

    legendContainer.appendChild(wrapper);
}



function hexToRgba(hex, alpha = 0.3) {
    // Remove leading #
    hex = hex.replace(/^#/, '');

    // Parse r,g,b
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function generateSortedIndicesByPos(route) {
    // Create an array of indices
    const indices = Array.from({ length: route.length }, (_, index) => index);

    // Sort indices based on the route[nR].pos value
    indices.sort((a, b) => route[a].pos - route[b].pos);

    return indices;
}

function calcTransform(ncP) {
    // Calculate the midpoint between start and ziel
    const midX = (cqc.cP[ncP].start.x + cqc.cP[ncP].ziel.x) / 2;
    const midY = (cqc.cP[ncP].start.y + cqc.cP[ncP].ziel.y) / 2;

    // Target position (center of the canvas)
    const targetX = canvasMap.width / 2;
    const targetY = canvasMap.height / 2;

    // Compute angle (rotation)
    const dx = (cqc.cP[ncP].ziel.x - cqc.cP[ncP].start.x);
    const dy = (cqc.cP[ncP].ziel.y - cqc.cP[ncP].start.y);
    const angle = Math.atan2(dy, dx); // Radians
    const originalLength  = Math.sqrt(dx * dx + dy * dy);

    const targetLength = canvasMapHeight * 0.9; // HARDCODED for now
    let scaleFactor_FB = (targetLength) / (originalLength + 2*rControl) * cqc.scale; // Scale factor for the image

    const extremes = findExtremes(cqc.cP[ncP]);
    
    SFL = canvasMapWidth / 2 / extremes.leftDistance * cqc.scale;
    SFR = canvasMapWidth / 2 / extremes.rightDistance * cqc.scale;
    SFF = canvasMapHeight / 2 / extremes.forwardDistance * cqc.scale;
    SFB = canvasMapHeight / 2 / extremes.backwardDistance * cqc.scale;

    let scaleFactor = 0.98*Math.min(SFL, SFR, SFF, SFB, scaleFactor_FB); // Scale factor for the image
    const cosA = Math.cos(-angle - Math.PI / 2);
    const sinA = Math.sin(-angle - Math.PI / 2);

    // Set the target transformation matrix
    targetTransform = [
        scaleFactor * cosA,
        scaleFactor * sinA,
        -scaleFactor * sinA,
        scaleFactor * cosA,
        targetX - (midX / cqc.scale) * scaleFactor * cosA + (midY / cqc.scale) * scaleFactor * sinA,
        targetY - (midX / cqc.scale) * scaleFactor * sinA - (midY / cqc.scale) * scaleFactor * cosA
    ];

    // Store the current transformation matrix
    startTransform = ctx.getTransform();
}

function findExtremes(pair) {
    const start = pair.start;
    const ziel = pair.ziel;
    const dx = ziel.x - start.x;
    const dy = ziel.y - start.y;
    const norm = Math.sqrt(dx * dx + dy * dy);

    // Midpoint coordinates
    const midX = (start.x + ziel.x) / 2;
    const midY = (start.y + ziel.y) / 2;

    let maxRight = 0;
    let maxLeft = 0;
    let maxForward = 0;
    let maxBackward = 0;

    pair.route.forEach(route => {
        route.rP.forEach(p => {
            const px = p.x - midX;
            const py = p.y - midY;

            // Left/right: perpendicular (cross product)
            const cross = dx * py - dy * px;
            const sideDistance = cross / norm;
            if (sideDistance > maxRight) maxRight = sideDistance;
            if (sideDistance < maxLeft) maxLeft = sideDistance;

            // Forward/backward: projection on the line (dot product)
            const dot = px * dx + py * dy;
            const projection = dot / norm;

            if (projection > maxForward) maxForward = projection;
            if (projection < maxBackward) maxBackward = projection;
        });
    });

    return {
        leftDistance: Math.abs(maxLeft),
        rightDistance: maxRight,
        forwardDistance: maxForward,
        backwardDistance: Math.abs(maxBackward)
    };
}

function drawUserLine(userId, index, scaling) {
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // Define margins
    const leftMargin = 0.06 * canvasWidth;
    const rightMargin = 0.925 * canvasWidth;

    // Find max distance to scale x values
    const maxDistance = Math.max(...prog_distance);
    if (maxDistance === 0) return;

    const xCoords = prog_distance.map(distance => {
        return leftMargin + ((distance / maxDistance) * (rightMargin - leftMargin));
    });
    const yCoords = selectedCumulativeDiffs[userId].map(value => {
        return scaling.topMargin + ((value - scaling.offset) * scaling.scale);
    });

    ctx.strokeStyle = userColors[index % userColors.length];
    ctx.lineWidth = 1;
    ctx.beginPath();
        ctx.moveTo(leftMargin, scaling.topMargin - scaling.offset * scaling.scale);

        for (let i = 0; i < xCoords.length; i++) {
            ctx.lineTo(xCoords[i], yCoords[i]);
        }
    ctx.stroke();

    const fullName = tabledata.find(u => u.user_id === userId)?.full_name || '';
    const canvasName = fullName.substring(0, 3);

    ctx.textAlign = 'left'; // Set text alignment to left
    ctx.textBaseline = 'middle'; // Set text baseline to middle
    ctx.font = "14px Arial";
    ctx.fillStyle = userColors[index % userColors.length];
    ctx.fillText(canvasName, xCoords[xCoords.length - 1] + 5, yCoords[yCoords.length - 1])
}

function drawGridX() {
    if (!prog_distance || prog_distance.length === 0) return;

    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // Define margins
    const leftMargin = 0.06 * canvasWidth;
    const rightMargin = 0.925 * canvasWidth;
    const totalDistance = prog_distance[prog_distance.length - 1] || 1; // Avoid divide-by-zero

    ctx.save(); // Save canvas state
    ctx.strokeStyle = 'grey';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftMargin, 0);
    ctx.lineTo(leftMargin, canvasHeight);
    ctx.stroke();

    prog_distance.forEach(distance => {
        // Adjust x-coordinate for the left and right margins
        const x = leftMargin + ((distance / totalDistance) * (rightMargin - leftMargin));

        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasHeight);
        ctx.stroke();
    });

    const prevDistance = (ncP > 0) ? prog_distance[ncP - 1] : 0;

    const leftX = leftMargin + ((prevDistance / totalDistance) * (rightMargin - leftMargin));
    const rightX = leftMargin + ((prog_distance[ncP] / totalDistance) * (rightMargin - leftMargin));

    const rectWidth = rightX - leftX;

    // Draw filled rectangle
    ctx.fillStyle = "rgba(255, 0, 0, 0.2)"; // transparent red
    ctx.fillRect(leftX, 0, rectWidth, canvasHeight);

    ctx.restore(); // Restore canvas state
}

function drawGridY(scaling) {
    const canvasHeight = canvas.height;
    const canvasWidth = canvas.width;

    const topMargin = scaling.topMargin ?? 0.05 * canvasHeight;
    const bottomMargin = scaling.bottomMargin ?? 0.05 * canvasHeight;
    const usableHeight = canvasHeight - topMargin - bottomMargin;

    const leftMargin = 0.06 * canvasWidth;
    const rightMargin = 0.925 * canvasWidth;

    // Determine how many lines can be drawn with at least 100px spacing
    const maxLines = Math.floor(canvasHeight / 75);
    const totalRange = scaling.max - scaling.min || 1;
    const rawInterval = totalRange / maxLines;

    // Round interval to a "nice" number
    function roundToNiceInterval(x) {
        const magnitude = Math.pow(10, Math.floor(Math.log10(x)));
        const residual = x / magnitude;
        if (residual <= 1) return 1 * magnitude;
        if (residual <= 2) return 2 * magnitude;
        if (residual <= 5) return 5 * magnitude;
        return 10 * magnitude;
    }

    const interval = roundToNiceInterval(rawInterval);
    const startYVal = Math.ceil(scaling.min / interval) * interval;
    ctx.beginPath();
    ctx.moveTo(leftMargin, 1);
    ctx.lineTo(leftMargin, canvasHeight - 1);
    ctx.lineTo(rightMargin, canvasHeight - 1);
    ctx.lineTo(rightMargin, 1);
    ctx.lineTo(leftMargin, 1);
    ctx.strokeStyle = 'black';
    ctx.stroke();

    ctx.save();
    ctx.strokeStyle = 'grey';
    ctx.lineWidth = 1;
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#666';

    for (let yVal = startYVal; yVal <= scaling.max; yVal += interval) {
        // Correct y-value transformation:
        const yCanvas = topMargin + (yVal - scaling.offset) * scaling.scale;

        ctx.beginPath();
        ctx.moveTo(leftMargin, yCanvas);
        ctx.lineTo(rightMargin, yCanvas);
        ctx.stroke();

        // Label the line
        ctx.textAlign = 'right'; // Set text alignment to right
        ctx.textBaseline = 'middle'; // Set text baseline to middle
        ctx.fillText(`${yVal.toFixed(0)}s`, 0.06*canvasWidth-3, yCanvas);
    }

    ctx.restore();
}

function draw(scaling) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGridX();
    drawGridY(scaling);
    selectedUsers.forEach((userId, index) => {
        drawUserLine(userId, index, scaling);
    });
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function calculateUserTimes(user) {
    let choice_time_sum = 0;
    let route_diff_sum = 0;

    for (const index in user.controls) {
        const controlIndex = parseInt(index);
        const control = user.controls[controlIndex];

        const choiceTime = control.choice_time || 0;
        const selectedRuntime = control.selected_route_runtime || 0;
        const shortestRuntime = shortest_route_runtime[controlIndex] || 0;

        choice_time_sum += choiceTime;
        route_diff_sum += selectedRuntime - shortestRuntime;
    }

    return {
        choice_time: choice_time_sum,
        route_diff: route_diff_sum,
        total: choice_time_sum + route_diff_sum
    };
}

function drawBlockedLines() {
    ctxM.strokeStyle = "rgb(160, 51, 240,1)";
    ctxM.lineWidth = 10; // scale line width like controls

    cqc.blockedTerrain.lines.forEach(line => {
        ctxM.beginPath();
        ctxM.moveTo(line.start.x / cqc.scale, line.start.y / cqc.scale);
        ctxM.lineTo(line.end.x / cqc.scale, line.end.y / cqc.scale);
        ctxM.stroke();
    });
}

function drawBlockedAreas() {
    cqc.blockedTerrain.areas.forEach(area => {
        const pts = area.points;
        if (!pts || pts.length < 3) return;

        // --- Scale points ---
        const scaledPts = pts.map(p => ({ x: p.x / cqc.scale, y: p.y / cqc.scale }));

        // --- Hatch fill only ---
        fillPolygonHatch(scaledPts, 45, 13);   // spacing in pixels (already scaled)
        fillPolygonHatch(scaledPts, -45, 13);
    });
}

function fillPolygonHatch(points, angleDeg = 45, spacing = 2) {
    ctxM.save();

    // build polygon path
    ctxM.beginPath();
    ctxM.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        ctxM.lineTo(points[i].x, points[i].y);
    }
    ctxM.closePath();
    ctxM.clip();

    // calculate bounds
    const bounds = polygonBounds(points);
    const diag = Math.hypot(
        bounds.maxX - bounds.minX,
        bounds.maxY - bounds.minY
    );

    // rotate hatch lines
    ctxM.translate(bounds.minX, bounds.minY);
    ctxM.rotate(angleDeg * Math.PI / 180);

    ctxM.strokeStyle = "rgb(160, 51, 240,1)";
    ctxM.lineWidth = 4;

    for (let x = -diag; x < diag * 2; x += spacing) {
        ctxM.beginPath();
        ctxM.moveTo(x, -diag);
        ctxM.lineTo(x, diag * 2);
        ctxM.stroke();
    }

    ctxM.restore();
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