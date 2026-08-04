import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type AgentEvent, type ModelConfig } from '@chimera/core';
import {
  DefaultHookRunner,
  type FirePayload,
  type HookFireResult,
  type HookRunner,
} from '@chimera/hooks';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentFactory, AgentRegistry } from '../src/agent-registry';

function quietModel(): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
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

function failingModel(message: string): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: new Error(message) },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

const model: ModelConfig = { providerId: 'mock', modelId: 'm', maxSteps: 10 };

function makeFactory(
  home: string,
  runnerFactory: (sessionId: string, cwd: string) => HookRunner,
  languageModel: LanguageModel = quietModel(),
): AgentFactory {
  return {
    build: async (init) => {
      const agent = new Agent({
        cwd: init.cwd,
        model,
        languageModel,
        tools: {} as ToolSet,
        sandboxMode: 'off',
        sessionId: init.requestedSessionId ?? init.sessionId,
        sessionName: init.name,
        home,
        contextWindow: 200_000,
      });
      const hookRunner = runnerFactory(agent.session.id, init.cwd);
      return { agent, hookRunner };
    },
  };
}

describe('hook integration via registry', () => {
  let home: string;
  let cwd: string;
  let projectRoot: string;
  let globalRoot: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'chimera-hook-int-'));
    home = join(root, 'home');
    cwd = join(root, 'cwd');
    globalRoot = join(root, 'global');
    projectRoot = join(cwd, '.chimera', 'hooks');
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  });

  async function dropScript(event: string, name: string, body: string): Promise<string> {
    const dir = join(projectRoot, event);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, body);
    await chmod(path, 0o755);
    return path;
  }

  it('fires SessionCreated for a fresh custom ID with the session name payload', async () => {
    const captured = join(cwd, 'session-created.json');
    await dropScript(
      'SessionCreated',
      'capture.sh',
      `#!/bin/sh
cat > ${JSON.stringify(captured)}
`,
    );
    const registry = new AgentRegistry({
      factory: makeFactory(
        home,
        (sessionId, theCwd) =>
          new DefaultHookRunner({
            sessionId,
            cwd: theCwd,
            globalRoot,
            timeoutMs: 5_000,
            log: () => {},
          }),
      ),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });

    const { sessionId } = await registry.create({
      cwd,
      model,
      sandboxMode: 'off',
      requestedSessionId: 'custom-session',
      name: 'Named session',
    });

    expect(sessionId).toBe('custom-session');
    expect(JSON.parse(await readFile(captured, 'utf8'))).toMatchObject({
      event: 'SessionCreated',
      session_id: 'custom-session',
      cwd,
      session_name: 'Named session',
    });
  });

  it('fires SessionCreated for a fresh generated ID', async () => {
    const captured = join(cwd, 'generated-session-created.json');
    await dropScript(
      'SessionCreated',
      'capture.sh',
      `#!/bin/sh
cat > ${JSON.stringify(captured)}
`,
    );
    const registry = new AgentRegistry({
      factory: makeFactory(
        home,
        (sessionId, theCwd) =>
          new DefaultHookRunner({
            sessionId,
            cwd: theCwd,
            globalRoot,
            timeoutMs: 5_000,
            log: () => {},
          }),
      ),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });

    const { sessionId } = await registry.create({ cwd, model, sandboxMode: 'off' });

    expect(JSON.parse(await readFile(captured, 'utf8'))).toMatchObject({
      event: 'SessionCreated',
      session_id: sessionId,
      cwd,
    });
  });

  it('does not fire SessionCreated when resuming a session', async () => {
    const captured = join(cwd, 'resumed-session-created.json');
    await dropScript(
      'SessionCreated',
      'capture.sh',
      `#!/bin/sh
cat > ${JSON.stringify(captured)}
`,
    );
    const registry = new AgentRegistry({
      factory: makeFactory(
        home,
        (sessionId, theCwd) =>
          new DefaultHookRunner({
            sessionId,
            cwd: theCwd,
            globalRoot,
            timeoutMs: 5_000,
            log: () => {},
          }),
      ),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });

    await registry.create({ cwd, model, sandboxMode: 'off', sessionId: 'resumed-session' });

    await expect(readFile(captured, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs a PostToolUse script when tool_call_result is published, with the expected payload', async () => {
    const captured = join(cwd, 'captured.json');
    await dropScript(
      'PostToolUse',
      'capture.sh',
      `#!/bin/sh
cat > ${JSON.stringify(captured)}
exit 1
`,
    );

    const registry = new AgentRegistry({
      factory: makeFactory(
        home,
        (sessionId, theCwd) =>
          new DefaultHookRunner({
            sessionId,
            cwd: theCwd,
            globalRoot,
            // projectRoot defaults to <cwd>/.chimera/hooks → matches our setup
            timeoutMs: 5_000,
            log: () => {},
          }),
      ),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });
    const { sessionId, entry } = await registry.create({ cwd, model, sandboxMode: 'off' });

    entry.bus.publish({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'bash',
      args: { command: 'echo hi' },
      target: 'host',
    });
    entry.bus.publish({
      type: 'tool_call_result',
      callId: 'c1',
      result: { stdout: 'hi', exitCode: 0 },
      durationMs: 5,
    });

    // Wait for the fire-and-forget hook to land.
    await waitForFile(captured, 2_000);
    const body = JSON.parse(await readFile(captured, 'utf8'));
    expect(body).toMatchObject({
      event: 'PostToolUse',
      session_id: sessionId,
      cwd,
      tool_name: 'bash',
      tool_input: { command: 'echo hi' },
      tool_result: { stdout: 'hi', exitCode: 0 },
    });

    // Session is still operational despite the hook's non-zero exit.
    expect(registry.get(sessionId)).not.toBeNull();
  });

  it('awaits OnError before publishing a terminal model failure', async () => {
    const captured = join(cwd, 'on-error.json');
    const counter = join(cwd, 'on-error-count.txt');
    await writeFile(counter, '');
    await dropScript(
      'OnError',
      'capture.sh',
      `#!/bin/sh
cat > ${JSON.stringify(captured)}
echo "$CHIMERA_EVENT" >> ${JSON.stringify(counter)}
exit 1
`,
    );

    const registry = new AgentRegistry({
      factory: makeFactory(
        home,
        (sessionId, theCwd) =>
          new DefaultHookRunner({
            sessionId,
            cwd: theCwd,
            globalRoot,
            timeoutMs: 5_000,
            log: () => {},
          }),
        failingModel('terminated'),
      ),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });
    const { sessionId, entry } = await registry.create({ cwd, model, sandboxMode: 'off' });
    let terminalEvent: { reason: string; error?: string } | undefined;
    let hookCompletedBeforeTerminalEvent = false;
    entry.bus.subscribe((event) => {
      if (event.type === 'run_finished') {
        terminalEvent = event;
        hookCompletedBeforeTerminalEvent = existsSync(captured);
      }
    });

    expect(await registry.run(sessionId, 'fail')).toBe('queued');
    await entry.activeRun;

    expect(hookCompletedBeforeTerminalEvent).toBe(true);
    expect(terminalEvent).toMatchObject({ reason: 'error', error: 'terminated' });
    expect(JSON.parse(await readFile(captured, 'utf8'))).toMatchObject({
      event: 'OnError',
      session_id: sessionId,
      cwd,
      error: 'terminated',
    });
    expect((await readFile(counter, 'utf8')).trim().split('\n')).toEqual(['OnError']);
  });

  it('fires OnError once when the agent iterator throws and preserves the synthesized error', async () => {
    const fired: FirePayload[] = [];
    const hookRunner: HookRunner = {
      async fire(payload): Promise<HookFireResult> {
        fired.push(payload);
        return { blocked: false };
      },
    };
    const registry = new AgentRegistry({
      factory: makeFactory(home, () => hookRunner),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });
    const { sessionId, entry } = await registry.create({ cwd, model, sandboxMode: 'off' });
    entry.agent.run = async function* (): AsyncGenerator<AgentEvent> {
      yield* [];
      throw new Error('iterator failed');
    } as typeof entry.agent.run;

    expect(await registry.run(sessionId, 'fail')).toBe('queued');
    await entry.activeRun;

    expect(fired.filter((payload) => payload.event === 'OnError')).toEqual([
      { event: 'OnError', error: 'iterator failed' },
    ]);
    expect(entry.bus.snapshot().filter((event) => event.type === 'run_finished')).toHaveLength(1);
    expect(entry.bus.snapshot().at(-1)).toMatchObject({
      type: 'run_finished',
      reason: 'error',
      error: 'iterator failed',
    });
  });

  it('publishes the original terminal error when OnError rejects', async () => {
    const fired: FirePayload[] = [];
    const hookRunner: HookRunner = {
      async fire(payload): Promise<HookFireResult> {
        fired.push(payload);
        if (payload.event === 'OnError') throw new Error('notification failed');
        return { blocked: false };
      },
    };
    const registry = new AgentRegistry({
      factory: makeFactory(home, () => hookRunner),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });
    const { sessionId, entry } = await registry.create({ cwd, model, sandboxMode: 'off' });
    entry.agent.run = async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'run_finished', reason: 'error', error: 'terminated' };
    } as typeof entry.agent.run;

    expect(await registry.run(sessionId, 'fail')).toBe('queued');
    await entry.activeRun;

    expect(fired).toContainEqual({ event: 'OnError', error: 'terminated' });
    expect(entry.bus.snapshot().at(-1)).toMatchObject({
      type: 'run_finished',
      reason: 'error',
      error: 'terminated',
    });
  });

  it('uses unknown when a terminal error has no text', async () => {
    const fired: FirePayload[] = [];
    const hookRunner: HookRunner = {
      async fire(payload): Promise<HookFireResult> {
        fired.push(payload);
        return { blocked: false };
      },
    };
    const registry = new AgentRegistry({
      factory: makeFactory(home, () => hookRunner),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });
    const { sessionId, entry } = await registry.create({ cwd, model, sandboxMode: 'off' });
    entry.agent.run = async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'run_finished', reason: 'error' };
    } as typeof entry.agent.run;

    expect(await registry.run(sessionId, 'fail')).toBe('queued');
    await entry.activeRun;

    expect(fired).toContainEqual({ event: 'OnError', error: 'unknown' });
    expect(entry.bus.snapshot().at(-1)).toMatchObject({ type: 'run_finished', reason: 'error' });
  });

  it.each([
    'stop',
    'max_steps',
    'timeout',
    'interrupted',
  ] as const)('does not fire OnError for %s completion', async (reason) => {
    const fired: FirePayload[] = [];
    const hookRunner: HookRunner = {
      async fire(payload): Promise<HookFireResult> {
        fired.push(payload);
        return { blocked: false };
      },
    };
    const registry = new AgentRegistry({
      factory: makeFactory(home, () => hookRunner),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });
    const { sessionId, entry } = await registry.create({ cwd, model, sandboxMode: 'off' });
    entry.agent.run = async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'run_finished', reason };
    } as typeof entry.agent.run;

    expect(await registry.run(sessionId, 'finish')).toBe('queued');
    await entry.activeRun;

    expect(fired.filter((payload) => payload.event === 'OnError')).toEqual([]);
    expect(entry.bus.snapshot().at(-1)).toMatchObject({ type: 'run_finished', reason });
  });

  it('fires SessionEnd exactly once when a session is deleted', async () => {
    const counter = join(cwd, 'counter.txt');
    await writeFile(counter, '');
    await dropScript(
      'SessionEnd',
      'count.sh',
      `#!/bin/sh
echo end >> ${JSON.stringify(counter)}
exit 0
`,
    );

    const registry = new AgentRegistry({
      factory: makeFactory(
        home,
        (sessionId, theCwd) =>
          new DefaultHookRunner({
            sessionId,
            cwd: theCwd,
            globalRoot,
            timeoutMs: 5_000,
            log: () => {},
          }),
      ),
      instance: { pid: 1, cwd, version: '0.1.0', sandboxMode: 'off' },
    });
    const { sessionId } = await registry.create({ cwd, model, sandboxMode: 'off' });

    const deleted = await registry.delete(sessionId);
    expect(deleted).toBe(true);

    // delete() awaits the SessionEnd fire, so the file should be present already.
    let body = await readFile(counter, 'utf8');
    expect(body.trim()).toBe('end');

    // Double-delete must not fire SessionEnd a second time.
    const deletedAgain = await registry.delete(sessionId);
    expect(deletedAgain).toBe(false);
    body = await readFile(counter, 'utf8');
    expect(body.trim()).toBe('end');
  });
});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error(`timeout waiting for ${path}`);
}
