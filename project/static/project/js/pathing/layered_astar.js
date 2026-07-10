// Sparse layered A* for third-dimension passages.
//
// The base surface is one cropped mask subgrid. Each relevant passage contributes
// two directional search-state copies over the same cropped passage raster:
// entering through the start cap can exit only through the end cap, and vice
// versa. This prevents an unreconstructable same-entrance shortcut while keeping
// allocation proportional to cropped passage area rather than full map size.

import { MinHeap } from './heap.js';

const SQRT2 = Math.SQRT2;
const DXS = new Int8Array([-1, -1, -1, 0, 0, 1, 1, 1]);
const DYS = new Int8Array([-1, 0, 1, -1, 1, -1, 0, 1]);
const STEPS = new Float32Array([SQRT2, 1, SQRT2, 1, 1, SQRT2, 1, SQRT2]);

function addTransition(map, baseIndex, layeredIndex) {
    let targets = map.get(baseIndex);
    if (!targets) {
        targets = [];
        map.set(baseIndex, targets);
    }
    targets.push(layeredIndex);
}

function globalForLocal(passage, localIndex) {
    const x = localIndex % passage.localWidth;
    const y = (localIndex - x) / passage.localWidth;
    return { x: x + passage.originX, y: y + passage.originY };
}

function liveEntrance(entrance, passage, baseGrid, baseW, baseH, baseOriginX, baseOriginY) {
    const live = [];
    for (let i = 0; i < entrance.length; i++) {
        const localIndex = entrance[i];
        if (localIndex >= passage.grid.length || passage.grid[localIndex] === 0) continue;
        const global = globalForLocal(passage, localIndex);
        const baseX = global.x - baseOriginX;
        const baseY = global.y - baseOriginY;
        if (!Number.isInteger(baseX) || !Number.isInteger(baseY)
            || baseX < 0 || baseX >= baseW || baseY < 0 || baseY >= baseH) continue;
        const baseIndex = baseY * baseW + baseX;
        if (baseGrid[baseIndex] === 0) continue;
        live.push({ localIndex, baseIndex });
    }
    return live;
}

function preparePassages(passages, base, baseCount) {
    const prepared = [];
    let nextOffset = baseCount;
    for (const passage of passages || []) {
        if (!passage?.grid?.length || !passage.startEntrance || !passage.endEntrance) continue;
        const liveStart = liveEntrance(
            passage.startEntrance, passage,
            base.grid, base.w, base.h, base.originX, base.originY,
        );
        const liveEnd = liveEntrance(
            passage.endEntrance, passage,
            base.grid, base.w, base.h, base.originX, base.originY,
        );
        if (!liveStart.length || !liveEnd.length) continue;

        const count = passage.grid.length;
        prepared.push({
            passage,
            count,
            fromStartOffset: nextOffset,
            fromEndOffset: nextOffset + count,
            liveStart,
            liveEnd,
            // Sparse local-index -> base-index exits for the opposite cap.
            fromStartExits: new Map(liveEnd.map(item => [item.localIndex, item.baseIndex])),
            fromEndExits: new Map(liveStart.map(item => [item.localIndex, item.baseIndex])),
        });
        nextOffset += 2 * count;
    }
    return { passages: prepared, nodeCount: nextOffset };
}

function maxPassableValue(grid) {
    let best = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > best) best = grid[i];
    return best;
}

/**
 * Run A* across a base subgrid plus normalized cropped passage rasters.
 *
 * @param {{grid:Uint8Array,w:number,h:number,originX:number,originY:number}} base
 * @param {{x:number,y:number}} start  base-local coordinates
 * @param {{x:number,y:number}} goal   base-local coordinates
 * @param {Array<object>} passages normalized passage objects from passage_geometry.js
 * @returns {{legs:Array<object>,nodePath:Array<number>,cost:number,stats:object}|null}
 */
export function layeredAstar(base, start, goal, passages) {
    const sx = start.x | 0;
    const sy = start.y | 0;
    const gx = goal.x | 0;
    const gy = goal.y | 0;
    if (sx < 0 || sx >= base.w || sy < 0 || sy >= base.h
        || gx < 0 || gx >= base.w || gy < 0 || gy >= base.h) return null;
    const startIndex = sy * base.w + sx;
    const goalIndex = gy * base.w + gx;
    if (base.grid[startIndex] === 0 || base.grid[goalIndex] === 0) return null;

    const baseCount = base.w * base.h;
    const prepared = preparePassages(passages, base, baseCount);

    const baseTransitions = new Map();
    for (const meta of prepared.passages) {
        for (const item of meta.liveStart) {
            addTransition(baseTransitions, item.baseIndex, meta.fromStartOffset + item.localIndex);
        }
        for (const item of meta.liveEnd) {
            addTransition(baseTransitions, item.baseIndex, meta.fromEndOffset + item.localIndex);
        }
    }

    function locate(node) {
        if (node < baseCount) {
            const x = node % base.w;
            const y = (node - x) / base.w;
            return {
                kind: 'base', surface: 'base', localIndex: node,
                x, y, globalX: x + base.originX, globalY: y + base.originY,
                grid: base.grid, w: base.w, h: base.h, meta: null,
            };
        }
        for (const meta of prepared.passages) {
            if (node >= meta.fromStartOffset && node < meta.fromStartOffset + meta.count) {
                const localIndex = node - meta.fromStartOffset;
                const x = localIndex % meta.passage.localWidth;
                const y = (localIndex - x) / meta.passage.localWidth;
                return {
                    kind: 'from-start', surface: `passage:${meta.passage.id}`,
                    localIndex, x, y,
                    globalX: x + meta.passage.originX, globalY: y + meta.passage.originY,
                    grid: meta.passage.grid, w: meta.passage.localWidth,
                    h: meta.passage.localHeight, meta,
                };
            }
            if (node >= meta.fromEndOffset && node < meta.fromEndOffset + meta.count) {
                const localIndex = node - meta.fromEndOffset;
                const x = localIndex % meta.passage.localWidth;
                const y = (localIndex - x) / meta.passage.localWidth;
                return {
                    kind: 'from-end', surface: `passage:${meta.passage.id}`,
                    localIndex, x, y,
                    globalX: x + meta.passage.originX, globalY: y + meta.passage.originY,
                    grid: meta.passage.grid, w: meta.passage.localWidth,
                    h: meta.passage.localHeight, meta,
                };
            }
        }
        return null;
    }

    let maxGrey = maxPassableValue(base.grid);
    for (const meta of prepared.passages) {
        maxGrey = Math.max(maxGrey, maxPassableValue(meta.passage.grid));
    }
    const heuristicFactor = Math.max(0, 255 - maxGrey);
    const goalGlobalX = gx + base.originX;
    const goalGlobalY = gy + base.originY;
    const heuristic = info => Math.hypot(goalGlobalX - info.globalX, goalGlobalY - info.globalY) * heuristicFactor;

    const gScore = new Float32Array(prepared.nodeCount);
    gScore.fill(Infinity);
    const parent = new Int32Array(prepared.nodeCount);
    parent.fill(-1);
    const closed = new Uint8Array(prepared.nodeCount);
    const open = new MinHeap();
    gScore[startIndex] = 0;
    open.push(heuristic(locate(startIndex)), startIndex);

    let expanded = 0;
    while (open.size > 0) {
        const current = open.pop();
        if (closed[current]) continue;
        closed[current] = 1;
        expanded++;
        if (current === goalIndex) {
            const reversed = [];
            let p = current;
            while (p !== -1) {
                reversed.push(p);
                if (p === startIndex) break;
                p = parent[p];
            }
            if (reversed[reversed.length - 1] !== startIndex) return null;
            const nodePath = reversed.reverse();
            const legs = [];
            for (const node of nodePath) {
                const info = locate(node);
                let leg = legs[legs.length - 1];
                if (!leg || leg.surface !== info.surface) {
                    leg = {
                        surface: info.surface,
                        passageId: info.meta?.passage?.id || null,
                        direction: info.kind === 'base' ? null : info.kind,
                        points: [],
                    };
                    legs.push(leg);
                }
                const n = leg.points.length;
                if (n < 2 || leg.points[n - 2] !== info.globalX || leg.points[n - 1] !== info.globalY) {
                    leg.points.push(info.globalX, info.globalY);
                }
            }
            // Both sides of a zero-length transition must own its coordinate.
            for (let i = 1; i < legs.length; i++) {
                const previous = legs[i - 1];
                const currentLeg = legs[i];
                const px = previous.points[previous.points.length - 2];
                const py = previous.points[previous.points.length - 1];
                if (currentLeg.points[0] !== px || currentLeg.points[1] !== py) {
                    currentLeg.points.unshift(px, py);
                }
            }
            return {
                legs,
                nodePath,
                cost: gScore[goalIndex],
                stats: {
                    expanded,
                    allocatedNodes: prepared.nodeCount,
                    baseNodes: baseCount,
                    selectedPassages: prepared.passages.length,
                    passageStateNodes: prepared.nodeCount - baseCount,
                    heuristicFactor,
                },
            };
        }

        const info = locate(current);
        const gCurrent = gScore[current];
        for (let k = 0; k < 8; k++) {
            const nx = info.x + DXS[k];
            const ny = info.y + DYS[k];
            if (nx < 0 || nx >= info.w || ny < 0 || ny >= info.h) continue;
            const localIndex = ny * info.w + nx;
            const grey = info.grid[localIndex];
            if (grey === 0) continue;
            let neighbour;
            if (info.kind === 'base') neighbour = localIndex;
            else if (info.kind === 'from-start') neighbour = info.meta.fromStartOffset + localIndex;
            else neighbour = info.meta.fromEndOffset + localIndex;
            if (closed[neighbour]) continue;
            const tentative = gCurrent + STEPS[k] * (255 - grey);
            if (tentative < gScore[neighbour]) {
                gScore[neighbour] = tentative;
                parent[neighbour] = current;
                open.push(tentative + heuristic(locate(neighbour)), neighbour);
            }
        }

        if (info.kind === 'base') {
            for (const neighbour of baseTransitions.get(info.localIndex) || []) {
                if (closed[neighbour] || gCurrent >= gScore[neighbour]) continue;
                gScore[neighbour] = gCurrent;
                parent[neighbour] = current;
                open.push(gCurrent + heuristic(locate(neighbour)), neighbour);
            }
        } else {
            const exitMap = info.kind === 'from-start'
                ? info.meta.fromStartExits
                : info.meta.fromEndExits;
            const neighbour = exitMap.get(info.localIndex);
            if (neighbour !== undefined && !closed[neighbour] && gCurrent < gScore[neighbour]) {
                gScore[neighbour] = gCurrent;
                parent[neighbour] = current;
                open.push(gCurrent + heuristic(locate(neighbour)), neighbour);
            }
        }
    }
    return null;
}
