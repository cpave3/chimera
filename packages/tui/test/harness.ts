import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent, PermissionDecisionAction, QuestionResolution } from '@chimera/core';
import { vi } from 'vitest';
import { type MountOptions, mountTui, type TuiHandle } from '../src/mount';
import { VirtualInput, VirtualTerminal } from '../src/terminal/virtual-terminal';

export const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function* noEvents(): AsyncGenerator<AgentEvent> {
  yield* [];
}

/** A session whose event stream the test feeds, recording what the TUI asks of it. */
export function fakeSession() {
  const waiters: Array<(event: AgentEvent) => void> = [];
  const buffer: AgentEvent[] = [];
  const sent: string[] = [];
  const appended: string[] = [];
  const resolutions: Array<{ requestId: string; action: PermissionDecisionAction }> = [];
  const answers: Array<{ requestId: string; resolution: QuestionResolution }> = [];
  const interrupt = vi.fn(async () => {});
  const push = (event: AgentEvent) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else buffer.push(event);
  };
  const client = {
    subscribe: async function* (_sessionId: string, options?: { signal?: AbortSignal }) {
      while (!options?.signal?.aborted) {
        const next = buffer.shift();
        yield next ?? (await new Promise<AgentEvent>((resolve) => waiters.push(resolve)));
      }
    },
    getSession: async () => {
      throw new Error('no session');
    },
    send: (_sessionId: string, text: string) => {
      sent.push(text);
      return noEvents();
    },
    appendMessage: async (_sessionId: string, text: string) => {
      appended.push(text);
    },
    addPath: async () => {},
    interrupt,
    resolvePermissionAction: async (
      _sessionId: string,
      requestId: string,
      action: PermissionDecisionAction,
    ) => {
      resolutions.push({ requestId, action });
    },
    answerQuestion: async (
      _sessionId: string,
      requestId: string,
      resolution: QuestionResolution,
    ) => {
      answers.push({ requestId, resolution });
    },
    listRules: async () => [],
    listSubagents: async () => [],
    listSessions: async () => [],
    getContextBreakdown: async () => {
      throw new Error('no breakdown');
    },
  } as unknown as ChimeraClient;
  return { client, push, sent, appended, resolutions, answers, interrupt };
}

export type FakeSession = ReturnType<typeof fakeSession>;

function fakeSignals() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    sent: [] as string[],
    on(signal: string, handler: () => void) {
      if (!handlers.has(signal)) handlers.set(signal, new Set());
      handlers.get(signal)!.add(handler);
    },
    off(signal: string, handler: () => void) {
      handlers.get(signal)?.delete(handler);
    },
    kill(signal: string) {
      this.sent.push(signal);
    },
    deliver(signal: string) {
      for (const handler of [...(handlers.get(signal) ?? [])]) handler();
    },
  };
}

export interface Mounted {
  term: VirtualTerminal;
  input: VirtualInput;
  session: FakeSession;
  signals: ReturnType<typeof fakeSignals>;
  handle: TuiHandle;
  /** Send bytes as one read, then let the TUI draw. */
  keys(bytes: string, wait?: number): Promise<void>;
  /** Feed a session event, then let the TUI draw. */
  event(...events: AgentEvent[]): Promise<void>;
  /** The visible screen as text. */
  screen(): string;
  unmount(): Promise<void>;
}

/** `mountTui` on a virtual terminal with a fake session. */
export async function mount(
  overrides: Partial<MountOptions> = {},
  size = { columns: 100, rows: 30 },
): Promise<Mounted> {
  const term = new VirtualTerminal(size);
  const input = new VirtualInput();
  const session = fakeSession();
  const signals = fakeSignals();
  const handle = mountTui({
    client: session.client,
    sessionId: '01ABCDEFGH8AWWBRGC',
    modelRef: 'manticore/gpt',
    model: { providerId: 'manticore', modelId: 'gpt', maxSteps: 50 },
    cwd: '/tmp/project',
    notifications: 'off',
    version: 'v9.9.9',
    readWorktree: async () => ({ branch: 'main', ahead: 0, behind: 0, files: [] }),
    listFiles: async () => [],
    terminal: { stdin: input, stdout: term, signals, env: { TERM: 'xterm-256color' } },
    ...overrides,
  });
  await settle();
  return {
    term,
    input,
    session,
    signals,
    handle,
    async keys(bytes, wait = 40) {
      input.send(bytes);
      await settle(wait);
    },
    async event(...events) {
      for (const event of events) session.push(event);
      await settle();
    },
    screen: () => term.screen().join('\n'),
    async unmount() {
      handle.unmount();
      await settle(10);
    },
  };
}

export const userMessage = (content: string): AgentEvent => ({ type: 'user_message', content });
export const text = (delta: string, id = 't1'): AgentEvent => ({
  type: 'assistant_text_delta',
  id,
  delta,
});
export const runFinished: AgentEvent = { type: 'run_finished', reason: 'stop' } as AgentEvent;

export function toolCall(
  callId: string,
  name: string,
  args: unknown,
  summary: string,
  result?: unknown,
  resultSummary = summary,
): AgentEvent[] {
  const start: AgentEvent = {
    type: 'tool_call_start',
    callId,
    name,
    args,
    target: 'host',
    display: { summary },
  } as AgentEvent;
  if (result === undefined) return [start];
  return [
    start,
    {
      type: 'tool_call_result',
      callId,
      result,
      durationMs: 1200,
      display: { summary: resultSummary },
    } as AgentEvent,
  ];
}
