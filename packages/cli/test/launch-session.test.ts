import { ChimeraHttpError, type CreateSessionOpts } from '@chimera/client';
import { describe, expect, it, vi } from 'vitest';
import { launchSession } from '../src/launch-session';

const createOptions: CreateSessionOpts = {
  cwd: '/workspace',
  model: { providerId: 'test', modelId: 'model' },
  name: 'named session',
  requestedSessionId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
};

describe('launchSession', () => {
  it('creates a named session with a requested ID', async () => {
    const client = {
      createSession: vi.fn().mockResolvedValue({ sessionId: createOptions.requestedSessionId }),
      resumeSession: vi.fn(),
    };

    await expect(launchSession(client, createOptions)).resolves.toEqual({
      sessionId: createOptions.requestedSessionId,
    });
    expect(client.createSession).toHaveBeenCalledWith(createOptions);
  });

  it('retries a collision without the requested ID while retaining the name', async () => {
    const collision = new ChimeraHttpError(409, { code: 'SESSION_ID_EXISTS' });
    const client = {
      createSession: vi
        .fn()
        .mockRejectedValueOnce(collision)
        .mockResolvedValueOnce({ sessionId: 'generated' }),
      resumeSession: vi.fn(),
    };

    await expect(launchSession(client, createOptions, { sessionExists: 'new' })).resolves.toEqual({
      sessionId: 'generated',
    });
    expect(client.createSession).toHaveBeenNthCalledWith(2, {
      ...createOptions,
      requestedSessionId: undefined,
    });
  });

  it('resumes the requested ID on collision when explicitly configured', async () => {
    const collision = new ChimeraHttpError(409, { code: 'SESSION_ID_EXISTS' });
    const client = {
      createSession: vi.fn().mockRejectedValue(collision),
      resumeSession: vi.fn().mockResolvedValue({ sessionId: createOptions.requestedSessionId }),
    };

    await launchSession(client, createOptions, { sessionExists: 'resume' });

    expect(client.resumeSession).toHaveBeenCalledWith(createOptions.requestedSessionId);
  });

  it('defaults a collision to an error when stdin is not a TTY', async () => {
    const collision = new ChimeraHttpError(409, { code: 'SESSION_ID_EXISTS' });
    const client = {
      createSession: vi.fn().mockRejectedValue(collision),
      resumeSession: vi.fn(),
    };

    await expect(launchSession(client, createOptions, { isTTY: false })).rejects.toBe(collision);
  });

  it('explicitly resumes an existing session instead of creating one', async () => {
    const client = {
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({ sessionId: 'existing' }),
    };

    await expect(
      launchSession(client, createOptions, { resumeSessionId: 'existing' }),
    ).resolves.toEqual({ sessionId: 'existing' });
    expect(client.resumeSession).toHaveBeenCalledWith('existing');
    expect(client.createSession).not.toHaveBeenCalled();
  });
});
