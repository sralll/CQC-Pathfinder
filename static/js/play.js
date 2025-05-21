const clientWidth = window.innerWidth;
const clientHeight = window.innerHeight;

let cqc = null;
let image = new Image();
let choiceMade = false;

let game_file = null;

let loading = false;
let spinnerAngle = 0;

let startTransform = null; // To store the starting transformation matrix
let targetTransform = null; // To store the target transformation matrix
let animationDuration = 1000; // Duration of the animation in milliseconds (1 second)
let startTime = null; // To track the start time of the animation

const rControl = 25;		//radius of control circle

const routeColor = ["#FFFF00", "#00FFFF", "#FF00FF", "#0000FF"];
let selectedIndex = null; // Store the last clicked index

let lastPressTime = null; // Store the time of the last button press
let timeDiff = null;

const runSpeed = 4.75; // in m/s

let cqc_filename = null;

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// Set canvas dimensions
canvas.height = Math.min(clientHeight*0.75,clientWidth);
canvas.width = Math.min(canvas.height, clientWidth);

const canvasHeight = canvas.clientHeight;
const canvasWidth = canvas.clientWidth;

const answerWrapper = document.getElementById("answerWrapper");

// Set dimensions using style
const answerWrapperHeight = 0.25 * clientHeight;

answerWrapper.style.height = answerWrapperHeight + "px";
answerWrapper.style.width = canvasWidth + "px";
answerWrapper.style.padding = (answerWrapperHeight/12) + "px 0px" ;

const resultBoxWrapper = document.getElementById("resultBoxWrapper");
resultBoxWrapper.style.height = (answerWrapperHeight/4) + "px";
resultBoxWrapper.style.width = canvasWidth + "px";
resultBoxWrapper.style.marginBottom = (answerWrapperHeight/12) + "px" ;

const resultBox = document.getElementById("resultBox");
resultBox.style.padding = 0;
resultBox.style.height = (answerWrapperHeight/4) + "px";


document.addEventListener("DOMContentLoaded", function () {
  const isMobile = document.body.classList.contains("mobile");

  if (isMobile) {
    resultBox.style.fontSize = (resultBox.offsetHeight - 30) + "px";
  } else {
    resultBox.style.fontSize = (resultBox.offsetHeight - 10) + "px";
  }
});

const nextButton = document.getElementById("nextButton");
nextButton.style.height = resultBoxWrapper.offsetHeight-10 + "px";
nextButton.style.fontSize = resultBoxWrapper.offsetHeight-10 + "px";
nextButton.style.marginRight = "5px";

const routeButtonContainer = document.getElementById("routeButtonContainer");
routeButtonContainer.style.height = (answerWrapperHeight/2) + "px";
routeButtonContainer.style.width = canvasWidth + "px";

const modalP = document.getElementById("modalP");
const modalcP = document.getElementById("modalcP");
modalP.style.display = "block";
modalcP.style.display = "block";
loadFileList();
const closeModal = document.getElementById("closeProjects");

function getCSRFToken() {
    return document.querySelector('meta[name="csrf-token"]').getAttribute('content');
}

function openModal() {
    modalP.style.display = "block";
    loadFileList();
}

closeModal.onclick = () => modalP.style.display = "none";

function loadFileList() {
    fetch('/play/get-files/')
        .then(response => response.json())
        .then(files => {
            // Sort files by modified date (latest first)
            files.sort((a, b) => new Date(b.modified) - new Date(a.modified));

            // Get or create the tbody element
            let tbody = fileTable.querySelector('tbody');
            if (!tbody) {
                tbody = document.createElement('tbody');  // Create tbody if it doesn't exist
                fileTable.appendChild(tbody);  // Append tbody to table
            }

            // Clear the existing table rows (inside tbody)
            tbody.innerHTML = '';

            // Loop through each file and add a row
            files.forEach(file => {
                if (!file.published) return;                            
                const row = document.createElement('tr');
                row.classList.add('tableRowProjects');
                row.style.borderBottom = '1px solid #ccc'; // Add a bottom border to each row
                    
                // File name without the extension
                const fileNameCell = document.createElement('td');
                fileNameCell.classList.add('tableCellProjects');
                const fileNameWithoutExtension = file.filename.replace('.json', ''); // Remove the '.json' extension
                const fileNameText = document.createElement('span');
                fileNameText.textContent = fileNameWithoutExtension || 'Unknown'; // Display filename without extension
                    
                // Add hover effect to the table cell (feedback)
                fileNameCell.style.cursor = 'pointer';
                fileNameCell.addEventListener('mouseenter', () => {
                    fileNameCell.style.backgroundColor = '#f0f0f0'; // Light gray background when hovering
                });
                fileNameCell.addEventListener('mouseleave', () => {
                    fileNameCell.style.backgroundColor = ''; // Reset background when not hovering
                });

                // Add click event to set filename in input field (entire cell)
                fileNameCell.addEventListener('click', () => {
                    loadGameData(file.filename); // Call the loadFile function when clicked                        });
                });
                fileNameCell.appendChild(fileNameText);
                row.appendChild(fileNameCell);

                // Number of cP entries
                const cpCountCell = document.createElement('td');
                cpCountCell.classList.add('tableCellProjects');
                const cpCount = file.cPCount; // Count the number of cP entries (if exists)
                cpCountCell.textContent = cpCount; // Display the number of cP entries
                cpCountCell.style.textAlign = 'center'; // Center the text
                row.appendChild(cpCountCell);

                // Last modified time
                const lastModifiedCell = document.createElement('td');
                lastModifiedCell.classList.add('tableCellProjects');
                    
                // Completion Status
                const statusCell = document.createElement('td');
                statusCell.classList.add('tableCellProjects');
                let status = 'neu';
                    statusCell.style.color = 'blue'; // Default background color

                if (file.userEntryCount === file.cPCount) {
                    status = 'erledigt';
                    statusCell.style.color = 'green'; // Default background color

                } else if (file.userEntryCount > 0) {
                    status = 'begonnen';
                    statusCell.style.color = 'orange'; // Default background color

                }
                statusCell.textContent = status;
                statusCell.style.textAlign = 'center';
                row.appendChild(statusCell);


                // Append row to tbody
                tbody.appendChild(row);
            });
        })
        .catch(error => {
            console.error('Error loading file list:', error);
            alert('Failed to load file list');
        });
}

function loadGameData(filename) {
    const encodedFilename = encodeURIComponent(filename);
    const url = `/play/load-file/${encodedFilename}/`;

    // Start spinner
    loading = true;
    animateCanvasSpinner();
    modalP.style.display = 'none';


    fetch(url)
        .then(response => response.json())
        .then(fileData => {
            cqc = fileData;
            game_file = filename.replace('.json', '');
            cqc_filename = filename;

            // Load image
            image = new Image();
            image.src = cqc.mapFile;

            image.onload = () => {
                loading = false; // Stop spinner
                makePreview(); // Draw full game UI
            };

            image.onerror = () => {
                loading = false;
                alert("Failed to load image");
            };
        })
        .catch(error => {
            loading = false;
            alert("Failed to load game data");
        });
}

document.addEventListener("keydown", function(e) {
    if (modalP.style.display === 'block') {
        switch (e.keyCode) {
            case 27: //esc
                modalP.style.display = 'none';
            break
        }
    }
});

document.addEventListener("keydown", function(event) {
    if (event.key === "Enter" && choiceMade == true) { // Check if the pressed key is Enter
        nextControl();
    }
});

// Also, make sure to close the modal when clicking outside of the modal content
window.addEventListener('click', (event) => {
    if (event.target === modalP) {
        modalP.style.display = 'none';
    }
});

function home() {
    window.location.href = "/";
}

function makePreview() {
    if (!image.complete) {
        image.onload = makePreview; // Re-run the function once the image is loaded
        return;
    }
    // Get image dimensions
    const imgWidth = image.naturalWidth;
    const imgHeight = image.naturalHeight;
    
    // Calculate the scale factor to fit the image into the canvas
    const scale = Math.min(canvasWidth / imgWidth, canvasHeight / imgHeight);

    // Calculate new image dimensions
    const newWidth = imgWidth * scale;
    const newHeight = imgHeight * scale;

    // Clear canvas before drawing
    ctx.resetTransform();
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    // Center the image in the canvas
    const offsetX = (canvasWidth - newWidth) / 2;
    const offsetY = (canvasHeight - newHeight) / 2;
    
    // Draw the scaled image centered
    ctx.drawImage(image, 0, 0, imgWidth, imgHeight, offsetX, offsetY, newWidth, newHeight);

    // Create a button dynamically inside resultBox
    const resultBox = document.getElementById("resultBox");
    resultBox.innerHTML = ""; // Clear previous content
    routeButtonContainer.innerHTML = "";

    const startButton = document.createElement("button");
    startButton.id = "startButton";
    startButton.textContent = "Start"
    startButton.style.height = (answerWrapperHeight/4-10) + "px";
    startButton.style.fontSize = (answerWrapperHeight/4-20) + "px";
    startButton.onclick = startGame;

    resultBox.appendChild(startButton);
}


function startGame() {
    ncP = 0;

    resultBox.innerHTML = "Bereit?";
    resultBox.style.color = "blue";
    resultBox.style.backgroundColor = "white";
    startTime = 0;
    ctx.resetTransform();
    ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear canvas

    // Delay the recalculation by 1 second (1000ms)
    setTimeout(function() {
        calcTransform(ncP);
        ctx.setTransform(...targetTransform);
        draw(ncP);
        playTiming();
    }, 1000); // Delay of 1000 milliseconds
}

function nextControl() {
    if (ncP < (cqc.cP.length - 1)) {
        ncP++;
    
        nextButton.style.display = "none";
        resultBox.innerHTML = "Bereit?";
        resultBox.style.color = "blue";
        routeButtonContainer.innerHTML = ""; // Clear existing cells
        startTime = null;
        calcTransform(ncP);
        animateTransition();
        playTiming();
    }
    else {
        window.location.href = `/results/?game=${encodeURIComponent(game_file)}`;
    }
}

// Function to start the animation
function animateTransition() {
    // Ensure the animation loop runs
    requestAnimationFrame(animateStep);
}

function animateStep(timestamp) {
    if (!startTime) startTime = timestamp;
    let elapsedTime = timestamp - startTime;

    // Calculate the progress of the animation (0 to 1)
    let progress = Math.min(elapsedTime / animationDuration, 1);

    // Interpolate between the old transformation and the new one
    const interpolatedTransform = interpolateTransform(startTransform, targetTransform, progress);
    ctx.resetTransform();
    ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear canvas
    //console.log(interpolatedTransform)
    // Apply the interpolated transformation matrix
    ctx.setTransform(...interpolatedTransform);
    drawMap(); // Draw the image

    if (progress < 1) {
        // Continue the animation loop if not done
        requestAnimationFrame(animateStep);
    } else {
        draw(ncP);
        playTiming();
    }
}

// Function to calculate the new transformation matrix and trigger animation
function calcTransform(ncP) {
    // Calculate the midpoint between start and ziel
    const midX = (cqc.cP[ncP].start.x + cqc.cP[ncP].ziel.x) / 2;
    const midY = (cqc.cP[ncP].start.y + cqc.cP[ncP].ziel.y) / 2;

    // Target position (center of the canvas)
    const targetX = canvas.width / 2;
    const targetY = canvas.height / 2;

    // Compute angle (rotation)
    const dx = (cqc.cP[ncP].ziel.x - cqc.cP[ncP].start.x);
    const dy = (cqc.cP[ncP].ziel.y - cqc.cP[ncP].start.y);
    const angle = Math.atan2(dy, dx); // Radians
    const originalLength  = Math.sqrt(dx * dx + dy * dy);

    const targetLength = canvasHeight * 0.9; // HARDCODED for now
    let scaleFactor_FB = (targetLength) / (originalLength + 2*rControl) * cqc.scale; // Scale factor for the image

    const extremes = findExtremes(cqc.cP[ncP]);
    
    SFL = canvasWidth / 2 / extremes.leftDistance * cqc.scale;
    SFR = canvasWidth / 2 / extremes.rightDistance * cqc.scale;
    SFF = canvasHeight / 2 / extremes.forwardDistance * cqc.scale;
    SFB = canvasHeight / 2 / extremes.backwardDistance * cqc.scale;

    let scaleFactor = Math.min(SFL, SFR, SFF, SFB, scaleFactor_FB); // Scale factor for the image
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


// Function to interpolate between two transformation matrices
function interpolateTransform(start, end, progress) {
    return [
        start.a + (end[0] - start.a) * progress,
        start.b + (end[1] - start.b) * progress,
        start.c + (end[2] - start.c) * progress,
        start.d + (end[3]- start.d) * progress,
        start.e + (end[4] - start.e) * progress,
        start.f + (end[5] - start.f) * progress
    ];
}

function drawMap() {
    ctx.drawImage(image, 0, 0);
}

function drawCP(ncP) {
    ctx.beginPath();
    ctx.arc(cqc.cP[ncP].start.x/cqc.scale, cqc.cP[ncP].start.y/cqc.scale, rControl/cqc.scale, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgb(160, 51, 240,0.8)";
    ctx.lineWidth = 3/cqc.scale;
    ctx.stroke();

    ctx.beginPath(ncP);
    ctx.arc(cqc.cP[ncP].ziel.x/cqc.scale, cqc.cP[ncP].ziel.y/cqc.scale, rControl/cqc.scale, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgb(160, 51, 240,0.8)";
    ctx.lineWidth = 3/cqc.scale;
    ctx.stroke();

    const angleC = Math.atan2(cqc.cP[ncP].ziel.y - cqc.cP[ncP].start.y, cqc.cP[ncP].ziel.x - cqc.cP[ncP].start.x);
    const distC = Math.sqrt(
        Math.pow(cqc.cP[ncP].ziel.x - cqc.cP[ncP].start.x, 2) +
        Math.pow(cqc.cP[ncP].ziel.y - cqc.cP[ncP].start.y, 2)
    );
    if (distC > 2 * (rControl)) {
        ctx.beginPath();
        ctx.lineWidth = 3/cqc.scale;
        ctx.strokeStyle = "rgb(160, 51, 240,0.8)";
        ctx.moveTo(cqc.cP[ncP].start.x/cqc.scale + Math.cos(angleC) * (rControl + 0)/cqc.scale,
            cqc.cP[ncP].start.y/cqc.scale + Math.sin(angleC) * (rControl + 0)/cqc.scale);
        ctx.lineTo(cqc.cP[ncP].ziel.x/cqc.scale - Math.cos(angleC) * (rControl + 0)/cqc.scale,
            cqc.cP[ncP].ziel.y/cqc.scale - Math.sin(angleC) * (rControl + 0)/cqc.scale);
        ctx.stroke();
    }
}

function drawRoutes()  {
    if (cqc.cP[ncP].complex) {

        ctx.beginPath();

        cqc.cP[ncP].route.forEach((route, nR) => {
            ctx.beginPath();
            route.rP.forEach((point, idx) => {
                if (idx === 0) {
                    ctx.moveTo(point.x / cqc.scale, point.y / cqc.scale);
                } else {
                    ctx.lineTo(point.x / cqc.scale, point.y / cqc.scale);
                }
            });
            ctx.strokeStyle = "white";
            ctx.lineWidth = 8;
            ctx.stroke();
        });

        const sortedIndices = generateSortedIndicesByPos(cqc.cP[ncP].route);
        
        const colorPicker = reduceColors(cqc.cP[ncP].route.length);
        routeButtonContainer.innerHTML = ""; // Clear existing cells

        const table = document.createElement("table");
        table.id = "routeButtonTable";
        table.style.width = "100%";
        table.style.tableLayout = "fixed";
        table.style.borderCollapse = "collapse";
        table.style.margin = "0px";
        table.style.padding = "0px";
        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");

        choiceMade = false;

        // Draw routes in randomized order
        sortedIndices.forEach((index, indexColor) => {
            const route = cqc.cP[ncP].route[index];
            
            // Begin a new path for each route
            ctx.beginPath();
            route.rP.forEach((point, idx) => {
                if (idx === 0) {
                    ctx.moveTo(point.x / cqc.scale, point.y / cqc.scale);
                } else {
                    ctx.lineTo(point.x / cqc.scale, point.y / cqc.scale);
                }
            });

            // Set the color for the route based on randomized index
            ctx.strokeStyle = routeColor[colorPicker[indexColor]];
            ctx.lineWidth = 6;
            ctx.stroke(); // Stroke the route

            const routeCell = document.createElement("td");
            routeCell.style.border = "1px solid black";
            routeCell.style.backgroundColor = routeColor[colorPicker[indexColor]]; // Assign color
            routeCell.style.cursor = "pointer";
            routeCell.style.height = (answerWrapperHeight/4-3) + "px";

            routeCell.addEventListener("click", () => {
                submitChoice(index, sortedIndices, colorPicker);
            });

            headerRow.appendChild(routeCell);

        });
        thead.appendChild(headerRow);
        table.appendChild(thead);
        routeButtonContainer.appendChild(table);

        resultBox.innerHTML = "";
        nextButton.style.display = "none";
    }

    else {
        routeButtonContainer.innerHTML = ""; // Clear existing cells

        if (cqc.cP[ncP].route[0].pos < cqc.cP[ncP].route[1].pos) {routeOrder = [0, 1];}
        else {routeOrder = [1, 0];}

        const colorPicker = reduceColors(cqc.cP[ncP].route.length);
        const answerText = ["Links", "Rechts"];
        const table = document.createElement("table");
        table.style.width = "100%";
        table.style.tableLayout = "fixed";
        table.style.borderCollapse = "collapse";
        table.style.margin = "0px";
        table.style.padding = "0px";
        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");

        cqc.cP[ncP].route.forEach((route, index) => {
            const routeCell = document.createElement("td");
            routeCell.style.border = "1px solid black";
            routeCell.style.backgroundColor = routeColor[colorPicker[routeOrder[index]]]; // Assign color
            routeCell.textContent = answerText[index]; // Assign text
            routeCell.style.cursor = "pointer";
            routeCell.style.height = (answerWrapperHeight/4-3) + "px";
            routeCell.addEventListener("click", () => {
                submitChoice(routeOrder[index], routeOrder, colorPicker);
            });

            headerRow.appendChild(routeCell);
            routeCell.style.fontSize = (answerWrapperHeight/8) + "px";
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);
        routeButtonContainer.appendChild(table);

        choiceMade = false;

        resultBox.innerHTML = "";
        nextButton.style.display = "none";
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

function generateSortedIndicesByPos(route) {
    // Create an array of indices
    const indices = Array.from({ length: route.length }, (_, index) => index);

    // Sort indices based on the route[nR].pos value
    indices.sort((a, b) => route[a].pos - route[b].pos);

    return indices;
}

function submitChoice(index, routeOrder, reducedColorMap) {
    if (choiceMade) {return;} // Prevent multiple clicks
    choiceMade = true;

    const choiceTime = playTiming();

    selectedIndex = index;
    const table = document.querySelector("#routeButtonContainer table");
    // Update the header row with additional text
    const headerRow = table.querySelector("thead tr");

    if (headerRow) {
        headerRow.cells[routeOrder.indexOf(index)].textContent = `X`;
        headerRow.cells[routeOrder.indexOf(index)].style.fontSize = (answerWrapperHeight/4-10) + "px";
    }
    
    let tbody = table.querySelector("tbody");
    if (!tbody) {
        tbody = document.createElement("tbody");
        table.appendChild(tbody);
    }

    const newRow = document.createElement("tr");
    const shortestIndex = cqc.cP[ncP].route
        .map((route, i) => {
            return {
                index: i,
                runTime: route.runTime
            };
        })
        .reduce((shortest, curr) => (curr.runTime < shortest.runTime ? curr : shortest)).index;
    
    resultBox.innerHTML = "";

    if (!cqc.cP[ncP].complex) {
        cqc.cP[ncP].route.forEach((route, nR) => {
            ctx.beginPath(); // Start a new path for each route
            route.rP.forEach((point, idx) => {
                if (idx === 0) {
                    ctx.moveTo(point.x / cqc.scale, point.y / cqc.scale);
                } else {
                    ctx.lineTo(point.x / cqc.scale, point.y / cqc.scale);
                }
            });
            ctx.strokeStyle = "white"; // Ensure we don't go out of bounds
            ctx.lineWidth = 6;
            ctx.stroke(); // Stroke once per route, not per point
        });

        // Draw routes in randomized order
        cqc.cP[ncP].route.forEach((route, index) => {
            
            // Begin a new path for each route
            ctx.beginPath();
            route.rP.forEach((point, idx) => {
                if (idx === 0) {
                    ctx.moveTo(point.x / cqc.scale, point.y / cqc.scale);
                } else {
                    ctx.lineTo(point.x / cqc.scale, point.y / cqc.scale);
                }
            });

            // Set the color for the route based on randomized index
            ctx.strokeStyle = routeColor[reducedColorMap[index]];
            ctx.lineWidth = 4;
            ctx.stroke(); // Stroke the route

        });

    }
    // Loop through all routes and display their .dist property
    routeOrder.forEach((routeIndex) => {
        const currentrunTime = cqc.cP[ncP].route[routeIndex].runTime;
        const shortestrunTime = cqc.cP[ncP].route[shortestIndex].runTime;

        const currentRouteLength = cqc.cP[ncP].route[routeIndex].length;
        const shortestRouteLength = cqc.cP[ncP].route[shortestIndex].length;

        const cell = document.createElement("td");
        cell.style.height = (answerWrapperHeight/4-3) + "px";

        cell.style.fontSize = (answerWrapperHeight/12) + "px";
        if (routeIndex == shortestIndex) {
            cell.style.backgroundColor = "green"; // Highlight the selected choice
        } else {
            if ((currentRouteLength / shortestRouteLength) < 1) {
                cell.textContent = `${Math.round((currentRouteLength / shortestRouteLength - 1) * 100)}% (+${Math.round(currentrunTime - shortestrunTime)}s)`;
            } else {
                cell.textContent = `+${Math.round((currentRouteLength / shortestRouteLength - 1) * 100)}% (+${Math.round(currentrunTime - shortestrunTime)}s)`;
            }
        }

        cell.style.border = "1px solid black";
        cell.style.textAlign = "center";

        newRow.appendChild(cell);
    });

    // Declare result variables
    let resultText = "";
    let resultColor = "";

    fetch('/play/submit_result/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            "X-CSRFToken": getCSRFToken(),
        },
        body: JSON.stringify({
            filename: cqc_filename.replace('.json', ''),
            control_pair_index: ncP,
            choice_time: Number(choiceTime.toFixed(2)),
            selected_route_runtime: Number(cqc.cP[ncP].route[index].runTime.toFixed(2)),
            shortest_route_runtime: Number(cqc.cP[ncP].route[shortestIndex].runTime.toFixed(2)),
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === "duplicate") {
            resultText = `Duplikat (${choiceTime.toFixed(2)}s)`;
            resultColor = "grey";
        } else {
            if (index === shortestIndex) {
                resultText = `richtig! (${choiceTime.toFixed(2)}s)`;
                resultColor = "green";
            } else {
                // Get the length of the selected route
                const selectedRouterunTime = cqc.cP[ncP].route[index].runTime;
                const shortestRouterunTime = cqc.cP[ncP].route[shortestIndex].runTime;

                // Calculate percentage difference
                const percentageLonger = Math.round((selectedRouterunTime / shortestRouterunTime - 1) * 100);

                if (percentageLonger <= 5) {
                    resultText = `okay (${choiceTime.toFixed(2)}s)`;
                    resultColor = "#F4C430";  // Fixed color name
                } else if (percentageLonger <= 10) {
                    resultText = `nicht ideal (${choiceTime.toFixed(2)}s)`;
                    resultColor = "orange";
                } else {
                    resultText = `Ui! (${choiceTime.toFixed(2)}s)`;
                    resultColor = "red";
                }
            }
        }

        // Now update the result box
        resultBox.innerHTML = resultText;
        resultBox.style.color = resultColor;
        resultBox.style.backgroundColor = "white";
        resultBox.style.display = "block";
        if (ncP == (cqc.cP.length - 1)) {
            nextButton.innerHTML = "Ende";
        }
        nextButton.style.display = "inline-flex";

        tbody.appendChild(newRow);
    });
}

function animateCanvasSpinner() {
    if (!loading) return;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = "#aaaaaa";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Spinner circle
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = 30;
    const lineWidth = 6;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(spinnerAngle);

    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 1.5);
    ctx.strokeStyle = "#007bff";
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.restore();

    // Optional text
    ctx.fillStyle = "#333";
    ctx.font = "18px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Karte laden...", centerX, centerY + 50);

    spinnerAngle += 0.1;
    requestAnimationFrame(animateCanvasSpinner);
}


// Function to record time difference between presses
function playTiming() {
    const currentTime = Date.now(); // Get the current timestamp
    if (lastPressTime !== null) {
        timeDiff = (currentTime - lastPressTime) / 1000; // Convert to seconds
    }
    lastPressTime = currentTime; // Update the last press time
    return timeDiff;
}

function draw(ncP) {
    drawMap(ncP);
    drawCP(ncP);
    drawRoutes(ncP);
}