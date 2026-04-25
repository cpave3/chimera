import { basename, isAbsolute, relative } from 'node:path';

/**
 * Resolve `p` for human-readable display. Inside `cwd` we show the relative
 * path; outside `cwd` (or when the relative form would be empty/awkward) we
 * fall back to just the basename so a long absolute path doesn't blow out
 * the scrollback line.
 */
export function relPath(p: string, cwd: string = process.cwd()): string {
  if (!isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  if (rel === '' || rel.startsWith('..')) return basename(p);
  return rel;
}

/**
 * Single-line clamp suitable for scrollback summaries. Collapses to the
 * first line, then truncates with an ellipsis if it still exceeds `max`.
 */
export function clip(s: string, max: number): string {
  const firstLine = s.split('\n', 1)[0] ?? '';
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max)}…`;
}

const CD_PREFIX = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&\s*/;

/**
 * Drop a leading `cd <dir> && ` from a bash command. LLMs habitually prepend
 * this even though chimera already runs each call from the project cwd,
 * and it eats valuable display width.
 */
export function stripCdPrefix(command: string): string {
  return command.replace(CD_PREFIX, '');
}
