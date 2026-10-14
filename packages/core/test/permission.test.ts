import { describe, expect, it } from 'vitest';
import { permissionDenialMessage } from '../src/permission';

describe('permissionDenialMessage', () => {
  it('names who denied the call', () => {
    expect(permissionDenialMessage('rule')).toBe('denied by rule');
    expect(permissionDenialMessage('hook')).toBe('denied by hook');
    expect(permissionDenialMessage('headless')).toBe('denied by policy');
    expect(permissionDenialMessage('user')).toBe('denied by user');
    expect(permissionDenialMessage(undefined)).toBe('denied by user');
  });

  it('gives the model the reason of the reviewer', () => {
    expect(permissionDenialMessage('reviewer', 'pushes to a remote the user did not name')).toBe(
      'denied by reviewer: pushes to a remote the user did not name',
    );
    expect(permissionDenialMessage('reviewer')).toMatch(/^denied by reviewer: /);
  });

  it('gives the model the note of the System One check', () => {
    expect(
      permissionDenialMessage('system_one', 'rejected: safety 0.31, needs 0.80, reads as "remote"'),
    ).toBe('denied: System One rejected: safety 0.31, needs 0.80, reads as "remote"');
    expect(permissionDenialMessage('system_one')).toBe('denied: System One rejected the command');
  });
});
