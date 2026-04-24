import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRule } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuleStore } from '../src/rule-store';

function makeRule(pattern: string, decision: 'allow' | 'deny' = 'allow'): PermissionRule {
  return {
    tool: 'bash',
    target: 'host',
    pattern,
    patternKind: 'glob',
    decision,
    createdAt: Date.now(),
  };
}

describe('RuleStore', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-rules-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('session rules do not touch disk', () => {
    const store = new RuleStore(cwd);
    store.add(makeRule('foo *'), 'session');
    expect(() => readFileSync(join(cwd, '.chimera', 'permissions.json'))).toThrow();
  });

  it('project rules create .chimera/permissions.json on first add', () => {
    const store = new RuleStore(cwd);
    const r = makeRule('pnpm test *');
    store.add(r, 'project');
    const parsed = JSON.parse(
      readFileSync(join(cwd, '.chimera', 'permissions.json'), 'utf8'),
    );
    expect(parsed.version).toBe(1);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].pattern).toBe('pnpm test *');
  });

  it('all() returns session rules then project rules', () => {
    const store = new RuleStore(cwd);
    store.add(makeRule('a'), 'session');
    store.add(makeRule('b'), 'project');
    const all = store.all();
    expect(all.map((r) => r.pattern)).toEqual(['a', 'b']);
  });

  it('removeAt rewrites project file atomically', () => {
    const store = new RuleStore(cwd);
    store.add(makeRule('a'), 'project');
    store.add(makeRule('b'), 'project');
    store.removeAt(0); // removes 'a' from project rules
    const parsed = JSON.parse(
      readFileSync(join(cwd, '.chimera', 'permissions.json'), 'utf8'),
    );
    expect(parsed.rules.map((r: PermissionRule) => r.pattern)).toEqual(['b']);
  });

  it('persists across instantiation', () => {
    const s1 = new RuleStore(cwd);
    s1.add(makeRule('persist-me'), 'project');

    const s2 = new RuleStore(cwd);
    expect(s2.all().map((r) => r.pattern)).toEqual(['persist-me']);
  });
});
