// Behavioral fetch-spy verification of the coalesced passage persistence path
// (CR 2 follow-up). Drives the exact client editor.js uses — one save-element
// request per committed action carrying the complete document and route metric
// batch, newer saves abort the in-flight request, and an aborted request is
// reported as superseded, never as a failure.
// Usage:
//   node project/static/project/js/pathing/dev/passage_save_client.test.mjs

import assert from 'node:assert/strict';

// The classic script attaches the factory to globalThis; importing it as an
// ES module executes it once in this process.
await import('../../passage_save_client.js');
const { createPassageSaveClient } = globalThis;
assert.equal(typeof createPassageSaveClient, 'function');

function jsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function makeSpyFetch() {
    const calls = [];
    return {
        calls,
        fetch(url, init) {
            const call = { url, init, settle: null };
            calls.push(call);
            return new Promise((resolve, reject) => {
                call.settle = { resolve, reject };
                init.signal.addEventListener('abort', () => {
                    const error = new Error('The operation was aborted.');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        },
    };
}

function passagePayload(routeCount, marker) {
    return {
        file_id: 7,
        type: 'level_passages',
        level_passages: { version: 1, items: [{ id: marker, points: [[1, 1], [9, 1]], width: 4 }] },
        route_updates: Array.from({ length: routeCount }, (_, i) => ({
            cp_db_id: 100 + i,
            route: { db_id: 200 + i, obstacle: i, run_time: 60 + i },
        })),
    };
}

// One committed action produces exactly one save-element request whose body
// carries the canonical document and every derived route metric.
{
    const spy = makeSpyFetch();
    const client = createPassageSaveClient({
        fetchImpl: spy.fetch,
        getCsrfToken: () => 'token-1',
    });
    const payload = passagePayload(12, 'single');
    const pending = client.save(payload);
    assert.equal(spy.calls.length, 1);
    const call = spy.calls[0];
    assert.equal(call.url, '/editor/save-element/');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['X-CSRFToken'], 'token-1');
    const body = JSON.parse(call.init.body);
    assert.equal(body.type, 'level_passages');
    assert.equal(body.route_updates.length, 12);
    assert.deepEqual(body.route_updates[11], {
        cp_db_id: 111, route: { db_id: 211, obstacle: 11, run_time: 71 },
    });
    assert.equal(client.pending(), true);
    call.settle.resolve(jsonResponse({ status: 'ok', last_edited: '2026-07-11T10:00:00' }));
    const result = await pending;
    assert.deepEqual(result, {
        status: 'saved',
        data: { status: 'ok', last_edited: '2026-07-11T10:00:00' },
    });
    assert.equal(client.pending(), false);
}

// A burst of edits on a slow connection: each new save aborts the in-flight
// request; only the newest request completes and stale responses can never be
// applied because superseded saves return no data at all.
{
    const spy = makeSpyFetch();
    const client = createPassageSaveClient({ fetchImpl: spy.fetch, getCsrfToken: () => 't' });
    const first = client.save(passagePayload(1, 'v1'));
    const second = client.save(passagePayload(1, 'v2'));
    const third = client.save(passagePayload(1, 'v3'));
    assert.equal(spy.calls.length, 3);
    assert.equal(spy.calls[0].init.signal.aborted, true);
    assert.equal(spy.calls[1].init.signal.aborted, true);
    assert.equal(spy.calls[2].init.signal.aborted, false);
    assert.deepEqual(await first, { status: 'superseded', data: null });
    assert.deepEqual(await second, { status: 'superseded', data: null });
    spy.calls[2].settle.resolve(jsonResponse({ status: 'ok' }));
    assert.deepEqual(await third, { status: 'saved', data: { status: 'ok' } });
    assert.equal(client.pending(), false);
    assert.equal(JSON.parse(spy.calls[2].init.body).level_passages.items[0].id, 'v3');
}

// Server-side rejections surface as errors with the response payload; real
// network failures (not aborts) are reported as failed.
{
    const spy = makeSpyFetch();
    const client = createPassageSaveClient({ fetchImpl: spy.fetch, getCsrfToken: () => 't' });
    const rejected = client.save(passagePayload(1, 'bad'));
    spy.calls[0].settle.resolve(jsonResponse({ error: 'invalid_route_updates', detail: 'x' }, false, 400));
    const rejectedResult = await rejected;
    assert.equal(rejectedResult.status, 'error');
    assert.equal(rejectedResult.data.error, 'invalid_route_updates');

    const failing = client.save(passagePayload(1, 'net'));
    spy.calls[1].settle.reject(new TypeError('network down'));
    const failedResult = await failing;
    assert.equal(failedResult.status, 'failed');
    assert.equal(failedResult.error.message, 'network down');
    assert.equal(client.pending(), false);
}

console.log('passage save client: single coalesced request, abort-on-newer-save, and failure taxonomy passed');
