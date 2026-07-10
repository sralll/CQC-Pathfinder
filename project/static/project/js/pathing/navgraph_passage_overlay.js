// Dynamic third-dimension overlay for the base-only Infinity navgraph.
//
// This module deliberately knows nothing about the serialized navgraph format.
// Callers supply the existing endpoint snapper and local A* implementation, so
// passage edits rebuild only this small in-memory overlay.

const DEFAULT_MIN_PORTALS = 3;
const DEFAULT_MAX_PORTALS = 9;
const DEFAULT_PORTAL_SPACING = 8;

function itemsFrom(documentOrItems) {
    if (Array.isArray(documentOrItems)) return documentOrItems;
    if (documentOrItems && documentOrItems.version === 1 && Array.isArray(documentOrItems.items)) {
        return documentOrItems.items;
    }
    return [];
}

function canonicalPassageJson(documentOrItems, mapWidth, mapHeight) {
    const items = itemsFrom(documentOrItems).map((item) => ({
        id: typeof item?.id === 'string' ? item.id : '',
        points: Array.isArray(item?.points)
            ? item.points.map((point) => [Number(point?.[0]), Number(point?.[1])])
            : [],
        width: Number(item?.width),
    })).sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify({ version: 1, mapWidth, mapHeight, items });
}

function hash32(text, seed) {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** Deterministic semantic cache key; independent of File.last_edited. */
export function passageRevision(documentOrItems, mapWidth, mapHeight) {
    const canonical = canonicalPassageJson(documentOrItems, mapWidth, mapHeight);
    return `p1-${hash32(canonical, 0x811c9dc5)}${hash32(canonical, 0x9e3779b9)}`;
}

function localPoint(passage, localIndex) {
    const x = localIndex % passage.localWidth;
    const y = (localIndex - x) / passage.localWidth;
    return { x, y, globalX: x + passage.originX, globalY: y + passage.originY };
}

function liveEntranceCells(state, passage, entrance) {
    const { mask, artifact } = state;
    const { W, H } = artifact;
    const cells = [];
    for (let i = 0; i < entrance.length; i++) {
        const localIndex = entrance[i];
        if (localIndex >= passage.grid.length || passage.grid[localIndex] === 0) continue;
        const point = localPoint(passage, localIndex);
        if (point.globalX < 0 || point.globalX >= W || point.globalY < 0 || point.globalY >= H) continue;
        if (mask[point.globalY * W + point.globalX] === 0) continue;
        cells.push({ ...point, localIndex });
    }
    return cells;
}

function squaredDistance(a, b) {
    const dx = a.globalX - b.globalX;
    const dy = a.globalY - b.globalY;
    return dx * dx + dy * dy;
}

// Deterministic farthest-point sampling covers both the cap width and depth.
function sampleEntrance(cells, endpoint, wanted) {
    if (cells.length <= wanted) return cells.slice().sort((a, b) => a.localIndex - b.localIndex);
    const ordered = cells.slice().sort((a, b) => a.localIndex - b.localIndex);
    let first = ordered[0];
    let firstDistance = Infinity;
    for (const cell of ordered) {
        const d = (cell.globalX - endpoint[0]) ** 2 + (cell.globalY - endpoint[1]) ** 2;
        if (d < firstDistance) { first = cell; firstDistance = d; }
    }
    const selected = [first];
    const selectedIndices = new Set([first.localIndex]);
    while (selected.length < wanted) {
        let best = null;
        let bestDistance = -1;
        for (const candidate of ordered) {
            if (selectedIndices.has(candidate.localIndex)) continue;
            let nearest = Infinity;
            for (const chosen of selected) nearest = Math.min(nearest, squaredDistance(candidate, chosen));
            if (nearest > bestDistance) { best = candidate; bestDistance = nearest; }
        }
        if (!best) break;
        selected.push(best);
        selectedIndices.add(best.localIndex);
    }
    return selected.sort((a, b) => a.localIndex - b.localIndex);
}

function addDirected(adjacency, edgeByPair, edge) {
    let list = adjacency.get(edge.from);
    if (!list) { list = []; adjacency.set(edge.from, list); }
    list.push(edge);
    edgeByPair.set(`${edge.from}:${edge.to}`, edge);
}

function reversedPath(path) {
    const out = [];
    for (let i = path.length - 1; i >= 0; i--) out.push(path[i]);
    return out;
}

function addBidirectional(adjacency, edgeByPair, edge) {
    addDirected(adjacency, edgeByPair, edge);
    addDirected(adjacency, edgeByPair, {
        ...edge,
        id: `${edge.id}:r`,
        from: edge.to,
        to: edge.from,
        path: reversedPath(edge.path),
    });
}

/**
 * Build portal nodes and dynamic edges for normalized passage rasters.
 * Passage traversal edges connect opposite caps only; there are no same-cap or
 * mid-corridor transitions, and overlapping passages remain independent.
 */
export function buildPassageOverlay(state, passages, { snapEndpoint, astarSubgrid } = {}) {
    const { artifact } = state;
    const { N } = artifact;
    const adjacency = new Map();
    const edgeByPair = new Map();
    const nodeCoords = [];
    const passageById = new Map();
    let edgeSerial = 0;
    let portalCount = 0;
    let traversalCount = 0;
    let minCostPerPx = Number.isFinite(artifact.minCostPerPx) ? artifact.minCostPerPx : 0;

    const addPortal = (point, passageId, cap) => {
        const node = N + nodeCoords.length;
        nodeCoords.push({ x: point.globalX, y: point.globalY, passageId, cap, localIndex: point.localIndex });
        return node;
    };

    for (const passage of passages || []) {
        for (let i = 0; i < passage.grid.length; i++) {
            const value = passage.grid[i];
            if (value > 0) minCostPerPx = Math.min(minCostPerPx, 255 - value);
        }
        const wanted = Math.max(DEFAULT_MIN_PORTALS, Math.min(
            DEFAULT_MAX_PORTALS,
            Math.ceil(passage.width / DEFAULT_PORTAL_SPACING) + 2,
        ));
        const liveStart = liveEntranceCells(state, passage, passage.startEntrance);
        const liveEnd = liveEntranceCells(state, passage, passage.endEntrance);
        const startCells = sampleEntrance(liveStart, passage.points[0], wanted);
        const endCells = sampleEntrance(liveEnd, passage.points[passage.points.length - 1], wanted);
        if (!startCells.length || !endCells.length) continue;

        const startPortals = startCells.map((point) => ({ point, node: addPortal(point, passage.id, 'start') }));
        const endPortals = endCells.map((point) => ({ point, node: addPortal(point, passage.id, 'end') }));
        const allPortals = startPortals.concat(endPortals);
        let connectorCount = 0;
        for (const portal of allPortals) {
            const snaps = snapEndpoint(state, { x: portal.point.globalX, y: portal.point.globalY });
            for (const snap of snaps) {
                const nodePoint = { x: artifact.nodes[2 * snap.node], y: artifact.nodes[2 * snap.node + 1] };
                addBidirectional(adjacency, edgeByPair, {
                    id: `d${edgeSerial++}`,
                    from: snap.node,
                    to: portal.node,
                    weight: snap.w,
                    surface: 'base',
                    passageId: null,
                    direction: null,
                    path: [nodePoint, { x: portal.point.globalX, y: portal.point.globalY }],
                });
                connectorCount++;
            }
        }
        if (!connectorCount) continue;

        for (const start of startPortals) {
            for (const end of endPortals) {
                const local = astarSubgrid(
                    passage.grid, passage.localWidth,
                    0, 0, passage.localWidth, passage.localHeight,
                    start.point.x, start.point.y, end.point.x, end.point.y,
                    true, Math.max(200000, passage.grid.length * 8), null,
                );
                if (!local?.path?.length) continue;
                const path = local.path.map((point) => ({
                    x: point.x + passage.originX,
                    y: point.y + passage.originY,
                }));
                addDirected(adjacency, edgeByPair, {
                    id: `d${edgeSerial++}`,
                    from: start.node,
                    to: end.node,
                    weight: local.cost,
                    surface: `passage:${passage.id}`,
                    passageId: passage.id,
                    direction: 'from-start',
                    path,
                });
                addDirected(adjacency, edgeByPair, {
                    id: `d${edgeSerial++}`,
                    from: end.node,
                    to: start.node,
                    weight: local.cost,
                    surface: `passage:${passage.id}`,
                    passageId: passage.id,
                    direction: 'from-end',
                    path: reversedPath(path),
                });
                traversalCount++;
            }
        }
        passageById.set(String(passage.id), passage);
        portalCount += allPortals.length;
    }

    return {
        nodeCount: nodeCoords.length,
        totalNodeCount: N + nodeCoords.length,
        nodeCoords,
        adjacency,
        edgeByPair,
        passageById,
        passages: Array.from(passageById.values()),
        stats: { passageCount: passageById.size, portalCount, traversalCount, dynamicEdges: edgeSerial },
        minCostPerPx,
    };
}

export function overlayNodeCoord(state, node) {
    const { artifact, passageOverlay } = state;
    if (node < artifact.N) return { x: artifact.nodes[2 * node], y: artifact.nodes[2 * node + 1] };
    return passageOverlay?.nodeCoords?.[node - artifact.N] || null;
}

export function overlayEdge(state, from, to) {
    return state.passageOverlay?.edgeByPair?.get(`${from}:${to}`) || null;
}

function appendLeg(legs, surface, passageId, direction, path) {
    if (!path?.length) return;
    let leg = legs[legs.length - 1];
    if (!leg || leg.surface !== surface || (surface !== 'base' && leg.direction !== direction)) {
        leg = { surface, passageId, direction, points: [] };
        legs.push(leg);
    }
    for (const point of path) {
        const previous = leg.points[leg.points.length - 1];
        if (!previous || previous.x !== point.x || previous.y !== point.y) leg.points.push({ x: point.x, y: point.y });
    }
}

/** Convert a graph path into surface-typed geometry while identity is intact. */
export function nodePathToTypedRoute(state, nodePath, start, goal) {
    const graphNodes = state.passageOverlay?.totalNodeCount || state.artifact.N;
    const START = graphNodes;
    const GOAL = graphNodes + 1;
    const legs = [];
    for (let i = 1; i < nodePath.length; i++) {
        const from = nodePath[i - 1];
        const to = nodePath[i];
        let path;
        let surface = 'base';
        let passageId = null;
        let direction = null;
        if (from === START) {
            path = [start, overlayNodeCoord(state, to)];
        } else if (to === GOAL) {
            path = [overlayNodeCoord(state, from), goal];
        } else {
            const dynamic = overlayEdge(state, from, to);
            if (dynamic) {
                path = dynamic.path;
                surface = dynamic.surface;
                passageId = dynamic.passageId;
                direction = dynamic.direction;
            } else {
                path = [overlayNodeCoord(state, from), overlayNodeCoord(state, to)];
            }
        }
        appendLeg(legs, surface, passageId, direction, path);
    }
    const path = [];
    for (const leg of legs) {
        for (const point of leg.points) {
            const previous = path[path.length - 1];
            if (!previous || previous.x !== point.x || previous.y !== point.y) path.push({ x: point.x, y: point.y });
        }
    }
    return { path, legs };
}

function edgeCrossesBarrier(edge, barrier, intersects) {
    const path = edge.path || [];
    for (let i = 1; i < path.length; i++) {
        if (intersects(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y,
            barrier.ax, barrier.ay, barrier.bx, barrier.by)) return true;
    }
    return false;
}

export function blockedDynamicEdges(state, barriers, intersects) {
    const blocked = new Set();
    const adjacency = state.passageOverlay?.adjacency;
    if (!adjacency || !barriers?.length) return blocked;
    for (const edges of adjacency.values()) {
        for (const edge of edges) {
            for (const barrier of barriers) {
                const barrierSurface = barrier.surface || 'base';
                if (barrierSurface !== edge.surface) continue;
                if (edgeCrossesBarrier(edge, barrier, intersects)) { blocked.add(edge.id); break; }
            }
        }
    }
    return blocked;
}
