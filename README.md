# Quota

[![CI](https://github.com/magetsu002/quota/actions/workflows/ci.yml/badge.svg)](https://github.com/magetsu002/quota/actions/workflows/ci.yml)

## Tired of Desktop Commander limits?

**Quota exposes your own local MCP tools to ChatGPT, Claude, and other MCP clients through a self-hosted relay.**

No hosted remote bridge. No Quota-imposed monthly tool-call counter. Your tools keep running on **your machine**.

Desktop Commander can be the provider — but it does not have to be. Quota can expose **any stdio MCP server**.

```text
your local MCP server
        |
        | stdio
        v
   Quota agent
        |
        | authenticated outbound connection
        v
   Quota relay
        |
        | Streamable HTTP
        v
ChatGPT / Claude / MCP client
```

### Why Quota?

- **Keep the MCP local** — the provider runs on your own machine.
- **Bring your own tools** — Desktop Commander, your own MCP, or anything else that speaks stdio MCP.
- **No Quota monthly call limit** — Quota itself does not meter tool calls.
- **Outbound-only agent** — your machine does not need an inbound port.
- **Works with remote clients** — expose the relay through a stable HTTPS endpoint or supported secure tunnel.

> Quota does not bundle, crack, or bypass Desktop Commander's hosted service. It runs a local MCP provider and exposes those tools through your own relay.

## Quick start

### 1. Install

```bash
git clone https://github.com/magetsu002/quota.git
cd quota
npm install
npm run build
```

Requirements:

- Node.js 20+
- a local stdio MCP server to expose

### 2. Generate two different secrets

```bash
export QUOTA_DEVICE_TOKEN="$(openssl rand -hex 32)"
export QUOTA_MCP_TOKEN="$(openssl rand -hex 32)"
```

- `QUOTA_DEVICE_TOKEN`: agent → relay
- `QUOTA_MCP_TOKEN`: MCP client/tunnel → relay

Do not reuse the same secret for both.

### 3. Start the relay

```bash
QUOTA_DEVICE_TOKEN="$QUOTA_DEVICE_TOKEN" \
QUOTA_MCP_TOKEN="$QUOTA_MCP_TOKEN" \
npm run start:relay
```

The MCP endpoint is now:

```text
http://127.0.0.1:8787/mcp
```

### 4. Attach a local MCP provider

#### Desktop Commander

```bash
QUOTA_DEVICE_TOKEN="$QUOTA_DEVICE_TOKEN" \
QUOTA_RELAY_URL=http://127.0.0.1:8787 \
node dist/agent/agent.js -- npx -y @wonderwhy-er/desktop-commander@0.2.50
```

#### Your own MCP

```bash
QUOTA_DEVICE_TOKEN="$QUOTA_DEVICE_TOKEN" \
QUOTA_RELAY_URL=http://127.0.0.1:8787 \
node dist/agent/agent.js -- node /path/to/your-mcp-server.js
```

That is the core idea:

```text
Quota does not care what your MCP does.
If it speaks stdio MCP, the agent can expose its tools.
```

## ChatGPT

For a machine that is not publicly reachable, use **OpenAI Secure MCP Tunnel** and point it at:

```text
http://127.0.0.1:8787/mcp
```

Inject the local Quota bearer token as the MCP authorization header:

```http
Authorization: Bearer <QUOTA_MCP_TOKEN>
```

The token stays on the tunnel-client → Quota hop.

Quota supports the modern stateless calls used by ChatGPT tunnel action discovery:

```text
server/discover
tools/list
tools/call
```

with protocol version:

```text
2026-07-28
```

Provider-specific UI metadata is stripped from the exported action catalog by default. This prevents tool scans from trying to load UI resources that Quota does not proxy.

## Claude and other MCP clients

Quota exposes Streamable HTTP MCP.

Any compatible client that can reach the relay URL and provide the configured bearer token can use the exposed tools.

For a local client:

```text
http://127.0.0.1:8787/mcp
```

For a remote/cloud client, put Quota behind a stable HTTPS endpoint or supported secure tunnel.

## Direct HTTPS + OAuth

If you expose Quota directly on a stable HTTPS hostname, OAuth mode is built in.

```bash
export QUOTA_PUBLIC_URL=https://mcp.example.com
export QUOTA_OAUTH_OWNER_SECRET="$(openssl rand -hex 32)"
export QUOTA_OAUTH_STATE_PATH="$HOME/.local/state/quota/oauth.json"
```

The OAuth implementation supports:

- Protected Resource Metadata
- Authorization Server Metadata
- Dynamic Client Registration
- PKCE
- access tokens
- refresh tokens
- token revocation
- persistent OAuth client/token state
- a built-in authorization consent page

## What is already proven

Quota currently has automated coverage for:

- agent registration
- tool discovery
- tool calls
- modern ChatGPT `2026-07-28` discovery/list/call
- normal Streamable HTTP clients
- provider UI metadata sanitization
- OAuth discovery
- Dynamic Client Registration
- PKCE
- access-token exchange
- refresh tokens
- authenticated MCP calls

A real Desktop Commander provider was also tested through the standalone generic Quota agent and exposed all 26 tools through the relay.

## Agent configuration

Instead of passing the MCP command after `--`, configure it with environment variables:

```bash
export QUOTA_MCP_COMMAND=node
export QUOTA_MCP_ARGS_JSON='["/path/to/server.js"]'
export QUOTA_MCP_ENV_JSON='{"EXAMPLE":"value"}'

node dist/agent/agent.js
```

## Security

Quota deliberately bridges remote AI clients to tools running on another machine.

Use it like infrastructure, not like a toy:

- keep device and client credentials separate
- never commit secrets
- bind the relay to `127.0.0.1` unless you intentionally expose it
- use stable HTTPS/OAuth or a trusted secure tunnel for remote access
- only expose MCP tools you are comfortable invoking remotely

See [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
```

## Status

Quota is an early working prototype.

The transport and authentication paths are proven. The next focus is making installation, tunnel setup, service management, and multi-device support much easier.

## License

MIT
