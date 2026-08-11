import { describe, expect, it, vi } from 'vitest';
import { OwnerLocalSudoAuthentication } from '../src/sudo-authentication';

const terminal = {
  stdin: {} as NodeJS.ReadStream,
  stdout: {} as NodeJS.WriteStream,
};

describe('OwnerLocalSudoAuthentication', () => {
  it('makes a successful validation consumable exactly once by request ID', async () => {
    const validate = vi.fn(async () => ({ status: 'validated' as const }));
    const authentication = new OwnerLocalSudoAuthentication(validate);

    await expect(
      authentication.authenticateSudo({
        requestId: 'request-1',
        command: 'sudo true',
        ...terminal,
      }),
    ).resolves.toEqual({ status: 'validated' });
    expect(authentication.consumeSudoAuthentication('request-1')).toBe(true);
    expect(authentication.consumeSudoAuthentication('request-1')).toBe(false);
  });

  it('does not create a token when validation fails', async () => {
    const authentication = new OwnerLocalSudoAuthentication(async () => ({
      status: 'failed',
      message: 'rejected',
    }));

    await authentication.authenticateSudo({
      requestId: 'request-1',
      command: 'sudo true',
      ...terminal,
    });

    expect(authentication.consumeSudoAuthentication('request-1')).toBe(false);
  });
});
