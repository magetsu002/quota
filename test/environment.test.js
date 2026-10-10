import assert from 'node:assert/strict';
import { providerEnvironment } from '../dist/agent/environment.js';

const parent = {
    PATH: '/usr/bin',
    HOME: '/tmp',
    QUOTA_DEVICE_TOKEN: 'device-secret',
    QUOTA_MCP_TOKEN: 'mcp-secret',
    QUOTA_OAUTH_OWNER_SECRET: 'oauth-secret',
    QUOTA_PUBLIC_URL: 'https://quota.example',
    QUOTA_RELAY_URL: 'https://relay.example',
    QUOTA_MCP_ENV_JSON: '{"SECRET":"value"}',
    API_KEY: 'provider-owned-credential'
};
const result = providerEnvironment(parent, { PROVIDER_OPTION: 'okay' });

assert.equal(result.PATH, '/usr/bin');
assert.equal(result.HOME, '/tmp');
assert.equal(result.API_KEY, 'provider-owned-credential');
assert.equal(result.PROVIDER_OPTION, 'okay');
for (const key of Object.keys(result)) {
    assert.ok(!key.startsWith('QUOTA_'), `Leaked internal environment variable: ${key}`);
}
assert.equal(result.QUOTA_DEVICE_TOKEN, undefined);
assert.equal(result.QUOTA_MCP_TOKEN, undefined);

// Explicit provider credentials remain possible, but never inherited implicitly.
const deliberate = providerEnvironment(parent, { QUOTA_DEVICE_TOKEN: 'explicit-only' });
assert.equal(deliberate.QUOTA_DEVICE_TOKEN, 'explicit-only');

console.log('PASS Quota provider environment: transport credentials isolated');
