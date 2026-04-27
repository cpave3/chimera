import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent, Session } from '@chimera/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import type { OpenInEditorResult } from '../src/input/external-editor';

interface StubOpts {
  sendSpy?: (msg: string) => void;
}

function emptySession(id: string): Session {
  return {
    id,
    parentId: null,
    children: [],
    cwd: '/tmp',
    createdAt: 1,
    messages: [],
    toolCalls: [],
    status: 'idle',
    model: { providerId: 'mock', modelId: 'mock', maxSteps: 10 },
    sandboxMode: 'off',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
    },
  };
}

function stubClient(opts: StubOpts = {}): ChimeraClient {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  return {
    subscribe: async function* () {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
    send: async function* (_id: string, msg: string) {
      opts.sendSpy?.(msg);
      wake?.();
      wake = null;
    },
    interrupt: async () => {},
    listRules: async () => [],
    addRule: async () => {},
    removeRule: async () => {},
    resolvePermission: async () => {},
    listSubagents: async () => [],
    getSession: async (id: string) => emptySession(id),
    listSessions: async () => [],
    createSession: async () => ({ sessionId: 'x' }),
    resumeSession: async (id: string) => ({ sessionId: id }),
    forkSession: async (id: string) => ({ sessionId: 'c', parentId: id }),
  } as unknown as ChimeraClient;
}

async function type(stdin: NodeJS.WritableStream, text: string): Promise<void> {
  for (const ch of text) {
    (stdin as unknown as { write: (s: string) => void }).write(ch);
    await new Promise((r) => setTimeout(r, 1));
  }
  await new Promise((r) => setTimeout(r, 50));
}

async function writeRaw(stdin: NodeJS.WritableStream, seq: string): Promise<void> {
  (stdin as unknown as { write: (s: string) => void }).write(seq);
  await new Promise((r) => setTimeout(r, 50));
}

describe('multi-line input', () => {
  it('typing `hello\\` then Enter inserts a newline and does not send', async () => {
    const sent: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
      />,
    );
    await type(stdin, 'hello\\\r');
    const frame = lastFrame()!;
    expect(sent).toEqual([]);
    // First line shows `> hello`. Cursor is on the new (second) line.
    expect(frame).toContain('> hello');
    unmount();
  });

  it('plain Enter (no trailing backslash) submits the buffer', async () => {
    const sent: string[] = [];
    const { stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
      />,
    );
    await type(stdin, 'hello world\r');
    expect(sent).toEqual(['hello world']);
    unmount();
  });

  it('a literal linefeed inserts a newline mid-buffer without submitting', async () => {
    // The stdin-filter translates Shift+Enter / Alt+Enter sequences to a
    // bare `\n` before Ink sees them. This test exercises the post-filter
    // path: when `\n` reaches the App, it should land in the buffer as a
    // newline (via the printable-char path) without triggering submit.
    const sent: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
      />,
    );
    await type(stdin, 'foo');
    await writeRaw(stdin, '\n');
    const frame = lastFrame()!;
    expect(sent).toEqual([]);
    expect(frame).toContain('> foo');
    unmount();
  });

  it('multi-line message reaches the agent intact', async () => {
    const sent: string[] = [];
    const { stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
      />,
    );
    await type(stdin, 'first\\\rsecond\r');
    expect(sent).toEqual(['first\nsecond']);
    unmount();
  });

  it('Backspace after \\<Enter> joins the lines (deletes the inserted newline)', async () => {
    const sent: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
      />,
    );
    await type(stdin, 'hello\\\r');
    // Now buffer is 'hello\n' with cursor at offset 6 (start of line 2).
    expect(lastFrame()!).toContain('> hello');
    // Send backspace (\x7f) — should remove the \n and rejoin to 'hello'.
    await writeRaw(stdin, '\x7f');
    const frame = lastFrame()!;
    expect(frame).toContain('> hello');
    // The empty second-line row (`  ` prefix) should be gone now.
    const lines = frame.split('\n');
    const promptIdx = lines.findIndex((l) => l.includes('> hello'));
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    // The next line should be the cwd status bar, not a blank prompt row.
    expect(lines[promptIdx + 1] ?? '').not.toMatch(/^ {2}\s*$/);
    expect(sent).toEqual([]);
    unmount();
  });

  it('Up arrow with empty buffer recalls history (regression)', async () => {
    const sent: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
      />,
    );
    await type(stdin, 'recallme\r');
    await new Promise((r) => setTimeout(r, 30));
    await writeRaw(stdin, '\x1b[A');
    const frame = lastFrame()!;
    expect(frame).toContain('> recallme');
    unmount();
  });

  it('Ctrl+G runs the editor handoff and replaces the buffer', async () => {
    const opened: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient()}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        openInEditor={async ({ initialText }) => {
          opened.push(initialText);
          const result: OpenInEditorResult = { ok: true, text: 'after edit' };
          return result;
        }}
      />,
    );
    await type(stdin, 'before');
    await type(stdin, '\x07'); // Ctrl+G
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual(['before']);
    const frame = lastFrame()!;
    expect(frame).toContain('> after edit');
    unmount();
  });
});
