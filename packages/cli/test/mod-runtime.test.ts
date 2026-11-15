import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@chimera/core';
import { type AgentFactory, AgentRegistry } from '@chimera/server';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { expect, it } from 'vitest';
import { runOneShot } from '../src/commands/run';
import { ModRuntime } from '../src/mod-runtime';

it('preserves exact child and parent tool identities in mod lifecycle events', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mod-child-'));
  const directory = join(home, 'observer');
  await mkdir(directory);
  await writeFile(
    join(directory, 'chimera-mod.json'),
    JSON.stringify({ name: 'observer', version: '1', apiVersion: 1, module: 'index.mjs' }),
  );
  await writeFile(
    join(directory, 'index.mjs'),
    `
    import { appendFile } from 'node:fs/promises';
    export function register(on) {
      for (const type of ['agent.spawn', 'agent.finish']) on(type, async ($, event) => {
        await appendFile(${JSON.stringify(join(home, 'events'))}, JSON.stringify(event) + '\\n');
      });
    }
  `,
  );
  const runtime = await ModRuntime.create({ home, modDirs: [directory] });
  const factory: AgentFactory = {
    build: async (init) => ({
      agent: new Agent({
        cwd: home,
        model: init.model,
        sandboxMode: 'off',
        home,
        tools: {},
        contextWindow: 200_000,
        languageModel: new MockLanguageModelV3(),
      }),
    }),
  };
  const registry = new AgentRegistry({
    factory,
    instance: { pid: 1, cwd: home, version: 'test', sandboxMode: 'off' },
  });
  runtime.bind(registry, 'http://127.0.0.1:1234');
  try {
    const { sessionId, entry } = await registry.create({
      cwd: home,
      model: { providerId: 'test', modelId: 'test', maxSteps: 1 },
      sandboxMode: 'off',
    });
    entry.agent.pushEvent({
      type: 'subagent_spawned',
      subagentId: 'child',
      parentCallId: 'call',
      childSessionId: 'child-session',
      purpose: 'check',
      background: true,
      url: 'http://127.0.0.1:1234',
    });
    entry.agent.pushEvent({
      type: 'subagent_finished',
      subagentId: 'child',
      parentCallId: 'call',
      reason: 'stop',
      result: 'done',
      background: true,
    });
    await entry.agent.lifecycle.drain(sessionId);
    const events = (await readFile(join(home, 'events'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'agent.spawn',
        parentCallId: 'call',
        childSessionId: 'child-session',
      }),
      expect.objectContaining({
        type: 'agent.finish',
        parentCallId: 'call',
        childSessionId: 'child-session',
      }),
    ]);
    await registry.delete(sessionId);
  } finally {
    await runtime.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

it('loads a mod folder in a real run and delivers lifecycle plus a usable server URL', async () => {
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
        for (const type of ['session.start','turn.start','turn.complete','session.end']) {
          on(type, async ($, event) => {
            const serverUrl = $.server.url();
            if (type === 'session.start') {
              const response = await $.http.fetch(serverUrl + '/v1/instance');
              if (!response.ok) throw new Error('server URL unavailable');
            }
            await appendFile(${JSON.stringify(join(home, 'received.jsonl'))}, JSON.stringify({
              ...event, serverUrl, cwd: $.session.cwd, version: $.chimera.version,
              apiVersion: $.api.version,
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
    expect(events.map((event) => event.type)).toEqual([
      'session.start',
      'turn.start',
      'turn.complete',
      'session.end',
    ]);
    expect(events[0]).toMatchObject({ reason: 'new', cwd: home, apiVersion: 1 });
    expect(events[2]).toMatchObject({ reason: 'stop' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
