import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyThemeByName,
  getDefaultThemePath,
  listThemes,
  loadUserTheme,
  resolveTheme,
} from '../src/theme/loader';
import { BUILTIN_THEMES, THEME_TOKENS, type ThemeTokens } from '../src/theme/palette';
import { createStyle, detectColorLevel } from '../src/theme/style';

const ESC = '\x1b[';

/** The parameters of every SGR sequence in `text`. */
function sgrCodes(text: string): string[] {
  return text
    .split(ESC)
    .slice(1)
    .map((part) => part.slice(0, part.indexOf('m')));
}

describe('createStyle', () => {
  const theme: ThemeTokens = {
    ...BUILTIN_THEMES.default,
    accent: 'magenta',
    muted: 'brightBlack',
    info: '#7aa7ff',
  };

  it('maps ANSI colour names to 16-colour foreground SGR, closed by the foreground reset', () => {
    const style = createStyle(theme, 'truecolor');
    expect(style.fg('accent', 'hi')).toBe(`${ESC}35mhi${ESC}39m`);
    expect(style.fg('muted', 'hi')).toBe(`${ESC}90mhi${ESC}39m`);
  });

  it('maps hex to truecolor SGR', () => {
    expect(createStyle(theme, 'truecolor').fg('info', 'x')).toBe(
      `${ESC}38;2;122;167;255mx${ESC}39m`,
    );
  });

  it('maps hex to the nearest 256-colour entry without truecolor', () => {
    // #7aa7ff: 122,167,255 -> cube levels 135,175,255 -> 16 + 36*2 + 6*3 + 5 = 111
    expect(createStyle(theme, 'ansi256').fg('info', 'x')).toBe(`${ESC}38;5;111mx${ESC}39m`);
    // A grey lands on the grey ramp.
    expect(createStyle({ ...theme, info: '#5e5a6e' }, 'ansi256').fg('info', 'x')).toBe(
      `${ESC}38;5;241mx${ESC}39m`,
    );
  });

  it('maps hex to a 16-colour entry on a 16-colour terminal', () => {
    expect(createStyle({ ...theme, info: '#f08a8a' }, 'ansi16').fg('info', 'x')).toBe(
      `${ESC}91mx${ESC}39m`,
    );
  });

  it('nests: an inner style closes only its own attribute', () => {
    const style = createStyle(theme, 'truecolor');
    const line = style.bold(`a ${style.fg('accent', 'b')} c`);
    expect(line).toBe(`${ESC}1ma ${ESC}35mb${ESC}39m c${ESC}22m`);
  });

  it('leaves the default foreground alone', () => {
    expect(createStyle({ ...theme, text: 'default' }, 'truecolor').fg('text', 'x')).toBe('x');
  });

  it('under NO_COLOR draws no colour and keeps the hierarchy with bold and dim', () => {
    const style = createStyle(BUILTIN_THEMES.chimera, 'none');
    for (const token of THEME_TOKENS) {
      expect(sgrCodes(style.fg(token, 'x')).filter((code) => /^(3|4|9|10)\d/.test(code))).toEqual(
        [],
      );
    }
    expect(style.fg('muted', 'x')).toBe(`${ESC}2mx${ESC}22m`);
    expect(style.fg('accent', 'x')).toBe(`${ESC}1mx${ESC}22m`);
    expect(style.fg('text', 'x')).toBe('x');
    expect(style.diffBg('add', 'x')).toBe('x');
  });

  it('paints diff backgrounds only for a theme that sets them', () => {
    expect(createStyle(BUILTIN_THEMES.default, 'truecolor').diffBg('add', 'x')).toBe('x');
    const tinted = createStyle(BUILTIN_THEMES.chimera, 'truecolor');
    expect(tinted.hasDiffTints).toBe(true);
    expect(tinted.diffBg('add', 'x')).toBe(`${ESC}48;2;33;56;38mx${ESC}49m`);
    expect(tinted.diffBg('remove', 'x')).toBe(`${ESC}48;2;61;35;41mx${ESC}49m`);
  });

  it('never paints a background outside the diff tints', () => {
    const style = createStyle(BUILTIN_THEMES.chimera, 'truecolor');
    for (const token of THEME_TOKENS) {
      expect(sgrCodes(style.fg(token, 'x')).filter((code) => /^(4|10)\d/.test(code))).toEqual([]);
    }
  });
});

describe('detectColorLevel', () => {
  it('reads NO_COLOR, COLORTERM and TERM', () => {
    expect(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe('none');
    expect(detectColorLevel({ NO_COLOR: '', COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(detectColorLevel({ COLORTERM: '24bit' })).toBe('truecolor');
    expect(detectColorLevel({ TERM: 'tmux-256color' })).toBe('ansi256');
    expect(detectColorLevel({ TERM: 'xterm' })).toBe('ansi16');
  });
});

describe('the shipped themes', () => {
  it('default uses only the terminal palette', () => {
    for (const value of Object.values(BUILTIN_THEMES.default)) expect(value).not.toMatch(/^#/);
    expect(BUILTIN_THEMES.default.diffAddBg).toBeUndefined();
  });

  it('chimera sets every token as an explicit colour, with diff tints', () => {
    for (const token of THEME_TOKENS)
      expect(BUILTIN_THEMES.chimera[token]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('loadUserTheme', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chimera-theme-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (content: unknown) => {
    const path = join(dir, 'theme.json');
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    return path;
  };

  it('reports a missing file', () => {
    expect(loadUserTheme(join(dir, 'absent.json'))).toEqual({ kind: 'missing' });
  });

  it('reads flat tokens and the active name, ignoring _-prefixed notes', () => {
    const path = write({ _themeName: 'mine', _comment: 'note', accent: 'green', info: '#00AAFF' });
    expect(loadUserTheme(path)).toEqual({
      kind: 'ok',
      theme: { accent: 'green', info: '#00AAFF' },
      activeName: 'mine',
    });
  });

  it('refuses the old grouped format, naming the new tokens', () => {
    const result = loadUserTheme(write({ accent: { primary: 'red' }, status: { error: 'red' } }));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toMatch(/old/);
    for (const token of ['text', 'muted', 'dim', 'accent', 'diffAddBg', 'keyword']) {
      expect(result.message).toContain(token);
    }
  });

  it('refuses an unknown token and a value that is not a colour', () => {
    expect(loadUserTheme(write({ acent: 'red' }))).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/unknown token "acent"/),
    });
    expect(loadUserTheme(write({ accent: 'purpleish' }))).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/accent.*purpleish/),
    });
  });

  it('reports malformed JSON', () => {
    expect(loadUserTheme(write('{ "accent":'))).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/invalid JSON/),
    });
  });
});

describe('resolveTheme', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chimera-theme-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('merges a user theme over the default theme', () => {
    const themePath = join(dir, 'theme.json');
    writeFileSync(themePath, JSON.stringify({ accent: 'green' }));
    const resolved = resolveTheme({ themePath, env: { TERM: 'xterm' } });
    expect(resolved.tokens).toEqual({ ...BUILTIN_THEMES.default, accent: 'green' });
    expect(resolved.style.fg('accent', 'x')).toBe(`${ESC}32mx${ESC}39m`);
    expect(resolved.error).toBeUndefined();
  });

  it('falls back to the default theme and reports why when the file is bad', () => {
    const themePath = join(dir, 'theme.json');
    writeFileSync(themePath, JSON.stringify({ text: { primary: 'red' } }));
    const resolved = resolveTheme({ themePath, env: {} });
    expect(resolved.tokens).toEqual(BUILTIN_THEMES.default);
    expect(resolved.error).toMatch(/old/);
  });
});

describe('getDefaultThemePath', () => {
  it('is ~/.chimera/theme.json', () => {
    expect(getDefaultThemePath()).toBe(join(homedir(), '.chimera', 'theme.json'));
  });
});

describe('listThemes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chimera-theme-list-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists default and chimera plus user themes, marking the active one', () => {
    const presetsDir = join(dir, 'themes');
    mkdirSync(presetsDir);
    writeFileSync(join(presetsDir, 'mine.json'), '{}');
    const themePath = join(dir, 'theme.json');
    writeFileSync(themePath, JSON.stringify({ _themeName: 'chimera' }));
    expect(listThemes({ presetsDir, themePath })).toEqual([
      { name: 'chimera', source: 'builtin', active: true },
      { name: 'default', source: 'builtin', active: false },
      { name: 'mine', source: 'user', active: false },
    ]);
  });
});

describe('applyThemeByName', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chimera-theme-apply-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a builtin theme with its marker, and it reads back', () => {
    const themePath = join(dir, 'sub', 'theme.json');
    const applied = applyThemeByName('chimera', { presetsDir: join(dir, 'themes'), themePath });
    expect(applied.origin).toBe('builtin');
    const written = JSON.parse(readFileSync(themePath, 'utf-8'));
    expect(written._themeName).toBe('chimera');
    expect(written.accent).toBe(BUILTIN_THEMES.chimera.accent);
    expect(loadUserTheme(themePath)).toMatchObject({ kind: 'ok', activeName: 'chimera' });
  });

  it('prefers a user theme of the same name', () => {
    const presetsDir = join(dir, 'themes');
    mkdirSync(presetsDir);
    writeFileSync(join(presetsDir, 'chimera.json'), JSON.stringify({ accent: '#000000' }));
    const themePath = join(dir, 'theme.json');
    expect(applyThemeByName('chimera', { presetsDir, themePath }).origin).toBe('user');
    expect(JSON.parse(readFileSync(themePath, 'utf-8')).accent).toBe('#000000');
  });

  it('refuses a user theme in the old format', () => {
    const presetsDir = join(dir, 'themes');
    mkdirSync(presetsDir);
    writeFileSync(join(presetsDir, 'old.json'), JSON.stringify({ accent: { primary: 'red' } }));
    expect(() =>
      applyThemeByName('old', { presetsDir, themePath: join(dir, 'theme.json') }),
    ).toThrow(/old/);
  });

  it('throws on an unknown name', () => {
    expect(() =>
      applyThemeByName('cyberpunk', {
        presetsDir: join(dir, 'themes'),
        themePath: join(dir, 'theme.json'),
      }),
    ).toThrow(/unknown theme 'cyberpunk'/);
  });
});
