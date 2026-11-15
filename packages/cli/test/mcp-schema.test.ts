import { createServer } from 'node:http';
import type { McpPermissionGate } from '@chimera/core';
import { interceptTools } from '@chimera/tools';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { ToolSet } from 'ai';
import { afterEach, expect, it } from 'vitest';
import { McpClientManager, type McpTool } from '../src/mcp/client';
import { registerMcpTools } from '../src/mcp/tools';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(schema: McpTool['inputSchema'] | ((url: string) => McpTool['inputSchema'])) {
  const calls: unknown[] = [];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
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
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'schema-fixture', version: '1' },
        };
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: 'echo', inputSchema }] };
      } else if (message.method === 'tools/call') {
        calls.push(message.params.arguments);
        result = { content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  const url = `http://127.0.0.1:${address.port}`;
  const inputSchema = typeof schema === 'function' ? schema(url) : schema;
  const servers = { fixture: { transport: 'http' as const, url: `${url}/mcp` } };
  const manager = new McpClientManager(
    servers,
    () => ({ tokens: async () => undefined }) as OAuthClientProvider,
  );
  cleanup.push(() => manager.close());
  const tools: ToolSet = {};
  const permissions: unknown[] = [];
  await registerMcpTools({
    manager,
    servers,
    tools,
    formatters: {},
    gate: {
      requestMcp: async (request) => {
        permissions.push(request.args);
        return { decision: 'allow' };
      },
    } as McpPermissionGate,
    cwd: process.cwd(),
    warn: (message) => {
      throw new Error(message);
    },
  });
  const wrapped = interceptTools(tools, [], (call, next) => next(call));
  return {
    calls,
    permissions,
    requests,
    url,
    invoke: (args: Record<string, unknown>) =>
      wrapped.mcp_fixture_echo.execute!(args, { toolCallId: 'schema-call', messages: [] }),
  };
}

it('invokes a discovered MCP tool declaring JSON Schema 2020-12', async () => {
  const test = await fixture({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    $defs: { key: { type: 'string', minLength: 1 } },
    properties: { taskId: { $ref: '#/$defs/key' } },
    required: ['taskId'],
    additionalProperties: false,
  });
  const args = { taskId: 'PROP-424' };
  await expect(test.invoke(args)).resolves.toMatchObject({
    content: [{ type: 'text', text: JSON.stringify(args) }],
  });
  for (const invalid of [{}, { taskId: '' }, { taskId: 42 }, { ...args, extra: true }]) {
    await expect(test.invoke(invalid)).rejects.toThrow('Invalid arguments');
  }
  expect(test.calls).toEqual([args]);
  expect(test.permissions).toEqual([args]);
});

it.each([
  undefined,
  'https://json-schema.org/draft/2020-12/schema#',
])('enforces 2020-12 tuple and unevaluated-property constraints ($schema: %s)', async ($schema) => {
  const test = await fixture({
    ...($schema ? { $schema } : {}),
    type: 'object',
    allOf: [{ properties: { projectId: { type: 'string' } }, required: ['projectId'] }],
    properties: {
      labels: {
        type: 'array',
        prefixItems: [{ const: 'ready-for-agent' }],
        items: false,
        minItems: 1,
      },
    },
    required: ['labels'],
    unevaluatedProperties: false,
  });
  const args = { projectId: 'PROP', labels: ['ready-for-agent'] };
  await expect(test.invoke(args)).resolves.toMatchObject({
    content: [{ type: 'text', text: JSON.stringify(args) }],
  });
  for (const invalid of [
    { ...args, labels: ['wrong'] },
    { ...args, labels: ['ready-for-agent', 'extra'] },
    { ...args, extra: true },
  ]) {
    await expect(test.invoke(invalid)).rejects.toThrow('Invalid arguments');
  }
  expect(test.calls).toEqual([args]);
  expect(test.permissions).toEqual([args]);
});

it('retains explicit draft-07 tuple, dependency and local-reference validation', async () => {
  const test = await fixture({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    definitions: { key: { type: 'string', minLength: 1 } },
    properties: {
      projectId: { $ref: '#/definitions/key' },
      labels: {
        type: 'array',
        items: [{ const: 'ready-for-agent' }],
        additionalItems: false,
        minItems: 1,
      },
    },
    required: ['labels'],
    dependencies: { labels: ['projectId'] },
    additionalProperties: false,
  });
  const args = { projectId: 'PROP', labels: ['ready-for-agent'] };
  await expect(test.invoke(args)).resolves.toMatchObject({
    content: [{ type: 'text', text: JSON.stringify(args) }],
  });
  for (const invalid of [
    { labels: args.labels },
    { ...args, projectId: '' },
    { ...args, labels: ['wrong'] },
    { ...args, labels: ['ready-for-agent', 'extra'] },
  ]) {
    await expect(test.invoke(invalid)).rejects.toThrow('Invalid arguments');
  }
  expect(test.calls).toEqual([args]);
  expect(test.permissions).toEqual([args]);
});

it.each([
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
])('does not fetch unresolved remote references ($schema: %s)', async ($schema) => {
  const test = await fixture((url) => ({
    $schema,
    type: 'object',
    properties: { taskId: { $ref: `${url}/remote-schema` } },
    required: ['taskId'],
  }));
  const requests = [...test.requests];
  await expect(test.invoke({ taskId: 'PROP-424' })).rejects.toThrow(/can't resolve reference/);
  expect(test.requests).toEqual(requests);
  expect(test.permissions).toEqual([]);
  expect(test.calls).toEqual([]);
});

it('rejects unsupported declared dialects rather than guessing their semantics', async () => {
  const test = await fixture((url) => ({ $schema: `${url}/unknown-dialect`, type: 'object' }));
  const requests = [...test.requests];
  await expect(test.invoke({})).rejects.toThrow(/no schema with key or ref/);
  expect(test.requests).toEqual(requests);
  expect(test.permissions).toEqual([]);
  expect(test.calls).toEqual([]);
});
