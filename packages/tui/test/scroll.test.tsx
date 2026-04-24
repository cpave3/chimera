import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent } from '@chimera/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

/**
 * Build a stub client whose subscribe() yields a sequence of events. Used to
 * seed the scrollback with many entries so we can scroll through them.
 */
function clientWithEvents(events: AgentEvent[]): ChimeraClient {
  return {
    subscribe: async function* () {
      for (const ev of events) yield ev;
      await new Promise(() => {});
    },
    send: async function* () {},
    interrupt: async () => {},
    listRules: async () => [],
    addRule: async () => {},
    removeRule: async () => {},
    resolvePermission: async () => {},
  } as unknown as ChimeraClient;
}

function makeMessages(n: number): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ type: 'user_message', content: `line-${i}` });
  }
  return out;
}

function streamingClient(
  initial: AgentEvent[],
): { client: ChimeraClient; push: (ev: AgentEvent) => void } {
  const queue: AgentEvent[] = [...initial];
  let wake: (() => void) | null = null;
  const client = {
    subscribe: async function* () {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
    send: async function* () {},
    interrupt: async () => {},
    listRules: async () => [],
    addRule: async () => {},
    removeRule: async () => {},
    resolvePermission: async () => {},
  } as unknown as ChimeraClient;
  const push = (ev: AgentEvent) => {
    queue.push(ev);
    wake?.();
    wake = null;
  };
  return { client, push };
}

describe('scrollback paging', () => {
  it('PageUp reveals older entries; PageDown returns toward the tail', async () => {
    const events = makeMessages(60);
    const { lastFrame, stdin, unmount } = render(
      <App client={clientWithEvents(events)} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    // Let subscribe drain.
    await new Promise((r) => setTimeout(r, 40));

    // At tail, we see the last few "line-N" entries, not line-0.
    const initial = lastFrame()!;
    expect(initial).toContain('line-59');
    expect(initial).not.toContain('line-0');
    expect(initial).not.toContain('scrolled back');

    // PageUp several times — scroll back toward the beginning.
    for (let i = 0; i < 10; i += 1) {
      (stdin as any).write('\x1b[5~'); // PageUp
      await new Promise((r) => setTimeout(r, 5));
    }
    const scrolled = lastFrame()!;
    expect(scrolled).toContain('scrolled back');
    // line-59 should no longer be in view (we've scrolled past it).
    expect(scrolled).not.toContain('line-59');

    // PageDown all the way back.
    for (let i = 0; i < 20; i += 1) {
      (stdin as any).write('\x1b[6~'); // PageDown
      await new Promise((r) => setTimeout(r, 5));
    }
    const tail = lastFrame()!;
    expect(tail).toContain('line-59');
    expect(tail).not.toContain('scrolled back');
    unmount();
  });

  it('mouse wheel up scrolls the feed, wheel down returns to tail', async () => {
    const events = makeMessages(60);
    // Capture the wheel handler ink would subscribe to.
    let wheelHandler: ((dir: 'up' | 'down') => void) | null = null;
    const subscribeWheel = (h: (dir: 'up' | 'down') => void) => {
      wheelHandler = h;
      return () => {
        wheelHandler = null;
      };
    };

    const { lastFrame, unmount } = render(
      <App
        client={clientWithEvents(events)}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        subscribeWheel={subscribeWheel}
      />,
    );
    await new Promise((r) => setTimeout(r, 40));

    // Simulate several wheel-ups.
    for (let i = 0; i < 5; i += 1) wheelHandler?.('up');
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()!).toContain('scrolled back');
    expect(lastFrame()!).not.toContain('line-59');

    // Wheel back down past the tail.
    for (let i = 0; i < 10; i += 1) wheelHandler?.('down');
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()!).toContain('line-59');
    expect(lastFrame()!).not.toContain('scrolled back');
    unmount();
  });

  it('shows the tail of a tall message even if it is larger than the viewport', async () => {
    // Single message with many lines — guaranteed taller than the test
    // renderer's viewport. Old behavior: nothing rendered (bailed because the
    // entry didn't "fit"). New behavior: last N lines show.
    const longBody = Array.from({ length: 80 }, (_, i) => `row-${i}`).join('\n');
    const events: AgentEvent[] = [{ type: 'assistant_text_done', text: longBody }];
    const { lastFrame, unmount } = render(
      <App client={clientWithEvents(events)} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame()!;
    // The final row must be visible (we're at the tail).
    expect(frame).toContain('row-79');
    // Early rows must be clipped — if the old algorithm were still live the
    // whole entry would be hidden (frame wouldn't contain 'row-79' either).
    expect(frame).not.toContain('row-0 ');
    expect(frame).not.toMatch(/\brow-0\b/);
    unmount();
  });

  it('keeps the first viewport visible when the user scrolls past the top', async () => {
    // Seed with enough messages to guarantee we can scroll a long way. Then
    // scroll up far more than the content length — the viewport must stay
    // pinned at the top, not go blank or drop lines from the bottom.
    const events = makeMessages(40);
    let wheelHandler: ((dir: 'up' | 'down') => void) | null = null;
    const subscribeWheel = (h: (dir: 'up' | 'down') => void) => {
      wheelHandler = h;
      return () => {
        wheelHandler = null;
      };
    };
    const { lastFrame, unmount } = render(
      <App
        client={clientWithEvents(events)}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        subscribeWheel={subscribeWheel}
      />,
    );
    await new Promise((r) => setTimeout(r, 40));
    // Wildly over-scroll.
    for (let i = 0; i < 500; i += 1) wheelHandler?.('up');
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame()!;
    // First message must be visible (we're pinned at the top).
    expect(frame).toContain('line-0');
    // Newest must NOT be visible (we scrolled away from the tail).
    expect(frame).not.toContain('line-39');
    unmount();
  });

  it('pressing Enter returns scroll to the live tail', async () => {
    const events = makeMessages(60);
    const sent: string[] = [];
    const client = {
      subscribe: async function* () {
        for (const ev of events) yield ev;
        await new Promise(() => {});
      },
      send: async function* (_id: string, msg: string) {
        sent.push(msg);
      },
      interrupt: async () => {},
      listRules: async () => [],
      addRule: async () => {},
      removeRule: async () => {},
      resolvePermission: async () => {},
    } as unknown as ChimeraClient;

    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await new Promise((r) => setTimeout(r, 40));
    (stdin as any).write('\x1b[5~');
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()!).toContain('scrolled back');

    // Type a message and hit Enter.
    for (const ch of 'hello\r') {
      (stdin as any).write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 30));

    expect(sent).toEqual(['hello']);
    expect(lastFrame()!).not.toContain('scrolled back');
    unmount();
  });
});
