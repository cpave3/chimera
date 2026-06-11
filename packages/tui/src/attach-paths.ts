import type { Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface AttachToken {
  kind: 'read' | 'write';
  raw: string;
  absolute: string;
}

/**
 * Detect `@path` (read) and `#path` (write) tokens in user input.
 * The path runs to the next whitespace. `~/` expands via `os.homedir()`.
 * Otherwise resolved against `cwd` (absolute paths pass through).
 * Returns tokens in order of appearance.
 */
export function parseAttachTokens(input: string, cwd: string): AttachToken[] {
  const tokens: AttachToken[] = [];
  const pattern = /(^|\s)([@#])(\S+)/g;
  let match: RegExpExecArray | null = pattern.exec(input);
  while (match !== null) {
    const [, , prefix, rawPath] = match;
    if (prefix === '#' && rawPath.startsWith('#')) {
      // Skip markdown headings (`## Title`, `### Code`, etc.)
      match = pattern.exec(input);
    } else {
      const kind = prefix === '@' ? 'read' : 'write';
      let resolved: string;
      if (rawPath.startsWith('~/')) {
        resolved = join(homedir(), rawPath.slice(2));
      } else if (isAbsolute(rawPath)) {
        resolved = rawPath;
      } else {
        resolved = resolve(cwd, rawPath);
      }
      tokens.push({ kind, raw: rawPath, absolute: resolved });
      match = pattern.exec(input);
    }
  }
  return tokens;
}

/**
 * Read disk content for attach tokens.
 * - File: line-numbered, capped at 2000 lines / 100 KB.
 * - Directory: one entry per line, trailing `/` for subdirs, capped at 200 entries.
 * - Missing or on error: returns a descriptive body.
 */
export async function readForAttach(absPath: string): Promise<{
  kind: 'file' | 'dir' | 'missing' | 'error';
  body: string;
}> {
  let stats: Stats;
  try {
    stats = await stat(absPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ENOENT') || message.includes('no such file or directory')) {
      return { kind: 'missing', body: `missing: ${absPath}` };
    }
    return { kind: 'error', body: message };
  }

  if (stats.isDirectory()) {
    try {
      const entries = await readdir(absPath, { withFileTypes: true });
      const capped = entries.slice(0, 200);
      const lines = capped.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { kind: 'dir', body: lines.join('\n') };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'error', body: message };
    }
  }

  // File
  try {
    const content = await readFile(absPath, 'utf-8');
    let body = content;
    const MAX_SIZE = 100 * 1024;
    const MAX_LINES = 2000;

    if (Buffer.byteLength(body, 'utf-8') > MAX_SIZE) {
      let bytes = 0;
      const lines: string[] = [];
      for (const line of body.split('\n')) {
        bytes += Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline
        if (bytes > MAX_SIZE || lines.length >= MAX_LINES) break;
        lines.push(line);
      }
      body = lines.join('\n');
    }

    const lines = body.split('\n');
    const numbered = lines.slice(0, MAX_LINES).map((line, index) => `${index + 1}\t${line}`);
    return { kind: 'file', body: numbered.join('\n') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', body: message };
  }
}
