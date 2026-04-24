import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@chimera/core';
import type { AgentFactory } from '@chimera/server';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandsList } from '../src/commands/commands';
import { runOneShot } from '../src/commands/run';

/**
 * A mock LM that captures the first user message it receives, echoes back a
 * short acknowledgement, and stops.
 */
function capturingModel(captured: { firstUser?: string }): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async (opts: { prompt: unknown }) => {
      if (captured.firstUser === undefined) {
        const prompt = opts.prompt as Array<{
          role: string;
          content: string | Array<{ type: string; text?: string }>;
        }>;
        const firstUser = prompt.find((m) => m.role === 'user');
        if (firstUser) {
          const c = firstUser.content;
          if (typeof c === 'string') {
            captured.firstUser = c;
          } else {
            const textPart = c.find((p) => p.type === 'text');
            captured.firstUser = textPart?.text ?? '';
          }
        }
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'ok.' },
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

describe('chimera run --command E2E', () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-commands-e2e-'));
    workspace = join(home, 'workspace');
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it(
    'expands a .chimera/commands/<name>.md template and sends the expanded body as the first user message',
    { timeout: 20000 },
    async () => {
      await mkdir(join(workspace, '.chimera', 'commands'), { recursive: true });
      await writeFile(
        join(workspace, '.chimera', 'commands', 'summarize.md'),
        '---\ndescription: Summarize something\n---\nSummarize: $ARGUMENTS',
      );

      const captured: { firstUser?: string } = {};
      const factory: AgentFactory = {
        build: async (init) => ({
          agent: new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: capturingModel(captured),
            tools: {},
            sandboxMode: init.sandboxMode,
            home,
          }),
        }),
      };

      const res = await runOneShot({
        prompt: '',
        cwd: workspace,
        home,
        command: 'summarize',
        commandArgs: 'foo',
        factoryOverride: factory,
        modelOverride: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
      });

      expect(res.exitCode).toBe(0);
      expect(captured.firstUser).toBe('Summarize: foo');
    },
  );

  it('exits nonzero on --command with an unknown template name', async () => {
    const res = await runOneShot({
      prompt: '',
      cwd: workspace,
      home,
      command: 'nope',
      factoryOverride: { build: async () => ({ agent: {} as never }) },
      modelOverride: { providerId: 'm', modelId: 'm', maxSteps: 1 },
    });
    expect(res.exitCode).toBe(1);
  });
});

describe('chimera commands list + --no-claude-compat', () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-commands-list-'));
    workspace = join(home, 'workspace');
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('json output includes .claude/commands entries by default and excludes them with --no-claude-compat', async () => {
    await mkdir(join(workspace, '.claude', 'commands'), { recursive: true });
    await writeFile(join(workspace, '.claude', 'commands', 'from-claude.md'), 'x');

    // Capture stdout.
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
      chunks.push(s);
      return true;
    };
    try {
      await runCommandsList({ cwd: workspace, home, json: true });
    } finally {
      (process.stdout as { write: (s: string) => boolean }).write = origWrite;
    }
    const json1 = JSON.parse(chunks.join(''));
    expect(json1.map((c: { name: string }) => c.name)).toContain('from-claude');

    // --no-claude-compat equivalent: claudeCompat = false.
    const chunks2: string[] = [];
    (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
      chunks2.push(s);
      return true;
    };
    try {
      await runCommandsList({
        cwd: workspace,
        home,
        json: true,
        claudeCompat: false,
      });
    } finally {
      (process.stdout as { write: (s: string) => boolean }).write = origWrite;
    }
    const json2 = JSON.parse(chunks2.join(''));
    expect(json2.map((c: { name: string }) => c.name)).not.toContain('from-claude');
  });
});
