import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Mounted, mount } from './harness';

let mounted: Mounted | undefined;
let home: string;
let originalHome: string | undefined;

// /theme reads and writes ~/.chimera/{theme.json,themes/}: HOME points at a
// temporary directory so the tests never touch the user's own theme.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'chimera-tui-theme-'));
  mkdirSync(join(home, '.chimera'), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('/theme', () => {
  it('lists the shipped themes when none is applied', async () => {
    mounted = await mount();
    await mounted.keys('/theme\r');
    const screen = mounted.screen();

    expect(screen).toContain('   note  themes:');
    expect(screen).toMatch(/^ {9} {2}chimera$/m);
    expect(screen).toMatch(/^ {9} {2}default$/m);
    expect(screen).not.toContain('cyberpunk');
    expect(screen).toContain('Use /theme <name> to apply.');
  });

  it('applies a shipped theme into a flat theme.json with its name', async () => {
    mounted = await mount();
    await mounted.keys('/theme chimera\r');

    expect(mounted.screen()).toContain("   note  theme: applied 'chimera' (builtin).");
    const written = JSON.parse(readFileSync(join(home, '.chimera', 'theme.json'), 'utf-8'));
    expect(written._themeName).toBe('chimera');
    expect(written.accent).toBe('#b79cf7');
  });

  it('marks the applied theme with a *', async () => {
    mounted = await mount();
    await mounted.keys('/theme chimera\r');
    await mounted.keys('/theme\r');

    expect(mounted.screen()).toMatch(/^ {9}\* chimera$/m);
    expect(mounted.screen()).toMatch(/^ {9} {2}default$/m);
  });

  it('reports an unknown theme', async () => {
    mounted = await mount();
    await mounted.keys('/theme not-a-real-theme\r');

    expect(mounted.screen()).toContain("✗ error  /theme: unknown theme 'not-a-real-theme'.");
  });

  it('tags a theme from ~/.chimera/themes as the user’s', async () => {
    const themes = join(home, '.chimera', 'themes');
    mkdirSync(themes, { recursive: true });
    writeFileSync(join(themes, 'cyberpunk.json'), '{}');
    mounted = await mount();
    await mounted.keys('/theme\r');

    expect(mounted.screen()).toMatch(/^ {9} {2}cyberpunk \(user\)$/m);
  });
});
