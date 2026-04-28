import type { AgentEvent, ModelConfig, SandboxMode, SessionId } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { InMemoryAgentRegistry } from '../src/agents/registry';
import type { AgentDefinition } from '../src/agents/types';
import { buildSpawnAgentTool } from '../src/spawn-tool';
import type { InProcessAgentBuilder, SpawnAgentToolContext } from '../src/types';

function fixtureAgent(over: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'review-correctness',
    description: 'Logical correctness pass',
    body: 'You are a correctness reviewer. Be terse.',
    path: '/tmp/agents/review-correctness.md',
    source: 'claude-user',
    frontmatter: {
      name: 'review-correctness',
      description: 'Logical correctness pass',
      tools: 'Read, Grep, Glob',
      model: 'sonnet',
    },
    ...over,
  };
}

function baseCtx(over: Partial<SpawnAgentToolContext> = {}): SpawnAgentToolContext {
  return {
    emit: () => {},
    parentAbortSignal: new AbortController().signal,
    parentSessionId: 'parent-1',
    cwd: '/tmp',
    defaultModelRef: 'anthropic/claude-haiku-4-5',
    sandboxMode: 'off',
    autoApprove: 'host',
    currentDepth: 0,
    maxDepth: 3,
    chimeraBin: '/usr/bin/false',
    parentHasTty: true,
    ...over,
  };
}

describe('spawn_agent — agent definition resolution', () => {
  it('embeds the registry index in the tool description', () => {
    const agents = new InMemoryAgentRegistry(
      [
        fixtureAgent({ name: 'a', description: 'first' }),
        fixtureAgent({ name: 'b', description: 'second' }),
      ],
      [],
    );
    const ctx = baseCtx({ agents });
    const built = buildSpawnAgentTool(ctx);
    const tool = built.tool as unknown as { description: string };
    expect(tool.description).toContain('Available agent definitions');
    expect(tool.description).toContain('a — first');
    expect(tool.description).toContain('b — second');
  });

  it('omits the index block when no agents are registered', () => {
    const agents = new InMemoryAgentRegistry([], []);
    const ctx = baseCtx({ agents });
    const built = buildSpawnAgentTool(ctx);
    const tool = built.tool as unknown as { description: string };
    expect(tool.description).not.toContain('Available agent definitions');
  });

  it('returns an error when agent name is unknown, listing available agents', async () => {
    const agents = new InMemoryAgentRegistry([fixtureAgent({ name: 'reviewer' })], []);
    const ctx = baseCtx({ agents });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    const result = await tool.execute(
      { prompt: 'go', purpose: 'p', agent: 'no-such-thing', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(result.reason).toBe('error');
    expect(result.result).toMatch(/unknown agent "no-such-thing"/);
    expect(result.result).toMatch(/reviewer/);
  });

  it('errors clearly when agent is requested but no registry is wired', async () => {
    const ctx = baseCtx({ agents: undefined });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    const result = await tool.execute(
      { prompt: 'go', purpose: 'p', agent: 'reviewer', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(result.reason).toBe('error');
    expect(result.result).toMatch(/no agent registry is configured/);
  });

  it('uses the agent body as system_prompt and frontmatter tools as toolNames', async () => {
    let capturedSystemPrompt: string | undefined;
    let capturedToolNames: string[] | undefined;
    const builder: InProcessAgentBuilder = async ({ systemPrompt, toolNames }) => {
      capturedSystemPrompt = systemPrompt;
      capturedToolNames = toolNames;
      return {
        sessionId: 'cs' as SessionId,
        send: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: 'run_finished', reason: 'stop' };
          })(),
        interrupt: () => {},
        dispose: async () => {},
      };
    };
    const agents = new InMemoryAgentRegistry([fixtureAgent({})], []);
    const ctx = baseCtx({ agents, inProcess: builder });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    await tool.execute(
      { prompt: 'go', purpose: 'p', agent: 'review-correctness', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(capturedSystemPrompt).toBe('You are a correctness reviewer. Be terse.');
    expect(capturedToolNames).toEqual(['read', 'grep', 'glob']);
  });

  it('explicit args override agent definition', async () => {
    let capturedSystemPrompt: string | undefined;
    let capturedToolNames: string[] | undefined;
    const builder: InProcessAgentBuilder = async ({ systemPrompt, toolNames }) => {
      capturedSystemPrompt = systemPrompt;
      capturedToolNames = toolNames;
      return {
        sessionId: 'cs' as SessionId,
        send: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: 'run_finished', reason: 'stop' };
          })(),
        interrupt: () => {},
        dispose: async () => {},
      };
    };
    const agents = new InMemoryAgentRegistry([fixtureAgent({})], []);
    const ctx = baseCtx({ agents, inProcess: builder });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    await tool.execute(
      {
        prompt: 'go',
        purpose: 'p',
        agent: 'review-correctness',
        system_prompt: 'custom',
        tools: ['bash'],
        in_process: true,
      },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(capturedSystemPrompt).toBe('custom');
    expect(capturedToolNames).toEqual(['bash']);
  });

  it('skips frontmatter model unless it is a fully-qualified provider/model ref', async () => {
    let capturedModel: ModelConfig | undefined;
    const builder: InProcessAgentBuilder = async ({ model }) => {
      capturedModel = model;
      return {
        sessionId: 'cs' as SessionId,
        send: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: 'run_finished', reason: 'stop' };
          })(),
        interrupt: () => {},
        dispose: async () => {},
      };
    };
    const agents = new InMemoryAgentRegistry(
      [
        fixtureAgent({
          frontmatter: {
            name: 'review-correctness',
            description: 'x',
            tools: 'Read',
            model: 'sonnet', // not provider-qualified
          },
        }),
      ],
      [],
    );
    const ctx = baseCtx({ agents, inProcess: builder });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    await tool.execute(
      { prompt: 'go', purpose: 'p', agent: 'review-correctness', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    // Falls back to ctx.defaultModelRef = 'anthropic/claude-haiku-4-5'
    expect(capturedModel?.providerId).toBe('anthropic');
    expect(capturedModel?.modelId).toBe('claude-haiku-4-5');
  });

  it('uses agent frontmatter model when fully qualified', async () => {
    let capturedModel: ModelConfig | undefined;
    const builder: InProcessAgentBuilder = async ({ model }) => {
      capturedModel = model;
      return {
        sessionId: 'cs' as SessionId,
        send: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: 'run_finished', reason: 'stop' };
          })(),
        interrupt: () => {},
        dispose: async () => {},
      };
    };
    const agents = new InMemoryAgentRegistry(
      [
        fixtureAgent({
          frontmatter: {
            name: 'review-correctness',
            description: 'x',
            tools: 'Read',
            model: 'anthropic/claude-sonnet-4-6',
          },
        }),
      ],
      [],
    );
    const ctx = baseCtx({ agents, inProcess: builder });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    await tool.execute(
      { prompt: 'go', purpose: 'p', agent: 'review-correctness', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(capturedModel?.providerId).toBe('anthropic');
    expect(capturedModel?.modelId).toBe('claude-sonnet-4-6');
  });
});

type _Unused = SandboxMode;
