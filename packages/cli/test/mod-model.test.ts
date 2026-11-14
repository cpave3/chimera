import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChimeraClient } from '@chimera/client';
import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';
import { ModRuntime } from '../src/mod-runtime';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chimera-mod-model-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function fixture(sources: string[], holdFinish = false) {
  const folders = await Promise.all(
    sources.map(async (source, index) => {
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
      await writeFile(join(folder, 'index.mjs'), source);
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
    instance: { pid: 1, cwd: home, version: 'test', sandboxMode: 'off' },
  });
  runtime.bind(registry, 'http://127.0.0.1:1');
  const { sessionId, entry } = await registry.create({
    cwd: home,
    sandboxMode: 'off',
    model: { providerId: 'fixture', modelId: 'test', maxSteps: 20 },
  });
  const agent = entry.agent;
  return {
    agent,
    registry,
    sessionId,
    entry,
    requests,
    release: () => pendingFinishes.shift()?.(),
    close: async () => {
      for (const finish of pendingFinishes.splice(0)) finish();
      await factory.dispose();
      await runtime.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it('routes each request through ordered mods, exposes usage after live streaming, and leaves the session model unchanged', async () => {
  const received = join(home, 'usage.json');
  const test = await fixture([
    `import {writeFile} from 'node:fs/promises';
    export function register(on) { let calls = 0; on('turn.step', async ($, event, next) => {
      calls++;
      if (calls === 1) { event.model = 'fixture/gpt-5'; event.effort = 'high';
      }
      event.systemPrompt += '\\nouter instruction';
      await next();
      await writeFile(${JSON.stringify(received)}, JSON.stringify(event.usage));
    }); }`,
    `export function register(on) { on('turn.step', async ($, event, next) => {
      event.systemPrompt += '\\ninner instruction'; return next();
    }); }`,
  ]);
  try {
    const events = [];
    for await (const event of test.agent.run('hello')) events.push(event);
    expect(events.filter((event) => event.type === 'run_finished')).toMatchObject([
      { type: 'run_finished', reason: 'stop', model: { providerId: 'fixture', modelId: 'test' } },
    ]);
    expect(test.requests[0]).toMatchObject({ model: 'gpt-5', reasoning_effort: 'high' });
    expect(JSON.stringify(test.requests[0].messages)).toContain(
      'outer instruction\\ninner instruction',
    );
    expect(JSON.parse(await readFile(received, 'utf8'))).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(events.some((event) => event.type === 'assistant_text_delta')).toBe(true);
    expect(test.agent.session.model.modelId).toBe('test');
    for await (const _event of test.agent.run('again')) {
      /* consume */
    }
    expect(test.requests[1].model).toBe('test');
  } finally {
    await test.close();
  }
});

it('drops before a run starts and rewrites accepted prompts without changing prior history', async () => {
  const test = await fixture([
    `export function register(on) {
    on('prompt.submit', ($, event, next) => {
      if (event.text === 'drop me') return {decision:'drop', reason:'filtered'};
      event.text = 'rewritten: ' + event.text;
      return next();
    });
  }`,
  ]);
  try {
    const dropped = [];
    for await (const event of test.agent.run('drop me')) dropped.push(event);
    expect(dropped).toEqual([{ type: 'prompt_dropped', reason: 'filtered' }]);
    expect(test.requests).toHaveLength(0);
    expect(test.agent.session.messages).toEqual([]);
    expect(test.agent.session.status).toBe('idle');
    for await (const _event of test.agent.run('hello')) {
      /* consume */
    }
    expect(JSON.stringify(test.requests[0].messages)).toContain('rewritten: hello');
    for await (const _event of test.agent.run('again', undefined, 'background')) {
      /* consume */
    }
    expect(JSON.stringify(test.requests[1].messages)).toContain('rewritten: again');
    expect(test.agent.session.messages.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'rewritten: hello' },
      { role: 'user', content: 'rewritten: again' },
    ]);
  } finally {
    await test.close();
  }
});

it('HTTP send completes a mod-dropped submission and can submit again', async () => {
  const test = await fixture([
    `export function register(on) {
      on('prompt.submit', ($, event, next) => event.text === 'drop me'
        ? {decision: 'drop', reason: 'filtered'} : next());
    }`,
  ]);
  const server = await startServer({ app: buildApp({ registry: test.registry }) });
  try {
    const client = new ChimeraClient({ baseUrl: server.url });
    const dropped = [];
    for await (const event of client.send(test.sessionId, 'drop me', {
      signal: AbortSignal.timeout(2000),
    })) {
      dropped.push(event);
    }
    expect(dropped).toEqual([{ type: 'prompt_dropped', reason: 'filtered' }]);
    expect(test.requests).toEqual([]);
    expect(await client.getSession(test.sessionId)).toMatchObject({ status: 'idle', messages: [] });

    const accepted = [];
    for await (const event of client.send(test.sessionId, 'hello')) accepted.push(event);
    expect(accepted).toContainEqual({
      type: 'assistant_text_done',
      id: expect.any(String),
      text: 'done',
    });
    expect(accepted.at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' });
  } finally {
    await server.close();
    await test.close();
  }
});

it('continues with the mod stop message and stops retrying at the existing limit', async () => {
  const test = await fixture([
    `export function register(on) {
    on('turn.stop', () => ({decision:'block', reason:'keep checking'}));
  }`,
  ]);
  try {
    await test.registry.run(test.sessionId, 'hello');
    await test.entry.activeRun;
    expect(test.requests).toHaveLength(6);
    expect(JSON.stringify(test.requests[1].messages)).toContain('keep checking');
    expect(
      test.entry.bus.snapshot().filter((event) => event.type === 'run_finished'),
    ).toMatchObject([{ reason: 'max_steps' }]);
  } finally {
    await test.close();
  }
});

it('streams deltas before the request finishes and applies explicit provider options', async () => {
  const usagePath = join(home, 'stream-usage.json');
  const test = await fixture(
    [
      `import {writeFile} from 'node:fs/promises';
    export function register(on) { on('turn.step', async ($, event, next) => {
      event.providerOptions = {chimera: {reasoningEffort: 'low'}};
      await next();
      await writeFile(${JSON.stringify(usagePath)}, JSON.stringify(event.usage));
    }); }
  `,
    ],
    true,
  );
  try {
    for await (const event of test.agent.run('stream it')) {
      if (event.type === 'assistant_text_delta') {
        await expect(readFile(usagePath)).rejects.toThrow();
        test.release();
      }
    }
    expect(test.requests[0]).toMatchObject({ reasoning_effort: 'low' });
    expect(JSON.parse(await readFile(usagePath, 'utf8'))).toMatchObject({ totalTokens: 15 });
  } finally {
    await test.close();
  }
});
