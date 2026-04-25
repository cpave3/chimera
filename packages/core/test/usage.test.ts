import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent';
import type { AgentEvent } from '../src/events';
import { newSessionId } from '../src/ids';
import { emptyUsage, type ModelConfig, type Session, type Usage } from '../src/types';

function makeModel(): ModelConfig {
  return { providerId: 'mock', modelId: 'm', maxSteps: 10 };
}

interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

function v3Usage(step: StepUsage) {
  // LanguageModelV3Usage shape (model-level). The SDK transforms this into
  // the flat LanguageModelUsage shape on `streamText`'s `fullStream`.
  const inputTotal = step.inputTokens ?? 0;
  const outputTotal = step.outputTokens ?? 0;
  const cacheRead = step.cachedInputTokens ?? 0;
  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal - cacheRead,
      cacheRead,
      cacheWrite: 0,
    },
    outputTokens: {
      total: outputTotal,
      text: outputTotal,
      reasoning: 0,
    },
  };
}

function singleStepModel(opts: { step: StepUsage }): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'hi' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: v3Usage(opts.step),
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

function modelWithoutUsage(): LanguageModel {
  // A model finish with no `usage` field at all.
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'hi' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop' },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

describe('Agent usage tracking', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-usage-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('emits usage_updated with cumulative totals after a step with usage', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: singleStepModel({
        step: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      }),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('hi')) events.push(ev);

    const usageEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: 'usage_updated' }> =>
        e.type === 'usage_updated',
    );
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    const first = usageEvents[0];
    expect(first.usage.totalTokens).toBe(1200);
    expect(first.usage.inputTokens).toBe(1000);
    expect(first.usage.outputTokens).toBe(200);
    expect(first.usage.stepCount).toBe(1);
    expect(first.usage.lastStep?.totalTokens).toBe(1200);
    expect(first.contextWindow).toBe(200_000);
    expect(first.usedContextTokens).toBe(1000);
    expect(agent.session.usage.totalTokens).toBe(1200);
  });

  it('accumulates cached input tokens when reported', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: singleStepModel({
        step: {
          inputTokens: 1000,
          outputTokens: 100,
          cachedInputTokens: 800,
          totalTokens: 1100,
        },
      }),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    for await (const _ of agent.run('go')) {
      /* drain */
    }
    expect(agent.session.usage.cachedInputTokens).toBe(800);
    expect(agent.session.usage.inputTokens).toBe(1000);
  });

  it('emits no usage_updated and does not increment counters when usage is absent', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: modelWithoutUsage(),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('go')) events.push(ev);
    expect(events.find((e) => e.type === 'usage_updated')).toBeUndefined();
    expect(agent.session.usage.totalTokens).toBe(0);
    expect(agent.session.usage.stepCount).toBe(0);
  });

  it('does not emit a reconciliation event when totalUsage agrees with per-step sum', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: singleStepModel({
        step: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      }),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('hi')) events.push(ev);
    const usageEvents = events.filter((e) => e.type === 'usage_updated');
    expect(usageEvents.length).toBe(1);
  });

  it('emits a snapshot usage_updated immediately after session_started for resumed sessions with prior usage', async () => {
    const sessionId = newSessionId();
    const priorUsage: Usage = {
      inputTokens: 5000,
      outputTokens: 1500,
      cachedInputTokens: 0,
      totalTokens: 6500,
      stepCount: 4,
      lastStep: {
        inputTokens: 1500,
        outputTokens: 200,
        cachedInputTokens: 0,
        totalTokens: 1700,
      },
    };
    const session: Session = {
      id: sessionId,
      cwd: '/tmp',
      createdAt: 1,
      messages: [],
      toolCalls: [],
      status: 'idle',
      model: makeModel(),
      sandboxMode: 'off',
      usage: priorUsage,
    };

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: singleStepModel({
        step: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      session,
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('continue')) events.push(ev);

    // Find indices: session_started -> usage_updated (snapshot) -> ... -> usage_updated (post-step)
    const startedIdx = events.findIndex((e) => e.type === 'session_started');
    const firstUsageIdx = events.findIndex((e) => e.type === 'usage_updated');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(firstUsageIdx).toBeGreaterThan(startedIdx);
    // Snapshot must precede any text deltas.
    const firstDeltaIdx = events.findIndex((e) => e.type === 'assistant_text_delta');
    expect(firstUsageIdx).toBeLessThan(firstDeltaIdx);

    const snapshot = events[firstUsageIdx] as Extract<
      AgentEvent,
      { type: 'usage_updated' }
    >;
    expect(snapshot.usage.totalTokens).toBe(6500);
    expect(snapshot.usedContextTokens).toBe(1500); // lastStep.inputTokens
  });

  it('does not emit a snapshot usage_updated for a fresh zero-usage session', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: singleStepModel({
        step: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('hi')) events.push(ev);

    // The first usage_updated should land *after* the first text delta
    // (i.e. only the post-step event, no leading snapshot).
    const firstUsageIdx = events.findIndex((e) => e.type === 'usage_updated');
    const firstDeltaIdx = events.findIndex((e) => e.type === 'assistant_text_delta');
    expect(firstUsageIdx).toBeGreaterThan(firstDeltaIdx);
  });

  it('default-initializes session.usage on a fresh agent', () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: modelWithoutUsage(),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    expect(agent.session.usage).toEqual(emptyUsage());
  });
});
