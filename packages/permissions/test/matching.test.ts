import type { PermissionRequest, PermissionRule } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { matchRule, trustedByList } from '../src/matching';

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
  it('returns null when no rule matches', async () => {
    expect(await matchRule(req(), [rule({ pattern: 'pnpm test' })])).toBeNull();
  });

  it('exact pattern matches only exactly', async () => {
    const r = rule({ pattern: 'git push origin main', patternKind: 'exact' });
    expect((await matchRule(req(), [r]))?.decision).toBe('allow');
    expect(await matchRule(req({ command: 'git push origin dev' }), [r])).toBeNull();
  });

  it('glob pattern matches via minimatch', async () => {
    const r = rule({ pattern: 'git push *', patternKind: 'glob' });
    expect(await matchRule(req({ command: 'git push origin main' }), [r])).not.toBeNull();
    expect(await matchRule(req({ command: 'git status' }), [r])).toBeNull();
  });

  it('deny wins over allow', async () => {
    const allow = rule({ pattern: 'git *', decision: 'allow' });
    const deny = rule({ pattern: 'git push *', decision: 'deny' });
    const m = await matchRule(req(), [allow, deny]);
    expect(m?.decision).toBe('deny');
  });

  it('longer pattern wins among same-decision rules', async () => {
    const a = rule({ pattern: 'git *', decision: 'allow' });
    const b = rule({ pattern: 'git push *', decision: 'allow' });
    const m = await matchRule(req(), [a, b]);
    expect(m?.pattern).toBe('git push *');
  });

  it('most recent wins among otherwise-equal rules', async () => {
    const old = rule({ pattern: 'git *', createdAt: 100 });
    const fresh = rule({ pattern: 'git *', createdAt: 200 });
    const m = await matchRule(req({ command: 'git status' }), [old, fresh]);
    expect(m?.createdAt).toBe(200);
  });

  it('does not match when tool differs', async () => {
    expect(await matchRule(req(), [rule({ tool: 'other' })])).toBeNull();
  });
});

describe('matchRule for MCP identities', () => {
  const mcpReq = (command: string) => req({ tool: 'mcp', command });
  const serverAllow = rule({ tool: 'mcp', pattern: 'burnlite/*', patternKind: 'glob' });

  it('a server glob matches only that server', async () => {
    expect((await matchRule(mcpReq('burnlite/create_note'), [serverAllow]))?.decision).toBe(
      'allow',
    );
    expect(await matchRule(mcpReq('other/create_note'), [serverAllow])).toBeNull();
    expect(await matchRule(mcpReq('burnlite-x/create_note'), [serverAllow])).toBeNull();
  });

  it('an exact deny beats a server glob allow', async () => {
    const deny = rule({
      tool: 'mcp',
      pattern: 'burnlite/delete_task',
      patternKind: 'exact',
      decision: 'deny',
    });
    expect((await matchRule(mcpReq('burnlite/delete_task'), [serverAllow, deny]))?.decision).toBe(
      'deny',
    );
  });
});

describe('trustedByList', () => {
  it('a plain name trusts only that tool', () => {
    expect(trustedByList('list_projects', ['list_projects'])).toBe(true);
    expect(trustedByList('create_task', ['list_projects'])).toBe(false);
  });

  it('a lone star trusts every tool', () => {
    expect(trustedByList('delete_task', ['*'])).toBe(true);
  });

  it('a glob trusts a family of tools', () => {
    expect(trustedByList('list_projects', ['list_*'])).toBe(true);
    expect(trustedByList('create_task', ['list_*'])).toBe(false);
  });

  it('an exclusion takes a tool back out of the list', () => {
    expect(trustedByList('create_task', ['*', '!delete_*'])).toBe(true);
    expect(trustedByList('delete_task', ['*', '!delete_*'])).toBe(false);
  });

  it('exclusions alone trust nothing', () => {
    expect(trustedByList('create_task', ['!delete_*'])).toBe(false);
  });

  it('an empty list trusts nothing', () => {
    expect(trustedByList('create_task', [])).toBe(false);
  });
});
