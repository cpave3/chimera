import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@chimera/core';
import type { AgentFactory } from '@chimera/server';
import { buildTools, LocalExecutor } from '@chimera/tools';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  });

  it('exits 2 when the answer keeps hitting the output limit', { timeout: 20000 }, async () => {
    const cutOffModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'an answer that never finishes' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: { unified: 'length', raw: 'length' },
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;
    const factory: AgentFactory = {
      build: async (init) => ({
        agent: new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: cutOffModel,
          tools: {},
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: 200_000,
        }),
      }),
    };

    const result = await runOneShot({
      prompt: 'write a very long answer',
      cwd: workspace,
      home,
      factoryOverride: factory,
      modelOverride: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
    });

    expect(result.exitCode).toBe(2);
  });

  it('exits 0 when the agent requests user input', { timeout: 20000 }, async () => {
    let agent: Agent;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'request-1',
              toolName: 'request_user_input',
              input: JSON.stringify({ request: 'Run X and paste the output', kind: 'action' }),
            },
            {
              type: 'finish',
              finishReason: 'tool-calls',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;
    const factory: AgentFactory = {
      build: async (init) => {
        const executor = new LocalExecutor({ cwd: init.cwd });
        const built = buildTools({
          sandboxExecutor: executor,
          hostExecutor: executor,
          sandboxMode: 'off',
          requestUserInput: async (request) => agent.requestUserInput(request),
        });
        agent = new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: model,
          tools: built.tools,
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: 200_000,
        });
        return { agent };
      },
    };

    const result = await runOneShot({
      prompt: 'continue',
      cwd: workspace,
      home,
      factoryOverride: factory,
      modelOverride: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
    });

    expect(result.exitCode).toBe(0);
  });

  it('--add-read-path and --add-write-path reach the factory', { timeout: 20000 }, async () => {
    const extraRead = join(home, 'allowed-read');
    const extraWrite = join(home, 'allowed-write');
    await Promise.all([
      mkdir(extraRead, { recursive: true }),
      mkdir(extraWrite, { recursive: true }),
    ]);

    let capturedInit: Parameters<AgentFactory['build']>[0] | undefined;
    const factory: AgentFactory = {
      build: async (init) => {
        capturedInit = init;
        return {
          agent: new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('done.'),
            tools: {},
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          }),
        };
      },
    };

    const result = await runOneShot({
      prompt: 'hi',
      cwd: workspace,
      home,
      factoryOverride: factory,
      modelOverride: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
      additionalReadPaths: [extraRead],
      additionalWritePaths: [extraWrite],
    });
    expect(result.exitCode).toBe(0);
    expect(capturedInit).toBeDefined();
    expect(capturedInit!.additionalReadPaths).toEqual([extraRead]);
    expect(capturedInit!.additionalWritePaths).toEqual([extraWrite]);
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

  describe('what chimera run prints', () => {
    function bashFactory(): AgentFactory {
      return {
        build: async (init) => {
          const executor = new LocalExecutor({ cwd: init.cwd });
          const built = buildTools({
            sandboxExecutor: executor,
            hostExecutor: executor,
            sandboxMode: 'off',
          });
          const agent = new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: bashThenStopModel(
              'printf "one\\ntwo\\nthree\\nfour\\nfive\\n"',
              'All done.',
            ),
            tools: built.tools,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          });
          agent.setToolFormatters(built.formatters);
          return { agent };
        },
      };
    }

    async function captured(json: boolean) {
      const stderr: string[] = [];
      const stdout: string[] = [];
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
      try {
        const result = await runOneShot({
          prompt: 'print five lines',
          cwd: workspace,
          home,
          json,
          factoryOverride: bashFactory(),
          modelOverride: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
        });
        return { exitCode: result.exitCode, stderr: stderr.join(''), stdout: stdout.join('') };
      } finally {
        errSpy.mockRestore();
        outSpy.mockRestore();
      }
    }

    it('prints tool rows on piped stderr in the Ledger layout, without escape codes', {
      timeout: 20000,
    }, async () => {
      const { exitCode, stderr, stdout } = await captured(false);
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain('\x1b');
      const rows = stderr.split('\n');
      const header = rows.findIndex((row) => row.startsWith('   bash  printf'));
      expect(header).toBeGreaterThanOrEqual(0);
      expect(rows[header]).toMatch(/^ {3}bash {2}printf .* {2}\d+\.\ds$/);
      expect(rows.slice(header + 1, header + 5)).toEqual([
        '         one',
        '         two',
        '         three',
        '         … 2 more · ctrl+o',
      ]);
      expect(stdout).toBe('All done.\n');
    });

    it('keeps --json output as one event per line, with no rows on stderr', {
      timeout: 20000,
    }, async () => {
      const { exitCode, stderr, stdout } = await captured(true);
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain('bash  printf');
      const events = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string });
      const types = events.map((event) => event.type);
      expect(types).toContain('tool_call_start');
      expect(types).toContain('tool_call_result');
      expect(types.at(-1)).toBe('run_finished');
      const start = events.find((event) => event.type === 'tool_call_start') as Record<
        string,
        unknown
      >;
      expect(Object.keys(start).sort()).toEqual([
        'args',
        'callId',
        'display',
        'name',
        'target',
        'type',
      ]);
    });
  });
});
