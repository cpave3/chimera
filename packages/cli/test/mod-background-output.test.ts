import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '@chimera/server';
import { afterEach, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';
import { ModRuntime } from '../src/mod-runtime';

let root: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
});

function stubModelStartingBackgroundShell(command: string): void {
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    const chunk = (delta: unknown, reason: string | null) =>
      `data: ${JSON.stringify({
        id: 'chat',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [{ index: 0, delta, finish_reason: reason }],
      })}\n\n`;
    const response =
      ++calls === 1
        ? chunk(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: JSON.stringify({ command, run_in_background: true }),
                  },
                },
              ],
            },
            null,
          ) + chunk({}, 'tool_calls')
        : chunk({ role: 'assistant', content: 'started' }, null) + chunk({}, 'stop');
    return new Response(`${response}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

it('delivers a background job output to a mod in order, then its exit, outside the session log', async () => {
  root = await mkdtemp(join(tmpdir(), 'chimera-mod-background-output-'));
  const cwd = join(root, 'cwd');
  const home = join(root, 'home');
  const modDirectory = join(root, 'observer');
  const log = join(root, 'events.jsonl');
  await mkdir(cwd);
  await mkdir(home);
  await mkdir(modDirectory);
  await writeFile(
    join(modDirectory, 'chimera-mod.json'),
    JSON.stringify({ name: 'observer', version: '1', apiVersion: 1, module: 'index.mjs' }),
  );
  await writeFile(
    join(modDirectory, 'index.mjs'),
    `
    import { appendFile } from 'node:fs/promises';
    export function register(on) {
      for (const type of ['background.start', 'background.output', 'background.exit']) {
        on(type, async ($, event) => {
          await appendFile(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
        });
      }
    }
  `,
  );
  const command = 'sleep 1; echo hi; sleep 2; echo bye';
  stubModelStartingBackgroundShell(command);
  const runtime = await ModRuntime.create({ home, modDirs: [modDirectory] });
  const factory = new CliAgentFactory({
    providersConfig: {
      providers: {
        direct: { shape: 'openai', baseUrl: 'https://provider.test/v1', apiKey: 'test' },
      },
    },
    models: { 'direct/coder': { contextWindow: 64_000 } },
    autoApprove: 'all',
    home,
    warn: () => {},
    subagents: { enabled: false },
    mods: runtime.host,
  });
  const registry = new AgentRegistry({
    factory,
    instance: { pid: 1, cwd, version: 'test', sandboxMode: 'off' },
  });
  runtime.bind(registry, 'http://127.0.0.1:1');
  const { sessionId, entry } = await registry.create({
    cwd,
    model: { providerId: 'direct', modelId: 'coder', maxSteps: 5 },
    sandboxMode: 'off',
  });
  const readEvents = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    await registry.run(sessionId, 'start the shell');
    await entry.activeRun;
    const deadline = Date.now() + 10_000;
    while (!(await readEvents()).some((event) => event.type === 'background.exit')) {
      if (Date.now() > deadline) throw new Error('no background.exit');
      await new Promise((r) => setTimeout(r, 50));
    }
    const events = await readEvents();
    expect(events.map((event) => [event.type, event.text ?? null])).toEqual([
      ['background.start', null],
      ['background.output', 'hi\n'],
      ['background.output', 'bye\n'],
      ['background.exit', null],
    ]);
    const jobId = events[0].jobId;
    expect(events).toEqual([
      expect.objectContaining({ sessionId, jobId, command }),
      expect.objectContaining({ sessionId, jobId, stream: 'stdout', seq: 1 }),
      expect.objectContaining({ sessionId, jobId, stream: 'stdout', seq: 2 }),
      expect.objectContaining({ sessionId, jobId, exitCode: 0 }),
    ]);
    expect(entry.bus.snapshot().map((event) => event.type)).not.toContain('BackgroundOutput');
    expect(JSON.stringify(entry.bus.snapshot())).not.toContain('"text":"bye\\n"');
  } finally {
    await registry.delete(sessionId);
    await runtime.shutdown();
  }
}, 20_000);
