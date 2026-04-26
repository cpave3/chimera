import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Agent, type ModelConfig } from '@chimera/core';
import { DefaultHookRunner, type HookRunner } from '@chimera/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry, type AgentFactory } from '../src/agent-registry';

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

const model: ModelConfig = { providerId: 'mock', modelId: 'm', maxSteps: 10 };

function makeFactory(home: string, runnerFactory: (sessionId: string, cwd: string) => HookRunner): AgentFactory {
  return {
    build: async (init) => {
      const agent = new Agent({
        cwd: init.cwd,
        model,
        languageModel: quietModel(),
        tools: {} as ToolSet,
        sandboxMode: 'off',
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
