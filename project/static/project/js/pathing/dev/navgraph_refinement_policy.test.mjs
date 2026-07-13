import assert from 'node:assert/strict';

import {
	DEFAULT_CONFIG,
	refinementPairCanBeServed,
} from '../navgraph_router.js';

assert.equal(DEFAULT_CONFIG.refineTimeoutPolicy, 'reject',
	'uploaded-map Infinity must not serve a dense legal-spine fallback');

assert.equal(refinementPairCanBeServed('reject', 'theta', 'theta'), true);
assert.equal(refinementPairCanBeServed('reject', 'legal-fallback', 'theta'), false);
assert.equal(refinementPairCanBeServed('reject', 'theta', 'legal-fallback'), false);
assert.equal(refinementPairCanBeServed('reject', 'legal-fallback', 'legal-fallback'), false);
assert.equal(refinementPairCanBeServed('reject', 'unusable', 'theta'), false);

// The old fallback mode remains available for explicit diagnostics only.
assert.equal(refinementPairCanBeServed('fallback', 'legal-fallback', 'theta'), true);
assert.equal(refinementPairCanBeServed('fallback', 'unusable', 'theta'), false);

console.log('navgraph refinement policy tests passed');
