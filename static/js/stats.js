const bgColor = getBackgroundColor(); // Gets the background color of <html>

function getBackgroundColor() {
    return document.getElementById("statsContainer").backgroundColor;
}

const screenWidth = window.innerWidth;

const doughnutChart = document.getElementById('doughnutChart');
const barChart = document.getElementById('barChart');

let doughnutChartInstance = null;
let barChartInstance = null;

const isMobile = document.body.classList.contains('mobile');
const canvasWidth = isMobile ? screenWidth * 0.9 : screenWidth * 0.4;

doughnutChart.width = canvasWidth;
doughnutChart.height = canvasWidth;
barChart.width = canvasWidth;
barChart.height = canvasWidth;


if (isTrainer) {
    document.addEventListener('DOMContentLoaded', () => {
        fetch('/user_list/')
        .then(response => response.json())
        .then(data => {
            const select = document.getElementById('userSelect');
            
            data.users.sort((a, b) => a.name.localeCompare(b.name));

            data.users.forEach(user => {
                const option = document.createElement('option');
                option.value = user.id;
                option.textContent = user.name;
                select.appendChild(option);
            });
        });
    });

    const userSelect = document.getElementById('userSelect');
    userSelect.addEventListener('change', () => {
        const userId = userSelect.value; // empty string if none selected

        if (userId === "clear") {
            console.log("Clearing stats");
            doughnutChartInstance.destroy();
            barChartInstance.destroy();
            return;
        }
        // Construct the URL (with or without userId)
        const url = userId ? `/stats/${userId}/` : '/stats/';
    
        fetch(url)
        .then(response => {
            if (!response.ok) throw new Error('Failed to fetch stats');
            return response.json();
        })
        .then(data => {
            updateStats(userId);
        })
        .catch(error => {
            console.error('Error fetching stats:', error);
        });
    });
}
else {
    updateStats()
}


function updateStats(userId) {
    const url = userId ? `/stats/${userId}/` : '/stats/';
    
    fetch(url)
    .then(response => response.json())
    .then(data => {

        // Destroy the previous chart instance if it exists
        if (doughnutChartInstance) {
            doughnutChartInstance.destroy();
        }

        // Destroy the previous chart instance if it exists
        if (barChartInstance) {
            barChartInstance.destroy();
        }

        const doughnutData = {
            labels: ['Schnellste', '<5%', '5–10%', '10%+'],
            datasets: [{
                label: 'Individuell',
                weight: 0,
                data: [
                    data.category_counts.fastest,
                    data.category_counts.less_5,
                    data.category_counts.between_5_10,
                    data.category_counts.more_10
                ],
                backgroundColor: ['#4CAF50', '#FFC107', '#FF9800', '#F44336'],
                borderWidth: 0,
            },{
                label: 'Kaderdurchschnitt',
                weight: 1,
                data: [
                    data.global_category_counts.fastest,
                    data.global_category_counts.less_5,
                    data.global_category_counts.between_5_10,
                    data.global_category_counts.more_10
                ],
                backgroundColor: [
                    'rgba(76, 175, 80, 0.5)',   // #4CAF50
                    'rgba(255, 193, 7, 0.5)',   // #FFC107
                    'rgba(255, 152, 0, 0.5)',   // #FF9800
                    'rgba(244, 67, 54, 0.5)'    // #F44336
                ],
                borderWidth: 2,
                borderColor: getBackgroundColor(),
            },{
                label: 'Individuell',
                weight: 2,
                data: [
                    data.category_counts.fastest,
                    data.category_counts.less_5,
                    data.category_counts.between_5_10,
                    data.category_counts.more_10
                ],
                backgroundColor: ['#4CAF50', '#FFC107', '#FF9800', '#F44336'],
                borderWidth: 2,
                borderColor: getBackgroundColor(),
            }]
        };

        const centerTextPlugin = {
            id: 'centerText',
            beforeDraw(chart, args, options) {
                const { ctx, chartArea } = chart;
                const centerX = (chartArea.left + chartArea.right) / 2;
                const centerY = (chartArea.top + chartArea.bottom) / 2;

                ctx.save();
                ctx.font = options.font || '50px Arial';
                ctx.fillStyle = options.color || 'black';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(data.total_entries || '', centerX, centerY-20);

                ctx.font = options.font || '25px Arial';
                ctx.fillText('Posten' || '', centerX, centerY+20);
                ctx.restore();
            }
        };

        const options = {
            responsive: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: 'black',
                        font: {
                            size: 12,
                        },
                    },
                    title: {
                        display: true,
                        text: 'Routenwahl',
                        color: 'black',
                        font: {
                            size: 16,
                            weight: 'bold',
                        },
                    },
                }
            },
        };

        const ctx = document.getElementById('doughnutChart').getContext('2d');
        doughnutChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: doughnutData,
            options,
            plugins: [centerTextPlugin],
        });


        const barData = {
            labels: ['⌀ Entscheidungszeit','⌀ Routenwahlfehler'],
            datasets: [{
                type: 'bar',
                label: 'Individuell',
                data: [
                    data.avg_choice_time.toFixed(2),
                    data.avg_runtime_diff.toFixed(2)
                ],
                backgroundColor: [
                    'blue',   // #4CAF50
                    'blue',   // #FFC107
                ],
                barPercentage: 0.7,       // overrides global setting
            },{
                type: 'bar',
                label: 'Kaderdurchschnitt',
                data: [
                    data.global_avg_choice_time.toFixed(2),
                    data.global_avg_runtime_diff.toFixed(2)
                ],
                backgroundColor: [
                    'rgba(127,127,127,0.5)',   // #4CAF50
                    'rgba(127,127,127,0.5)',   // #4CAF50
                ],
                barPercentage: 0.9,       // overrides global setting
            }]
        };

        const btx = document.getElementById('barChart').getContext('2d');
        barChartInstance = new Chart(btx, {
            type: 'bar',
            data: barData,
            options: {
                responsive: false,
                plugins: {
                    legend: {
                    display: true,
                    },
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        },
                        stacked: true,
                        barPercentage: 0.4,
                        categoryPercentage: 0.6     // Default is 0.8 (smaller = more spacing between groups)
                    },
                    y: {
                        grid: {
                            display: true,
                        },
                    }
                }
            }
        });
    });
}