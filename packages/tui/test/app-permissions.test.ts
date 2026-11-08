import { ChimeraClient } from '@chimera/client';
import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MountOptions } from '../src/mount';
import { type FakeSession, fakeSession, type Mounted, mount, runFinished, settle } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

const event = (value: unknown) => value as AgentEvent;

const bashRequest = (requestId: string, command: string, extra: Record<string, unknown> = {}) =>
  event({ type: 'permission_request', requestId, tool: 'bash', target: 'host', command, ...extra });

const sudoAnalysis = (message = 'sudo requires approval') => ({
  version: 1,
  outcome: 'approval_required',
  stages: [],
  findings: [{ kind: 'elevation', stageId: 'sudo_approval', ruleId: 'sudo', message }],
});

const mcpPreview = {
  server: 'calendar',
  tool: 'create_event',
  preview: [
    { name: 'title', type: 'string' },
    { name: '[redacted]', type: 'redacted' },
  ],
};

function snapshot(extra: Record<string, unknown>) {
  return {
    parentId: null,
    mode: 'build',
    model: { providerId: 'manticore', modelId: 'gpt' },
    messages: [],
    ...extra,
  };
}

/** Mount on a fake session whose client has `extra` methods; feed it through `session`. */
async function mountSession(
  extra: Record<string, unknown> = {},
  overrides: Partial<MountOptions> = {},
): Promise<{
  mounted: Mounted;
  session: FakeSession;
  feed(...events: AgentEvent[]): Promise<void>;
}> {
  const session = fakeSession();
  Object.assign(session.client, extra);
  mounted = await mount({ client: session.client, ...overrides });
  return {
    mounted,
    session,
    async feed(...events) {
      for (const item of events) session.push(item);
      await settle();
    },
  };
}

describe('the permission card', () => {
  it('shows the command, the reason and the choices', async () => {
    mounted = await mount();
    await mounted.event(bashRequest('p1', 'pnpm test', { reason: 'integration tests' }));
    const screen = mounted.screen();

    expect(screen).toContain('│ bash   pnpm test ');
    expect(screen).toContain('│ why    integration tests ');
    for (const choice of [
      'a  Allow once',
      'A  Allow & remember…',
      'g  Allow pattern…',
      'd  Deny once',
      'f  Deny with feedback…',
    ])
      expect(screen).toContain(choice);
  });

  it('shows an MCP tool and the shape of its arguments, not shell syntax or values', async () => {
    mounted = await mount();
    await mounted.event(
      event({
        type: 'permission_request',
        requestId: 'mcp-live',
        tool: 'mcp',
        target: 'host',
        command: 'calendar/create_event',
        mcp: mcpPreview,
      }),
    );
    const screen = mounted.screen();

    expect(screen).toContain('│ mcp    calendar / create_event ');
    expect(screen).toContain('│ args   title: string, [redacted]: redacted ');
    expect(screen).not.toContain('calendar/create_event');
    await mounted.keys('a');
    expect(mounted.session.resolutions).toEqual([
      { requestId: 'mcp-live', action: { decision: 'allow' } },
    ]);
  });

  it('allows once, without remembering, on a', async () => {
    mounted = await mount();
    await mounted.event(bashRequest('p1', 'clear'));
    await mounted.keys('a');

    expect(mounted.session.resolutions).toEqual([
      { requestId: 'p1', action: { decision: 'allow' } },
    ]);
  });

  it.each([
    ['s', 'session'],
    ['p', 'project'],
    ['g', 'global'],
  ] as const)('remembers the exact command for the %s scope after A', async (key, scope) => {
    mounted = await mount();
    await mounted.event(bashRequest('p1', 'rm -rf /tmp'));
    await mounted.keys('A');
    expect(mounted.screen()).toContain('│ remember exact rm -rf /tmp ');
    expect(mounted.screen()).toContain('s session  p project  g global');

    await mounted.keys(key);

    expect(mounted.session.resolutions).toEqual([
      {
        requestId: 'p1',
        action: {
          decision: 'allow',
          remember: { scope, pattern: 'rm -rf /tmp', patternKind: 'exact' },
        },
      },
    ]);
  });

  it('takes an unchanged pattern as the exact command', async () => {
    mounted = await mount();
    await mounted.event(bashRequest('p1', 'rm -rf /tmp'));
    await mounted.keys('g');
    expect(mounted.screen()).toContain('│ pattern › rm -rf /tmp');

    await mounted.keys('\r');
    expect(mounted.screen()).toContain('│ remember exact rm -rf /tmp ');
    await mounted.keys('p');

    expect(mounted.session.resolutions).toEqual([
      {
        requestId: 'p1',
        action: {
          decision: 'allow',
          remember: { scope: 'project', pattern: 'rm -rf /tmp', patternKind: 'exact' },
        },
      },
    ]);
  });

  it('denies with the feedback typed into the card', async () => {
    mounted = await mount();
    await mounted.event(bashRequest('p1', 'rm -rf /tmp'));
    await mounted.keys('f');
    expect(mounted.screen()).toContain('│ feedback ›');

    await mounted.keys('use cache');
    await mounted.keys('\r');

    expect(mounted.session.resolutions).toEqual([
      { requestId: 'p1', action: { decision: 'deny', feedback: 'use cache' } },
    ]);
  });

  it('shows a sudo elevation and offers no remembered approval', async () => {
    mounted = await mount();
    await mounted.event(
      bashRequest('p1', 'sudo true', {
        policyAnalysis: sudoAnalysis('sudo requires one-time approval and local authentication.'),
      }),
    );
    const screen = mounted.screen();

    expect(screen).toContain(
      '│ found  elevation (sudo): sudo requires one-time approval and local authentication.',
    );
    expect(screen).not.toContain('Allow & remember');
    expect(screen).not.toContain('Allow pattern');
  });

  it('shows the policy findings and grants exactly the proposed access', async () => {
    const grant = { id: 'write:/outside', kind: 'write', path: '/outside' };
    mounted = await mount();
    await mounted.event(
      bashRequest('p1', 'echo x > /outside/file', {
        policyAnalysis: {
          version: 1,
          outcome: 'approval_required',
          stages: [],
          findings: [
            {
              kind: 'path',
              stageId: 'path_authorization',
              operation: 'write',
              path: '/outside/file',
              resolvedPath: '/outside/file',
              requiredGrant: 'write',
              message: 'outside allowed write directories',
            },
          ],
          grantProposal: grant,
        },
      }),
    );
    const screen = mounted.screen();

    expect(screen).toContain('│ found  write /outside/file: outside allowed write directories');
    expect(screen).toContain('│ note   approval is not filesystem confinement');
    expect(screen).toContain('g  Allow + session write /outside');
    expect(screen).not.toContain('Allow & remember');
    await mounted.keys('g');
    expect(mounted.session.resolutions).toEqual([
      { requestId: 'p1', action: { decision: 'allow_with_grant', grant } },
    ]);
  });

  it('shows one request at a time and the next once the first is answered', async () => {
    mounted = await mount();
    await mounted.event(
      bashRequest('req-1', 'first command'),
      bashRequest('req-2', 'second command'),
    );
    expect(mounted.screen()).toContain('first command');
    expect(mounted.screen()).not.toContain('second command');

    await mounted.keys('a');

    expect(mounted.session.resolutions.map((resolution) => resolution.requestId)).toEqual([
      'req-1',
    ]);
    expect(mounted.screen()).toContain('second command');
  });
});

describe('permissions of a resumed session', () => {
  it('restores an MCP request from the session snapshot', async () => {
    await mountSession({
      getSession: async () =>
        snapshot({
          status: 'waiting_for_permission',
          pendingPermissions: [
            {
              requestId: 'mcp-hydrated',
              tool: 'mcp',
              target: 'host',
              command: 'calendar/create_event',
              cwd: '/tmp/project',
              mcp: mcpPreview,
            },
          ],
        }),
    });

    expect(mounted!.screen()).toContain('│ mcp    calendar / create_event ');
    expect(mounted!.screen()).toContain('title: string');
    expect(mounted!.screen()).not.toContain('calendar/create_event');
  });

  it('restores pending requests and keeps follow-ups on the active run until it finishes', async () => {
    const { session, feed } = await mountSession({
      getSession: async () =>
        snapshot({
          status: 'waiting_for_permission',
          pendingPermissions: [
            {
              requestId: 'recovered-request',
              tool: 'bash',
              target: 'host',
              command: 'rm /tmp/recovered',
              reason: 'clean up',
              cwd: '/tmp/project',
            },
            {
              requestId: 'next-request',
              tool: 'bash',
              target: 'host',
              command: 'echo next',
              cwd: '/tmp/project',
            },
          ],
        }),
    });
    expect(mounted!.screen()).toContain('rm /tmp/recovered');
    await feed(bashRequest('recovered-request', 'rm /tmp/recovered', { reason: 'clean up' }));

    await mounted!.keys('a');
    expect(mounted!.screen()).toContain('echo next');
    await mounted!.keys('d');
    expect(session.resolutions).toEqual([
      { requestId: 'recovered-request', action: { decision: 'allow' } },
      { requestId: 'next-request', action: { decision: 'deny' } },
    ]);
    expect(mounted!.screen()).not.toContain('rm /tmp/recovered');

    await mounted!.keys('follow up\r');
    expect(session.appended).toEqual(['follow up']);
    expect(session.sent).toEqual([]);

    await feed(runFinished);
    await mounted!.keys('next turn\r');
    expect(session.sent).toEqual(['next turn']);
  });

  it('does not bring back a request resolved before a late snapshot arrives', async () => {
    let releaseSnapshot = () => {};
    const { session, feed } = await mountSession({
      getSession: async () => {
        await new Promise<void>((resolve) => {
          releaseSnapshot = resolve;
        });
        return snapshot({
          status: 'waiting_for_permission',
          pendingPermissions: [
            {
              requestId: 'stale-request',
              tool: 'bash',
              target: 'host',
              command: 'stale command',
              cwd: '/tmp/project',
            },
          ],
        });
      },
    });
    await feed(
      bashRequest('stale-request', 'stale command'),
      event({ type: 'permission_resolved', requestId: 'stale-request', decision: 'allow' }),
      runFinished,
    );
    releaseSnapshot();
    await settle();

    expect(mounted!.screen()).not.toContain('stale command');
    await mounted!.keys('new turn\r');
    expect(session.sent).toEqual(['new turn']);
    expect(session.appended).toEqual([]);
  });
});

describe('sudo', () => {
  it('asks for the password locally before allowing the command', async () => {
    let password = '';
    const checkSudo = vi.fn(async () => ({ status: 'password_required' as const }));
    const authenticateSudo = vi.fn(async (request: { password: Uint8Array }) => {
      password = Buffer.from(request.password).toString();
      return { status: 'validated' as const };
    });
    mounted = await mount({ checkSudo, authenticateSudo });
    await mounted.event(
      bashRequest('sudo-request', 'sudo true', { policyAnalysis: sudoAnalysis() }),
    );
    await mounted.keys('a');
    expect(mounted.screen()).toContain('sudo password');
    expect(mounted.session.resolutions).toEqual([]);

    await mounted.keys('hunter2');
    expect(mounted.screen()).toContain('password › •••••••');
    expect(mounted.screen()).not.toContain('hunter2');
    await mounted.keys('\r');

    expect(authenticateSudo).toHaveBeenCalledWith({
      requestId: 'sudo-request',
      command: 'sudo true',
      password: expect.any(Uint8Array),
      signal: expect.any(AbortSignal),
    });
    expect(password).toBe('hunter2');
    expect(mounted.session.resolutions).toEqual([
      { requestId: 'sudo-request', action: { decision: 'allow' } },
    ]);
  });
});

describe('a permission request from a subagent', () => {
  it('names the subagent and goes to its own server', async () => {
    const childResolve = vi
      .spyOn(ChimeraClient.prototype, 'resolvePermissionAction')
      .mockImplementation(async () => {});
    mounted = await mount();
    await mounted.event(
      event({
        type: 'subagent_spawned',
        subagentId: 'sub-9999999999',
        parentCallId: 'pc1',
        childSessionId: 'child-sess-A',
        url: 'http://127.0.0.1:1',
        purpose: 'investigate',
      }),
      event({
        type: 'subagent_event',
        subagentId: 'sub-9999999999',
        event: bashRequest('req-1', 'rm -rf /tmp/x', { reason: 'cleanup' }),
      }),
    );
    expect(mounted.screen()).toContain('│ from   subagent 99999999: investigate');
    expect(mounted.screen()).toContain('rm -rf /tmp/x');

    await mounted.keys('a');

    expect(mounted.session.resolutions).toEqual([]);
    expect(childResolve).toHaveBeenCalledTimes(1);
    expect(childResolve).toHaveBeenCalledWith('child-sess-A', 'req-1', { decision: 'allow' });
  });
});

describe('switching sessions', () => {
  it('drops the permissions and the sudo prompt of the session left behind', async () => {
    let finishCreate = () => {};
    let finishOldSnapshot = () => {};
    let sudoSignal: AbortSignal | undefined;
    const oldSession = fakeSession();
    const oldEvents = fakeSession();
    const newEvents = fakeSession();
    const checkSudo = vi.fn(
      (request: { signal?: AbortSignal }) =>
        new Promise<{ status: 'validated' }>(() => {
          sudoSignal = request.signal;
        }),
    );
    Object.assign(oldSession.client, {
      createSession: async () => {
        await new Promise<void>((resolve) => {
          finishCreate = resolve;
        });
        return { sessionId: 'new-session' };
      },
      getSession: async (sessionId: string) => {
        if (sessionId !== 'attached-session') return snapshot({ status: 'idle' });
        await new Promise<void>((resolve) => {
          finishOldSnapshot = resolve;
        });
        return snapshot({
          status: 'waiting_for_permission',
          pendingPermissions: [
            {
              requestId: 'old-request',
              tool: 'bash',
              target: 'host',
              command: 'old snapshot command',
              cwd: '/tmp/project',
            },
          ],
        });
      },
    });
    oldSession.client.subscribe = (sessionId, options) =>
      (sessionId === 'attached-session' ? oldEvents : newEvents).client.subscribe(
        sessionId,
        options,
      );
    mounted = await mount({
      client: oldSession.client,
      sessionId: 'attached-session',
      checkSudo,
      authenticateSudo: async () => ({ status: 'validated' }),
    });
    await mounted.keys('/new\r');
    oldEvents.push(
      bashRequest('old-request', 'sudo old live command', { policyAnalysis: sudoAnalysis() }),
    );
    await settle();
    expect(mounted.screen()).toContain('sudo old live command');
    await mounted.keys('a');
    expect(checkSudo).toHaveBeenCalledTimes(1);
    expect(sudoSignal?.aborted).toBe(false);

    finishCreate();
    await settle();
    oldEvents.push(bashRequest('late-old-request', 'late old command'));
    finishOldSnapshot();
    await settle();

    expect(mounted.screen()).toContain('   note  new session -session');
    expect(sudoSignal?.aborted).toBe(true);
    expect(mounted.screen()).not.toContain('old live command');
    expect(mounted.screen()).not.toContain('old snapshot command');
    expect(mounted.screen()).not.toContain('late old command');
    expect(mounted.screen()).not.toContain('sudo password');
  });
});
