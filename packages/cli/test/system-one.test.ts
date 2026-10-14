import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemOneSettings } from '../src/config';
import { CliAgentFactory } from '../src/factory';

const SYSTEM_ONE_URL = 'http://system-one.test/v1/systemone';

type ChatBody = { messages: Array<{ role: string; content: unknown }> };
type SystemOneBody = { model: string; state: { bash_command: string }; questions: object };

function streamOf(delta: unknown, finishReason: string): Response {
  const chunk = (part: unknown, reason: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: [{ index: 0, delta: part, finish_reason: reason }],
    })}\n\n`;
  return new Response(`${chunk(delta, null)}${chunk({}, finishReason)}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A chat-completions stream that asks for one `bash` call. */
function bashCall(id: string, command: string): Response {
  return streamOf(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command }) },
        },
      ],
    },
    'tool_calls',
  );
}

/** The reply of a System One model that gives every harmless reading this probability. */
function rated(benign: number): Response {
  const rest = 1 - benign;
  return new Response(
    JSON.stringify({
      model: 'jev-1.13-20260917',
      answers: {
        damage: { type: 'score', score: 1, probabilities: { '0': 0, '1': benign, '2': rest } },
        kind: { type: 'choice', choice: 'x', probabilities: { develops: benign, destroys: rest } },
        verdict: { type: 'choice', choice: 'x', probabilities: { safe: benign, unsafe: rest } },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('the System One check in a session', () => {
  let cwd: string;
  let home: string;
  // Outside the project, the home and the session's temp directory, so a
  // write there has a path finding and needs approval.
  let outside: string;
  let systemTmp: string | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-system-one-'));
    home = await mkdtemp(join(tmpdir(), 'chimera-system-one-home-'));
    outside = await mkdtemp(join(tmpdir(), 'chimera-system-one-outside-'));
    systemTmp = process.env.TMPDIR;
    process.env.TMPDIR = await mkdtemp(join(tmpdir(), 'chimera-session-tmp-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(process.env.TMPDIR!, { recursive: true, force: true });
    if (systemTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = systemTmp;
    for (const directory of [cwd, home, outside]) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  interface Scenario {
    /** The probability the model gives the harmless readings. */
    benign: number;
    /** The check's settings; null turns the check off. */
    systemOne?: Partial<SystemOneSettings> | null;
    headless?: boolean;
  }

  /**
   * One run: the session model runs a command that needs no approval, then
   * writes a file outside the project, then stops.
   */
  async function run(scenario: Scenario) {
    const target = join(outside, 'made.txt');
    const sessionCalls: ChatBody[] = [];
    const systemOneCalls: Array<{ body: SystemOneBody; authorization?: string }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (String(input) === SYSTEM_ONE_URL) {
        systemOneCalls.push({
          body: JSON.parse(String(init?.body)) as SystemOneBody,
          authorization: (init?.headers as Record<string, string>).authorization,
        });
        return rated(scenario.benign);
      }
      if (!String(input).endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 });
      }
      sessionCalls.push(JSON.parse(String(init?.body)) as ChatBody);
      if (sessionCalls.length === 1) return bashCall('call_1', 'echo hello');
      if (sessionCalls.length === 2) return bashCall('call_2', `echo made > ${target}`);
      return streamOf({ role: 'assistant', content: 'done' }, 'stop');
    });
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: { shape: 'openai', baseUrl: 'https://provider.test/v1', apiKey: 'test-key' },
        },
      },
      models: { 'direct/coder': { contextWindow: 64_000 } },
      autoApprove: 'host',
      hostBashPolicy: {
        enabled: true,
        mode: 'balanced',
        autoAllowThrough: 'caution',
        osSandbox: 'off',
        network: 'on',
        sandboxWritePaths: [],
      },
      ...(scenario.systemOne === null
        ? {}
        : { systemOne: { url: SYSTEM_ONE_URL, threshold: 0.8, ...scenario.systemOne } }),
      home,
      warn: () => {},
      subagents: { enabled: false, headlessAutoDeny: scenario.headless ?? false },
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'direct', modelId: 'coder', maxSteps: 5 },
      sandboxMode: 'off',
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.run('Write made.txt next to the project.')) {
      events.push(event);
      if (event.type === 'permission_request')
        void agent.resolvePermission(event.requestId, 'deny');
    }
    const writeResult = JSON.stringify(
      sessionCalls
        .at(-1)
        ?.messages.filter((message) => message.role === 'tool')
        .at(-1)?.content,
    );
    const of = <T extends AgentEvent['type']>(type: T) =>
      events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
    const logged = async (file: string) =>
      (await readFile(join(home, '.chimera', 'logs', file), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    return { target, of, systemOneCalls, writeResult, logged, sessionId: agent.session.id };
  }

  it('runs a command the model rates safe, without a prompt, and reports the verdict', async () => {
    const { target, of, systemOneCalls } = await run({ benign: 0.9 });

    expect(await readFile(target, 'utf8')).toBe('made\n');
    expect(of('permission_request')).toHaveLength(0);
    // Only the command that needed approval went to the model.
    expect(systemOneCalls).toHaveLength(1);
    expect(systemOneCalls[0]!.body.state.bash_command).toBe(`echo made > ${target}`);
    expect(systemOneCalls[0]!.body.model).toBe('jev-latest');
    const checked = of('system_one_checked');
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({
      decision: 'allow',
      note: 'approved: safety 0.90, needs 0.80',
      threshold: 0.8,
    });
    expect(checked[0]!.callId).toBe(of('tool_call_start')[1]!.callId);
  });

  it('asks the user about a command the model rejects, with a note that it did', async () => {
    const { target, of, writeResult } = await run({ benign: 0.25 });

    expect(of('permission_request')).toHaveLength(1);
    expect(of('permission_request')[0]!.systemOneNote).toBe(
      'rejected: safety 0.25, needs 0.80, reads as "destroys"',
    );
    expect(of('system_one_checked')[0]).toMatchObject({ decision: 'escalate', safety: 0.25 });
    expect(writeResult).toContain('denied by user');
    expect(existsSync(target)).toBe(false);
  });

  it('gives the model the note when the check rejects and nobody can be asked', async () => {
    const { target, of, writeResult } = await run({ benign: 0.25, headless: true });

    expect(of('permission_request')).toHaveLength(0);
    expect(writeResult).toContain('denied: System One rejected: safety 0.25, needs 0.80');
    expect(existsSync(target)).toBe(false);
  });

  it('logs the commands the model approved and rejected', async () => {
    const approvedRun = await run({ benign: 0.9 });
    const rejectedRun = await run({ benign: 0.25 });

    const checks = await approvedRun.logged('system-one-decisions.jsonl');
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      sessionId: approvedRun.sessionId,
      command: `echo made > ${approvedRun.target}`,
      outcome: 'approved',
      url: SYSTEM_ONE_URL,
      servedBy: 'jev-1.13-20260917',
    });
    expect(checks[1]).toMatchObject({ sessionId: rejectedRun.sessionId, outcome: 'rejected' });
    const decisions = await approvedRun.logged('permission-decisions.jsonl');
    expect(decisions.filter((record) => record.systemOne)).toMatchObject([
      { decision: 'allow', source: 'system_one', systemOne: { decision: 'allow' } },
      { decision: 'deny', source: 'user', systemOne: { decision: 'escalate' } },
    ]);
  });

  it('uses the model, the key and the threshold of the settings', async () => {
    const { of, systemOneCalls } = await run({
      benign: 0.75,
      systemOne: { model: 'typed-decisions', apiKey: 'local-key', threshold: 0.7 },
    });

    expect(systemOneCalls[0]!.body.model).toBe('typed-decisions');
    expect(systemOneCalls[0]!.authorization).toBe('Bearer local-key');
    expect(of('system_one_checked')[0]).toMatchObject({ decision: 'allow', threshold: 0.7 });
  });

  it('calls no System One model when the setting is off', async () => {
    const { of, systemOneCalls, writeResult } = await run({
      benign: 0.9,
      systemOne: null,
      headless: true,
    });

    expect(systemOneCalls).toHaveLength(0);
    expect(of('system_one_checked')).toHaveLength(0);
    expect(writeResult).toContain('denied by policy');
  });
});
