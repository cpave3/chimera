import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryModeRegistry } from '@chimera/modes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';

describe('CliAgentFactory', () => {
  it('retains SDK vision declarations through updates, model switches, resume, and reset', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: {
            shape: 'openai',
            adapter: 'compatible',
            baseUrl: 'https://example.invalid',
            apiKey: 'key',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      subagents: { enabled: false },
    });
    const { agent } = await factory.build({
      cwd,
      model: {
        providerId: 'direct',
        modelId: 'custom',
        maxSteps: 1,
        vision: true,
        imageLongEdge: 2048,
      },
      sandboxMode: 'off',
    });
    await agent.updateModelSettings({ settings: {} });
    expect(agent.session.model.vision).toBe(true);
    expect(agent.session.model.imageLongEdge).toBe(2048);
    await agent.updateModelSettings({ model: 'direct/other' });
    expect(agent.session.model.vision).not.toBe(true);
    await agent.updateModelSettings({ model: 'direct/custom', resetSettings: true });
    expect(agent.session.model.vision).toBe(true);
    const { agent: resumed } = await factory.build({
      cwd,
      model: agent.session.model,
      sessionId: agent.session.id,
      sandboxMode: 'off',
    });
    await resumed.updateModelSettings({ settings: {} });
    expect(resumed.session.model.vision).toBe(true);
    expect(resumed.session.model.imageLongEdge).toBe(2048);
  });
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-factory-'));
    process.env.CHIMERA_FACTORY_TEST_KEY = 'test-key';
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    process.env.CHIMERA_FACTORY_TEST_KEY = undefined;
    vi.unstubAllGlobals();
  });

  it('retains SDK creation defaults through settings updates, model switches, and resets', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: {
            shape: 'openai',
            adapter: 'compatible',
            requestProfile: 'openai-chat',
            baseUrl: 'https://example.invalid',
            apiKey: 'key',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      subagents: { enabled: false },
    });
    const { agent } = await factory.build({
      cwd,
      model: {
        providerId: 'direct',
        modelId: 'gpt-4.1',
        maxSteps: 1,
        maxOutputTokens: 4096,
        temperature: 0,
      },
      sandboxMode: 'off',
    });
    await agent.updateModelSettings({ settings: { parallelToolCalls: false } });
    expect(agent.session.model.temperature).toBe(0);
    expect(agent.session.model.maxOutputTokens).toBe(4096);
    await agent.updateModelSettings({ settings: { temperature: 0.7 } });
    const { agent: resumed } = await factory.build({
      cwd,
      model: agent.session.model,
      sessionId: agent.session.id,
      sandboxMode: 'off',
    });
    expect(resumed.session.model.temperature).toBe(0.7);
    await resumed.updateModelSettings({ resetSettings: true });
    expect(resumed.session.model.temperature).toBe(0);
    expect(resumed.session.model.maxOutputTokens).toBe(4096);
    await agent.updateModelSettings({ model: 'direct/gpt-4.1-mini' });
    await agent.updateModelSettings({ model: 'direct/gpt-4.1', resetSettings: true });
    expect(agent.session.model.temperature).toBe(0);
    expect(agent.session.model.maxOutputTokens).toBe(4096);
  });

  it('resolves configured and session settings on creation, switch, and resume', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: {
            shape: 'openai',
            adapter: 'compatible',
            requestProfile: 'openai-chat',
            baseUrl: 'https://example.invalid',
            apiKey: 'key',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      subagents: { enabled: false },
      models: {
        'direct/gpt-5.6-sol': { settings: { reasoningEffort: 'low' } },
        'direct/gpt-5.6-luna': { settings: { reasoningEffort: 'medium' } },
      },
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'direct', modelId: 'gpt-5.6-sol', maxSteps: 1 },
      sandboxMode: 'off',
    });
    expect(agent.modelSettingsState?.effective.reasoningEffort).toBe('low');
    expect(
      (
        await agent.updateModelSettings({
          settings: { reasoningEffort: 'max', parallelToolCalls: false },
        })
      ).status,
    ).toBe('applied');
    await agent.updateModelSettings({ model: 'direct/gpt-5.6-luna' });
    expect(agent.modelSettingsState?.effective.reasoningEffort).toBe('medium');
    await agent.updateModelSettings({ model: 'direct/gpt-5.6-sol' });
    const resumed = await factory.build({
      cwd,
      model: agent.session.model,
      sessionId: agent.session.id,
      sandboxMode: 'off',
    });
    expect(resumed.agent.modelSettingsState?.effective).toMatchObject({
      reasoningEffort: 'max',
      parallelToolCalls: false,
    });
  });

  it('uses mode model defaults on creation and restores the original model after leaving the mode', async () => {
    const modes = new InMemoryModeRegistry(
      ['build', 'plan'].map((name) => ({
        name,
        description: name,
        body: name,
        colorHex: '#000000',
        path: `/builtin/${name}.md`,
        source: 'builtin' as const,
        cycle: true,
        ...(name === 'plan' ? { model: 'direct/gpt-5.6-luna' } : {}),
      })),
      [],
    );
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: {
            shape: 'openai',
            adapter: 'compatible',
            requestProfile: 'openai-chat',
            baseUrl: 'https://example.invalid',
            apiKey: 'key',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      subagents: { enabled: false },
      modes,
      initialMode: 'plan',
      models: {
        'direct/gpt-5.6-sol': { settings: { reasoningEffort: 'max' } },
        'direct/gpt-5.6-luna': { settings: { reasoningEffort: 'low' } },
      },
    });
    const { agent } = await factory.build({
      cwd,
      model: {
        providerId: 'direct',
        modelId: 'gpt-5.6-sol',
        maxSteps: 1,
        settings: { reasoningEffort: 'high' },
        vision: true,
      },
      sandboxMode: 'off',
    });
    expect(agent.modelSettingsState?.effective.reasoningEffort).toBe('low');
    expect(agent.session.model.modelId).toBe('gpt-5.6-luna');
    expect(agent.session.model.vision).not.toBe(true);
    expect(agent.queueModeSwitch('build').status).toBe('applied');
    expect(agent.modelSettingsState?.effective.reasoningEffort).toBe('high');
    expect(agent.session.model.vision).toBe(true);
    await agent.updateModelSettings({ model: 'direct/gpt-5.6-luna' });
    await agent.updateModelSettings({ model: null });
    expect(agent.session.model.modelId).toBe('gpt-5.6-sol');
  });

  it('threads the model identity into the composed system prompt', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });

    // Agent.opts is private; access via type cast for test inspection.
    const opts = (agent as unknown as { opts: { systemPrompt: string } }).opts;
    expect(opts.systemPrompt).toContain('- model: anthropic/claude-opus-4-6');
  });

  it('passes a resolved contextWindow through to the agent', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const opts = (
      agent as unknown as {
        opts: { contextWindow: number; contextWindowIsApproximate?: boolean };
      }
    ).opts;
    expect(opts.contextWindow).toBe(200_000);
    expect(opts.contextWindowIsApproximate).toBe(false);
  });

  it('marks contextWindowIsApproximate when the model falls back', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      warn: () => {},
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'totally-made-up-model', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const opts = (
      agent as unknown as {
        opts: { contextWindow: number; contextWindowIsApproximate?: boolean };
      }
    ).opts;
    expect(opts.contextWindowIsApproximate).toBe(true);
  });

  it('advertises configured models in the spawn_agent tool description, default first', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      models: {
        'anthropic/claude-haiku-4-5': {},
        'anthropic/claude-sonnet-4-5': { contextWindow: 1_000_000 },
      },
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const tools = (
      agent as unknown as {
        opts: { tools: Record<string, { description: string }> };
      }
    ).opts.tools;
    const description = tools.spawn_agent.description;
    expect(description).toMatch(/Available models/);
    expect(description).toMatch(/anthropic\/claude-opus-4-7 \(default\)/);
    expect(description).toContain('anthropic/claude-haiku-4-5');
    expect(description).toContain('anthropic/claude-sonnet-4-5');
  });

  it('uses only the configured SearXNG provider and adds verified-URL guidance', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      webSearch: { provider: 'searxng', baseUrl: 'http://search.example:8181/' },
      subagents: { enabled: false },
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const opts = (
      agent as unknown as {
        opts: {
          tools: Record<
            string,
            { execute: (args: { query: string }, options: object) => Promise<unknown> }
          >;
          systemPrompt: string;
        };
      }
    ).opts;

    expect(opts.tools.web_search).toBeDefined();
    expect(opts.systemPrompt).toContain('Do not invent, assume, or guess URLs');
    expect(opts.systemPrompt).toContain('exact URL returned by web_search');
    await opts.tools.web_search.execute({ query: 'private query' }, {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain('search.example:8181/search');
  });

  it('omits search guidance when web_search is unavailable', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      subagents: { enabled: false },
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const opts = (
      agent as unknown as {
        opts: { tools: Record<string, unknown>; systemPrompt: string };
      }
    ).opts;

    expect(opts.tools.web_search).toBeUndefined();
    expect(opts.tools.fetch).toBeDefined();
    expect(opts.systemPrompt).not.toContain('Do not invent, assume, or guess URLs');
  });

  it('omits search guidance when an allowlist removes web_search', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      webSearch: { provider: 'searxng', baseUrl: 'http://search.example:8181/' },
      toolsAllowlist: ['fetch'],
      subagents: { enabled: false },
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const opts = (
      agent as unknown as {
        opts: { tools: Record<string, unknown>; systemPrompt: string };
      }
    ).opts;

    expect(Object.keys(opts.tools)).toEqual(['fetch', 'request_user_input']);
    expect(opts.systemPrompt).not.toContain('Do not invent, assume, or guess URLs');
  });

  it('keeps search guidance aligned with the current mode after a model change', async () => {
    const modes = new InMemoryModeRegistry(
      [
        {
          name: 'restricted',
          description: 'Fetch only',
          body: 'Restricted mode.',
          tools: ['fetch'],
          colorHex: '#000000',
          path: '/builtin/restricted.md',
          source: 'builtin',
          cycle: true,
        },
      ],
      [],
    );
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      webSearch: { provider: 'searxng', baseUrl: 'http://search.example:8181/' },
      modes,
      initialMode: 'restricted',
      models: { 'anthropic/claude-sonnet-4-5': {} },
      subagents: { enabled: false },
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const result = agent.setUserModelOverride('anthropic/claude-sonnet-4-5');
    const opts = (agent as unknown as { opts: { systemPrompt: string } }).opts;

    expect(result.status).toBe('applied');
    expect(opts.systemPrompt).not.toContain('Do not invent, assume, or guess URLs');
  });

  it('uses the Codex tool surface when the model is configured for it', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          synthetic: {
            shape: 'openai',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      models: {
        'synthetic/codex': { toolCallShape: 'codex' },
      },
      subagents: { enabled: false },
    });

    const { agent } = await factory.build({
      cwd,
      model: {
        providerId: 'synthetic',
        modelId: 'codex',
        maxSteps: 1,
        toolCallShape: 'codex',
      },
      sandboxMode: 'off',
    });

    const tools = (agent as unknown as { opts: { tools: Record<string, unknown> } }).opts.tools;
    expect(Object.keys(tools).sort()).toEqual([
      'bash',
      'edit',
      'find',
      'grep',
      'ls',
      'read',
      'request_user_input',
      'write',
    ]);
    const systemPrompt = (agent as unknown as { opts: { systemPrompt: string } }).opts.systemPrompt;
    expect(systemPrompt).toContain('# Active tools');
    expect(systemPrompt).toContain('- find: Find files by glob pattern');
    expect(systemPrompt).toContain('- ls: List directory contents');
    expect(systemPrompt).not.toContain('- glob:');
  });

  describe('vision model resolver', () => {
    const providersConfig = {
      providers: {
        anthropic: {
          shape: 'anthropic' as const,
          baseUrl: 'https://example.invalid',
          apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
        },
      },
    };

    async function buildAgent(opts: {
      defaultVisionModel?: string;
      models?: ConstructorParameters<typeof CliAgentFactory>[0]['models'];
    }) {
      const factory = new CliAgentFactory({
        providersConfig,
        autoApprove: 'all',
        home: cwd,
        warn: () => {},
        defaultVisionModel: opts.defaultVisionModel,
        models: opts.models,
      });
      const { agent } = await factory.build({
        cwd,
        model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
        sandboxMode: 'off',
      });
      return agent as unknown as {
        visionModelResolver?: () =>
          | {
              status: 'ok';
              ref: string;
              model: { vision?: boolean; maxSteps: number };
              languageModel: unknown;
              contextWindow: number;
            }
          | { status: 'unavailable'; reason: string };
        session: { model: { vision?: boolean } };
        setUserModelOverride: (ref: string) => { status: string };
      };
    }

    it('resolves a configured, vision-flagged defaultVisionModel', async () => {
      const agent = await buildAgent({
        defaultVisionModel: 'anthropic/claude-sonnet-4-5',
        models: { 'anthropic/claude-sonnet-4-5': { vision: true } },
      });
      const result = agent.visionModelResolver?.();
      expect(result).toMatchObject({
        status: 'ok',
        ref: 'anthropic/claude-sonnet-4-5',
        contextWindow: 200_000,
      });
      if (result?.status === 'ok') {
        expect(result.model.vision).toBe(true);
        expect(result.languageModel).toBeDefined();
      }
    });

    it('is unavailable when defaultVisionModel is not set', async () => {
      const agent = await buildAgent({});
      const result = agent.visionModelResolver?.();
      expect(result).toMatchObject({ status: 'unavailable' });
      if (result?.status === 'unavailable') {
        expect(result.reason).toContain('defaultVisionModel');
      }
    });

    it('is unavailable when vision is explicitly disabled for the fallback', async () => {
      const agent = await buildAgent({
        defaultVisionModel: 'anthropic/claude-sonnet-4-5',
        models: { 'anthropic/claude-sonnet-4-5': { vision: false } },
      });
      const result = agent.visionModelResolver?.();
      expect(result).toMatchObject({ status: 'unavailable' });
      if (result?.status === 'unavailable') {
        expect(result.reason).toContain('vision');
      }
    });

    it('is unavailable when the fallback references an unknown provider', async () => {
      const agent = await buildAgent({
        defaultVisionModel: 'nonesuch/some-model',
        models: { 'nonesuch/some-model': { vision: true } },
      });
      const result = agent.visionModelResolver?.();
      expect(result).toMatchObject({ status: 'unavailable' });
    });

    it('carries the vision flag through runtime /model changes', async () => {
      const agent = await buildAgent({
        models: { 'anthropic/claude-sonnet-4-5': { vision: true } },
      });
      const result = agent.setUserModelOverride('anthropic/claude-sonnet-4-5');
      expect(result.status).toBe('applied');
      expect(agent.session.model.vision).toBe(true);
    });
  });

  it('honors a per-model contextWindow override from config', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      models: { 'anthropic/claude-sonnet-4-5': { contextWindow: 1_000_000 } },
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const opts = (agent as unknown as { opts: { contextWindow: number } }).opts;
    expect(opts.contextWindow).toBe(1_000_000);
  });

  it('registers discovered HTTP MCP tools and gates their invocation even with host auto-approval', async () => {
    let calls = 0;
    const server = createServer((request, response) => {
      if (request.method === 'GET') {
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
                        required: ['message'],
                      },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: message.params.arguments.message }] };
        if (message.method === 'tools/call') calls++;
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: {
            shape: 'openai',
            adapter: 'compatible',
            baseUrl: 'https://example.invalid',
            apiKey: 'key',
          },
        },
      },
      autoApprove: 'host',
      home: cwd,
      subagents: { enabled: false, headlessAutoDeny: true },
      mcpServers: { fixture: { transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` } },
    });
    try {
      const { agent } = await factory.build({
        cwd,
        model: { providerId: 'direct', modelId: 'custom', maxSteps: 1 },
        sandboxMode: 'off',
      });
      const tools = (
        agent as unknown as {
          opts: {
            tools: Record<string, { execute: (args: object, options: object) => Promise<unknown> }>;
          };
        }
      ).opts.tools;
      expect(tools.mcp_fixture_echo).toBeDefined();
      expect(factory.getFormatters().mcp_fixture_echo({ message: 'secret-value' })).toEqual({
        label: 'fixture / echo',
        summary: 'message',
      });
      expect(await tools.mcp_fixture_echo.execute({ message: 'hello' }, {})).toMatchObject({
        error: expect.stringContaining('denied'),
      });
      expect(calls).toBe(0);
      const trustedFactory = new CliAgentFactory({
        providersConfig: {
          providers: {
            direct: {
              shape: 'openai',
              adapter: 'compatible',
              baseUrl: 'https://example.invalid',
              apiKey: 'key',
            },
          },
        },
        autoApprove: 'none',
        home: cwd,
        subagents: { enabled: false, headlessAutoDeny: true },
        mcpServers: {
          fixture: {
            transport: 'http',
            url: `http://127.0.0.1:${address.port}/mcp`,
            trustedTools: ['echo'],
          },
        },
      });
      try {
        const trusted = await trustedFactory.build({
          cwd,
          model: { providerId: 'direct', modelId: 'custom', maxSteps: 1 },
          sandboxMode: 'off',
        });
        const allowed = (
          trusted.agent as unknown as {
            opts: {
              tools: Record<
                string,
                { execute: (args: object, options: object) => Promise<unknown> }
              >;
            };
          }
        ).opts.tools;
        expect(await allowed.mcp_fixture_echo.execute({ message: 'hello' }, {})).toMatchObject({
          content: [{ type: 'text', text: 'hello' }],
        });
        expect(calls).toBe(1);
      } finally {
        await trustedFactory.dispose();
      }
    } finally {
      await factory.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
