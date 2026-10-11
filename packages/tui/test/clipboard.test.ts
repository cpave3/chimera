import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ClipboardImage,
  clipboardCommands,
  clipboardSequence,
  isImageFile,
  saveImageToSession,
  writeClipboardText,
} from '../src/clipboard';

const mockImage: ClipboardImage = {
  data: Buffer.from('fake-image-data'),
  mimeType: 'image/png',
};

describe('isImageFile', () => {
  it('returns true for known image extensions', () => {
    expect(isImageFile('/path/to/screenshot.png')).toBe(true);
    expect(isImageFile('~/image.jpg')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('anim.gif')).toBe(true);
    expect(isImageFile('thumb.webp')).toBe(true);
    expect(isImageFile('icon.bmp')).toBe(true);
  });

  it('returns false for non-image extensions', () => {
    expect(isImageFile('/path/to/readme.md')).toBe(false);
    expect(isImageFile('main.ts')).toBe(false);
    expect(isImageFile('data.json')).toBe(false);
    expect(isImageFile('/etc/hosts')).toBe(false);
  });

  it('returns false for files without extensions', () => {
    expect(isImageFile('/path/to/Dockerfile')).toBe(false);
    expect(isImageFile('Makefile')).toBe(false);
  });
});

describe('saveImageToSession', () => {
  it('writes image data to the session images directory', async () => {
    const home = join(tmpdir(), `chimera-clipboard-test-${Date.now()}`);
    await mkdir(home, { recursive: true });

    try {
      const sessionId = '01SESSIONID00000000000000000';
      const path = await saveImageToSession(sessionId, mockImage, home);
      expect(path).toContain(`${home}/.chimera/sessions/01SESSIONID00000000000000000/images/`);
      expect(path).toMatch(/\d+\.png$/);

      const written = await readFile(path);
      expect(written.toString()).toBe('fake-image-data');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('copying text', () => {
  it('wraps the text for the terminal clipboard, as base64', () => {
    expect(clipboardSequence('héllo')).toBe(
      `\x1b]52;c;${Buffer.from('héllo', 'utf8').toString('base64')}\x07`,
    );
  });

  it.each([
    ['Wayland', { WAYLAND_DISPLAY: 'wayland-0' }, 'linux', ['wl-copy', []]],
    ['X11', { DISPLAY: ':0' }, 'linux', ['xclip', ['-selection', 'clipboard']]],
    ['macOS', {}, 'darwin', ['pbcopy', []]],
  ] as const)('uses the system tool on %s', (_label, env, platform, expected) => {
    expect(clipboardCommands(env, platform)[0]).toEqual({
      command: expected[0],
      args: expected[1],
    });
  });

  it('uses no system tool over SSH, where it would fill the wrong clipboard', () => {
    expect(
      clipboardCommands({ WAYLAND_DISPLAY: 'wayland-0', SSH_CONNECTION: '10.0.0.1 22' }, 'linux'),
    ).toEqual([]);
  });

  it('gives the text to the first tool that takes it', async () => {
    const tried: string[] = [];
    const copied = await writeClipboardText('some text', {
      env: { DISPLAY: ':0' },
      platform: 'linux',
      run: async (command, _args, input) => {
        tried.push(`${command}:${input}`);
        return command === 'xsel';
      },
    });

    expect(copied).toBe(true);
    expect(tried).toEqual(['xclip:some text', 'xsel:some text']);
  });

  it('says so when no tool took the text', async () => {
    const copied = await writeClipboardText('x', {
      env: {},
      platform: 'linux',
      run: async () => true,
    });
    expect(copied).toBe(false);
  });
});
