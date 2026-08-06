import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryModeRegistry } from '@chimera/modes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';

describe('CliAgentFactory', () => {
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

    expect(Object.keys(opts.tools)).toEqual(['fetch']);
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

    it('is unavailable when the fallback is not marked vision-capable', async () => {
      const agent = await buildAgent({
        defaultVisionModel: 'anthropic/claude-sonnet-4-5',
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
});
