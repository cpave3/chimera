import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectMemoryDir, type SandboxMode } from '@chimera/core';
import { InMemoryModeRegistry, loadModes } from '@chimera/modes';
import { InMemorySkillRegistry } from '@chimera/skills';
import { loadAgents } from '@chimera/subagents';
import { detectOsSandbox } from '@chimera/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBashPolicyConfig } from '../src/config';
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

  const anthropicOnly = {
    providers: {
      anthropic: {
        shape: 'anthropic' as const,
        baseUrl: 'https://example.invalid',
        apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
      },
    },
  };

  it('tells the model to give wide searches to the explore agent', async () => {
    const factory = new CliAgentFactory({
      providersConfig: anthropicOnly,
      autoApprove: 'all',
      home: cwd,
      agents: loadAgents({ cwd, userHome: cwd }),
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const { systemPrompt, tools } = (
      agent as unknown as {
        opts: { systemPrompt: string; tools: Record<string, { description: string }> };
      }
    ).opts;

    expect(tools.spawn_agent.description).toContain('explore —');
    expect(systemPrompt).toMatch(/spawn_agent.*agent "explore"/s);
  });

  it('registers the background agent tools beside spawn_agent, unless the session cannot wait', async () => {
    const toolNames = async (subagents: { background?: boolean }) => {
      const factory = new CliAgentFactory({
        providersConfig: anthropicOnly,
        autoApprove: 'all',
        home: cwd,
        subagents,
      });
      const { agent } = await factory.build({
        cwd,
        model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
        sandboxMode: 'off',
      });
      return Object.keys((agent as unknown as { opts: { tools: object } }).opts.tools);
    };

    expect(await toolNames({})).toEqual(
      expect.arrayContaining(['spawn_agent', 'agent_status', 'agent_stop']),
    );
    const oneShot = await toolNames({ background: false });
    expect(oneShot).toContain('spawn_agent');
    expect(oneShot).not.toContain('agent_status');
    expect(oneShot).not.toContain('agent_stop');
  });

  it('keeps the skills index within 2% of the context window', async () => {
    const skill = (name: string) => ({
      name,
      description: 'A long description of what this skill is for and when to reach for it.',
      path: `/skills/${name}/SKILL.md`,
      source: 'user' as const,
      frontmatter: {},
    });
    const promptWith = async (count: number) => {
      const factory = new CliAgentFactory({
        providersConfig: anthropicOnly,
        autoApprove: 'all',
        home: cwd,
        subagents: { enabled: false },
        models: { 'anthropic/claude-opus-4-7': { contextWindow: 100_000 } },
        skills: new InMemorySkillRegistry(
          Array.from({ length: count }, (_, index) => skill(`skill-${index}`)),
          [],
        ),
      });
      const { agent } = await factory.build({
        cwd,
        model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
        sandboxMode: 'off',
      });
      return (agent as unknown as { opts: { systemPrompt: string } }).opts.systemPrompt;
    };

    // 2% of 100k tokens is 2,000 tokens, about 8,000 characters.
    expect(await promptWith(10)).toContain('skill-3 — A long description');
    const large = await promptWith(200);
    expect(large).not.toContain('A long description');
    expect(large).toContain('- /skills: skill-0, skill-1, ');
  });

  it('composes the prompt of a live session again, with its tool list', async () => {
    const factory = new CliAgentFactory({
      providersConfig: anthropicOnly,
      autoApprove: 'all',
      home: cwd,
      subagents: { enabled: false },
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const first = (agent as unknown as { opts: { systemPrompt: string } }).opts.systemPrompt;
    await writeFile(join(cwd, 'AGENTS.md'), 'NEW-PROJECT-RULE');

    const again = factory.composeSystemPromptFor(agent.session.id);

    expect(again).toContain('NEW-PROJECT-RULE');
    expect(again).toContain('## Tools');
    expect(again?.replace(/\n\n# [^\n]*AGENTS\.md\n\nNEW-PROJECT-RULE/, '')).toBe(first);
    expect(factory.composeSystemPromptFor('no-such-session')).toBeUndefined();
  });

  it('gives plan mode research tools, with spawn_agent held to explore', async () => {
    const warnings: string[] = [];
    const factory = new CliAgentFactory({
      providersConfig: anthropicOnly,
      autoApprove: 'all',
      home: cwd,
      agents: loadAgents({ cwd, userHome: cwd }),
      modes: loadModes({ cwd, userHome: cwd, includeClaudeCompat: false }),
      initialMode: 'plan',
      webSearch: { provider: 'searxng', baseUrl: 'http://search.example:8181/' },
      warn: (message) => warnings.push(message),
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const tools = (
      agent as unknown as {
        opts: {
          tools: Record<
            string,
            {
              execute: (
                args: object,
                options: object,
              ) => Promise<{ reason: string; result: string }>;
            }
          >;
        };
      }
    ).opts.tools;

    expect(Object.keys(tools).sort()).toEqual(
      [
        'agent_status',
        'agent_stop',
        'fetch',
        'glob',
        'grep',
        'read',
        // The handoff tool is registered in every mode.
        'request_user_input',
        'spawn_agent',
        'task_list',
        'web_search',
      ].sort(),
    );
    const refused = await tools.spawn_agent!.execute(
      { prompt: 'edit the file', purpose: 'p' },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(refused.reason).toBe('error');
    expect(refused.result).toMatch(/plan mode.*agent: "explore"/);
    expect(warnings).toEqual([]);
  });

  it('warns about a limit on a tool that takes none', async () => {
    const modesDirectory = join(cwd, '.chimera', 'modes');
    await mkdir(modesDirectory, { recursive: true });
    await writeFile(
      join(modesDirectory, 'careful.md'),
      '---\nname: careful\ndescription: careful mode\ntools: [read, bash(safe)]\n---\nbody',
    );
    const warnings: string[] = [];

    new CliAgentFactory({
      providersConfig: anthropicOnly,
      autoApprove: 'all',
      home: cwd,
      modes: loadModes({ cwd, userHome: cwd, includeClaudeCompat: false }),
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      'mode "careful" limits "bash", which takes no limit; the limit is ignored',
    ]);
  });

  describe('project memory', () => {
    // A home apart from the working directory, as on a real machine: the
    // file tools reach everything under the working directory anyway.
    // The file tools also reach the system temp directory, where test
    // directories live, so the session gets a temp directory of its own.
    let memoryHome: string;
    let systemTmp: string | undefined;
    beforeEach(async () => {
      memoryHome = await mkdtemp(join(tmpdir(), 'chimera-memory-home-'));
      systemTmp = process.env.TMPDIR;
      process.env.TMPDIR = await mkdtemp(join(tmpdir(), 'chimera-session-tmp-'));
    });
    afterEach(async () => {
      await rm(process.env.TMPDIR!, { recursive: true, force: true });
      if (systemTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = systemTmp;
      await rm(memoryHome, { recursive: true, force: true });
    });
    const memoryDirectory = () => projectMemoryDir(cwd, memoryHome);

    async function build(options: Partial<ConstructorParameters<typeof CliAgentFactory>[0]> = {}) {
      const factory = new CliAgentFactory({
        providersConfig: anthropicOnly,
        autoApprove: 'all',
        home: memoryHome,
        subagents: { enabled: false },
        ...options,
      });
      const { agent } = await factory.build({
        cwd,
        model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
        sandboxMode: 'off',
      });
      const opts = (
        agent as unknown as {
          opts: {
            systemPrompt: string;
            tools: Record<string, { execute: (args: object, options: object) => Promise<unknown> }>;
          };
        }
      ).opts;
      return { factory, agent, prompt: opts.systemPrompt, tools: opts.tools };
    }

    it('loads the index into the system prompt and lets the file tools write the directory', async () => {
      await mkdir(memoryDirectory(), { recursive: true });
      await writeFile(join(memoryDirectory(), 'MEMORY.md'), '- [Tests](tests.md) — use vitest\n');

      const { prompt, tools } = await build();
      await tools.write!.execute(
        { path: join(memoryDirectory(), 'style.md'), content: 'No emojis.' },
        { toolCallId: 't', messages: [] },
      );

      expect(prompt).toContain('# Project memory');
      expect(prompt).toContain(memoryDirectory());
      expect(prompt).toContain('- [Tests](tests.md) — use vitest');
      expect(await readFile(join(memoryDirectory(), 'style.md'), 'utf8')).toBe('No emojis.');
    });

    it('lets a subagent read the memory and not write it', async () => {
      await mkdir(memoryDirectory(), { recursive: true });
      await writeFile(join(memoryDirectory(), 'tests.md'), 'Use vitest.');

      const { prompt, tools } = await build({ subagents: { enabled: false, currentDepth: 1 } });
      const read = await tools.read!.execute(
        { path: join(memoryDirectory(), 'tests.md') },
        { toolCallId: 't', messages: [] },
      );

      expect(JSON.stringify(read)).toContain('Use vitest.');
      expect(prompt).toMatch(/read-only for you/);
      await expect(
        tools.write!.execute(
          { path: join(memoryDirectory(), 'new.md'), content: 'x' },
          { toolCallId: 't', messages: [] },
        ),
      ).rejects.toThrow();
    });

    it('is absent when memory is turned off', async () => {
      await mkdir(memoryDirectory(), { recursive: true });
      await writeFile(join(memoryDirectory(), 'tests.md'), 'Use vitest.');

      const { prompt, tools } = await build({ memory: { enabled: false } });

      expect(prompt).not.toContain('# Project memory');
      expect(prompt).not.toContain(memoryDirectory());
      await expect(
        tools.read!.execute(
          { path: join(memoryDirectory(), 'tests.md') },
          { toolCallId: 't', messages: [] },
        ),
      ).rejects.toThrow();
    });

    it('comes back with a reload after the user edits the index', async () => {
      const { factory, agent, prompt } = await build();
      expect(prompt).toContain('Nothing is saved yet.');
      await mkdir(memoryDirectory(), { recursive: true });
      await writeFile(join(memoryDirectory(), 'MEMORY.md'), '- [Style](style.md) — no emojis\n');

      expect(factory.composeSystemPromptFor(agent.session.id)).toContain(
        '- [Style](style.md) — no emojis',
      );
    });
  });

  it('asks the PreToolUse hook before a tool runs, and obeys a block', async () => {
    const hooks = join(cwd, '.chimera', 'hooks', 'PreToolUse');
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, 'guard.sh'),
      '#!/bin/sh\npayload=$(cat)\ncase "$payload" in *frozen.txt*) echo "frozen.txt is read-only" >&2; exit 2;; esac\nexit 0\n',
      { mode: 0o755 },
    );
    const factory = new CliAgentFactory({
      providersConfig: anthropicOnly,
      autoApprove: 'all',
      home: cwd,
      subagents: { enabled: false },
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const { write } = (
      agent as unknown as {
        opts: {
          tools: Record<string, { execute: (args: object, options: object) => Promise<unknown> }>;
        };
      }
    ).opts.tools;

    await write!.execute({ path: 'open.txt', content: 'yes' }, { toolCallId: 'a', messages: [] });
    await expect(
      write!.execute({ path: 'frozen.txt', content: 'no' }, { toolCallId: 'b', messages: [] }),
    ).rejects.toThrow('blocked by PreToolUse hook: frozen.txt is read-only');

    expect(await readFile(join(cwd, 'open.txt'), 'utf8')).toBe('yes');
    await expect(readFile(join(cwd, 'frozen.txt'), 'utf8')).rejects.toThrow();
  });

  it('lets ask_question reach the user only where a user watches the session', async () => {
    const ask = async (options: Partial<ConstructorParameters<typeof CliAgentFactory>[0]>) => {
      const factory = new CliAgentFactory({
        providersConfig: anthropicOnly,
        autoApprove: 'all',
        home: cwd,
        subagents: { enabled: false },
        ...options,
      });
      const { agent } = await factory.build({
        cwd,
        model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
        sandboxMode: 'off',
      });
      const tool = (
        agent as unknown as {
          opts: {
            tools: Record<string, { execute: (args: object, options: object) => Promise<any> }>;
          };
        }
      ).opts.tools.ask_question!;
      const result = tool.execute(
        { questions: [{ question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] },
        { toolCallId: 't', messages: [] },
      );
      return { agent, result };
    };

    const headless = await ask({});
    expect(await headless.result).toMatchObject({ status: 'unavailable' });
    expect(headless.agent.pendingQuestionRequests()).toEqual([]);

    const subagent = await ask({
      userCanAnswer: true,
      subagents: { enabled: false, currentDepth: 1 },
    });
    expect(await subagent.result).toMatchObject({ status: 'unavailable' });

    const interactive = await ask({ userCanAnswer: true });
    // The call passes the tool interceptors before it reaches the user.
    await vi.waitFor(() => expect(interactive.agent.pendingQuestionRequests()).toHaveLength(1));
    const [pending] = interactive.agent.pendingQuestionRequests();
    expect(pending?.questions[0]?.question).toBe('Which?');
    interactive.agent.resolveQuestion(pending!.requestId, { status: 'cancelled' });
    expect(await interactive.result).toMatchObject({ status: 'cancelled' });
  });

  it('says nothing of explore when no such agent exists', async () => {
    const factory = new CliAgentFactory({
      providersConfig: anthropicOnly,
      autoApprove: 'all',
      home: cwd,
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const { systemPrompt } = (agent as unknown as { opts: { systemPrompt: string } }).opts;

    expect(systemPrompt).not.toContain('"explore"');
  });

  it('warns once about a utility model it cannot resolve, and goes on without one', async () => {
    const warnings: string[] = [];
    const factory = new CliAgentFactory({
      providersConfig: anthropicOnly,
      autoApprove: 'all',
      home: cwd,
      utilityModel: 'nowhere/cheap',
      warn: (message) => warnings.push(message),
    });

    for (let build = 0; build < 2; build += 1) {
      await factory.build({
        cwd,
        model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
        sandboxMode: 'off',
      });
    }

    expect(warnings.filter((message) => message.includes('utilityModel'))).toEqual([
      expect.stringContaining('nowhere/cheap'),
    ]);
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
    // Every native tool stays; only glob is renamed (find) and ls is added.
    // A Codex model id also resolves to the patch edit format.
    expect(Object.keys(tools).sort()).toEqual([
      'apply_patch',
      'ask_question',
      'bash',
      'bash_kill',
      'bash_output',
      'fetch',
      'find',
      'grep',
      'ls',
      'read',
      'recall',
      'request_user_input',
      'task_list',
      'write',
    ]);
    const systemPrompt = (agent as unknown as { opts: { systemPrompt: string } }).opts.systemPrompt;
    expect(systemPrompt).toContain('## Tools');
    expect(systemPrompt).toContain('- find — Find files by name pattern.');
    expect(systemPrompt).toContain('- ls — List a directory.');
    expect(systemPrompt).not.toContain('- glob —');
  });

  describe('OS sandbox', () => {
    const describeBwrap = detectOsSandbox() === 'bwrap' ? describe : describe.skip;
    // The session writes the temp directory, and test directories live in
    // the system one. With a temp directory of its own, the home made here
    // is outside everything the sandbox lets a command write.
    let sandboxHome: string;
    let systemTmp: string | undefined;
    beforeEach(async () => {
      sandboxHome = await mkdtemp(join(tmpdir(), 'chimera-sandbox-home-'));
      systemTmp = process.env.TMPDIR;
      process.env.TMPDIR = await mkdtemp(join(tmpdir(), 'chimera-session-tmp-'));
    });
    afterEach(async () => {
      await rm(process.env.TMPDIR!, { recursive: true, force: true });
      if (systemTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = systemTmp;
      await rm(sandboxHome, { recursive: true, force: true });
    });

    type Tools = Record<string, { execute: (args: object, options: object) => Promise<any> }>;
    const policy = (over: Partial<HostBashPolicyConfig> = {}): HostBashPolicyConfig => ({
      enabled: true,
      mode: 'balanced',
      autoAllowThrough: 'caution',
      osSandbox: 'auto',
      network: 'on',
      sandboxWritePaths: [],
      ...over,
    });

    // With the command policy off, nothing asks about a write outside the
    // project, so the write shows whether a sandbox was in the way.
    const unchecked = (over: Partial<HostBashPolicyConfig> = {}) =>
      policy({ enabled: false, ...over });

    function factoryWith(options: Partial<ConstructorParameters<typeof CliAgentFactory>[0]>) {
      return new CliAgentFactory({
        providersConfig: anthropicOnly,
        autoApprove: 'all',
        home: sandboxHome,
        subagents: { enabled: false },
        hostBashPolicy: policy(),
        ...options,
      });
    }

    async function session(factory: CliAgentFactory, sandboxMode: SandboxMode = 'off') {
      const { agent } = await factory.build({
        cwd,
        model: { providerId: 'anthropic', modelId: 'claude-opus-4-7', maxSteps: 1 },
        sandboxMode,
      });
      const tools = (agent as unknown as { opts: { tools: Tools } }).opts.tools;
      const bash = (command: string) =>
        tools.bash!.execute({ command }, { toolCallId: 't', messages: [] });
      return { agent, tools, bash };
    }

    describeBwrap('with bubblewrap', () => {
      it('lets a host command write the project and not the home, and explains the refusal', async () => {
        const factory = factoryWith({});
        const { agent, bash } = await session(factory);

        const inside = await bash('echo in > in.txt');
        const outside = await bash(`echo out > ${join(sandboxHome, 'out.txt')}`);

        expect(inside.exit_code).toBe(0);
        expect(await readFile(join(cwd, 'in.txt'), 'utf8')).toBe('in\n');
        expect(outside.exit_code).not.toBe(0);
        expect(outside.sandbox).toMatch(/unsandboxed: true/);
        expect(existsSync(join(sandboxHome, 'out.txt'))).toBe(false);
        expect(factory.osSandboxOf(agent.session.id)).toBe('bwrap');
      });

      it('keeps the project rules and hooks from a sandboxed command and from the file tools', async () => {
        const { bash, tools } = await session(factoryWith({}));

        const hook = await bash(
          'mkdir -p .chimera/hooks/PreToolUse && echo "exit 0" > .chimera/hooks/PreToolUse/x.sh',
        );

        expect(hook.exit_code).not.toBe(0);
        expect(existsSync(join(cwd, '.chimera', 'hooks'))).toBe(false);
        await expect(
          tools.write!.execute(
            { path: '.chimera/permissions.json', content: '{"rules":[]}' },
            { toolCallId: 't', messages: [] },
          ),
        ).rejects.toThrow(/permissions\.json/);
        expect(existsSync(join(cwd, '.chimera', 'permissions.json'))).toBe(false);
      });

      it('lets a command write the configured write paths and a path granted in the session', async () => {
        const configured = await mkdtemp(join(sandboxHome, 'cache-'));
        const granted = await mkdtemp(join(sandboxHome, 'granted-'));
        const factory = factoryWith({
          hostBashPolicy: policy({ sandboxWritePaths: [configured] }),
        });
        const { agent, bash } = await session(factory);

        const beforeGrant = await bash(`echo x > ${join(granted, 'file')}`);
        await factory.addSessionPath(agent.session.id, 'write', granted);
        const afterGrant = await bash(`echo x > ${join(granted, 'file')}`);
        const inConfigured = await bash(`echo x > ${join(configured, 'file')}`);

        expect(beforeGrant.exit_code).not.toBe(0);
        expect(afterGrant.exit_code).toBe(0);
        expect(inConfigured.exit_code).toBe(0);
      });

      it('tells the model in the system prompt that bash runs in the OS sandbox', async () => {
        const { agent } = await session(factoryWith({}));
        const plain = await session(factoryWith({ hostBashPolicy: policy({ osSandbox: 'off' }) }));
        const promptOf = (built: typeof agent) =>
          (built as unknown as { opts: { systemPrompt: string } }).opts.systemPrompt;

        expect(promptOf(agent)).toMatch(/^- sandbox: os — /m);
        expect(promptOf(agent)).toMatch(/To change a file outside[^.]*unsandboxed: true/);
        expect(promptOf(plain.agent)).toMatch(/^- sandbox: off — no sandbox/m);
      });

      it('gives a sandboxed command no network when the network setting is off', async () => {
        const listener = createServer((_request, response) => response.end('ok'));
        await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
        const { port } = listener.address() as { port: number };
        const connect = `${process.execPath} -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(7))"`;
        try {
          const online = await session(factoryWith({ hostBashPolicy: unchecked() }));
          const offline = await session(
            factoryWith({ hostBashPolicy: unchecked({ network: 'off' }) }),
          );

          expect((await online.bash(connect)).exit_code).toBe(0);
          expect((await offline.bash(connect)).exit_code).toBe(7);
        } finally {
          listener.close();
        }
      });
    });

    it('warns once and runs host commands as before on a machine with no sandbox', async () => {
      const warn = vi.fn();
      const factory = factoryWith({
        warn,
        hostBashPolicy: unchecked(),
        detectOsSandbox: () => null,
      });

      const { agent, bash } = await session(factory);
      await session(factory);
      const outside = await bash(`echo out > ${join(sandboxHome, 'out.txt')}`);

      expect(factory.osSandboxOf(agent.session.id)).toBeUndefined();

      expect(warn.mock.calls.filter(([message]) => /OS sandbox/.test(message))).toHaveLength(1);
      expect(outside.exit_code).toBe(0);
      expect(await readFile(join(sandboxHome, 'out.txt'), 'utf8')).toBe('out\n');
    });

    it('refuses host commands when the sandbox is required and the machine has none', async () => {
      const factory = factoryWith({
        hostBashPolicy: policy({ osSandbox: 'required' }),
        detectOsSandbox: () => null,
      });
      const { bash } = await session(factory);

      const result = await bash('echo in > in.txt');

      expect(result.exit_code).not.toBe(0);
      expect(result.stderr).toContain('commandPolicy.hostBash.osSandbox');
      expect(existsSync(join(cwd, 'in.txt'))).toBe(false);
    });

    it('does not look for a sandbox when the setting is off or the Docker sandbox is on', async () => {
      const detect = vi.fn(() => null);

      const off = await session(
        factoryWith({ hostBashPolicy: unchecked({ osSandbox: 'off' }), detectOsSandbox: detect }),
      );
      await session(
        factoryWith({ hostBashPolicy: policy({ osSandbox: 'required' }), detectOsSandbox: detect }),
        'bind',
      );
      const outside = await off.bash(`echo out > ${join(sandboxHome, 'out.txt')}`);

      expect(detect).not.toHaveBeenCalled();
      expect(outside.exit_code).toBe(0);
      expect(existsSync(join(cwd, '.chimera'))).toBe(false);
    });
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
