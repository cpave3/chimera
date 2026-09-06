import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  CommandPolicyRoots,
  DirEntry,
  ExecOptions,
  ExecResult,
  Executor,
  StatResult,
} from '@chimera/core';
import { PathEscapeError } from './errors';

/**
 * Canonicalize a directory path: `realpathSync` it so symlinked prefixes
 * (e.g. `/home` → `/var/home` on systemd-homed) match the realpath-resolved
 * targets checked in `resolveSafe`/`resolveReadable`. Falls back to `resolve`
 * on any error (notably `ENOENT` for allow-dirs that don't exist yet, such as
 * `~/.agents`), so callers never throw at construction for a missing dir.
 */
function canonicalizeDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const SIGKILL_DELAY_MS = 2_000;
const PIPE_DRAIN_MS = 250;
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
    this.rootCwd = canonicalizeDir(opts.cwd);
    this.readAllowDirs = (opts.readAllowDirs ?? []).map((d) => canonicalizeDir(d));
    this.writeAllowDirs = (opts.writeAllowDirs ?? []).map((d) => canonicalizeDir(d));
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  /** Add an absolute directory to the read-allow list. Deduplicates silently. */
  addReadAllowDir(absolutePath: string): void {
    const canonical = canonicalizeDir(absolutePath);
    if (!this.readAllowDirs.some((d) => canonicalizeDir(d) === canonical)) {
      this.readAllowDirs.push(canonical);
    }
  }

  /** Add an absolute directory to the write-allow list. Deduplicates silently. */
  addWriteAllowDir(absolutePath: string): void {
    const canonical = canonicalizeDir(absolutePath);
    if (!this.writeAllowDirs.some((d) => canonicalizeDir(d) === canonical)) {
      this.writeAllowDirs.push(canonical);
    }
  }

  removeReadAllowDir(absolutePath: string): void {
    const canonical = canonicalizeDir(absolutePath);
    const index = this.readAllowDirs.indexOf(canonical);
    if (index >= 0) this.readAllowDirs.splice(index, 1);
  }

  removeWriteAllowDir(absolutePath: string): void {
    const canonical = canonicalizeDir(absolutePath);
    const index = this.writeAllowDirs.indexOf(canonical);
    if (index >= 0) this.writeAllowDirs.splice(index, 1);
  }

  /** Return a shallow copy of the current read-allow directories. */
  listReadAllowDirs(): readonly string[] {
    return [...this.readAllowDirs];
  }

  /** Return a shallow copy of the current write-allow directories. */
  listWriteAllowDirs(): readonly string[] {
    return [...this.writeAllowDirs];
  }

  commandPolicyRoots(): CommandPolicyRoots {
    const write = Object.freeze([this.rootCwd, ...this.writeAllowDirs]);
    const read = Object.freeze([
      this.rootCwd,
      ...this.readAllowDirs.filter((path) => !write.includes(path)),
      ...this.writeAllowDirs,
    ]);
    return { read, write };
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

    if (opts.signal?.aborted) {
      return {
        stdout: '',
        stderr: 'The operation was aborted',
        exitCode: -1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }

    return new Promise<ExecResult>((resolvePromise) => {
      const child = spawn('sh', ['-c', cmd], {
        cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own the command's group without sharing Chimera's signal lifetime.
        detached: true,
      });

      const stdoutBuffer = new BoundedBuffer(maxOutputBytes);
      const stderrBuffer = new BoundedBuffer(maxOutputBytes);
      const diagnostics: string[] = [];
      let timedOut = false;
      let stopping = false;
      let settled = false;
      let closed = false;
      let killTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;

      const settle = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        clearTimeout(drainTimer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolvePromise({
          stdout: stdoutBuffer.toString(),
          stderr: stderrBuffer.toString() + diagnostics.join(''),
          exitCode: stopping ? -1 : exitCode,
          timedOut,
          stdoutTruncated: stdoutBuffer.truncated,
          stderrTruncated: stderrBuffer.truncated,
        });
      };

      const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
        if (child.pid === undefined) return false;
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          diagnostics.push(`\n[local-executor] signal ${signal} failed: ${String(error)}\n`);
          return true;
        }
      };

      const stop = (reason: 'timeout' | 'abort' | 'error') => {
        if (settled || stopping) return;
        stopping = true;
        timedOut = reason === 'timeout';
        clearTimeout(timeoutTimer);
        if (reason === 'abort') diagnostics.push('\nThe operation was aborted\n');
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => {
          signalGroup('SIGKILL');
          drainTimer = setTimeout(() => {
            if (!closed) {
              diagnostics.push(
                '\n[local-executor] cleanup incomplete: process or output pipes did not close ' +
                  'after SIGKILL; a detached or elevated process may still be running.\n',
              );
            } else if (signalGroup(0)) {
              diagnostics.push(
                '\n[local-executor] process group still exists after SIGKILL; ' +
                  'members may still be running or awaiting reaping.\n',
              );
            }
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            settle(-1);
          }, PIPE_DRAIN_MS);
        }, SIGKILL_DELAY_MS);
      };
      const onAbort = () => stop('abort');
      const timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs);
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => stdoutBuffer.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrBuffer.push(chunk));

      child.on('error', (error) => {
        diagnostics.push(String(error.message));
        settle(-1);
      });
      child.on('close', (code, signal) => {
        closed = true;
        if (settled) return;
        // Children with redirected output can survive both the shell and its pipes.
        if (!stopping || !signalGroup(0)) settle(code ?? (signal ? -1 : 0));
      });

      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        // A command may deliberately exit without reading all its input.
        if (error.code === 'EPIPE') return;
        diagnostics.push(`\n[local-executor] stdin failed: ${error.message}\n`);
        stop('error');
      });
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      child.stdin.end();
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
