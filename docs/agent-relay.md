# Quota Agent Relay MVP

An **opt-in, authenticated, persistent task mailbox** for existing MCP-capable ChatGPT conversations. This is not a ChatGPT activation service.

## Decision

| Approach | Feasible today | Decision |
| --- | --- | --- |
| A. Native MCP coordination | Yes, when each active conversation can invoke an authorized tool | **Implement** an additive, self-hosted relay endpoint |
| B. Supported ChatGPT integration | MCP tool invocations are supported; no documented general API to send a new user turn into an arbitrary existing ChatGPT chat | **Do not claim automatic resumption** |
| C. Isolated browser controller | A separate headless Chromium/Wayland compositor could avoid disturbing the user's desktop, but does not establish permission or robust ChatGPT session automation | **Do not implement** private endpoints, cookie reuse, CAPTCHA bypass, or UI automation without a permitted contract |
| D. Hybrid transport | A durable message bus plus a future verified activation transport separates concerns | **Chosen design**, with a deliberately unsupported activation adapter today |

Sources checked November 6, 2026:
- [OpenAI: connecting custom MCP servers](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt) — ChatGPT tool invocation is subject to account/workspace capabilities and write-action approvals.
- [OpenAI: ChatGPT Work](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex) and [scheduled tasks](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt) — Work can run scheduled/event-triggered tasks, but this does **not** demonstrate resuming arbitrary existing specialist chats by conversation ID.
- [OpenAI: cloud browser](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt) — isolated cloud browser is for user-directed supported site tasks, not a public cross-conversation send API.
- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/) — automated extraction, bypass of safeguards, rate limits, and unauthorized reverse engineering are restricted.
- [OpenAI API Responses/Conversations migration](https://platform.openai.com/docs/guides/migrate-to-responses) — API-owned conversations do not establish access to existing ChatGPT product conversations.

## Isolation and trust boundary

The existing `/mcp` endpoint still bridges remote clients to device tools. Its device queue remains intentionally ephemeral: an uncertain execution must **never** be replayed.

The new endpoint `/agent-relay/mcp` is independent. It serves only agent-messaging tools, never the local MCP provider. Its per-agent bearer tokens are separate from `QUOTA_MCP_TOKEN` and `QUOTA_DEVICE_TOKEN`. They cannot be reused. The endpoint is disabled unless both agent-relay environment variables are configured.

Agent identities are provisioned by a local operator, not claimed in tool arguments. Configuration includes `id`, `role`, `token_sha256`, optional `conversation_ref`, and for orchestrators an explicit `assign_to` allowlist. Tokens should be random, long, unique and transmitted only through an authorized HTTPS tunnel. A configured conversation reference is **operator-provided metadata**, not a server-verified ChatGPT conversation ID. Reusing a token across conversations defeats that mapping.

The relay **does not execute** any task it stores. Agent prompts and results are untrusted instructions/data; the existing Quota device bridge retains its own privileges. Authorization to put a task in a mailbox never authorizes firmware, reboots, disk changes, TPM, credential operations, or any local command. Those operations need separate human approval and tool-access controls.

## Setup

Generate distinct tokens and their SHA-256 digests without putting plaintext tokens in the repository:

```bash
install -d -m 700 "$HOME/.quota"
node --input-type=module <<'JS'
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const token = () => randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const chief = token(), worker = token();
const agents = [
  { id: 'chief', role: 'orchestrator', token_sha256: hash(chief),
    assign_to: ['storage'], conversation_ref: 'your-chief-chat-reference' },
  { id: 'storage', role: 'worker', token_sha256: hash(worker),
    conversation_ref: 'your-storage-chat-reference' }
];
writeFileSync(join(homedir(), '.quota', 'relay-agents.json'), JSON.stringify({ agents }, null, 2) + '\n', { mode: 0o600 });
console.log('Store these in separate authorized client/tunnel configurations (not the repository):');
console.log({ chief, worker });
JS
```

Start the Quota relay with the two extra variables (in addition to its normal credentials):

```bash
export QUOTA_AGENT_RELAY_CONFIG_PATH="$HOME/.quota/relay-agents.json"
export QUOTA_AGENT_RELAY_STATE_PATH="$HOME/.quota/agent-relay-state.json"
npm run relay
```

Each MCP client connects to `http://127.0.0.1:8787/agent-relay/mcp` with `Authorization: Bearer <its own token>`. Remote ChatGPT access requires a separately authorized HTTPS transport such as a Secure MCP Tunnel that injects the correct bearer token on the tunnel-to-Quota hop. Whether multiple separately registered custom endpoints can be selected in **your current ChatGPT account** requires a product-side test; local MCP test success does not establish that.

No OpenAI API key, Codex dependency, cloud subscription, UI automation, or additional Node packages are required.

## Protocol and lifecycle

1. Chief calls `relay_agents` and `relay_assign({to, request_id, assignment})`. A stable `request_id` is required for at-most-once **task creation**, even across HTTP timeout or relay restart. Reusing the key with different content is an error.
2. Once the worker's existing conversation is active, it calls `relay_inbox` and `relay_claim({task_id})`. Claim marks `RUNNING`, meaning acknowledged by that agent, **not** verified execution.
3. Worker calls `relay_report({task_id, report})`. Reports require `outcome` (`implemented`, `investigated`, `partial`, `failed`, `blocked`, `awaiting_approval`), summary, full commit SHAs, tests, evidence, blockers, and a recommended next action.
4. Chief calls `relay_tasks` and `relay_events({after_seq})`, inspects the self-reported evidence, independently checks Git commits/tests, and only then assigns a new bounded task.

`COMPLETED` means the *assignment* ended; the `outcome` distinguishes implemented from investigation-only or partial work. The relay reports `verified:false`: it does not automatically inspect commits or test logs. `AWAITING_APPROVAL` and `BLOCKED` are explicit terminal reports for now, not hidden approval execution.

Other tools: `relay_identity`, `relay_capabilities`, `relay_cancel` (only unclaimed work). All task reads and events are scoped to sender/recipient identity; only allowlisted orchestrators can assign work. There is no agent self-assignment or automatic task-chain execution.

## Reliability and limits

- Single relay process, single durable JSON state file, serialized mutations, temporary-file write + flush + atomic rename. No simultaneous independent writers or network filesystem guarantee.
- Fixed task IDs and client-generated idempotency keys; duplicate claim/report retries return the existing task, but mismatching results are refused.
- Restart recovery retains queued, claimed, and completed tasks without **automatically sending prompts again**. A recipient must explicitly poll by MCP.
- Maximum 16 registered agents, 4 outstanding tasks per worker, 2000 stored tasks, 8000 events, 4000-character assignment, bounded reports and 100-event paged reads. Capacity exhaustion fails closed; archive offline after preserving evidence before continuing.
- `IDLE` / `ASSIGNED` / `RUNNING` / `COMPLETED` / `FAILED` / `BLOCKED` / `AWAITING_APPROVAL` are task-derived states. `connectivity: UNKNOWN` is truthful; without a supported chat-activity signal, the relay cannot determine `UNREACHABLE`.
- No cursor movement, keyboard focus, desktop automation, browser tabs, or fullscreen interruptions. This implementation only handles HTTP/MCP and filesystem state.

## Verified vs not yet verified

`npm test` includes `test/agent-relay.test.js` exercising separate authenticated MCP clients against the **actual Quota relay server**, both Streamable HTTP SDK and the ChatGPT-style self-contained MCP discovery/list/call protocol, role isolation, duplicate request IDs, task receipt, completion report, event attribution, restart recovery, and access denial against the old `/mcp` endpoint. This is **not** a test with two real ChatGPT web conversations.

**Not supported yet:** externally waking or posting a new user turn into an arbitrary existing ChatGPT specialist conversation; determining the genuine end of ChatGPT's response; guaranteeing product-side multi-connector support; autonomous seven-conversation operation. Neither the new endpoint nor the `ConversationActivationAdapter` contract implies support.

## Path to seven conversations

First connect two **existing** ChatGPT conversations with separate Quota identities and explicitly invoke `relay_identity`, `relay_assign`, `relay_inbox`, `relay_claim`, and `relay_report`. Record both conversation references and verify the chat-specific connections are genuinely isolated. Do not expand without this acceptance test.

Then register the five remaining specialists using separate bearer tokens and narrow chief-to-specialist allowlists. Keep the independent QA agent read-only regarding source code and privileged devices (enforce this outside the message bus), and require commit/test inspection before integration.

Only investigate activation adapters backed by a documented provider capability that (1) targets the **existing** conversation, (2) accepts an authorized message, (3) returns a durable receipt, (4) exposes completion status, and (5) respects policy and rate limits. For an uncertain send, record/reconcile instead of blindly retrying. ChatGPT Work scheduled/event-triggered tasks may merit a separate experiment, but they do not currently prove existing-chat activation. Until then, an active human-directed conversation or explicit user action must invoke the recipient's MCP inbox.
