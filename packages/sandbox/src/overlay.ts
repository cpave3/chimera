import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OverlayApplySelection, OverlayDiff } from './types';

export function defaultOverlaysHome(home?: string): string {
  return join(home ?? homedir(), '.chimera', 'overlays');
}

export function overlayPaths(sessionId: string, overlaysHome?: string) {
  const root = join(overlaysHome ?? defaultOverlaysHome(), sessionId);
  return {
    root,
    upper: join(root, 'upper'),
    work: join(root, 'work'),
    /** The actual data directory `entrypoint.sh` writes into. */
    upperData: join(root, 'upper', 'data'),
  };
}

export async function ensureOverlayDirs(sessionId: string, overlaysHome?: string): Promise<void> {
  const p = overlayPaths(sessionId, overlaysHome);
  await mkdir(p.upperData, { recursive: true });
  await mkdir(p.work, { recursive: true });
}

export async function removeOverlayDirs(sessionId: string, overlaysHome?: string): Promise<void> {
  const p = overlayPaths(sessionId, overlaysHome);
  await rm(p.root, { recursive: true, force: true });
}

interface RsyncRunner {
  run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

class SpawnRsync implements RsyncRunner {
  run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        resolve({ stdout, stderr: stderr + String(err.message), exitCode: -1 });
      });
      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });
    });
  }
}

/**
 * Run `rsync --dry-run -rln --delete --itemize-changes <upperData>/ <hostCwd>/`
 * and partition the itemized output into added/modified/deleted lists.
 *
 * Itemize format from rsync: `YXcstpoguax path/to/file` where the leading
 * char is `<`/`>`/`*` (or `c`/`h`/`.`). For our purposes:
 *   - lines starting with `*deleting` → deleted
 *   - lines starting with `>f+++++++++` (all `+`) → added
 *   - other `>f` lines → modified
 *   - directory entries (`cd`, `>d…`) → ignored as standalone entries
 */
export function parseRsyncItemize(out: string): OverlayDiff {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('*deleting')) {
      const path = line.slice('*deleting'.length).trim();
      if (path && !path.endsWith('/')) deleted.push(path);
      continue;
    }
    // Itemize prefix is 11 chars + space + path.
    if (line.length < 13) continue;
    const prefix = line.slice(0, 11);
    const path = line.slice(12);
    if (!path || path.endsWith('/')) continue;
    const op = prefix[0];
    const fileType = prefix[1];
    if (fileType !== 'f') continue;
    if (op === '>') {
      const isNew = prefix.slice(2) === '+++++++++';
      if (isNew) added.push(path);
      else modified.push(path);
    }
  }

  return { modified, added, deleted };
}

export async function diffOverlay(
  sessionId: string,
  hostCwd: string,
  opts: { overlaysHome?: string; runner?: RsyncRunner } = {},
): Promise<OverlayDiff> {
  const { upperData } = overlayPaths(sessionId, opts.overlaysHome);
  const runner = opts.runner ?? new SpawnRsync();
  const r = await runner.run([
    '--dry-run',
    '-rln',
    '--delete',
    '--itemize-changes',
    `${upperData}/`,
    `${hostCwd}/`,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`rsync diff failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
  }
  return parseRsyncItemize(r.stdout);
}

export async function applyOverlay(
  sessionId: string,
  hostCwd: string,
  selection: OverlayApplySelection = {},
  opts: { overlaysHome?: string; runner?: RsyncRunner } = {},
): Promise<void> {
  const { upperData } = overlayPaths(sessionId, opts.overlaysHome);
  const runner = opts.runner ?? new SpawnRsync();

  const args: string[] = ['-a'];
  if (selection.includeDeletions !== false) args.push('--delete');

  if (selection.paths && selection.paths.length > 0) {
    for (const path of selection.paths) {
      // rsync requires explicit ancestor `--include` entries to descend
      // when a final `--exclude *` is in play.
      const parts = path.split('/');
      let acc = '';
      for (let i = 0; i < parts.length - 1; i += 1) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
        args.push('--include', `/${acc}/`);
      }
      args.push('--include', `/${path}`);
    }
    args.push('--exclude', '*');
  }

  args.push(`${upperData}/`, `${hostCwd}/`);
  const r = await runner.run(args);
  if (r.exitCode !== 0) {
    throw new Error(`rsync apply failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
  }
}

export async function discardOverlay(
  sessionId: string,
  opts: { overlaysHome?: string } = {},
): Promise<void> {
  await removeOverlayDirs(sessionId, opts.overlaysHome);
}
