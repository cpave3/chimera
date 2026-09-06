import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type AgentEventEnvelope, type ModelConfig } from '@chimera/core';
import { buildTools, LocalExecutor } from '@chimera/tools';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../src/agent-registry';
import { buildApp } from '../src/app';

const model: ModelConfig = { providerId: 'mock', modelId: 'bash-lifecycle', maxSteps: 5 };

function commandModel(command: string, timeoutMs?: number) {
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const firstCall = calls++ === 0;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...(firstCall
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'bash-1',
                    toolName: 'bash',
                    input: JSON.stringify({ command, timeout_ms: timeoutMs }),
                  },
                ]
              : [
                  { type: 'text-start' as const, id: 'reply' },
                  { type: 'text-delta' as const, id: 'reply', delta: 'Ready for another prompt.' },
                  { type: 'text-end' as const, id: 'reply' },
                ]),
            {
              type: 'finish',
              finishReason: { unified: firstCall ? 'tool-calls' : 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  });
}

describe('host bash interruption through HTTP', () => {
  let home: string;
  let registry: AgentRegistry | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-bash-http-'));
    registry = undefined;
    await writeFile(
      join(home, 'child.cjs'),
      `const fs = require('node:fs');
process.on('SIGTERM', () => {
  fs.writeFileSync('term.received', 'yes');
  if (!process.argv.includes('--ignore-term')) process.exit(0);
});
setTimeout(() => process.exit(0), 10000);
fs.writeFileSync('child.pid', String(process.pid));
`,
    );
  });

  afterEach(async () => {
    for (const file of ['child.pid', 'shell.pid']) {
      try {
        process.kill(Number(await readFile(join(home, file), 'utf8')), 'SIGKILL');
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    for (const session of registry?.list() ?? []) await registry!.delete(session.id);
    await rm(home, { recursive: true, force: true });
  });

  async function start(command: string, timeoutMs?: number) {
    const executor = new LocalExecutor({ cwd: home });
    registry = new AgentRegistry({
      factory: {
        build: async () => ({
          agent: new Agent({
            cwd: home,
            home,
            model,
            languageModel: commandModel(command, timeoutMs),
            tools: buildTools({
              hostExecutor: executor,
              sandboxExecutor: executor,
              sandboxMode: 'off',
            }).tools,
            sandboxMode: 'off',
            contextWindow: 200_000,
          }),
        }),
      },
      instance: { pid: process.pid, cwd: home, version: 'test', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const createResponse = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: home, model, sandboxMode: 'off' }),
    });
    expect(createResponse.status).toBe(201);
    const { sessionId } = await createResponse.json();
    const send = () =>
      app.request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Run the command, then reply.' }),
      });
    const events: AgentEventEnvelope[] = [];
    registry.get(sessionId)!.bus.subscribe((event) => events.push(event));
    expect((await send()).status).toBe(202);
    return { app, sessionId, events, send };
  }

  it.each([
    'after shell exit',
    'during timeout cleanup',
  ] as const)('interrupts %s and accepts another prompt in the same session', async (phase) => {
    const afterTimeout = phase === 'during timeout cleanup';
    const { app, sessionId, events, send } = await start(
      `echo $$ > shell.pid; "${process.execPath}" child.cjs ${afterTimeout ? '--ignore-term' : ''} &`,
      afterTimeout ? 2000 : undefined,
    );
    await vi.waitFor(
      async () =>
        expect(Number(await readFile(join(home, 'child.pid'), 'utf8'))).toBeGreaterThan(0),
      { timeout: 2000, interval: 10 },
    );
    if (afterTimeout) {
      await vi.waitFor(
        async () => expect(await readFile(join(home, 'term.received'), 'utf8')).toBe('yes'),
        { timeout: 2000, interval: 10 },
      );
    } else {
      const shellPid = Number(await readFile(join(home, 'shell.pid'), 'utf8'));
      await vi.waitFor(() => expect(() => process.kill(shellPid, 0)).toThrow(), {
        timeout: 2000,
        interval: 10,
      });
    }
    expect(events.at(-1)?.type).toBe('tool_call_start');
    const interruptResponse = await app.request(`/v1/sessions/${sessionId}/interrupt`, {
      method: 'POST',
    });
    expect(interruptResponse.status).toBe(204);
    await vi.waitFor(
      () => expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'interrupted' }),
      { timeout: 3000, interval: 10 },
    );

    expect((await send()).status).toBe(202);
    await vi.waitFor(
      () => expect(events.filter((event) => event.type === 'run_finished')).toHaveLength(2),
      { timeout: 2000, interval: 10 },
    );
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'assistant_text_done', text: 'Ready for another prompt.' }),
    );
  });

  it('returns a timed-out tool result and lets the model continue without interruption', async () => {
    const { events } = await start(`echo $$ > shell.pid; "${process.execPath}" child.cjs &`, 2000);
    await vi.waitFor(
      async () => expect(await readFile(join(home, 'term.received'), 'utf8')).toBe('yes'),
      { timeout: 3000, interval: 10 },
    );
    await vi.waitFor(
      () => expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' }),
      { timeout: 3000, interval: 10 },
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_call_result',
        result: expect.objectContaining({ timed_out: true, exit_code: -1 }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'assistant_text_done', text: 'Ready for another prompt.' }),
    );
  });
});
