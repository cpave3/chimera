import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LanguageModel, tool } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent';
import { type LifecycleEvent, LifecycleSource } from '../src/lifecycle';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chimera-lifecycle-events-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function textModel(before?: () => void): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => {
      before?.();
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: 'done' },
            { type: 'text-end', id: 'text' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 3, text: 3, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  }) as unknown as LanguageModel;
}

function setup(languageModel = textModel(), maxSteps = 10) {
  const lifecycle = new LifecycleSource();
  const observed: LifecycleEvent[] = [];
  lifecycle.subscribe((event) => {
    observed.push(event);
  });
  const agent = new Agent({
    cwd: home,
    home,
    model: { providerId: 'mock', modelId: 'model', maxSteps },
    languageModel,
    tools: {},
    sandboxMode: 'off',
    contextWindow: 200_000,
    lifecycle,
  });
  return { agent, lifecycle, observed };
}

it('observes appends without mistaking idle or mid-run context for a turn start', async () => {
  let agent: Agent;
  let calls = 0;
  const fixture = setup(
    textModel(() => {
      if (++calls === 1) agent.injectRunMessage('attached while busy', undefined, 'append');
    }),
  );
  agent = fixture.agent;
  await agent.appendMessage('!cmd output');
  await agent.appendMessage('@file contents');
  for await (const _event of agent.run('work')) {
    /* drain */
  }
  await fixture.lifecycle.drain(agent.session.id);
  expect(
    fixture.observed
      .filter((event) => event.type === 'message_appended')
      .map((event) => event.text),
  ).toEqual(['!cmd output', '@file contents', 'attached while busy']);
  expect(
    fixture.observed.filter((event) => event.type === 'user_message').map((event) => event.content),
  ).toEqual(['work']);
});

it.each([
  'stop',
  'error',
  'interrupted',
  'max_steps',
] as const)('captures terminal model, usage and context fill for %s independently of later session state', async (reason) => {
  const languageModel =
    reason === 'error'
      ? new MockLanguageModelV3({
          doStream: async () => {
            throw new Error('invalid api key');
          },
        })
      : textModel();
  const { agent, observed } = setup(
    languageModel as LanguageModel,
    reason === 'max_steps' ? 0 : 10,
  );
  for await (const event of agent.run('work')) {
    if (reason === 'interrupted' && event.type === 'user_message') agent.interrupt();
  }
  const completed = observed.find((event) => event.type === 'run_finished');
  expect(completed).toMatchObject({
    reason,
    model: { providerId: 'mock', modelId: 'model' },
    usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
    contextFill: expect.any(Number),
  });
  if (completed?.type !== 'run_finished') throw new Error('missing completion');
  expect(completed.contextFill).toBeGreaterThan(0);
  if (reason === 'error') expect(completed.error).toBe('invalid api key');
  if (reason === 'stop') expect(completed.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  agent.session.model.modelId = 'changed';
  agent.session.usage.inputTokens = 999;
  expect(completed.model?.modelId).toBe('model');
  expect(completed.usage?.inputTokens).not.toBe(999);
});

it('observes question request and resolution with the same request id', async () => {
  let calls = 0;
  const languageModel = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks:
          ++calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'question',
                  toolName: 'ask_question',
                  input: '{}',
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
      }),
    }),
  }) as unknown as LanguageModel;
  const { agent, lifecycle, observed } = setup(languageModel);
  agent.setTools({
    ask_question: tool({
      inputSchema: z.object({}),
      execute: () =>
        agent.askQuestions({
          requestId: 'question-1',
          questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
        }),
    }),
  });
  lifecycle.subscribe((event) => {
    if (event.type === 'question_request')
      agent.resolveQuestion(event.requestId, {
        status: 'answered',
        answers: [{ question: 'Which?', answer: 'A', custom: false }],
      });
  });
  for await (const _event of agent.run('ask')) {
    /* drain */
  }
  expect(
    observed
      .filter((event) => event.type === 'question_request' || event.type === 'question_resolved')
      .map((event) => ({ type: event.type, requestId: event.requestId })),
  ).toEqual([
    { type: 'question_request', requestId: 'question-1' },
    { type: 'question_resolved', requestId: 'question-1' },
  ]);
});

it('observes background completion even after the turn ended', async () => {
  const { agent, lifecycle, observed } = setup();
  for await (const _event of agent.run('start background work')) {
    /* drain */
  }
  agent.pushEvent({
    type: 'background_process_exited',
    shellId: 'shell_1',
    command: 'work',
    status: 'exited',
    exitCode: 0,
  });
  await lifecycle.drain(agent.session.id);
  expect(observed.at(-1)).toMatchObject({ type: 'background_process_exited', shellId: 'shell_1' });
});
