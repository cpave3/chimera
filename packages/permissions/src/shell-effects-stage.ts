import type {
  CommandPolicyFact,
  CommandPolicyStage,
  CommandPolicyStageContext,
  CommandPolicyStageResult,
} from '@chimera/core';
import type { ShellCommandParser } from './types';

const READ_COMMANDS = new Set([
  'cat',
  'head',
  'less',
  'more',
  'readlink',
  'realpath',
  'stat',
  'tail',
  'wc',
]);
const SEARCH_COMMANDS = new Set(['grep', 'rg']);
const WRITE_COMMANDS = new Set(['mkdir', 'touch']);
const DELETE_COMMANDS = new Set(['rm', 'rmdir']);
const NO_PATH_COMMANDS = new Set([
  'date',
  'echo',
  'git',
  'hostname',
  'printf',
  'pwd',
  'uname',
  'which',
  'whoami',
]);

export class ShellEffectsStage implements CommandPolicyStage {
  readonly id = 'shell_effects';

  constructor(private readonly parser: ShellCommandParser) {}

  async evaluate(context: CommandPolicyStageContext): Promise<CommandPolicyStageResult> {
    const analysis = await this.parser.parse(context.command);

    if (analysis.flags.includes('chained_command')) {
      return this.unresolved('compound commands require complete effect analysis');
    }
    if (
      (context.command.match(/(?:^|[^>])>(?!>)/g)?.length ?? 0) +
        (context.command.match(/>>/g)?.length ?? 0) >
      1
    ) {
      return this.unresolved('multiple redirects require complete effect analysis');
    }
    if (analysis.flags.some((flag) => flag.startsWith('uses_var:'))) {
      return this.unresolved('filesystem effect depends on variable expansion');
    }
    if (/\$\(|`|<\(|>\(|\beval\b|\bsource\b|(^|[;&|]\s*)\.\s+/.test(context.command)) {
      return this.unresolved('filesystem effect depends on dynamic shell evaluation');
    }

    const executable = analysis.executable?.replace(/^.*\//, '');
    if (!executable) return this.unresolved('command executable could not be resolved');
    if (executable === 'git' && !isReadOnlyGit(analysis.args, analysis.flags)) {
      return this.unresolved('unsupported or path-changing git invocation');
    }

    const facts: CommandPolicyFact[] = [];
    if (analysis.hasRedirect) {
      const redirectPath = analysis.paths.at(-1);
      if (!redirectPath) return this.unresolved('redirect target could not be resolved');
      facts.push({ kind: 'shell_effect', operation: 'write', path: redirectPath });
    }

    const operands = analysis.args.filter((argument) => argument !== redirectPath(analysis));
    if (READ_COMMANDS.has(executable)) {
      facts.push(...operands.map((path) => this.effect('read', path)));
    } else if (SEARCH_COMMANDS.has(executable)) {
      const searchPaths = analysis.paths.length > 0 ? analysis.paths : ['.'];
      facts.push(...searchPaths.map((path) => this.effect('read', path)));
    } else if (WRITE_COMMANDS.has(executable)) {
      facts.push(...operands.map((path) => this.effect('write', path)));
    } else if (DELETE_COMMANDS.has(executable)) {
      facts.push(...operands.map((path) => this.effect('delete', path)));
    } else if (!NO_PATH_COMMANDS.has(executable)) {
      return this.unresolved(`unsupported executable: ${executable}`);
    }

    return { status: 'pass', facts: deduplicateEffects(facts) };
  }

  private effect(operation: 'read' | 'write' | 'delete', path: string): CommandPolicyFact {
    return { kind: 'shell_effect', operation, path };
  }

  private unresolved(message: string): CommandPolicyStageResult {
    return {
      status: 'findings',
      findings: [{ kind: 'unresolved', stageId: this.id, message }],
    };
  }
}

function isReadOnlyGit(args: string[], flags: string[]): boolean {
  const subcommand = args[0];
  if (!subcommand || !['branch', 'log', 'status'].includes(subcommand)) return false;
  if (args.length !== 1) return false;
  const safeFlags: Record<string, Set<string>> = {
    branch: new Set(['-a', '--all', '-r', '--remotes', '-v', '--verbose']),
    log: new Set(['--decorate', '--oneline', '--stat']),
    status: new Set(['--branch', '--porcelain', '--short']),
  };
  return flags.every((flag) => safeFlags[subcommand]?.has(flag));
}

function redirectPath(analysis: { hasRedirect: boolean; paths: string[] }): string | undefined {
  return analysis.hasRedirect ? analysis.paths.at(-1) : undefined;
}

function deduplicateEffects(facts: CommandPolicyFact[]): CommandPolicyFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    if (fact.kind !== 'shell_effect') return true;
    const key = `${fact.operation}:${fact.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
