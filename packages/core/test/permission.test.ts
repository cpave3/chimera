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
});
