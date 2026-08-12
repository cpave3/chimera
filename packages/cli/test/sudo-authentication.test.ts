import { describe, expect, it, vi } from 'vitest';
import { OwnerLocalSudoAuthentication } from '../src/sudo-authentication';

describe('OwnerLocalSudoAuthentication', () => {
  it('makes cached validation consumable exactly once by request ID', async () => {
    const check = vi.fn(async () => ({ status: 'validated' as const }));
    const authentication = new OwnerLocalSudoAuthentication(check, async () => ({
      status: 'validated',
    }));

    await expect(
      authentication.checkSudo({ requestId: 'request-1', command: 'sudo true' }),
    ).resolves.toEqual({ status: 'validated' });
    expect(authentication.consumeSudoAuthentication('request-1')).toBe(true);
    expect(authentication.consumeSudoAuthentication('request-1')).toBe(false);
  });

  it('makes successful password validation consumable exactly once', async () => {
    const validate = vi.fn(async () => ({ status: 'validated' as const }));
    const authentication = new OwnerLocalSudoAuthentication(
      async () => ({ status: 'password_required' }),
      validate,
    );
    const password = new Uint8Array([1, 2, 3]);

    await expect(
      authentication.authenticateSudo({
        requestId: 'request-1',
        command: 'sudo true',
        password,
      }),
    ).resolves.toEqual({ status: 'validated' });
    expect(validate).toHaveBeenCalledWith({
      requestId: 'request-1',
      command: 'sudo true',
      password,
    });
    expect(authentication.consumeSudoAuthentication('request-1')).toBe(true);
    expect(authentication.consumeSudoAuthentication('request-1')).toBe(false);
  });

  it('does not create a token when password validation fails', async () => {
    const authentication = new OwnerLocalSudoAuthentication(
      async () => ({ status: 'password_required' }),
      async () => ({ status: 'failed', message: 'rejected' }),
    );

    await authentication.authenticateSudo({
      requestId: 'request-1',
      command: 'sudo true',
      password: new Uint8Array([1]),
    });

    expect(authentication.consumeSudoAuthentication('request-1')).toBe(false);
  });
});
