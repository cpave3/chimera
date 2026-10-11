import { describe, expect, it } from 'vitest';
import { applyAllowlist, expandAllowlist } from '../src/system-prompt';

describe('applyAllowlist', () => {
  const allow = (...names: string[]) => new Set(names);

  it('returns every tool when there is no allowlist', () => {
    const tools = { bash: 1, read: 2 };
    expect(applyAllowlist(tools, undefined)).toBe(tools);
  });

  it('keeps only the listed tools', () => {
    expect(
      Object.keys(applyAllowlist({ bash: 1, read: 2, grep: 3 }, allow('read', 'grep'))),
    ).toEqual(['read', 'grep']);
  });

  it('admits the codex-shape names for a list written with native names', () => {
    const codexTools = { bash: 1, read: 2, find: 3, ls: 4, grep: 5 };
    expect(Object.keys(applyAllowlist(codexTools, allow('read', 'glob', 'grep'))).sort()).toEqual([
      'find',
      'grep',
      'ls',
      'read',
    ]);
  });

  it('admits apply_patch where edit is allowed', () => {
    const patchTools = { read: 1, write: 2, apply_patch: 3 };
    expect(Object.keys(applyAllowlist(patchTools, allow('read', 'edit'))).sort()).toEqual([
      'apply_patch',
      'read',
    ]);
  });

  it('does not admit an edit tool for a read-only list', () => {
    const patchTools = { read: 1, apply_patch: 3, find: 4 };
    expect(Object.keys(applyAllowlist(patchTools, allow('read', 'glob')))).toEqual([
      'read',
      'find',
    ]);
  });
});

describe('expandAllowlist', () => {
  it('reports which listed names no registered tool satisfies', () => {
    const { missing } = expandAllowlist(new Set(['read', 'glob', 'nonesuch']), ['read', 'find']);
    expect(missing).toEqual(['nonesuch']);
  });
});
