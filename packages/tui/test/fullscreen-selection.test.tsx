import { describe, expect, it } from 'vitest';
import type { Region } from '../src/input/screen-selection';
import { mountFullscreen, plain, settle } from './fullscreen-helpers';

describe('mouse selection in the fullscreen layout', () => {
  it('keeps the transcript column and the panel apart as selectable regions', async () => {
    const reported: Region[][] = [];
    const { unmount } = mountFullscreen({
      onSelectableRegions: (regions) => reported.push(regions),
    });
    await settle();
    unmount();

    // 100 columns: the panel takes 32, and each column has two cells of padding.
    expect(reported.at(-1)).toEqual([
      { left: 2, right: 66 },
      { left: 71, right: 98 },
    ]);
  });

  it('has one region when the panel is hidden', async () => {
    const reported: Region[][] = [];
    const { unmount } = mountFullscreen({
      terminalSize: { columns: 80, rows: 24 },
      onSelectableRegions: (regions) => reported.push(regions),
    });
    await settle();
    unmount();

    expect(reported.at(-1)).toEqual([{ left: 2, right: 78 }]);
  });

  it('says how much was copied, in place of the key hints, for a moment', async () => {
    const { lastFrame, unmount, mouse } = mountFullscreen();
    await settle();

    mouse.emit({ kind: 'copied', characters: 124 });
    await settle();
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('copied 124 characters');
    expect(frame).not.toContain('? help');
  });

  it('ends the selection when the user types or scrolls', async () => {
    let cleared = 0;
    const { unmount, stdin, mouse } = mountFullscreen({
      screenSelection: { clear: () => cleared++ },
    });
    await settle();

    stdin.write('a');
    await settle();
    const afterKey = cleared;
    mouse.emit({ kind: 'wheel-up' });
    await settle();
    unmount();

    expect(afterKey).toBe(1);
    expect(cleared).toBe(2);
  });
});
