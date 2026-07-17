// Canonical passage-document revision shared by the worker, the router, and
// project/navgraph.py. The former dynamic runtime overlay was removed once the
// serialized v6 artifact became the single source of passage topology (CR 8.3);
// only the deterministic revision hash remains.

function itemsFrom(documentOrItems) {
    if (Array.isArray(documentOrItems)) return documentOrItems;
    if (documentOrItems && documentOrItems.version === 1 && Array.isArray(documentOrItems.items)) {
        return documentOrItems.items;
    }
    return [];
}

function canonicalPassageJson(documentOrItems, mapWidth, mapHeight) {
    // Sort by id in codepoint order (not localeCompare): this is engine- and
    // language-independent, so project/navgraph.py can reproduce the exact same
    // canonical string and revision. Change the two together (CR 8.1).
    const items = itemsFrom(documentOrItems).map((item) => ({
        id: typeof item?.id === 'string' ? item.id : '',
        points: Array.isArray(item?.points)
            ? item.points.map((point) => [Number(point?.[0]), Number(point?.[1])])
            : [],
        width: Number(item?.width),
    })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
