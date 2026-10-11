import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@chimera/core';
import { loadModes } from '@chimera/modes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';

interface CapturedRequest {
  system: string;
  tools: string[];
}

describe('model profiles', () => {
  let cwd: string;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-profile-'));
    requests = [];
    // The provider rejects every request, so each run ends after the first
    // step. The request it received is what the test inspects.
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (!String(input).endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 });
      }
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
        tools?: Array<{ function: { name: string } }>;
      };
      requests.push({
        // Reasoning-model ids get the system prompt under the `developer` role.
        system:
          body.messages.find((message) => ['system', 'developer'].includes(message.role))
            ?.content ?? '',
        tools: (body.tools ?? []).map((tool) => tool.function.name).sort(),
      });
      return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cwd, { recursive: true, force: true });
  });

  async function buildAgent(
    modelId: string,
    options: Partial<ConstructorParameters<typeof CliAgentFactory>[0]> = {},
  ): Promise<Agent> {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: { shape: 'openai', baseUrl: 'https://provider.test/v1', apiKey: 'test-key' },
        },
      },
      autoApprove: 'all',
      home: cwd,
      warn: () => {},
      subagents: { enabled: false },
      ...options,
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'direct', modelId, maxSteps: 3 },
      sandboxMode: 'off',
    });
    return agent;
  }

  async function requestFor(agent: Agent): Promise<CapturedRequest> {
    for await (const _event of agent.run('hi')) {
      // drain
    }
    return requests.at(-1)!;
  }

  /** The tool names the prompt's tools section lists. */
  function listedTools(system: string): string[] {
    const start = system.indexOf('## Tools');
    const section = system.slice(start, system.indexOf('\n## ', start + 1));
    return [...section.matchAll(/^- (\S+) — /gm)].map((match) => match[1]!).sort();
  }

  it('gives a GPT model apply_patch and the lean prompt', async () => {
    const request = await requestFor(await buildAgent('gpt-5-codex'));

    expect(request.tools).toContain('apply_patch');
    expect(request.tools).not.toContain('edit');
    expect(request.system).toContain('You are Chimera');
    expect(request.system).not.toContain('## Working method');
  });

  it('gives a model it does not know the edit tool and the guided prompt', async () => {
    const request = await requestFor(await buildAgent('qwen3-coder'));

    expect(request.tools).toContain('edit');
    expect(request.tools).not.toContain('apply_patch');
    expect(request.system).toContain('## Working method');
  });

  it('lists exactly the registered tools in the prompt', async () => {
    const request = await requestFor(await buildAgent('qwen3-coder'));

    expect(listedTools(request.system)).toEqual(request.tools);
    expect(request.system).not.toContain('four built-in tools');
  });

  it('follows the per-model settings in config', async () => {
    const request = await requestFor(
      await buildAgent('qwen3-coder', {
        models: { 'direct/qwen3-coder': { promptStyle: 'lean', toolCallShape: 'codex' } },
      }),
    );

    expect(request.tools).toEqual(expect.arrayContaining(['find', 'ls', 'fetch']));
    expect(request.tools).not.toContain('glob');
    expect(request.system).not.toContain('## Working method');
    expect(listedTools(request.system)).toEqual(request.tools);
  });

  it('applies the new model profile after a model change', async () => {
    const agent = await buildAgent('qwen3-coder');
    await requestFor(agent);

    expect(agent.setUserModelOverride('direct/gpt-5-codex').status).toBe('applied');
    const request = await requestFor(agent);

    expect(request.tools).toContain('apply_patch');
    expect(request.tools).not.toContain('edit');
    expect(request.system).not.toContain('## Working method');
    expect(listedTools(request.system)).toEqual(request.tools);
  });

  it('keeps file discovery in plan mode under the codex tool names', async () => {
    const modes = loadModes({ cwd, userHome: cwd, includeClaudeCompat: false });
    const agent = await buildAgent('qwen3-coder', {
      models: { 'direct/qwen3-coder': { toolCallShape: 'codex' } },
      modes,
      initialMode: 'plan',
    });

    const request = await requestFor(agent);

    expect(request.tools).toEqual(expect.arrayContaining(['read', 'find', 'ls', 'grep']));
    expect(request.tools).not.toContain('bash');
    expect(listedTools(request.system)).toEqual(request.tools);
  });
});
