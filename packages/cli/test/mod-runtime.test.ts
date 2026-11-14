import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@chimera/core';
import type { AgentFactory } from '@chimera/server';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { expect, it } from 'vitest';
import { runOneShot } from '../src/commands/run';

it('loads a folder mod in a real run and delivers turn.complete', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mod-run-'));
  try {
    const directory = join(home, 'observer');
    await mkdir(directory);
    await writeFile(
      join(directory, 'chimera-mod.json'),
      JSON.stringify({
        name: 'observer',
        version: '1',
        apiVersion: 1,
        module: 'index.mjs',
      }),
    );
    await writeFile(
      join(directory, 'index.mjs'),
      `
      import {appendFile} from 'node:fs/promises';
      export function register(on) {
        for (const type of ['turn.complete']) {
          on(type, async ($, event) => {
            $.ui.log('observed turn completion', {to: 'debug'});
            await appendFile(${JSON.stringify(join(home, 'received.jsonl'))}, JSON.stringify({
              ...event,
            }) + '\\n');
          });
        }
      }
    `,
    );
    const factory: AgentFactory = {
      build: async (init) => ({
        agent: new Agent({
          cwd: init.cwd,
          model: init.model,
          sandboxMode: 'off',
          home,
          tools: {},
          contextWindow: 200_000,
          languageModel: new MockLanguageModelV3({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'text' },
                  { type: 'text-delta', id: 'text', delta: 'done' },
                  { type: 'text-end', id: 'text' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    };
    const result = await runOneShot({
      prompt: 'hello',
      cwd: home,
      home,
      modDirs: [directory],
      factoryOverride: factory,
      modelOverride: { providerId: 'fixture', modelId: 'model', maxSteps: 2 },
    });
    expect(result.exitCode).toBe(0);
    const events = (await readFile(join(home, 'received.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(events.map((event) => event.type)).toEqual(['turn.complete']);
    expect(events[0]).toMatchObject({ reason: 'stop' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
