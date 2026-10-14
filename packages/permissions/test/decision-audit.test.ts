import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PermissionDecisionAudit } from '../src/decision-audit';

it('records MCP decisions without argument values or feedback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mcp-audit-'));
  const audit = new PermissionDecisionAudit({ home, sessionId: 'session-1', mode: 'balanced' });
  audit.record({
    request: {
      requestId: 'mcp-1',
      tool: 'mcp',
      target: 'host',
      cwd: '/workspace',
      command: 'burnlite/create_project',
      mcp: {
        server: 'burnlite',
        tool: 'create_project',
        preview: [{ name: 'token', type: 'string' }],
      },
    },
    resolution: { decision: 'deny', remembered: false, feedback: 'super-secret' },
    source: 'user',
  });
  const text = await readFile(join(home, '.chimera', 'logs', 'permission-decisions.jsonl'), 'utf8');
  expect(JSON.parse(text)).toMatchObject({
    mcp: { server: 'burnlite', tool: 'create_project' },
    decision: 'deny',
  });
  expect(text).not.toContain('super-secret');
  expect(text).not.toContain('token');
  expect(text).not.toContain('preview');
});

it('appends structured permission outcomes to a user-only JSONL audit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-audit-'));
  const audit = new PermissionDecisionAudit({ home, sessionId: 'session-1', mode: 'balanced' });

  audit.record({
    request: {
      requestId: 'request-1',
      tool: 'bash',
      target: 'host',
      command: 'git push --force origin main',
      cwd: '/workspace',
    },
    resolution: { decision: 'deny', remembered: false, denialSource: 'policy' },
    source: 'policy',
  });

  const path = join(home, '.chimera', 'logs', 'permission-decisions.jsonl');
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  expect(records).toEqual([
    expect.objectContaining({
      version: 1,
      sessionId: 'session-1',
      mode: 'balanced',
      command: 'git push --force origin main',
      decision: 'deny',
      source: 'policy',
    }),
  ]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('records what the approval reviewer decided, and why', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-audit-'));
  const audit = new PermissionDecisionAudit({ home, sessionId: 'session-1', mode: 'balanced' });
  const request = {
    requestId: 'request-1',
    tool: 'bash',
    target: 'host' as const,
    command: 'pnpm install',
    cwd: '/workspace',
  };

  audit.record({
    request,
    resolution: { decision: 'allow', remembered: false },
    source: 'reviewer',
    review: { decision: 'allow', reason: 'installs the dependencies of the task' },
  });
  audit.record({
    request: { ...request, requestId: 'request-2', command: 'git push' },
    resolution: { decision: 'deny', remembered: false, denialSource: 'user' },
    source: 'user',
    review: { decision: 'escalate', reason: 'the user did not ask for a push', stopped: 'total' },
  });

  const path = join(home, '.chimera', 'logs', 'permission-decisions.jsonl');
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  expect(records[0]).toMatchObject({
    decision: 'allow',
    source: 'reviewer',
    reviewer: { decision: 'allow', reason: 'installs the dependencies of the task' },
  });
  expect(records[1]).toMatchObject({
    decision: 'deny',
    source: 'user',
    reviewer: {
      decision: 'escalate',
      reason: 'the user did not ask for a push',
      stopped: 'total',
    },
  });
});

it('leaves the reason of the reviewer out for an MCP call, where it can repeat an argument', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mcp-audit-'));
  const audit = new PermissionDecisionAudit({ home, sessionId: 'session-1', mode: 'balanced' });

  audit.record({
    request: {
      requestId: 'mcp-1',
      tool: 'mcp',
      target: 'host',
      cwd: '/workspace',
      command: 'burnlite/create_project',
      mcp: { server: 'burnlite', tool: 'create_project', preview: [] },
    },
    resolution: { decision: 'allow', remembered: false },
    source: 'reviewer',
    review: { decision: 'allow', reason: 'creates the project "super-secret" the user named' },
  });

  const text = await readFile(join(home, '.chimera', 'logs', 'permission-decisions.jsonl'), 'utf8');
  expect(JSON.parse(text)).toMatchObject({ source: 'reviewer', reviewer: { decision: 'allow' } });
  expect(text).not.toContain('super-secret');
});

it('records what the System One check found with the decision that followed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-audit-'));
  const audit = new PermissionDecisionAudit({ home, sessionId: 'session-1', mode: 'balanced' });

  audit.record({
    request: {
      requestId: 'request-1',
      tool: 'bash',
      target: 'host',
      command: 'vercel deploy --prod',
      cwd: '/workspace',
    },
    resolution: { decision: 'deny', remembered: false, denialSource: 'user' },
    source: 'user',
    systemOne: {
      decision: 'escalate',
      note: 'rejected: safety 0.31, needs 0.80, reads as "remote"',
      safety: 0.31,
      threshold: 0.8,
    },
  });

  const text = await readFile(join(home, '.chimera', 'logs', 'permission-decisions.jsonl'), 'utf8');
  expect(JSON.parse(text)).toMatchObject({
    decision: 'deny',
    source: 'user',
    systemOne: {
      decision: 'escalate',
      note: 'rejected: safety 0.31, needs 0.80, reads as "remote"',
      safety: 0.31,
      threshold: 0.8,
    },
  });
});
