import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@chimera/core';
import type { AgentFactory } from '@chimera/server';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOneShot } from '../src/commands/run';

function talkingModel(): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'done.' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

describe('chimera run --goal', () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-run-goal-'));
    workspace = join(home, 'workspace');
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** One headless run whose goal checker gives the queued replies, then repeats the last. */
  async function run(replies: Array<string | Error>, goal: string | null = 'all tests pass') {
    const queue = [...replies];
    const asked: string[] = [];
    const factory: AgentFactory = {
      build: async (init) => ({
        agent: new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: talkingModel(),
          tools: {},
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: 200_000,
          goalCheck: {
            maxContinuations: 2,
            ask: async (prompt) => {
              asked.push(prompt.prompt);
              const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
              if (reply instanceof Error) throw reply;
              return reply;
            },
          },
        }),
      }),
    };
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = await runOneShot({
      prompt: 'make the tests pass',
      cwd: workspace,
      home,
      factoryOverride: factory,
      modelOverride: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
      ...(goal === null ? {} : { goal }),
    });
    return { exitCode: result.exitCode, asked, stderr: stderr.join('') };
  }

  const met = '{"result": "met", "reason": "the test run passed"}';
  const notMet = '{"result": "not_met", "reason": "the tests were not run"}';
  const impossible = '{"result": "impossible", "reason": "there is no test command"}';

  it('exits 0 when the goal is met, and says what the checker found', {
    timeout: 20000,
  }, async () => {
    const { exitCode, asked, stderr } = await run([notMet, met]);

    expect(exitCode).toBe(0);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('all tests pass');
    expect(stderr).toContain('[goal] not met (1 of 2): the tests were not run');
    expect(stderr).toContain('[goal] met: the test run passed');
  });

  it('exits 2 when the run ends at the continuation limit', { timeout: 20000 }, async () => {
    const { exitCode, stderr } = await run([notMet]);

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/\[goal\] limit of 2 continuations reached/);
  });

  it('exits 3 when the goal is not possible', { timeout: 20000 }, async () => {
    const { exitCode, stderr } = await run([impossible]);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('[goal] not possible: there is no test command');
  });

  it('exits 1 when the goal could not be checked', { timeout: 20000 }, async () => {
    const { exitCode, stderr } = await run([new Error('503 overloaded')]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/\[goal\] not checked: the checker failed: 503 overloaded/);
  });

  it('asks no checker and exits as before without --goal', { timeout: 20000 }, async () => {
    const { exitCode, asked } = await run([impossible], null);

    expect(exitCode).toBe(0);
    expect(asked).toHaveLength(0);
  });
});
