import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { DirEntry, ExecOptions, ExecResult, Executor, StatResult } from '@chimera/core';
import { PathEscapeError } from './errors';

const DEFAULT_TIMEOUT_MS = 120_000;
const SIGKILL_DELAY_MS = 2_000;

export interface LocalExecutorOptions {
  cwd: string;
  /**
   * Extra absolute directories that are permitted for READ operations only.
   * Used for out-of-cwd resources the agent legitimately needs (notably
   * skill directories under `~/.chimera/skills/` and `~/.claude/skills/`).
   * Writes and exec remain strictly cwd-scoped regardless of this list.
   */
  readAllowDirs?: string[];
}

export class LocalExecutor implements Executor {
  private readonly rootCwd: string;
  private readonly readAllowDirs: string[];

  constructor(opts: LocalExecutorOptions) {
    this.rootCwd = resolve(opts.cwd);
    this.readAllowDirs = (opts.readAllowDirs ?? []).map((d) => resolve(d));
  }

  cwd(): string {
    return this.rootCwd;
  }

  target(): 'host' {
    return 'host';
  }

  /**
   * Resolve a relative or absolute path against the executor's cwd and
   * reject any result that falls outside it.
   */
  private resolveSafe(path: string): string {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.rootCwd, path);
    const rel = relative(this.rootCwd, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new PathEscapeError(path, this.rootCwd);
    }
    return absolute;
  }

  /**
   * Read-mode path resolution: allow `rootCwd` plus any configured
   * `readAllowDirs`. Returns the absolute path on success.
   */
  private resolveReadable(path: string): string {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.rootCwd, path);
    const relCwd = relative(this.rootCwd, absolute);
    const underCwd = !relCwd.startsWith('..') && !isAbsolute(relCwd);
    if (underCwd) return absolute;
    for (const dir of this.readAllowDirs) {
      const rel = relative(dir, absolute);
      if (!rel.startsWith('..') && !isAbsolute(rel)) return absolute;
    }
    throw new PathEscapeError(path, this.rootCwd);
  }

  async readFile(path: string): Promise<string> {
    const abs = this.resolveReadable(path);
    return readFile(abs, 'utf8');
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const abs = this.resolveReadable(path);
    return readFile(abs);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.resolveSafe(path);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, abs);
  }

  async stat(path: string): Promise<StatResult | null> {
    try {
      const abs = this.resolveReadable(path);
      const st = await stat(abs);
      return { exists: true, isDir: st.isDirectory(), size: st.size };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw err;
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const abs = this.resolveReadable(path);
    const entries = await readdir(abs, { withFileTypes: true });
    return entries
      .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cwd = opts.cwd ? this.resolveSafe(opts.cwd) : this.rootCwd;

    return new Promise<ExecResult>((resolvePromise) => {
      const child = spawn('sh', ['-c', cmd], {
        cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: opts.signal,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // already exited
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already exited
          }
        }, SIGKILL_DELAY_MS);
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
      }
      child.stdin.end();

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        resolvePromise({
          stdout,
          stderr: stderr + String(err?.message ?? err),
          exitCode: -1,
          timedOut,
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        const exitCode =
          code === null ? (signal === 'SIGTERM' || signal === 'SIGKILL' ? -1 : 0) : code;
        resolvePromise({ stdout, stderr, exitCode, timedOut });
      });
    });
  }
}
