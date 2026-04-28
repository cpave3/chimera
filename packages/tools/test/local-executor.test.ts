import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathEscapeError } from '../src/errors';
import { LocalExecutor } from '../src/local-executor';

describe('LocalExecutor', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-exec-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads and writes files relative to cwd', async () => {
    const exec = new LocalExecutor({ cwd: root });
    await exec.writeFile('a/b.txt', 'hello');
    const content = await exec.readFile('a/b.txt');
    expect(content).toBe('hello');
    const st = await exec.stat('a/b.txt');
    expect(st?.exists).toBe(true);
    expect(st?.size).toBe(5);
  });

  it('throws PathEscapeError on absolute path outside cwd', async () => {
    const exec = new LocalExecutor({ cwd: root });
    await expect(exec.readFile('/etc/passwd')).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('throws PathEscapeError on ../ traversal', async () => {
    const exec = new LocalExecutor({ cwd: root });
    await expect(exec.writeFile('../outside.txt', 'x')).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('stat returns null for missing files', async () => {
    const exec = new LocalExecutor({ cwd: root });
    expect(await exec.stat('missing.txt')).toBeNull();
  });

  it('exec runs a command and returns stdout/exit', async () => {
    const exec = new LocalExecutor({ cwd: root });
    const r = await exec.exec('echo hi');
    expect(r.stdout).toContain('hi');
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('exec timeout sets timedOut=true and terminates the process', async () => {
    const exec = new LocalExecutor({ cwd: root });
    const r = await exec.exec('sleep 10', { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  }, 10_000);

  it('exec honors AbortSignal', async () => {
    const exec = new LocalExecutor({ cwd: root });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await exec.exec('sleep 5', { signal: ac.signal });
    expect(r.exitCode).not.toBe(0);
  }, 10_000);

  it('readAllowDirs permits reads outside cwd on allow-listed paths', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-allow-'));
    try {
      const skillDir = join(outside, 'pdf');
      await mkdir(skillDir);
      await writeFile(join(skillDir, 'SKILL.md'), 'hello-skill');

      const exec = new LocalExecutor({
        cwd: root,
        readAllowDirs: [skillDir],
      });
      const content = await exec.readFile(join(skillDir, 'SKILL.md'));
      expect(content).toBe('hello-skill');

      // Stat of the allow-listed file also succeeds.
      expect((await exec.stat(join(skillDir, 'SKILL.md')))?.exists).toBe(true);

      // A sibling path outside the allow-list is still rejected.
      const sibling = join(outside, 'other.txt');
      await writeFile(sibling, 'nope');
      await expect(exec.readFile(sibling)).rejects.toBeInstanceOf(PathEscapeError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('readAllowDirs does NOT permit writes outside cwd', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-allow-w-'));
    try {
      const allowed = join(outside, 'pdf');
      await mkdir(allowed);
      const exec = new LocalExecutor({ cwd: root, readAllowDirs: [allowed] });
      await expect(exec.writeFile(join(allowed, 'new.txt'), 'x')).rejects.toBeInstanceOf(
        PathEscapeError,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writeFile is atomic: uses a temp+rename path', async () => {
    const exec = new LocalExecutor({ cwd: root });
    const target = join(root, 'out.txt');
    await writeFile(target, 'old');
    await exec.writeFile('out.txt', 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('exec caps stdout at maxOutputBytes and reports stdoutTruncated', async () => {
    const exec = new LocalExecutor({ cwd: root, maxOutputBytes: 1024 });
    // Write 4 KB of "a" to stdout — must exceed 1 KB cap.
    const result = await exec.exec(`yes a | head -c 4096`);
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('exec leaves stdoutTruncated/stderrTruncated false when under the cap', async () => {
    const exec = new LocalExecutor({ cwd: root, maxOutputBytes: 1024 });
    const result = await exec.exec('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  it('exec caps stderr at maxOutputBytes and reports stderrTruncated', async () => {
    const exec = new LocalExecutor({ cwd: root, maxOutputBytes: 1024 });
    const result = await exec.exec(`yes a | head -c 4096 1>&2`);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stdoutTruncated).toBe(false);
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('readdir returns sorted entries with isDir flags', async () => {
    const exec = new LocalExecutor({ cwd: root });
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'b.txt'), 'x');
    await writeFile(join(root, 'a.txt'), 'x');
    const entries = await exec.readdir('.');
    expect(entries).toEqual([
      { name: 'a.txt', isDir: false },
      { name: 'b.txt', isDir: false },
      { name: 'sub', isDir: true },
    ]);
  });
});
