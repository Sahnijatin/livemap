// A stdio MCP server for the proxy's --upstream-cmd tests: `echo` and a nexus-like `sn_record_manage`.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'mock-stdio-upstream', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'sn_record_manage', inputSchema: { type: 'object', additionalProperties: true } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments ?? {};
  if (req.params.name === 'echo') return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { echo: a.text } }) }] };
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { sys_id: a.sys_id, table: a.table } }) }] };
});
await server.connect(new StdioServerTransport());
