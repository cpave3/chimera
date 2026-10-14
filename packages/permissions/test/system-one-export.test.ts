import { describe, expect, it } from 'vitest';
import { exportSystemOneLog } from '../src/system-one-export';

/** One line of `system-one-decisions.jsonl`. */
function check(requestId: string, command: string, outcome: string, over: object = {}) {
  return {
    version: 1,
    timestamp: 1_000,
    sessionId: 's1',
    requestId,
    cwd: '/work/shop',
    command,
    outcome,
    ...(outcome === 'failed' ? {} : { safety: outcome === 'approved' ? 0.9 : 0.3 }),
    threshold: 0.8,
    note: `${outcome}: ...`,
    url: 'http://system-one.test/v1/systemone',
    model: 'jev-latest',
    promptVersion: 'aaaaaaaaaaaa',
    durationMs: 90,
    ...over,
  };
}

/** One line of `permission-decisions.jsonl`. */
function decision(requestId: string, made: 'allow' | 'deny', source: string, over: object = {}) {
  return { version: 1, sessionId: 's1', requestId, decision: made, source, ...over };
}

describe('the export of the System One log', () => {
  it('labels a command with what the user decided after the model rejected it', () => {
    const { labelled, review } = exportSystemOneLog({
      checks: [
        check('r1', './dev check', 'rejected'),
        check('r2', 'vercel deploy --prod', 'rejected'),
      ],
      decisions: [
        decision('r1', 'allow', 'user'),
        decision('r2', 'deny', 'user', { feedback: 'not on a Friday' }),
      ],
    });

    expect(labelled).toEqual([
      expect.objectContaining({
        requestId: 'r1',
        command: './dev check',
        cwd: '/work/shop',
        outcome: 'rejected',
        safety: 0.3,
        promptVersion: 'aaaaaaaaaaaa',
        label: 'safe',
        labelSource: 'user',
      }),
      expect.objectContaining({
        requestId: 'r2',
        label: 'unsafe',
        labelSource: 'user',
        feedback: 'not on a Friday',
      }),
    ]);
    expect(review).toEqual([]);
  });

  it('lists for review the commands that nobody decided, each one once', () => {
    const { labelled, review } = exportSystemOneLog({
      checks: [
        check('r1', 'pnpm test', 'approved', { safety: 0.84 }),
        check('r2', 'pnpm test', 'approved', { safety: 0.91, timestamp: 2_000 }),
        check('r3', 'pnpm test', 'approved', { cwd: '/work/other' }),
        // The sandbox retry: the model rejected it and nobody was asked.
        check('r4', 'make cache', 'rejected', { unsandboxed: true }),
        // The model gave no answer, and the approval reviewer allowed it.
        check('r5', 'make docs', 'failed'),
        check('r6', './dev check', 'rejected'),
      ],
      decisions: [
        decision('r1', 'allow', 'system_one'),
        decision('r2', 'allow', 'system_one'),
        decision('r5', 'allow', 'reviewer'),
        decision('r6', 'allow', 'user'),
      ],
    });

    expect(labelled.map((row) => row.requestId)).toEqual(['r6']);
    expect(review).toEqual([
      {
        cwd: '/work/shop',
        command: 'pnpm test',
        count: 2,
        outcomes: ['approved'],
        lowestSafety: 0.84,
        highestSafety: 0.91,
        label: null,
      },
      {
        cwd: '/work/other',
        command: 'pnpm test',
        count: 1,
        outcomes: ['approved'],
        lowestSafety: 0.9,
        highestSafety: 0.9,
        label: null,
      },
      {
        cwd: '/work/shop',
        command: 'make cache',
        unsandboxed: true,
        count: 1,
        outcomes: ['rejected'],
        lowestSafety: 0.3,
        highestSafety: 0.3,
        label: null,
      },
      { cwd: '/work/shop', command: 'make docs', count: 1, outcomes: ['failed'], label: null },
    ]);
  });

  describe('with the labels of an earlier review', () => {
    const reviewed = (command: string, label: unknown, over: object = {}) => ({
      cwd: '/work/shop',
      command,
      count: 1,
      outcomes: ['approved'],
      label,
      ...over,
    });

    it('labels each time the model rated a reviewed command, and keeps the review', () => {
      const { labelled, review } = exportSystemOneLog({
        checks: [
          check('r1', 'pnpm test', 'approved'),
          check('r2', 'pnpm test', 'approved'),
          check('r3', 'npm publish', 'approved'),
          check('r4', 'make cache', 'approved'),
          // Reviewed in the sandbox only: outside it, the command is another question.
          check('r5', 'pnpm test', 'approved', { unsandboxed: true }),
        ],
        decisions: [],
        reviewed: [
          reviewed('pnpm test', 'safe'),
          reviewed('npm publish', 'unsafe'),
          reviewed('make cache', null),
          // A command that is no longer in the log: the label is not lost.
          reviewed('old command', 'safe'),
        ],
      });

      expect(
        labelled.map(({ requestId, label, labelSource }) => [requestId, label, labelSource]),
      ).toEqual([
        ['r1', 'safe', 'review'],
        ['r2', 'safe', 'review'],
        ['r3', 'unsafe', 'review'],
      ]);
      expect(
        review.map(({ command, unsandboxed, count, label }) => [
          command,
          unsandboxed,
          count,
          label,
        ]),
      ).toEqual([
        ['make cache', undefined, 1, null],
        ['pnpm test', true, 1, null],
        ['pnpm test', undefined, 2, 'safe'],
        ['npm publish', undefined, 1, 'unsafe'],
        ['old command', undefined, 1, 'safe'],
      ]);
    });

    it('refuses a label that is neither safe nor unsafe', () => {
      expect(() =>
        exportSystemOneLog({
          checks: [],
          decisions: [],
          reviewed: [reviewed('pnpm test', 'saef')],
        }),
      ).toThrow('review label of "pnpm test" must be "safe", "unsafe" or null, not "saef"');
    });
  });

  it('takes likely credentials out of the commands, and still matches a review of them', () => {
    const secret = 'STRIPE_SECRET_KEY=sk_live_abc123 ./deploy.sh';
    const scrubbed = 'STRIPE_SECRET_KEY=[REDACTED] ./deploy.sh';
    const input = {
      checks: [
        check('r1', secret, 'approved'),
        check('r2', 'curl -H "Authorization: Bearer tok_456" https://api.test', 'rejected'),
      ],
      decisions: [decision('r2', 'deny', 'user', { feedback: 'never send --token tok_456' })],
    };

    const first = exportSystemOneLog(input);

    expect(JSON.stringify(first)).not.toMatch(/sk_live_abc123|tok_456/);
    expect(first.review[0]!.command).toBe(scrubbed);
    expect(first.labelled[0]).toMatchObject({
      command: 'curl -H "Authorization: Bearer [REDACTED]" https://api.test',
      feedback: 'never send --token [REDACTED]',
    });

    const second = exportSystemOneLog({
      ...input,
      reviewed: [{ ...first.review[0]!, label: 'unsafe' }],
    });

    expect(second.labelled).toContainEqual(
      expect.objectContaining({ requestId: 'r1', command: scrubbed, label: 'unsafe' }),
    );
  });
});
