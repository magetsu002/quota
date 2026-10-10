import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Real MCP handshake + tool listing, then simulate an unexpected provider exit.
const server = new Server({ name: 'crashing-provider', version: '1.0.0' }, {
    capabilities: { tools: {} }
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'ping', description: 'No-op', inputSchema: { type: 'object', properties: {} } }]
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'pong' }]
}));
await server.connect(new StdioServerTransport());
setTimeout(() => process.exit(79), 1250);
