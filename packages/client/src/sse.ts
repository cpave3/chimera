import type { AgentEventEnvelope } from '@chimera/core';

/**
 * Parses an SSE stream body into an async iterable of AgentEventEnvelopes.
 * Tracks the last observed eventId.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array> | null,
  onEventId: (id: string) => void,
): AsyncGenerator<AgentEventEnvelope, void, void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const env = parseBlock(chunk);
        if (env) {
          onEventId(env.eventId);
          yield env;
        }
        idx = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
    try {
      reader.releaseLock();
    } catch {
      // best-effort
    }
  }
}

function parseBlock(block: string): AgentEventEnvelope | null {
  let eventName: string | null = null;
  let id: string | null = null;
  let data = '';
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('id:')) {
      id = line.slice(3).trim();
    } else if (line.startsWith('data:')) {
      data += (data ? '\n' : '') + line.slice(5).trimStart();
    }
  }
  if (!data || eventName !== 'agent_event') return null;
  try {
    const parsed = JSON.parse(data) as AgentEventEnvelope;
    if (id) parsed.eventId = id;
    return parsed;
  } catch {
    return null;
  }
}
