import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 18787;
const deviceToken = 'selfhost-relay-device-test-token';
const mcpToken = 'selfhost-relay-mcp-test-token';
const baseUrl = `http://127.0.0.1:${port}`;
const deviceAuthHeaders = { Authorization: `Bearer ${deviceToken}` };
const mcpAuthHeaders = { Authorization: `Bearer ${mcpToken}` };

const relay = spawn(process.execPath, [path.join(repoRoot, 'dist/relay/server.js')], {
    cwd: repoRoot,
    env: { ...process.env, QUOTA_RELAY_PORT: String(port), QUOTA_DEVICE_TOKEN: deviceToken, QUOTA_MCP_TOKEN: mcpToken },
    stdio: ['ignore', 'pipe', 'pipe']
});
relay.stdout.on('data', chunk => process.stdout.write(`[relay] ${chunk}`));
relay.stderr.on('data', chunk => process.stderr.write(`[relay] ${chunk}`));

async function waitForRelay() {
    for (let i = 0; i < 50; i++) {
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) return;
        } catch { /* retry */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Relay did not become ready');
}

let fakeRunning = true;
const fakeAbort = new AbortController();
async function fakeDevice() {
    const deviceId = 'fake-device';
    const register = await fetch(`${baseUrl}/device/register`, {
        method: 'POST',
        headers: { ...deviceAuthHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_id: deviceId,
            device_name: 'fake',
            tools: [{
                name: 'echo',
                description: 'Echo text through the relay',
                inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text']
                },
                _meta: {
                    'ui/resourceUri': 'ui://provider/test-widget',
                    'openai/outputTemplate': 'ui://provider/test-widget',
                    'openai/widgetAccessible': true
                }
            }]
        })
    });
    assert.equal(register.status, 200);

    while (fakeRunning) {
        let response;
        try {
            response = await fetch(`${baseUrl}/device/next?device_id=${deviceId}`, { headers: deviceAuthHeaders, signal: fakeAbort.signal });
        } catch (error) {
            if (!fakeRunning) return;
            throw error;
        }
        assert.equal(response.status, 200);
        const { call } = await response.json();
        if (!call) continue;
        const result = {
            content: [{ type: 'text', text: `echo:${call.tool_args.text}` }]
        };
        const report = await fetch(`${baseUrl}/device/result`, {
            method: 'POST',
            headers: { ...deviceAuthHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: deviceId, call_id: call.id, status: 'completed', result })
        });
        assert.equal(report.status, 200);
    }
}

try {
    await waitForRelay();

    const wrongDeviceAuth = await fetch(`${baseUrl}/device/register`, {
        method: 'POST',
        headers: { ...mcpAuthHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: 'must-not-register', tools: [] })
    });
    assert.equal(wrongDeviceAuth.status, 401, 'MCP credential must not authorize device APIs');

    const unauthenticatedMcp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unauthenticated-test', version: '1.0.0' } } })
    });
    assert.equal(unauthenticatedMcp.status, 401, 'MCP endpoint must reject missing credentials');

    const discoverMcp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
            ...mcpAuthHeaders,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'server/discover'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'discover-test',
            method: 'server/discover',
            params: { _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'quota-test', version: '1.0.0' },
                'io.modelcontextprotocol/clientCapabilities': {}
            } }
        })
    });
    assert.equal(discoverMcp.status, 200);
    assert.equal(discoverMcp.headers.get('mcp-session-id'), null, 'server/discover must remain sessionless');
    assert.match(discoverMcp.headers.get('content-type') || '', /application\/json/);
    const discoverEnvelope = await discoverMcp.json();
    assert.equal(discoverEnvelope.id, 'discover-test');
    assert.equal(discoverEnvelope.result.resultType, 'complete');
    assert.equal(discoverEnvelope.result._meta['io.modelcontextprotocol/serverInfo'].name, 'quota');
    assert.ok(discoverEnvelope.result.supportedVersions.includes('2026-07-28'));

    const devicePromise = fakeDevice();
    for (let i = 0; i < 50; i++) {
        const health = await fetch(`${baseUrl}/health`).then(response => response.json());
        if (health.onlineDevices?.some(device => device.tools === 1)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }

    const modernMeta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'quota-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {}
    };
    const modernHeaders = {
        ...mcpAuthHeaders,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2026-07-28'
    };

    const modernList = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { ...modernHeaders, 'Mcp-Method': 'tools/list' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'modern-tools-list',
            method: 'tools/list',
            params: { _meta: modernMeta }
        })
    });
    assert.equal(modernList.status, 200);
    assert.equal(modernList.headers.get('mcp-session-id'), null);
    const modernListEnvelope = await modernList.json();
    assert.equal(modernListEnvelope.result.resultType, 'complete');
    assert.equal(modernListEnvelope.result.tools.length, 1);
    assert.equal(modernListEnvelope.result.tools[0].name, 'echo');
    assert.equal(modernListEnvelope.result.tools[0]._meta, undefined, 'Quota must not expose inherited provider UI resources');

    const modernCall = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { ...modernHeaders, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'modern-tools-call',
            method: 'tools/call',
            params: { _meta: modernMeta, name: 'echo', arguments: { text: 'hello-modern' } }
        })
    });
    assert.equal(modernCall.status, 200);
    assert.equal(modernCall.headers.get('mcp-session-id'), null);
    const modernCallEnvelope = await modernCall.json();
    assert.equal(modernCallEnvelope.result.resultType, 'complete');
    assert.deepEqual(modernCallEnvelope.result.content, [{ type: 'text', text: 'echo:hello-modern' }]);

    const client = new Client({ name: 'selfhost-relay-test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: mcpAuthHeaders }
    });
    await client.connect(transport);

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0].name, 'echo');
    assert.equal(listed.tools[0]._meta, undefined, 'legacy tool listing must also strip inherited UI resources');

    const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'echo:hello' }]);
    console.log('PASS Quota relay: MCP listTools + callTool round-trip');

    await client.close();
    fakeRunning = false;
    fakeAbort.abort();
    await devicePromise;
    relay.kill('SIGTERM');
} finally {
    fakeRunning = false;
    fakeAbort.abort();
    relay.kill('SIGTERM');
}
