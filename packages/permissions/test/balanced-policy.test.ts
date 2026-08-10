import { describe, expect, it } from 'vitest';
import { BalancedPolicyEvaluator } from '../src/balanced-policy';
import { PiSafeShellAdapter } from '../src/pi-safe-shell-adapter';
import { CommandPolicyPipeline } from '../src/pipeline';
import { RiskStage } from '../src/risk-stage';
import { ScaryCommandStage } from '../src/scary-command-stage';
import { ShellEffectsStage } from '../src/shell-effects-stage';

const context = {
  command: '',
  target: 'host' as const,
  cwd: '/workspace',
  home: '/home/user',
  projectRoot: '/workspace',
  roots: { read: ['/workspace'], write: ['/workspace'] },
};

function evaluator(): BalancedPolicyEvaluator {
  const adapter = new PiSafeShellAdapter();
  return new BalancedPolicyEvaluator(
    new CommandPolicyPipeline([
      new ScaryCommandStage(),
      new RiskStage(adapter, 'caution'),
      new ShellEffectsStage(adapter),
    ]),
  );
}

describe('BalancedPolicyEvaluator', () => {
  it('auto-allows ordinary unknown, compound, build, and read-only git commands', async () => {
    for (const command of [
      'pnpm test',
      'pnpm -r build',
      'custom-linter --check src',
      'git diff --stat',
      'pnpm build && pnpm test',
    ]) {
      await expect(evaluator().evaluate({ ...context, command })).resolves.toMatchObject({
        outcome: 'pass',
      });
    }
  });

  it('still requires approval when an analyzer fails', async () => {
    const failing = new BalancedPolicyEvaluator({
      async evaluate() {
        return {
          version: 1,
          outcome: 'approval_required',
          stages: [
            {
              id: 'risk',
              status: 'error',
              findings: [
                { kind: 'analyzer_error', stageId: 'risk', message: 'classifier unavailable' },
              ],
            },
          ],
          findings: [
            { kind: 'analyzer_error', stageId: 'risk', message: 'classifier unavailable' },
          ],
        };
      },
    });

    await expect(failing.evaluate({ ...context, command: 'pnpm test' })).resolves.toMatchObject({
      outcome: 'approval_required',
    });
  });

  it('requires approval for known scary commands', async () => {
    for (const command of [
      'git push --force origin main',
      'git -c core.hooksPath=/tmp push --force origin main',
      'git push origin +main',
      'rm -rf build',
      'rm -r -f build',
      'rm --recursive --force build',
      'command /bin/rm -rf build',
      'kubectl delete deployment api -n production',
      'terraform apply -var-file=production.tfvars',
      'terraform -chdir=infra destroy -var-file=production.tfvars',
    ]) {
      await expect(evaluator().evaluate({ ...context, command })).resolves.toMatchObject({
        outcome: 'approval_required',
      });
    }
  });
});
