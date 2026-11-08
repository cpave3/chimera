import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount } from './harness';

type PolicyAnalysis = NonNullable<
  Extract<AgentEvent, { type: 'permission_request' }>['policyAnalysis']
>;

const command = 'legato plan create feature';
const bypassAnalysis: PolicyAnalysis = {
  version: 1,
  outcome: 'approval_required',
  stages: [],
  findings: [
    {
      kind: 'elevation',
      stageId: 'os_sandbox',
      ruleId: 'unsandboxed',
      message: 'Bypass requested',
    },
  ],
};

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** A permission request for `command`, with `policyAnalysis` (none when null). */
async function requestPermission(policyAnalysis: PolicyAnalysis | null = bypassAnalysis) {
  mounted = await mount({}, { columns: 100, rows: 40 });
  await mounted.event({
    type: 'permission_request',
    requestId: 'bypass',
    tool: 'bash',
    target: 'host',
    command,
    reason: 'Legato needs to update its host database',
    ...(policyAnalysis ? { policyAnalysis } : {}),
  } as AgentEvent);
  return mounted;
}

describe('a permission request that runs outside the OS sandbox', () => {
  it('warns about the bypass and remembers the exact command for the session', async () => {
    const { keys, screen, session } = await requestPermission();
    expect(screen()).toContain('approval needed');
    expect(screen()).toContain(command);
    expect(screen()).toContain('Legato needs to update its host database');
    expect(screen()).toContain('outside the OS sandbox');
    expect(screen()).toContain('trusts the executable');
    expect(screen()).toContain('Allow exact command…');
    expect(screen()).toContain('Allow command prefix…');

    await keys('2');
    expect(screen()).toContain(`remember exact ${command}`);
    expect(screen()).toContain('s session  p project  g global');
    await keys('s');

    expect(session.resolutions).toEqual([
      {
        requestId: 'bypass',
        action: {
          decision: 'allow',
          remember: {
            scope: 'session',
            pattern: command,
            patternKind: 'exact',
            allowUnsandboxed: true,
          },
        },
      },
    ]);
    expect(screen()).not.toContain('approval needed');
  });

  it.each([
    ['s', 'session'],
    ['p', 'project'],
    ['g', 'global'],
  ])('remembers an edited command prefix with %s (%s)', async (key, scope) => {
    const { keys, screen, session } = await requestPermission();
    await keys('3');
    expect(screen()).toMatch(/prefix › legato {2}/);
    expect(screen()).toContain('outside the OS sandbox');

    await keys(' plan\r');
    expect(screen()).toContain('remember prefix legato plan');
    expect(screen()).toContain('trusts the executable');
    await keys(key);

    expect(session.resolutions).toEqual([
      {
        requestId: 'bypass',
        action: {
          decision: 'allow',
          remember: {
            scope,
            pattern: 'legato plan',
            patternKind: 'prefix',
            allowUnsandboxed: true,
          },
        },
      },
    ]);
  });

  it.each([
    ['p', 'project'],
    ['g', 'global'],
  ])('remembers the exact command with %s (%s)', async (key, scope) => {
    const { keys, screen, session } = await requestPermission();
    await keys('A');
    expect(screen()).toContain(`remember exact ${command}`);
    await keys(key);

    expect(session.resolutions).toEqual([
      {
        requestId: 'bypass',
        action: {
          decision: 'allow',
          remember: { scope, pattern: command, patternKind: 'exact', allowUnsandboxed: true },
        },
      },
    ]);
  });

  it('keeps the prefix key apart from the filesystem grant', async () => {
    const { keys, screen, session } = await requestPermission({
      ...bypassAnalysis,
      grantProposal: { id: 'write-host', kind: 'write', path: '/host/state' },
    });
    expect(screen()).toContain('Allow + session write /host/state');
    await keys('g');

    expect(screen()).toMatch(/prefix › legato {2}/);
    expect(session.resolutions).toEqual([]);
  });

  it.each([
    ['a', { decision: 'allow' }],
    ['d', { decision: 'deny' }],
  ])('%s answers once without remembering', async (key, action) => {
    const { keys, session } = await requestPermission();
    await keys(key);

    expect(session.resolutions).toEqual([{ requestId: 'bypass', action }]);
  });
});

describe('a permission request the policy requires for another reason', () => {
  it.each([
    { kind: 'elevation', stageId: 'sudo', ruleId: 'sudo', message: 'Needs sudo' },
    { kind: 'elevation', stageId: 'other', ruleId: 'unsandboxed', message: 'Other stage' },
    { kind: 'blocked', stageId: 'os_sandbox', ruleId: 'other', message: 'Other rule' },
    { kind: 'risk', stageId: 'risk', level: 'danger', message: 'Risky command' },
  ] satisfies PolicyAnalysis['findings'])('offers no remembered rule for $stageId / $message', async (finding) => {
    const { keys, screen, session } = await requestPermission({
      ...bypassAnalysis,
      findings: [finding],
    });
    const card = screen();
    expect(card).toContain('Allow once');
    expect(card).toContain('Deny once');
    expect(card).not.toContain('Allow exact command');
    expect(card).not.toContain('Allow command prefix');
    expect(card).not.toContain('Allow & remember');
    expect(card).not.toContain('Allow pattern');
    expect(card).not.toContain('outside the OS sandbox');

    await keys('Ag');
    expect(screen()).not.toContain('s session  p project  g global');
    expect(session.resolutions).toEqual([]);

    await keys('d');
    expect(session.resolutions).toEqual([{ requestId: 'bypass', action: { decision: 'deny' } }]);
  });
});

describe('an ordinary permission request', () => {
  it('remembers the exact command for the session, without the bypass', async () => {
    const { keys, session } = await requestPermission(null);
    await keys('As');

    expect(session.resolutions).toEqual([
      {
        requestId: 'bypass',
        action: {
          decision: 'allow',
          remember: { scope: 'session', pattern: command, patternKind: 'exact' },
        },
      },
    ]);
  });

  it('remembers an edited pattern for the session, without the bypass', async () => {
    const { keys, screen, session } = await requestPermission(null);
    expect(screen()).toContain('Allow & remember…');
    expect(screen()).toContain('Allow pattern…');
    expect(screen()).not.toContain('outside the OS sandbox');

    await keys('g');
    await keys(' *\r');
    expect(screen()).toContain(`remember glob ${command} *`);
    await keys('s');

    expect(session.resolutions).toEqual([
      {
        requestId: 'bypass',
        action: {
          decision: 'allow',
          remember: { scope: 'session', pattern: `${command} *`, patternKind: 'glob' },
        },
      },
    ]);
  });
});
