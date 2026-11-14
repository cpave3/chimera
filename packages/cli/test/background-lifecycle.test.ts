import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LifecycleEvent } from '@chimera/core';
import { AgentRegistry, buildApp } from '@chimera/server';
import { afterEach, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';

let root: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
});

it('publishes a real background shell start on SSE and its late exit on the lifecycle source', async () => {
  root = await mkdtemp(join(tmpdir(), 'chimera-background-lifecycle-'));
  const cwd = join(root, 'cwd');
  const home = join(root, 'home');
  await mkdir(cwd);
  await mkdir(home);
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
                    arguments: JSON.stringify({ command: 'sleep 0.2', run_in_background: true }),
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
  });
  const registry = new AgentRegistry({
    factory,
    instance: { pid: 1, cwd, version: 'test', sandboxMode: 'off' },
  });
  const { sessionId, entry } = await registry.create({
    cwd,
    model: { providerId: 'direct', modelId: 'coder', maxSteps: 5 },
    sandboxMode: 'off',
  });
  const observed: LifecycleEvent[] = [];
  let onExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    onExit = resolve;
  });
  const unsubscribe = entry.agent.lifecycle.subscribe((event) => {
    if (event.sessionId !== sessionId) return;
    observed.push(event);
    if (event.type === 'background_process_exited') onExit();
  });
  try {
    await registry.run(sessionId, 'start the shell');
    await entry.activeRun;
    await exited;
    const started = observed.find((event) => event.type === 'background_process_started');
    const completed = observed.find((event) => event.type === 'background_process_exited');
    expect(started).toMatchObject({ command: 'sleep 0.2', shellId: expect.any(String) });
    expect(completed).toMatchObject({
      command: 'sleep 0.2',
      shellId: started && 'shellId' in started ? started.shellId : undefined,
      status: 'exited',
      exitCode: 0,
    });
    expect(observed.findIndex((event) => event.type === 'run_finished')).toBeLessThan(
      observed.findIndex((event) => event.type === 'background_process_exited'),
    );
    const app = buildApp({ registry, home });
    const response = await app.request(
      `/v1/sessions/${sessionId}/events?since=${entry.bus.snapshot()[0]!.eventId}`,
    );
    const reader = response.body!.getReader();
    try {
      let received = '';
      while (!received.includes('"type":"background_process_started"')) {
        const { value, done } = await reader.read();
        if (done) break;
        received += new TextDecoder().decode(value);
      }
      expect(received).toContain('"type":"background_process_started"');
      expect(received).toContain('sleep 0.2');
    } finally {
      await reader.cancel();
    }
  } finally {
    unsubscribe();
    await registry.delete(sessionId);
    await factory.dispose();
  }
});
