import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '@chimera/server';
import { afterEach, expect, it, vi } from 'vitest';
import { CliAgentFactory } from '../src/factory';

let root: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
});

it('routes factory tool, permission and terminal hooks through the ordered source once', async () => {
  root = await mkdtemp(join(tmpdir(), 'chimera-factory-hooks-'));
  const cwd = join(root, 'cwd');
  const home = join(root, 'home');
  const recorded = join(root, 'payloads.jsonl');
  await mkdir(cwd);
  await mkdir(home);
  for (const event of [
    'SessionCreated',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PermissionResolved',
    'PostToolUse',
    'Stop',
  ]) {
    const directory = join(cwd, '.chimera', 'hooks', event);
    await mkdir(directory, { recursive: true });
    const script = join(directory, 'record.sh');
    await writeFile(
      script,
      `#!/bin/sh\ncat >> ${JSON.stringify(recorded)}\necho >> ${JSON.stringify(recorded)}\nexit ${event === 'PermissionRequest' ? 2 : 0}\n`,
    );
    await chmod(script, 0o755);
  }
  let modelCalls = 0;
  vi.stubGlobal('fetch', async () => {
    modelCalls++;
    const chunk = (delta: unknown, reason: string | null) =>
      `data: ${JSON.stringify({
        id: 'chat-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [{ index: 0, delta, finish_reason: reason }],
      })}\n\n`;
    const response =
      modelCalls === 1
        ? chunk(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'bash', arguments: JSON.stringify({ command: 'echo hello' }) },
                },
              ],
            },
            null,
          ) + chunk({}, 'tool_calls')
        : chunk({ role: 'assistant', content: 'done' }, null) + chunk({}, 'stop');
    return new Response(`${response}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const factory = new CliAgentFactory({
    providersConfig: {
      providers: {
        direct: { shape: 'openai', baseUrl: 'https://provider.test/v1', apiKey: 'test-key' },
      },
    },
    models: { 'direct/coder': { contextWindow: 64_000 } },
    autoApprove: 'none',
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
  await registry.run(sessionId, 'say hello');
  await entry.activeRun;
  const payloads = (await readFile(recorded, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(payloads.map((payload) => payload.event)).toEqual([
    'SessionCreated',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PermissionResolved',
    'PostToolUse',
    'Stop',
  ]);
  expect(payloads[1]).toMatchObject({
    session_id: sessionId,
    cwd,
    user_message: 'say hello',
    source: 'user',
  });
  expect(payloads[2]).toMatchObject({ tool_name: 'bash', tool_input: { command: 'echo hello' } });
  expect(payloads[3]).toMatchObject({ tool_name: 'bash', command: 'echo hello', target: 'host' });
  expect(payloads[4]).toMatchObject({
    decision: 'deny',
    remembered: false,
    session_status: 'running',
    remaining_pending: 0,
  });
  expect(payloads.at(-1)).toMatchObject({ reason: 'stop' });
  await registry.delete(sessionId);
});
