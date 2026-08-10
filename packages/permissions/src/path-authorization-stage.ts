import { access, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  CommandPolicyFact,
  CommandPolicyFinding,
  CommandPolicyStage,
  CommandPolicyStageContext,
  CommandPolicyStageResult,
} from '@chimera/core';

export class PathAuthorizationStage implements CommandPolicyStage {
  readonly id = 'path_authorization';

  async evaluate(context: CommandPolicyStageContext): Promise<CommandPolicyStageResult> {
    const effects = context.facts.filter(isShellEffect);
    const findings: CommandPolicyFinding[] = [];

    for (const effect of effects) {
      const resolvedPath = await resolveEffectPath(effect.path, context.cwd, context.home);
      const roots = effect.operation === 'read' ? context.roots.read : context.roots.write;
      if (roots.some((root) => contains(root, resolvedPath))) continue;
      const requiredGrant = effect.operation === 'read' ? 'read' : 'write';
      findings.push({
        kind: 'path',
        stageId: this.id,
        operation: effect.operation,
        path: effect.path,
        resolvedPath,
        requiredGrant,
        message: `${effect.operation} target is outside allowed ${requiredGrant} directories`,
      });
    }

    if (findings.length === 0) return { status: 'pass' };
    const proposal = await proposeGrant(findings, context.home);
    return {
      status: 'findings',
      findings,
      ...(proposal ? { grantProposal: proposal } : {}),
    };
  }
}

function isShellEffect(
  fact: CommandPolicyFact,
): fact is Extract<CommandPolicyFact, { kind: 'shell_effect' }> {
  return fact.kind === 'shell_effect';
}

async function resolveEffectPath(path: string, cwd: string, home: string): Promise<string> {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const ancestor = await nearestExistingAncestor(dirname(absolute));
    return join(await realpath(ancestor), relative(ancestor, absolute));
  }
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return candidate;
      candidate = parent;
    }
  }
}

function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function proposeGrant(
  findings: CommandPolicyFinding[],
  home: string,
): Promise<{ id: string; kind: 'read' | 'write'; path: string } | undefined> {
  const pathFindings = findings.filter(
    (finding): finding is Extract<CommandPolicyFinding, { kind: 'path' }> =>
      Boolean(finding.kind === 'path' && finding.resolvedPath),
  );
  const paths = await Promise.all(
    pathFindings.map(async (finding) => {
      const resolvedPath = finding.resolvedPath ?? finding.path;
      const pathStat = await stat(resolvedPath).catch(() => null);
      return {
        kind: finding.requiredGrant,
        path: pathStat?.isDirectory() ? resolvedPath : dirname(resolvedPath),
      };
    }),
  );
  if (paths.length === 0) return undefined;
  const first = paths[0];
  if (!first || paths.some((entry) => entry.kind !== first.kind || entry.path !== first.path)) {
    return undefined;
  }
  if (first.path === '/' || first.path === home) return undefined;
  return {
    id: `${first.kind}:${first.path}`,
    kind: first.kind,
    path: first.path,
  };
}
