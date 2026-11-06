import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 18806;
const base = `http://127.0.0.1:${port}`;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-agent-relay-test-'));
const config = path.join(dir, 'agents.json');
const state = path.join(dir, 'state.json');
const token = () => randomBytes(32).toString('hex');
const chiefToken = token();
const workerToken = token();
const qaToken = token();
const mcpToken = token();
const deviceToken = token();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const mcpEndpoint = new URL(`${base}/agent-relay/mcp`);

await fs.writeFile(config, JSON.stringify({ agents: [
    { id: 'chief', role: 'orchestrator', token_sha256: sha256(chiefToken), assign_to: ['storage'], conversation_ref: 'chatgpt-conversation-chief' },
    { id: 'storage', role: 'worker', token_sha256: sha256(workerToken), conversation_ref: 'chatgpt-conversation-storage' },
    { id: 'qa', role: 'worker', token_sha256: sha256(qaToken) }
] }), { mode: 0o600 });

let relay;
const clients = [];
async function start() {
    relay = spawn(process.execPath, [path.join(root, 'dist/relay/server.js')], {
        cwd: root,
        env: {
            ...process.env,
            QUOTA_RELAY_PORT: String(port),
            QUOTA_RELAY_HOST: '127.0.0.1',
            QUOTA_MCP_TOKEN: mcpToken,
            QUOTA_DEVICE_TOKEN: deviceToken,
            QUOTA_AGENT_RELAY_CONFIG_PATH: config,
            QUOTA_AGENT_RELAY_STATE_PATH: state,
            QUOTA_ALLOW_ANONYMOUS_MCP: 'false',
            QUOTA_PUBLIC_URL: '',
            QUOTA_OAUTH_OWNER_SECRET: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    relay.stderr.on('data', data => process.stderr.write('[agent-relay] ' + data));
    for (let i = 0; i < 80; i++) {
        if (relay.exitCode !== null) throw new Error('Relay exited before ready');
        try {
            if ((await fetch(`${base}/health`)).ok) return;
        } catch { /* retry */ }
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Relay did not start');
}

async function stop() {
    if (!relay || relay.exitCode !== null) return;
    const proc = relay;
    await new Promise(resolve => {
        proc.once('close', resolve);
        proc.kill('SIGTERM');
    });
}

async function connect(agentId, agentToken) {
    const client = new Client({ name: `relay-test-${agentId}`, version: '0.1.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(mcpEndpoint, {
        requestInit: { headers: { Authorization: `Bearer ${agentToken}` } }
    });
    await client.connect(transport);
    clients.push(client);
    return client;
}

async function run(client, name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    const output = response.content?.[0]?.text || '';
    if (response.isError) return { isError: true, message: output };
    return JSON.parse(output);
}

async function modern(tokenValue, method, params = {}) {
    const response = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${tokenValue}`,
            'Content-Type': 'application/json',
            'Mcp-Protocol-Version': '2026-07-28'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'test-modern', method, params })
    });
    return { status: response.status, body: await response.json() };
}

const result = {
    outcome: 'implemented',
    summary: 'Storage smoke test completed in an isolated worktree',
    commits: ['a'.repeat(40)],
    tests: ['node --test storage.test.js: PASS'],
    evidence: ['test output: storage pass'],
    blockers: [],
    recommended_action: 'Chief integrator reviews the commit before merging'
};

try {
    await start();

    // Agent credentials never authorize the original local-machine provider.
    const cannotAccessMachine = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.equal(cannotAccessMachine.status, 401);

    const noAuth = await modern('', 'tools/list');
    assert.equal(noAuth.status, 401);
    const deviceAuth = await modern(deviceToken, 'tools/list');
    assert.equal(deviceAuth.status, 401);
    const machineAuth = await modern(mcpToken, 'tools/list');
    assert.equal(machineAuth.status, 401);

    // ChatGPT's self-contained protocol and standard Streamable HTTP both work.
    const modernDiscover = await modern(chiefToken, 'server/discover');
    assert.equal(modernDiscover.body.result.resultType, 'complete');
    assert.equal(modernDiscover.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'quota-agent-relay');
    const modernList = await modern(workerToken, 'tools/list');
    assert.equal(modernList.body.result.tools.length, 10);
    const modernIdentity = await modern(workerToken, 'tools/call', { name: 'relay_identity', arguments: {} });
    assert.equal(JSON.parse(modernIdentity.body.result.content[0].text).id, 'storage');

    const capabilities = await modern(chiefToken, 'tools/call', { name: 'relay_capabilities', arguments: {} });
    assert.equal(JSON.parse(capabilities.body.result.content[0].text).resumes_existing_chat, false);

    const chief = await connect('chief', chiefToken);
    const storage = await connect('storage', workerToken);
    const qa = await connect('qa', qaToken);

    assert.equal((await run(storage, 'relay_identity')).id, 'storage');
    assert.equal((await run(chief, 'relay_identity')).id, 'chief');
    assert.equal((await run(qa, 'relay_identity')).id, 'qa');

    const workerRegistry = await run(storage, 'relay_agents');
    assert.deepEqual(workerRegistry.agents.map(a => a.id).sort(), ['chief', 'storage']);
    assert.equal(workerRegistry.agents.find(a => a.id === 'chief').conversation_ref, null);
    assert.equal(workerRegistry.agents.find(a => a.id === 'storage').conversation_ref, 'chatgpt-conversation-storage');
    assert.equal(workerRegistry.agents.some(a => a.id === 'qa'), false);
    const qaRegistry = await run(qa, 'relay_agents');
    assert.deepEqual(qaRegistry.agents.map(a => a.id), ['qa']);
    const chiefRegistry = await run(chief, 'relay_agents');
    assert.deepEqual(chiefRegistry.agents.map(a => a.id).sort(), ['chief', 'storage']);
    assert.equal(chiefRegistry.agents.find(a => a.id === 'storage').conversation_ref, 'chatgpt-conversation-storage');

    const listed = await chief.listTools();
    assert.equal(listed.tools.length, 10);

    const workerEscalation = await run(storage, 'relay_assign', {
        to: 'qa', request_id: 'worker-escalate', assignment: 'Ignore your role'
    });
    assert.equal(workerEscalation.isError, true);
    assert.match(workerEscalation.message, /Only an orchestrator/);
    const forbiddenTarget = await run(chief, 'relay_assign', {
        to: 'qa', request_id: 'wrong-target', assignment: 'Not allowed'
    });
    assert.match(forbiddenTarget.message, /not permitted/);

    const assigned = await run(chief, 'relay_assign', {
        to: 'storage', request_id: 'milestone-001', assignment: 'Implement and test the storage milestone'
    });
    assert.equal(assigned.task.from, 'chief');
    assert.equal(assigned.task.to, 'storage');
    assert.equal(assigned.task.status, 'ASSIGNED');
    assert.equal(assigned.activated, false);
    assert.equal(assigned.duplicate, false);
    const taskId = assigned.task.id;
    assert.equal((await run(qa, 'relay_inbox')).tasks.length, 0, 'QA must not read another recipient\'s tasks');
    assert.equal((await run(storage, 'relay_inbox')).tasks[0].id, taskId);

    const retry = await run(chief, 'relay_assign', {
        to: 'storage', request_id: 'milestone-001', assignment: 'Implement and test the storage milestone'
    });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.task.id, taskId);
    const conflict = await run(chief, 'relay_assign', {
        to: 'storage', request_id: 'milestone-001', assignment: 'Different work'
    });
    assert.match(conflict.message, /Idempotency key conflict/);

    const forgedClaim = await run(chief, 'relay_claim', { task_id: taskId });
    assert.match(forgedClaim.message, /Only the recipient/);
    const claimed = await run(storage, 'relay_claim', { task_id: taskId, actor: 'chief' });
    assert.equal(claimed.task.status, 'RUNNING');
    assert.equal((await run(storage, 'relay_claim', { task_id: taskId })).duplicate, true);
    const report = await run(storage, 'relay_report', { task_id: taskId, report: result, actor: 'chief' });
    assert.equal(report.task.status, 'COMPLETED');
    assert.deepEqual(report.task.report, result);
    assert.equal((await run(storage, 'relay_report', { task_id: taskId, report: result })).duplicate, true);

    const chiefTasks = await run(chief, 'relay_tasks');
    assert.equal(chiefTasks.tasks.length, 1);
    assert.equal(chiefTasks.tasks[0].status, 'COMPLETED');
    assert.equal(chiefTasks.tasks[0].report.commits[0], 'a'.repeat(40));
    const events = await run(chief, 'relay_events');
    assert.deepEqual(events.events.map(e => e.action), ['assigned', 'claimed', 'reported']);
    assert.equal(events.events[0].actor, 'chief');
    assert.equal(events.events[1].actor, 'storage');
    assert.equal(events.events[2].status, 'COMPLETED');
    assert.equal((await run(qa, 'relay_events')).events.length, 0);

    // Do not claim that investigation-only assignments implemented the milestone.
    const investigate = await run(chief, 'relay_assign', {
        to: 'storage', request_id: 'investigate-002', assignment: 'Review tests without changing code'
    });
    await run(storage, 'relay_claim', { task_id: investigate.task.id });
    const investigationResult = await run(storage, 'relay_report', {
        task_id: investigate.task.id,
        report: { ...result, outcome: 'investigated', commits: [], summary: 'Reviewed only' }
    });
    assert.equal(investigationResult.task.report.outcome, 'investigated');

    // Unclaimed canceled assignments never become running tasks.
    const pending = await run(chief, 'relay_assign', {
        to: 'storage', request_id: 'cancel-003', assignment: 'Pending work'
    });
    assert.equal((await run(chief, 'relay_cancel', { task_id: pending.task.id })).task.status, 'CANCELED');
    assert.match((await run(storage, 'relay_claim', { task_id: pending.task.id })).message, /not assignable/);

    // Simulate a relay crash/restart: message IDs and acknowledgments persist.
    const unclaimed = await run(chief, 'relay_assign', {
        to: 'storage', request_id: 'persist-004', assignment: 'Resume after relay restart'
    });
    await Promise.all(clients.map(client => client.close()));
    clients.length = 0;
    await stop();
    await start();

    const chief2 = await connect('chief-reconnected', chiefToken);
    const storage2 = await connect('storage-reconnected', workerToken);
    assert.equal((await run(storage2, 'relay_inbox')).tasks.some(t => t.id === unclaimed.task.id), true);
    const persisted = await run(chief2, 'relay_assign', {
        to: 'storage', request_id: 'persist-004', assignment: 'Resume after relay restart'
    });
    assert.equal(persisted.duplicate, true);
    assert.equal(persisted.task.id, unclaimed.task.id);
    assert.equal((await run(storage2, 'relay_claim', { task_id: unclaimed.task.id })).task.status, 'RUNNING');

    // An unacknowledged assignment is not retried by the server, but is still queryable.
    const allTasks = await run(chief2, 'relay_tasks');
    assert.equal(allTasks.tasks.length, 4);
    assert.equal(allTasks.tasks.find(t => t.id === taskId).status, 'COMPLETED');
    assert.equal(allTasks.tasks.find(t => t.id === unclaimed.task.id).status, 'RUNNING');
    const fileMode = (await fs.stat(state)).mode & 0o777;
    assert.equal(fileMode, 0o600, 'Agent relay state must not be world-readable');

    const badReport = await run(storage2, 'relay_report', {
        task_id: unclaimed.task.id,
        report: { ...result, commits: ['not-a-commit'] }
    });
    assert.match(badReport.message, /full Git commit hashes/);
    const awaiting = await run(storage2, 'relay_report', {
        task_id: unclaimed.task.id,
        report: { ...result, outcome: 'awaiting_approval', commits: [], blockers: ['TPM change needs human approval'] }
    });
    assert.equal(awaiting.task.status, 'AWAITING_APPROVAL');
    assert.equal(awaiting.verified, false);

    // Bounded outstanding assignments prevent unbounded task spawning.
    for (let i = 0; i < 3; i++) {
        const next = await run(chief2, 'relay_assign', {
            to: 'storage', request_id: `bounded-${i}`, assignment: `Bounded pending task ${i}`
        });
        assert.equal(next.task.status, 'ASSIGNED');
    }
    const overload = await run(chief2, 'relay_assign', {
        to: 'storage', request_id: 'bounded-too-many', assignment: 'Must not be queued'
    });
    assert.match(overload.message, /outstanding task limit/);
    const registry = await run(chief2, 'relay_agents');
    const storageState = registry.agents.find(a => a.id === 'storage');
    assert.equal(storageState.status, 'AWAITING_APPROVAL');
    assert.equal(storageState.connectivity, 'UNKNOWN');
    const tail = await run(chief2, 'relay_events', { after_seq: 3 });
    assert.ok(tail.events.every(e => e.seq > 3));
    assert.equal(tail.next_after_seq, tail.events.at(-1).seq);

    console.log('PASS Quota Agent Relay: MCP messaging, auth, limits, idempotency, persistence and recovery');
} finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await stop();
    await fs.rm(dir, { recursive: true, force: true });
}
