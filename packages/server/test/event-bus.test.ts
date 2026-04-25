import { describe, expect, it } from 'vitest';
import type { SessionId } from '@chimera/core';
import { EventBus } from '../src/event-bus';

const sid = 's1' as unknown as SessionId;

describe('EventBus.replay', () => {
  it('returns [] when no sinceEventId is given', () => {
    const bus = new EventBus(sid);
    bus.publish({ type: 'session_started', sessionId: sid });
    bus.publish({ type: 'user_message', content: 'hi' });
    expect(bus.replay()).toEqual([]);
  });

  it('returns events strictly after a known sinceEventId', () => {
    const bus = new EventBus(sid);
    const a = bus.publish({ type: 'session_started', sessionId: sid });
    const b = bus.publish({ type: 'user_message', content: 'hi' });
    const c = bus.publish({ type: 'assistant_text_done', text: 'ok' });
    expect(bus.replay(a.eventId).map((e) => e.eventId)).toEqual([b.eventId, c.eventId]);
    expect(bus.replay(b.eventId).map((e) => e.eventId)).toEqual([c.eventId]);
    expect(bus.replay(c.eventId)).toEqual([]);
  });

  it('returns [] when sinceEventId is unknown (evicted or never seen)', () => {
    // Reproduces the duplicate-flood bug: a long-lived client reconnects with
    // a `since` whose eventId has rolled out of the ring (or was never on
    // this server). The previous behavior dumped the entire ring, which the
    // client then re-rendered as new content. Returning [] forfeits the
    // missed-event window but eliminates duplicate replay of events the
    // client already has.
    const bus = new EventBus(sid);
    bus.publish({ type: 'session_started', sessionId: sid });
    bus.publish({ type: 'user_message', content: 'hi' });
    expect(bus.replay('01ZZZZZZZZZZZZZZZZZZZZZZZZ')).toEqual([]);
  });
});
