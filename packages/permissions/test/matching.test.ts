import type { PermissionRequest, PermissionRule } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { matchRule } from '../src/matching';

function req(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'r',
    tool: 'bash',
    target: 'host',
    command: 'git push origin main',
    cwd: '/tmp',
    ...overrides,
  };
}

function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    tool: 'bash',
    target: 'host',
    pattern: 'git push *',
    patternKind: 'glob',
    decision: 'allow',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('matchRule', () => {
  it('returns null when no rule matches', () => {
    expect(matchRule(req(), [rule({ pattern: 'pnpm test' })])).toBeNull();
  });

  it('exact pattern matches only exactly', () => {
    const r = rule({ pattern: 'git push origin main', patternKind: 'exact' });
    expect(matchRule(req(), [r])?.decision).toBe('allow');
    expect(matchRule(req({ command: 'git push origin dev' }), [r])).toBeNull();
  });

  it('glob pattern matches via minimatch', () => {
    const r = rule({ pattern: 'git push *', patternKind: 'glob' });
    expect(matchRule(req({ command: 'git push origin main' }), [r])).not.toBeNull();
    expect(matchRule(req({ command: 'git status' }), [r])).toBeNull();
  });

  it('deny wins over allow', () => {
    const allow = rule({ pattern: 'git *', decision: 'allow' });
    const deny = rule({ pattern: 'git push *', decision: 'deny' });
    const m = matchRule(req(), [allow, deny]);
    expect(m?.decision).toBe('deny');
  });

  it('longer pattern wins among same-decision rules', () => {
    const a = rule({ pattern: 'git *', decision: 'allow' });
    const b = rule({ pattern: 'git push *', decision: 'allow' });
    const m = matchRule(req(), [a, b]);
    expect(m?.pattern).toBe('git push *');
  });

  it('most recent wins among otherwise-equal rules', () => {
    const old = rule({ pattern: 'git *', createdAt: 100 });
    const fresh = rule({ pattern: 'git *', createdAt: 200 });
    const m = matchRule(req({ command: 'git status' }), [old, fresh]);
    expect(m?.createdAt).toBe(200);
  });

  it('does not match when tool differs', () => {
    expect(matchRule(req(), [rule({ tool: 'other' })])).toBeNull();
  });
});
