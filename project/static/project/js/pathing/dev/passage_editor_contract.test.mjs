// Static editor integration guards for contracts that live in the non-module
// editor bundle and therefore cannot be imported into the Node geometry suite.
// Usage: node project/static/project/js/pathing/dev/passage_editor_contract.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const editorUrl = new URL('../../editor.js', import.meta.url);
const source = await readFile(editorUrl, 'utf8');
const templateUrl = new URL('../../../../../templates/project/editor.html', import.meta.url);
const template = await readFile(templateUrl, 'utf8');
const maskSourceUrl = new URL('../../../../../../results/static/results/js/infinite/mask_scene_source.js', import.meta.url);
const maskSource = await readFile(maskSourceUrl, 'utf8');
const infinitePlayUrl = new URL('../../../../../../results/static/results/js/infinite_play.js', import.meta.url);
const infinitePlay = await readFile(infinitePlayUrl, 'utf8');
const debugInfinityUrl = new URL('../../../../../../results/static/results/js/debug_infinity.js', import.meta.url);
const debugInfinity = await readFile(debugInfinityUrl, 'utf8');

assert.match(source, /normalizePassagesForRuntime\(\{\s*version:\s*LEVEL_PASSAGES_VERSION,\s*items:\s*nextItems/s,
    'passage commits must normalize the complete proposed document');
assert.match(source, /normalized\.passages\.length\s*===\s*nextItems\.length\s*&&\s*!normalized\.diagnostics\.length/,
    'passage commits must reject skipped or diagnosed runtime items');
assert.match(source, /route_updates:\s*passageRouteMetricUpdates\(\)/,
    'passage saves must carry the derived route metric batch');
assert.match(source, /createPassageSaveClient\(\{/,
    'passage saves must go through the abortable single-flight client');
assert.doesNotMatch(source, /project\.level_passages = normalizeLevelPassagesDocument\(data/,
    'server responses must never overwrite the local passage document');
assert.match(source, /result\.data\?\.infinite_enabled === false[\s\S]*project\.infinite_enabled = false;[\s\S]*updateNavInfinityBtn/,
    'a successful passage save must mirror server-side Infinity invalidation in the navbar');
assert.match(template, /passage_save_client\.js[\s\S]*editor\.js/,
    'the save client script must load before editor.js');
assert.match(source, /if \(PassageEditor\.removeLastDraftPoint\(\)\) return true;\s*return PassageEditor\.removeLastPassage\(\);/,
    'D must remove the last draft point, else the last passage');
assert.match(source, /"third-dimension":\s*\[[^\]]*id:\s*"edit"[\s\S]*?id:\s*"remove"[^\]]*\]/,
    'the third-dimension family must expose one combined add/edit action plus remove');
assert.match(source, /const routeRefresh = invalidateRouting\(\);\s*render\(\);\s*await routeRefresh;\s*return !!\(await saveLevelPassages\(\)\);/s,
    'passage metrics must be recalculated before the single atomic save');
assert.doesNotMatch(source, /saveRecalculatedRoutes/,
    'passage actions must not issue one follow-up save per route');
assert.match(source, /fetch\("\/editor\/save-element\/"/,
    'the editor must send the coalesced payload through save-element');
assert.doesNotMatch(source, /route:\s*\{[^}]*_passageSpans/s,
    'transient surface identity must not enter Django Route payloads');
assert.doesNotMatch(source, /detail\s*>=\s*2[^}]*finish\(/s,
    'double click must not finish a passage draft');
assert.match(source, /if \(!addUndoState\) addUndoState = pushUndoState\(gettext\("Passage added"\)\);\s*draftPoints\.push/s,
    'Add must push exactly one undo state before its first draft mutation');
assert.match(source, /wheelEditTimer = setTimeout\(commitWheelEdit, WIDTH_EDIT_DEBOUNCE_MS\)/,
    'width wheel ticks must coalesce behind the idle debounce');
assert.match(source, /a\.distance - b\.distance\s*\|\| b\.renderIndex - a\.renderIndex[\s\S]*localeCompare[\s\S]*a\.pointIndex - b\.pointIndex/,
    'overlapping edit candidates must use deterministic node/render/id/index ordering');
assert.match(source, /_passageFinishRightClick[\s\S]*RCM\.cancel\(\);\s*PassageEditor\.finish\(\)/,
    'a finishing right click must suppress the radial context menu');
assert.match(source, /handleDeleteKey\(\)[\s\S]*PassageEditor\.removeLastDraftPoint\(\)/,
    'plain D must remove the last Add draft point through the shared shortcut guard');
assert.doesNotMatch(template, /passage-(?:finish|cancel)-btn/,
    'the sidebar must not retain Finish or Cancel passage buttons');
assert.match(template, /Right click \/ Enter:[^<]*D:[^<]*Escape:/,
    'the Add sidebar must describe the direct mouse and keyboard interactions');
assert.match(template, /id="passage-list"/,
    'mask mode must expose a sidebar list for passages');
assert.match(source, /row\.addEventListener\("click", \(\) => selectPassage\(passage\.id\)\)/,
    'passage sidebar rows must select and focus their passage');
assert.match(source, /function centerOnPassage\(passage\)[\s\S]*rect\.width \/ \(width \+ padding \* 2\)[\s\S]*zoomMin\), zoomMax\)[\s\S]*animateCamera/,
    'passage selection must fit its padded bounds within the global camera zoom limits');
assert.match(source, /passage-object\$\{selectedPassageId === passage\.id \? " selected" : ""\}/,
    'the selected sidebar passage must also be highlighted on the map');
assert.match(source, /const committedViews = new Map\(\);[\s\S]*function updatePassageView\([\s\S]*setAttribute\("points"/,
    'live passage edits must update persistent committed SVG nodes in place');
const passagePreviewRenderer = source.match(
    /function renderPreview\(\)\s*\{[\s\S]*?const schedulePreviewRender/
)?.[0] || '';
assert.ok(passagePreviewRenderer, 'the passage preview renderer must be present');
assert.doesNotMatch(passagePreviewRenderer, /innerHTML\s*=/,
    'the live passage preview must not rebuild its SVG layer on pointer movement');
assert.match(source, /class: "passage-mode-cursor"[\s\S]*7 \/ Math\.max\(camera\.zoom, 0\.01\)/,
    'passage add/edit mode must show a fixed-screen-size SVG cursor marker');
assert.match(source, /handlePool\.length = 0;[\s\S]*gRoot = svgNode\("g", \{ class: "region-overlay" \}\)/,
    'a rebuilt region overlay must discard handles detached with the old UI layer');
assert.match(source, /function hitHandle\(e, pt\)[\s\S]*Math\.hypot\(pt\.x - verts\[i\]\.x, pt\.y - verts\[i\]\.y\)/,
    'region vertices must remain draggable/removable through geometric hit testing');
assert.match(source, /const insertedIndex = tryInsertOnEdge\(pt\);[\s\S]*dragIdx = insertedIndex;/,
    'an edge-inserted region vertex must use its snapped index for immediate dragging');
assert.match(source, /persistPolygon\(\[\], gettext\("Region deleted\."\)\)/,
    'deleting a region must persist an explicit empty polygon snapshot');
assert.match(template, /id="region-delete-btn"[^>]*>\{% trans "Delete region" %\}<\/button>/,
    'the Infinity side panel must expose a translated region reset action');
assert.match(maskSource, /barrierWidthPx,[\s\S]*barrierClearNodeDistPx:\s*barrierWidthPx/,
    'mask workers must receive the displayed blocker width in mask pixels');
assert.match(infinitePlay, /maskBarrierStrokeWidthMapUnits\(sc\.mapScaleDenominator, sc\.editorScale\)/,
    'player blocker rendering must share the per-map width conversion');
assert.match(debugInfinity, /maskBarrierStrokeWidthMapUnits\([\s\S]*infinity_file\.map_scale[\s\S]*infinity_file\.editor_scale/,
    'the report debugger must reproduce the player blocker width');
assert.match(maskSource, /const PREFETCH_TARGET\s*=\s*5/,
    'uploaded-map Infinity must keep five validated future pairs prefetched');
assert.match(maskSource,
    /if \(this\.buffer\.length\) \{[\s\S]*const scene = this\.buffer\.shift\(\);[\s\S]*this\._scheduleRefill\(\);[\s\S]*return scene;/,
    'a prefetched mask scene must be returned before waiting for refill work');

console.log('passage editor contract: batched save and direct add/edit/remove/undo interactions passed');
