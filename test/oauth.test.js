import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 18788;
const deviceToken = 'oauth-device-test-token';
const staticMcpToken = 'oauth-static-tunnel-token';
const ownerPassphrase = 'oauth-owner-test-passphrase';
const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${baseUrl}/mcp`;
const deviceHeaders = { Authorization: `Bearer ${deviceToken}` };

const relay = spawn(process.execPath, [path.join(repoRoot, 'dist/relay/server.js')], {
    cwd: repoRoot,
    env: {
        ...process.env,
        QUOTA_RELAY_PORT: String(port),
        QUOTA_DEVICE_TOKEN: deviceToken,
        QUOTA_MCP_TOKEN: staticMcpToken,
        QUOTA_PUBLIC_URL: baseUrl,
        QUOTA_OAUTH_OWNER_SECRET: ownerPassphrase
    },
    stdio: ['ignore', 'pipe', 'pipe']
});relay.stdout.on('data', chunk => process.stdout.write(`[relay] ${chunk}`));
relay.stderr.on('data', chunk => process.stderr.write(`[relay] ${chunk}`));

async function waitForRelay() {
    for (let i = 0; i < 50; i++) {
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) return;
        } catch { /* retry */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('OAuth relay did not become ready');
}

let fakeRunning = true;
const fakeAbort = new AbortController();
async function fakeDevice() {
    const deviceId = 'oauth-fake-device';
    const register = await fetch(`${baseUrl}/device/register`, {
        method: 'POST',
        headers: { ...deviceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_id: deviceId,
            device_name: 'oauth-fake',
            tools: [{
                name: 'echo',
                description: 'Echo through OAuth relay',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
            }]
        })
    });    assert.equal(register.status, 200);
    while (fakeRunning) {
        let response;
        try {
            response = await fetch(`${baseUrl}/device/next?device_id=${deviceId}`, {
                headers: deviceHeaders,
                signal: fakeAbort.signal
            });
        } catch (error) {
            if (!fakeRunning) return;
            throw error;
        }
        assert.equal(response.status, 200);
        const { call } = await response.json();
        if (!call) continue;
        const result = { content: [{ type: 'text', text: `oauth:${call.tool_args.text}` }] };
        const report = await fetch(`${baseUrl}/device/result`, {
            method: 'POST',
            headers: { ...deviceHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: deviceId,
                call_id: call.id,
                status: 'completed',
                result
            })
        });
        assert.equal(report.status, 200);
    }
}

function pkceChallenge(verifier) {
    return createHash('sha256').update(verifier).digest('base64url');
}
try {
    await waitForRelay();
    const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(new URL(metadata.issuer).origin, new URL(baseUrl).origin);
    assert.ok(metadata.registration_endpoint);
    assert.ok(metadata.authorization_endpoint);
    assert.ok(metadata.token_endpoint);

    const tunnelDiscover = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${staticMcpToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'server/discover'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'tunnel-discover',
            method: 'server/discover',
            params: {
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientInfo': { name: 'quota-oauth-test', version: '1.0.0' },
                    'io.modelcontextprotocol/clientCapabilities': {}
                }
            }
        })
    });
    assert.equal(tunnelDiscover.status, 200);
    const tunnelDiscoverEnvelope = await tunnelDiscover.json();
    assert.equal(tunnelDiscoverEnvelope.result.resultType, 'complete');
    assert.ok(tunnelDiscoverEnvelope.result.supportedVersions.includes('2026-07-28'));

    const redirectUri = 'https://example.test/oauth/callback';
    const registration = await fetch(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_name: 'selfhost-oauth-test'
        })
    });
    const registrationText = await registration.text();
    assert.equal(registration.status, 201, registrationText);
    const clientInfo = JSON.parse(registrationText);

    const verifier = 'oauth-test-verifier-0123456789abcdefghijklmnopqrstuvwxyz';
    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientInfo.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);    authorizeUrl.searchParams.set('scope', 'mcp:tools');
    authorizeUrl.searchParams.set('state', 'state-123');
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('resource', mcpUrl);

    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(authorize.status, 200);
    assert.equal(authorize.headers.get('cache-control'), 'no-store');
    assert.match(authorize.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(authorize.headers.get('referrer-policy'), 'no-referrer');
    const html = await authorize.text();
    assert.match(html, /<title>Authorize Quota<\/title>/);
    assert.match(html, /Authorization request/);
    assert.match(html, /background: #090a0c/);
    assert.match(html, /selfhost-oauth-test/);
    const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
    assert.ok(requestId, 'authorization page must contain request_id');

    const approved = await fetch(`${baseUrl}/oauth/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_id: requestId, owner_secret: ownerPassphrase }),
        redirect: 'manual'
    });
    assert.equal(approved.status, 302);
    const callback = new URL(approved.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'state-123');
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const tokenResponse = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientInfo.client_id,
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            resource: mcpUrl
        })
    });    const tokenText = await tokenResponse.text();
    assert.equal(tokenResponse.status, 200, tokenText);
    const tokens = JSON.parse(tokenText);
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);

    const devicePromise = fakeDevice();
    const client = new Client({ name: 'selfhost-oauth-test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    });
    await client.connect(transport);

    const listed = await client.listTools();
    assert.equal(listed.tools[0]?.name, 'echo');
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'oauth:hello' }]);
    await client.close();

    const refreshResponse = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientInfo.client_id,
            refresh_token: tokens.refresh_token,
            scope: 'mcp:tools',
            resource: mcpUrl
        })
    });    const refreshText = await refreshResponse.text();
    assert.equal(refreshResponse.status, 200, refreshText);
    const refreshed = JSON.parse(refreshText);
    assert.ok(refreshed.access_token);

    console.log('PASS Quota OAuth relay: discovery + PKCE + refresh + MCP round-trip');
    fakeRunning = false;
    fakeAbort.abort();
    await devicePromise;
} finally {
    fakeRunning = false;
    fakeAbort.abort();
    relay.kill('SIGTERM');
}
