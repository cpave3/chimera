import { describe, expect, it } from 'vitest';
import { newCallId, newEventId, newRequestId, newSessionId } from '../src/ids';

describe('ids', () => {
  it('produces 26-character ULIDs', () => {
    for (const fn of [newSessionId, newEventId, newCallId, newRequestId]) {
      const id = fn();
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it('produces sorted-over-time unique IDs', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toEqual(b);
  });
});
