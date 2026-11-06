import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { noActivationAdapter } from './activation.js';

export type AgentRole = 'orchestrator' | 'worker';
export type TaskStatus = 'ASSIGNED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'AWAITING_APPROVAL' | 'CANCELED';
type Outcome = 'implemented' | 'investigated' | 'partial' | 'failed' | 'blocked' | 'awaiting_approval';

export type RelayActor = {
    id: string;
    role: AgentRole;
    token_sha256: string;
    assign_to: string[];
    conversation_ref?: string;
};

type Report = {
    outcome: Outcome;
    summary: string;
    commits: string[];
    tests: string[];
    evidence: string[];
    blockers: string[];
    recommended_action: string;
};

type Task = {
    id: string;
    request_id: string;
    from: string;
    to: string;
    assignment: string;
    status: TaskStatus;
    created_at: string;
    claimed_at?: string;
    reported_at?: string;
    report?: Report;
};

type Event = { seq: number; at: string; actor: string; task_id: string; action: string; status: TaskStatus };
type State = { version: 1; next_seq: number; tasks: Task[]; events: Event[] };
const emptyState = (): State => ({ version: 1, next_seq: 1, tasks: [], events: [] });
const MAX_TASKS = 2000;
const MAX_EVENTS = 8000;
const MAX_PENDING_PER_AGENT = 4;
const MAX_STRING = 4000;
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const statuses: TaskStatus[] = ['ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'CANCELED'];

function object(value: unknown, label: string): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, any>;
}

function bounded(value: unknown, label: string, max = MAX_STRING): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
        throw new Error(`${label} must be a nonempty string of at most ${max} characters`);
    }
    return value;
}

function stringArray(value: unknown, label: string, maxItems = 20): string[] {
    if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array of at most ${maxItems} strings`);
    return value.map((entry, index) => bounded(entry, `${label}[${index}]`, 400));
}

function readReport(value: unknown): Report {
    const r = object(value, 'report');
    const outcomes: Outcome[] = ['implemented', 'investigated', 'partial', 'failed', 'blocked', 'awaiting_approval'];
    if (!outcomes.includes(r.outcome)) throw new Error('report.outcome is invalid');
    const commits = stringArray(r.commits, 'report.commits', 20);
    if (commits.some(sha => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha))) {
        throw new Error('report.commits must contain full Git commit hashes');
    }
    return {
        outcome: r.outcome,
        summary: bounded(r.summary, 'report.summary', 2000),
        commits,
        tests: stringArray(r.tests, 'report.tests'),
        evidence: stringArray(r.evidence, 'report.evidence'),
        blockers: stringArray(r.blockers, 'report.blockers'),
        recommended_action: bounded(r.recommended_action, 'report.recommended_action', 1000)
    };
}

function taskStatus(outcome: Outcome): TaskStatus {
    switch (outcome) {
        case 'failed': return 'FAILED';
        case 'blocked': return 'BLOCKED';
        case 'awaiting_approval': return 'AWAITING_APPROVAL';
        default: return 'COMPLETED';
    }
}

export class AgentRelay {
    private state: State;
    private tail: Promise<void> = Promise.resolve();
    private constructor(readonly agents: RelayActor[], private readonly stateFile: string, state: State) {
        this.state = state;
    }

    static async load(configFile: string, stateFile: string): Promise<AgentRelay> {
        if (path.resolve(configFile) === path.resolve(stateFile)) throw new Error('Agent config and state files must differ');
        const config = object(JSON.parse(await fs.readFile(configFile, 'utf8')), 'agent relay config');
        if (!Array.isArray(config.agents) || config.agents.length < 2 || config.agents.length > 16) {
            throw new Error('Agent relay requires 2 to 16 explicitly configured agents');
        }
        const agents: RelayActor[] = config.agents.map((value: unknown) => {
            const a = object(value, 'agent');
            if (typeof a.id !== 'string' || !idPattern.test(a.id)) throw new Error('Invalid agent id');
            if (a.role !== 'worker' && a.role !== 'orchestrator') throw new Error('Invalid agent role');
            if (typeof a.token_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.token_sha256)) {
                throw new Error(`Agent ${a.id} needs a lowercase SHA-256 token digest`);
            }
            if (a.assign_to !== undefined && (!Array.isArray(a.assign_to) || a.assign_to.some((v: unknown) => typeof v !== 'string'))) {
                throw new Error('assign_to must be an array of agent IDs');
            }
            if (a.conversation_ref !== undefined) bounded(a.conversation_ref, 'conversation_ref', 500);
            return {
                id: a.id,
                role: a.role,
                token_sha256: a.token_sha256,
                assign_to: a.assign_to ?? [],
                ...(a.conversation_ref === undefined ? {} : { conversation_ref: a.conversation_ref })
            };
        });
        if (new Set(agents.map(a => a.id)).size !== agents.length || new Set(agents.map(a => a.token_sha256)).size !== agents.length) {
            throw new Error('Agent IDs and token hashes must be unique');
        }
        if (!agents.some(a => a.role === 'orchestrator') || !agents.some(a => a.role === 'worker')) {
            throw new Error('At least one orchestrator and one worker are required');
        }
        for (const a of agents) {
            if (a.role === 'worker' && a.assign_to.length) throw new Error('Workers cannot assign tasks');
            if (a.assign_to.some(target => target === a.id || !agents.some(other => other.id === target && other.role === 'worker'))) {
                throw new Error(`Invalid assign_to for ${a.id}`);
            }
        }
        let state: State;
        try {
            state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as State;
        } catch (e: any) {
            if (e?.code !== 'ENOENT') throw e;
            state = emptyState();
        }
        if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.events) ||
            !Number.isSafeInteger(state.next_seq) || state.next_seq < 1 ||
            state.tasks.length > MAX_TASKS || state.events.length > MAX_EVENTS) {
            throw new Error('Invalid agent relay state; refusing to reset data');
        }
        if (state.tasks.some(t => !agents.some(a => a.id === t.from) || !agents.some(a => a.id === t.to) || !statuses.includes(t.status))) {
            throw new Error('Agent configuration does not match persisted tasks');
        }
        return new AgentRelay(agents, stateFile, state);
    }

    authenticate(token: string): RelayActor | undefined {
        if (!token || token.length < 32 || token.length > 512) return undefined;
        const digest = createHash('sha256').update(token).digest();
        return this.agents.find(agent => timingSafeEqual(Buffer.from(agent.token_sha256, 'hex'), digest));
    }

    private async persist(state: State): Promise<void> {
        await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
        const tmp = `${this.stateFile}.${randomUUID()}.tmp`;
        try {
            const fd = await fs.open(tmp, 'wx', 0o600);
            try {
                await fd.writeFile(JSON.stringify(state, null, 2) + '\n');
                await fd.sync();
            } finally {
                await fd.close();
            }
            await fs.rename(tmp, this.stateFile);
            // Directory sync is best-effort (some filesystems reject it).
            try {
                const dir = await fs.open(path.dirname(this.stateFile), 'r');
                try { await dir.sync(); } finally { await dir.close(); }
            } catch { /* atomically renamed state remains committed */ }
        } finally {
            await fs.rm(tmp, { force: true });
        }
    }

    private async change<T>(mutate: (draft: State) => T): Promise<T> {
        const operation = this.tail.then(async () => {
            const draft = structuredClone(this.state);
            const result = mutate(draft);
            await this.persist(draft);
            this.state = draft;
            return result;
        });
        this.tail = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private log(draft: State, actor: string, task: Task, action: string): void {
        if (draft.events.length >= MAX_EVENTS) throw new Error('Event history is full; archive before continuing');
        draft.events.push({ seq: draft.next_seq++, at: new Date().toISOString(), actor, task_id: task.id, action, status: task.status });
    }

    private visible(actor: RelayActor, task: Task): boolean {
        return task.to === actor.id || task.from === actor.id;
    }

    private findVisible(draft: State, actor: RelayActor, taskId: unknown): Task {
        const task = draft.tasks.find(t => t.id === bounded(taskId, 'task_id', 100));
        if (!task || !this.visible(actor, task)) throw new Error('Task not found');
        return task;
    }

    private async view<T>(read: (state: State) => T): Promise<T> {
        await this.tail;
        return read(this.state);
    }

    async call(actor: RelayActor, tool: string, rawArgs: unknown): Promise<unknown> {
        const args = object(rawArgs ?? {}, 'arguments');
        switch (tool) {
            case 'relay_capabilities':
                return {
                    messaging: 'durable-mcp',
                    activation_adapter: noActivationAdapter.name,
                    resumes_existing_chat: noActivationAdapter.resumesExistingConversation,
                    unsolicited_model_execution: false
                };
            case 'relay_identity':
                return { id: actor.id, role: actor.role, conversation_ref: actor.conversation_ref ?? null, assign_to: actor.assign_to };
            case 'relay_agents':
                return this.view(state => ({ agents: this.agents
                    .filter(a => a.id === actor.id ||
                        (actor.role === 'orchestrator' && actor.assign_to.includes(a.id)) ||
                        (actor.role === 'worker' && a.role === 'orchestrator' && a.assign_to.includes(actor.id)))
                    .map(a => ({
                        id: a.id,
                        role: a.role,
                        // Workers must not learn any other conversation references.
                        conversation_ref: a.id === actor.id ||
                            (actor.role === 'orchestrator' && actor.assign_to.includes(a.id))
                            ? a.conversation_ref ?? null : null,
                        status: this.agentStatus(state, a.id),
                        connectivity: 'UNKNOWN'
                    })) }));
            case 'relay_assign':
                return this.change(draft => {
                    if (actor.role !== 'orchestrator') throw new Error('Only an orchestrator may assign work');
                    const to = bounded(args.to, 'to', 64);
                    if (!actor.assign_to.includes(to)) throw new Error('Assignment to this agent is not permitted');
                    const requestId = bounded(args.request_id, 'request_id', 100);
                    const assignment = bounded(args.assignment, 'assignment');
                    const previous = draft.tasks.find(t => t.from === actor.id && t.request_id === requestId);
                    if (previous) {
                        if (previous.to !== to || previous.assignment !== assignment) throw new Error('Idempotency key conflict');
                        return { task: previous, duplicate: true };
                    }
                    if (draft.tasks.length >= MAX_TASKS) throw new Error('Task store is full; archive before continuing');
                    const outstanding = draft.tasks.filter(t => t.to === to && ['ASSIGNED', 'RUNNING', 'AWAITING_APPROVAL'].includes(t.status)).length;
                    if (outstanding >= MAX_PENDING_PER_AGENT) throw new Error('Recipient outstanding task limit reached');
                    const task: Task = {
                        id: randomUUID(), request_id: requestId, from: actor.id, to, assignment,
                        status: 'ASSIGNED', created_at: new Date().toISOString()
                    };
                    draft.tasks.push(task);
                    this.log(draft, actor.id, task, 'assigned');
                    return { task, duplicate: false, activated: noActivationAdapter.resumesExistingConversation };
                });
            case 'relay_inbox':
                return this.view(s => ({ tasks: s.tasks.filter(t => t.to === actor.id && ['ASSIGNED', 'RUNNING', 'AWAITING_APPROVAL'].includes(t.status)) }));
            case 'relay_claim':
                return this.change(draft => {
                    const task = this.findVisible(draft, actor, args.task_id);
                    if (task.to !== actor.id) throw new Error('Only the recipient may claim a task');
                    if (task.status === 'RUNNING') return { task, duplicate: true };
                    if (task.status !== 'ASSIGNED') throw new Error('Task is not assignable');
                    task.status = 'RUNNING';
                    task.claimed_at = new Date().toISOString();
                    this.log(draft, actor.id, task, 'claimed');
                    return { task, duplicate: false };
                });
            case 'relay_report':
                return this.change(draft => {
                    const task = this.findVisible(draft, actor, args.task_id);
                    if (task.to !== actor.id) throw new Error('Only the recipient may report results');
                    const report = readReport(args.report);
                    const status = taskStatus(report.outcome);
                    if (task.report) {
                        if (isDeepStrictEqual(task.report, report)) return { task, duplicate: true, verified: false };
                        throw new Error('Task already has a different report');
                    }
                    if (task.status !== 'RUNNING') throw new Error('Task must be claimed before reporting');
                    task.status = status;
                    task.report = report;
                    task.reported_at = new Date().toISOString();
                    this.log(draft, actor.id, task, 'reported');
                    return { task, duplicate: false, verified: false };
                });
            case 'relay_cancel':
                return this.change(draft => {
                    const task = this.findVisible(draft, actor, args.task_id);
                    if (task.from !== actor.id || actor.role !== 'orchestrator') throw new Error('Only the assigning orchestrator may cancel');
                    if (task.status !== 'ASSIGNED') throw new Error('Only unclaimed tasks may be canceled');
                    task.status = 'CANCELED';
                    this.log(draft, actor.id, task, 'canceled');
                    return { task };
                });
            case 'relay_tasks':
                return this.view(s => ({ tasks: s.tasks.filter(t => this.visible(actor, t)).slice(-100) }));
            case 'relay_events':
                return this.view(s => {
                    const after = args.after_seq ?? 0;
                    if (!Number.isSafeInteger(after) || after < 0) throw new Error('after_seq must be a nonnegative integer');
                    const ids = new Set(s.tasks.filter(t => this.visible(actor, t)).map(t => t.id));
                    const visible = s.events.filter(e => e.seq > after && ids.has(e.task_id));
                    const events = visible.slice(0, 100);
                    return { events, next_after_seq: events.at(-1)?.seq ?? after, has_more: visible.length > events.length };
                });
            default:
                throw new Error(`Unknown relay tool: ${tool}`);
        }
    }

    private agentStatus(state: State, agentId: string): string {
        const tasks = state.tasks.filter(t => t.to === agentId);
        // A newer completed task must not hide older outstanding assignments.
        for (const status of ['AWAITING_APPROVAL', 'RUNNING', 'ASSIGNED'] as const) {
            if (tasks.some(t => t.status === status)) return status;
        }
        return tasks.at(-1)?.status ?? 'IDLE';
    }
}

export const agentTools = [
    { name: 'relay_capabilities', description: 'Report supported messaging and conversation-activation capabilities without guessing.', inputSchema: { type: 'object', properties: {} } },
    { name: 'relay_identity', description: 'Return authenticated relay identity; it does not prove a ChatGPT conversation ID.', inputSchema: { type: 'object', properties: {} } },
    { name: 'relay_agents', description: 'List registered agents. Connectivity UNKNOWN: a queued task cannot wake an idle ChatGPT conversation.', inputSchema: { type: 'object', properties: {} } },
    { name: 'relay_assign', description: 'Orchestrator: durably assign bounded work with a stable client-generated request_id. Queued does not mean activated.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, request_id: { type: 'string' }, assignment: { type: 'string' } }, required: ['to', 'request_id', 'assignment'] } },
    { name: 'relay_inbox', description: 'Recipient: fetch assigned tasks through an explicit MCP invocation.', inputSchema: { type: 'object', properties: {} } },
    { name: 'relay_claim', description: 'Recipient: acknowledge receipt and explicitly mark the task RUNNING; not a live process heartbeat.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'relay_report', description: 'Recipient: publish a structured result. Report claims are not independently verified.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, report: { type: 'object', properties: { outcome: { type: 'string', enum: ['implemented', 'investigated', 'partial', 'failed', 'blocked', 'awaiting_approval'] }, summary: { type: 'string' }, commits: { type: 'array', items: { type: 'string' } }, tests: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } }, blockers: { type: 'array', items: { type: 'string' } }, recommended_action: { type: 'string' } }, required: ['outcome', 'summary', 'commits', 'tests', 'evidence', 'blockers', 'recommended_action'] } }, required: ['task_id', 'report'] } },
    { name: 'relay_cancel', description: 'Orchestrator: cancel an unclaimed assignment without running it.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'relay_tasks', description: 'List the latest 100 tasks visible to this authenticated agent.', inputSchema: { type: 'object', properties: {} } },
    { name: 'relay_events', description: 'Inspect up to 100 authorized durable task events after a sequence cursor.', inputSchema: { type: 'object', properties: { after_seq: { type: 'integer', minimum: 0 } } } }
];

export function relayToolResult(data: unknown): { content: { type: 'text'; text: string }[] } {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
