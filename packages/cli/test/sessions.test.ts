import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyUsage,
  newSessionId,
  persistSession,
  type Session,
} from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findLatestSessionInCwd,
  resolveSessionId,
} from '../src/commands/sessions';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: newSessionId(),
    parentId: null,
    children: [],
    cwd: '/tmp/proj-a',
    createdAt: Date.now(),
    messages: [],
    toolCalls: [],
    status: 'idle',
    model: { providerId: 'p', modelId: 'm', maxSteps: 100 },
    sandboxMode: 'off',
    usage: emptyUsage(),
    ...overrides,
  };
}

async function persistEmptySession(session: Session, home: string) {
  await persistSession(
    session,
    {
      type: 'step_finished',
      stepNumber: 1,
      finishReason: 'stop',
      messages: session.messages,
      toolCalls: session.toolCalls,
      usage: session.usage,
    },
    home,
  );
}

describe('resolveSessionId', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-resolve-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns the id verbatim when it matches a full ULID exactly', async () => {
    const targetSession = makeSession({ cwd: '/tmp/proj-a' });
    await persistEmptySession(targetSession, home);
    const resolved = await resolveSessionId(targetSession.id, { home });
    expect(resolved).toBe(targetSession.id);
  });

  it('resolves a unique suffix to the full id', async () => {
    const targetSession = makeSession({ cwd: '/tmp/proj-a' });
    await persistEmptySession(targetSession, home);
    const resolved = await resolveSessionId(targetSession.id.slice(-8), {
      home,
    });
    expect(resolved).toBe(targetSession.id);
  });

  it('throws an Ambiguous error when a suffix matches multiple sessions', async () => {
    // Two sessions whose ids both end in 'AAAAAAAA' would be statistically
    // improbable for ULIDs; emulate by reusing the suffix manually.
    const sessionA = makeSession({ id: '01HZAAAAAAAAAAAAAAAAAAAAAA' });
    const sessionB = makeSession({ id: '01HZBBBBBBBBBBBBBBBBAAAAAA' });
    await persistEmptySession(sessionA, home);
    await persistEmptySession(sessionB, home);
    await expect(resolveSessionId('AAAAAA', { home })).rejects.toThrow(
      /Ambiguous/,
    );
  });

  it('throws when no session matches', async () => {
    await expect(resolveSessionId('NEVERMATCHES', { home })).rejects.toThrow(
      /No session matching/,
    );
  });

  it('scopes suffix matching to cwd when provided', async () => {
    const sessionInProjA = makeSession({
      id: '01HZAAAAAAAAAAAAAAAAAAAAAA',
      cwd: '/tmp/proj-a',
    });
    const sessionInProjB = makeSession({
      id: '01HZBBBBBBBBBBBBBBBBAAAAAA',
      cwd: '/tmp/proj-b',
    });
    await persistEmptySession(sessionInProjA, home);
    await persistEmptySession(sessionInProjB, home);

    // Both ids share the suffix "AAAAAA" — but only sessionA is in proj-a,
    // so a cwd-scoped resolve from /tmp/proj-a uniquely returns sessionA.
    const resolved = await resolveSessionId('AAAAAA', {
      home,
      cwd: '/tmp/proj-a',
    });
    expect(resolved).toBe(sessionInProjA.id);
  });

  it('hints about cross-directory matches when no cwd-scoped match exists', async () => {
    const sessionInOtherDir = makeSession({
      id: '01HZBBBBBBBBBBBBBBBBAAAAAA',
      cwd: '/tmp/proj-other',
    });
    await persistEmptySession(sessionInOtherDir, home);
    await expect(
      resolveSessionId('AAAAAA', { home, cwd: '/tmp/proj-a' }),
    ).rejects.toThrow(/in other directories/);
  });

  it('still resolves a full-id exact match even from a different cwd', async () => {
    const sessionInOtherDir = makeSession({ cwd: '/tmp/proj-other' });
    await persistEmptySession(sessionInOtherDir, home);
    const resolved = await resolveSessionId(sessionInOtherDir.id, {
      home,
      cwd: '/tmp/proj-a',
    });
    expect(resolved).toBe(sessionInOtherDir.id);
  });
});

describe('findLatestSessionInCwd', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-latest-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns null when no sessions match the cwd', async () => {
    const wrongDirSession = makeSession({ cwd: '/tmp/elsewhere' });
    await persistEmptySession(wrongDirSession, home);
    const latest = await findLatestSessionInCwd('/tmp/proj-a', home);
    expect(latest).toBeNull();
  });

  it('returns the most-recently-active session in the cwd', async () => {
    const olderSession = makeSession({ cwd: '/tmp/proj-a' });
    await persistEmptySession(olderSession, home);
    await new Promise((resolveTick) => setTimeout(resolveTick, 12));
    const newerSession = makeSession({ cwd: '/tmp/proj-a' });
    await persistEmptySession(newerSession, home);

    const latest = await findLatestSessionInCwd('/tmp/proj-a', home);
    expect(latest?.id).toBe(newerSession.id);
  });
});
