#!/usr/bin/env node
// An isolated process verifies the downloaded provider actually speaks MCP.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { providerEnvironment } from '../agent/environment.js';
import { PROVIDER_PACKAGE, REQUIRED_TOOLS, stableVersion } from './state.js';

const version = process.argv[2];
if (!stableVersion(version)) throw new Error('Expected a stable provider version');

const client = new Client({ name: 'quota-provider-probe', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', PROVIDER_PACKAGE + '@' + version],
    env: providerEnvironment(process.env, {
        npm_config_loglevel: 'error',
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false'
    })
});
let file = '';
try {
    await client.connect(transport);
    const listing = await client.listTools();
    const names = (listing.tools || []).map(tool => tool.name);
    const missing = REQUIRED_TOOLS.filter(name => !names.includes(name));
    if (missing.length) throw new Error('Missing required tools: ' + missing.join(', '));

    const configuration = await client.callTool({ name: 'get_config', arguments: {} });
    if (configuration.isError) throw new Error('get_config returned an error');
    const config = (configuration.structuredContent as any)?.config;
    let reported = config?.version;
    if (!reported) {
        const text = (configuration as any).content?.find((item: any) => item.type === 'text') as any;
        const match = text?.text?.match(/"version"\s*:\s*"([^"]+)"/);
        reported = match?.[1];
    }
    if (reported !== version) {
        throw new Error('Provider version mismatch: expected ' + version + ', got ' + (reported || 'unknown'));
    }

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-provider-probe-'));
    file = path.join(directory, randomUUID() + '.txt');
    await fs.writeFile(file, 'quota-provider-probe');
    const read = await client.callTool({ name: 'read_file', arguments: { path: file } });
    if (read.isError || !JSON.stringify(read.content).includes('quota-provider-probe')) {
        throw new Error('Provider read_file smoke test failed');
    }
    process.stdout.write(JSON.stringify({ version, tools: names.sort() }) + '\n');
} finally {
    await client.close().catch(() => {});
    if (file) await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
}
