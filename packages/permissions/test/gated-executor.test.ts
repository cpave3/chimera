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

  it('defaults toolName to "bash" for backward compatibility', async () => {
    let capturedToolName = '';
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async (req) => {
        capturedToolName = req.tool;
        return { decision: 'allow', remembered: false };
      },
    });
    const g = new GatedExecutor({
      inner: stubExecutor({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
      gate,
    });
    await g.exec('echo hi');
    expect(capturedToolName).toBe('bash');
  });

  it('forwards toolName from opts to the gate', async () => {
    let capturedToolName = '';
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async (req) => {
        capturedToolName = req.tool;
        return { decision: 'allow', remembered: false };
      },
    });
    const g = new GatedExecutor({
      inner: stubExecutor({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
      gate,
    });
    await g.exec('rg foo', { toolName: 'grep' });
    expect(capturedToolName).toBe('grep');
    capturedToolName = '';
    await g.exec('rg --files', { toolName: 'glob' });
    expect(capturedToolName).toBe('glob');
  });

  it('respects tool-specific rules via toolName', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'deny', remembered: false }),
    });
    gate.addRule(
      {
        tool: 'grep',
        target: 'host',
        pattern: 'rm -rf *',
        patternKind: 'glob',
        decision: 'allow',
        createdAt: Date.now(),
      },
      'project',
    );
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
          stdout: 'ran',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    };
    const g = new GatedExecutor({ inner, gate });

    // With toolName='bash' the rule does not match → denied.
    const r1 = await g.exec('rm -rf /', { toolName: 'bash' });
    expect(r1.exitCode).toBe(-1);
    expect(innerCalled).toBe(false);

    // With toolName='grep' the rule matches → allowed.
    const r2 = await g.exec('rm -rf /', { toolName: 'grep' });
    expect(r2.stdout).toBe('ran');
    expect(innerCalled).toBe(true);
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
