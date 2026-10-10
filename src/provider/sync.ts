import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { providerEnvironment } from '../agent/environment.js';
import { systemdUserEnv } from './systemd.js';
import {
    PROVIDER_PACKAGE, ProviderState, compareVersions,
    providerStatePath, readProviderState, stableVersion, writeProviderState
} from './state.js';

const exec = promisify(execFile);
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const safeEnv = providerEnvironment(process.env, {
    npm_config_loglevel: 'error',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false'
});

export type ProviderProbe = { version: string; tools: string[] };
export type UpdateContext = {
    host: string;
    port: number;
    mcpToken: string;
};

async function run(cmd: string, args: string[], timeout = 60_000): Promise<string> {
    const { stdout } = await exec(cmd, args, {
        env: cmd === 'systemctl' ? systemdUserEnv(safeEnv) : safeEnv,
        timeout, maxBuffer: 1024 * 1024
    });
    return stdout.trim();
}

export async function latestProviderVersion(): Promise<string> {
    const response = await run('npm', ['view', PROVIDER_PACKAGE, 'dist-tags.latest', '--json'], 20_000);
    const version = JSON.parse(response);
    if (!stableVersion(version)) throw new Error('npm did not return a stable Desktop Commander release');
    return version;
}

export async function probeProvider(version: string): Promise<ProviderProbe> {
    if (!stableVersion(version)) throw new Error('Invalid version: ' + version);
    const stdout = await run(process.execPath, [path.join(DIST_DIR, 'probe.js'), version], 120_000);
    const probe = JSON.parse(stdout) as ProviderProbe;
    if (probe.version !== version || !Array.isArray(probe.tools) || !probe.tools.every(name => typeof name === 'string')) {
        throw new Error('Provider returned an invalid compatibility report');
    }
    return probe;
}

function lock(): () => void {
    const file = providerStatePath() + '.lock';
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
        const handle = fs.openSync(file, 'wx', 0o600);
        fs.writeSync(handle, String(process.pid));
        fs.closeSync(handle);
    } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        // A dead updater can leave a lock. Avoid clearing a *live* update.
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if (age < 30 * 60_000) {
            throw new Error('Another provider update is in progress (' + file + ')');
        }
        fs.unlinkSync(file);
        return lock();
    }
    return () => fs.unlinkSync(file);
}

function endpoint(context: UpdateContext): string {
    const host = context.host === '0.0.0.0' ? '127.0.0.1' : context.host;
    return 'http://' + (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host) + ':' + context.port;
}

export async function runningProviderVersion(context: UpdateContext): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
        const response = await fetch(endpoint(context) + '/mcp', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + context.mcpToken,
                'Content-Type': 'application/json',
                'Mcp-Protocol-Version': '2026-07-28'
            },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 'quota-version-check', method: 'tools/call',
                params: { name: 'get_config', arguments: {} }
            }),
            signal: controller.signal
        });
        if (!response.ok) return null;
        const body = await response.json() as any;
        const result = body?.result;
        const content = result?.content?.find((item: any) => item.type === 'text')?.text || '';
        const version = result?.structuredContent?.config?.version ||
            content.match(/"version"\s*:\s*"([^"]+)"/)?.[1];
        return stableVersion(version) ? version : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function restartAndVerify(version: string, context: UpdateContext): Promise<void> {
    await run('systemctl', ['--user', 'restart', 'quota.service'], 20_000);
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
        if (await runningProviderVersion(context) === version) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Quota failed to expose provider ' + version + ' after restart');
}

async function applySafely(
    candidate: ProviderState,
    original: ProviderState,
    context: UpdateContext
): Promise<void> {
    writeProviderState(candidate);
    try {
        await restartAndVerify(candidate.active, context);
    } catch (error) {
        console.error('Update activation failed; reverting provider state...');
        writeProviderState(original);
        try {
            await restartAndVerify(original.active, context);
            console.error('Rollback verified; running ' + original.active);
        } catch (rollbackError) {
            console.error('Automatic rollback could not be verified:', rollbackError);
        }
        throw error;
    }
}

export async function syncProvider(context: UpdateContext, mode: 'check' | 'stage' | 'apply'): Promise<void> {
    // --check has no side effects and does not need a lock.
    if (mode === 'check') {
        const current = readProviderState();
        const latest = await latestProviderVersion();
        console.log('Installed: ' + current.active + ' | npm latest: ' + latest);
        console.log(compareVersions(latest, current.active) > 0 ? 'Update available' : 'Up to date');
        return;
    }
    const release = lock();
    try {
        const current = readProviderState();
        const latest = await latestProviderVersion();
        console.log('Installed: ' + current.active + ' | npm latest: ' + latest);
        if (compareVersions(latest, current.active) <= 0) {
            // Never restart a healthy installation merely because npm is current.
            // Staged state is activated only when the live version is the recorded
            // previous version. Unknown/offline states require operator diagnosis.
            if (mode === 'apply') {
                const running = await runningProviderVersion(context);
                if (running === current.active) {
                    console.log('Already on latest supported stable release.');
                } else if (running && current.previous === running) {
                    console.log('Applying staged provider ' + current.active);
                    const original: ProviderState = {
                        active: running, previous: current.active,
                        updatedAt: new Date().toISOString()
                    };
                    await applySafely(current, original, context);
                    console.log('Staged provider activated and verified: ' + current.active);
                } else {
                    throw new Error('Live provider version could not be verified against state; refusing automatic restart');
                }
            } else {
                console.log('Already on latest supported stable release.');
            }
            return;
        }
        console.log('Canary testing ' + latest + ' against active ' + current.active + '...');
        const [baseline, candidate] = await Promise.all([
            probeProvider(current.active), probeProvider(latest)
        ]);
        const missing = baseline.tools.filter(tool => !candidate.tools.includes(tool));
        if (missing.length) throw new Error('Update rejected; removed tools: ' + missing.join(', '));
        console.log('Canary passed: ' + candidate.tools.length + ' tools; no existing tools removed.');
        const next: ProviderState = {
            active: latest, previous: current.active, updatedAt: new Date().toISOString()
        };
        if (mode === 'apply') {
            const running = await runningProviderVersion(context);
            if (running !== current.active) {
                throw new Error('Cannot apply upgrade: live provider is not verified as ' + current.active);
            }
            await applySafely(next, current, context);
            console.log('Update activated and verified: ' + latest);
        } else {
            writeProviderState(next);
            console.log('Staged ' + latest + '. Restart quota.service when ready, or run quota update --apply.');
        }
    } finally {
        release();
    }
}

export async function rollbackProvider(context: UpdateContext, apply: boolean): Promise<void> {
    const release = lock();
    try {
        const current = readProviderState();
        if (!current.previous) throw new Error('No previous Desktop Commander version recorded');
        const prior: ProviderState = {
            active: current.previous,
            previous: current.active,
            updatedAt: new Date().toISOString()
        };
        console.log('Rolling back from ' + current.active + ' to ' + prior.active);
        // Verify the target remains runnable before changing state.
        await probeProvider(prior.active);
        if (apply) await applySafely(prior, current, context);
        else writeProviderState(prior);
        console.log(apply ? 'Rollback activated and verified' : 'Rollback staged; restart Quota to activate');
    } finally {
        release();
    }
}
