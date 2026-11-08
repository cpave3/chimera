import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount } from './harness';

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';
const ESC = '\x1b';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function mountWithRequest(): Promise<Mounted> {
  const withRequest = await mount();
  await withRequest.event({
    type: 'permission_request',
    requestId: 'r1',
    tool: 'bash',
    target: 'host',
    command: 'git push origin main',
  } as AgentEvent);
  return withRequest;
}

describe('the approval choices', () => {
  it('lists the choices with the first one selected', async () => {
    mounted = await mountWithRequest();
    const screen = mounted.screen();

    expect(screen).toContain('approval needed');
    expect(screen).toContain('› a  Allow once');
    expect(screen).toContain('  A  Allow & remember…');
    expect(screen).toContain('  g  Allow pattern…');
    expect(screen).toContain('  d  Deny once');
    expect(screen).toContain('  f  Deny with feedback…');
  });

  it('applies the selected choice on Enter', async () => {
    mounted = await mountWithRequest();
    await mounted.keys(ENTER);

    expect(mounted.session.resolutions).toEqual([
      { requestId: 'r1', action: { decision: 'allow' } },
    ]);
    expect(mounted.screen()).not.toContain('approval needed');
  });

  it('moves the selection with the arrow keys', async () => {
    mounted = await mountWithRequest();
    await mounted.keys(DOWN);
    await mounted.keys(DOWN);
    await mounted.keys(DOWN);
    expect(mounted.screen()).toContain('› d  Deny once');
    expect(mounted.screen()).not.toContain('› a  Allow once');

    await mounted.keys(UP);
    await mounted.keys(DOWN);
    await mounted.keys(ENTER);

    expect(mounted.session.resolutions).toEqual([
      { requestId: 'r1', action: { decision: 'deny' } },
    ]);
  });

  it('picks a choice by its number', async () => {
    mounted = await mountWithRequest();
    await mounted.keys('4');

    expect(mounted.session.resolutions).toEqual([
      { requestId: 'r1', action: { decision: 'deny' } },
    ]);
  });

  it('picks a choice by its letter', async () => {
    mounted = await mountWithRequest();
    await mounted.keys('d');

    expect(mounted.session.resolutions).toEqual([
      { requestId: 'r1', action: { decision: 'deny' } },
    ]);
  });

  it('denies on Escape', async () => {
    mounted = await mountWithRequest();
    await mounted.keys(ESC, 120);

    expect(mounted.session.resolutions).toEqual([
      { requestId: 'r1', action: { decision: 'deny' } },
    ]);
  });

  it('asks where to remember the rule for a choice that needs a follow-up', async () => {
    mounted = await mountWithRequest();
    await mounted.keys(DOWN);
    await mounted.keys(ENTER);

    expect(mounted.screen()).toContain('remember exact git push origin main');
    expect(mounted.screen()).toContain('s session  p project  g global');
    expect(mounted.session.resolutions).toEqual([]);

    await mounted.keys('p');

    expect(mounted.session.resolutions).toEqual([
      {
        requestId: 'r1',
        action: {
          decision: 'allow',
          remember: { scope: 'project', pattern: 'git push origin main', patternKind: 'exact' },
        },
      },
    ]);
  });

  it('keeps every character of feedback that arrives in one burst', async () => {
    mounted = await mountWithRequest();
    await mounted.keys('f');
    await mounted.keys(`no${ENTER}`);

    expect(mounted.session.resolutions).toEqual([
      { requestId: 'r1', action: { decision: 'deny', feedback: 'no' } },
    ]);
  });

  it('applies the choice the arrows reached when Enter follows in the same burst', async () => {
    mounted = await mountWithRequest();
    await mounted.keys(`${DOWN}${DOWN}${DOWN}${ENTER}`);

    expect(mounted.session.resolutions).toEqual([
      { requestId: 'r1', action: { decision: 'deny' } },
    ]);
  });
});
