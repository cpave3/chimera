import { homedir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Header, type HeaderProps } from '../src/Header';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { defaultTheme } from '../src/theme/tokens';

function banner(overrides: Partial<HeaderProps> = {}): string {
  const { lastFrame, unmount } = render(
    <ThemeProvider theme={defaultTheme}>
      <Header
        version="0.1.0"
        modelRef="anthropic/claude-opus-4-7"
        cwd={join(homedir(), 'Projects', 'chimera')}
        sessionId="01JABCDEFGH12345678"
        mode="build"
        sandboxMode="off"
        skillCount={0}
        commandCount={0}
        {...overrides}
      />
    </ThemeProvider>,
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

describe('start banner', () => {
  it('states the model, the directory, the session, the mode and the sandbox', () => {
    const out = banner();

    expect(out).toContain('Chimera');
    expect(out).toContain('v0.1.0');
    expect(out).toMatch(/model\s+anthropic\/claude-opus-4-7/);
    expect(out).toMatch(/cwd\s+~\/Projects\/chimera/);
    expect(out).toMatch(/session\s+12345678 · mode build · sandbox off/);
  });

  it('says what was loaded when there is something to say', () => {
    expect(banner()).not.toContain('loaded');
    expect(banner({ skillCount: 12, commandCount: 1 })).toMatch(/loaded\s+12 skills · 1 command/);
  });
});
