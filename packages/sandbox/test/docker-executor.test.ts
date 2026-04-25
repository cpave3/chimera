import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerExecutor } from '../src/docker-executor';
import type { DockerRunner, RunOptions } from '../src/docker-runner';

interface ScriptedCall {
  match: (args: string[]) => boolean;
  result: {
    stdout?: string | Buffer;
    stderr?: string;
    exitCode?: number;
    timedOut?: boolean;
  };
}

class FakeRunner implements DockerRunner {
  calls: { args: string[]; opts?: RunOptions }[] = [];
  scripts: ScriptedCall[] = [];
  /** Default fallback for unmatched calls. */
  defaultResult: ScriptedCall['result'] = { exitCode: 0 };

  on(match: ScriptedCall['match'], result: ScriptedCall['result']): this {
    this.scripts.push({ match, result });
    return this;
  }

  async run(args: string[], opts?: RunOptions) {
    const r = await this.runRaw(args, opts);
    return {
      stdout:
        typeof r.stdout === 'string' ? r.stdout : Buffer.from(r.stdout).toString('utf8'),
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    };
  }

  async runRaw(args: string[], opts?: RunOptions) {
    this.calls.push({ args, opts });
    for (const s of this.scripts) {
      if (s.match(args)) {
        return materialize(s.result);
      }
    }
    return materialize(this.defaultResult);
  }
}

function materialize(r: ScriptedCall['result']) {
  const stdout =
    r.stdout === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(r.stdout)
        ? r.stdout
        : Buffer.from(r.stdout, 'utf8');
  return {
    stdout,
    stderr: r.stderr ?? '',
    exitCode: r.exitCode ?? 0,
    timedOut: r.timedOut ?? false,
  };
}

const SESSION = 'sess-exec-test';
let overlaysHome: string;
let cwd: string;

beforeEach(async () => {
  overlaysHome = await mkdtemp(join(tmpdir(), 'chimera-ov-'));
  cwd = await mkdtemp(join(tmpdir(), 'chimera-cwd-'));
});

afterEach(async () => {
  await rm(overlaysHome, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe('DockerExecutor.start mount strategy', () => {
  it('bind mode mounts cwd:/workspace:rw and skips SYS_ADMIN', async () => {
    const runner = new FakeRunner();
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await exec.start();
    const runCall = runner.calls.find((c) => c.args[0] === 'run');
    expect(runCall).toBeDefined();
    const args = runCall!.args;
    expect(args).toContain('-v');
    expect(args).toContain(`${cwd}:/workspace:rw`);
    expect(args).not.toContain('SYS_ADMIN');
    expect(args).toContain('-e');
    expect(args).toContain('CHIMERA_MODE=bind');
  });

  it('overlay mode mounts /lower:ro + /upper and adds SYS_ADMIN', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'inspect',
      { stdout: 'true|0|running\n', exitCode: 0 },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'overlay',
      sessionId: SESSION,
      hostCwd: cwd,
      overlaysHome,
    });
    await exec.start();
    expect(exec.mode()).toBe('overlay');
    const runCall = runner.calls.find((c) => c.args[0] === 'run')!;
    const args = runCall.args;
    expect(args).toContain(`${cwd}:/lower:ro`);
    expect(args.some((a) => a.endsWith(`/${SESSION}/upper:/upper`))).toBe(true);
    expect(args).toContain('SYS_ADMIN');
    expect(args).toContain('apparmor=unconfined');
  });

  it('ephemeral mode uses --tmpfs /upper', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'inspect',
      { stdout: 'true|0|running\n', exitCode: 0 },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'ephemeral',
      sessionId: SESSION,
      hostCwd: cwd,
      overlaysHome,
    });
    await exec.start();
    const args = runner.calls.find((c) => c.args[0] === 'run')!.args;
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/upper');
    expect(args).not.toContain(`${cwd}:/workspace:rw`);
  });

  it('honors --network none and resource flags', async () => {
    const runner = new FakeRunner();
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
      network: 'none',
      memory: '1g',
      cpus: '4',
    });
    await exec.start();
    const args = runner.calls.find((c) => c.args[0] === 'run')!.args;
    const networkIdx = args.indexOf('--network');
    expect(args[networkIdx + 1]).toBe('none');
    expect(args).toContain('--memory');
    expect(args[args.indexOf('--memory') + 1]).toBe('1g');
    expect(args).toContain('--cpus');
    expect(args[args.indexOf('--cpus') + 1]).toBe('4');
  });
});

describe('DockerExecutor overlay fallback', () => {
  it('falls back to bind when entrypoint exits non-zero', async () => {
    const runner = new FakeRunner();
    let inspectCalls = 0;
    runner.on(
      (a) => a[0] === 'inspect',
      // First inspect (overlay attempt) shows exited; second (bind retry) running.
      // We can't differentiate by arg, so use a counter via on-match closures.
      {},
    );
    runner.scripts.pop(); // remove placeholder so we add stateful one
    runner.on(
      (a) => a[0] === 'inspect',
      {},
    );
    runner.scripts.pop();
    runner.scripts.push({
      match: (a) => a[0] === 'inspect',
      result: {},
    });
    // Override run() with stateful inspect.
    const origRun = runner.run.bind(runner);
    runner.run = async (args, opts) => {
      if (args[0] === 'inspect') {
        inspectCalls += 1;
        if (inspectCalls === 1) {
          return {
            stdout: 'false|78|exited\n',
            stderr: '',
            exitCode: 0,
            timedOut: false,
          };
        }
        return { stdout: 'true|0|running\n', stderr: '', exitCode: 0, timedOut: false };
      }
      return origRun(args, opts);
    };

    const warnings: string[] = [];
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'overlay',
      sessionId: SESSION,
      hostCwd: cwd,
      overlaysHome,
      warn: (m) => warnings.push(m),
    });
    await exec.start();
    expect(exec.mode()).toBe('bind');
    expect(exec.fallbackEvent()?.fromMode).toBe('overlay');
    expect(exec.fallbackEvent()?.toMode).toBe('bind');
    expect(warnings.some((w) => /falling back to bind/.test(w))).toBe(true);
  });

  it('refuses fallback under strict', async () => {
    const runner = new FakeRunner();
    runner.run = async () => ({
      stdout: 'false|78|exited\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
    runner.runRaw = runner.run as never;

    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'overlay',
      sessionId: SESSION,
      hostCwd: cwd,
      overlaysHome,
      strict: true,
    });
    await expect(exec.start()).rejects.toThrow(/refused under --sandbox-strict/);
  });
});

describe('DockerExecutor file ops', () => {
  it('writeFile streams content via docker exec -i tee+mv', async () => {
    const runner = new FakeRunner();
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await exec.start();
    await exec.writeFile('a/b.txt', 'hello');
    const writeCall = runner.calls.find(
      (c) => c.args[0] === 'exec' && c.args.includes('sh') && c.args.includes('-c'),
    );
    expect(writeCall).toBeDefined();
    expect(writeCall!.opts?.stdin).toBe('hello');
    const cmdIdx = writeCall!.args.indexOf('-c');
    const cmd = writeCall!.args[cmdIdx + 1]!;
    expect(cmd).toContain('mkdir -p');
    expect(cmd).toContain('/workspace/a');
    expect(cmd).toContain('mv');
  });

  it('readFile cat returns stdout bytes', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'exec' && a.includes('cat'),
      { stdout: Buffer.from('payload', 'utf8') },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await exec.start();
    expect(await exec.readFile('foo.txt')).toBe('payload');
  });

  it('stat parses %F|%s output', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'exec' && a.includes('stat'),
      { stdout: 'regular file|42\n' },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await exec.start();
    const s = await exec.stat('foo.txt');
    expect(s).toEqual({ exists: true, isDir: false, size: 42 });
  });

  it('stat returns null for No such file', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'exec' && a.includes('stat'),
      { exitCode: 1, stderr: "stat: cannot stat 'x': No such file or directory" },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await exec.start();
    expect(await exec.stat('x')).toBeNull();
  });

  it('exec routes command via docker exec -i sh -c', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'exec' && a.includes('sh'),
      { stdout: 'hello\n', exitCode: 0 },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await exec.start();
    const r = await exec.exec('echo hello');
    expect(r.stdout).toBe('hello\n');
    expect(r.exitCode).toBe(0);
    const call = runner.calls.find(
      (c) => c.args[0] === 'exec' && c.args.includes('sh'),
    )!;
    expect(call.args[1]).toBe('-i');
    expect(call.args[call.args.indexOf('-c') + 1]).toBe('echo hello');
  });

  it('exec forwards timeoutMs to the runner', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'exec' && a.includes('sh'),
      { stdout: '', exitCode: -1, timedOut: true },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await exec.start();
    const r = await exec.exec('sleep 60', { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    const execCall = runner.calls.find(
      (c) => c.args[0] === 'exec' && c.args.includes('sh'),
    )!;
    expect(execCall.opts?.timeoutMs).toBe(100);
  });
});

describe('DockerExecutor host user mapping', () => {
  it('passes CHIMERA_HOST_UID/GID env vars on docker run when hostUid/hostGid are set', async () => {
    const runner = new FakeRunner();
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
      hostUid: 1234,
      hostGid: 5678,
    });
    await exec.start();
    const runCall = runner.calls.find((c) => c.args[0] === 'run')!;
    expect(runCall.args).toContain('CHIMERA_HOST_UID=1234');
    expect(runCall.args).toContain('CHIMERA_HOST_GID=5678');
  });

  it('passes --user UID:GID on docker exec for exec/readFile/writeFile/stat', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'exec' && a.includes('cat'),
      { stdout: Buffer.from('payload', 'utf8') },
    );
    runner.on(
      (a) => a[0] === 'exec' && a.includes('stat'),
      { stdout: 'regular file|0\n' },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
      hostUid: 1234,
      hostGid: 5678,
    });
    await exec.start();
    await exec.exec('echo hi');
    await exec.readFile('foo.txt');
    await exec.writeFile('bar.txt', 'data');
    await exec.stat('foo.txt');

    const execCalls = runner.calls.filter((c) => c.args[0] === 'exec');
    expect(execCalls.length).toBeGreaterThan(0);
    for (const call of execCalls) {
      const idx = call.args.indexOf('--user');
      expect(idx).toBeGreaterThan(0);
      expect(call.args[idx + 1]).toBe('1234:5678');
    }
  });

  it('omits --user and host-uid env vars when hostUid is null', async () => {
    const runner = new FakeRunner();
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
      hostUid: null,
      hostGid: null,
    });
    await exec.start();
    await exec.exec('echo hi');
    const runCall = runner.calls.find((c) => c.args[0] === 'run')!;
    expect(runCall.args.some((a) => a.startsWith('CHIMERA_HOST_UID='))).toBe(false);
    expect(runCall.args.some((a) => a.startsWith('CHIMERA_HOST_GID='))).toBe(false);
    const execCall = runner.calls.find(
      (c) => c.args[0] === 'exec' && c.args.includes('sh'),
    )!;
    expect(execCall.args).not.toContain('--user');
  });
});

describe('DockerExecutor.ensureImage', () => {
  it('errors when the image is missing and dockerfileDir is not set', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'image' && a[1] === 'inspect',
      { exitCode: 1, stderr: 'No such image' },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'someone-else/chimera-sandbox:weird',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await expect(exec.start()).rejects.toThrow(/not present locally/);
  });

  it('auto-builds the bundled image when dockerfileDir is set', async () => {
    const runner = new FakeRunner();
    let inspectCalls = 0;
    const origRun = runner.run.bind(runner);
    runner.run = async (args, opts) => {
      runner.calls.push({ args, opts });
      if (args[0] === 'image' && args[1] === 'inspect') {
        inspectCalls += 1;
        return { stdout: '', stderr: 'No such image', exitCode: 1, timedOut: false };
      }
      if (args[0] === 'build') {
        return { stdout: 'Successfully built', stderr: '', exitCode: 0, timedOut: false };
      }
      return origRun(args, opts);
    };

    const warnings: string[] = [];
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:dev',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
      dockerfileDir: '/fake/docker',
      warn: (m) => warnings.push(m),
    });
    await exec.start();
    expect(inspectCalls).toBe(1);
    expect(warnings.some((w) => /missing — building/.test(w))).toBe(true);
    const buildCall = runner.calls.find((c) => c.args[0] === 'build');
    expect(buildCall).toBeDefined();
    expect(buildCall!.args).toEqual([
      'build',
      '-t',
      'chimera-sandbox:dev',
      '/fake/docker',
    ]);
  });

  it('skips build when image is already present', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'image' && a[1] === 'inspect',
      { stdout: '[{...}]', exitCode: 0 },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:dev',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
      dockerfileDir: '/fake/docker',
    });
    await exec.start();
    expect(runner.calls.find((c) => c.args[0] === 'build')).toBeUndefined();
  });

  it('throws when build fails', async () => {
    const runner = new FakeRunner();
    runner.run = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { stdout: '', stderr: '', exitCode: 1, timedOut: false };
      }
      if (args[0] === 'build') {
        return { stdout: '', stderr: 'no such file', exitCode: 1, timedOut: false };
      }
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    };
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:dev',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
      dockerfileDir: '/fake/docker',
    });
    await expect(exec.start()).rejects.toThrow(/'docker build .* failed/);
  });
});

describe('DockerExecutor lifecycle', () => {
  it('stop is idempotent', async () => {
    const runner = new FakeRunner();
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await exec.start();
    await exec.stop();
    await exec.stop();
  });

  it('stop retains overlay upperdir; discardUpperdir removes it', async () => {
    const runner = new FakeRunner();
    runner.on(
      (a) => a[0] === 'inspect',
      { stdout: 'true|0|running\n' },
    );
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'overlay',
      sessionId: SESSION,
      hostCwd: cwd,
      overlaysHome,
    });
    await exec.start();
    await exec.stop();
    // Upperdir still exists.
    const fs = await import('node:fs/promises');
    await fs.stat(join(overlaysHome, SESSION));
    await exec.discardUpperdir();
    await expect(fs.stat(join(overlaysHome, SESSION))).rejects.toThrow();
  });

  it('exec after stop throws', async () => {
    const runner = new FakeRunner();
    const exec = new DockerExecutor({
      runner,
      image: 'chimera-sandbox:test',
      mode: 'bind',
      sessionId: SESSION,
      hostCwd: cwd,
    });
    await exec.start();
    await exec.stop();
    await expect(exec.exec('echo hi')).rejects.toThrow(/cannot use after stop/);
  });
});
