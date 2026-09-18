#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type QuotaConfig = {
    deviceToken: string;
    mcpToken: string;
    relayHost: string;
    relayPort: number;
};

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.QUOTA_CONFIG_DIR || path.join(os.homedir(), '.quota');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function secret(): string {
    return randomBytes(32).toString('hex');
}

async function readStoredConfig(): Promise<QuotaConfig | undefined> {
    try {
        const parsed = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) as Partial<QuotaConfig>;
        if (
            typeof parsed.deviceToken === 'string' &&
            typeof parsed.mcpToken === 'string' &&
            typeof parsed.relayHost === 'string' &&
            typeof parsed.relayPort === 'number'
        ) {
            return parsed as QuotaConfig;
        }
        throw new Error('config file is incomplete');
    } catch (error: any) {
        if (error?.code === 'ENOENT') return undefined;
        throw new Error(`Could not read ${CONFIG_PATH}: ${error?.message || error}`);
    }
}

async function ensureConfig(): Promise<{ config: QuotaConfig; created: boolean }> {
    const stored = await readStoredConfig();
    const config: QuotaConfig = stored ?? {
        deviceToken: secret(),
        mcpToken: secret(),
        relayHost: '127.0.0.1',
        relayPort: 8787
    };

    const runtime: QuotaConfig = {
        deviceToken: process.env.QUOTA_DEVICE_TOKEN || config.deviceToken,
        mcpToken: process.env.QUOTA_MCP_TOKEN || config.mcpToken,
        relayHost: process.env.QUOTA_RELAY_HOST || config.relayHost,
        relayPort: Number.parseInt(process.env.QUOTA_RELAY_PORT || String(config.relayPort), 10)
    };

    if (!stored) {
        await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        await fs.chmod(CONFIG_PATH, 0o600);
    }

    if (!Number.isFinite(runtime.relayPort) || runtime.relayPort < 1 || runtime.relayPort > 65535) {
        throw new Error('QUOTA_RELAY_PORT must be between 1 and 65535');
    }

    return { config: runtime, created: !stored };
}

function localBaseUrl(config: QuotaConfig): string {
    const host = config.relayHost === '0.0.0.0' ? '127.0.0.1' : config.relayHost;
    const printableHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${printableHost}:${config.relayPort}`;
}

function providerArgs(): string[] {
    const separator = process.argv.indexOf('--');
    if (separator >= 0) return process.argv.slice(separator + 1);

    const command = process.argv[2];
    if (command === 'start' || command === 'agent') return process.argv.slice(3);
    return [];
}

function quotaEnv(config: QuotaConfig): NodeJS.ProcessEnv {
    return {
        ...process.env,
        QUOTA_DEVICE_TOKEN: config.deviceToken,
        QUOTA_MCP_TOKEN: config.mcpToken,
        QUOTA_RELAY_HOST: config.relayHost,
        QUOTA_RELAY_PORT: String(config.relayPort),
        QUOTA_RELAY_URL: localBaseUrl(config)
    };
}

function spawnNode(script: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    return spawn(process.execPath, [path.join(DIST_DIR, script), ...args], {
        env,
        stdio: 'inherit'
    });
}

async function relayHealth(config: QuotaConfig): Promise<any | undefined> {
    try {
        const response = await fetch(`${localBaseUrl(config)}/health`);
        if (!response.ok) return undefined;
        const body = await response.json() as any;
        return body?.ok === true ? body : undefined;
    } catch {
        return undefined;
    }
}

async function waitForRelay(config: QuotaConfig, child: ChildProcess): Promise<void> {
    const healthUrl = `${localBaseUrl(config)}/health`;
    for (let i = 0; i < 60; i++) {
        if (child.exitCode !== null) {
            throw new Error(`Relay exited before becoming ready (code ${child.exitCode})`);
        }
        try {
            const response = await fetch(healthUrl);
            if (response.ok) return;
        } catch {
            // retry
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Relay did not become ready at ${healthUrl}`);
}

function waitForChild(child: ChildProcess): Promise<number> {
    return new Promise(resolve => {
        child.once('exit', code => resolve(code ?? 1));
    });
}

function stopChild(child?: ChildProcess): void {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
}

async function runRelay(config: QuotaConfig): Promise<number> {
    const child = spawnNode('relay/server.js', [], quotaEnv(config));
    return await waitForChild(child);
}

async function runAgent(config: QuotaConfig): Promise<number> {
    const custom = providerArgs();
    const args = custom.length > 0 ? ['--', ...custom] : [];
    const child = spawnNode('agent/agent.js', args, quotaEnv(config));
    return await waitForChild(child);
}

async function startStack(config: QuotaConfig, created: boolean): Promise<number> {
    if (await relayHealth(config)) {
        throw new Error(
            `Quota is already running at ${localBaseUrl(config)}. ` +
            'Run "npm run --silent status" to inspect it.'
        );
    }

    console.log('');
    console.log('Quota');
    console.log('─────');
    if (created) console.log(`Config created: ${CONFIG_PATH}`);
    console.log(`MCP endpoint: ${localBaseUrl(config)}/mcp`);
    console.log('Provider:     ' + (providerArgs().length > 0 ? providerArgs().join(' ') : 'Desktop Commander (auto)'));
    console.log('MCP token:    run "npm run --silent token"');
    console.log('');

    const relay = spawnNode('relay/server.js', [], quotaEnv(config));
    let agent: ChildProcess | undefined;

    const stop = () => {
        stopChild(agent);
        stopChild(relay);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    try {
        await waitForRelay(config, relay);
        agent = spawnNode(
            'agent/agent.js',
            providerArgs().length > 0 ? ['--', ...providerArgs()] : [],
            quotaEnv(config)
        );

        const winner = await Promise.race([
            waitForChild(relay).then(code => ({ source: 'relay', code })),
            waitForChild(agent).then(code => ({ source: 'agent', code }))
        ]);

        if (winner.source === 'relay') stopChild(agent);
        else stopChild(relay);

        return winner.code;
    } finally {
        stop();
    }
}

async function status(config: QuotaConfig): Promise<number> {
    const url = `${localBaseUrl(config)}/health`;
    try {
        const body = await relayHealth(config);
        if (!body) throw new Error('no Quota relay responded');
        const agents = Array.isArray(body.onlineDevices) ? body.onlineDevices : [];

        console.log(`Relay:    online (${url})`);
        if (agents.length === 0) {
            console.log('Agent:    none connected');
        } else {
            for (const agent of agents) {
                console.log(`Agent:    ${agent.name || agent.id} — ${agent.tools ?? 0} tools`);
            }
        }
        return 0;
    } catch (error: any) {
        console.error(`Relay:    offline (${url})`);
        console.error(`Reason:   ${error?.message || error}`);
        return 1;
    }
}

function help(): void {
    console.log(`Quota — self-hosted remote MCP bridge

Usage:
  quota start [<mcp-command> ...]   Start relay + agent
  quota relay                      Start only the relay
  quota agent [<mcp-command> ...]  Start only the agent
  quota status                     Show relay/agent status
  quota token                      Print the MCP client token
  quota init                       Create local config/secrets
  quota help                       Show this help

Default provider:
  Desktop Commander is fetched automatically when no MCP command is supplied.

Examples:
  quota start
  quota start node ./my-mcp-server.js
`);
}

async function main(): Promise<number> {
    const command = process.argv[2] || 'help';

    if (command === 'help' || command === '--help' || command === '-h') {
        help();
        return 0;
    }

    const { config, created } = await ensureConfig();

    switch (command) {
        case 'init':
            console.log(created ? `Created ${CONFIG_PATH}` : `Config already exists: ${CONFIG_PATH}`);
            return 0;
        case 'token':
            console.log(config.mcpToken);
            return 0;
        case 'status':
            return await status(config);
        case 'relay':
            return await runRelay(config);
        case 'agent':
            return await runAgent(config);
        case 'start':
            return await startStack(config, created);
        default:
            console.error(`Unknown command: ${command}\n`);
            help();
            return 2;
    }
}

main()
    .then(code => {
        process.exitCode = code;
    })
    .catch(error => {
        console.error(`Quota: ${error?.message || error}`);
        process.exitCode = 1;
    });
