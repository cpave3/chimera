import type { PermissionRequest, PermissionRule } from '@chimera/core';
import { minimatch } from 'minimatch';
import { matchesCommandPrefix } from './command-prefix';

async function matches(rule: PermissionRule, req: PermissionRequest): Promise<boolean> {
  if (rule.tool !== req.tool) return false;
  if (rule.target !== req.target) return false;
  if (rule.decision === 'allow' && rule.allowUnsandboxed && !req.unsandboxed) return false;
  if (rule.patternKind === 'exact') {
    return rule.pattern === req.command;
  }
  if (rule.patternKind === 'prefix') {
    return req.tool === 'bash' && matchesCommandPrefix(req.command, rule.pattern);
  }
  return rule.patternKind === 'glob' && minimatch(req.command, rule.pattern);
}

export async function matchRule(
  req: PermissionRequest,
  rules: readonly PermissionRule[],
): Promise<PermissionRule | null> {
  const matched = await Promise.all(rules.map((rule) => matches(rule, req)));
  const candidates = rules.filter((_, index) => matched[index]);
  if (candidates.length === 0) return null;

  // Tier 1: deny wins.
  const denies = candidates.filter((c) => c.decision === 'deny');
  const pool = denies.length > 0 ? denies : candidates;

  // Tier 2: longer pattern wins.
  let best = pool[0]!;
  for (const r of pool) {
    if (r.pattern.length > best.pattern.length) {
      best = r;
    } else if (r.pattern.length === best.pattern.length) {
      // Tier 3: most recent wins.
      if (r.createdAt >= best.createdAt) best = r;
    }
  }
  return best;
}
