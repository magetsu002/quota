import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 18796;
const base = `http://127.0.0.1:${port}`;
const token = 'provider-crash-test-token';
const relay = spawn(process.execPath, [path.join(root, 'dist/relay/server.js')], {
    cwd: root,
    env: { ...process.env, QUOTA_RELAY_PORT: String(port),
        QUOTA_DEVICE_TOKEN: token, QUOTA_MCP_TOKEN: 'different-mcp-token' },
    stdio: ['ignore', 'pipe', 'pipe']
});
let agent;
let stderr = '';

async function health() {
    try {
        const response = await fetch(`${base}/health`);
        if (response.ok) return response.json();
    } catch { /* retry */ }
    return null;
}

async function waitFor(predicate, limitMs) {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`condition not reached: ${stderr}`);
}

try {
    await waitFor(async () => Boolean(await health()), 6500);
    agent = spawn(process.execPath, [
        path.join(root, 'dist/agent/agent.js'), '--', process.execPath,
        path.join(root, 'test/fixtures/crashing-provider.js')
    ], {
        cwd: root,
        env: { ...process.env, QUOTA_RELAY_URL: base, QUOTA_DEVICE_TOKEN: token,
            QUOTA_DEVICE_ID: 'crashing-test-provider', QUOTA_RETRY_MS: '100' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    agent.stderr.on('data', chunk => { stderr += String(chunk); });
    await waitFor(async () => (await health())?.onlineDevices?.some(d => d.tools === 1), 6500);

    const exited = await waitFor(() => agent.exitCode !== null, 6500);
    assert.ok(exited);
    assert.notEqual(agent.exitCode, 0, 'provider crash must propagate as agent failure');

    const offline = await waitFor(async () => {
        const response = await health();
        return response?.onlineDevices?.length === 0;
    }, 2500);
    assert.equal(offline, true);
    assert.match(stderr, /provider disconnected|Local MCP provider disconnected/i);
    console.log('PASS Quota agent: provider crash clears readiness and exits nonzero');
} finally {
    agent?.kill('SIGTERM');
    relay.kill('SIGTERM');
}
