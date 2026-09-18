#!/usr/bin/env node

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { SingleUserOAuthProvider } from './oauth.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = Number.parseInt(process.env.QUOTA_RELAY_PORT || '8787', 10);
const HOST = process.env.QUOTA_RELAY_HOST || '127.0.0.1';
const DEVICE_TOKEN = process.env.QUOTA_DEVICE_TOKEN || '';
const MCP_TOKEN = process.env.QUOTA_MCP_TOKEN || '';
const ALLOW_ANONYMOUS_MCP = process.env.QUOTA_ALLOW_ANONYMOUS_MCP === 'true';
const PUBLIC_URL = process.env.QUOTA_PUBLIC_URL || '';
const OAUTH_OWNER_SECRET = process.env.QUOTA_OAUTH_OWNER_SECRET || '';
const OAUTH_STATE_PATH = process.env.QUOTA_OAUTH_STATE_PATH || '';
const TARGET_DEVICE_ID = process.env.QUOTA_TARGET_DEVICE_ID || '';
const DEVICE_STALE_MS = Number.parseInt(process.env.QUOTA_DEVICE_STALE_MS || '60000', 10);
const TOOL_TIMEOUT_MS = Number.parseInt(process.env.QUOTA_TOOL_TIMEOUT_MS || '300000', 10);
const LONG_POLL_MS = Number.parseInt(process.env.QUOTA_LONG_POLL_MS || '25000', 10);

if (Boolean(PUBLIC_URL) !== Boolean(OAUTH_OWNER_SECRET)) {
    throw new Error('QUOTA_PUBLIC_URL and QUOTA_OAUTH_OWNER_SECRET must be configured together');
}
if (PUBLIC_URL && ALLOW_ANONYMOUS_MCP) {
    throw new Error('OAuth mode cannot be combined with QUOTA_ALLOW_ANONYMOUS_MCP=true');
}

const publicBaseUrl = PUBLIC_URL ? new URL(PUBLIC_URL) : undefined;
if (publicBaseUrl && publicBaseUrl.protocol !== 'https:' && publicBaseUrl.hostname !== '127.0.0.1' && publicBaseUrl.hostname !== 'localhost') {
    throw new Error('QUOTA_PUBLIC_URL must use HTTPS except for localhost testing');
}
const publicMcpUrl = publicBaseUrl ? new URL('/mcp', publicBaseUrl) : undefined;

type RelayCall = {
    id: string;
    tool_name: string;
    tool_args: unknown;
    metadata: Record<string, unknown>;
};

type DeviceState = {
    id: string;
    name: string;
    tools: any[];
    lastSeen: number;
    queue: RelayCall[];
    waiters: Set<() => void>;
};

type PendingCall = {
    deviceId: string;
    resolve: (value: any) => void;
    reject: (reason?: unknown) => void;
    timer: NodeJS.Timeout;
};

const devices = new Map<string, DeviceState>();
const pendingCalls = new Map<string, PendingCall>();

function safeTokenEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: any): string {
    const header = String(req.headers?.authorization || '');
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function hasStaticMcpToken(req: any): boolean {
    return Boolean(MCP_TOKEN) && safeTokenEqual(bearer(req), MCP_TOKEN);
}

function requireDeviceToken(req: any, res: any, next: any): void {
    if (!DEVICE_TOKEN) {
        res.status(503).json({ error: 'QUOTA_DEVICE_TOKEN is not configured' });
        return;
    }
    if (!safeTokenEqual(bearer(req), DEVICE_TOKEN)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    next();
}

const oauthProvider = publicMcpUrl && OAUTH_OWNER_SECRET
    ? new SingleUserOAuthProvider(OAUTH_OWNER_SECRET, publicMcpUrl, OAUTH_STATE_PATH || undefined)
    : undefined;
const oauthBearerAuth = oauthProvider && publicMcpUrl
    ? requireBearerAuth({
        verifier: oauthProvider,
        requiredScopes: ['mcp:tools'],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicMcpUrl)
    })
    : undefined;

function requireMcpAuth(req: any, res: any, next: any): void {
    if (hasStaticMcpToken(req)) {
        next();
        return;
    }
    if (oauthBearerAuth) {
        oauthBearerAuth(req, res, next);
        return;
    }
    if (ALLOW_ANONYMOUS_MCP) {
        next();
        return;
    }
    if (!MCP_TOKEN) {
        res.status(503).json({ error: 'QUOTA_MCP_TOKEN is not configured' });
        return;
    }
    if (!safeTokenEqual(bearer(req), MCP_TOKEN)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    next();
}

function isOnline(device: DeviceState): boolean {
    return Date.now() - device.lastSeen <= DEVICE_STALE_MS;
}

function activeDevice(): DeviceState {
    if (TARGET_DEVICE_ID) {
        const target = devices.get(TARGET_DEVICE_ID);
        if (!target || !isOnline(target)) throw new Error(`Target device '${TARGET_DEVICE_ID}' is offline`);
        return target;
    }
    const online = [...devices.values()].filter(isOnline);
    if (online.length === 0) throw new Error('No Quota agent is online');
    if (online.length > 1) throw new Error('Multiple devices are online; set QUOTA_TARGET_DEVICE_ID to choose one');
    return online[0];
}

function touch(deviceId: string): DeviceState {
    const device = devices.get(deviceId);
    if (!device) throw new Error(`Unknown device '${deviceId}'`);
    device.lastSeen = Date.now();
    return device;
}

function wakeDevice(device: DeviceState): void {
    for (const wake of device.waiters) wake();
    device.waiters.clear();
}

function publicToolDescriptor(tool: any): any {
    const { _meta: _providerUiMeta, ...publicTool } = tool;
    return publicTool;
}

function publicTools(device: DeviceState): any[] {
    return device.tools.map(publicToolDescriptor);
}

async function dispatchTool(name: string, args: unknown, metadata: Record<string, unknown>): Promise<any> {
    const device = activeDevice();
    const id = randomUUID();
    const call: RelayCall = { id, tool_name: name, tool_args: args ?? {}, metadata };
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingCalls.delete(id);
            reject(new Error(`Tool call '${name}' timed out after ${TOOL_TIMEOUT_MS}ms`));
        }, TOOL_TIMEOUT_MS);
        pendingCalls.set(id, { deviceId: device.id, resolve, reject, timer });
        device.queue.push(call);
        wakeDevice(device);
    });
}

const MODERN_PROTOCOL_VERSION = '2026-07-28';

function requestProtocolVersion(req: any): string {
    const headerVersion = String(req.headers?.['mcp-protocol-version'] || '');
    if (headerVersion) return headerVersion;
    const metaVersion = req.body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    return typeof metaVersion === 'string' ? metaVersion : '';
}

function isModernSelfContainedRequest(req: any): boolean {
    return requestProtocolVersion(req) === MODERN_PROTOCOL_VERSION;
}

function sendModernResult(res: any, requestId: unknown, result: Record<string, unknown>): void {
    res.status(200).json({
        jsonrpc: '2.0',
        id: requestId ?? null,
        result: {
            resultType: 'complete',
            ...result
        }
    });
}

function sendModernError(res: any, requestId: unknown, code: number, message: string): void {
    res.status(200).json({
        jsonrpc: '2.0',
        id: requestId ?? null,
        error: { code, message }
    });
}

async function handleModernRequest(req: any, res: any): Promise<boolean> {
    if (!isModernSelfContainedRequest(req)) return false;

    const body = req.body ?? {};
    const requestId = body.id ?? null;

    switch (body.method) {
        case 'server/discover':
            sendModernResult(res, requestId, {
                supportedVersions: [
                    MODERN_PROTOCOL_VERSION,
                    '2025-11-25',
                    '2025-06-18',
                    '2025-03-26',
                    '2024-11-05'
                ],
                capabilities: { tools: { listChanged: true } },
                ttlMs: 0,
                cacheScope: 'private',
                _meta: {
                    'io.modelcontextprotocol/serverInfo': {
                        name: 'quota',
                        version: '0.1.0'
                    }
                }
            });
            return true;

        case 'tools/list': {
            const device = activeDevice();
            sendModernResult(res, requestId, { tools: publicTools(device) });
            return true;
        }

        case 'tools/call': {
            const name = String(body.params?.name || '');
            if (!name) {
                sendModernError(res, requestId, -32602, 'Tool name is required');
                return true;
            }
            try {
                const result = await dispatchTool(
                    name,
                    body.params?.arguments ?? {},
                    (body.params?._meta ?? {}) as Record<string, unknown>
                );
                sendModernResult(res, requestId, result ?? {});
            } catch (error: any) {
                sendModernError(res, requestId, -32603, error?.message || 'Remote tool failed');
            }
            return true;
        }

        case 'ping':
            sendModernResult(res, requestId, {});
            return true;

        default:
            sendModernError(res, requestId, -32601, `Method not found: ${String(body.method || '')}`);
            return true;
    }
}

function createProtocolServer(): Server {
    const server = new Server(
        {
            name: 'quota',
            version: '0.1.0'
        },
        {
            capabilities: { tools: {} },
            instructions: 'Quota provides authenticated remote filesystem, terminal, process, and machine tools through a self-hosted device agent.'
        }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const device = activeDevice();
        return { tools: publicTools(device) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const result = await dispatchTool(
            request.params.name,
            request.params.arguments ?? {},
            (request.params._meta ?? {}) as Record<string, unknown>
        );
        return result;
    });
    return server;
}

const protocolServer = createProtocolServer();

const allowedHosts = publicBaseUrl
    ? [publicBaseUrl.hostname, '127.0.0.1', 'localhost', '[::1]']
    : undefined;
const app = createMcpExpressApp({ host: HOST, allowedHosts });

if (oauthProvider && publicBaseUrl && publicMcpUrl) {
    app.get('/.well-known/oauth-protected-resource', (_req: any, res: any) => {
        res.json({
            resource: publicMcpUrl.href,
            authorization_servers: [publicBaseUrl.href],
            scopes_supported: ['mcp:tools'],
            resource_name: 'Quota'
        });
    });

    app.post('/oauth/approve', async (req: any, res: any) => {
        let raw = '';
        for await (const chunk of req) raw += chunk.toString();
        const form = new URLSearchParams(raw);
        try {
            const redirect = oauthProvider.approve(
                String(form.get('request_id') || ''),
                String(form.get('owner_secret') || '')
            );
            res.redirect(redirect);
        } catch (error: any) {
            res.status(401).type('text').send(error?.message || 'Authorization failed');
        }
    });
    app.use(mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: publicBaseUrl,
        baseUrl: publicBaseUrl,
        resourceServerUrl: publicMcpUrl,
        resourceName: 'Quota',
        scopesSupported: ['mcp:tools']
    }));
}

app.get('/health', (_req: any, res: any) => {
    const online = [...devices.values()].filter(isOnline);
    res.json({ ok: true, onlineDevices: online.map(d => ({ id: d.id, name: d.name, tools: d.tools.length })) });
});

app.post('/device/register', requireDeviceToken, (req: any, res: any) => {
    const id = String(req.body?.device_id || '');
    const name = String(req.body?.device_name || id);
    const tools = Array.isArray(req.body?.tools) ? req.body.tools : [];
    if (!id) return res.status(400).json({ error: 'device_id is required' });
    const existing = devices.get(id);
    const state: DeviceState = existing ?? { id, name, tools, lastSeen: Date.now(), queue: [], waiters: new Set() };
    state.name = name;
    state.tools = tools;
    state.lastSeen = Date.now();
    devices.set(id, state);
    res.json({ ok: true, device_id: id, tools: tools.length });
});

app.post('/device/heartbeat', requireDeviceToken, (req: any, res: any) => {
    try {
        touch(String(req.body?.device_id || ''));
        res.json({ ok: true });
    } catch (error: any) {
        res.status(404).json({ error: error.message });
    }
});

app.get('/device/next', requireDeviceToken, async (req: any, res: any) => {
    const deviceId = String(req.query.device_id || '');
    let device: DeviceState;
    try {
        device = touch(deviceId);
    } catch (error: any) {
        res.status(404).json({ error: error.message });
        return;
    }
    if (device.queue.length > 0) {
        res.json({ call: device.queue.shift() });
        return;
    }
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        device.waiters.delete(wake);
        clearTimeout(timer);
        device.lastSeen = Date.now();
        res.json({ call: device.queue.shift() ?? null });
    };
    const wake = () => finish();
    const timer = setTimeout(finish, LONG_POLL_MS);
    device.waiters.add(wake);
    req.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        device.waiters.delete(wake);
    });
});

app.post('/device/result', requireDeviceToken, (req: any, res: any) => {
    const callId = String(req.body?.call_id || '');
    const pending = pendingCalls.get(callId);
    if (!pending) return res.status(404).json({ error: 'Unknown or expired call' });
    if (String(req.body?.device_id || '') !== pending.deviceId) {
        return res.status(409).json({ error: 'Result came from the wrong device' });
    }
    pendingCalls.delete(callId);
    clearTimeout(pending.timer);
    touch(pending.deviceId);
    if (req.body?.status === 'completed') pending.resolve(req.body.result);
    else pending.reject(new Error(String(req.body?.error || 'Remote tool failed')));
    res.json({ ok: true });
});

app.options('/mcp', (_req: any, res: any) => {
    res.status(204).send();
});

app.post('/mcp', requireMcpAuth, async (req: any, res: any) => {
    try {
        if (await handleModernRequest(req, res)) return;

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });

        await protocolServer.connect(transport);

        res.on('close', () => {
            transport.close().catch(error => {
                console.error('[relay] Failed to close MCP transport:', error?.message || error);
            });
        });

        await transport.handleRequest(req, res, req.body);
    } catch (error: any) {
        console.error('[relay] MCP request failed:', error?.message || error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: error?.message || 'Internal error' },
                id: null
            });
        }
    }
});

app.get('/mcp', requireMcpAuth, (_req: any, res: any) => {
    res.status(405).set('Allow', 'POST, OPTIONS').send('Method Not Allowed');
});

app.delete('/mcp', requireMcpAuth, (_req: any, res: any) => {
    res.status(405).set('Allow', 'POST, OPTIONS').send('Method Not Allowed');
});

app.listen(PORT, HOST, (error?: Error) => {
    if (error) {
        console.error('[relay] Failed to listen:', error.message);
        process.exit(1);
    }
    console.log(`[relay] MCP endpoint: http://${HOST}:${PORT}/mcp`);
    console.log(`[relay] Device API:   http://${HOST}:${PORT}/device/*`);
    if (oauthProvider && publicMcpUrl) console.log(`[relay] OAuth MCP URL: ${publicMcpUrl.href}`);
    else if (ALLOW_ANONYMOUS_MCP) console.warn('[relay] WARNING: MCP authentication is disabled');
});
