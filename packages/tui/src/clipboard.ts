import { execFile, spawn } from 'node:child_process';
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

/**
 * The escape sequence that asks the terminal to put text on the clipboard
 * (OSC 52). It also works over SSH, where the clipboard is on the user's
 * machine and no local tool can reach it.
 */
export function clipboardSequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

export interface ClipboardCommand {
  command: string;
  args: string[];
}

/** The system tools that take text for the clipboard on stdin, best first. */
export function clipboardCommands(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ClipboardCommand[] {
  // A tool on the remote end of an SSH session fills the remote clipboard.
  if (env.SSH_CONNECTION || env.SSH_TTY) return [];
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ command: 'clip', args: [] }];
  const commands: ClipboardCommand[] = [];
  if (env.WAYLAND_DISPLAY) commands.push({ command: 'wl-copy', args: [] });
  if (env.DISPLAY) {
    commands.push(
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    );
  }
  return commands;
}

const CLIPBOARD_TOOL_TIMEOUT_MS = 2_000;

function pipeToCommand(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => settle(false), CLIPBOARD_TOOL_TIMEOUT_MS);
      timer.unref();
      child.once('error', () => settle(false));
      child.once('close', (code) => settle(code === 0));
      child.stdin.on('error', () => settle(false));
      child.stdin.end(input);
    } catch {
      settle(false);
    }
  });
}

/**
 * Put text on the system clipboard with the first tool that takes it. False
 * when there is no tool; the terminal's own clipboard sequence is then the
 * only way, and the caller sends it in every case.
 */
export async function writeClipboardText(
  text: string,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    run?: (command: string, args: string[], input: string) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const run = options.run ?? pipeToCommand;
  for (const { command, args } of clipboardCommands(options.env, options.platform)) {
    if (await run(command, args, text)) return true;
  }
  return false;
}
