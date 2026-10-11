import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionGate, PermissionRequest, PermissionResolution } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundProcessManager } from '../src/background';
import { buildBashTool } from '../src/bash';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';
import { createOsSandbox } from '../src/os-sandbox';

const hasBwrap =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true']).status ===
    0;
const describeBwrap = hasBwrap ? describe : describe.skip;

type Bash = { execute: (args: object, options?: object) => Promise<any> };

class RecordingGate implements PermissionGate {
  requests: PermissionRequest[] = [];
  answer: PermissionResolution = { decision: 'allow', remembered: false };
  async request(request: PermissionRequest): Promise<PermissionResolution> {
    this.requests.push(request);
    return this.answer;
  }
  check = () => null;
  addRule = () => {};
  listRules = () => [];
  removeRule = () => {};
}

let root: string;
let cwd: string;
let sandboxTmp: string;
let outside: string;
let gate: RecordingGate;
let manager: BackgroundProcessManager;

beforeEach(() => {
  // Siblings under one root: the suite needs nothing outside the system
  // temp directory, and `outside` is still outside what the sandbox allows.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'chimera-bash-sandbox-')));
  cwd = join(root, 'project');
  sandboxTmp = join(root, 'tmp');
  outside = join(root, 'outside');
  for (const directory of [cwd, sandboxTmp, outside]) mkdirSync(directory);
  gate = new RecordingGate();
  manager = new BackgroundProcessManager({ cwd });
});

afterEach(() => {
  manager.killAll();
  rmSync(root, { recursive: true, force: true });
});

function bash(over: Partial<ToolContext> = {}): Bash {
  const executor = new LocalExecutor({ cwd });
  const ctx: ToolContext = {
    sandboxExecutor: executor,
    hostExecutor: executor,
    sandboxMode: 'off',
    permissionGate: gate,
    backgroundProcesses: manager,
    osSandbox: createOsSandbox('bwrap', {
      cwd,
      tmp: sandboxTmp,
      writablePaths: [],
      readOnlyPaths: [],
      network: 'on',
    }),
    ...over,
  };
  const built = buildBashTool(ctx).tool as unknown as Bash;
  return { execute: (args) => built.execute(args, {}) };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('bash tool description', () => {
  const description = (over: Partial<ToolContext> = {}) => {
    const executor = new LocalExecutor({ cwd });
    return (
      buildBashTool({
        sandboxExecutor: executor,
        hostExecutor: executor,
        sandboxMode: 'off',
        ...over,
      }).tool as unknown as { description: string }
    ).description;
  };
  const sandbox = (network: 'on' | 'off') =>
    createOsSandbox('bwrap', {
      cwd,
      tmp: sandboxTmp,
      writablePaths: [],
      readOnlyPaths: [],
      network,
    });

  it('tells the model what the OS sandbox allows before a command fails in it', () => {
    const active = description({ osSandbox: sandbox('on') });

    expect(active).toMatch(/OS sandbox/);
    expect(active).toMatch(/working directory/);
    expect(active).toMatch(/unsandboxed: true/);
    expect(active).not.toMatch(/network/);
    expect(description({ osSandbox: sandbox('off') })).toMatch(/no network/);
  });

  it('does not speak of the OS sandbox when none is active', () => {
    expect(description()).not.toMatch(/OS sandbox/);
    expect(description({ osSandbox: sandbox('on'), sandboxMode: 'bind' })).not.toMatch(
      /OS sandbox/,
    );
  });
});

describeBwrap('bash in the OS sandbox', () => {
  it('runs a host command in the sandbox and tells the gate so', async () => {
    const target = join(outside, 'escaped.txt');

    const inside = await bash().execute({ command: 'echo hi > made.txt && cat made.txt' });
    const escaping = await bash().execute({ command: `echo no > ${target}` });

    expect(inside).toMatchObject({ stdout: 'hi\n', exit_code: 0 });
    expect(inside.sandbox).toBeUndefined();
    expect(readFileSync(join(cwd, 'made.txt'), 'utf8')).toBe('hi\n');
    expect(escaping.exit_code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(gate.requests[0]).toMatchObject({
      command: 'echo hi > made.txt && cat made.txt',
      osSandbox: true,
    });
  });

  it('adds a note to the result of a command the sandbox blocked', async () => {
    const result = await bash().execute({ command: `echo no > ${join(outside, 'x.txt')}` });

    expect(result.sandbox).toMatch(/OS sandbox refused a write/);
    expect(result.sandbox).toMatch(/unsandboxed: true/);
  });

  it('runs a command outside the sandbox when asked, and asks the gate for that', async () => {
    const target = join(outside, 'allowed.txt');

    const result = await bash().execute({
      command: `echo yes > ${target}`,
      unsandboxed: true,
      reason: 'the tool writes its cache in the home directory',
    });

    expect(result.exit_code).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('yes\n');
    expect(gate.requests[0]).toMatchObject({
      unsandboxed: true,
      reason: 'the tool writes its cache in the home directory',
    });
    expect(gate.requests[0]!.osSandbox).toBeUndefined();
  });

  it('does not run an unsandboxed command without a reason, or when the user says no', async () => {
    const target = join(outside, 'denied.txt');

    const noReason = await bash().execute({ command: `echo x > ${target}`, unsandboxed: true });
    gate.answer = { decision: 'deny', remembered: false, denialSource: 'user' };
    const denied = await bash().execute({
      command: `echo x > ${target}`,
      unsandboxed: true,
      reason: 'because',
    });

    expect(noReason.stderr).toMatch(/reason/);
    expect(gate.requests).toHaveLength(1);
    expect(denied.exit_code).toBe(-1);
    expect(existsSync(target)).toBe(false);
  });

  it('runs a command approved for sudo outside the sandbox, where setuid works', async () => {
    gate.answer = { decision: 'allow', remembered: false, authentication: 'sudo' };
    const target = join(outside, 'as-root.txt');

    const result = await bash({
      hostAuthentication: { consumeSudoAuthentication: () => true } as never,
    }).execute({ command: `echo root > ${target}` });

    expect(result.exit_code).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it('runs a background command in the sandbox too, and shows the command as the model wrote it', async () => {
    const target = join(outside, 'background.txt');

    const started = await bash().execute({
      command: `echo no > ${target}; echo marker > bg.txt`,
      run_in_background: true,
    });
    await until(() => existsSync(join(cwd, 'bg.txt')));

    expect(existsSync(target)).toBe(false);
    expect(manager.get(started.shell_id)?.command).toBe(
      `echo no > ${target}; echo marker > bg.txt`,
    );
    expect(gate.requests[0]).toMatchObject({ osSandbox: true });
  });
});

describe('bash without a usable OS sandbox', () => {
  it('refuses every host command when the sandbox is required and missing', async () => {
    const refusal =
      'refused by chimera: commandPolicy.hostBash.osSandbox is "required" and no OS sandbox is available.';

    const foreground = await bash({ osSandbox: undefined, hostCommandsRefused: refusal }).execute({
      command: 'echo hi > made.txt',
    });
    const background = await bash({ osSandbox: undefined, hostCommandsRefused: refusal }).execute({
      command: 'echo hi > made.txt',
      run_in_background: true,
    });

    expect(foreground).toMatchObject({ exit_code: -1, stderr: refusal });
    expect(background).toMatchObject({ exit_code: -1, stderr: refusal });
    expect(existsSync(join(cwd, 'made.txt'))).toBe(false);
    expect(gate.requests).toEqual([]);
  });

  it('runs commands as before when there is no sandbox and none is required', async () => {
    const result = await bash({ osSandbox: undefined }).execute({ command: 'echo plain' });

    expect(result).toMatchObject({ stdout: 'plain\n', exit_code: 0 });
    expect(gate.requests[0]!.osSandbox).toBeUndefined();
  });

  it('ignores unsandboxed when no sandbox is in use, so nothing asks without need', async () => {
    const result = await bash({ osSandbox: undefined }).execute({
      command: 'echo plain',
      unsandboxed: true,
    });

    expect(result.exit_code).toBe(0);
    expect(gate.requests[0]!.unsandboxed).toBeUndefined();
  });
});
