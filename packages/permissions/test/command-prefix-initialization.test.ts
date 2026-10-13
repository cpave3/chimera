import { afterEach, describe, expect, it, vi } from 'vitest';
import * as TreeSitter from 'web-tree-sitter';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('matchesCommandPrefix initialization', () => {
  it('propagates parser runtime initialization failures even for invalid input', async () => {
    vi.resetModules();
    const failure = new Error('runtime initialization failed');
    const initialize = vi.spyOn(TreeSitter.Parser, 'init').mockRejectedValueOnce(failure);
    const { matchesCommandPrefix } = await import('../src/command-prefix');

    await expect(matchesCommandPrefix('', '')).rejects.toBe(failure);
    await expect(matchesCommandPrefix('legato plan', 'legato')).rejects.toBe(failure);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('propagates grammar loading failures', async () => {
    vi.resetModules();
    const failure = new Error('grammar loading failed');
    vi.spyOn(TreeSitter.Language, 'load').mockRejectedValueOnce(failure);
    const { matchesCommandPrefix } = await import('../src/command-prefix');

    await expect(matchesCommandPrefix('legato plan', 'legato')).rejects.toBe(failure);
  });
});
