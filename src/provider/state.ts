import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PROVIDER_PACKAGE = '@wonderwhy-er/desktop-commander';
export const DEFAULT_PROVIDER_VERSION = '0.2.52';
export const REQUIRED_TOOLS = ['get_config', 'read_file', 'write_file', 'list_directory', 'start_process'];

export type ProviderState = {
    active: string;
    previous?: string;
    updatedAt: string;
};

export function providerStatePath(): string {
    const directory = process.env.QUOTA_CONFIG_DIR || path.join(os.homedir(), '.quota');
    return path.join(directory, 'provider.json');
}

export function stableVersion(value: unknown): value is string {
    return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

export function compareVersions(a: string, b: string): number {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
    }
    return 0;
}

export function readProviderState(): ProviderState {
    let raw: string;
    try {
        raw = fs.readFileSync(providerStatePath(), 'utf8');
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return { active: DEFAULT_PROVIDER_VERSION, updatedAt: '' };
        }
        throw error;
    }
    const state = JSON.parse(raw);
    if (!stableVersion(state.active) || (state.previous !== undefined && !stableVersion(state.previous))) {
        throw new Error('Invalid provider state; refusing to launch an untrusted package version');
    }
    return { active: state.active, previous: state.previous, updatedAt: String(state.updatedAt || '') };
}

export function writeProviderState(state: ProviderState): void {
    if (!stableVersion(state.active) || (state.previous !== undefined && !stableVersion(state.previous))) {
        throw new Error('Invalid provider version');
    }
    const file = providerStatePath();
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
    } finally {
        try { fs.unlinkSync(temporary); } catch (error: any) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
}
