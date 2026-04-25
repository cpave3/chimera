import type { AgentEvent, AgentEventEnvelope, SessionId } from '@chimera/core';
import { newEventId } from '@chimera/core';

const RING_SIZE = 1000;

export type Subscriber = (envelope: AgentEventEnvelope) => void;

export class EventBus {
  private readonly sessionId: SessionId;
  private readonly ring: AgentEventEnvelope[] = [];
  private readonly subscribers = new Set<Subscriber>();

  constructor(sessionId: SessionId) {
    this.sessionId = sessionId;
  }

  publish(event: AgentEvent): AgentEventEnvelope {
    const envelope: AgentEventEnvelope = {
      ...event,
      eventId: newEventId(),
      sessionId: this.sessionId,
      ts: Date.now(),
    };
    this.ring.push(envelope);
    if (this.ring.length > RING_SIZE) {
      this.ring.shift();
    }
    for (const sub of this.subscribers) {
      try {
        sub(envelope);
      } catch {
        // never let one slow subscriber break the bus
      }
    }
    return envelope;
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  // Events strictly after the given eventId. When `sinceEventId` is
  // unknown (evicted from the ring, or from a different server), return []
  // rather than the whole ring — re-delivering events the client already
  // has would duplicate them in scrollback. The cost is forfeiting the
  // window of evicted events; the alternative duplicate-flood is worse.
  replay(sinceEventId?: string): AgentEventEnvelope[] {
    if (!sinceEventId) return [];
    const idx = this.ring.findIndex((e) => e.eventId === sinceEventId);
    if (idx === -1) return [];
    return this.ring.slice(idx + 1);
  }

  snapshot(): AgentEventEnvelope[] {
    return [...this.ring];
  }
}
