document.documentElement.style.overflow = 'hidden';

form = document.getElementById("uploadForm");
form.classList.add('reset-form');

function getCSRFToken() {
    return document.querySelector('meta[name="csrf-token"]').getAttribute('content');
}
//global variables
const routeCanvas = document.getElementById("routeCanvas"); rc = routeCanvas.getContext("2d");
const maskCanvas = document.getElementById("maskCanvas"); mc = maskCanvas.getContext("2d");
const editLiveCanvas = document.getElementById('editLiveCanvas'); ec = editLiveCanvas.getContext("2d");

const rControl = 25;		//radius of control circle
const snapThreshhold = 25;	//distance to snap cursor (same as control circle radius)
const mrklen = 5;			//small cross marker size
const waitThreshhold = 150;	//ms, waittime for cursor change when dragging

let image = new Image();
let mask = null;

let loading = false;
let startTime = null;

let liveX, liveY;			//cursor live position relative to canvas (inverse of transformation matrix)
var xClick, yClick;			//coordinates on mouse click

//map transformation	
var scale = 1; 				//initial scale
var transX = transY = 0;	//translation of map
    
//state booleans
var isDragging = cDraw = rDraw = sDraw = false;

let isEditing = false;

var cv_mask = false;
var mode = "placeControls";	//tool mode
var subMode = null;

let isEditingElevation = false;

let BrushRadius = 2;

let runSpeed = 4.75;

let subImageData = null;

const addBlocked = document.getElementById("buttonAddblocked");
const removeBlocked = document.getElementById("buttonRemoveBlocked");
const buttonCV = document.getElementById("buttonCV");
const instructionBox = document.getElementById("divI");
const alertBox = document.getElementById("alertBox");


buttonCV.addEventListener('click', () => {
    if (cv_mask) {
        mode = "mapCV"
    } else {
        // Extract filename from cqc.mapFile
        const mapPath = cqc.mapFile;

        if (!mapPath) {
            alertBox.innerHTML = `<span style="color: red;">Keine Karte geladen</span>`;
            return;
        }
       // Get scale
        const scale = cqc.scale;
        const prediction_time = Math.round(5+scale/0.7104*image.naturalWidth*image.naturalHeight*2/1000000)

        alertBox.innerHTML = `<span><i style="font-size: 1rem; padding: 0px 5px" class="fa-solid fa-spinner fa-spin-pulse"></i> Geschätze Dauer für neurales Netzwerk: ${prediction_time}s</span>`;

        const filename = mapPath.split('/').pop();  // Gets just "FILENAME.extension"

        // Construct request URL
        const url = `/coursesetter/run_unet/?filename=${encodeURIComponent(filename)}&scale=${encodeURIComponent(scale)}`;

        // Fetch request
        fetch(url)
            .then(response => {
                if (!response.ok) {
                    return response.text().then(text => {
                        throw new Error(text || 'Server returned an error');
                    });
                }
                return response.json();  // expecting { message: "Prediction done" }
            })
            .then(data => {
                alertBox.innerHTML = `<span>${data.message}</span>`;
                cv_mask = true;
                const basename = filename.split('.').slice(0, -1).join('.');
                const maskUrl = `/coursesetter/get_mask/mask_${basename}.png`;

                if (!mask) {
                    mask = new Image();
                    mask.crossOrigin = "anonymous";
                }
                mask.onload = () => {
                    processMaskImage(mask);
                };
                mask.src = maskUrl;
                mode = "mapCV";
            })
            .catch(error => {
                alertBox.innerHTML = `<span style="color: red;">Error: ${error.message}</span>`;
            });
    }
    draw(rc);
});

addBlocked.addEventListener('click', () => {
    subMode = "add";
    draw(rc);
});

removeBlocked.addEventListener('click', () => {
    subMode = "remove";
    draw(rc);
});

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
        addBlocked.style.display = "table-cell";
        removeBlocked.style.display = "table-cell";
        addBlocked.style.backgroundColor = "white";
        removeBlocked.style.backgroundColor = "white";

        if (subMode == "add") {
            addBlocked.style.backgroundColor = "yellow";
        } else if (subMode == "remove") {
            removeBlocked.style.backgroundColor = "yellow";
        }

    } else {
        routeCanvas.style.opacity = 1;
        maskCanvas.style.display = "none";
        editLiveCanvas.style.display = "none";
        buttonCV.style.backgroundColor = "white";
        addBlocked.style.display = "none";
        removeBlocked.style.display = "none";
    }
}

//indexing
var ncP = nR = nRP = 0; //counters for control points, routes, route points	

//update table with controls
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
    const cth = document.getElementById('tableHC');
    document.getElementById('headC').style.height = cth.offsetHeight + 'px';
    
    const cd_width = document.getElementById('divC').offsetWidth;
    cth.style.width = cd_width + 'px';
    
    const tableC = document.getElementById('tableC');
    
    //go to bottom of scrollable content on new entries
    if (ncP >= cqc.cP.length) {
        tableC.scrollTop = tableC.scrollHeight;
    }
    
    //limit div size
    const cpt = document.getElementById('controlPairsTable')
    if (cpt.scrollHeight  < 600) {
        tableC.style.height = cpt.scrollHeight + "px";
    }
    else {
        tableC.style.height = "600px";
    }
    
    //change background color according to tool mode
    if (mode == "placeControls"){
        document.getElementById("buttonControl").style.backgroundColor = "green";
    } else {
        document.getElementById("buttonControl").style.backgroundColor = "white";
    }
}

//update table with routes
function updateTableR() {
    const tableBody = document.querySelector('#routesTable tbody');
    tableBody.innerHTML = ''; //clear existing rows
    
    if (mode == "drawRoutes"){
        document.getElementById("buttonRoute").style.backgroundColor = "green";
    } else {
        document.getElementById("buttonRoute").style.backgroundColor = "white";
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
        tableBody.appendChild(row);
    }	

    //size formatting
    const tableR = document.getElementById('divR');
    const rpt = document.getElementById('routesTable')
    //limit div height
    if (rpt.scrollHeight < 600) {
        tableR.style.height = rpt.scrollHeight + "px";
    }
    else {
        tableR.style.height = "600px";
    }
}

// Function to download the cqc object as a .json file
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

function resizeCanvas() {
    //follow window size change
    routeCanvas.width = window.innerWidth;
    routeCanvas.height = window.innerHeight;
    maskCanvas.width = window.innerWidth;
    maskCanvas.height = window.innerHeight;
    editLiveCanvas.width = window.innerWidth;
    editLiveCanvas.height = window.innerHeight;
}

const filenameInput = document.getElementById('filename');

document.getElementById('buttonProjects').addEventListener('click', () => {
    document.getElementById('modalP').style.display = 'block';
    loadFileList();  // Load file list when the modal opens
});

const editCanvas = document.createElement('canvas');
const editCtx = editCanvas.getContext('2d');
editCtx.imageSmoothingEnabled = false;

submitSaveButton.addEventListener('click', async () => {
    const filename = filenameInput.value.trim();

    cqc.cP.forEach((cp, i) => {
        cp.route.forEach((r, j) => {
            const length = r.length;
            const elevation = r.elevation;

            const gradient = (elevation / length) * 100; // Gradient in %
            const GAP_p = 0.0017 * (gradient) ** 2 + 0.02901 * gradient + 0.99387;
            const GAP_n = 0.0017 * (gradient) ** 2 - 0.02901 * gradient + 0.99387;
            const GAP = runSpeed / ((GAP_p + GAP_n) / 2);
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
                filename: `${filename}.json`,
                data: cqc
            })
        });

        if (!saveResponse.ok) {
            throw new Error('Failed to save file');
        }

        // Successfully saved
        filenameInput.value = '';
        loadFileList();

    } catch (error) {
        console.error(error);
        alert(error.message);
    }
});

// Get the "x" element to close the modal
const closeProjects = document.getElementById('closeProjects');
const modalP = document.getElementById('modalP');
const modalCV = document.getElementById('modalCV');


// When the "x" is clicked, close the modal
closeProjects.addEventListener('click', () => {
    modalP.style.display = 'none';
    document.getElementById('filename').value = '';
});

// Also, make sure to close the modal when clicking outside of the modal content
window.addEventListener('click', (event) => {
    if (event.target === modalP) {
        modalP.style.display = 'none';

        document.getElementById('filename').value = '';
    }
});

// Get the "x" element to close the modal
const openMap = document.getElementById('buttonMap');
const closeMap = document.getElementById('closeMap');
const modalM = document.getElementById('modalM');

// When the "x" is clicked, close the modal
closeMap.addEventListener('click', () => {
    modalM.style.display = 'none';
    draw(rc);
document.getElementById('filename').value = '';
});

// Also, make sure to close the modal when clicking outside of the modal content
window.addEventListener('click', (event) => {
    if (event.target === modalM) {
        modalM.style.display = 'none';
        document.getElementById('filename').value = '';
        draw(rc);
    }
});

openMap.addEventListener('click', () => {
    modalM.style.display = 'block';
});

function loadFileList() {
    let tbody = fileTable.querySelector('tbody');

    // Show a loading spinner row
    tbody.innerHTML = `
        <tr>
            <td colspan="4" style="text-align: center; padding: 20px;">
                <i style="font-size: 2rem; padding: 0px 5px" class="fa-solid fa-spinner fa-spin-pulse"></i>
            </td>
        </tr>
    `;
    fetch('/coursesetter/get-files/')
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
                const row = document.createElement('tr');
                row.classList.add('tableRowProjects');
                
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
                    filenameInput.value = fileNameWithoutExtension;  // Set the file name in input field
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
                
                const formattedDate = new Date(file.modified);
                const day = String(formattedDate.getDate()).padStart(2, '0');
                const month = String(formattedDate.getMonth() + 1).padStart(2, '0');
                const year = formattedDate.getFullYear();
                const hours = String(formattedDate.getHours()).padStart(2, '0');
                const minutes = String(formattedDate.getMinutes()).padStart(2, '0');
                const seconds = String(formattedDate.getSeconds()).padStart(2, '0');

                const formattedDateString = `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;

                lastModifiedCell.textContent = formattedDateString; // Display the formatted date and time

                row.appendChild(lastModifiedCell);

                // Author
                const authorCell = document.createElement('td');
                authorCell.classList.add('tableCellProjects');
                authorCell.textContent = file.author; // Button label
                row.appendChild(authorCell);

                // Load button
                const loadCell = document.createElement('td');
                loadCell.classList.add('tableCellProjects');
                const loadButton = document.createElement('button');
                loadButton.innerHTML = '<i class="fa-solid fa-folder-open"></i>'; // Button label
                loadButton.addEventListener('click', () => {
                    loadFile(file.filename); // Call the loadFile function when clicked
                });
                loadCell.appendChild(loadButton);
                row.appendChild(loadCell);

                // Delete button
                const deleteCell = document.createElement('td');
                deleteCell.classList.add('tableCellProjects');
                const deleteButton = document.createElement('button');
                deleteButton.innerHTML = `<i class="fa-solid fa-trash"></i>`;
                deleteButton.addEventListener('click', () => deleteFile(file.filename));
                deleteCell.appendChild(deleteButton);
                row.appendChild(deleteCell);

                // Publish button
                const publishCell = document.createElement('td');
                publishCell.classList.add('tableCellProjects');

                const publishButton = document.createElement('button');
                publishButton.innerHTML = `<i class="fa-solid fa-globe"></i>`;
                publishButton.addEventListener('click', () => publishProject(file.filename, publishButton));

                // Set button color based on published state
                if (file.published) {
                    publishButton.style.backgroundColor = "orange";
                } else {
                    publishButton.style.backgroundColor = "white";
                }

                publishCell.appendChild(publishButton);
                row.appendChild(publishCell);

                // Append row to tbody
                tbody.appendChild(row);
            });
        })
        .catch(error => {
            console.error('Error loading file list:', error);
            alert('Failed to load file list');
        });
}

function publishProject(filename, button) {
    const filenameWithoutExtension = filename.replace('.json', '');

    fetch(`/coursesetter/toggle-publish/${filenameWithoutExtension}.json/`, {
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
            maskData[i] = 200;
            maskData[i + 1] = 200;
            maskData[i + 2] = 200;
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

function loadFile(filename) {
    const encodedFilename = encodeURIComponent(filename);
    const url = `/coursesetter/load-file/${encodedFilename}/`;

    fetch(url)
    .then(response => response.json())
    .then(fileData => {
        cqc = fileData;
        cv_mask = fileData.has_mask || false;
        mask = null;

        loading = true;
        requestAnimationFrame(drawLoadingAnimation);

        modalP.style.display = 'none';
        document.getElementById('filename').value = '';
        ncP = nRP = nR = 0;
        transX = transY = 0;


        // Load image and draw immediately after it's ready
        image.onload = () => {
            loading = false;
        };
        image.crossOrigin = "anonymous";
        image.src = cqc.mapFile;

        // Load mask in parallel, but don't block the draw
        if (cv_mask) {
            const mapFilename = cqc.mapFile.split('/').pop().split('.')[0];
            const maskUrl = `/coursesetter/get_mask/mask_${mapFilename}.png`;

            const tempMask = new Image();
            tempMask.onload = () => {
                mask = tempMask;
                processMaskImage(mask);  // post-process when ready
            };
            tempMask.crossOrigin = "anonymous";
            tempMask.src = maskUrl;
        } else {
            mask = null;
            mode = "placeControls";
        }
        draw(rc);
    })
    .catch(error => {
        console.error('Error loading the file:', error);
        alert('Failed to load the file');
    });
}


// Function to delete a file
function deleteFile(filename) {
// Remove .json if present in the filename
const filenameWithoutExtension = filename.replace('.json', '');

if (confirm(`Projekt "${filenameWithoutExtension}" löschen?`)) {
    fetch(`/coursesetter/delete-file/${filenameWithoutExtension}.json/`, {
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

document.getElementById('uploadForm').addEventListener('submit', function(event) {
    event.preventDefault(); // Prevent default form submission

    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];

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

    uploadSpinner = document.getElementById("uploadSpinner");
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
        fileInput.value = '';

        loading = true;
        requestAnimationFrame(drawLoadingAnimation);

        // Extract filename from the returned S3 key or URL
        const mapFilename = data.filename || data.mapFile.split('/').pop();

        // Replace direct S3 URL with Django protected view URL
        const protectedMapUrl = `/coursesetter/get_map/${mapFilename}`;
        cqc.mapFile = protectedMapUrl;
        
        image.onload = () => {
            loading = false;
        };
        
        image.src = cqc.mapFile;
        document.getElementById('scalingInfo').style.display = 'flex';
        document.getElementById("scaleInputDiv").style.display = 'none';
        uploadSpinner.style.display = "none";

        cqc.scaled = data.scaled;
        cqc.scale = 1; //reset scale
        cDraw = false;
        cqc.cP = [];
        nsP = 0;
        nRP = 0;
        ncP = 0;
        draw(rc); //update canvas, tables
    })
    .catch(error => {
        console.error('Error uploading file:', error);
        document.getElementById('scalingInfo').textContent = 'Upload failed.';
    });
});

// Handling Enter key to trigger upload
document.addEventListener('keydown', function(event) {
if (modalM.style.display = 'block' && event.key === 'Enter') {
    event.preventDefault(); // Prevent default behavior (form submission or focusing)

    const fileInput = document.getElementById('fileInput');
    const uploadButton = document.getElementById('uploadButton');

    // If file is selected, simulate click on upload button
    if (fileInput.files.length > 0) {
        uploadButton.click();
    }
}
});

//UI shortcuts
document.addEventListener("keydown", function(e) {
    if (modalP.style.display === 'block' || modalM.style.display === 'block') {
        if (cqc.scaled) {
            switch (e.keyCode) {
                case 27: //esc
                    modalP.style.display = 'none';
                    modalM.style.display = 'none';
                break
            }
        }
    }
    else {
        switch (e.keyCode) {
            case 68: //d
                delControl();
            break;
            case 78: //n
                if (cqc.cP.length > ncP) {
                    ncP += 1;
                    nR = 0;
                    nRP = 0;
                }
            break;
            case 80: //p
                mode = "placeControls";
            break;
            case 82: //r
                mode = "drawRoutes";
            break;
            case 86: //v
                mode = "mapCV";
            break;
            case 65: //a
                if (mode == "mapCV"){
                    subMode = "add";
                }
            break;
            case 69: //e
                if (mode == "mapCV"){
                    subMode = "remove";
                }
            break;
            case 77: //m
                modalM.style.display = 'block';
            break;
        }
    }
    draw(rc); //update canvas, tables
})

function saveCanvas() {
    const updatedCanvas = updateMaskFromEdits(mask);

    // Extract base name from cqc.mapFile
    const fullPath = cqc.mapFile;  // e.g., "/media/maps/forest_map.jpg"
    const baseName = fullPath.split('/').pop().split('.')[0];  // "forest_map"
    const maskFilename = `mask_${baseName}.png`;

    updatedCanvas.toBlob(blob => {
        const formData = new FormData();
        formData.append('mask', blob, maskFilename);

        fetch('/coursesetter/upload-mask/', {
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
        })
        .catch(error => {
            alertBox.innerHTML = error;
        });
    }, 'image/png');
}


//set tool modes
function setModeC() {
    mode = "placeControls";
    draw(rc); //update canvas, tables
}

function setModeR() {
    nRP = 0;
    nR = 0;
    mode = "drawRoutes";
    draw(rc); //update canvas, tables
}

//set route number
function setR(index) {
    if (!rDraw) {
        nR = index;
    }
    draw(rc); //update canvas, tables
}

//set control pair number
function setcP(index) {
    if (!cDraw) {
        ncP = index;
    }
    nR = 0; //start at first route when switching control pairs
    draw(rc); //update canvas, tables
}

//delete function
function delControl() {
    switch (mode) {
        case "placeControls": //when drawing controls
            if(cqc.cP.length > 0) { //check if control array is not empty
                cqc.cP.splice(ncP,1); //delete current control pair
                if (!cDraw) {
                    if (ncP > 0) {
                        ncP -= 1; //jump back to previous control
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
    }
    draw(rc); //update canvas, tables
}

//generate new route point in object
function gen_rP() {
    return {
        x: null,
        y: null
    }
}

//generate new route in object
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
//generate new control pair in object
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

//generate new scale point pair in object
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

//generate main object
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
    cP		: []
};

draw(rc); //draw initial canvas and (empty) tables (onload?)

//wheel event listener for zooming
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

maskCanvas.addEventListener("mousedown", startDraw);
maskCanvas.addEventListener("mousemove", editing);
maskCanvas.addEventListener("mouseup", stopDrawSave);
maskCanvas.addEventListener("mouseleave", stopDraw);
maskCanvas.addEventListener('mousemove', editingCursor);

addBlocked.addEventListener('wheel', (event) => {
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

removeBlocked.addEventListener('wheel', (event) => {
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
        ec.arc(x, y, BrushRadius*scale, 0, Math.PI * 2);
        ec.strokeStyle = "black";
        ec.lineWidth = 1;
        ec.stroke();
    } else if (subMode == "remove") {
        ec.beginPath();
        ec.arc(x, y, BrushRadius*scale, 0, Math.PI * 2);
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
        drawPixelCircle(editCtx, Math.round(x), Math.round(y), BrushRadius)
        // Show live feedback directly on mc (screen canvas)
        mc.save();
        mc.setTransform(1, 0, 0, 1, 0, 0); // reset transform
        mc.fillStyle = "rgba(255,0,0,1)";
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;
        drawCircle(mc, canvasX, canvasY, BrushRadius*scale);
        mc.restore();

    } else if (subMode === "remove") {
        eraseCircle(editCtx, Math.round(x), Math.round(y), BrushRadius);

        // Normal smooth erase circle on mc:
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;
        mc.save();
        mc.setTransform(1, 0, 0, 1, 0, 0);
        mc.beginPath();
        mc.arc(canvasX, canvasY, BrushRadius*scale, 0, 2 * Math.PI);
        mc.globalCompositeOperation = 'destination-out';
        mc.fill();
        mc.globalCompositeOperation = 'source-over';
        mc.restore();
    }
}

//mouse object for panning and clicking
const mouse = {x: 0, y: 0, oldX: 0, oldY: 0, button: false};

//setup mouse event listeners
routeCanvas.addEventListener("mousemove", mouseEvent, {passive: true});
routeCanvas.addEventListener("mousedown", mouseEvent, {passive: true});
routeCanvas.addEventListener("mouseup", mouseEvent, {passive: true});

function drawMask() {
    if (!editCanvas) return;

    if (mode == "mapCV" & !loading) {
        mc.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        mc.setTransform(scale, 0, 0, scale, transX, transY);
        mc.drawImage(editCanvas, 0, 0); // respects transforms
        mc.setTransform(1, 0, 0, 1, 0, 0);
    }
}

//main mouse event function
function mouseEvent(event) {
    liveCursor(event); //get inverse transformed mouse coordinates (relative to map)
    if (event.type === "mousedown") { //on click
        mouse.button = true; //boolean for clicked
        xClick = liveX, yClick = liveY; //get current coordinates
        transXclick = transX, transYclick = transY; //get current translation (for pan checking)
        
        //check if mouse is grabbing and panning
        setTimeout(function() {
            if (mouse.button) { //if mouse down after timeout
                document.getElementById("routeCanvas").style.cursor = "grabbing"; //change cursor
                isDragging = true; //set dragging boolean for live draw
            }
            draw(rc); //update canvas, tables
        },waitThreshhold); //timeout
    }
    if (event.type === "mouseup") { //on release
        mouse.button = isDragging = false; //change states
        if (transXclick == transX && transYclick == transY) { //if no panning occured:
            switch(mode){
                case "placeControls":
                    makeControl(event); //make a new control at clicked coordinates
                break;
                case "drawRoutes":
                    makeRP(event); //make a new route point at clicked coordinates
                break;
                case "scaleMap":
                    makeScale(event); //make a new scale point at clicked coordinates
                break;
                case "mapCV":
                    console.log("CV Mode")
                break;
            }
            draw(rc); //update canvas, tables
        }
        document.getElementById("routeCanvas").style.cursor = "default"; //change cursor back

    }
    mouse.oldX = mouse.x, mouse.oldY = mouse.y; //write previous mouse coordinates
    mouse.x = event.offsetX, mouse.y = event.offsetY; //write current mouse coordinates
    if(mouse.button) { //on mouse down
        pan({x: mouse.x - mouse.oldX, y: mouse.y - mouse.oldY}); //pan by difference between old and new coordinates
    }
    if (!loading) {
        draw(rc); //update canvas, tables
    }
}

function pan(amount) {
    transX += amount.x, transY += amount.y; //change translation 
    draw(rc); //update canvas, tables
}

//calculate translation values from zooming/panning
function calcTransf(amount,e) {
    transX = e.offsetX - (e.offsetX - transX)*amount;
    transY = e.offsetY - (e.offsetY - transY)*amount;
    return transX, transY;
}

function drawScaledImage(image) {
    // Apply scaling to the image, but without modifying the canvas transform
    const scaledWidth = image.naturalWidth * cqc.scale;
    const scaledHeight = image.naturalHeight * cqc.scale;

    rc.drawImage(image, 0, 0, scaledWidth, scaledHeight);
}

//draw function
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
        liveDraw(); //draw live elements
        drawMask();
        updateTableC(), updateTableR(); updateTableI(); updateTableM();//draw tables
    }
}

function scaleMap() {
    modalM.style.display = 'none';
    sDraw = true;
    cDraw = false;
    mode = "scaleMap";
    nsP = 0;
}

function submitScale() {
    const inputValue = document.getElementById("scaleInput").value;

    if (isNaN(inputValue) || inputValue <= 0) {
        alert("Please enter a valid positive number!");
        return;
    }

    cqc.scale = inputValue / cqc.sP.dist / 0.48;
    console.log("Scaling factor set to:", cqc.scale);

    // Close the modal
    document.getElementById("modalM").style.display = "none";
    document.getElementById("scaleInput").value = "";
    document.getElementById("scaleInputDiv").style.display = 'none';
    mode = "placeControls";
    transX = transY = 0; //reset translation
    cqc.scaled = true;
    draw(rc); //update canvas, tables
}

// Allow Enter key to submit
document.getElementById("scaleInput").addEventListener("keydown", function(event) {
if (event.key === "Enter" && document.getElementById("scaleInput").style.display !== "none") {
    submitScale();
}
});

function makeRP(event){
    if (!rDraw) { //if not in route draw mode
        if (cqc.cP[ncP].route.length > nR) { //check if data exists already in current route
            cqc.cP[ncP].route.splice(nR,1,gen_route()); //replace current route data with empty route sub-object
        } else {
            if (!cqc.cP[ncP].complex && cqc.cP[ncP].route.length > 1) {
                alert("Bei Links/Rechts-Posten maximal 2 Routen");
                return;
            }
        cqc.cP[ncP].route.push(gen_route()); //add new route sub-object
        }
        rDraw = true; //set route draw state
        nRP = 0; //reset counter of route points
    }
    //add new route point array element and write mouse click coordinates
    cqc.cP[ncP].route[nR].rP.push(gen_rP());
    cqc.cP[ncP].route[nR].rP[nRP].x = xClick;
    cqc.cP[ncP].route[nR].rP[nRP].y = yClick;
    nRP += 1; //route point counter increase
    
    if (xClick == cqc.cP[ncP].ziel.x && yClick == cqc.cP[ncP].ziel.y) { //if route point is the control point
        calcSide(); //calculate left/right side of route
        calcLength(); //calculate route length
        calcDir(); //calculate number of sharp angles on route
        nR += 1; //increase route counter
        nRP = 0; //reset route point counter
        rDraw = false; //reset route drawing mode
    }
}

//add a control
function makeControl(event){
    if (!sDraw) {
        if (cDraw){ //depending on if it is the first or second
            makeZiel(event); //draw a second control
        } else {
            makeStart(event); //draw a first control
        }
    }
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
            document.getElementById("scalingInfo").style.display = 'none';
            document.getElementById("scaleInputDiv").style.display = 'flex';
            document.getElementById('scaleInput').focus();
        }
        nsP += 1;
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
    cqc.cP[ncP].route[nR].pos = sideWeightOfRoute(cqc.cP[ncP], cqc.cP[ncP].route[nR]);
        //use for whole file
        /*cqc.cP.forEach((pair, indexC) => {
            pair.route.forEach((route, indexR) => {
                route.pos = sideWeightOfRoute(pair, route);
            });
        });*/
}

function sideWeightOfRoute(pair, route) {
    let sum = 0;
    const start = pair.start;
    const ziel = pair.ziel;
    const routePoints = route.rP; // Get the route points

    for (const p of routePoints) {
        const dx = ziel.x - start.x;
        const dy = ziel.y - start.y;
        const px = p.x - start.x;
        const py = p.y - start.y;

        const cross = dx * py - dy * px;
        sum += cross;
    }

    return sum  / routePoints.length;
}

function drawStart() {
    for (let i = 0; i < cqc.cP.length; i++) { //iterate over all first controls
        rc.beginPath();

        rc.arc(cqc.cP[i].start.x, cqc.cP[i].start.y, rControl, 0, 2 * Math.PI); //draw circle
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
        rc.arc(cqc.cP[i].ziel.x, cqc.cP[i].ziel.y, rControl, 0, 2 * Math.PI); //draw circle
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

            if (distC > 2 * (rControl + 10)) {
                rc.beginPath();
                rc.lineWidth = i == ncP ? 5 : 3; // Thicker line for selected pair
                rc.moveTo(start.x + Math.cos(angleC) * (rControl + 10), start.y + Math.sin(angleC) * (rControl + 10));
                rc.lineTo(ziel.x - Math.cos(angleC) * (rControl + 10), ziel.y - Math.sin(angleC) * (rControl + 10));
                rc.stroke();

                // Only draw arrow for the selected pair
                if (i == ncP) {
                    drawConnectionArrow(start, ziel, angleC);
                }
            }
        }
    }
}

// Function to draw an arrow in the middle of the selected pair's line
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


    
function drawRoutes() {
    cqc.cP.forEach((pair, indexC) => {
        if (indexC !== ncP) {
            // Draw white base path
            /*rc.beginPath();
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
            rc.strokeStyle = 'white';
            rc.lineWidth = 4;
            rc.stroke();*/

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
            route.rP.forEach((point, idx) => {  // FIXED: `route.rP`
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
            route.rP.forEach((point, idx) => {  // FIXED: `route.rP`
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

    // Draw the red route on top
    if (cqc.cP[ncP] && cqc.cP[ncP].route[nR]) {  
        rc.beginPath();
        cqc.cP[ncP].route[nR].rP.forEach((point, idx) => {  // FIXED: `cqc.cP[ncP].route[nR].rP`
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
}



function drawCursor(tc) { //draw small crosshair
    tc.strokeStyle = "#000";
    tc.lineWidth = 1;
    tc.beginPath();
    tc.moveTo(liveX-mrklen,liveY-mrklen);
    tc.lineTo(liveX+mrklen,liveY+mrklen);
    tc.stroke();
    tc.beginPath();
    tc.moveTo(liveX-mrklen,liveY+mrklen);
    tc.lineTo(liveX+mrklen,liveY-mrklen);
    tc.stroke();
}


function liveDraw() {
    switch (mode){
        case "placeControls": //when drawing controls
            if (!isDragging) { //don't draw circle when dragging
                rc.strokeStyle = "rgb(160, 51, 240,0.8)";
                rc.lineWidth = 3;
                rc.beginPath();
                rc.arc(liveX, liveY, rControl, 0, 2 * Math.PI);
                rc.stroke();
                
                drawCursor(rc);
                
                if(cDraw) { //live draw connection line to live cursor position
                    let angleC = Math.atan2(liveY - cqc.cP[ncP].start.y, liveX - cqc.cP[ncP].start.x);
                    let distC = Math.sqrt(Math.pow(liveX - cqc.cP[ncP].start.x,2) + Math.pow(liveY - cqc.cP[ncP].start.y,2));
                    
                    if (distC > 2*(rControl+10)){
                        rc.strokeStyle = "rgb(160, 51, 240,0.8)";
                        rc.lineWidth = 2;
                        //connection line with offset
                        rc.beginPath();
                        rc.moveTo(cqc.cP[ncP].start.x + Math.cos(angleC)*(rControl+10), cqc.cP[ncP].start.y + Math.sin(angleC)*(rControl+10));
                        rc.lineTo(liveX - Math.cos(angleC)*(rControl+10), liveY - Math.sin(angleC)*(rControl+10));
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
            if (nsP == 1) { //live draw scale line to cursor
                /*rc.lineWidth = 5;
                rc.strokeStyle = "black";
                rc.beginPath();
                rc.moveTo(cqc.sP.p1.x,cqc.sP.p1.y);
                rc.lineTo(liveX,liveY);
                rc.stroke();*/
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
    }
}

function liveCursor(event){
    //unsnapped live position
    liveX = (event.clientX-transX)/scale;
    liveY = (event.clientY-transY)/scale;

    switch (mode){
        case "placeControls": //when drawing controls
            if (ncP>0 && !cDraw){ //snap to second control
                let snapDist = Math.sqrt(Math.pow((liveX - cqc.cP[ncP-1].ziel.x),2)+Math.pow((liveY - cqc.cP[ncP-1].ziel.y),2)); //distance to target
                if(snapDist<snapThreshhold){
                    //snapped live position
                    liveX = cqc.cP[ncP-1].ziel.x;
                    liveY = cqc.cP[ncP-1].ziel.y;
                }
            }
        break;
        case "drawRoutes": //when drawing routes
            if (ncP < cqc.cP.length){
                if (!rDraw){ //snap to first control
                    let snapDist = Math.sqrt(Math.pow((liveX - cqc.cP[ncP].start.x),2)+Math.pow((liveY - cqc.cP[ncP].start.y),2)); //distance to target
                    if(snapDist<snapThreshhold){
                        //snapped live position
                        liveX = cqc.cP[ncP].start.x;
                        liveY = cqc.cP[ncP].start.y;
                    }
                }
                if (rDraw){ //snap to second control
                    let snapDist = Math.sqrt(Math.pow((liveX - cqc.cP[ncP].ziel.x),2)+Math.pow((liveY - cqc.cP[ncP].ziel.y),2)); //distance to target
                    if(snapDist<snapThreshhold/5){
                        //snapped live position
                        liveX = cqc.cP[ncP].ziel.x;
                        liveY = cqc.cP[ncP].ziel.y;
                    }
                }
            }
        break;

        return liveX, liveY;
    }
}