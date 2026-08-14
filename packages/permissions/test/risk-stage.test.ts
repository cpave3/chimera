import { describe, expect, it } from 'vitest';
import { PiSafeShellAdapter } from '../src/pi-safe-shell-adapter';
import { RiskStage } from '../src/risk-stage';

const context = {
  command: 'ls -la',
  target: 'host' as const,
  cwd: '/workspace',
  home: '/home/user',
  projectRoot: '/workspace',
  roots: { read: ['/workspace'], write: ['/workspace'] },
  facts: [],
};

describe('RiskStage', () => {
  it('normalizes real provider results and only escalates above caution', async () => {
    const stage = new RiskStage(new PiSafeShellAdapter(), 'caution');

    await expect(stage.evaluate(context)).resolves.toMatchObject({ status: 'pass' });
    await expect(stage.evaluate({ ...context, command: 'rm -rf /' })).resolves.toMatchObject({
      status: 'findings',
      findings: [
        {
          kind: 'risk',
          stageId: 'risk',
          level: 'critical',
          score: 100,
        },
      ],
    });
  });

  it('waives only generic delete risk after path authorization', async () => {
    const stage = new RiskStage(new PiSafeShellAdapter(), 'caution');

    await expect(
      stage.evaluate({
        ...context,
        command: 'rm build.log',
        facts: [{ kind: 'authorized_delete' }],
      }),
    ).resolves.toEqual({ status: 'pass' });
  });

  it('retains independent risk factors after path authorization', async () => {
    const stage = new RiskStage(
      {
        async classify() {
          return {
            level: 'critical' as const,
            score: 100,
            reasons: ['dangerous command', 'system destruction'],
            riskFactors: ['dangerous_command', 'system_destruction'],
          };
        },
      },
      'caution',
    );

    await expect(
      stage.evaluate({ ...context, facts: [{ kind: 'authorized_delete' }] }),
    ).resolves.toMatchObject({
      status: 'findings',
      findings: [{ kind: 'risk', factors: ['dangerous_command', 'system_destruction'] }],
    });
  });
});
