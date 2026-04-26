import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookEvent } from './types';

export interface DiscoveryOptions {
  /** Override the global hook directory root (defaults to ~/.chimera/hooks). */
  globalRoot?: string;
  /** Override the project hook directory root (defaults to <cwd>/.chimera/hooks). */
  projectRoot?: string;
}

export interface DiscoveredHooks {
  global: string[];
  project: string[];
}

export function defaultGlobalRoot(): string {
  return join(homedir(), '.chimera', 'hooks');
}

export function defaultProjectRoot(cwd: string): string {
  return join(cwd, '.chimera', 'hooks');
}

/**
 * Discovery returns absolute paths of executable files in:
 *   1. <globalRoot>/<event>/
 *   2. <projectRoot>/<event>/
 * Sorted lexicographically per directory; globals appear first in the
 * combined ordered list.
 */
export async function discover(
  event: HookEvent,
  cwd: string,
  opts: DiscoveryOptions = {},
): Promise<DiscoveredHooks> {
  const globalRoot = opts.globalRoot ?? defaultGlobalRoot();
  const projectRoot = opts.projectRoot ?? defaultProjectRoot(cwd);
  const [global, project] = await Promise.all([
    listExecutables(join(globalRoot, event)),
    listExecutables(join(projectRoot, event)),
  ]);
  return { global, project };
}

async function listExecutables(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  entries.sort();
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    let info;
    try {
      info = await stat(full); // follows symlinks; broken symlinks throw
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if ((info.mode & 0o111) === 0) continue;
    out.push(full);
  }
  return out;
}
