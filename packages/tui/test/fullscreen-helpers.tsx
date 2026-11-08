import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent, ContextBreakdown } from '@chimera/core';

export const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** A frame without the cursor's inverse-video codes. */
export function plain(frame: string | undefined): string {
  return (frame ?? '').replaceAll('\x1b[7m', '').replaceAll('\x1b[27m', '');
}

export async function type(stdin: { write: (data: string) => void }, text: string) {
  for (const character of text) {
    stdin.write(character);
    await settle(2);
  }
  await settle(20);
}

async function* noEvents(): AsyncGenerator<AgentEvent> {
  yield* [];
}

export interface FakeSession {
  client: ChimeraClient;
  push: (event: AgentEvent) => void;
  sent: string[];
}

/** A session whose event stream the test feeds, recording what the TUI sends. */
export function fakeSession(options: { breakdown?: Partial<ContextBreakdown> } = {}): FakeSession {
  const waiters: Array<(event: AgentEvent) => void> = [];
  const buffer: AgentEvent[] = [];
  const sent: string[] = [];
  const push = (event: AgentEvent) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else buffer.push(event);
  };
  const client = {
    subscribe: async function* () {
      while (true) {
        const next = buffer.shift();
        yield next ?? (await new Promise<AgentEvent>((resolve) => waiters.push(resolve)));
      }
    },
    send: (_sessionId: string, text: string) => {
      sent.push(text);
      return noEvents();
    },
    appendMessage: async () => {},
    interrupt: async () => {},
    listRules: async () => [],
    listSubagents: async () => [],
    listSessions: async () => [],
    getContextBreakdown: async () => {
      if (!options.breakdown) throw new Error('no breakdown');
      return options.breakdown;
    },
  } as unknown as ChimeraClient;
  return { client, push, sent };
}
