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
});
