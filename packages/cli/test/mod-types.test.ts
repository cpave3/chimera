import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runModTypes } from '../src/commands/mod';

it('writes declarations that type-check a mod without runtime Chimera imports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mod-types-'));
  try {
    let declarations = '';
    expect(
      await runModTypes({
        stdout: {
          write: (text: string) => {
            declarations += text;
          },
        },
      }),
    ).toBe(0);
    await writeFile(join(directory, 'chimera-mod.d.ts'), declarations);
    await writeFile(
      join(directory, 'index.mts'),
      `
import type { On, ModTestHarness } from './chimera-mod.js';
export function register(on: On) {
  on('session.start', async ($, event) => {
    const reason: 'new' | 'resume' | 'fork' | 'switch' = event.reason;
    await $.ui.log($.chimera.version + $.api.version + reason, {to: 'debug'});
    await $.prompt.submit({text: 'hello'});
  });
  on('tool.call', async ($, event, next) => {
    event.args = {command: 'echo hello'};
    return next();
  });
  on('permission.request', async ($, event, next) => {
    const requestId: string = event.requestId;
    const sessionId: string = event.sessionId;
    await $.ui.log(sessionId + requestId, {to: 'debug'});
    return next();
  });
  on('question.request', async ($, event) => {
    const requestId: string = event.requestId;
    const sessionId: string = event.sessionId;
    await $.ui.log(sessionId + requestId, {to: 'debug'});
  });
  for (const name of ['permission.resolved', 'question.resolved', 'background.start', 'background.exit', 'agent.spawn', 'agent.finish'] as const) {
    on(name, async ($, event) => {
      const sessionId: string = event.sessionId;
      await $.ui.log(sessionId, {to: 'debug'});
    });
  }
  // @ts-expect-error unknown hook
  on('not.a.hook', () => {});
}
export async function test(harness: ModTestHarness) {
  harness.setResult('prompt.submit', {accepted: true});
  await harness.emit({type: 'session.start', sessionId: 'test', reason: 'new', name: 'test'});
  harness.calls.filter(call => call.path === 'prompt.submit');
}
`,
    );
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          target: 'es2022',
          module: 'nodenext',
          lib: ['es2022', 'dom'],
          types: [],
        },
        files: ['index.mts'],
      }),
    );
    execFileSync(
      process.execPath,
      [resolve('../../node_modules/typescript/bin/tsc'), '-p', join(directory, 'tsconfig.json')],
      { encoding: 'utf8' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
