# Goal: uploaded-map Infinity pathfinding

Status: achieved and tuned on 2026-07-17

## Production outcome

Infinity play on uploaded maps uses the compact v6 navgraph for endpoint
snapping and five cumulative A* alternatives. Full-resolution legal spines are
built for the surviving alternatives, the final two routes are selected from
those legal-spine costs and shapes, and only those two receive the 30 px
corridor plus Theta* quality pass.

The pixel-grid editor pipeline remains the accuracy reference, but it is not run
by Infinity play.

## Selection invariants

- Generate up to five distinct cumulative navgraph routes. A partial stack may
  still be used when at least two eligible routes exist.
- Reject graph pairs whose provisional relative runtime difference is at least
  40%.
- Require route separation of `max(15 metres, 15% of direct distance)`.
- Apply runtime, side, centre, lateral, balance, and layered-passage
  distinctness checks to the legal spines before Theta*.
- Select the eligible legal-spine pair closest to the configured target relative
  difference.
- Render and enforce every unselected lower-index blocker below the larger
  selected route index.
- After Theta*, require both passes to succeed and retain blocker and mask
  legality checks. Do not repeat the selection gates on refined geometry.

Routes whose editor reference leaves the saved Infinity polygon are excluded
from accuracy comparisons. Border-adjacent comparisons may also be excluded
until graph nodes explicitly model polygon edges.

## Performance target and retained benchmark

Mean wall time until a served pair is ready must remain below 600 ms on the
reference device. The tuned file-209 run served 100/100 pairs at 570.8 ms mean,
497.9 ms median, and 928.7 ms p90.

The retained timing benchmark runs the real production `generateOnePair` path:

```powershell
npm run benchmark:pathfinding -- --mask media/masks/<mask>.png --count 100 --out scratch/pathfinding/<run-name>
```

It writes per-pair timing CSV data and a timing summary.

## Artifact policy

Normal navgraph generation writes only the compact `.navgraph.bin`. The mask and
map image remain required. `.npz` and debug PNG files are diagnostic outputs and
must only be produced by an explicit debug command.
