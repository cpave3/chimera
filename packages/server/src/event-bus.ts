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

  /** Events strictly after the given eventId, or all recent events if no id supplied. */
  replay(sinceEventId?: string): AgentEventEnvelope[] {
    if (!sinceEventId) return [];
    const idx = this.ring.findIndex((e) => e.eventId === sinceEventId);
    if (idx === -1) return [...this.ring];
    return this.ring.slice(idx + 1);
  }

  snapshot(): AgentEventEnvelope[] {
    return [...this.ring];
  }
}
