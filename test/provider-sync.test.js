import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_PROVIDER_VERSION, compareVersions, providerStatePath,
    readProviderState, stableVersion, writeProviderState
} from '../dist/provider/state.js';
import { manageProviderTimer } from '../dist/provider/timer.js';

const originalHome = process.env.HOME;
const originalConfig = process.env.QUOTA_CONFIG_DIR;
const originalPath = process.env.PATH;
const originalSystemd = process.env.QUOTA_SYSTEMD_USER_DIR;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-updates-test-'));
try {
    process.env.HOME = temp;
    process.env.QUOTA_CONFIG_DIR = path.join(temp, 'quota');
    process.env.QUOTA_SYSTEMD_USER_DIR = path.join(temp, '.config/systemd/user');
    const baseline = readProviderState();
    assert.equal(baseline.active, DEFAULT_PROVIDER_VERSION);
    assert.equal(compareVersions('0.2.53', '0.2.52'), 1);
    assert.equal(compareVersions('0.3.0', '0.2.99'), 1);
    assert.equal(compareVersions('0.2.52', '0.2.52'), 0);
    assert.equal(compareVersions('0.2.51', '0.2.52'), -1);
    for (const invalid of ['latest', '0.2.52;rm', '0.2.52-beta', '../other', '1.2', '01.2.3']) {
        assert.equal(stableVersion(invalid), false);
    }
    assert.equal(stableVersion('1.2.3'), true);
    writeProviderState({ active: '0.2.53', previous: '0.2.52', updatedAt: 'test' });
    assert.equal(readProviderState().active, '0.2.53');
    assert.equal(readProviderState().previous, '0.2.52');
    if (process.platform !== 'win32') assert.equal(fs.statSync(providerStatePath()).mode & 0o777, 0o600);
    assert.throws(() => writeProviderState({ active: 'latest', updatedAt: 'test' }));

    if (process.platform === 'linux') {
        const bin = path.join(temp, 'bin');
        fs.mkdirSync(bin);
        const fakeSystemctl = path.join(bin, 'systemctl');
        fs.writeFileSync(fakeSystemctl, '#!/bin/sh\necho "$@" >> "' + path.join(temp, 'systemctl.log') + '"\n', { mode: 0o755 });
        process.env.PATH = bin + path.delimiter + originalPath;
        manageProviderTimer('enable');
        const service = fs.readFileSync(path.join(temp, '.config/systemd/user/quota-provider-sync.service'), 'utf8');
        assert.match(service, /update --apply/);
        assert.match(service, /ExecStart=/);
        assert.match(service, /^WorkingDirectory=\/[^"\n]+$/m);
        assert.doesNotMatch(service, /\.npm\/_npx\//);
        assert.ok(service.split(String.fromCharCode(10)).length > 10, 'service unit must use real line breaks');
        assert.match(fs.readFileSync(path.join(temp, '.config/systemd/user/quota-provider-sync.timer'), 'utf8'), /OnCalendar=\*-\*-\* 04:00:00/);
        const timerText = fs.readFileSync(path.join(temp, '.config/systemd/user/quota-provider-sync.timer'), 'utf8');
        assert.ok(timerText.split(String.fromCharCode(10)).length > 10, 'timer unit must use real line breaks');
        manageProviderTimer('disable');
        assert.ok(!fs.existsSync(path.join(temp, '.config/systemd/user/quota-provider-sync.timer')));
    }
    console.log('PASS Quota provider sync: version validation, atomic state, systemd timer');
} finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfig === undefined) delete process.env.QUOTA_CONFIG_DIR;
    else process.env.QUOTA_CONFIG_DIR = originalConfig;
    process.env.PATH = originalPath;
    if (originalSystemd === undefined) delete process.env.QUOTA_SYSTEMD_USER_DIR;
    else process.env.QUOTA_SYSTEMD_USER_DIR = originalSystemd;
    fs.rmSync(temp, { recursive: true, force: true });
}
