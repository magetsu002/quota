import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'dist/cli.js');
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cli-test-'));
const env = { ...process.env, QUOTA_CONFIG_DIR: configDir };

try {
    const init = execFileSync(process.execPath, [cli, 'init'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8'
    });
    assert.match(init, /Created /);

    const configPath = path.join(configDir, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    assert.match(config.deviceToken, /^[0-9a-f]{64}$/);
    assert.match(config.mcpToken, /^[0-9a-f]{64}$/);
    assert.notEqual(config.deviceToken, config.mcpToken);
    assert.equal(config.relayHost, '127.0.0.1');
    assert.equal(config.relayPort, 8787);

    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    }

    const token = execFileSync(process.execPath, [cli, 'token'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8'
    }).trim();
    assert.equal(token, config.mcpToken);

    const help = execFileSync(process.execPath, [cli, 'help'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8'
    });
    assert.match(help, /quota start/);
    assert.match(help, /Desktop Commander is fetched automatically/);

    const initAgain = execFileSync(process.execPath, [cli, 'init'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8'
    });
    assert.match(initAgain, /Config already exists/);

    console.log('PASS Quota CLI: config + secret generation + help');
} finally {
    fs.rmSync(configDir, { recursive: true, force: true });
}
