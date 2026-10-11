import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';

/** An OpenAI chat-completions stream that asks for one tool call. */
function toolCallStream(name: string, args: unknown): Response {
  const chunk = (delta: unknown, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const body =
    chunk(
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      null,
    ) +
    chunk({}, 'tool_calls') +
    'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('tool guards in a session', () => {
  let cwd: string;
  let toolMessages: string[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-guards-'));
    toolMessages = [];
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cwd, { recursive: true, force: true });
  });

  /**
   * The provider asks for one tool call, then rejects the follow-up request.
   * That follow-up carries the tool result exactly as the model would see it.
   */
  async function resultSeenByModel(toolName: string, args: unknown): Promise<string> {
    let requestCount = 0;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (!String(input).endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 });
      }
      requestCount += 1;
      if (requestCount === 1) return toolCallStream(toolName, args);
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      for (const message of body.messages) {
        if (message.role === 'tool') toolMessages.push(JSON.stringify(message.content));
      }
      return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: { shape: 'openai', baseUrl: 'https://provider.test/v1', apiKey: 'test-key' },
        },
      },
      // A 16k-token window gives the smallest output budget: 2,000 tokens.
      models: { 'direct/small-coder': { contextWindow: 16_000 } },
      autoApprove: 'all',
      home: cwd,
      warn: () => {},
      subagents: { enabled: false },
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'direct', modelId: 'small-coder', maxSteps: 3 },
      sandboxMode: 'off',
    });
    for await (const _event of agent.run('go')) {
      // drain
    }
    return toolMessages.at(-1) ?? '';
  }

  it('keeps a large command output within the model output budget', async () => {
    const seen = await resultSeenByModel('bash', { command: 'seq 1 20000' });

    expect(seen.length).toBeLessThan(2_000 * 4 + 1_000);
    expect(seen).toMatch(/recall\(\{ id: \\+"pr_[0-9a-f]+\\+" \}\)/);
    expect(seen).toContain('output_archived');
  });

  it('leaves a small command output alone', async () => {
    const seen = await resultSeenByModel('bash', { command: 'echo hello' });

    expect(seen).toContain('hello');
    expect(seen).not.toContain('output_archived');
  });
});
