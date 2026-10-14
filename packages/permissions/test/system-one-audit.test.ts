import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRequest } from '@chimera/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createSystemOneCheck, SYSTEM_ONE_PROMPT_VERSION } from '../src/system-one';
import { SystemOneAudit, systemOneAuditPath } from '../src/system-one-audit';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chimera-system-one-audit-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function request(requestId: string, command: string): PermissionRequest {
  return { requestId, tool: 'bash', target: 'host', command, cwd: '/work/shop' };
}

function answers(benign: number) {
  const rest = 1 - benign;
  return {
    damage: {
      type: 'score',
      score: 1,
      confidence: 0.4,
      probabilities: { '0': benign, '1': 0, '2': rest, '3': 0 },
    },
    kind: { type: 'choice', choice: 'reads', probabilities: { reads: benign, remote: rest } },
    verdict: { type: 'choice', choice: 'safe', probabilities: { safe: benign, unsafe: rest } },
  };
}

it('logs every command the model approved, rejected or did not answer', async () => {
  const replies = [
    () => new Response(JSON.stringify({ model: 'jev-1.13-20260917', answers: answers(0.875) })),
    () => new Response(JSON.stringify({ model: 'jev-1.13-20260917', answers: answers(0.25) })),
    () => new Response('{}', { status: 500 }),
  ];
  const audit = new SystemOneAudit({ home, sessionId: 'session-1' });
  const check = createSystemOneCheck({
    url: 'http://system-one.test/v1/systemone',
    model: 'jev-latest',
    threshold: 0.8,
    fetch: (async () => replies.shift()!()) as unknown as typeof globalThis.fetch,
    record: (entry) => audit.record(entry),
  });

  await check.check(request('r1', 'pnpm test'));
  await check.check(request('r2', 'vercel deploy --prod'));
  await check.check({ ...request('r3', 'make build'), osSandbox: true });

  const path = join(home, '.chimera', 'logs', 'system-one-decisions.jsonl');
  expect(systemOneAuditPath(home)).toBe(path);
  const records = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(3);
  expect(records[0]).toMatchObject({
    version: 1,
    sessionId: 'session-1',
    requestId: 'r1',
    cwd: '/work/shop',
    command: 'pnpm test',
    outcome: 'approved',
    threshold: 0.8,
    url: 'http://system-one.test/v1/systemone',
    model: 'jev-latest',
    servedBy: 'jev-1.13-20260917',
    answers: {
      damage: { '0': 0.875, '1': 0, '2': 0.125, '3': 0 },
      kind: { reads: 0.875, remote: 0.125 },
      verdict: { safe: 0.875, unsafe: 0.125 },
    },
  });
  expect(records[0].safety).toBeCloseTo(0.875);
  // The version names the questions, the input and the scoring that gave these numbers.
  expect(SYSTEM_ONE_PROMPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
  expect(records.map((record) => record.promptVersion)).toEqual(
    Array(3).fill(SYSTEM_ONE_PROMPT_VERSION),
  );
  expect(records[0].timestamp).toEqual(expect.any(Number));
  expect(records[0].durationMs).toEqual(expect.any(Number));
  expect(records[1]).toMatchObject({
    requestId: 'r2',
    command: 'vercel deploy --prod',
    outcome: 'rejected',
    note: 'rejected: safety 0.25, needs 0.80, reads as "remote"',
  });
  expect(records[2]).toMatchObject({
    requestId: 'r3',
    command: 'make build',
    osSandbox: true,
    outcome: 'failed',
    note: 'gave no answer: HTTP 500',
  });
  expect(records[2]).not.toHaveProperty('safety');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('reports a log it cannot write and lets the check go on', async () => {
  const warnings: string[] = [];
  // A file where the `.chimera` directory must be.
  const blockedHome = join(home, 'file');
  await writeFile(blockedHome, '');
  const audit = new SystemOneAudit({
    home: blockedHome,
    sessionId: 'session-1',
    onWarning: (message) => warnings.push(message),
  });

  audit.record({
    request: request('r1', 'pnpm test'),
    verdict: {
      decision: 'allow',
      note: 'approved: safety 0.90, needs 0.80',
      safety: 0.9,
      threshold: 0.8,
    },
    url: 'http://system-one.test/v1/systemone',
    model: 'jev-latest',
    promptVersion: SYSTEM_ONE_PROMPT_VERSION,
    durationMs: 12,
  });

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('System One audit write failed');
});
