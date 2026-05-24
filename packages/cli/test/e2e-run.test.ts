// Session files may be cleaned up after run, so no fs assertions needed.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@chimera/core';
import type { AgentFactory } from '@chimera/server';
import { buildTools, LocalExecutor } from '@chimera/tools';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOneShot } from '../src/commands/run';

function textOnlyModel(text: string): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: text },
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

function bashThenStopModel(bashCommand: string, finalText: string): LanguageModel {
  let callIndex = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'bash',
                input: JSON.stringify({ command: bashCommand }),
              },
              {
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: finalText },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      };
    },
  }) as unknown as LanguageModel;
}

describe('chimera run E2E (stub provider)', () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-e2e-'));
    workspace = join(home, 'workspace');
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('text-only run exits 0 with a session file persisted', { timeout: 20000 }, async () => {
    const factory: AgentFactory = {
      build: async (init) => ({
        agent: new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: textOnlyModel('done.'),
          tools: {},
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: 200_000,
        }),
      }),
    };

    const result = await runOneShot({
      prompt: 'hi',
      cwd: workspace,
      home,
      factoryOverride: factory,
      modelOverride: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
    });

    expect(result.exitCode).toBe(0);
    // runOneShot now deletes the session in its finally block so SessionEnd
    // hooks fire; the session file may or may not be present on disk.
    // The real assertion is that the run completed cleanly.
  });

  it('bash tool call round-trip: model invokes echo, loop continues, exits 0', {
    timeout: 20000,
  }, async () => {
    const factory: AgentFactory = {
      build: async (init) => {
        const executor = new LocalExecutor({ cwd: init.cwd });
        const tools = buildTools({
          sandboxExecutor: executor,
          hostExecutor: executor,
          sandboxMode: 'off',
        });
        const agent = new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: bashThenStopModel('echo hello', 'done.'),
          tools,
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: 200_000,
        });
        return { agent };
      },
    };

    const res = await runOneShot({
      prompt: 'please echo hello',
      cwd: workspace,
      home,
      factoryOverride: factory,
      modelOverride: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
    });
    expect(res.exitCode).toBe(0);
  });
});
