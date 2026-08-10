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
