import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reviewBashPolicy } from '../src/policy-review';

it('extracts unique bash calls, joins audit outcomes, and redacts likely secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chimera-policy-review-'));
  const eventsPath = join(dir, 'events.jsonl');
  const auditPath = join(dir, 'permission-decisions.jsonl');
  const toolCalls = [
    {
      callId: 'call-1',
      name: 'bash',
      args: { command: 'API_KEY=secret pnpm test' },
      target: 'host',
      result: { exit_code: 0 },
      startedAt: 1,
      endedAt: 2,
    },
    {
      callId: 'call-2',
      name: 'bash',
      args: { command: 'git push --force origin main' },
      target: 'host',
      result: { exit_code: -1 },
      startedAt: 3,
      endedAt: 4,
    },
  ];
  await writeFile(
    eventsPath,
    `${JSON.stringify({ type: 'step_finished', stepNumber: 1, toolCalls })}\n${JSON.stringify({ type: 'step_finished', stepNumber: 2, toolCalls })}\n`,
  );
  await writeFile(
    auditPath,
    `${JSON.stringify({ sessionId: 'session-1', command: 'API_KEY=secret pnpm test', decision: 'allow', source: 'automatic' })}\n${JSON.stringify({ sessionId: 'session-1', command: 'git push --force origin main', decision: 'deny', source: 'policy' })}\n`,
  );

  const report = await reviewBashPolicy({ eventsPath, auditPath, sessionId: 'session-1' });

  expect(report.commands).toHaveLength(2);
  expect(report.commands[0]?.command).toBe('API_KEY=[REDACTED] pnpm test');
  expect(JSON.stringify(report.commands[0]?.audit)).not.toContain('secret');
  expect(report.commands[1]).toMatchObject({
    command: 'git push --force origin main',
    currentPolicy: { outcome: 'blocked', ruleId: 'git-force-push' },
    audit: { decision: 'deny', source: 'policy' },
  });
  expect(report.summary).toEqual({ total: 2, blocked: 1, prompted: 0, automatic: 1 });
  expect((await readFile(auditPath, 'utf8')).trim().split('\n')).toHaveLength(2);
});
