import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalExecutor } from '../src/local-executor';

async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/stat`, 'utf8');
      return status.slice(status.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    }
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

async function within<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('executor did not complete in time')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

describe('LocalExecutor process lifecycle', () => {
  let root: string;
  let executor: LocalExecutor;
  let pending: ReturnType<LocalExecutor['exec']> | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-exec-lifecycle-'));
    executor = new LocalExecutor({ cwd: root });
    pending = undefined;
    await writeFile(
      join(root, 'child.cjs'),
      `const fs = require('node:fs');
process.on('SIGTERM', () => {
  fs.writeFileSync('term.received', 'yes');
  if (!process.argv.includes('--ignore-term')) process.exit(0);
});
setTimeout(() => process.exit(0), 10000);
process.stdout.write('child output\\n');
fs.writeFileSync('child.pid', String(process.pid));
if (process.argv.includes('--finish-after-release')) {
  setInterval(() => {
    if (!fs.existsSync('release')) return;
    process.stdout.write('final output\\n');
    process.stderr.write('final error\\n');
    process.exit(0);
  }, 10);
}
`,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const file of ['child.pid', 'shell.pid']) {
      try {
        const pid = Number(await readFile(join(root, file), 'utf8'));
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (!['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    if (pending) await within(pending, 3000);
    await rm(root, { recursive: true, force: true });
  });

  async function pidFrom(file: string): Promise<number> {
    let pid = 0;
    await vi.waitFor(
      async () => {
        pid = Number(await readFile(join(root, file), 'utf8'));
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 2000, interval: 10 },
    );
    return pid;
  }

  it('retains final child output after normal shell exit', async () => {
    pending = executor.exec(
      `echo $$ > shell.pid; "${process.execPath}" child.cjs --finish-after-release &`,
    );
    await pidFrom('child.pid');
    const shellPid = await pidFrom('shell.pid');
    await vi.waitFor(async () => expect(await isRunning(shellPid)).toBe(false));
    await writeFile(join(root, 'release'), 'yes');
    expect(await within(pending, 3000)).toMatchObject({
      stdout: 'child output\nfinal output\n',
      stderr: 'final error\n',
      timedOut: false,
      exitCode: 0,
    });
  });

  it('honors interruption after the shell has exited', async () => {
    const controller = new AbortController();
    pending = executor.exec(`echo $$ > shell.pid; "${process.execPath}" child.cjs &`, {
      signal: controller.signal,
    });
    const childPid = await pidFrom('child.pid');
    const shellPid = await pidFrom('shell.pid');
    await vi.waitFor(async () => expect(await isRunning(shellPid)).toBe(false));
    controller.abort();
    const result = await within(pending, 3000);
    expect(result).toMatchObject({ timedOut: false, exitCode: -1 });
    expect(result.stderr).toContain('aborted');
    await vi.waitFor(async () => expect(await isRunning(childPid)).toBe(false));
  });

  it('escalates after shell close when a resistant child redirects its output', async () => {
    const controller = new AbortController();
    pending = executor.exec(
      `echo $$ > shell.pid; "${process.execPath}" child.cjs --ignore-term >/dev/null 2>&1 & wait`,
      { signal: controller.signal },
    );
    const childPid = await pidFrom('child.pid');
    controller.abort();
    const result = await within(pending, 3000);
    expect(result).toMatchObject({ timedOut: false, exitCode: -1 });
    expect(await readFile(join(root, 'term.received'), 'utf8')).toBe('yes');
    expect(await isRunning(childPid)).toBe(false);
  });

  it('keeps SIGKILL scheduled when interruption follows timeout', async () => {
    const controller = new AbortController();
    pending = executor.exec(
      `echo $$ > shell.pid; "${process.execPath}" child.cjs --ignore-term &`,
      {
        timeoutMs: 2000,
        signal: controller.signal,
      },
    );
    const childPid = await pidFrom('child.pid');
    await vi.waitFor(
      async () => expect(await readFile(join(root, 'term.received'), 'utf8')).toBe('yes'),
      { timeout: 2000, interval: 10 },
    );
    controller.abort();
    const result = await within(pending, 3000);
    expect(result).toMatchObject({ timedOut: true, exitCode: -1 });
    expect(result.stdout).toContain('child output');
    expect(await isRunning(childPid)).toBe(false);
  });

  it('stops a waiting shell and its child on early interruption', async () => {
    const controller = new AbortController();
    pending = executor.exec(`echo $$ > shell.pid; "${process.execPath}" child.cjs & wait`, {
      signal: controller.signal,
    });
    const childPid = await pidFrom('child.pid');
    const shellPid = await pidFrom('shell.pid');
    expect(await isRunning(shellPid)).toBe(true);
    controller.abort();
    const result = await within(pending, 3000);
    expect(result).toMatchObject({ timedOut: false, exitCode: -1 });
    expect(await isRunning(shellPid)).toBe(false);
    expect(await isRunning(childPid)).toBe(false);
  });

  it('does not execute a command with an already-aborted signal', async () => {
    const result = await executor.exec('echo unexpected > side-effect', {
      signal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ timedOut: false, exitCode: -1 });
    await expect(readFile(join(root, 'side-effect'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await executor.exec('echo next')).stdout).toBe('next\n');
  });

  it('preserves nonzero exits, stdin, and stderr without cancelling later commands', async () => {
    const controller = new AbortController();
    const result = await executor.exec('cat; echo failure >&2; exit 7', {
      stdin: 'input\n',
      timeoutMs: 50,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      stdout: 'input\n',
      stderr: 'failure\n',
      exitCode: 7,
      timedOut: false,
    });
    controller.abort();
    expect((await executor.exec('echo next')).stdout).toBe('next\n');
  });

  it('finishes when the command closes stdin before consuming its input', async () => {
    const result = await executor.exec('exit 7', { stdin: 'x'.repeat(1024 * 1024) });
    expect(result).toMatchObject({ exitCode: 7, timedOut: false });
  });

  it('returns spawn failures without leaving the executor blocked', async () => {
    const result = await executor.exec('echo unreachable', { env: { PATH: '' } });
    expect(result).toMatchObject({ exitCode: -1, timedOut: false });
    expect(result.stderr).toContain('ENOENT');
    expect((await executor.exec('echo next')).stdout).toBe('next\n');
  });

  it('reports a remaining group even when its pipes closed and signalling succeeded', async () => {
    const controller = new AbortController();
    pending = executor.exec(
      `echo $$ > shell.pid; "${process.execPath}" child.cjs --ignore-term >/dev/null 2>&1 & wait`,
      { signal: controller.signal },
    );
    const childPid = await pidFrom('child.pid');
    const shellPid = await pidFrom('shell.pid');
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      // A group signal can succeed without terminating every member (e.g. mixed UIDs).
      if (pid === -shellPid && signal === 'SIGKILL') return true;
      return kill(pid, signal);
    });
    controller.abort();
    const result = await within(pending, 3000);
    expect(result).toMatchObject({ timedOut: false, exitCode: -1 });
    expect(result.stderr).toContain('process group still exists');
    expect(await isRunning(childPid)).toBe(true);
  });

  it('reports signalling failures and still completes within the cleanup bound', async () => {
    const controller = new AbortController();
    pending = executor.exec(`echo $$ > shell.pid; "${process.execPath}" child.cjs & wait`, {
      signal: controller.signal,
    });
    const childPid = await pidFrom('child.pid');
    const shellPid = await pidFrom('shell.pid');
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -shellPid && signal !== 0) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return kill(pid, signal);
    });
    controller.abort();
    const result = await within(pending, 3000);
    expect(result).toMatchObject({ timedOut: false, exitCode: -1 });
    expect(result.stderr).toContain('SIGTERM failed');
    expect(result.stderr).toContain('SIGKILL failed');
    expect(result.stderr).toContain('operation not permitted');
    expect(result.stderr).toContain('cleanup incomplete');
    expect(await isRunning(childPid)).toBe(true);
  });

  it('bounds cleanup when an escaped child keeps output pipes open', async () => {
    await writeFile(
      join(root, 'launcher.cjs'),
      `require('node:child_process').spawn(process.execPath, ['child.cjs'], {
  detached: true,
  stdio: ['ignore', 1, 2],
}).unref();`,
    );
    const controller = new AbortController();
    pending = executor.exec(`echo $$ > shell.pid; "${process.execPath}" launcher.cjs`, {
      signal: controller.signal,
    });
    const childPid = await pidFrom('child.pid');
    controller.abort();
    const result = await within(pending, 3000);
    expect(result).toMatchObject({ timedOut: false, exitCode: -1 });
    expect(result.stdout).toContain('child output');
    expect(result.stderr).toContain('cleanup incomplete');
    expect(await isRunning(childPid)).toBe(true);
  });

  it('times out when a child holds output pipes after the shell exits', async () => {
    pending = executor.exec(`echo $$ > shell.pid; "${process.execPath}" child.cjs &`, {
      timeoutMs: 2000,
    });
    const childPid = await pidFrom('child.pid');
    await vi.waitFor(
      async () => expect(await readFile(join(root, 'term.received'), 'utf8')).toBe('yes'),
      { timeout: 3000, interval: 10 },
    );
    const result = await within(pending, 3000);
    expect(result).toMatchObject({ timedOut: true, exitCode: -1 });
    expect(result.stdout).toContain('child output');
    await vi.waitFor(async () => expect(await isRunning(childPid)).toBe(false));
  });
});
