import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CommandPolicyStage,
  CommandPolicyStageContext,
  CommandPolicyStageResult,
} from '@chimera/core';

const execFileAsync = promisify(execFile);

interface ScaryCommandMatch {
  ruleId: string;
  message: string;
}

function matchScaryCommand(command: string): ScaryCommandMatch | undefined {
  for (const invocation of command.split(/(?:&&|\|\||;|\|)/)) {
    const tokens = invocation.trim().split(/\s+/).filter(Boolean);
    const normalized = unwrapCommand(tokens);
    const executable = normalized[0]?.replace(/^.*\//, '');
    const args = normalized.slice(1);
    if (executable === 'git' && isForcePush(args)) {
      return { ruleId: 'git-force-push', message: 'Force-pushing is blocked by Chimera policy.' };
    }
    if (executable === 'rm' && hasRecursiveForce(args)) {
      return {
        ruleId: 'recursive-force-delete',
        message: 'Recursive forced deletion is blocked by Chimera policy.',
      };
    }
    if (executable === 'kubectl' && isProductionKubectlMutation(args)) {
      return {
        ruleId: 'production-kubectl',
        message: 'Production-targeted kubectl mutation is blocked by Chimera policy.',
      };
    }
    if (executable === 'terraform' && isProductionTerraformMutation(args)) {
      return {
        ruleId: 'production-terraform',
        message: 'Production-targeted Terraform mutation is blocked by Chimera policy.',
      };
    }
  }
  if (/:\(\)\s*\{\s*:\s*\|:&\s*\}\s*;\s*:/.test(command)) {
    return { ruleId: 'fork-bomb', message: 'Fork bombs are blocked by Chimera policy.' };
  }
  return undefined;
}

export class ScaryCommandStage implements CommandPolicyStage {
  readonly id = 'scary_commands';

  async evaluate(context: CommandPolicyStageContext): Promise<CommandPolicyStageResult> {
    const rule = matchScaryCommand(context.command);
    if (!rule) return { status: 'pass' };
    if (rule.ruleId === 'git-force-push') {
      const lease = parseLeasePush(context.command);
      if (lease) {
        let defaultRef: string;
        try {
          const result = await execFileAsync(
            'git',
            ['symbolic-ref', '--quiet', `refs/remotes/${lease.remote}/HEAD`],
            { cwd: context.cwd, timeout: 1_000, signal: context.signal },
          );
          defaultRef = result.stdout.trim();
        } catch (error) {
          rule.message = `Cannot determine the default branch for ${lease.remote}: ${(error as Error).message}. Set it with git remote set-head ${lease.remote} -a before requesting lease-push approval.`;
          return this.blocked(rule);
        }
        const branch = lease.ref.slice('refs/heads/'.length);
        if (
          ['main', 'master'].includes(branch) ||
          defaultRef === `refs/remotes/${lease.remote}/${branch}`
        ) {
          rule.message = `Force-pushing protected/default branch ${lease.ref} is blocked.`;
          return this.blocked(rule);
        }
        return {
          status: 'findings',
          findings: [
            {
              kind: 'approval',
              stageId: this.id,
              ruleId: 'git-lease-push',
              message: `Operator approval required: replace ${lease.remote} ${lease.ref} at ${lease.sha} using an explicit lease.`,
            },
          ],
        };
      }
      rule.message =
        'Force-pushing requires a standalone git push with one --force-with-lease=refs/heads/<branch>:<full-sha> and a matching explicit <source>:refs/heads/<branch> destination; bare force and ambiguous pushes cannot be approved.';
    }
    return this.blocked(rule);
  }

  private blocked(rule: ScaryCommandMatch): CommandPolicyStageResult {
    return {
      status: 'findings',
      findings: [
        {
          kind: 'blocked',
          stageId: this.id,
          ruleId: rule.ruleId,
          message: rule.message,
        },
      ],
    };
  }
}

function parseLeasePush(command: string) {
  // Deliberately accept only literal argv: shell expansion, wrappers and extra
  // push options could change the repository, destination or lease semantics.
  if (!/^git[ \t]+push[ \t]+[A-Za-z0-9_./:=@ \t-]+$/.test(command)) return undefined;
  const args = command.split(/[ \t]+/).slice(2);
  if (args.length !== 3) return undefined;
  const lease = args.find((arg) => arg.startsWith('--force-with-lease='));
  const match = lease?.match(
    /^--force-with-lease=(refs\/heads\/[A-Za-z0-9_][A-Za-z0-9_./-]*):([a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
  );
  if (!match) return undefined;
  const [remote, refspec] = args.filter((arg) => arg !== lease);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(remote ?? '')) return undefined;
  const destination = refspec?.match(
    /^(HEAD|refs\/heads\/[A-Za-z0-9_][A-Za-z0-9_./-]*):(refs\/heads\/[A-Za-z0-9_][A-Za-z0-9_./-]*)$/,
  );
  if (!destination || destination[2] !== match[1]) return undefined;
  return { remote: remote!, ref: match[1]!, sha: match[2]! };
}

function unwrapCommand(tokens: string[]): string[] {
  let index = 0;
  while (['command', 'env', 'sudo'].includes(tokens[index] ?? '')) {
    index++;
    while (tokens[index]?.startsWith('-')) index++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index++;
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index++;
  return tokens.slice(index);
}

function isForcePush(args: string[]): boolean {
  const pushIndex = args.indexOf('push');
  return (
    pushIndex >= 0 &&
    args
      .slice(pushIndex + 1)
      .some((arg) => arg === '-f' || arg.startsWith('--force') || arg.startsWith('+'))
  );
}

function hasRecursiveForce(args: string[]): boolean {
  const hasRecursive = args.some(
    (arg) => arg === '--recursive' || (/^-[^-]/.test(arg) && arg.includes('r')),
  );
  const hasForce = args.some(
    (arg) => arg === '--force' || (/^-[^-]/.test(arg) && arg.includes('f')),
  );
  return hasRecursive && hasForce;
}

function isProductionKubectlMutation(args: string[]): boolean {
  const mutating = args.some((arg) =>
    ['apply', 'delete', 'patch', 'replace', 'rollout', 'scale'].includes(arg),
  );
  return mutating && hasProductionTarget(args);
}

function isProductionTerraformMutation(args: string[]): boolean {
  const mutating = args.some((arg) => ['apply', 'destroy', 'import', 'taint'].includes(arg));
  return mutating && args.some((arg) => /prod(?:uction)?/i.test(arg));
}

function hasProductionTarget(args: string[]): boolean {
  return args.some((arg) => /prod(?:uction)?/i.test(arg));
}
