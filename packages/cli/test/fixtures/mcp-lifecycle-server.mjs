import { appendFileSync, existsSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const [journal, failure] = process.argv.slice(2);
const restarted = existsSync(journal);
appendFileSync(journal, 'start\n');
const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
if (failure === 'initializing') {
  server.setRequestHandler(InitializeRequestSchema, async () => {
    appendFileSync(journal, 'initialize\n');
    await new Promise(() => {});
  });
}
server.setRequestHandler(ListToolsRequestSchema, () => {
  appendFileSync(journal, 'list\n');
  return {
    tools: (restarted ? ['ping'] : ['mutate', 'ping', 'flood']).map((name) => ({
      name,
      inputSchema: { type: 'object' },
    })),
  };
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  appendFileSync(journal, `${params.name}\n`);
  if (params.name === 'mutate') {
    if (failure === 'exit') process.exit(0);
    if (failure === 'hang') await new Promise(() => {});
    const archived = Array.from({ length: 1000 }, (_, index) => ({
      id: `synthetic-${index}`,
      title: 'Synthetic archived task — private-result-canary',
      priority: 'medium',
      status: 'Done',
      workspace_name: 'Synthetic workspace',
      workspace_color: '#123456',
    }));
    return { content: [{ type: 'text', text: JSON.stringify(archived) }] };
  }
  if (params.name === 'flood') {
    await new Promise((resolve) =>
      process.stderr.write('private-stderr-canary'.repeat(100_000), resolve),
    );
  }
  return { content: [{ type: 'text', text: 'pong' }] };
});
await server.connect(new StdioServerTransport());
