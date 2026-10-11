import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bwrapCommand,
  detectOsSandbox,
  type OsSandboxSpec,
  sandboxBlockNote,
  seatbeltProfile,
} from '../src/os-sandbox';

const hasBwrap =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true']).status ===
    0;
const describeBwrap = hasBwrap ? describe : describe.skip;

let cwd: string;
let outside: string;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'chimera-os-sandbox-')));
  // A directory outside the project and outside the temp directory.
  outside = mkdtempSync(join(homedir(), '.chimera-os-sandbox-test-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function spec(over: Partial<OsSandboxSpec> = {}): OsSandboxSpec {
  return { cwd, tmp: tmpdir(), writablePaths: [], readOnlyPaths: [], network: 'on', ...over };
}

/** Run a command the way the executor does: the wrapped string through `sh -c`. */
function run(command: string, sandbox = spec()) {
  const result = spawnSync('sh', ['-c', bwrapCommand(sandbox, command)], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describeBwrap('bwrap sandbox', () => {
  it('runs the command in the working directory and returns its output and exit code', () => {
    expect(run('pwd && echo "out $((1 + 1))"; exit 3')).toMatchObject({
      code: 3,
      stdout: `${cwd}\nout 2\n`,
    });
  });

  it('keeps quotes, dollars and newlines of the command intact', () => {
    const result = run(`printf '%s|' "it's" 'a "b"' "$HOME"\necho done`);
    expect(result.stdout).toBe(`it's|a "b"|${process.env.HOME}|done\n`);
  });

  it('lets the command write in the working directory and the temp directory', () => {
    const inTmp = join(tmpdir(), `chimera-os-sandbox-${process.pid}.txt`);
    try {
      const result = run(`echo project > made.txt && echo temp > ${inTmp}`);

      expect(result.code).toBe(0);
      expect(readFileSync(join(cwd, 'made.txt'), 'utf8')).toBe('project\n');
      expect(readFileSync(inTmp, 'utf8')).toBe('temp\n');
    } finally {
      rmSync(inTmp, { force: true });
    }
  });

  it('refuses a write outside them, and the file is not there afterwards', () => {
    const target = join(outside, 'escaped.txt');

    const result = run(`echo no > ${target}`);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Read-only file system/);
    expect(existsSync(target)).toBe(false);
  });

  it('lets the command read outside the project', () => {
    execFileSync('sh', ['-c', `echo secret-ish > ${join(outside, 'readable.txt')}`]);
    expect(run(`cat ${join(outside, 'readable.txt')}`).stdout).toBe('secret-ish\n');
  });

  it('makes an extra write path writable', () => {
    const result = run(
      `echo yes > ${join(outside, 'cache.txt')}`,
      spec({ writablePaths: [outside] }),
    );

    expect(result.code).toBe(0);
    expect(readFileSync(join(outside, 'cache.txt'), 'utf8')).toBe('yes\n');
  });

  it('keeps a protected directory inside the project read-only', () => {
    const state = join(cwd, '.chimera');
    mkdirSync(state);

    const result = run(
      'mkdir -p .chimera/hooks/PreToolUse && echo "#!/bin/sh" > .chimera/hooks/PreToolUse/x.sh',
      spec({ readOnlyPaths: [state] }),
    );

    expect(result.code).not.toBe(0);
    expect(existsSync(join(state, 'hooks'))).toBe(false);
  });

  it('skips a path that does not exist instead of failing to start', () => {
    const result = run(
      'echo ok',
      spec({ writablePaths: ['/no/such/dir'], readOnlyPaths: ['/nor/this'] }),
    );
    expect(result).toMatchObject({ code: 0, stdout: 'ok\n' });
  });

  it('has a network by default and none when the network is off', async () => {
    // The kernel completes the connection from the listen queue, so the
    // server needs no turn of this (blocked) process to be reachable.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const connect = `node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => { console.log('connected'); process.exit(0); }).on('error', () => { console.log('no network'); process.exit(1); })"`;
    try {
      expect(run(connect).stdout).toBe('connected\n');
      expect(run(connect, spec({ network: 'off' })).stdout).toBe('no network\n');
    } finally {
      server.close();
    }
  });
});

describe('seatbelt profile', () => {
  const profile = seatbeltProfile({
    cwd: '/Users/u/code/app',
    tmp: '/private/tmp',
    writablePaths: ['/Users/u/Library/Caches/pnpm'],
    readOnlyPaths: ['/Users/u/code/app/.chimera', '/Users/u/.chimera'],
    network: 'off',
  });

  it('allows everything, then denies writes outside the writable directories', () => {
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(allow default)');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(subpath "/Users/u/code/app")');
    expect(profile).toContain('(subpath "/private/tmp")');
    expect(profile).toContain('(subpath "/Users/u/Library/Caches/pnpm")');
  });

  it('denies the protected directories after the allow, so the deny wins', () => {
    const allow = profile.indexOf('(allow file-write*');
    const deny = profile.indexOf('(deny file-write* (subpath "/Users/u/code/app/.chimera"))');
    expect(allow).toBeGreaterThan(-1);
    expect(deny).toBeGreaterThan(allow);
    expect(profile).toContain('(deny file-write* (subpath "/Users/u/.chimera"))');
  });

  it('denies the network only when the network is off', () => {
    expect(profile).toContain('(deny network*)');
    expect(
      seatbeltProfile({
        cwd: '/a',
        tmp: '/tmp',
        writablePaths: [],
        readOnlyPaths: [],
        network: 'on',
      }),
    ).not.toContain('network');
  });

  it('escapes a path that has a quote in it', () => {
    expect(
      seatbeltProfile({
        cwd: '/a/we"ird',
        tmp: '/tmp',
        writablePaths: [],
        readOnlyPaths: [],
        network: 'on',
      }),
    ).toContain('(subpath "/a/we\\"ird")');
  });
});

describe('detectOsSandbox', () => {
  it('finds bwrap on Linux when a probe command runs in it', () => {
    expect(detectOsSandbox({ platform: 'linux', probe: () => true })).toBe('bwrap');
  });

  it('finds none on Linux when the probe fails, as with user namespaces turned off', () => {
    expect(detectOsSandbox({ platform: 'linux', probe: () => false })).toBeNull();
  });

  it('finds sandbox-exec on macOS when the program is there', () => {
    expect(detectOsSandbox({ platform: 'darwin', probe: () => true })).toBe('sandbox-exec');
    expect(detectOsSandbox({ platform: 'darwin', probe: () => false })).toBeNull();
  });

  it('finds none on other systems', () => {
    expect(detectOsSandbox({ platform: 'win32', probe: () => true })).toBeNull();
  });
});

describe('sandboxBlockNote', () => {
  const failed = (stderr: string) => ({ exitCode: 1, stderr });

  it('explains a refused write and how to ask for an unsandboxed run', () => {
    const note = sandboxBlockNote(
      failed('sh: 1: cannot create /home/u/x: Read-only file system'),
      spec(),
    );

    expect(note).toMatch(/OS sandbox/);
    expect(note).toContain(cwd);
    expect(note).toMatch(/unsandboxed: true/);
    expect(note).toMatch(/reason/);
  });

  it('explains a refused connection when the network is off', () => {
    const offline = spec({ network: 'off' });
    expect(
      sandboxBlockNote(failed('curl: (6) Could not resolve host: example.com'), offline),
    ).toMatch(/network/);
    expect(
      sandboxBlockNote(failed('curl: (6) Could not resolve host: example.com'), spec()),
    ).toBeNull();
  });

  it('says nothing for a command that worked, or failed for its own reasons', () => {
    expect(sandboxBlockNote({ exitCode: 0, stderr: 'Read-only file system' }, spec())).toBeNull();
    expect(sandboxBlockNote(failed('error TS2345: bad type'), spec())).toBeNull();
  });
});
