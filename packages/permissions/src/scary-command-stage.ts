import type {
  CommandPolicyStage,
  CommandPolicyStageContext,
  CommandPolicyStageResult,
} from '@chimera/core';

export interface ScaryCommandMatch {
  ruleId: string;
  message: string;
}

export function matchScaryCommand(command: string): ScaryCommandMatch | undefined {
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
