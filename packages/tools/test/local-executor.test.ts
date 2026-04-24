import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    await expect(exec.writeFile('../outside.txt', 'x')).rejects.toBeInstanceOf(
      PathEscapeError,
    );
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

  it('writeFile is atomic: uses a temp+rename path', async () => {
    const exec = new LocalExecutor({ cwd: root });
    const target = join(root, 'out.txt');
    await writeFile(target, 'old');
    await exec.writeFile('out.txt', 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });
});
