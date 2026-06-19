import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ClipboardImage, isImageFile, saveImageToSession } from '../src/clipboard';

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
