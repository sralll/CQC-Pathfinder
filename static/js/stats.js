const bgColor = getBackgroundColor(); // Gets the background color of <html>

function getBackgroundColor() {
    return document.getElementById("statsContainer").backgroundColor;
}

let isMobile = null;
const screenWidth = window.innerWidth;

const doughnutChart = document.getElementById('doughnutChart');
const barChart = document.getElementById('barChart');

let doughnutChartInstance = null;
let barChartInstance = null;

if(!isTrainer) {
    document.addEventListener('DOMContentLoaded', function () {
        isMobile = document.body.classList.contains('mobile');

        if (isMobile) {
            doughnutChart.width = 0.9*screenWidth;
            doughnutChart.height = 0.9*screenWidth;
            barChart.width = 0.9*screenWidth;
            barChart.height = 0.9*screenWidth;
            doughnutChart.style.width = "90vw";
            barChart.style.width = "90vw";
        } else {
            doughnutChart.width = 0.45*screenWidth;
            doughnutChart.height = 0.45*screenWidth;
            barChart.style.width = "45vw";
            barChart.style.height = "45vw";
        }

        if (!isTrainer) {
            updateStats();
        }
    });
}

function home() {
    window.location.href = "/";
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
                ctx.font = '50px Arial';
                ctx.fillStyle = 'black';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                let ncP_pos = -20;
                ctx.fillText(data.total_entries || '', centerX, centerY+ncP_pos);

                ctx.font = '25px Arial';
                let tcP_pos = 20;
                ctx.fillText('Posten' || '', centerX, centerY+tcP_pos);
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
                            size: isMobile ? 20 : 12
                        },
                    },
                    title: {
                        display: true,
                        text: 'Routenwahl',
                        color: 'black',
                        font: {
                            size: isMobile ? 30 : 16,
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
                        labels: {
                            font: {
                                size: isMobile ? 20 : 12
                            },
                        }
                    },
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        },
                        stacked: true,
                        barPercentage: 0.4,
                        categoryPercentage: 0.6,
                        ticks: {
                            font: {
                                size: isMobile ? 20 : 12
                            },
                        }
                    },
                    y: {
                        grid: {
                            display: true,
                        },
                        ticks: {
                            font: {
                                size: isMobile ? 20 : 12
                            },
                        },
                    }
                }
            }
        });
    });
}

document.addEventListener("DOMContentLoaded", () => {
  if (!isTrainer) return;

  const toggle = document.getElementById("trainingToggle");

  // initial load
  loadTrainerStats(toggle.checked);

  // reload on toggle
  toggle.addEventListener("change", () => {
    const tbody = document.querySelector("#trainerStatsTable tbody");
    tbody.style.opacity = 0.2;
    loadTrainerStats(toggle.checked);
  });
});

async function loadTrainerStats(isTraining) {
  const tbody = document.querySelector("#trainerStatsTable tbody");

  const mode = isTraining ? "competition" : "training";

  try {
    const response = await fetch(`/stats/table/?mode=${mode}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    tbody.innerHTML = "";

    if (data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8">Keine Daten vorhanden</td>
        </tr>
      `;
      return;
    }

    for (const row of data) {
      const isSummary = row.athlete.includes("Kaderdurchschnitt");

      tbody.insertAdjacentHTML(
        "beforeend",
        `
        <tr ${isSummary ? 'class="summary-row" style="font-weight: bold; color:blue"' : ''}>
            <td>${row.athlete}</td>
            <td>${row.posten}</td>
            <td>${formatTime(row.avg_choice_time)}</td>
            <td>${formatError(row.avg_error)}</td>
            <td>${row.schnellste}%</td>
            <td>${row.lt5}%</td>
            <td>${row.lt10}%</td>
            <td>${row.gt10}%</td>
        </tr>
        `
      );
    }
    tbody.style.opacity = 1;

  } catch (err) {
    console.error(err);
    tbody.innerHTML = `
      <tr>
        <td colspan="8">Fehler beim Laden der Daten</td>
      </tr>
    `;
  }
}

function formatTime(seconds) {
  if (seconds === null || seconds === undefined) return "–";
  return seconds.toFixed(1) + " s";
}

function formatError(seconds) {
  if (seconds === null || seconds === undefined) return "–";
  return seconds.toFixed(1) + " s";
}

const table = document.getElementById("trainerStatsTable");
if (table) {
    const headers = table.querySelectorAll("th");

    headers.forEach((th, index) => {
        th.style.cursor = "pointer";
        th.addEventListener("click", () => {
            const tbody = table.querySelector("tbody");
            const allRows = Array.from(tbody.querySelectorAll("tr"));
            const ascending = !th.asc;
            th.asc = ascending;

            // Separate summary row
            const summaryRow = allRows.find(r => r.classList.contains("summary-row"));
            const rows = allRows.filter(r => !r.classList.contains("summary-row"));

            rows.sort((a, b) => {
                const aText = a.children[index].textContent.trim();
                const bText = b.children[index].textContent.trim();

                const aNum = parseFloat(aText.replace(",", "."));
                const bNum = parseFloat(bText.replace(",", "."));

                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return ascending ? aNum - bNum : bNum - aNum;
                }
                return ascending ? aText.localeCompare(bText) : bText.localeCompare(aText);
            });

            tbody.innerHTML = "";
            if (summaryRow) tbody.appendChild(summaryRow); // summary always first
            rows.forEach(r => tbody.appendChild(r));
        });
    });
}