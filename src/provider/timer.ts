import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { systemdUserEnv } from './systemd.js';

const unitName = 'quota-provider-sync';
function unitPaths(): { directory: string; serviceFile: string; timerFile: string } {
    const directory = process.env.QUOTA_SYSTEMD_USER_DIR ||
        path.join(os.homedir(), '.config', 'systemd', 'user');
    return {
        directory,
        serviceFile: path.join(directory, unitName + '.service'),
        timerFile: path.join(directory, unitName + '.timer')
    };
}

function systemctl(...args: string[]): string {
    return execFileSync('systemctl', ['--user', ...args], {
        encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
        env: systemdUserEnv(process.env)
    }).trim();
}

export function manageProviderTimer(action: 'enable' | 'disable' | 'status'): void {
    if (process.platform !== 'linux') {
        throw new Error('Automatic systemd updates are currently supported on Linux only');
    }
    const { directory, serviceFile, timerFile } = unitPaths();
    if (action === 'status') {
        try { console.log('Provider update timer: ' + systemctl('is-enabled', unitName + '.timer')); }
        catch { console.log('Provider update timer: disabled'); }
        return;
    }

    if (action === 'disable') {
        try { systemctl('disable', '--now', unitName + '.timer'); }
        catch { /* timer may not be installed */ }
        for (const file of [serviceFile, timerFile]) {
            try { fs.unlinkSync(file); }
            catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        }
        systemctl('daemon-reload');
        console.log('Automatic provider updates disabled.');
        return;
    }

    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const npmPath = Array.from(new Set([
        path.dirname(process.execPath),
        ...(process.env.PATH || '/usr/local/bin:/usr/bin:/bin')
            .split(path.delimiter)
            .filter(segment => !segment.includes('/.npm/_npx/') &&
                !segment.includes('/node_modules/.bin') &&
                !segment.includes('/npm/node_modules/'))
    ])).join(path.delimiter);
    const working = path.dirname(path.dirname(cli));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const service = [
        '[Unit]',
        'Description=Quota verified Desktop Commander provider update',
        'Wants=network-online.target',
        'After=network-online.target',
        '',
        '[Service]',
        'Type=oneshot',
        'WorkingDirectory=' + working,
        'Environment=' + JSON.stringify('PATH=' + npmPath),
        'ExecStart=' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli) + ' update --apply',
        'TimeoutStartSec=480',
        ''
    ].join('\n');
    const timer = [
        '[Unit]',
        'Description=Daily verified Desktop Commander sync for Quota',
        '',
        '[Timer]',
        'OnCalendar=*-*-* 04:00:00',
        'RandomizedDelaySec=15m',
        'Persistent=true',
        'Unit=' + unitName + '.service',
        '',
        '[Install]',
        'WantedBy=timers.target',
        ''
    ].join('\n');
    fs.writeFileSync(serviceFile, service, { mode: 0o644 });
    fs.writeFileSync(timerFile, timer, { mode: 0o644 });
    systemctl('daemon-reload');
    systemctl('enable', '--now', unitName + '.timer');
    console.log('Automatic provider updates enabled (daily at 04:00 local time, up to 15m jitter).');
    console.log('Each update is canary-tested; failure triggers rollback to the prior provider.');
}
