import { describe, expect, it } from 'vitest';
import { BalancedPolicyEvaluator } from '../src/balanced-policy';
import { PathAuthorizationStage } from '../src/path-authorization-stage';
import { PiSafeShellAdapter } from '../src/pi-safe-shell-adapter';
import { CommandPolicyPipeline } from '../src/pipeline';
import { RiskStage } from '../src/risk-stage';
import { ScaryCommandStage } from '../src/scary-command-stage';
import { ShellEffectsStage } from '../src/shell-effects-stage';
import { SudoApprovalStage } from '../src/sudo-approval-stage';

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
      new SudoApprovalStage(),
      new ScaryCommandStage(),
      new ShellEffectsStage(adapter),
      new PathAuthorizationStage(),
      new RiskStage(adapter, 'caution'),
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

  it('auto-allows benign command substitutions containing rm text', async () => {
    for (const command of [
      'custom-tool `echo normal`',
      'custom-tool `echo format`',
      'custom-tool `echo arm`',
      'custom-tool `echo rm`',
      'custom-tool $(echo normal)',
      'custom-tool $(echo format)',
      'custom-tool $(echo arm)',
      'custom-tool $(echo rm)',
      'custom-tool $(r\\\\m temporary-file)',
    ]) {
      const analysis = await evaluator().evaluate({ ...context, command });
      expect(analysis.outcome, command).toBe('pass');
      expect(analysis.findings, command).not.toContainEqual(
        expect.objectContaining({
          kind: 'risk',
          factors: expect.arrayContaining(['obfuscated_destruction']),
        }),
      );
    }
  });

  it('requires approval for rm commands in command substitutions', async () => {
    for (const command of [
      'custom-tool `rm temporary-file`',
      'custom-tool $(rm temporary-file)',
      'custom-tool $(echo ok; rm temporary-file)',
      'custom-tool $(echo ok && rm temporary-file)',
      'custom-tool $(echo ok || rm temporary-file)',
      'custom-tool $(echo ok | rm temporary-file)',
      'custom-tool $(echo $(rm temporary-file))',
      'custom-tool $(/bin/rm temporary-file)',
      'custom-tool $("rm" temporary-file)',
      'custom-tool $(r\\m temporary-file)',
      'custom-tool $(command rm temporary-file)',
      'custom-tool $(env rm temporary-file)',
      'custom-tool $(exec rm temporary-file)',
      'custom-tool $(/bin/"rm" temporary-file)',
    ]) {
      const analysis = await evaluator().evaluate({ ...context, command });
      expect(analysis.outcome, command).toBe('approval_required');
      expect(analysis.findings, command).toContainEqual(
        expect.objectContaining({
          kind: 'risk',
          factors: expect.arrayContaining(['obfuscated_destruction']),
        }),
      );
    }
  });

  it('requires mandatory approval for executable sudo invocations', async () => {
    for (const command of [
      'sudo true',
      '/usr/bin/sudo true',
      '"sudo" true',
      "'sudo' true",
      's\\udo true',
      '/usr/bin/"sudo" true',
      'command sudo true',
      'command -- sudo true',
      'env FOO=bar sudo true',
      'env -u HOME sudo true',
      'FOO=bar sudo true',
      'echo before && sudo true',
      'sudo true | cat',
      'echo $(sudo true)',
      "sh -c 'sudo true'",
      "bash -e -c 'sudo true'",
      "bash -c -- 'sudo true'",
      'script=\'sudo true\'; bash -c "$script"',
      "eval 'sudo true'",
      'command_name=sudo; $command_name true',
    ]) {
      const analysis = await evaluator().evaluate({ ...context, command });
      expect(analysis.outcome, command).toBe('approval_required');
      expect(analysis.findings, command).toContainEqual(
        expect.objectContaining({
          kind: 'elevation',
          ruleId: 'sudo',
        }),
      );
    }
  });

  it('does not treat sudo text as an executable invocation', async () => {
    for (const command of [
      'echo sudo',
      'echo "sudo true"',
      "printf '%s' sudo",
      'cat /tmp/sudo',
      'echo safe # sudo true',
    ]) {
      const analysis = await evaluator().evaluate({ ...context, command });
      expect(analysis.findings, command).not.toContainEqual(
        expect.objectContaining({ kind: 'elevation' }),
      );
    }
  });

  it('does not treat wrapped-command options as sudo options', async () => {
    for (const command of [
      'sudo echo -k',
      'sudo -- echo -K',
      'sudo curl -k example.com',
      'sudo -p-k true',
      'sudo -u-k true',
    ]) {
      const analysis = await evaluator().evaluate({ ...context, command });
      expect(analysis.findings, command).not.toContainEqual(
        expect.objectContaining({ ruleId: 'sudo-credential-invalidation' }),
      );
      expect(analysis.findings, command).toContainEqual(
        expect.objectContaining({ kind: 'elevation', ruleId: 'sudo' }),
      );
    }
  });

  it('hard-blocks sudo timestamp invalidation', async () => {
    for (const command of ['sudo -k true', 'sudo -K', 'sudo --reset-timestamp true']) {
      const analysis = await evaluator().evaluate({ ...context, command });
      expect(analysis.findings, command).toContainEqual(
        expect.objectContaining({
          kind: 'blocked',
          ruleId: 'sudo-credential-invalidation',
        }),
      );
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

  it('auto-allows literal deletes inside writable roots', async () => {
    for (const command of [
      'rm build.log',
      'rmdir build',
      '/bin/rm build.log',
      'rm first.log second.log',
    ]) {
      await expect(evaluator().evaluate({ ...context, command })).resolves.toMatchObject({
        outcome: 'pass',
      });
    }
  });

  it('still intervenes for unauthorized or unresolved deletes', async () => {
    for (const command of [
      'rm /outside/file',
      'rm local-file /outside/file',
      'rm "$TARGET"',
      'rm $(printf file)',
      'rm local-file && echo done',
    ]) {
      await expect(evaluator().evaluate({ ...context, command })).resolves.toMatchObject({
        outcome: 'approval_required',
      });
    }
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
