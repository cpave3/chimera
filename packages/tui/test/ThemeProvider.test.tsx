import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import React, { useContext } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ThemeContext,
  ThemeProvider,
  useTheme,
  useThemeContext,
} from '../src/theme/ThemeProvider';
import { defaultTheme } from '../src/theme/tokens';
import type { Theme } from '../src/theme/types';

function TestComponent(): React.ReactElement {
  const theme = useTheme();
  return <Text>{theme.accent.primary}</Text>;
}

describe('ThemeProvider', () => {
  it('provides default theme via useTheme', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>,
    );
    expect(lastFrame()).toContain('cyan');
  });

  it('provides custom theme via useTheme', () => {
    const customTheme: Theme = {
      ...defaultTheme,
      accent: { ...defaultTheme.accent, primary: 'red' },
    };
    const { lastFrame } = render(
      <ThemeProvider theme={customTheme}>
        <TestComponent />
      </ThemeProvider>,
    );
    expect(lastFrame()).toContain('red');
  });
});

describe('useTheme', () => {
  it('provides default theme when used without provider', () => {
    // useTheme returns default theme if no provider (fallback behavior)
    const { lastFrame } = render(<TestComponent />);
    expect(lastFrame()).toContain('cyan');
  });
});

describe('ThemeContext.isUserTheme', () => {
  function FlagProbe(): React.ReactElement {
    const ctx = useContext(ThemeContext);
    return <Text>{ctx.isUserTheme ? 'user' : 'default'}</Text>;
  }

  it('reflects isUserTheme=true', () => {
    const { lastFrame } = render(
      <ThemeProvider theme={defaultTheme} isUserTheme>
        <FlagProbe />
      </ThemeProvider>,
    );
    expect(lastFrame()).toContain('user');
  });

  it('reflects isUserTheme=false (default)', () => {
    const { lastFrame } = render(
      <ThemeProvider theme={defaultTheme}>
        <FlagProbe />
      </ThemeProvider>,
    );
    expect(lastFrame()).toContain('default');
  });
});

// reload() is the live-update mechanism /theme <name> calls after writing
// the file. The themePath prop on ThemeProvider exists specifically so this
// path can be exercised against a tempfile without touching ~/.chimera/.
describe('ThemeProvider.reload', () => {
  let tmpDir: string;
  let themePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chimera-provider-reload-'));
    themePath = join(tmpDir, 'theme.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function ReloadProbe({
    onReady,
  }: {
    onReady: (reload: () => void) => void;
  }): React.ReactElement {
    const ctx = useThemeContext();
    React.useEffect(() => {
      onReady(ctx.reload);
    }, [ctx.reload, onReady]);
    return (
      <Text>
        {ctx.theme.accent.primary}|{ctx.activeName ?? 'none'}
      </Text>
    );
  }

  it('re-reads theme.json from disk and updates the live theme', async () => {
    let reload: (() => void) | undefined;
    const { lastFrame } = render(
      <ThemeProvider themePath={themePath}>
        <ReloadProbe onReady={(r) => (reload = r)} />
      </ThemeProvider>,
    );

    // Default theme initially — no theme.json on disk yet.
    expect(lastFrame()).toContain(`${defaultTheme.accent.primary}|none`);

    writeFileSync(
      themePath,
      JSON.stringify({
        _themeName: 'fixture',
        accent: { primary: '#abcdef' },
      }),
    );
    reload!();
    await new Promise((r) => setImmediate(r));

    expect(lastFrame()).toContain('#abcdef|fixture');
  });

  it('falls back to the base theme when the file disappears between reloads', async () => {
    writeFileSync(
      themePath,
      JSON.stringify({ accent: { primary: '#111111' } }),
    );

    let reload: (() => void) | undefined;
    const { lastFrame } = render(
      <ThemeProvider themePath={themePath}>
        <ReloadProbe onReady={(r) => (reload = r)} />
      </ThemeProvider>,
    );

    // First render uses ThemeProvider's initial-state defaults — reload picks
    // up the on-disk file.
    reload!();
    await new Promise((r) => setImmediate(r));
    expect(lastFrame()).toContain('#111111');

    rmSync(themePath);
    reload!();
    await new Promise((r) => setImmediate(r));
    expect(lastFrame()).toContain(`${defaultTheme.accent.primary}|none`);
  });
});
