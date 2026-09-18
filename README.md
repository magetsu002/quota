# Quota

[![CI](https://github.com/magetsu002/quota/actions/workflows/ci.yml/badge.svg)](https://github.com/magetsu002/quota/actions/workflows/ci.yml)

## Tired of Desktop Commander remote limits?

**Quota runs MCP tools on your machine and exposes them to ChatGPT, Claude, or any remote MCP client through your own relay.**

No Quota-imposed monthly tool-call limit. No separate hosted remote-bridge subscription.

Desktop Commander works out of the box, but Quota can expose **any stdio MCP server**.

## Start in three commands

```bash
git clone https://github.com/magetsu002/quota.git
cd quota
npm install
npm start
```

That is enough.

On first start, Quota automatically:

- creates local credentials
- starts the relay
- starts the agent
- fetches and runs Desktop Commander as the default MCP provider
- exposes its tools through Quota

**You do not need to clone or install Desktop Commander separately.**

Your config is stored at:

```text
~/.quota/config.json
```

Check the stack from another terminal:

```bash
npm run --silent status
```

Get the MCP client token:

```bash
npm run --silent token
```

## Use your own MCP instead

Desktop Commander is only the default provider.

```bash
npm start -- node ./my-mcp-server.js
```

If it speaks stdio MCP, Quota can expose its tools.

```text
local MCP provider
       │
       │ stdio
       ▼
   Quota agent
       │
       │ authenticated outbound connection
       ▼
   Quota relay
       │
       │ Streamable HTTP
       ▼
ChatGPT / Claude / MCP client
```

Quota is the bridge. The local MCP provider implements the actual tools.

## Connect an MCP client

The local endpoint is:

```text
http://127.0.0.1:8787/mcp
```

Authenticate with:

```http
Authorization: Bearer <QUOTA_MCP_TOKEN>
```

Run this to print the token:

```bash
npm run --silent token
```

### ChatGPT

For a machine that is not publicly reachable, connect the local Quota endpoint through **OpenAI Secure MCP Tunnel**.

Point the tunnel at:

```text
http://127.0.0.1:8787/mcp
```

and inject the Quota bearer token on the tunnel-client → Quota hop.

Quota supports the stateless MCP flow used by ChatGPT tunnel action discovery, including protocol version `2026-07-28`.

### Claude and other clients

Quota exposes Streamable HTTP MCP.

Local clients can use the endpoint directly. Remote clients need a stable HTTPS endpoint or a supported secure tunnel.

## CLI

After linking/installing the package as a CLI:

```text
quota start [<mcp-command> ...]   Start relay + agent
quota relay                      Start only the relay
quota agent [<mcp-command> ...]  Start only the agent
quota status                     Show connected agents/tools
quota token                      Print the MCP client token
quota init                       Create local config/secrets
```

From a cloned repo, the equivalent npm commands work without linking:

```bash
npm start
npm run --silent status
npm run --silent token
```

## Direct HTTPS + OAuth

If you expose Quota directly on a stable HTTPS hostname, OAuth is built in.

```bash
export QUOTA_PUBLIC_URL=https://mcp.example.com
export QUOTA_OAUTH_OWNER_SECRET="$(openssl rand -hex 32)"
export QUOTA_OAUTH_STATE_PATH="$HOME/.local/state/quota/oauth.json"
```

The OAuth path supports DCR, PKCE, access tokens, refresh tokens, revocation, and persistent client/token state.

## Security

Quota gives remote MCP clients access to tools running on your machine.

- keep the relay on `127.0.0.1` unless you intentionally expose it
- keep the agent and MCP client credentials separate
- never commit credentials or OAuth state
- only expose tools you are comfortable invoking remotely

See [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
```

The test suite covers the CLI, relay, modern ChatGPT discovery/list/call, normal Streamable HTTP, tool calls, provider metadata sanitization, and OAuth.

The standalone Quota agent has also been verified with Desktop Commander, exposing all 26 tools through the relay.

## Status

Quota is an early working prototype. The core relay, agent, authentication, ChatGPT tunnel compatibility, and OAuth paths are working.

Next focus: easier tunnel setup, service management, and multi-device UX.

## License

MIT
