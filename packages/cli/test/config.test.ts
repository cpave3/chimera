import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approvalReviewerEnabled,
  loadConfig,
  resolveHostBashPolicy,
  resolveMcpServers,
  resolveModel,
} from '../src/config';

it('rejects invalid MCP server configuration with config path and server name', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mcp-invalid-'));
  await mkdir(join(home, '.chimera'), { recursive: true });
  await writeFile(
    join(home, '.chimera', 'config.json'),
    JSON.stringify({
      mcpServers: { remote: { transport: 'http', url: 'http://example.com/mcp' } },
    }),
  );
  expect(() => loadConfig(home)).toThrow(/config\.json.*mcpServers.*remote.*url/i);
});

it.each([
  ['unsafe name', { 'bad.name': { transport: 'stdio', command: 'node' } }],
  [
    'unexpected stdio URL',
    { local: { transport: 'stdio', command: 'node', url: 'https://example.com' } },
  ],
  ['missing command', { local: { transport: 'stdio', args: ['server.js'] } }],
  [
    'invalid env reference',
    { local: { transport: 'stdio', command: 'node', env: { KEY: 'secret' } } },
  ],
  ['nonloopback HTTP', { local: { transport: 'http', url: 'http://example.com/mcp' } }],
  [
    'HTTP URL with credentials',
    { local: { transport: 'http', url: 'https://alice:secret@example.com/mcp' } },
  ],
])('rejects %s in mcpServers', async (_label, mcpServers) => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mcp-invalid-'));
  await mkdir(join(home, '.chimera'), { recursive: true });
  await writeFile(join(home, '.chimera', 'config.json'), JSON.stringify({ mcpServers }));
  expect(() => loadConfig(home)).toThrow(/config\.json.*mcpServers/);
});

it('loads typed stdio and HTTP MCP servers without changing other config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mcp-config-'));
  await mkdir(join(home, '.chimera'), { recursive: true });
  await writeFile(
    join(home, '.chimera', 'config.json'),
    JSON.stringify({
      defaultModel: 'example/model',
      mcpServers: {
        local: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { KEY: 'env:LOCAL_KEY' },
        },
        remote: { transport: 'http', url: 'https://example.com/mcp', trustedTools: ['read'] },
      },
    }),
  );
  expect(loadConfig(home).mcpServers).toEqual({
    local: {
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { KEY: 'env:LOCAL_KEY' },
    },
    remote: { transport: 'http', url: 'https://example.com/mcp', trustedTools: ['read'] },
  });
  expect(loadConfig(home).defaultModel).toBe('example/model');
});

it('surfaces malformed and invalid host bash policy config', async () => {
  const malformedHome = await mkdtemp(join(tmpdir(), 'chimera-config-'));
  await mkdir(join(malformedHome, '.chimera'), { recursive: true });
  await writeFile(join(malformedHome, '.chimera', 'config.json'), '{bad json');
  expect(() => loadConfig(malformedHome)).toThrow(/\.chimera\/config\.json.*JSON/i);

  const invalidHome = await mkdtemp(join(tmpdir(), 'chimera-config-'));
  await mkdir(join(invalidHome, '.chimera'), { recursive: true });
  await writeFile(
    join(invalidHome, '.chimera', 'config.json'),
    JSON.stringify({ commandPolicy: { hostBash: { autoAllowThrough: 'critical' } } }),
  );
  expect(() => loadConfig(invalidHome)).toThrow(/autoAllowThrough/);
  expect(resolveHostBashPolicy({})).toEqual({
    enabled: true,
    mode: 'balanced',
    autoAllowThrough: 'caution',
    osSandbox: 'auto',
    network: 'on',
    sandboxWritePaths: [],
  });
});

describe('OS sandbox settings', () => {
  async function homeWith(hostBash: object): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'chimera-config-'));
    await mkdir(join(home, '.chimera'), { recursive: true });
    await writeFile(
      join(home, '.chimera', 'config.json'),
      JSON.stringify({ commandPolicy: { hostBash } }),
    );
    return home;
  }

  it('reads the sandbox mode, the network setting and the write paths', async () => {
    const home = await homeWith({
      osSandbox: 'required',
      network: 'off',
      sandboxWritePaths: ['~/.cache/pnpm', '/var/cache/build'],
    });

    expect(resolveHostBashPolicy(loadConfig(home), home)).toMatchObject({
      osSandbox: 'required',
      network: 'off',
      sandboxWritePaths: [join(home, '.cache/pnpm'), '/var/cache/build'],
    });
  });

  it('refuses a sandbox mode or a network setting it does not know', async () => {
    const unknownMode = await homeWith({ osSandbox: 'on' });
    const unknownNetwork = await homeWith({ network: 'offline' });
    const pathsNotAList = await homeWith({ sandboxWritePaths: 'x' });

    expect(() => loadConfig(unknownMode)).toThrow(/osSandbox/);
    expect(() => loadConfig(unknownNetwork)).toThrow(/network/);
    expect(() => loadConfig(pathsNotAList)).toThrow(/sandboxWritePaths/);
  });
});

describe('approval reviewer setting', () => {
  async function homeWith(config: object): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'chimera-config-'));
    await mkdir(join(home, '.chimera'), { recursive: true });
    await writeFile(join(home, '.chimera', 'config.json'), JSON.stringify(config));
    return home;
  }

  it('is off unless the config turns it on', async () => {
    const on = await homeWith({ approvalReviewer: { enabled: true } });
    const off = await homeWith({ approvalReviewer: {} });

    expect(approvalReviewerEnabled({})).toBe(false);
    expect(approvalReviewerEnabled(loadConfig(off))).toBe(false);
    expect(approvalReviewerEnabled(loadConfig(on))).toBe(true);
  });

  it('refuses a key it does not know', async () => {
    const home = await homeWith({ approvalReviewer: { enabled: true, model: 'x/y' } });

    expect(() => loadConfig(home)).toThrow(/approvalReviewer/);
  });
});

describe('resolveModel', () => {
  it('uses CLI model over config defaultModel', () => {
    const r = resolveModel({
      cliModel: 'openrouter/some-model',
      config: {
        defaultModel: 'anthropic/claude-opus-4-7',
        providers: {
          anthropic: { shape: 'anthropic', baseUrl: 'x', apiKey: 'env:A' },
          openrouter: { shape: 'openai', baseUrl: 'x', apiKey: 'env:O' },
        },
      },
    });
    expect(r.ref).toBe('openrouter/some-model');
    expect(r.model.providerId).toBe('openrouter');
    expect(r.model.modelId).toBe('some-model');
  });

  it('errors when no model is configured and no CLI override is given', () => {
    expect(() => resolveModel({ config: {} })).toThrow(/defaultModel/);
  });

  it('errors when the referenced provider is not configured', () => {
    expect(() =>
      resolveModel({
        cliModel: 'nonesuch/foo',
        config: { providers: { other: { shape: 'openai', baseUrl: 'x', apiKey: 'env:A' } } },
      }),
    ).toThrow(/nonesuch/);
  });

  it('defaults maxSteps to 100 when not specified', () => {
    const r = resolveModel({
      cliModel: 'anthropic/m',
      config: { providers: { anthropic: { shape: 'anthropic', baseUrl: 'x', apiKey: 'env:A' } } },
    });
    expect(r.model.maxSteps).toBe(100);
  });

  it('forwards models[ref].maxOutputTokens to ModelConfig', () => {
    const r = resolveModel({
      cliModel: 'synthetic/k',
      config: {
        providers: { synthetic: { shape: 'openai', baseUrl: 'x', apiKey: 'env:S' } },
        models: { 'synthetic/k': { maxOutputTokens: 32_768 } },
      },
    });
    expect(r.model.maxOutputTokens).toBe(32_768);
  });

  it('leaves maxOutputTokens undefined when not configured', () => {
    const r = resolveModel({
      cliModel: 'synthetic/k',
      config: {
        providers: { synthetic: { shape: 'openai', baseUrl: 'x', apiKey: 'env:S' } },
      },
    });
    expect(r.model.maxOutputTokens).toBeUndefined();
  });

  it('forwards models[ref].vision to ModelConfig and defaults it to undefined', () => {
    const providers = {
      synthetic: { shape: 'openai' as const, baseUrl: 'x', apiKey: 'env:S' },
    };
    const flagged = resolveModel({
      cliModel: 'synthetic/k',
      config: { providers, models: { 'synthetic/k': { vision: true } } },
    });
    expect(flagged.model.vision).toBe(true);

    const unflagged = resolveModel({
      cliModel: 'synthetic/k',
      config: { providers },
    });
    expect(unflagged.model.vision).toBeUndefined();
  });

  it('forwards models[ref].toolCallShape to ModelConfig and defaults it to undefined', () => {
    const providers = {
      synthetic: { shape: 'openai' as const, baseUrl: 'x', apiKey: 'env:S' },
    };
    const flagged = resolveModel({
      cliModel: 'synthetic/k',
      config: { providers, models: { 'synthetic/k': { toolCallShape: 'codex' } } },
    });
    expect(flagged.model.toolCallShape).toBe('codex');

    const unflagged = resolveModel({
      cliModel: 'synthetic/k',
      config: { providers },
    });
    expect(unflagged.model.toolCallShape).toBeUndefined();
  });
});

describe('resolveMcpServers (--mcp-config)', () => {
  const global = {
    mcpServers: {
      local: { transport: 'stdio' as const, command: 'node', args: ['server.js'] },
      remote: { transport: 'http' as const, url: 'https://example.com/mcp' },
    },
  };

  it('returns the global servers when the flag is absent', () => {
    expect(resolveMcpServers(global, undefined)).toEqual(global.mcpServers);
    expect(resolveMcpServers({}, undefined)).toEqual({});
  });

  it('adds servers given as JSON for this session and lets them replace a global one of the same name', () => {
    const session = {
      mcpServers: {
        legato: {
          transport: 'stdio',
          command: '/usr/bin/legato',
          args: ['mcp', 'serve'],
          env: { LEGATO_TASK_ID: 'env:LEGATO_TASK_ID' },
          trustedTools: ['show_card'],
        },
        remote: { transport: 'http', url: 'https://other.example.com/mcp' },
      },
    };
    expect(resolveMcpServers(global, JSON.stringify(session))).toEqual({
      local: global.mcpServers.local,
      remote: session.mcpServers.remote,
      legato: session.mcpServers.legato,
    });
    // The global config object is not changed by a session's servers.
    expect(Object.keys(global.mcpServers)).toEqual(['local', 'remote']);
  });

  it('reads the same document from a file named with @', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chimera-mcp-flag-'));
    const file = join(dir, 'servers.json');
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { fromfile: { transport: 'stdio', command: 'node' } } }),
    );
    expect(resolveMcpServers({}, `@${file}`)).toEqual({
      fromfile: { transport: 'stdio', command: 'node' },
    });
  });

  it.each([
    ['text that is not JSON', 'legato=/usr/bin/legato', /--mcp-config.*JSON/i],
    [
      'a document without mcpServers',
      '{"legato":{"transport":"stdio","command":"x"}}',
      /--mcp-config.*mcpServers/,
    ],
    ['an array', '[]', /--mcp-config.*mcpServers/],
    [
      'a server the config file would reject',
      '{"mcpServers":{"bad":{"transport":"http","url":"http://example.com/mcp"}}}',
      /--mcp-config.*mcpServers.*bad.*url/i,
    ],
    [
      'a literal secret in env',
      '{"mcpServers":{"local":{"transport":"stdio","command":"node","env":{"KEY":"secret"}}}}',
      /--mcp-config.*mcpServers.*local/,
    ],
    [
      'a file that does not exist',
      '@/nonexistent/chimera/servers.json',
      /--mcp-config.*servers\.json/,
    ],
  ])('rejects %s, naming the flag', (_label, value, message) => {
    expect(() => resolveMcpServers(global, value)).toThrow(message);
  });
});

describe('tui settings', () => {
  async function homeWith(config: unknown): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'chimera-tui-config-'));
    await mkdir(join(home, '.chimera'), { recursive: true });
    await writeFile(join(home, '.chimera', 'config.json'), JSON.stringify(config));
    return home;
  }

  it('reads the layout and the mouse setting', async () => {
    const home = await homeWith({ tui: { layout: 'inline', mouse: false } });
    expect(loadConfig(home).tui).toEqual({ layout: 'inline', mouse: false });
  });

  it('reads the notification setting', async () => {
    const home = await homeWith({ tui: { notifications: 'off' } });
    expect(loadConfig(home).tui?.notifications).toBe('off');
  });

  it('rejects a notification setting that does not exist', async () => {
    const home = await homeWith({ tui: { notifications: 'loud' } });
    expect(() => loadConfig(home)).toThrow(/config\.json.*tui\.notifications/);
  });

  it('rejects a layout that does not exist, naming the key', async () => {
    const home = await homeWith({ tui: { layout: 'wide' } });
    expect(() => loadConfig(home)).toThrow(/config\.json.*tui\.layout/);
  });
});
