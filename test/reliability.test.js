import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 18794;
const base = `http://127.0.0.1:${port}`;
const deviceToken = 'reliability-test-device';
const mcpToken = 'reliability-test-mcp';
const deviceHeaders = { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' };
const mcpHeaders = {
    Authorization: `Bearer ${mcpToken}`,
    'Content-Type': 'application/json',
    'Mcp-Protocol-Version': '2026-07-28'
};
const relay = spawn(process.execPath, [path.join(root, 'dist/relay/server.js')], {
    cwd: root,
    env: {
        ...process.env,
        QUOTA_RELAY_PORT: String(port),
        QUOTA_DEVICE_TOKEN: deviceToken,
        QUOTA_MCP_TOKEN: mcpToken,
        QUOTA_TOOL_TIMEOUT_MS: '250',
        QUOTA_LONG_POLL_MS: '50'
    },
    stdio: ['ignore', 'pipe', 'pipe']
});
relay.stderr.on('data', chunk => process.stderr.write(chunk));

async function ready() {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            if ((await fetch(`${base}/health`)).ok) return;
        } catch { /* retry */ }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('relay not ready');
}

async function device(route, payload) {
    return fetch(`${base}/device/${route}`, {
        method: 'POST', headers: deviceHeaders, body: JSON.stringify(payload)
    });
}

async function register() {
    const response = await device('register', {
        device_id: 'test-device',
        device_name: 'test',
        tools: [{
            name: 'danger',
            inputSchema: { type: 'object', properties: {} },
            _meta: { 'ui/resourceUri': 'ui://unproxied', 'custom/key': 'preserved' }
        }]
    });
    assert.equal(response.status, 200);
}

function call(name = 'danger') {
    return fetch(`${base}/mcp`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'tools/call',
            params: { name, arguments: {} } })
    }).then(response => response.json());
}

try {
    await ready();
    await register();
    let state = await (await fetch(`${base}/health`)).json();
    assert.equal(state.onlineDevices.length, 1);

    const unknown = await call('unregistered');
    assert.match(unknown.error.message, /Unknown tool/);

    const listing = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} })
    }).then(response => response.json());
    assert.deepEqual(listing.result.tools[0]._meta, { 'custom/key': 'preserved' });

    // A timed-out queued call must never execute afterwards.
    const timedOut = await call();
    assert.match(timedOut.error.message, /timed out/);
    const afterTimeout = await fetch(`${base}/device/next?device_id=test-device`, {
        headers: deviceHeaders
    }).then(response => response.json());
    assert.equal(afterTimeout.call, null, 'expired call must be removed from the device queue');

    // Explicit provider loss must reject awaiting callers promptly.
    const pending = call();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await device('offline', { device_id: 'test-device' })).status, 200);
    const interrupted = await pending;
    assert.match(interrupted.error.message, /disconnected/);

    state = await (await fetch(`${base}/health`)).json();
    assert.equal(state.onlineDevices.length, 0);
    const offlineCall = await call();
    assert.match(offlineCall.error.message, /No Quota agent is online/);

    await register();
    state = await (await fetch(`${base}/health`)).json();
    assert.equal(state.onlineDevices.length, 1);

    // Re-registering an agent must not replay an old queued request.
    const oldCall = call();
    await new Promise(resolve => setTimeout(resolve, 25));
    await register();
    const interruptedByRestart = await oldCall;
    assert.match(interruptedByRestart.error.message, /re-registered/);
    const noReplay = await fetch(`${base}/device/next?device_id=test-device`, {
        headers: deviceHeaders
    }).then(response => response.json());
    assert.equal(noReplay.call, null);

    console.log('PASS Quota reliability: stale queues, offline devices, reconnect, metadata');
} finally {
    relay.kill('SIGTERM');
}
