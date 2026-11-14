import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRunner } from '@chimera/hooks';
import { InMemoryModeRegistry } from '@chimera/modes';
import { AgentRegistry } from '@chimera/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';

const toolName = 'mcp_fixture_echo';
const servers: Server[] = [];
const factories: CliAgentFactory[] = [];
const homes: string[] = [];

beforeEach(() => {
  vi.spyOn(DefaultHookRunner.prototype, 'fire').mockResolvedValue({ blocked: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(factories.splice(0).map((factory) => factory.dispose()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(instructions?: string) {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mcp-agent-'));
  homes.push(home);
  const calls: Array<{ name: string; arguments: { message: string } }> = [];
  const methods: string[] = [];
  const mcpUrl = await listen(
    createServer((request, response) => {
      methods.push(request.method ?? '');
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
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
            serverInfo: { name: 'remote-display-name', version: '1' },
            instructions,
          };
        } else if (message.method === 'tools/list') {
          result = {
            tools: [
              {
                name: 'echo',
                inputSchema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                  required: ['message'],
                },
              },
            ],
          };
        } else if (message.method === 'tools/call') {
          calls.push(message.params);
          result = {
            content: [{ type: 'text', text: `MCP says ${message.params.arguments.message}` }],
          };
        } else {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
    }),
  );

  const modelRequests: Array<{
    tools?: Array<{ function: { name: string } }>;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const modelUrl = await listen(
    createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        modelRequests.push(body);
        const messages = JSON.stringify(body.messages);
        const hasResult = messages.includes('MCP says hello');
        const denied = messages.includes('denied');
        const toolAvailable = body.tools?.some(
          (candidate: { function: { name: string } }) => candidate.function.name === toolName,
        );
        const delta =
          hasResult || denied || !toolAvailable
            ? {
                content: hasResult
                  ? 'Final: MCP says hello'
                  : denied
                    ? 'MCP denied'
                    : 'No MCP tool',
              }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: toolName,
                      arguments: '{"message":"hello"}',
                    },
                  },
                ],
              };
        const finish = hasResult || denied || !toolAvailable ? 'stop' : 'tool_calls';
        const payload = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
        ]
          .map(
            (part) =>
              `data: ${JSON.stringify({ id: 'fixture', created: 0, model: 'test', ...part })}\n\n`,
          )
          .join('');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`${payload}data: [DONE]\n\n`);
      });
    }),
  );

  function registry(
    options: { trustedTools?: string[]; modeTools?: string[]; systemPrompt?: string } = {},
  ) {
    const modes = new InMemoryModeRegistry(
      [
        {
          name: 'build',
          description: 'Test mode',
          body: 'Test mode',
          tools: options.modeTools,
          colorHex: '#000000',
          path: '/builtin/build.md',
          source: 'builtin',
          cycle: true,
        },
      ],
      [],
    );
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          fixture: {
            shape: 'openai',
            adapter: 'compatible',
            requestProfile: 'openai-chat',
            baseUrl: `${modelUrl}/v1`,
            apiKey: 'fixture-only',
          },
        },
      },
      autoApprove: 'all',
      systemPromptOverride: options.systemPrompt,
      models: { 'fixture/test': { contextWindow: 200_000 } },
      home,
      subagents: { enabled: false, headlessAutoDeny: true },
      modes,
      mcpServers: {
        fixture: { transport: 'http', url: `${mcpUrl}/mcp`, trustedTools: options.trustedTools },
      },
      diagnostics: { enabled: false },
      recall: { enabled: false },
    });
    factories.push(factory);
    return new AgentRegistry({
      factory,
      instance: { pid: process.pid, cwd: home, version: 'test', sandboxMode: 'off' },
      home,
    });
  }

  return { home, calls, methods, modelRequests, registry };
}

const init = (home: string) => ({
  cwd: home,
  model: { providerId: 'fixture', modelId: 'test', maxSteps: 3 },
  sandboxMode: 'off' as const,
});

it('discovers a namespaced tool and carries its result through agent events to final text', {
  timeout: 20000,
}, async () => {
  const test = await fixture();
  const registry = test.registry({ trustedTools: ['echo'] });
  const { sessionId, entry } = await registry.create(init(test.home));
  expect(await registry.run(sessionId, 'Use the echo tool')).toBe('queued');
  await entry.activeRun;
  const events = entry.bus.snapshot();
  expect(test.modelRequests[0]?.tools?.some((tool) => tool.function.name === toolName)).toBe(true);
  expect(test.calls).toEqual([{ name: 'echo', arguments: { message: 'hello' } }]);
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'tool_call_start', name: toolName }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool_call_result',
      result: expect.objectContaining({ content: [{ type: 'text', text: 'MCP says hello' }] }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'assistant_text_done', text: 'Final: MCP says hello' }),
  );
  expect(events).toContainEqual(expect.objectContaining({ type: 'run_finished', reason: 'stop' }));
  expect(test.methods).toContain('POST');
  expect(test.methods.every((method) => method === 'POST' || method === 'GET')).toBe(true);
  expect(test.modelRequests).toHaveLength(2);
  expect(await registry.delete(sessionId)).toBe(true);
});

it('keeps a discovered MCP tool out of a restricted mode', { timeout: 20000 }, async () => {
  const test = await fixture();
  const registry = test.registry({ trustedTools: ['echo'], modeTools: ['read'] });
  const { sessionId, entry } = await registry.create(init(test.home));
  expect(await registry.run(sessionId, 'Use the echo tool')).toBe('queued');
  await entry.activeRun;
  expect(test.modelRequests[0]?.tools?.some((tool) => tool.function.name === toolName)).toBe(false);
  expect(test.calls).toHaveLength(0);
  expect(entry.bus.snapshot()).not.toContainEqual(
    expect.objectContaining({ type: 'tool_call_result' }),
  );
  expect(await registry.delete(sessionId)).toBe(true);
});

it('denies an untrusted MCP call in a headless agent run even with host auto-approval', {
  timeout: 20000,
}, async () => {
  const test = await fixture();
  const registry = test.registry();
  const { sessionId, entry } = await registry.create(init(test.home));
  expect(await registry.run(sessionId, 'Use the echo tool')).toBe('queued');
  await entry.activeRun;
  expect(test.modelRequests[0]?.tools?.some((tool) => tool.function.name === toolName)).toBe(true);
  expect(test.calls).toHaveLength(0);
  expect(entry.bus.snapshot()).toContainEqual(
    expect.objectContaining({
      type: 'tool_call_result',
      result: expect.objectContaining({ error: expect.stringContaining('denied') }),
    }),
  );
  expect(entry.bus.snapshot()).toContainEqual(
    expect.objectContaining({ type: 'assistant_text_done', text: 'MCP denied' }),
  );
  expect(await registry.delete(sessionId)).toBe(true);
});

it.each([
  { instructions: undefined, systemPrompt: undefined },
  { instructions: 'Always check the project before using echo.', systemPrompt: undefined },
  { instructions: 'Always check the project before using echo.', systemPrompt: 'Custom prompt' },
])('sends only supplied MCP instructions to the model, named by configured server (%s)', {
  timeout: 20000,
}, async ({ instructions, systemPrompt }) => {
  const test = await fixture(instructions);
  const registry = test.registry({ trustedTools: ['echo'], systemPrompt });
  const { sessionId, entry } = await registry.create(init(test.home));
  await registry.run(sessionId, 'Use the echo tool');
  await entry.activeRun;
  const system = test.modelRequests[0].messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  if (instructions) {
    expect(system).toContain(`## MCP server: fixture\n\n${instructions}`);
  } else {
    expect(system).not.toContain('## MCP server:');
  }
  expect(await registry.delete(sessionId)).toBe(true);
});
