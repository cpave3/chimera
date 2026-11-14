import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentRegistry } from '@chimera/server';
import { expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';
import { ModRuntime } from '../src/mod-runtime';

it('retains process handles across a registry session switch and reaps them at shutdown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mod-process-switch-'));
  const folder = join(home, 'helper');
  await mkdir(folder);
  await writeFile(
    join(folder, 'chimera-mod.json'),
    JSON.stringify({ name: 'helper', version: '1', apiVersion: 1, module: 'index.mjs' }),
  );
  const helper = `process.stdin.setEncoding('utf8');
    process.stdin.on('data', text => {
      process.stdout.write(JSON.stringify({pid: process.pid, text}) + '\\n');
    });`;
  await writeFile(
    join(folder, 'index.mjs'),
    `let firstContext, handle, switched;
    export const result = () => switched;
    export const exit = () => handle.exitPromise;
    export const lateSpawn = () => firstContext.process.spawn({argv: ${JSON.stringify([process.execPath, '-e', helper])}});
    export const lateMessage = () => firstContext.message.append('late');
    export const lateTurn = () => firstContext.turn.abort();
    export const lateLog = () => firstContext.ui.log('late', {to: 'scrollback'});
    export function register(on) {
      on('session.start', async ($, event) => {
        if (!handle) {
          firstContext = $;
          handle = $.process.spawn({argv: ${JSON.stringify([process.execPath, '-e', helper])}});
          return;
        }
        switched = (async () => {
          await handle.write('after switch');
          const output = await handle.output[Symbol.asyncIterator]().next();
          return {
            echo: JSON.parse(output.value.text),
            stream: output.value.stream,
            reason: event.reason,
            sessionId: $.session.id,
            parentId: $.session.parentId,
            isSubagent: $.session.isSubagent,
            parentSessionId: event.parentSessionId,
          };
        })();
        await switched;
      });
    }`,
  );
  const runtime = await ModRuntime.create({ modDirs: [folder], home });
  const factory = new CliAgentFactory({
    mods: runtime.host,
    home,
    autoApprove: 'all',
    providersConfig: {
      providers: {
        fixture: {
          shape: 'openai',
          adapter: 'compatible',
          requestProfile: 'openai-chat',
          baseUrl: 'http://127.0.0.1:1/v1',
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
    instance: {
      pid: process.pid,
      cwd: home,
      version: 'test',
      sandboxMode: 'off',
      parentId: 'parent-session',
    },
  });
  runtime.bind(registry, 'http://127.0.0.1:1');
  try {
    expect(runtime.host.mods).toMatchObject([{ status: 'loaded' }]);
    const actions = (await import(
      /* @vite-ignore */ pathToFileURL(join(folder, 'index.mjs')).href
    )) as {
      result(): Promise<{
        echo: { pid: number; text: string };
        stream: string;
        reason: string;
        sessionId: string;
        parentId: string;
        isSubagent: boolean;
        parentSessionId: string;
      }>;
      exit(): Promise<{ code: number | null; signal: string | null }>;
      lateSpawn(): unknown;
      lateMessage(): Promise<void>;
      lateTurn(): void;
      lateLog(): void;
    };
    const init = {
      cwd: home,
      sandboxMode: 'off' as const,
      model: { providerId: 'fixture', modelId: 'test', maxSteps: 2 },
    };
    const first = await registry.create(init);
    expect(await registry.endSession(first.sessionId, 'switch')).toBe(true);
    const second = await registry.create({ ...init, startReason: 'switch' });
    const result = await actions.result();
    expect(result).toMatchObject({
      echo: { text: 'after switch' },
      stream: 'stdout',
      reason: 'switch',
      sessionId: second.sessionId,
      parentId: 'parent-session',
      isSubagent: true,
      parentSessionId: 'parent-session',
    });
    expect(result.echo.pid).toBeGreaterThan(0);
    expect(() => process.kill(result.echo.pid, 0)).not.toThrow();
    for (const action of [
      actions.lateSpawn,
      actions.lateMessage,
      actions.lateTurn,
      actions.lateLog,
    ]) {
      await expect(async () => action()).rejects.toMatchObject({ name: 'SessionEnded' });
    }
    expect(first.entry.agent.snapshot().messages).toEqual([]);
    await registry.endSession(second.sessionId, 'exit');
    await runtime.shutdown();
    expect(await actions.exit()).toMatchObject({ code: null, signal: 'SIGTERM' });
    expect(() => process.kill(result.echo.pid, 0)).toThrow();
  } finally {
    await runtime.shutdown();
    await factory.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
