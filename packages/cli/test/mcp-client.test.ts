import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { McpClientManager } from '../src/mcp/client';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

it('discovers and calls a tool over POST-only streamable HTTP', async () => {
  let gets = 0;
  const http = createServer((request, response) => {
    if (request.method === 'GET') {
      gets++;
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
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : message.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'echo',
                    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
                  },
                ],
              }
            : { content: [{ type: 'text', text: message.params.arguments.message }] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const manager = new McpClientManager({
    local: { transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` },
  });
  cleanup.push(() => manager.close());
  const tools = await manager.discover('local');
  expect(tools.map((tool) => tool.name)).toEqual(['echo']);
  const result = await manager.call('local', 'echo', { message: 'hello' });
  expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
  expect(gets).toBe(1);
});

it('completes PKCE login through loopback callback and stores confidential credentials securely', async () => {
  const { mkdtemp, readdir, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { McpAuth } = await import('../src/mcp/auth');
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mcp-'));
  let base = '';
  let tokenRequests = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', base);
    const json = (data: unknown) =>
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (
      path.pathname === '/.well-known/oauth-protected-resource' ||
      path.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      json({ resource: `${base}/mcp`, authorization_servers: [base] });
    } else if (path.pathname === '/.well-known/oauth-authorization-server') {
      json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    } else if (path.pathname === '/register') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () =>
        json({
          client_id: 'fixture-id',
          client_secret: 'private-value',
          redirect_uris: JSON.parse(Buffer.concat(chunks).toString()).redirect_uris,
        }),
      );
    } else if (path.pathname === '/token') {
      tokenRequests++;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        expect(body.get('code_verifier')).toBeTruthy();
        expect(body.get('client_secret')).toBe('private-value');
        json({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          token_type: 'Bearer',
        });
      });
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  base = `http://127.0.0.1:${address.port}`;
  const authorization = new McpAuth('fixture', `${base}/mcp`, { directory });
  await authorization.login({
    onUrl: (url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      const redirect = parsed.searchParams.get('redirect_uri');
      if (!redirect) throw new Error('redirect missing');
      const callback = new URL(redirect);
      callback.searchParams.set('code', 'grant-code');
      callback.searchParams.set('state', parsed.searchParams.get('state') ?? '');
      void fetch(callback);
    },
  });
  expect(tokenRequests).toBe(1);
  expect((await authorization.tokens())?.access_token).toBe('access-secret');
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect((await stat(join(directory, files[0]))).mode & 0o777).toBe(0o600);
  await authorization.logout();
  expect(await authorization.tokens()).toBeUndefined();
  const retry = new McpAuth('fixture', `${base}/mcp`, { directory });
  await expect(
    retry.login({
      onUrl: (url) => {
        const parsed = new URL(url);
        const callback = new URL(parsed.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', 'grant-code');
        callback.searchParams.set('state', 'wrong-state');
        void fetch(callback);
      },
    }),
  ).rejects.toThrow('state mismatch');
  expect(await retry.tokens()).toBeUndefined();
});

it('starts a stdio server, calls its tool, and closes the child', async () => {
  const script = `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }));
server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: 'pong' }] }));
await server.connect(new StdioServerTransport());`;
  const manager = new McpClientManager({
    local: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--input-type=module', '-e', script],
    },
  });
  cleanup.push(() => manager.close());
  expect((await manager.discover('local')).map((tool) => tool.name)).toEqual(['ping']);
  expect((await manager.call('local', 'ping', {})).content).toEqual([
    { type: 'text', text: 'pong' },
  ]);
  await manager.close();
});
