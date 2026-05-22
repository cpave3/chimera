import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { DirEntry, ExecOptions, ExecResult, Executor, StatResult } from '@chimera/core';
import { PathEscapeError } from './errors';

const DEFAULT_TIMEOUT_MS = 120_000;
const SIGKILL_DELAY_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface LocalExecutorOptions {
  cwd: string;
  /**
   * Extra absolute directories that are permitted for READ operations only.
   * Used for out-of-cwd resources the agent legitimately needs (notably
   * skill directories under `~/.chimera/skills/` and `~/.claude/skills/`).
   * Writes and exec remain strictly cwd-scoped regardless of this list.
   */
  readAllowDirs?: string[];
  /**
   * Extra absolute directories that are permitted for WRITE operations (and
   * exec cwd follow-through). Used for out-of-cwd paths the agent needs to
   * create or modify (e.g. `/tmp`). These do NOT automatically grant read
   * access; add the same directories to `readAllowDirs` if reads are also
   * required.
   */
  writeAllowDirs?: string[];
  /**
   * Per-stream byte cap for `exec()`. Once reached, further chunks are dropped
   * and the corresponding `stdoutTruncated`/`stderrTruncated` flag is set.
   * Guards against V8's ~512MB string-length limit when subprocesses emit huge
   * output (e.g. ripgrep over a giant tree). Defaults to 16 MiB.
   */
  maxOutputBytes?: number;
}

export class LocalExecutor implements Executor {
  private readonly rootCwd: string;
  private readonly readAllowDirs: string[];
  private readonly writeAllowDirs: string[];
  private readonly maxOutputBytes: number;

  constructor(opts: LocalExecutorOptions) {
    this.rootCwd = resolve(opts.cwd);
    this.readAllowDirs = (opts.readAllowDirs ?? []).map((d) => resolve(d));
    this.writeAllowDirs = (opts.writeAllowDirs ?? []).map((d) => resolve(d));
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  cwd(): string {
    return this.rootCwd;
  }

  target(): 'host' {
    return 'host';
  }

  /**
   * Resolve `path` and reject anything that falls outside `rootCwd` or
   * the configured `writeAllowDirs`.  Uses `fs.realpath` so symlinks
   * pointing outside the permitted tree cannot bypass the boundary.
   */
  private async resolveSafe(path: string): Promise<string> {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.rootCwd, path);
    const resolved = await realpath(absolute).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    const effective = resolved ?? absolute;
    const rel = relative(this.rootCwd, effective);
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      return absolute;
    }
    for (const dir of this.writeAllowDirs) {
      const relDir = relative(dir, effective);
      if (!relDir.startsWith('..') && !isAbsolute(relDir)) {
        return absolute;
      }
    }
    throw new PathEscapeError(path, this.rootCwd);
  }

  /**
   * Read-mode path resolution: allow `rootCwd` plus any configured
   * `readAllowDirs`.  Uses `fs.realpath` for the same symlink defense
   * as `resolveSafe`.
   */
  private async resolveReadable(path: string): Promise<string> {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.rootCwd, path);
    const resolved = await realpath(absolute).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    const effective = resolved ?? absolute;
    const relCwd = relative(this.rootCwd, effective);
    const underCwd = !relCwd.startsWith('..') && !isAbsolute(relCwd);
    if (underCwd) return absolute;
    for (const dir of this.readAllowDirs) {
      const rel = relative(dir, effective);
      if (!rel.startsWith('..') && !isAbsolute(rel)) return absolute;
    }
    throw new PathEscapeError(path, this.rootCwd);
  }

  async readFile(path: string): Promise<string> {
    const abs = await this.resolveReadable(path);
    return readFile(abs, 'utf8');
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const abs = await this.resolveReadable(path);
    return readFile(abs);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = await this.resolveSafe(path);
    await mkdir(dirname(abs), { recursive: true });
    // Preserve the existing file's mode across the write-tmp + rename dance.
    // Without this, replacing an executable script (or any non-default mode)
    // resets it to umask defaults because the tmp file is created fresh.
    // lstat (not stat) so we don't follow symlinks: a symlink target's mode
    // is irrelevant to a path we're about to replace via rename, and copying
    // it onto the new file would silently mask the symlink-replacement.
    let priorMode: number | null = null;
    try {
      const fileStats = await lstat(abs);
      if (!fileStats.isSymbolicLink()) {
        priorMode = fileStats.mode & 0o777;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, 'utf8');
    if (priorMode !== null) {
      await chmod(tmp, priorMode);
    }
    await rename(tmp, abs);
  }

  async stat(path: string): Promise<StatResult | null> {
    try {
      const abs = await this.resolveReadable(path);
      const st = await stat(abs);
      return { exists: true, isDir: st.isDirectory(), size: st.size };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw err;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const abs = await this.resolveReadable(path);
    const entries = await readdir(abs, { withFileTypes: true });
    return entries
      .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cwd = opts.cwd ? await this.resolveSafe(opts.cwd) : this.rootCwd;
    const maxOutputBytes = this.maxOutputBytes;

    return new Promise<ExecResult>((resolvePromise, rejectPromise) => {
      const child = spawn('sh', ['-c', cmd], {
        cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: opts.signal,
      });

      const stdoutBuffer = new BoundedBuffer(maxOutputBytes);
      const stderrBuffer = new BoundedBuffer(maxOutputBytes);
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      let settled = false;
      const settle = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        rejectPromise(err);
      };

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch (err) {
          const error = err as NodeJS.ErrnoException;
          if (error.code === 'EPERM') {
            console.debug(
              `[local-executor] SIGTERM failed (EPERM):`,
              error.message,
            );
          }
          // ESRCH → process already gone, benign; ignore silently.
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (err) {
            const error = err as NodeJS.ErrnoException;
            if (error.code === 'EPERM') {
              console.debug(
                `[local-executor] SIGKILL failed (EPERM):`,
                error.message,
              );
            }
            // ESRCH → process already gone, benign; ignore silently.
          }
        }, SIGKILL_DELAY_MS);
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        try {
          stdoutBuffer.push(d);
        } catch (err) {
          fail(err);
        }
      });
      child.stderr.on('data', (d: Buffer) => {
        try {
          stderrBuffer.push(d);
        } catch (err) {
          fail(err);
        }
      });

      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
      }
      child.stdin.end();

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        const stdout = stdoutBuffer.toString();
        const stderrBase = stderrBuffer.toString();
        settle({
          stdout,
          stderr: stderrBase + String(err?.message ?? err),
          exitCode: -1,
          timedOut,
          stdoutTruncated: stdoutBuffer.truncated,
          stderrTruncated: stderrBuffer.truncated,
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        const exitCode =
          code === null ? (signal === 'SIGTERM' || signal === 'SIGKILL' ? -1 : 0) : code;
        settle({
          stdout: stdoutBuffer.toString(),
          stderr: stderrBuffer.toString(),
          exitCode,
          timedOut,
          stdoutTruncated: stdoutBuffer.truncated,
          stderrTruncated: stderrBuffer.truncated,
        });
      });
    });
  }
}

/**
 * Append-only Buffer accumulator with a hard byte cap. Once the cap is hit,
 * further chunks are dropped and `truncated` flips to true. Decoding is
 * deferred to a single `toString('utf8')` at read time, which keeps us under
 * V8's ~512MB string-length ceiling and lets the caller observe partial
 * output instead of crashing.
 */
class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const remaining = this.cap - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return;
    }
    this.chunks.push(chunk.subarray(0, remaining));
    this.size += remaining;
    this.truncated = true;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString('utf8');
  }
}
