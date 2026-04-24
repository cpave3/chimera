import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ROLE_PROMPT } from './role';

export interface ComposeOptions {
  cwd: string;
  home?: string;
  extensions?: ((ctx: { cwd: string }) => string | null)[];
}

/**
 * Walk from cwd up to nearest git root (or home), collecting AGENTS.md files.
 * Returns in order root-first, closer-last so that closer files override.
 */
export function discoverAgentsFiles(cwd: string, home = homedir()): string[] {
  const files: string[] = [];
  let dir = resolve(cwd);
  const stopAt = resolve(home);
  let hitGitRoot = false;

  while (true) {
    const candidate = join(dir, 'AGENTS.md');
    try {
      const st = statSync(candidate);
      if (st.isFile()) files.push(candidate);
    } catch {
      // absent
    }

    try {
      const gitStat = statSync(join(dir, '.git'));
      if (gitStat.isDirectory() || gitStat.isFile()) {
        hitGitRoot = true;
      }
    } catch {
      // not a git root
    }

    if (hitGitRoot) break;
    if (dir === stopAt) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Closer (deeper) files should appear *later* so they override.
  // Walk collected in deep→shallow order; reverse to get shallow→deep.
  return files.reverse();
}

export function composeSystemPrompt(opts: ComposeOptions): string {
  const parts: string[] = [ROLE_PROMPT];

  const files = discoverAgentsFiles(opts.cwd, opts.home);
  for (const f of files) {
    try {
      const body = readFileSync(f, 'utf8');
      parts.push(`\n\n# ${f}\n\n${body}`);
    } catch {
      // race: file vanished; skip
    }
  }

  for (const ext of opts.extensions ?? []) {
    const chunk = ext({ cwd: opts.cwd });
    if (chunk) parts.push(`\n\n${chunk}`);
  }

  return parts.join('');
}
