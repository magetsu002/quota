# Quota

**Quota exposes any local stdio MCP server as an authenticated Streamable HTTP MCP endpoint.**

It was built because a remote MCP bridge should not require a hosted monthly tool-call quota.

```text
ChatGPT / Claude / MCP client
            |
            | Streamable HTTP
            v
        Quota relay
            |
            | authenticated outbound polling
            v
        Quota agent
            |
            | stdio MCP
            v
    any local MCP server
```

Quota does **not** bundle Desktop Commander. Desktop Commander is simply one MCP provider you can run behind the agent. You can use your own MCP server instead.

## What works

- Generic stdio MCP provider -> remote Streamable HTTP bridge
- Tool discovery and tool calls
- Separate device and MCP credentials
- Outbound-only agent connection
- OpenAI secure-tunnel compatibility, including the stateless `2026-07-28` discovery/list/call flow
- Direct HTTPS OAuth mode with:
  - Protected Resource Metadata
  - OAuth Authorization Server Metadata
  - Dynamic Client Registration
  - PKCE
  - access + refresh tokens
  - persisted OAuth clients/tokens
- Tool metadata sanitization so provider-specific UI resources do not break action scanning

## Requirements

- Node.js 20+
- A local stdio MCP server to expose

## Quick start

Clone and install:

```bash
git clone https://github.com/magetsu002/quota.git
cd quota
npm install
npm run build
```

Generate two different secrets:

```bash
export QUOTA_DEVICE_TOKEN="$(openssl rand -hex 32)"
export QUOTA_MCP_TOKEN="$(openssl rand -hex 32)"
```

Start the relay:

```bash
QUOTA_DEVICE_TOKEN="$QUOTA_DEVICE_TOKEN" \
QUOTA_MCP_TOKEN="$QUOTA_MCP_TOKEN" \
npm run start:relay
```

In another terminal, connect a local MCP provider.

### Example: Desktop Commander

```bash
QUOTA_DEVICE_TOKEN="$QUOTA_DEVICE_TOKEN" \
QUOTA_RELAY_URL=http://127.0.0.1:8787 \
node dist/agent/agent.js -- npx -y @wonderwhy-er/desktop-commander@0.2.50
```

### Example: your own MCP server

```bash
QUOTA_DEVICE_TOKEN="$QUOTA_DEVICE_TOKEN" \
QUOTA_RELAY_URL=http://127.0.0.1:8787 \
node dist/agent/agent.js -- node /path/to/your-mcp-server.js
```

The relay is now available at:

```text
http://127.0.0.1:8787/mcp
```

Clients must send:

```http
Authorization: Bearer <QUOTA_MCP_TOKEN>
```

## ChatGPT

For a machine that is not publicly reachable, the cleanest setup is OpenAI Secure MCP Tunnel.

Point the tunnel client at:

```text
http://127.0.0.1:8787/mcp
```

and inject the local Quota bearer token as an MCP extra header. The local token stays on the tunnel-client -> Quota hop.

Quota implements the modern stateless calls currently used during ChatGPT tunnel action discovery:

```text
server/discover
tools/list
tools/call
```

with protocol version `2026-07-28`.

If your provider advertises UI resources in tool `_meta`, Quota strips that provider-specific UI metadata by default. This keeps action-only connectors from failing on resources that Quota does not proxy.

## Claude and other MCP clients

Quota exposes standard Streamable HTTP MCP. Any MCP client that can reach the relay URL and send the configured bearer token can use the tools.

For a cloud client, expose the relay through a stable HTTPS endpoint or another supported secure tunnel. For a local client, `http://127.0.0.1:8787/mcp` is enough.

Quota is transport infrastructure; it does not require the provider behind it to be Desktop Commander.

## Direct HTTPS + OAuth

If you expose Quota directly on a stable HTTPS hostname, enable OAuth:

```bash
export QUOTA_PUBLIC_URL=https://mcp.example.com
export QUOTA_OAUTH_OWNER_SECRET="$(openssl rand -hex 32)"
export QUOTA_OAUTH_STATE_PATH="$HOME/.local/state/quota/oauth.json"
```

Then start the relay with `QUOTA_DEVICE_TOKEN` as usual.

The authorization flow supports DCR, PKCE, access tokens, refresh tokens, revocation, and persistent client/token state.

## Agent configuration

Instead of passing the provider after `--`, you can use environment variables:

```bash
export QUOTA_MCP_COMMAND=node
export QUOTA_MCP_ARGS_JSON='["/path/to/server.js"]'
export QUOTA_MCP_ENV_JSON='{"EXAMPLE":"value"}'
node dist/agent/agent.js
```

## Security model

Quota uses two independent credentials:

- `QUOTA_DEVICE_TOKEN`: agent -> relay
- `QUOTA_MCP_TOKEN`: MCP client/tunnel -> relay

Never make them the same secret.

The agent connects outbound to the relay. The machine does not need an inbound port.

See [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
```

The test suite covers:

- device registration
- tool discovery
- stateless modern ChatGPT discovery/list/call
- legacy Streamable HTTP client compatibility
- provider UI metadata stripping
- OAuth discovery
- DCR
- PKCE
- refresh tokens
- authenticated MCP calls

## Status

Quota is an early working prototype. The protocol path is proven, but installation and multi-device UX still need productization.

## License

MIT
