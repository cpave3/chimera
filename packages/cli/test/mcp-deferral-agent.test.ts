import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';

const servers: Server[] = [];
const factories: CliAgentFactory[] = [];
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(factories.splice(0).map((factory) => factory.dispose()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** An MCP server with many tools, each with a long description. */
async function largeServer(): Promise<{ url: string; called: string[] }> {
  const called: string[] = [];
  const tools = Array.from({ length: 12 }, (_, index) => ({
    name: `report_${index}`,
    description: `Build report number ${index}. ${'It reads the ledger and totals the entries. '.repeat(20)}`,
    inputSchema: { type: 'object', properties: { month: { type: 'string' } } },
  }));
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === 'initialize') {
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'ledger', version: '1' },
        };
      } else if (message.method === 'tools/list') {
        result = { tools };
      } else if (message.method === 'tools/call') {
        called.push(message.params.name);
        result = {
          content: [{ type: 'text', text: `report for ${message.params.arguments.month}` }],
        };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  return { url: `http://127.0.0.1:${address.port}`, called };
}

type Tools = Record<string, { execute: (args: object, options: object) => Promise<any> }>;

async function session(contextWindow: number) {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mcp-deferral-'));
  homes.push(home);
  const { url, called } = await largeServer();
  const factory = new CliAgentFactory({
    providersConfig: {
      providers: {
        anthropic: { shape: 'anthropic', baseUrl: 'https://example.invalid', apiKey: 'key' },
      },
    },
    autoApprove: 'all',
    home,
    subagents: { enabled: false },
    models: { 'anthropic/claude-opus-4-7': { contextWindow } },
    mcpServers: { ledger: { transport: 'http', url, trustedTools: ['report_3'] } },
    warn: () => {},
  });
  factories.push(factory);
  const { agent } = await factory.build({
    cwd: home,
    model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
    sandboxMode: 'off',
  });
  const tools = () => (agent as unknown as { opts: { tools: Tools } }).opts.tools;
  const prompt = () => (agent as unknown as { opts: { systemPrompt: string } }).opts.systemPrompt;
  return { tools, prompt, called };
}

const options = { toolCallId: 't', messages: [], abortSignal: new AbortController().signal };

it('registers every MCP tool when the window is large', async () => {
  const { tools } = await session(1_000_000);

  expect(Object.keys(tools()).filter((name) => name.startsWith('mcp_'))).toHaveLength(12);
  expect(tools().tool_search).toBeUndefined();
});

it('holds MCP tools back for a small window, and registers the one the model searches for', async () => {
  // Twelve schemas of about 250 tokens each are over a tenth of 20,000 tokens.
  const { tools, prompt, called } = await session(20_000);

  expect(Object.keys(tools()).filter((name) => name.startsWith('mcp_'))).toEqual([]);
  expect(tools().tool_search).toBeDefined();
  expect(prompt()).toContain('tool_search');

  const found = await tools().tool_search!.execute({ query: 'report 3', limit: 1 }, options);

  expect(found.registered).toEqual(['mcp_ledger_report_x00005f_3']);
  const registered = Object.keys(tools()).filter((name) => name.startsWith('mcp_'));
  expect(registered).toEqual(['mcp_ledger_report_x00005f_3']);
  const result = await tools().mcp_ledger_report_x00005f_3!.execute({ month: 'May' }, options);
  expect(result).toMatchObject({ content: [{ type: 'text', text: 'report for May' }] });
  expect(called).toEqual(['report_3']);
});
