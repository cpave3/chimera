import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult, Executor } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionGate } from '../src/gate';
import { GatedExecutor } from '../src/gated-executor';

function stubExecutor(result: ExecResult): Executor {
  return {
    exec: async () => result,
    readFile: async () => '',
    readFileBytes: async () => new Uint8Array(),
    writeFile: async () => {},
    stat: async () => null,
    cwd: () => '/tmp',
    target: () => 'host',
  };
}

describe('GatedExecutor', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-gexec-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('passes through exec when the gate approves', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      raiseRequest: async () => ({ decision: 'deny', remembered: false }),
    });
    const inner = stubExecutor({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const g = new GatedExecutor({ inner, gate });
    const r = await g.exec('echo hi');
    expect(r.stdout).toBe('ok');
  });

  it("returns 'denied by user' without calling inner when gate denies", async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'deny', remembered: false }),
    });
    let innerCalled = false;
    const inner: Executor = {
      ...stubExecutor({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
      exec: async () => {
        innerCalled = true;
        return {
          stdout: 'should-not-run',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    };
    const g = new GatedExecutor({ inner, gate });
    const r = await g.exec('rm -rf everything');
    expect(r.stderr).toBe('denied by user');
    expect(r.exitCode).toBe(-1);
    expect(innerCalled).toBe(false);
  });
});
