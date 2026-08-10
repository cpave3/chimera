import type { CommandPolicyStage } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { CommandPolicyPipeline } from '../src/pipeline';

const context = {
  command: 'ls -la',
  target: 'host' as const,
  cwd: '/workspace',
  home: '/home/user',
  projectRoot: '/workspace',
  roots: {
    read: ['/workspace'],
    write: ['/workspace'],
  },
};

describe('CommandPolicyPipeline', () => {
  it('fails closed for malformed results and stage timeouts', async () => {
    const malformed = {
      id: 'malformed',
      evaluate: async () => ({ status: 'unknown' }),
    } as unknown as CommandPolicyStage;
    const hanging: CommandPolicyStage = {
      id: 'hanging',
      evaluate: async () => new Promise(() => {}),
    };

    await expect(new CommandPolicyPipeline([malformed]).evaluate(context)).resolves.toMatchObject({
      version: 1,
      outcome: 'approval_required',
      findings: [{ kind: 'analyzer_error', stageId: 'malformed' }],
    });
    await expect(
      new CommandPolicyPipeline([hanging], { timeoutMs: 10 }).evaluate(context),
    ).resolves.toMatchObject({
      version: 1,
      outcome: 'approval_required',
      findings: [{ kind: 'analyzer_error', stageId: 'hanging', message: 'stage timed out' }],
    });
  });

  it('runs stages in order and converts a thrown stage into a mandatory analyzer error', async () => {
    const calls: string[] = [];
    const stages: CommandPolicyStage[] = [
      {
        id: 'first',
        async evaluate() {
          calls.push('first');
          return { status: 'pass', facts: [] };
        },
      },
      {
        id: 'broken',
        async evaluate() {
          calls.push('broken');
          throw new Error('classifier unavailable');
        },
      },
    ];

    const result = await new CommandPolicyPipeline(stages).evaluate(context);

    expect(calls).toEqual(['first', 'broken']);
    expect(result.outcome).toBe('approval_required');
    expect(result.stages).toEqual([
      { id: 'first', status: 'pass', findings: [] },
      {
        id: 'broken',
        status: 'error',
        findings: [
          {
            kind: 'analyzer_error',
            stageId: 'broken',
            message: 'classifier unavailable',
          },
        ],
      },
    ]);
  });
});
