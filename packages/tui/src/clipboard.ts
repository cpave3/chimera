import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SessionId } from '@chimera/core';

const execFileAsync = promisify(execFile);

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

export interface ClipboardImage {
  data: Buffer;
  mimeType: string;
}

export function isImageFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext !== undefined && ext in IMAGE_MIME_TYPES;
}

/**
 * Read an image from the system clipboard.
 * Returns null if no image is available or the platform is unsupported.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const platform = process.platform;

  if (platform === 'linux') {
    // Try Wayland first (wl-paste), then fall back to X11 (xclip).
    const result = await tryWaylandClipboard();
    if (result) return result;
    return tryX11Clipboard();
  }

  if (platform === 'darwin') {
    return tryMacosClipboard();
  }

  if (platform === 'win32') {
    return tryWindowsClipboard();
  }

  return null;
}

async function tryWaylandClipboard(): Promise<ClipboardImage | null> {
  try {
    const { stdout } = await execFileAsync('wl-paste', ['--type', 'image/png'], {
      encoding: 'buffer',
    });
    if (stdout.length === 0) return null;
    return { data: stdout, mimeType: 'image/png' };
  } catch {
    return null;
  }
}

async function tryX11Clipboard(): Promise<ClipboardImage | null> {
  try {
    const { stdout } = await execFileAsync(
      'xclip',
      ['-selection', 'clipboard', '-t', 'image/png', '-o'],
      { encoding: 'buffer' },
    );
    if (stdout.length === 0) return null;
    return { data: stdout, mimeType: 'image/png' };
  } catch {
    return null;
  }
}

async function tryMacosClipboard(): Promise<ClipboardImage | null> {
  try {
    // osascript with class PNGf returns the PNG data as raw bytes in stdout.
    // Use { encoding: 'buffer' } to avoid UTF-8 corruption.
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', 'try\nset pngData to the clipboard as «class PNGf»\nreturn pngData\nend try'],
      { encoding: 'buffer' },
    );
    if (stdout.length === 0) return null;
    return { data: stdout, mimeType: 'image/png' };
  } catch {
    return null;
  }
}

async function tryWindowsClipboard(): Promise<ClipboardImage | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-command',
        'Add-Type -Assembly System.Windows.Forms; $ms = New-Object System.IO.MemoryStream; [System.Windows.Forms.Clipboard]::GetImage().Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray())',
      ],
      { encoding: 'buffer' },
    );
    // powershell.exe returns UTF-16 LE BOM on Windows, but raw base64
    // string on some terminals. Try both.
    let base64 = '';
    if (stdout.length >= 2 && stdout[0] === 0xff && stdout[1] === 0xfe) {
      base64 = stdout.toString('utf16le', 2).trim();
    } else {
      base64 = stdout.toString('utf8').trim();
    }
    if (base64.length === 0) return null;
    const data = Buffer.from(base64, 'base64');
    return { data, mimeType: 'image/png' };
  } catch {
    return null;
  }
}

/**
 * Save clipboard image data to the session's images directory.
 * Returns the absolute path of the saved file.
 */
export async function saveImageToSession(
  sessionId: SessionId,
  image: ClipboardImage,
  home = homedir(),
): Promise<string> {
  const dir = join(home, '.chimera', 'sessions', sessionId, 'images');
  await mkdir(dir, { recursive: true });
  const ext = image.mimeType === 'image/jpeg' ? 'jpg' : (image.mimeType.split('/')[1] ?? 'png');
  const name = `${Date.now()}.${ext}`;
  const path = join(dir, name);
  await writeFile(path, image.data);
  return path;
}
