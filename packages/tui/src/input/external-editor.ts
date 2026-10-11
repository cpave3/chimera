import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTerminalHandoff } from './terminal-handoff';

export interface OpenInEditorArgs {
  initialText: string;
  mouseActive: boolean;
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}

export type OpenInEditorResult = { ok: true; text: string } | { ok: false; reason: string };

const SGR_MOUSE_DISABLE = '\x1b[?1006l\x1b[?1003l';
const SGR_MOUSE_ENABLE = '\x1b[?1003h\x1b[?1006h';

export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
} {
  const candidates = [env.VISUAL, env.EDITOR];
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      const tokens = candidate.trim().split(/\s+/);
      const [command, ...args] = tokens;
      return { command: command!, args };
    }
  }
  return { command: 'vi', args: [] };
}

export async function openInEditor(args: OpenInEditorArgs): Promise<OpenInEditorResult> {
  const { initialText, mouseActive, stdout, stdin } = args;
  const tempFile = join(tmpdir(), `chimera-prompt-${process.pid}-${randomUUID()}.md`);

  try {
    await writeFile(tempFile, initialText, 'utf8');

    if (mouseActive) {
      stdout.write(SGR_MOUSE_DISABLE);
    }
    const { command, args: editorArgs } = resolveEditorCommand();
    let exitCode: number | null;
    try {
      exitCode = await withTerminalHandoff(
        { stdin, stdout },
        () =>
          new Promise<number | null>((resolve, reject) => {
            const child = spawn(command, [...editorArgs, tempFile], { stdio: 'inherit' });
            child.once('error', reject);
            child.once('exit', (code) => resolve(code));
          }),
        { requireTty: false },
      );
    } finally {
      if (mouseActive) {
        stdout.write(SGR_MOUSE_ENABLE);
      }
    }

    if (exitCode !== 0) {
      return { ok: false, reason: `editor exited with status ${exitCode}` };
    }
    let raw: string;
    try {
      raw = await readFile(tempFile, 'utf8');
    } catch (err) {
      return { ok: false, reason: `read failed: ${(err as Error).message}` };
    }
    const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    try {
      await unlink(tempFile);
    } catch {
      // ENOENT and friends — ignore.
    }
  }
}

export type OpenFileInEditorResult = { ok: true } | { ok: false; reason: string };

/** Hand the terminal to the user's editor on a file that stays where it is. */
export async function openFileInEditor(args: {
  path: string;
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}): Promise<OpenFileInEditorResult> {
  const { command, args: editorArgs } = resolveEditorCommand();
  try {
    const exitCode = await withTerminalHandoff(
      { stdin: args.stdin, stdout: args.stdout },
      () =>
        new Promise<number | null>((resolve, reject) => {
          const child = spawn(command, [...editorArgs, args.path], { stdio: 'inherit' });
          child.once('error', reject);
          child.once('exit', (code) => resolve(code));
        }),
      { requireTty: false },
    );
    return exitCode === 0
      ? { ok: true }
      : { ok: false, reason: `editor exited with status ${exitCode}` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
