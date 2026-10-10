#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { providerEnvironment } from './environment.js';
import { readProviderState, PROVIDER_PACKAGE } from '../provider/state.js';

type RelayCall = {
    id: string;
    tool_name: string;
    tool_args: unknown;
    metadata?: Record<string, unknown>;
};

type ProviderCommand = {
    command: string;
    args: string[];
    env?: Record<string, string>;
};

const CONFIG_PATH = path.join(os.homedir(), '.quota', 'device.json');
const RELAY_URL = (process.env.QUOTA_RELAY_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.QUOTA_DEVICE_TOKEN || '';
const RETRY_MS = Number.parseInt(process.env.QUOTA_RETRY_MS || '1500', 10);

function parseJsonArray(value: string | undefined, name: string): string[] {
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
        throw new Error(`${name} must be a JSON array of strings`);
    }
    return parsed;
}

function parseJsonObject(value: string | undefined, name: string): Record<string, string> | undefined {
    if (!value) return undefined;
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${name} must be a JSON object`);
    }
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed)) {
        if (typeof item !== 'string') throw new Error(`${name} values must be strings`);
        out[key] = item;
    }
    return out;
}

function providerCommand(): ProviderCommand {
    const separator = process.argv.indexOf('--');
    if (separator >= 0 && process.argv[separator + 1]) {
        return {
            command: process.argv[separator + 1],
            args: process.argv.slice(separator + 2)
        };
    }

    const command = process.env.QUOTA_MCP_COMMAND;
    if (!command) {
        return {
            command: 'npx',
            args: ['-y', PROVIDER_PACKAGE + '@' + readProviderState().active],
            env: {
                npm_config_loglevel: 'error',
                npm_config_update_notifier: 'false',
                npm_config_fund: 'false'
            }
        };
    }

    return {
        command,
        args: parseJsonArray(process.env.QUOTA_MCP_ARGS_JSON, 'QUOTA_MCP_ARGS_JSON'),
        env: parseJsonObject(process.env.QUOTA_MCP_ENV_JSON, 'QUOTA_MCP_ENV_JSON')
    };
}

class QuotaAgent {
    private readonly provider = providerCommand();
    private readonly client = new Client(
        { name: 'quota-agent', version: '0.1.0' },
        { capabilities: {} }
    );
    private transport?: StdioClientTransport;
    private running = true;
    private providerFailed = false;
    private pollAbort?: AbortController;
    private heartbeatTimer?: NodeJS.Timeout;
    private deviceId = '';

    private async request(route: string, init: RequestInit = {}): Promise<Response> {
        return await fetch(`${RELAY_URL}${route}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                ...(init.headers || {})
            }
        });
    }

    private async loadDeviceId(): Promise<string> {
        if (process.env.QUOTA_DEVICE_ID) return process.env.QUOTA_DEVICE_ID;
        try {
            const saved = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
            if (typeof saved.deviceId === 'string' && saved.deviceId) return saved.deviceId;
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {
                console.warn('[agent] Could not read saved device ID:', error?.message || error);
            }
        }

        const deviceId = randomUUID();
        await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
        await fs.writeFile(CONFIG_PATH, JSON.stringify({ deviceId }, null, 2), { mode: 0o600 });
        return deviceId;
    }

    private async register(): Promise<void> {
        const capabilities = await this.client.listTools();
        const response = await this.request('/device/register', {
            method: 'POST',
            body: JSON.stringify({
                device_id: this.deviceId,
                device_name: os.hostname(),
                tools: capabilities.tools || []
            })
        });

        if (!response.ok) {
            throw new Error(`Relay registration failed (${response.status}): ${await response.text()}`);
        }

        const result = await response.json() as { tools: number };
        console.log(`[agent] Registered ${result.tools} tools from ${this.provider.command}`);
    }

    private async report(
        call: RelayCall,
        status: 'completed' | 'failed',
        result?: unknown,
        error?: string
    ): Promise<void> {
        const response = await this.request('/device/result', {
            method: 'POST',
            body: JSON.stringify({
                device_id: this.deviceId,
                call_id: call.id,
                status,
                result: result ?? null,
                error: error ?? null
            })
        });

        if (!response.ok && response.status !== 404) {
            throw new Error(`Could not report tool result (${response.status}): ${await response.text()}`);
        }
    }

    private async execute(call: RelayCall): Promise<void> {
        console.log(`[agent] ${call.tool_name} (${call.id})`);
        try {
            const request: any = {
                name: call.tool_name,
                arguments: call.tool_args ?? {}
            };
            if (call.metadata && Object.keys(call.metadata).length > 0) request._meta = call.metadata;

            const result = await this.client.callTool(request);
            await this.report(call, 'completed', result);
            console.log(`[agent] ${call.tool_name} completed`);
        } catch (error: any) {
            const message = error?.message || String(error);
            console.error(`[agent] ${call.tool_name} failed:`, message);
            try {
                await this.report(call, 'failed', null, message);
            } catch (reportError: any) {
                console.error('[agent] Failed to report error:', reportError?.message || reportError);
            }
        }
    }

    private async poll(): Promise<void> {
        this.pollAbort = new AbortController();
        const response = await this.request(
            `/device/next?device_id=${encodeURIComponent(this.deviceId)}`,
            { signal: this.pollAbort.signal }
        );
        this.pollAbort = undefined;

        if (response.status === 404) {
            await this.register();
            return;
        }
        if (!response.ok) {
            throw new Error(`Relay poll failed (${response.status}): ${await response.text()}`);
        }

        const body = await response.json() as { call?: RelayCall | null };
        if (body.call) await this.execute(body.call);
    }

    private installSignalHandlers(): void {
        const stop = (signal: string) => {
            if (!this.running) return;
            console.log(`\n[agent] ${signal}; shutting down`);
            this.running = false;
            this.pollAbort?.abort();
        };
        process.on('SIGINT', () => stop('SIGINT'));
        process.on('SIGTERM', () => stop('SIGTERM'));
    }

    async start(): Promise<void> {
        if (!TOKEN) {
            throw new Error('QUOTA_DEVICE_TOKEN is required');
        }

        this.deviceId = await this.loadDeviceId();
        this.installSignalHandlers();

        console.log(
            `[agent] Starting local MCP provider: ${this.provider.command} ${this.provider.args.join(' ')}`
        );
        this.transport = new StdioClientTransport({
            command: this.provider.command,
            args: this.provider.args,
            env: providerEnvironment(process.env, this.provider.env)
        });
        this.client.onclose = () => {
            if (this.running) {
                console.error('[agent] Local MCP provider disconnected');
                this.providerFailed = true;
                this.pollAbort?.abort();
            }
        };
        await this.client.connect(this.transport);
        await this.register();

        console.log(`[agent] Connected to relay ${RELAY_URL}`);
        // Long-running tools can block polling. Keep readiness fresh separately
        // while the local MCP provider is connected.
        this.heartbeatTimer = setInterval(() => {
            if (!this.running || this.providerFailed) return;
            this.request('/device/heartbeat', {
                method: 'POST',
                body: JSON.stringify({ device_id: this.deviceId })
            }).catch(() => { /* the poll loop handles relay recovery */ });
        }, 15_000);
        this.heartbeatTimer.unref();

        while (this.running) {
            try {
                await this.poll();
            } catch (error: any) {
                if (!this.running || this.providerFailed) break;
                console.error('[agent] Relay connection error:', error?.message || error);
                await new Promise(resolve => setTimeout(resolve, RETRY_MS));
            }
            if (this.providerFailed) break;
        }

        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

        if (this.providerFailed) {
            try {
                await this.request('/device/offline', {
                    method: 'POST',
                    body: JSON.stringify({ device_id: this.deviceId })
                });
            } catch {
                // The server may also be unreachable; stale-device expiry remains the fallback.
            }
            this.running = false;
        }

        await this.client.close();
        if (this.providerFailed) {
            throw new Error('Local MCP provider disconnected; restart required');
        }
    }
}

new QuotaAgent().start().catch(error => {
    console.error('[agent] Fatal:', error?.message || error);
    process.exitCode = 1;
});
