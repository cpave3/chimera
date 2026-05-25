import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

  it('writeAllowDirs permits writeFile outside cwd', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-write-allow-'));
    try {
      const file = join(outside, 'out.txt');
      const exec = new LocalExecutor({ cwd: root, writeAllowDirs: [outside] });
      await exec.writeFile(file, 'hello');
      expect(await readFile(file, 'utf8')).toBe('hello');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writeAllowDirs does NOT permit readFile outside cwd', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-write-read-'));
    try {
      const file = join(outside, 'secret.txt');
      await writeFile(file, 'shh');
      const exec = new LocalExecutor({ cwd: root, writeAllowDirs: [outside] });
      await expect(exec.readFile(file)).rejects.toBeInstanceOf(PathEscapeError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writeAllowDirs permits exec with cwd outside root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-exec-allow-'));
    try {
      const exec = new LocalExecutor({ cwd: root, writeAllowDirs: [outside] });
      const result = await exec.exec('pwd', { cwd: outside });
      expect(result.stdout.trim()).toBe(outside);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects symlink that escapes writeAllowDirs', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-slink-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'chimera-slink-target-'));
    try {
      const realTarget = join(targetDir, 'secret.txt');
      await writeFile(realTarget, 'secret');
      const linkPath = join(outside, 'link.txt');
      await symlink(realTarget, linkPath);
      const exec = new LocalExecutor({ cwd: root, writeAllowDirs: [outside] });
      await expect(exec.readFile(linkPath)).rejects.toBeInstanceOf(PathEscapeError);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it('writeFile is atomic: uses a temp+rename path', async () => {
    const exec = new LocalExecutor({ cwd: root });
    const target = join(root, 'out.txt');
    await writeFile(target, 'old');
    await exec.writeFile('out.txt', 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('writeFile preserves mode of an existing 0o755 file', async () => {
    const exec = new LocalExecutor({ cwd: root });
    const target = join(root, 'script.sh');
    await writeFile(target, '#!/bin/bash\necho old\n');
    await chmod(target, 0o755);
    await exec.writeFile('script.sh', '#!/bin/bash\necho new\n');
    const fileStats = await stat(target);
    expect(fileStats.mode & 0o777).toBe(0o755);
    expect(await readFile(target, 'utf8')).toBe('#!/bin/bash\necho new\n');
  });

  it('writeFile preserves mode of an existing 0o644 file', async () => {
    const exec = new LocalExecutor({ cwd: root });
    const target = join(root, 'data.txt');
    await writeFile(target, 'old');
    await chmod(target, 0o644);
    await exec.writeFile('data.txt', 'new');
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  it('writeFile creates new file at default mode when target does not exist', async () => {
    const exec = new LocalExecutor({ cwd: root });
    await exec.writeFile('new.txt', 'hello');
    // The exec bits must NOT be set on a freshly created file. Catches the
    // regression where priorMode leaks across calls or a stale 0o755 is applied.
    expect((await stat(join(root, 'new.txt'))).mode & 0o111).toBe(0);
  });

  it('writeFile through a symlink does not copy target mode onto the replacement', async () => {
    const exec = new LocalExecutor({ cwd: root });
    const realFile = join(root, 'real.txt');
    const linkPath = join(root, 'link.txt');
    await writeFile(realFile, 'real');
    await chmod(realFile, 0o755);
    await symlink(realFile, linkPath);
    await exec.writeFile('link.txt', 'via-link');
    const linkStats = await lstat(linkPath);
    expect(linkStats.isSymbolicLink()).toBe(false);
    expect(linkStats.mode & 0o111).toBe(0);
    expect((await stat(realFile)).mode & 0o777).toBe(0o755);
    expect(await readFile(realFile, 'utf8')).toBe('real');
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

  // --- Runtime mutators (addReadAllowDir / addWriteAllowDir) ---

  it('addReadAllowDir lets a subsequent readFile succeed', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-read-mut-'));
    try {
      const file = join(outside, 'secret.txt');
      await writeFile(file, 'hello');
      const exec = new LocalExecutor({ cwd: root });
      await expect(exec.readFile(file)).rejects.toBeInstanceOf(PathEscapeError);
      exec.addReadAllowDir(outside);
      const content = await exec.readFile(file);
      expect(content).toBe('hello');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('addWriteAllowDir lets a subsequent writeFile succeed', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-write-mut-'));
    try {
      const file = join(outside, 'new.txt');
      const exec = new LocalExecutor({ cwd: root });
      await expect(exec.writeFile(file, 'hello')).rejects.toBeInstanceOf(PathEscapeError);
      exec.addWriteAllowDir(outside);
      await exec.writeFile(file, 'hello');
      expect(await readFile(file, 'utf8')).toBe('hello');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('mutators silently ignore duplicate paths', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-dup-'));
    try {
      const exec = new LocalExecutor({ cwd: root });
      exec.addReadAllowDir(outside);
      exec.addReadAllowDir(outside);
      exec.addReadAllowDir(outside);
      exec.addWriteAllowDir(outside);
      exec.addWriteAllowDir(outside);
      expect(exec.listReadAllowDirs().filter((d) => d === resolve(outside)).length).toBe(1);
      expect(exec.listWriteAllowDirs().filter((d) => d === resolve(outside)).length).toBe(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writeFile is still rejected when only addReadAllowDir was used', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'chimera-read-only-'));
    try {
      const file = join(outside, 'new.txt');
      const exec = new LocalExecutor({ cwd: root });
      exec.addReadAllowDir(outside);
      // Read works.
      await writeFile(file, 'existing');
      expect(await exec.readFile(file)).toBe('existing');
      // Write still rejects.
      await expect(exec.writeFile(join(outside, 'another.txt'), 'x')).rejects.toBeInstanceOf(
        PathEscapeError,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
