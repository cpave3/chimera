import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyThemeByName,
  buildTheme,
  deepMerge,
  getDefaultThemePath,
  listThemes,
  loadUserTheme,
  pickBaseTheme,
} from '../src/theme/loader';
import { BUILTIN_PRESETS } from '../src/theme/presets';
import { defaultTheme, plainTheme } from '../src/theme/tokens';
import type { PartialTheme, Theme } from '../src/theme/types';

describe('pickBaseTheme', () => {
  it('returns defaultTheme when NO_COLOR is unset', () => {
    expect(pickBaseTheme({})).toBe(defaultTheme);
  });

  it('returns defaultTheme when NO_COLOR is empty (per NO_COLOR spec)', () => {
    expect(pickBaseTheme({ NO_COLOR: '' })).toBe(defaultTheme);
  });

  it('returns plainTheme when NO_COLOR has any value', () => {
    expect(pickBaseTheme({ NO_COLOR: '1' })).toBe(plainTheme);
  });
});

describe('theme tokens', () => {
  it('defaultTheme has all required token groups', () => {
    expect(defaultTheme.base).toBeDefined();
    expect(defaultTheme.accent).toBeDefined();
    expect(defaultTheme.status).toBeDefined();
    expect(defaultTheme.text).toBeDefined();
    expect(defaultTheme.ui).toBeDefined();
  });

  it('defaultTheme has required tokens', () => {
    expect(defaultTheme.base.foreground).toBeDefined();
    expect(defaultTheme.accent.primary).toBeDefined();
    expect(defaultTheme.accent.secondary).toBeDefined();
    expect(defaultTheme.status.success).toBeDefined();
    expect(defaultTheme.status.warning).toBeDefined();
    expect(defaultTheme.status.error).toBeDefined();
    expect(defaultTheme.text.primary).toBeDefined();
    expect(defaultTheme.text.secondary).toBeDefined();
    expect(defaultTheme.text.muted).toBeDefined();
    expect(defaultTheme.ui.badge).toBeDefined();
    expect(defaultTheme.ui.accent).toBeDefined();
  });

  it('plainTheme has neutral values for all tokens', () => {
    expect(plainTheme.accent.primary).toBe('white');
    expect(plainTheme.status.error).toBe('white');
  });
});

describe('deepMerge', () => {
  const baseTheme: Theme = {
    base: { foreground: 'white' },
    accent: { primary: 'cyan', secondary: 'blue' },
    status: { success: 'green', warning: 'yellow', error: 'red' },
    text: { primary: 'white', secondary: 'gray', muted: 'gray' },
    ui: { badge: 'yellow', accent: 'magenta' },
  };

  it('returns base theme when user theme is empty', () => {
    const result = deepMerge(baseTheme, {});
    expect(result).toEqual(baseTheme);
  });

  it('overrides single token group', () => {
    const userTheme: PartialTheme = {
      accent: { primary: 'red' },
    };
    const result = deepMerge(baseTheme, userTheme);
    expect(result.accent.primary).toBe('red');
    expect(result.accent.secondary).toBe('blue'); // unchanged
  });

  it('overrides multiple token groups', () => {
    const userTheme: PartialTheme = {
      accent: { primary: 'green' },
      status: { error: 'magenta' },
    };
    const result = deepMerge(baseTheme, userTheme);
    expect(result.accent.primary).toBe('green');
    expect(result.status.error).toBe('magenta');
    expect(result.accent.secondary).toBe('blue'); // unchanged
  });

  it('preserves base theme structure', () => {
    const userTheme: PartialTheme = {
      text: { primary: 'cyan' },
    };
    const result = deepMerge(baseTheme, userTheme);
    // All other groups should be preserved
    expect(result.base).toEqual(baseTheme.base);
    expect(result.status).toEqual(baseTheme.status);
    expect(result.ui).toEqual(baseTheme.ui);
  });

  it('ignores group values that are not objects', () => {
    const userTheme = { accent: 'red' } as unknown as PartialTheme;
    const result = deepMerge(baseTheme, userTheme);
    expect(result.accent).toEqual(baseTheme.accent);
  });
});

describe('loadUserTheme', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'theme-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports missing for non-existent path', () => {
    const result = loadUserTheme(join(tmpDir, 'no-such-file.json'));
    expect(result).toEqual({ kind: 'missing' });
  });

  it('reports ok with parsed theme for valid JSON', () => {
    const path = join(tmpDir, 'theme.json');
    writeFileSync(path, JSON.stringify({ accent: { primary: 'magenta' } }));
    const result = loadUserTheme(path);
    expect(result).toEqual({ kind: 'ok', theme: { accent: { primary: 'magenta' } } });
  });

  it('reports error for malformed JSON', () => {
    const path = join(tmpDir, 'theme.json');
    writeFileSync(path, '{ "accent":');
    const result = loadUserTheme(path);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toMatch(/invalid JSON/i);
  });

  it('reports error for non-object root', () => {
    const path = join(tmpDir, 'theme.json');
    writeFileSync(path, '"hello"');
    const result = loadUserTheme(path);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toMatch(/object/i);
  });

  it('strips unknown top-level keys (e.g. _comment)', () => {
    const path = join(tmpDir, 'theme.json');
    writeFileSync(path, JSON.stringify({ _comment: 'A note', accent: { primary: 'red' } }));
    const result = loadUserTheme(path);
    expect(result).toEqual({ kind: 'ok', theme: { accent: { primary: 'red' } } });
  });
});

describe('buildTheme', () => {
  const baseTheme: Theme = {
    base: { foreground: 'white' },
    accent: { primary: 'cyan', secondary: 'blue' },
    status: { success: 'green', warning: 'yellow', error: 'red' },
    text: { primary: 'white', secondary: 'gray', muted: 'gray' },
    ui: { badge: 'yellow', accent: 'magenta' },
  };

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'theme-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns base theme when no user theme file exists', () => {
    const result = buildTheme(baseTheme, join(tmpDir, 'absent.json'));
    expect(result).toEqual(baseTheme);
  });

  it('merges a user partial on top of the base', () => {
    const path = join(tmpDir, 'theme.json');
    writeFileSync(
      path,
      JSON.stringify({ accent: { primary: 'magenta' }, status: { error: 'redBright' } }),
    );
    const result = buildTheme(baseTheme, path);
    expect(result.accent.primary).toBe('magenta');
    expect(result.accent.secondary).toBe('blue');
    expect(result.status.error).toBe('redBright');
    expect(result.status.success).toBe('green');
    expect(result.ui).toEqual(baseTheme.ui);
  });
});

describe('getDefaultThemePath', () => {
  it('resolves to ~/.chimera/theme.json (matches the rest of the app)', () => {
    expect(getDefaultThemePath()).toBe(join(homedir(), '.chimera', 'theme.json'));
  });
});

describe('listThemes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chimera-theme-list-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists all bundled presets when no user dir is present', () => {
    const themePath = join(dir, 'theme.json');
    const presetsDir = join(dir, 'absent-themes');
    const list = listThemes({ presetsDir, themePath });
    const names = list.map((t) => t.name);
    for (const builtin of Object.keys(BUILTIN_PRESETS)) {
      expect(names).toContain(builtin);
    }
    expect(list.every((t) => !t.active)).toBe(true);
  });

  it('marks the active theme based on _themeName in theme.json', () => {
    const themePath = join(dir, 'theme.json');
    writeFileSync(themePath, JSON.stringify({ _themeName: 'cyberpunk' }));
    const presetsDir = join(dir, 'absent-themes');
    const list = listThemes({ presetsDir, themePath });
    const cp = list.find((t) => t.name === 'cyberpunk')!;
    expect(cp.active).toBe(true);
    expect(list.filter((t) => t.active)).toHaveLength(1);
  });

  it('user-dir entries shadow builtins of the same name', () => {
    const presetsDir = join(dir, 'themes');
    mkdirSync(presetsDir);
    writeFileSync(join(presetsDir, 'cyberpunk.json'), '{}');
    writeFileSync(join(presetsDir, 'mine.json'), '{}');
    const list = listThemes({
      presetsDir,
      themePath: join(dir, 'theme.json'),
    });
    expect(list.find((t) => t.name === 'cyberpunk')!.source).toBe('user');
    expect(list.find((t) => t.name === 'mine')!.source).toBe('user');
    expect(list.find((t) => t.name === 'tokyo-night-moon')!.source).toBe('builtin');
  });
});

describe('applyThemeByName', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chimera-theme-apply-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the chosen builtin to theme.json with a _themeName marker', () => {
    const themePath = join(dir, 'sub', 'theme.json');
    const presetsDir = join(dir, 'themes');
    const r = applyThemeByName('cyberpunk', { presetsDir, themePath });
    expect(r.origin).toBe('builtin');
    const written = JSON.parse(readFileSync(themePath, 'utf-8'));
    expect(written._themeName).toBe('cyberpunk');
    expect(written.accent.primary).toBe(BUILTIN_PRESETS.cyberpunk!.accent!.primary);
  });

  it('prefers a user preset over a builtin of the same name', () => {
    const themePath = join(dir, 'theme.json');
    const presetsDir = join(dir, 'themes');
    mkdirSync(presetsDir);
    writeFileSync(
      join(presetsDir, 'cyberpunk.json'),
      JSON.stringify({ accent: { primary: '#000000' } }),
    );
    const r = applyThemeByName('cyberpunk', { presetsDir, themePath });
    expect(r.origin).toBe('user');
    const written = JSON.parse(readFileSync(themePath, 'utf-8'));
    expect(written.accent.primary).toBe('#000000');
  });

  it('throws on unknown name', () => {
    expect(() =>
      applyThemeByName('does-not-exist', {
        presetsDir: join(dir, 'themes'),
        themePath: join(dir, 'theme.json'),
      }),
    ).toThrow(/unknown theme/);
  });

  it('round-trip: applied theme can be read back via loadUserTheme', () => {
    const themePath = join(dir, 'theme.json');
    applyThemeByName('tokyo-night-moon', {
      presetsDir: join(dir, 'themes'),
      themePath,
    });
    const r = loadUserTheme(themePath);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.activeName).toBe('tokyo-night-moon');
      expect(r.theme.accent?.primary).toBe(BUILTIN_PRESETS['tokyo-night-moon']!.accent!.primary);
    }
  });
});
