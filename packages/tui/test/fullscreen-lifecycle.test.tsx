import { describe, expect, it } from 'vitest';
import { mountFullscreen, plain, settle, type } from './fullscreen-helpers';

describe('fullscreen handoff', () => {
  it('gives the screen to the editor and takes it back with the edited prompt', async () => {
    const calls: string[] = [];
    const { lastFrame, unmount, stdin } = mountFullscreen({
      screen: { leave: () => calls.push('leave'), enter: () => calls.push('enter') },
      openInEditor: async ({ initialText }) => {
        calls.push(`edit:${initialText}`);
        return { ok: true, text: 'edited in vim' };
      },
    });
    await settle();
    await type(stdin, 'draft');
    stdin.write('\x07');
    await settle(80);
    const frame = plain(lastFrame());
    unmount();

    expect(calls).toEqual(['leave', 'edit:draft', 'enter']);
    expect(frame).toContain('› edited in vim');
    expect(frame).toContain('BUILD');
  });

  it('takes the screen back when the pager fails to start', async () => {
    const calls: string[] = [];
    const { lastFrame, unmount, stdin } = mountFullscreen({
      screen: { leave: () => calls.push('leave'), enter: () => calls.push('enter') },
      openInPager: async () => ({ ok: false, reason: 'less: not found' }),
    });
    await settle();
    stdin.write('\x14');
    await settle(80);
    const frame = plain(lastFrame());
    unmount();

    expect(calls).toEqual(['leave', 'enter']);
    expect(frame).toContain('transcript: less: not found');
  });
});

describe('fullscreen exit', () => {
  it('draws nothing as its last frame, so the terminal is left as it was', async () => {
    const { lastFrame, unmount, stdin } = mountFullscreen();
    await settle();
    expect(plain(lastFrame())).toContain('message chimera');
    stdin.write('\x04');
    await settle(80);
    const last = plain(lastFrame());
    unmount();

    expect(last.trim()).toBe('');
  });
});

describe('the session on screen', () => {
  it('is reported at start', async () => {
    const seen: string[] = [];
    const { unmount } = mountFullscreen({ onActiveSessionChange: (id) => seen.push(id) });
    await settle();
    unmount();

    expect(seen).toEqual(['01ABCDEFGH8AWWBRGC']);
  });
});
