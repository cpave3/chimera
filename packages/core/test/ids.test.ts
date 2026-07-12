import { describe, expect, it } from 'vitest';
import { isValidSessionId, newCallId, newEventId, newRequestId, newSessionId } from '../src/ids';

describe('ids', () => {
  it('produces 26-character ULIDs', () => {
    for (const fn of [newSessionId, newEventId, newCallId, newRequestId]) {
      const id = fn();
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it('validates custom session IDs', () => {
    for (const id of ['a', 'Session-1', 'release.2026_07']) {
      expect(isValidSessionId(id)).toBe(true);
    }
    for (const id of ['', '.session', '-session', 'session/id', 'session name']) {
      expect(isValidSessionId(id)).toBe(false);
    }
  });

  it('produces sorted-over-time unique IDs', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toEqual(b);
  });
});
