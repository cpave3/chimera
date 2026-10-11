import { describe, expect, it } from 'vitest';
import {
  formatBackgroundAgentMessage,
  parseBackgroundAgentMessage,
} from '../src/background-agent-message';

describe('background agent message', () => {
  const message = formatBackgroundAgentMessage({
    id: 'a1b2c3',
    purpose: 'map the auth flow',
    state: 'done',
    answer: 'Login starts in src/auth/login.ts:42.',
  });

  it('says who it is from and carries the answer', () => {
    expect(message).toContain('map the auth flow');
    expect(message).toContain('not from the user');
    expect(message).toContain('Login starts in src/auth/login.ts:42.');
  });

  it('can be read back, so a client can show it as one line', () => {
    expect(parseBackgroundAgentMessage(message)).toEqual({
      id: 'a1b2c3',
      purpose: 'map the auth flow',
      state: 'done',
    });
  });

  it('keeps a purpose that has brackets and quotes in it', () => {
    const odd = formatBackgroundAgentMessage({
      id: 'x',
      purpose: 'check "retry" [core]',
      state: 'failed',
      answer: 'timeout',
    });
    expect(parseBackgroundAgentMessage(odd)).toEqual({
      id: 'x',
      purpose: 'check "retry" [core]',
      state: 'failed',
    });
  });

  it('is not seen in what a user typed', () => {
    expect(parseBackgroundAgentMessage('please look at [background agent] docs')).toBeNull();
    expect(parseBackgroundAgentMessage('hello')).toBeNull();
  });
});
