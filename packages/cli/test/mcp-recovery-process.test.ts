import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const children: ChildProcess[] = [];
let home: string;
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  if (home) await rm(home, { recursive: true, force: true });
});

it.each([
  'exit',
  'oversized response',
])('built agent recovers from %s through the registered MCP tool without replay', async (failure) => {
  home = await mkdtemp(join(tmpdir(), 'chimera-mcp-recovery-process-'));
  const cwd = join(home, 'workspace');
  await mkdir(cwd);
  await mkdir(join(home, '.chimera'));
  const script = join(home, 'model-script.json');
  await writeFile(
    script,
    JSON.stringify([
      { tool: 'mcp_fixture_ping' },
      { tool: 'mcp_fixture_mutate' },
      { tool: 'mcp_fixture_ping' },
      { text: 'Recovered: {last}' },
    ]),
  );
  const env = { ...process.env, HOME: home };
  const model = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/fake-model-server.mjs', import.meta.url)), script],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(model);
  const [ready] = await once(model.stdout!, 'data');
  const port = /listening (\d+)/.exec(String(ready))?.[1];
  if (!port) throw new Error('fixture model did not report a port');
  await writeFile(
    join(home, '.chimera/config.json'),
    JSON.stringify({
      providers: {
        fake: { shape: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-only' },
      },
      defaultModel: 'fake/test',
      models: { 'fake/test': { contextWindow: 200_000 } },
      updates: { mode: 'off' },
      workspaceCheckpoints: false,
      recall: { enabled: false },
    }),
  );
  const journal = join(home, 'calls');
  const mcpConfig = JSON.stringify({
    mcpServers: {
      fixture: {
        transport: 'stdio',
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./fixtures/mcp-lifecycle-server.mjs', import.meta.url)),
          journal,
          failure,
        ],
        trustedTools: ['ping', 'mutate'],
      },
    },
  });
  const agent = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../dist/bin.js', import.meta.url)),
      'run',
      '--json',
      '--cwd',
      cwd,
      '--max-steps',
      '6',
      '--no-mods',
      '--no-subagents',
      '--mcp-config',
      mcpConfig,
      'Exercise fixture MCP recovery',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(agent);
  let output = '';
  let errors = '';
  agent.stdout!.on('data', (chunk) => {
    output += chunk;
  });
  agent.stderr!.on('data', (chunk) => {
    errors += chunk;
  });
  expect((await once(agent, 'exit'))[0], errors).toBe(0);
  const events = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const results = events
    .filter((event) => event.type === 'tool_call_result')
    .map((event) => event.result);
  expect(results).toHaveLength(3);
  expect(results[0].content).toEqual([{ type: 'text', text: 'pong' }]);
  expect(results[1].error).toContain(failure === 'exit' ? 'connection closed' : 'receive limit');
  expect(results[1].error).toContain('not retried');
  expect(results[2].content).toEqual([{ type: 'text', text: 'pong' }]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'assistant_text_done',
      text: expect.stringContaining('Recovered:'),
    }),
  );
  expect((await readFile(journal, 'utf8')).trim().split('\n')).toEqual([
    'start',
    'list',
    'ping',
    'mutate',
    'start',
    'list',
    'ping',
  ]);
  expect(output + errors).not.toContain('private-result-canary');
}, 15000);
