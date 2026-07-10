// Static editor integration guards for contracts that live in the non-module
// editor bundle and therefore cannot be imported into the Node geometry suite.
// Usage: node project/static/project/js/pathing/dev/passage_editor_contract.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const editorUrl = new URL('../../editor.js', import.meta.url);
const source = await readFile(editorUrl, 'utf8');

assert.match(source, /normalizePassagesForRuntime\(\{\s*version:\s*LEVEL_PASSAGES_VERSION,\s*items:\s*nextItems/s,
    'passage commits must normalize the complete proposed document');
assert.match(source, /normalized\.passages\.length\s*===\s*nextItems\.length\s*&&\s*!normalized\.diagnostics\.length/,
    'passage commits must reject skipped or diagnosed runtime items');
assert.match(source, /const saved = await saveLevelPassages\(\);\s*await routeRefresh;\s*if \(saved\) await saveRecalculatedRoutes\(\);/s,
    'route metric saves must be gated on successful passage persistence');
assert.doesNotMatch(source, /route:\s*\{[^}]*_passageSpans/s,
    'transient surface identity must not enter Django Route payloads');

console.log('passage editor contract: aggregate validation, save gating, and transient-only spans passed');
