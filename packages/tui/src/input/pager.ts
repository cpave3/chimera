import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTerminalHandoff } from './terminal-handoff';

export interface OpenInPagerArgs {
  text: string;
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}

export type OpenInPagerResult = { ok: true } | { ok: false; reason: string };

/**
 * `$PAGER` when set, else `less`: raw colour codes passed through, no
 * terminal bell, and positioned at the end, where the latest work is.
 */
export function resolvePagerCommand(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
} {
  const configured = env.PAGER?.trim();
  if (configured) {
    const [command, ...args] = configured.split(/\s+/);
    return { command: command!, args };
  }
  return { command: 'less', args: ['-R', '-Q', '+G'] };
}

/**
 * Hand the terminal to a pager showing `text`. The pager owns the alternate
 * screen, so the TUI's own scrollback is untouched when it exits.
 */
export async function openInPager(args: OpenInPagerArgs): Promise<OpenInPagerResult> {
  const { text, stdout, stdin } = args;
  const tempFile = join(tmpdir(), `chimera-transcript-${process.pid}-${randomUUID()}.txt`);
  try {
    await writeFile(tempFile, text, 'utf8');
    const { command, args: pagerArgs } = resolvePagerCommand();
    const exitCode = await withTerminalHandoff(
      { stdin, stdout },
      () =>
        new Promise<number | null>((resolve, reject) => {
          const child = spawn(command, [...pagerArgs, tempFile], { stdio: 'inherit' });
          child.once('error', reject);
          child.once('exit', (code) => resolve(code));
        }),
      { requireTty: false },
    );
    return exitCode === 0
      ? { ok: true }
      : { ok: false, reason: `${command} exited with status ${exitCode}` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}
