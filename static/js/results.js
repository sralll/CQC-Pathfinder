let ncP_max = 0;
let results = {};
let prog_distance = [];
let shortest_route_runtime = [];
let tabledata = {};
let avg_times = [];
let selectedUsers = [];
let selectedCumulativeDiffs = {};

const userColors = [
    '#ff1e1e', // red
    '#00c000', // blue
    '#2626ff', // green
    '#00c0c0', // purple
    '#c618c6', // orange
    '#ff9901', // yellow
];

canvas = document.getElementById('OLchart');
ctx = canvas.getContext('2d');

// --- Helper: Parse URL parameters ---
function getUrlParameter(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
}

window.onload = function () {
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
                const filenameWithExtension = gameParam + '.json';
                const optionExists = filenames.includes(filenameWithExtension);
                if (optionExists) {
                    dropdown.value = filenameWithExtension;
                    dropdown.dispatchEvent(new Event('change')); // Trigger the loading
                }
            }
        })
        .catch(error => console.error('Error fetching filenames:', error));
};

// --- Handle dropdown change ---
document.getElementById('jsonDropdown').addEventListener('change', function () {
    const selectedFilename = this.value;

    const tableBody = document.getElementById('userTableBody');
    tableBody.innerHTML = '';

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