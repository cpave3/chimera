import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newSessionId } from '../src/ids';
import { loadSession, persistSession, sessionPath } from '../src/persistence';
import type { Session } from '../src/types';

describe('persistence', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-test-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function makeSession(): Session {
    return {
      id: newSessionId(),
      cwd: '/tmp',
      createdAt: Date.now(),
      messages: [{ role: 'user', content: 'hi' }],
      toolCalls: [],
      status: 'running',
      model: { providerId: 'p', modelId: 'm', maxSteps: 100 },
      sandboxMode: 'off',
    };
  }

  it('persists and reloads a session', async () => {
    const s = makeSession();
    await persistSession(s, home);
    const loaded = await loadSession(s.id, home);
    expect(loaded.id).toEqual(s.id);
    expect(loaded.messages).toEqual(s.messages);
  });

  it('resets status to idle on load', async () => {
    const s = makeSession();
    s.status = 'error';
    await persistSession(s, home);
    const loaded = await loadSession(s.id, home);
    expect(loaded.status).toEqual('idle');
  });

  it('writes to the expected path', async () => {
    const s = makeSession();
    await persistSession(s, home);
    expect(sessionPath(s.id, home)).toEqual(
      join(home, '.chimera', 'sessions', `${s.id}.json`),
    );
  });
});
