import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor } from '@chimera/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DefaultPermissionGate } from '../src/gate';
import { GatedExecutor } from '../src/gated-executor';
import { CommandPolicyPipeline } from '../src/pipeline';
import { reviewBashPolicy } from '../src/policy-review';
import { ScaryCommandStage } from '../src/scary-command-stage';

let cwd: string;
let expectedSha: string;
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'chimera-lease-'));
  git('init', '-q', '-b', 'trunk');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('commit', '-qm', 'initial', '--allow-empty');
  expectedSha = git('rev-parse', 'HEAD');
  git('init', '--bare', '-q', join(cwd, 'remote.git'));
  git('remote', 'add', 'origin', join(cwd, 'remote.git'));
  git('push', '-q', 'origin', 'HEAD:refs/heads/topic');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  await writeFile(join(cwd, 'change'), 'rebased content');
  git('add', 'change');
  git('commit', '--amend', '-qm', 'replacement');
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
function setup(
  decision: 'allow' | 'deny' = 'allow',
  modDecision?: 'allow' | 'deny',
  headlessAutoDeny = false,
) {
  const raiseRequest = vi.fn(async () => ({ decision, remembered: false }));
  const systemCheck = vi.fn(async () => ({
    decision: 'allow' as const,
    note: 'safe',
    threshold: 0.8,
  }));
  const review = vi.fn(async () => ({ decision: 'allow' as const, reason: 'safe' }));
  const gate = new DefaultPermissionGate({
    cwd,
    home: cwd,
    autoApprove: 'all',
    headlessAutoDeny,
    raiseRequest,
    systemOne: { check: systemCheck },
    reviewer: { review },
    ...(modDecision ? { interceptPermission: async () => modDecision } : {}),
    commandPolicy: {
      evaluator: new CommandPolicyPipeline([new ScaryCommandStage()]),
      context: (request) => ({
        command: request.command,
        cwd,
        target: 'host',
        home: cwd,
        projectRoot: cwd,
        roots: { read: [cwd], write: [cwd] },
      }),
    },
  });
  const exec = vi.fn(async (command: string) => {
    const stdout = execFileSync('sh', ['-c', command], { cwd, encoding: 'utf8' });
    return {
      stdout,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  });
  const inner = { cwd: () => cwd, exec } as unknown as Executor;
  return {
    executor: new GatedExecutor({ inner, gate }),
    gate,
    raiseRequest,
    systemCheck,
    review,
    exec,
  };
}
function push(branch = 'topic'): string {
  return `git push --force-with-lease=refs/heads/${branch}:${expectedSha} origin HEAD:refs/heads/${branch}`;
}

it('asks the operator with the branch and expected SHA, then executes the approved lease push', async () => {
  const { executor, raiseRequest, systemCheck, review } = setup();
  await expect(executor.exec(push())).resolves.toMatchObject({ exitCode: 0 });
  expect(raiseRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      policyAnalysis: expect.objectContaining({
        findings: expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'git-lease-push',
            message: expect.stringContaining(`refs/heads/topic at ${expectedSha}`),
          }),
        ]),
      }),
    }),
  );
  expect(systemCheck).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
  expect(git('--git-dir=remote.git', 'rev-parse', 'refs/heads/topic')).toBe(
    git('rev-parse', 'HEAD'),
  );
});

it.each([
  'main',
  'master',
  'trunk',
])('blocks a lease push to protected/default branch %s without asking', async (branch) => {
  const { executor, raiseRequest, exec } = setup();
  await expect(executor.exec(push(branch))).resolves.toMatchObject({
    exitCode: -1,
    stderr: expect.stringMatching(/git-force-push.*protected\/default.*Approval unavailable/),
  });
  expect(raiseRequest).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});

it.each([
  'git push --force origin HEAD:refs/heads/topic',
  'git push -f origin HEAD:refs/heads/topic',
  'git push origin +HEAD:refs/heads/topic',
  'git push --force-with-lease origin HEAD:refs/heads/topic',
  'git push --force-with-lease=refs/heads/topic:abc origin HEAD:refs/heads/topic',
])('blocks unsafe or implicit force: %s', async (command) => {
  const { executor, raiseRequest, exec } = setup();
  await expect(executor.exec(command)).resolves.toMatchObject({
    exitCode: -1,
    stderr: expect.stringMatching(/git-force-push.*cannot be approved/),
  });
  expect(raiseRequest).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});

it.each([
  (command: string) => `${command} --force`,
  (command: string) => `${command} HEAD:refs/heads/other`,
  (command: string) => command.replace('HEAD:refs/heads/topic', 'HEAD:refs/heads/other'),
  (command: string) => `echo before && ${command}`,
  (command: string) => `${command}; git push --force origin main`,
])('does not apply the lease exception to ambiguous or compound commands', async (change) => {
  const { executor, raiseRequest, exec } = setup();
  await expect(executor.exec(change(push()))).resolves.toMatchObject({ exitCode: -1 });
  expect(raiseRequest).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});

it('does not execute after the operator rejects the lease push', async () => {
  const { executor, raiseRequest, exec } = setup('deny');
  await expect(executor.exec(push())).resolves.toMatchObject({
    exitCode: -1,
    stderr: 'denied by user',
  });
  expect(raiseRequest).toHaveBeenCalledOnce();
  expect(exec).not.toHaveBeenCalled();
  expect(git('--git-dir=remote.git', 'rev-parse', 'refs/heads/topic')).toBe(expectedSha);
});

it('fails closed with actionable feedback when the remote default is unknown', async () => {
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const { executor, raiseRequest, exec } = setup();
  await expect(executor.exec(push())).resolves.toMatchObject({
    exitCode: -1,
    stderr: expect.stringContaining('git remote set-head origin -a'),
  });
  expect(raiseRequest).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});

it('does not automatically retry a lease push outside the OS sandbox', async () => {
  const { gate, systemCheck, raiseRequest } = setup();
  await expect(
    gate.requestRememberedBypass({
      requestId: 'retry',
      tool: 'bash',
      target: 'host',
      cwd,
      command: push(),
    }),
  ).resolves.toBeNull();
  expect(systemCheck).not.toHaveBeenCalled();
  expect(raiseRequest).not.toHaveBeenCalled();
});

it('keeps mod denials effective for lease pushes', async () => {
  const { executor, raiseRequest, exec } = setup('allow', 'deny');
  await expect(executor.exec(push())).resolves.toMatchObject({
    stderr: 'denied by mod',
    exitCode: -1,
  });
  expect(raiseRequest).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});

it('does not substitute a mod allow for operator approval', async () => {
  const { executor, raiseRequest, exec } = setup('deny', 'allow');
  await expect(executor.exec(push())).resolves.toMatchObject({
    stderr: 'denied by user',
    exitCode: -1,
  });
  expect(raiseRequest).toHaveBeenCalledOnce();
  expect(exec).not.toHaveBeenCalled();
});

it('offers approval for the ticket command even with an explicit sandbox bypass', async () => {
  const { gate, raiseRequest } = setup();
  await expect(
    gate.request({
      requestId: 'ticket',
      tool: 'bash',
      target: 'host',
      cwd,
      command: push('legato/CHIM-88-compaction'),
      unsandboxed: true,
    }),
  ).resolves.toMatchObject({ decision: 'allow' });
  expect(raiseRequest).toHaveBeenCalledOnce();
});

it('does not substitute a saved allow for operator approval', async () => {
  const { gate, executor, raiseRequest, exec } = setup('deny');
  gate.applyRemember(
    { scope: 'session', pattern: push(), patternKind: 'exact' },
    {
      requestId: 'remember',
      tool: 'bash',
      target: 'host',
      cwd,
      command: push(),
    },
    'allow',
  );
  await expect(executor.exec(push())).resolves.toMatchObject({ exitCode: -1 });
  expect(raiseRequest).toHaveBeenCalledOnce();
  expect(exec).not.toHaveBeenCalled();
});

it('explains that operator approval is possible but unavailable in a headless session', async () => {
  const { executor, raiseRequest, exec } = setup('allow', undefined, true);
  await expect(executor.exec(push())).resolves.toMatchObject({
    exitCode: -1,
    stderr: expect.stringContaining('no approval responder'),
  });
  expect(raiseRequest).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});

it('reports the lease exception rather than a hard block in policy reports', async () => {
  const eventsPath = join(cwd, 'events.jsonl');
  const auditPath = join(cwd, 'audit.jsonl');
  await writeFile(
    eventsPath,
    JSON.stringify({
      type: 'step_finished',
      toolCalls: [
        {
          callId: 'lease',
          name: 'bash',
          args: { command: push() },
          startedAt: 1,
        },
      ],
    }),
  );
  await writeFile(
    auditPath,
    JSON.stringify({ cwd, command: push(), source: 'user', decision: 'allow' }),
  );
  const report = await reviewBashPolicy({ eventsPath, auditPath });
  expect(report.commands[0]?.currentPolicy).toMatchObject({
    outcome: 'approval_required',
    ruleId: 'git-lease-push',
  });
  expect(report.summary.blocked).toBe(0);
});
