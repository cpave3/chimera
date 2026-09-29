import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRequest, PermissionResolution } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionGate } from '../src/gate';

function req(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'r1',
    tool: 'bash',
    target: 'host',
    command: 'pnpm test',
    cwd: '/tmp',
    ...overrides,
  };
}

describe('DefaultPermissionGate', () => {
  it('remembers an MCP approval globally across projects and new sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chimera-global-home-'));
    const projectA = await mkdtemp(join(tmpdir(), 'chimera-global-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'chimera-global-b-'));
    try {
      const first = new DefaultPermissionGate({
        cwd: projectA,
        home,
        autoApprove: 'none',
        raiseRequest: async () => ({ decision: 'allow', remembered: false }),
      });
      first.applyRemember(
        { scope: 'global', pattern: 'burnlite/list_projects', patternKind: 'exact' },
        {
          requestId: 'global-1',
          cwd: projectA,
          tool: 'mcp',
          command: 'burnlite/list_projects',
          target: 'host',
          mcp: { server: 'burnlite', tool: 'list_projects', preview: [] },
        },
        'allow',
      );
      const second = new DefaultPermissionGate({
        cwd: projectB,
        home,
        autoApprove: 'none',
        mcpHeadlessAutoDeny: true,
        raiseRequest: async () => {
          throw new Error('unexpected prompt');
        },
      });
      expect(
        await second.requestMcp({
          requestId: 'global-2',
          cwd: projectB,
          server: 'burnlite',
          tool: 'list_projects',
          args: {},
        }),
      ).toMatchObject({ decision: 'allow', remembered: true });
      expect(
        await second.requestMcp({
          requestId: 'global-3',
          cwd: projectB,
          server: 'other',
          tool: 'list_projects',
          args: {},
        }),
      ).toMatchObject({ decision: 'deny', denialSource: 'headless' });
      const globalFile = join(home, '.chimera', 'permissions.json');
      expect(JSON.parse(await readFile(globalFile, 'utf8')).rules).toHaveLength(1);
      expect((await stat(globalFile)).mode & 0o777).toBe(0o600);
      second.addRule(
        {
          tool: 'mcp',
          target: 'host',
          pattern: 'burnlite/list_projects',
          patternKind: 'exact',
          decision: 'deny',
          createdAt: Date.now(),
        },
        'project',
      );
      expect(
        await second.requestMcp({
          requestId: 'global-4',
          cwd: projectB,
          server: 'burnlite',
          tool: 'list_projects',
          args: {},
        }),
      ).toMatchObject({ decision: 'deny', denialSource: 'rule' });
    } finally {
      await Promise.all(
        [home, projectA, projectB].map((path) => rm(path, { recursive: true, force: true })),
      );
    }
  });
  it('denies MCP prompts in a headless one-shot run without changing normal host approvals', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'chimera-mcp-one-shot-'));
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'host',
      mcpHeadlessAutoDeny: true,
      raiseRequest: async () => {
        throw new Error('must not prompt');
      },
    });
    expect(await gate.request(req())).toMatchObject({ decision: 'allow' });
    expect(
      await gate.requestMcp({
        requestId: 'm1',
        server: 'burnlite',
        tool: 'list_projects',
        cwd,
        args: {},
      }),
    ).toMatchObject({ decision: 'deny', denialSource: 'headless' });
  });
  it('prompts for MCP even with host auto-approval and never exposes argument values', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'chimera-mcp-gate-'));
    let raised: PermissionRequest | undefined;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      raiseRequest: async (request) => {
        raised = request;
        return { decision: 'allow', remembered: false };
      },
    });
    const resolution = await gate.requestMcp({
      requestId: 'm1',
      server: 'burnlite',
      tool: 'list_projects',
      cwd,
      args: { apiKey: 'super-secret', limit: 10 },
    });
    expect(resolution.decision).toBe('allow');
    expect(raised?.mcp).toEqual({
      server: 'burnlite',
      tool: 'list_projects',
      preview: [
        { name: '[redacted]', type: 'redacted' },
        { name: 'limit', type: 'number' },
      ],
    });
    expect(JSON.stringify(raised)).not.toContain('super-secret');
  });

  it('denies a trusted MCP tool when an explicit rule denies it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'chimera-mcp-rule-'));
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      headlessAutoDeny: true,
      raiseRequest: async () => {
        throw new Error('must not prompt');
      },
    });
    gate.addRule(
      {
        tool: 'mcp',
        target: 'host',
        pattern: 'burnlite/delete_project',
        patternKind: 'exact',
        decision: 'deny',
        createdAt: Date.now(),
      },
      'session',
    );
    const result = await gate.requestMcp(
      {
        requestId: 'm2',
        server: 'burnlite',
        tool: 'delete_project',
        cwd,
        args: {},
      },
      ['delete_project'],
    );
    expect(result).toMatchObject({ decision: 'deny', denialSource: 'rule' });
  });

  it('allows only explicitly trusted tools in headless MCP sessions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'chimera-mcp-headless-'));
    const decisions: string[] = [];
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      headlessAutoDeny: true,
      raiseRequest: async () => {
        throw new Error('must not prompt');
      },
      audit: ({ source }) => decisions.push(source),
    });
    const call = { requestId: 'm3', server: 'burnlite', tool: 'list_projects', cwd, args: {} };
    expect(await gate.requestMcp(call)).toMatchObject({
      decision: 'deny',
      denialSource: 'headless',
    });
    expect(await gate.requestMcp(call, ['list_projects'])).toMatchObject({ decision: 'allow' });
    expect(
      await gate.requestMcp({ ...call, tool: 'delete_project' }, ['list_projects']),
    ).toMatchObject({ decision: 'deny', denialSource: 'headless' });
    expect(decisions).toEqual(['headless', 'automatic', 'headless']);
  });

  it('remembers MCP approval for one server and tool, not arguments or another server', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'chimera-mcp-remember-'));
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      raiseRequest: async (request) => {
        raised++;
        if (raised === 1) gate.applyRemember({ scope: 'session' }, request, 'allow');
        return { decision: 'allow', remembered: false };
      },
    });
    const call = {
      requestId: 'm4',
      server: 'burnlite',
      tool: 'list_projects',
      cwd,
      args: { token: 'one' },
    };
    await gate.requestMcp(call);
    expect(await gate.requestMcp({ ...call, args: { token: 'two' } })).toMatchObject({
      decision: 'allow',
      remembered: true,
    });
    await gate.requestMcp({ ...call, server: 'other' });
    expect(raised).toBe(2);
    expect(JSON.stringify(gate.listRules())).not.toContain('token');
  });

  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-gate-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('mandatory bash policy findings override auto-approve all', async () => {
    let raisedRequest: PermissionRequest | undefined;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      commandPolicy: {
        evaluator: {
          async evaluate() {
            return {
              version: 1,
              outcome: 'approval_required',
              stages: [
                {
                  id: 'risk',
                  status: 'findings',
                  findings: [
                    {
                      kind: 'risk',
                      stageId: 'risk',
                      level: 'critical',
                      score: 100,
                      message: 'critical command',
                    },
                  ],
                },
              ],
              findings: [
                {
                  kind: 'risk',
                  stageId: 'risk',
                  level: 'critical',
                  score: 100,
                  message: 'critical command',
                },
              ],
            };
          },
        },
        context: (request) => ({
          command: request.command,
          target: 'host',
          cwd: request.cwd,
          home: '/home/user',
          projectRoot: request.cwd,
          roots: { read: [request.cwd], write: [request.cwd] },
        }),
      },
      raiseRequest: async (request) => {
        raisedRequest = request;
        return { decision: 'deny', remembered: false };
      },
    });

    const resolution = await gate.request(req({ command: 'rm -rf /' }));

    expect(resolution.decision).toBe('deny');
    expect(raisedRequest?.policyAnalysis?.findings[0]).toMatchObject({
      kind: 'risk',
      level: 'critical',
    });
  });

  it('requires sudo authentication after approval despite matching allow rules', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      commandPolicy: {
        evaluator: {
          async evaluate() {
            return {
              version: 1,
              outcome: 'approval_required',
              stages: [],
              findings: [
                {
                  kind: 'elevation',
                  stageId: 'sudo_approval',
                  ruleId: 'sudo',
                  message: 'sudo requires approval',
                },
              ],
            };
          },
        },
        context: (request) => ({
          command: request.command,
          target: 'host',
          cwd: request.cwd,
          home: '/home/user',
          projectRoot: request.cwd,
          roots: { read: [request.cwd], write: [request.cwd] },
        }),
      },
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'sudo true',
        patternKind: 'exact',
        decision: 'allow',
        createdAt: Date.now(),
      },
      'session',
    );

    await expect(gate.request(req({ command: 'sudo true' }))).resolves.toMatchObject({
      decision: 'allow',
      remembered: false,
      authentication: 'sudo',
    });
  });

  it('keeps explicit deny rules effective for mandatory findings', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'all',
      commandPolicy: {
        evaluator: {
          async evaluate() {
            return {
              version: 1,
              outcome: 'approval_required',
              stages: [],
              findings: [
                {
                  kind: 'risk',
                  stageId: 'risk',
                  level: 'danger',
                  message: 'dangerous command',
                },
              ],
            };
          },
        },
        context: (request) => ({
          command: request.command,
          target: 'host',
          cwd: request.cwd,
          home: '/home/user',
          projectRoot: request.cwd,
          roots: { read: [request.cwd], write: [request.cwd] },
        }),
      },
      raiseRequest: async () => {
        raised++;
        return { decision: 'allow', remembered: false };
      },
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
      'session',
    );

    await expect(gate.request(req({ command: 'rm -rf /' }))).resolves.toMatchObject({
      decision: 'deny',
    });
    expect(raised).toBe(0);
  });

  it('applies matching deny rules before safe-command auto-approval', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'host',
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'echo safe',
        patternKind: 'exact',
        decision: 'deny',
        createdAt: Date.now(),
      },
      'session',
    );

    await expect(gate.request(req({ command: 'echo safe' }))).resolves.toMatchObject({
      decision: 'deny',
      denialSource: 'rule',
    });
  });

  it('auto-approves host calls at level=host', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'host',
      raiseRequest: async (): Promise<PermissionResolution> => {
        raised += 1;
        return { decision: 'allow', remembered: false };
      },
    });
    const resolution = await gate.request(req());
    expect(resolution.decision).toBe('allow');
    expect(raised).toBe(0);
  });

  it('raises a request at level=none when no rule matches', async () => {
    let receivedCommand = '';
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async (r) => {
        receivedCommand = r.command;
        return { decision: 'deny', remembered: false };
      },
    });
    const resolution = await gate.request(req({ command: 'pnpm i' }));
    expect(receivedCommand).toBe('pnpm i');
    expect(resolution.decision).toBe('deny');
  });

  it('matching allow rule bypasses prompt', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => {
        raised += 1;
        return { decision: 'deny', remembered: false };
      },
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'pnpm test',
        patternKind: 'exact',
        decision: 'allow',
        createdAt: Date.now(),
      },
      'project',
    );
    const resolution = await gate.request(req({ command: 'pnpm test' }));
    expect(resolution.decision).toBe('allow');
    expect(resolution.remembered).toBe(true);
    expect(raised).toBe(0);
  });

  it('applyRemember with project scope persists a glob rule', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      raiseRequest: async () => ({ decision: 'allow', remembered: false }),
    });
    gate.applyRemember(
      { scope: 'project', pattern: 'git push *', patternKind: 'glob' },
      req({ command: 'git push origin main' }),
      'allow',
    );
    const rules = gate.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.pattern).toBe('git push *');
  });

  it('headlessAutoDeny denies host-target requests without raising', async () => {
    let raised = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      headlessAutoDeny: true,
      raiseRequest: async () => {
        raised += 1;
        return { decision: 'allow', remembered: false };
      },
    });
    const resolution = await gate.request(req({ target: 'host', command: 'rm -rf /' }));
    expect(resolution.decision).toBe('deny');
    expect(resolution.remembered).toBe(false);
    expect(resolution.denialSource).toBe('headless');
    expect(raised).toBe(0);
  });

  it('headlessAutoDeny respects existing allow rules instead of denying', async () => {
    const gate = new DefaultPermissionGate({
      cwd,
      autoApprove: 'none',
      headlessAutoDeny: true,
      raiseRequest: async () => ({ decision: 'deny', remembered: false }),
    });
    gate.addRule(
      {
        tool: 'bash',
        target: 'host',
        pattern: 'pnpm test',
        patternKind: 'exact',
        decision: 'allow',
        createdAt: Date.now(),
      },
      'project',
    );
    const resolution = await gate.request(req({ command: 'pnpm test' }));
    expect(resolution.decision).toBe('allow');
  });
});
