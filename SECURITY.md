# Security

Quota deliberately bridges an MCP client to tools running on another machine.

## Rules that matter

- Never reuse the device token as the MCP/client token.
- Keep the relay bound to `127.0.0.1` unless you intentionally place it behind a trusted HTTPS tunnel or reverse proxy.
- Do not commit `.env`, OAuth state, API keys, tunnel credentials, or generated device IDs.
- Treat every tool exposed by the local MCP provider as remotely invokable.
- Use a dedicated provider with the minimum tools you actually want to expose when possible.
- Rotate secrets if they are ever printed, pasted, logged, or committed.

For direct public HTTPS deployments, use Quota's OAuth mode rather than anonymous MCP access.

## Agent Relay boundaries

Agent Relay is opt-in and exposes `/agent-relay/mcp`, distinct from the
machine-control `/mcp` endpoint. Configure different long, randomly generated
bearer credentials for every agent; only store their SHA-256 digests in the
relay config. Never use an MCP or device token as an agent token.

A registered agent identity is bound to its bearer token, **not verified
against a ChatGPT conversation ID**. Reusing a token across chats allows those
chats to impersonate one another. The `conversation_ref` is only metadata.
Keep the state and config files private, and use an authorized HTTPS tunnel
for remote MCP. A worker may receive an untrusted assignment; treat its text
as data, not as authorization to bypass human approvals or local-tool controls.
The relay must not be used as an automatic approval authority for firmware,
TPM, encryption, reboots, destructive disk operations, or credentials.
See [Agent Relay](docs/agent-relay.md) for the complete scope and limits.
