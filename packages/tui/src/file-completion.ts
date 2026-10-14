import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MultilineBuffer } from './input/buffer';

export interface CompletionContext {
  /** `@` attaches a file for reading, `#` for writing. */
  marker: '@' | '#';
  /** What the user has typed after the marker. */
  query: string;
  /** Character range of the whole word, marker included. */
  start: number;
  end: number;
}

/**
 * The attach word the cursor is at the end of, if any. A marker only counts
 * at the start of a word, so `me@example` and `## heading` are left alone.
 */
export function completionContext(buffer: MultilineBuffer): CompletionContext | null {
  const { text, cursor } = buffer;
  const after = text[cursor];
  if (after !== undefined && !/\s/.test(after)) return null;
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  const word = text.slice(start, cursor);
  const marker = word[0];
  if (marker !== '@' && marker !== '#') return null;
  const query = word.slice(1);
  if (query.startsWith('#') || query.startsWith('@')) return null;
  return { marker, query, start, end: cursor };
}

/**
 * Replace the word under the cursor with the chosen path. A path with
 * spaces in it is quoted, so it is still read as one attachment.
 */
export function acceptCompletion(
  buffer: MultilineBuffer,
  context: CompletionContext,
  path: string,
): MultilineBuffer {
  const written = /\s/.test(path) ? `"${path}"` : path;
  const inserted = `${context.marker}${written} `;
  return {
    text: buffer.text.slice(0, context.start) + inserted + buffer.text.slice(context.end),
    cursor: context.start + inserted.length,
  };
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * The best `limit` matches for `query`. Classes, best first: the file name
 * starts with the query, the file name contains it, the path contains it,
 * the path has its letters in order. Within a class the shorter path wins,
 * since a short path is usually the more central file.
 */
export function rankFiles(files: string[], query: string, limit: number): string[] {
  const wanted = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    const score = name.startsWith(wanted)
      ? 0
      : name.includes(wanted)
        ? 1
        : lower.includes(wanted)
          ? 2
          : isSubsequence(wanted, lower)
            ? 3
            : -1;
    if (score >= 0) scored.push({ path, score });
  }
  return scored
    .sort(
      (a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
    )
    .slice(0, limit)
    .map((entry) => entry.path);
}

const MAX_WALK_FILES = 5_000;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'target']);

function gitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? null : stdout.split('\n').filter((line) => line !== ''));
      },
    );
  });
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [''];
  while (pending.length > 0 && files.length < MAX_WALK_FILES) {
    const relative = pending.shift()!;
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (files.length < MAX_WALK_FILES) {
        files.push(path);
      }
    }
  }
  return files;
}

/**
 * The files a user may want to attach: what git tracks plus untracked files
 * it does not ignore; outside a repository, a bounded walk of the directory.
 */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  return (await gitFiles(cwd)) ?? walk(cwd);
}
