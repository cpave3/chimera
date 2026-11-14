import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModContext, PromptResult } from '@chimera/mod-api';
import { AgentRegistry } from '@chimera/server';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';
import { ModRuntime } from '../src/mod-runtime';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chimera-mod-actions-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function fixture(source = '', holdFinish = false, parentId?: string) {
  const folders = await Promise.all(
    [source].map(async (source, index) => {
      const folder = join(home, `mod-${index}`);
      await mkdir(folder);
      await writeFile(
        join(folder, 'chimera-mod.json'),
        JSON.stringify({
          name: `mod-${index}`,
          version: '1',
          apiVersion: 1,
          module: 'index.mjs',
        }),
      );
      await writeFile(
        join(folder, 'index.mjs'),
        `
        let context;
        export const session = () => context.session;
        export const submit = (text) => context.prompt.submit({text});
        export const append = (text) => context.message.append(text);
        export const abort = () => context.turn.abort();
        export const url = () => context.server.url();
        export function register(on) {
          on('session.start', ($) => { context = $; });
          ${source}
        }
      `,
      );
      return folder;
    }),
  );
  const requests: Array<Record<string, unknown>> = [];
  const pendingFinishes: Array<() => void> = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: 'reply',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(finishReason
            ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }
            : {}),
        })}\n\n`;
      response.write(chunk({ role: 'assistant', content: 'done' }, null));
      const finish = () => {
        response.write(chunk({}, 'stop'));
        response.end('data: [DONE]\n\n');
      };
      if (holdFinish) pendingFinishes.push(finish);
      else finish();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const runtime = await ModRuntime.create({ modDirs: folders, home });
  const mods = runtime.host;
  const factory = new CliAgentFactory({
    mods,
    home,
    autoApprove: 'all',
    providersConfig: {
      providers: {
        fixture: {
          shape: 'openai',
          adapter: 'compatible',
          requestProfile: 'openai-chat',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'test',
        },
      },
    },
    subagents: { enabled: false },
    diagnostics: { enabled: false },
  });
  const registry = new AgentRegistry({
    factory,
    home,
    instance: { pid: 1, cwd: home, version: 'test', sandboxMode: 'off', parentId },
  });
  runtime.bind(registry, 'http://127.0.0.1:1');
  const { sessionId, entry } = await registry.create({
    cwd: home,
    sandboxMode: 'off',
    model: { providerId: 'fixture', modelId: 'test', maxSteps: 20 },
  });
  const agent = entry.agent;
  const actions = (await import(
    /* @vite-ignore */ pathToFileURL(join(folders[0], 'index.mjs')).href
  )) as {
    session(): ModContext['session'];
    submit(text: string): Promise<PromptResult>;
    append(text: string): Promise<void>;
    abort(): Promise<void>;
    url(): string;
  };
  return {
    agent,
    actions,
    runtime,
    registry,
    sessionId,
    entry,
    requests,
    release: () => pendingFinishes.shift()?.(),
    close: async () => {
      for (const finish of pendingFinishes.splice(0)) finish();
      entry.agent.interrupt();
      await entry.activeRun;
      await factory.dispose();
      await runtime.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it('queues a mod prompt during a model request and resolves on start, not completion', async () => {
  const test = await fixture('', true);
  try {
    await test.registry.run(test.sessionId, 'first');
    await expect.poll(() => test.requests.length).toBe(1);
    let result: PromptResult | undefined;
    const submitted = test.actions.submit('second').then((value) => {
      result = value;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(result).toBeUndefined();
    expect(test.requests).toHaveLength(1);
    test.release();
    await submitted;
    expect(result).toEqual({ queued: true });
    await expect.poll(() => test.requests.length).toBe(2);
    expect(test.entry.runActive).toBe(true);
    expect(test.agent.snapshot().messages.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
    test.release();
    await test.entry.activeRun;
  } finally {
    await test.close();
  }
});

it('reports accepted and filtered prompts exactly, without starting a dropped turn', async () => {
  const test = await fixture(
    `on('prompt.submit', ($, event, next) => {
    if (event.text === 'filtered') return { decision: 'drop', reason: 'policy' };
    return next();
  });`,
    true,
  );
  try {
    expect(await test.actions.submit('filtered')).toEqual({ dropped: true, reason: 'policy' });
    expect(test.requests).toHaveLength(0);
    expect(test.agent.snapshot().messages).toEqual([]);
    await test.entry.activeRun;
    expect(await test.actions.submit('accepted')).toEqual({ accepted: true });
    await expect.poll(() => test.requests.length).toBe(1);
    expect(test.entry.runActive).toBe(true);
    test.release();
    await test.entry.activeRun;
    expect(
      test.entry.bus.snapshot().filter((event) => event.type === 'prompt_dropped'),
    ).toMatchObject([{ type: 'prompt_dropped', reason: 'policy' }]);
    expect(
      test.entry.bus.snapshot().filter((event) => event.type === 'user_message'),
    ).toMatchObject([{ type: 'user_message', content: 'accepted', source: 'user' }]);
  } finally {
    await test.close();
  }
});

it('allows turn.complete to await the next prompt starting without a lifecycle wait cycle', async () => {
  const received = join(home, 'complete-result.json');
  const test = await fixture(`let completed = 0;
    on('turn.complete', async ($) => {
      if (completed++ === 0) {
        const result = await $.prompt.submit({text: 'follow-up'});
        const {writeFile} = await import('node:fs/promises');
        await writeFile(${JSON.stringify(received)}, JSON.stringify(result));
      }
    });`);
  try {
    await test.registry.run(test.sessionId, 'first');
    await expect
      .poll(async () => JSON.parse(await readFile(received, 'utf8')))
      .toEqual({ accepted: true });
    await expect.poll(() => test.requests.length).toBe(2);
    await expect.poll(() => test.entry.runActive).toBe(false);
    expect(test.agent.snapshot().messages.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'follow-up' },
    ]);
  } finally {
    await test.close();
  }
});

it('appends idle context without a model request or turn.start', async () => {
  const turns = join(home, 'turns');
  const test = await fixture(`on('turn.start', async () => {
    const {appendFile} = await import('node:fs/promises');
    await appendFile(${JSON.stringify(turns)}, 'start\\n');
  });`);
  try {
    await test.actions.append('context only');
    expect(test.agent.snapshot().messages).toEqual([{ role: 'user', content: 'context only' }]);
    expect(test.agent.snapshot().status).toBe('idle');
    expect(test.requests).toHaveLength(0);
    expect(test.entry.runActive).toBe(false);
    await expect(readFile(turns)).rejects.toThrow();
    await test.actions.submit('now act');
    await expect.poll(() => test.requests.length).toBe(1);
    await test.entry.activeRun;
    expect(JSON.stringify(test.requests[0].messages)).toContain('context only');
    await expect.poll(() => readFile(turns, 'utf8')).toBe('start\n');
  } finally {
    await test.close();
  }
});

it('aborts an in-flight turn as interrupted', async () => {
  const test = await fixture('', true);
  try {
    await test.registry.run(test.sessionId, 'working');
    await expect.poll(() => test.requests.length).toBe(1);
    await test.actions.abort();
    await test.entry.activeRun;
    expect(
      test.entry.bus.snapshot().filter((event) => event.type === 'run_finished'),
    ).toMatchObject([{ reason: 'interrupted' }]);
    expect(test.agent.snapshot().status).toBe('idle');
  } finally {
    await test.close();
  }
});

it.each([
  undefined,
  'parent-session',
])('exposes read-only session snapshots (parent %s)', async (parentId) => {
  const test = await fixture('', false, parentId);
  try {
    const snapshot = test.actions.session();
    expect(snapshot).toMatchObject({
      id: test.sessionId,
      cwd: home,
      status: 'idle',
      parentId: parentId ?? null,
      isSubagent: !!parentId,
      model: { providerId: 'fixture', modelId: 'test', maxSteps: 20 },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, stepCount: 0 },
    });
    expect(snapshot.name).toBeUndefined();
    expect(test.actions.url()).toBe('http://127.0.0.1:1');
    expect(Reflect.set(snapshot, 'cwd', '/changed')).toBe(false);
    expect(Reflect.set(snapshot.model, 'modelId', 'changed')).toBe(false);
    expect(Reflect.set(snapshot.usage, 'totalTokens', 999)).toBe(false);
    await test.actions.append('saved');
    const messages = snapshot.messages();
    expect(messages).toEqual([{ role: 'user', content: 'saved' }]);
    expect(Reflect.set(messages[0], 'content', 'changed')).toBe(false);
    expect(Reflect.set(messages, '0', { role: 'user', content: 'changed' })).toBe(false);
    expect(test.agent.snapshot().messages).toEqual([{ role: 'user', content: 'saved' }]);
  } finally {
    await test.close();
  }
});

it('rejects retained session calls after session.end with SessionEnded', async () => {
  const test = await fixture();
  try {
    const snapshot = test.actions.session();
    await test.registry.endSession(test.sessionId, 'switch');
    await expect(async () => test.actions.submit('late')).rejects.toMatchObject({
      name: 'SessionEnded',
    });
    await expect(async () => test.actions.append('late')).rejects.toMatchObject({
      name: 'SessionEnded',
    });
    expect(() => test.actions.abort()).toThrowError('Session ended');
    expect(() => snapshot.messages()).toThrowError('Session ended');
    expect(test.requests).toHaveLength(0);
  } finally {
    await test.close();
  }
});

it('rejects a queued prompt if its session ends before it starts, without leaking a rejection', async () => {
  const test = await fixture('', true);
  try {
    await test.registry.run(test.sessionId, 'first');
    await expect.poll(() => test.requests.length).toBe(1);
    const submitted = test.actions.submit('too late');
    const rejected = expect(submitted).rejects.toMatchObject({ name: 'SessionEnded' });
    await test.registry.endSession(test.sessionId, 'switch');
    test.agent.interrupt();
    await rejected;
    expect(test.requests).toHaveLength(1);
  } finally {
    await test.close();
  }
});

it('reports a queued prompt filtered after the active turn ends as dropped, not queued', async () => {
  const test = await fixture(
    `on('prompt.submit', ($, event, next) => {
    if (event.text === 'filtered later') return {decision: 'drop', reason: 'later policy'};
    return next();
  });`,
    true,
  );
  try {
    await test.registry.run(test.sessionId, 'first');
    await expect.poll(() => test.requests.length).toBe(1);
    const submitted = test.actions.submit('filtered later');
    test.release();
    expect(await submitted).toEqual({ dropped: true, reason: 'later policy' });
    await test.entry.activeRun;
    expect(test.requests).toHaveLength(1);
    expect(test.agent.snapshot().messages.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'first' },
    ]);
  } finally {
    await test.close();
  }
});

it('serializes multiple mod submissions into separate operator turns in FIFO order', async () => {
  const test = await fixture('', true);
  try {
    const first = test.actions.submit('first');
    const second = test.actions.submit('second');
    const third = test.actions.submit('third');
    expect(await first).toEqual({ accepted: true });
    await expect.poll(() => test.requests.length).toBe(1);
    test.release();
    expect(await second).toEqual({ queued: true });
    await expect.poll(() => test.requests.length).toBe(2);
    test.release();
    expect(await third).toEqual({ queued: true });
    await expect.poll(() => test.requests.length).toBe(3);
    test.release();
    await test.entry.activeRun;
    expect(
      test.entry.bus.snapshot().filter((event) => event.type === 'user_message'),
    ).toMatchObject([
      { content: 'first', source: 'user' },
      { content: 'second', source: 'user' },
      { content: 'third', source: 'user' },
    ]);
  } finally {
    await test.close();
  }
});

it('allows session.start to await an accepted prompt before the model finishes', async () => {
  const received = join(home, 'start-result.json');
  const test = await fixture(
    `on('session.start', async ($) => {
    const result = await $.prompt.submit({text: 'from startup'});
    const {writeFile} = await import('node:fs/promises');
    await writeFile(${JSON.stringify(received)}, JSON.stringify(result));
  });`,
    true,
  );
  try {
    expect(JSON.parse(await readFile(received, 'utf8'))).toEqual({ accepted: true });
    await expect.poll(() => test.requests.length).toBe(1);
    expect(test.entry.runActive).toBe(true);
    test.release();
    await test.entry.activeRun;
  } finally {
    await test.close();
  }
});
