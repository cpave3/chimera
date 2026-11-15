import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
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
                    inputSchema: {
                      type: 'object',
                      properties: { message: { type: 'string' } },
                    },
                  },
                ],
              }
            : {
                content: [{ type: 'text', text: message.params.arguments.message }],
              };
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

it('refreshes an expired HTTP token on a tool call without interactive login', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { McpAuth } = await import('../src/mcp/auth');
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mcp-refresh-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let base = '';
  let accessToken = 'initial-access';
  let refreshToken = 'initial-refresh';
  let refreshes = 0;
  let calls = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', base);
    const json = (value: unknown, status = 200) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (
      path.pathname === '/.well-known/oauth-protected-resource/mcp' ||
      path.pathname === '/.well-known/oauth-protected-resource'
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
    } else if (path.pathname === '/token') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe(refreshToken);
        expect(body.get('client_secret')).toBe('fixture-secret');
        refreshes++;
        accessToken = `rotated-access-${refreshes}`;
        refreshToken = `rotated-refresh-${refreshes}`;
        json({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      });
    } else if (path.pathname === '/mcp' && request.method === 'GET') {
      response.writeHead(405).end();
    } else if (path.pathname === '/mcp') {
      if (request.headers.authorization !== `Bearer ${accessToken}`) {
        response.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
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
              ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: 'done' }] };
        if (message.method === 'tools/call') calls++;
        json({ jsonrpc: '2.0', id: message.id, result });
      });
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  base = `http://127.0.0.1:${address.port}`;
  const provider = new McpAuth('fixture', `${base}/mcp`, { directory });
  await provider.saveClientInformation({
    client_id: 'fixture-id',
    client_secret: 'fixture-secret',
    issuer: base,
  });
  await provider.saveTokens({
    access_token: 'initial-access',
    refresh_token: 'initial-refresh',
    token_type: 'Bearer',
    issuer: base,
  });
  const manager = new McpClientManager(
    { fixture: { transport: 'http', url: `${base}/mcp` } },
    (name, url) => new McpAuth(name, url, { directory }),
  );
  cleanup.push(() => manager.close());
  expect((await manager.discover('fixture')).map((tool) => tool.name)).toEqual(['echo']);
  accessToken = 'expired';
  const refreshedCall = await manager.call('fixture', 'echo', {});
  expect(refreshedCall.content).toEqual([{ type: 'text', text: 'done' }]);
  expect(calls).toBe(1);
  expect(refreshes).toBe(1);
  expect((await provider.tokens())?.refresh_token).toBe('rotated-refresh-1');
  accessToken = 'expired-again';
  const resumed = new McpClientManager(
    { fixture: { transport: 'http', url: `${base}/mcp` } },
    (name, url) => new McpAuth(name, url, { directory }),
  );
  cleanup.push(() => resumed.close());
  expect((await resumed.discover('fixture')).map((tool) => tool.name)).toEqual(['echo']);
  expect((await resumed.call('fixture', 'echo', {})).content).toEqual([
    { type: 'text', text: 'done' },
  ]);
  expect(refreshes).toBe(2);
  expect((await provider.tokens())?.refresh_token).toBe('rotated-refresh-2');
  await provider.saveTokens({
    access_token: 'expired-no-refresh',
    token_type: 'Bearer',
    issuer: base,
  });
  accessToken = 'expired-again';
  await expect(resumed.call('fixture', 'echo', {})).rejects.toThrow('chimera mcp login fixture');
  expect(refreshes).toBe(2);
  expect(calls).toBe(2);
});

it('completes PKCE login through loopback callback and stores confidential credentials securely', async () => {
  const { mkdtemp, readFile, readdir, stat, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { McpAuth } = await import('../src/mcp/auth');
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mcp-'));
  let base = '';
  let tokenRequests = 0;
  let registrations = 0;
  const registeredRedirects = new Map<string, string>();
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
      request.on('end', () => {
        registrations++;
        const redirectUris = JSON.parse(Buffer.concat(chunks).toString()).redirect_uris;
        registeredRedirects.set(`fixture-id-${registrations}`, redirectUris[0]);
        json({
          client_id: `fixture-id-${registrations}`,
          client_secret: 'private-value',
          redirect_uris: redirectUris,
        });
      });
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
  const reserved = createServer();
  await new Promise<void>((resolve) => reserved.listen(0, '127.0.0.1', resolve));
  const callbackAddress = reserved.address();
  if (!callbackAddress || typeof callbackAddress === 'string')
    throw new Error('missing callback port');
  const callbackPort = callbackAddress.port;
  await new Promise<void>((resolve) => reserved.close(() => resolve()));
  const authorization = new McpAuth('fixture', `${base}/mcp`, {
    directory,
    callbackPort,
  });
  let callbackCount = 0;
  await authorization.login({
    onCallback: () => {
      callbackCount++;
    },
    onUrl: (url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        `http://localhost:${callbackPort}/callback`,
      );
      const redirect = parsed.searchParams.get('redirect_uri');
      if (!redirect) throw new Error('redirect missing');
      const callback = new URL(redirect);
      callback.searchParams.set('code', 'grant-code');
      callback.searchParams.set('state', parsed.searchParams.get('state') ?? '');
      void fetch(callback);
    },
  });
  expect(tokenRequests).toBe(1);
  expect(callbackCount).toBe(1);
  expect((await authorization.tokens())?.access_token).toBe('access-secret');
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect((await stat(join(directory, files[0]))).mode & 0o777).toBe(0o600);
  const storedPath = join(directory, files[0]);
  const stored = JSON.parse(await readFile(storedPath, 'utf8'));
  delete stored.tokens;
  await writeFile(storedPath, JSON.stringify(stored));
  const again = new McpAuth('fixture', `${base}/mcp`, {
    directory,
    callbackPort,
  });
  await again.login({
    onUrl: (url) => {
      const parsed = new URL(url);
      const callback = new URL(parsed.searchParams.get('redirect_uri') ?? '');
      expect(registeredRedirects.get(parsed.searchParams.get('client_id') ?? '')).toBe(
        callback.toString(),
      );
      callback.searchParams.set('code', 'grant-code');
      callback.searchParams.set('state', parsed.searchParams.get('state') ?? '');
      void fetch(callback);
    },
  });
  expect(registrations).toBe(1);
  expect(tokenRequests).toBe(2);
  await authorization.logout();
  expect(await authorization.tokens()).toBeUndefined();
  const retry = new McpAuth('fixture', `${base}/mcp`, {
    directory,
    callbackPort,
  });
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

async function lifecycleFixture(failure: string, callMs = 1000) {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mcp-disconnect-'));
  const journal = join(directory, 'calls');
  const manager = new McpClientManager(
    {
      legato: {
        transport: 'stdio',
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./fixtures/mcp-lifecycle-server.mjs', import.meta.url)),
          journal,
          failure,
        ],
        inheritEnv: false,
        env: {},
      },
    },
    undefined,
    { callMs },
  );
  cleanup.push(async () => {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    manager,
    calls: async () => (await readFile(journal, 'utf8')).trim().split('\n'),
  };
}

it.each([
  'exit',
  'oversized response',
])('reconnects after %s without replaying an ambiguous mutation', async (failure) => {
  const { manager, calls } = await lifecycleFixture(failure);
  expect((await manager.call('legato', 'ping', {})).content).toEqual([
    { type: 'text', text: 'pong' },
  ]);
  const failed = manager.call('legato', 'mutate', {});
  await expect(failed).rejects.toThrow(failure === 'exit' ? 'connection closed' : 'receive limit');
  await expect(failed).rejects.toThrow('not retried');
  await expect(failed).rejects.toThrow('Check the result before retrying a mutation');
  await expect(failed).rejects.not.toThrow('private-result-canary');
  const recovered = await Promise.all([
    manager.call('legato', 'ping', {}),
    manager.call('legato', 'ping', {}),
  ]);
  expect(recovered.map((result) => result.content)).toEqual([
    [{ type: 'text', text: 'pong' }],
    [{ type: 'text', text: 'pong' }],
  ]);
  expect((await manager.discover('legato')).map((tool) => tool.name)).toEqual(['ping']);
  await expect(manager.call('legato', 'mutate', {})).rejects.toThrow('Unknown MCP tool');
  expect(await calls()).toEqual([
    'start',
    'list',
    'ping',
    'mutate',
    'start',
    'list',
    'ping',
    'ping',
  ]);
});

it('drains private stdio diagnostics so a verbose server can answer calls', async () => {
  const { manager } = await lifecycleFixture('stderr', 500);
  expect((await manager.call('legato', 'flood', {})).content).toEqual([
    { type: 'text', text: 'pong' },
  ]);
});

it.each([
  'timeout',
  'abort',
])('does not replay a %s or discard a healthy stdio connection', async (failure) => {
  const { manager, calls } = await lifecycleFixture('hang', 500);
  await manager.discover('legato');
  const controller = new AbortController();
  const outcome = manager.call('legato', 'mutate', {}, controller.signal).catch((error) => error);
  if (failure === 'abort') {
    await expect.poll(async () => (await calls()).includes('mutate')).toBe(true);
    controller.abort(new Error('private-abort-canary'));
  }
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain(failure === 'abort' ? 'aborted' : 'timed out');
  expect(error.message).toContain('not retried');
  expect(error.message).not.toContain('private-abort-canary');
  expect((await manager.call('legato', 'ping', {})).content).toEqual([
    { type: 'text', text: 'pong' },
  ]);
  expect(await calls()).toEqual(['start', 'list', 'mutate', 'ping']);
});

it('closes an initializing connection and cannot restore it after session disposal', async () => {
  const { manager, calls } = await lifecycleFixture('initializing');
  const discovery = manager.discover('legato').catch((error) => error);
  await expect
    .poll(async () => {
      try {
        return (await calls()).includes('initialize');
      } catch {
        return false;
      }
    })
    .toBe(true);
  await manager.close();
  expect(await discovery).toBeInstanceOf(Error);
  await expect(manager.call('legato', 'ping', {})).rejects.toThrow('manager is closed');
  expect(await calls()).toEqual(['start', 'initialize']);
});

it.each([
  'call',
  'discovery',
])('reinitializes an HTTP session lost during %s only for a new request', async (failure) => {
  let sessions = 0;
  let session = '';
  const calls: string[] = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString());
      let result: unknown;
      if (message.method === 'initialize') {
        session = `session-${++sessions}`;
        response.setHeader('mcp-session-id', session);
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        };
      } else if (request.headers['mcp-session-id'] !== session) {
        response.writeHead(404).end('private-session-canary');
        return;
      } else if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      } else if (message.method === 'tools/list') {
        if (failure === 'discovery' && sessions === 1) {
          session = 'expired';
          response.writeHead(404).end('private-session-canary');
          return;
        }
        result = {
          tools: ['ping', 'mutate'].map((name) => ({
            name,
            inputSchema: { type: 'object' },
          })),
        };
      } else {
        calls.push(message.params.name);
        if (message.params.name === 'mutate') {
          // Model ambiguous delivery around server session loss, not a safe rejection to replay.
          session = 'expired';
          response.writeHead(404).end('private-session-canary');
          return;
        }
        result = { content: [{ type: 'text', text: 'pong' }] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const manager = new McpClientManager({
    local: { transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` },
  });
  cleanup.push(async () => {
    await manager.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  if (failure === 'call') await manager.call('local', 'ping', {});
  const failed =
    failure === 'call' ? manager.call('local', 'mutate', {}) : manager.discover('local');
  await expect(failed).rejects.toThrow('session expired');
  await expect(failed).rejects.toThrow(
    failure === 'call' ? 'not retried' : 'No tool call was sent',
  );
  await expect(failed).rejects.not.toThrow('private-session-canary');
  expect((await manager.call('local', 'ping', {})).content).toEqual([
    { type: 'text', text: 'pong' },
  ]);
  expect(sessions).toBe(2);
  expect(calls).toEqual(failure === 'call' ? ['ping', 'mutate', 'ping'] : ['ping']);
});
