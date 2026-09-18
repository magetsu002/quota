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
