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
