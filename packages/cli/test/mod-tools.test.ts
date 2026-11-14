import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModHost } from '@chimera/mods';
import { AgentRegistry } from '@chimera/server';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chimera-mod-tools-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function run(sources: string[], script?: string) {
  const folders: string[] = [];
  for (const [index, source] of sources.entries()) {
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
    folders.push(folder);
  }
  if (script) {
    const folder = join(home, '.chimera/hooks/PreToolUse');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'guard'), script);
    await chmod(join(folder, 'guard'), 0o755);
  }
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      const first = requests.length === 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = first
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'bash', arguments: JSON.stringify({ command: 'echo original' }) },
              },
            ],
          }
        : { role: 'assistant', content: 'done' };
      for (const [content, reason] of [
        [delta, null],
        [{}, first ? 'tool_calls' : 'stop'],
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: 'reply',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test',
            choices: [{ index: 0, delta: content, finish_reason: reason }],
          })}\n\n`,
        );
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const mods = await ModHost.create({
    folders,
    dataDirectory: join(home, '.chimera/mod-data'),
    sessionContext: () => ({ session: {} }),
  });
  const factory = new CliAgentFactory({
    mods,
    home,
    autoApprove: 'all',
    providersConfig: {
      providers: {
        fixture: {
          shape: 'openai',
          adapter: 'compatible',
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
  try {
    const session = await registry.create({
      cwd: home,
      sandboxMode: 'off',
      model: { providerId: 'fixture', modelId: 'test', maxSteps: 3 },
    });
    await registry.run(session.sessionId, 'do it');
    await registry.get(session.sessionId)!.activeRun;
    return JSON.stringify(requests.at(-1)?.messages.filter((message) => message.role === 'tool'));
  } finally {
    await registry.shutdown('exit');
    await factory.dispose();
    await mods.shutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it('runs mod tool middleware outermost, rewrites arguments, and gives its result/context to the model', async () => {
  const received = await run([
    `export function register(on) { on('tool.call', async ($, event, next) => {
      event.args = {command:'echo rewritten'};
      event.additionalContext = 'extra context';
      const result = await next();
      return {...result, stdout: result.stdout + 'outer'};
    }); }`,
    `export function register(on) { on('tool.call', async ($, event, next) => {
      const result = await next(); return {...result, stdout: result.stdout + 'inner'};
    }); }`,
  ]);
  expect(received).toContain('rewritten');
  expect(received).toContain('innerouter');
  expect(received).toContain('extra context');
  const audit = await readFile(join(home, '.chimera/logs/permission-decisions.jsonl'), 'utf8');
  expect(audit).toContain('echo rewritten');
  expect(audit).not.toContain('echo original');
});

it('rejects a mod rewrite that violates the schema before any permission decision', async () => {
  const received = await run([
    `export function register(on) { on('tool.call', ($, event, next) => {
    event.args = {command:42}; return next();
  }); }`,
  ]);
  expect(received).toMatch(/string|Invalid/);
  await expect(readFile(join(home, '.chimera/logs/permission-decisions.jsonl'))).rejects.toThrow();
});

it('still honors a blocking shell hook after mods pass', async () => {
  const received = await run(
    [`export function register(on) { on('tool.call', ($, event, next) => next()); }`],
    '#!/bin/sh\necho frozen >&2\nexit 2\n',
  );
  expect(received).toContain('frozen');
  expect(received).not.toContain('original\\n');
});
