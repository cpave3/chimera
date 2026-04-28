import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRequest, PermissionResolution } from '@chimera/core';
import type { FirePayload, HookFireResult, HookRunner } from '@chimera/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionGate } from '../src/gate';
import { GatedExecutor } from '../src/gated-executor';

function req(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'r1',
    tool: 'bash',
    target: 'host',
    command: 'rm -rf /',
    cwd: '/tmp',
    ...overrides,
  };
}

interface RecordingHookRunner extends HookRunner {
  fired: FirePayload[];
}

function recordingHookRunner(result: HookFireResult): RecordingHookRunner {
  const fired: FirePayload[] = [];
  return {
    fired,
    async fire(payload) {
      fired.push(payload);
      return result;
    },
  };
}

describe('DefaultPermissionGate hook integration', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-gate-hook-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('denies without raising when a PermissionRequest hook blocks; emits permission_resolved', async () => {
    let raised = 0;
    const resolvedEvents: Array<{
      requestId: string;
      decision: 'allow' | 'deny';
      remembered: boolean;
    }> = [];
    const hookRunner = recordingHookRunner({ blocked: true, blockingScript: '/x', reason: 'no' });
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => {
        raised += 1;
        return { decision: 'allow', remembered: false };
      },
      hookRunner,
      emitResolved: (requestId, decision, remembered) => {
        resolvedEvents.push({ requestId, decision, remembered });
      },
    });

    const r = await gate.request(req());

    expect(r.decision).toBe('deny');
    expect(r.remembered).toBe(false);
    expect(r.denialSource).toBe('hook');
    expect(raised).toBe(0);
    expect(hookRunner.fired).toHaveLength(1);
    expect(hookRunner.fired[0]).toMatchObject({
      event: 'PermissionRequest',
      tool_name: 'bash',
      target: 'host',
      command: 'rm -rf /',
    });
    expect(resolvedEvents).toEqual([{ requestId: 'r1', decision: 'deny', remembered: false }]);
  });

  it('does not call emitResolved when the hook allows', async () => {
    const hookRunner = recordingHookRunner({ blocked: false });
    const resolvedEvents: unknown[] = [];
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
      hookRunner,
      emitResolved: (requestId, decision, remembered) => {
        resolvedEvents.push({ requestId, decision, remembered });
      },
    });

    await gate.request(req());

    expect(resolvedEvents).toEqual([]);
  });

  it('proceeds to user prompt when hook does not block', async () => {
    let raised = 0;
    const hookRunner = recordingHookRunner({ blocked: false });
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async (): Promise<PermissionResolution> => {
        raised += 1;
        return { decision: 'allow', remembered: false };
      },
      hookRunner,
    });

    const r = await gate.request(req());

    expect(r.decision).toBe('allow');
    expect(raised).toBe(1);
    expect(hookRunner.fired).toHaveLength(1);
  });

  it('skips the hook when a rule already matches', async () => {
    const hookRunner = recordingHookRunner({ blocked: true });
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'deny', remembered: false }),
      hookRunner,
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'rm -rf /',
        patternKind: 'exact',
        decision: 'allow',
        createdAt: Date.now(),
      },
      'project',
    );

    const r = await gate.request(req());

    expect(r.decision).toBe('allow');
    expect(hookRunner.fired).toHaveLength(0);
  });

  it('rule denial sets denialSource to rule', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'rm -rf /',
        patternKind: 'exact',
        decision: 'deny',
        createdAt: Date.now(),
      },
      'project',
    );

    const r = await gate.request(req());
    expect(r.decision).toBe('deny');
    expect(r.denialSource).toBe('rule');
  });

  it('user denial sets denialSource to user when raise omits it', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'deny', remembered: false }),
    });
    const r = await gate.request(req());
    expect(r.denialSource).toBe('user');
  });

  it('GatedExecutor renders "denied by hook" when hook blocks', async () => {
    const hookRunner = recordingHookRunner({ blocked: true, blockingScript: '/x', reason: 'no' });
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
      hookRunner,
    });
    let innerCalled = false;
    const exec = new GatedExecutor({
      gate,
      inner: {
        exec: async () => {
          innerCalled = true;
          return {
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
        readFile: async () => '',
        readFileBytes: async () => new Uint8Array(),
        writeFile: async () => {},
        stat: async () => null,
        cwd: () => cwd,
        target: () => 'host',
      },
    });

    const r = await exec.exec('rm -rf /');
    expect(r.stderr).toBe('denied by hook');
    expect(r.exitCode).toBe(-1);
    expect(innerCalled).toBe(false);
  });

  it('GatedExecutor renders "denied by rule" when rule denies', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'rm -rf /',
        patternKind: 'exact',
        decision: 'deny',
        createdAt: Date.now(),
      },
      'project',
    );
    const exec = new GatedExecutor({
      gate,
      inner: {
        exec: async () => ({
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
        readFile: async () => '',
        readFileBytes: async () => new Uint8Array(),
        writeFile: async () => {},
        stat: async () => null,
        cwd: () => cwd,
        target: () => 'host',
      },
    });

    const r = await exec.exec('rm -rf /');
    expect(r.stderr).toBe('denied by rule');
  });

  it('skips hook when no runner is provided (existing behavior unchanged)', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => {
        raised += 1;
        return { decision: 'allow', remembered: false };
      },
    });
    const r = await gate.request(req());
    expect(r.decision).toBe('allow');
    expect(raised).toBe(1);
  });
});
