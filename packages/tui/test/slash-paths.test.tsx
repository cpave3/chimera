import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent, ModelConfig, Session } from '@chimera/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

async function type(stdin: NodeJS.WritableStream, text: string): Promise<void> {
  for (const ch of text) {
    // biome-ignore lint/suspicious/noExplicitAny: cast WritableStream to its untyped write usage
    (stdin as unknown as { write(chunk: string): boolean }).write(ch);
    await new Promise((r) => setTimeout(r, 1));
  }
  await new Promise((r) => setTimeout(r, 100));
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
    mode: 'build',
    userModelOverride: null,
    fileOps: { reads: new Set(), writes: new Set() },
  };
}

interface StubOpts {
  addPathSpy?: (kind: 'read' | 'write', path: string) => void;
  addPathError?: Error;
}

function stubClient(opts: StubOpts = {}): ChimeraClient {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  return {
    subscribe: async function* () {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
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
    listSubagents: async () => [],
    getSession: async (id: string) => emptySession(id),
    listSessions: async () => [],
    createSession: async () => ({ sessionId: '01HZNEWSESSION00000000000000' }),
    resumeSession: async (id: string) => ({ sessionId: id }),
    forkSession: async () => ({ sessionId: '01HZFORKEDCHILD0000000000000', parentId: 'p' }),
    compact: async () => {},
    appendMessage: async () => {},
    setModel: async () => {},
    addPath: async (_id: string, kind: 'read' | 'write', path: string) => {
      if (opts.addPathError) throw opts.addPathError;
      opts.addPathSpy?.(kind, path);
    },
    listPaths: async () => ({ read: [], write: [] }),
  } as unknown as ChimeraClient;
}

const TEST_MODEL: ModelConfig = {
  providerId: 'mock',
  modelId: 'mock',
  maxSteps: 10,
};

describe('TUI /add-read-path and /add-write-path', () => {
  it('/add-read-path /tmp calls client.addPath with read kind and shows confirmation', async () => {
    const calls: Array<{ kind: 'read' | 'write'; path: string }> = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({
          addPathSpy: (kind, path) => calls.push({ kind, path }),
        })}
        sessionId="s"
        modelRef="m/m"
        model={TEST_MODEL}
        cwd="/tmp"
      />,
    );
    await type(stdin, '/add-read-path /tmp\r');
    expect(calls).toEqual([{ kind: 'read', path: '/tmp' }]);
    expect(lastFrame()).toContain('/add-read-path: granted read access to /tmp');
    unmount();
  });

  it('/add-write-path /tmp calls client.addPath with write kind and shows confirmation', async () => {
    const calls: Array<{ kind: 'read' | 'write'; path: string }> = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({
          addPathSpy: (kind, path) => calls.push({ kind, path }),
        })}
        sessionId="s"
        modelRef="m/m"
        model={TEST_MODEL}
        cwd="/tmp"
      />,
    );
    await type(stdin, '/add-write-path /tmp\r');
    expect(calls).toEqual([{ kind: 'write', path: '/tmp' }]);
    expect(lastFrame()).toContain('/add-write-path: granted write access to /tmp');
    unmount();
  });

  it('/add-read-path with no arg shows a usage error and does not call client.addPath', async () => {
    const calls: Array<{ kind: 'read' | 'write'; path: string }> = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({
          addPathSpy: (kind, path) => calls.push({ kind, path }),
        })}
        sessionId="s"
        modelRef="m/m"
        model={TEST_MODEL}
        cwd="/tmp"
      />,
    );
    await type(stdin, '/add-read-path\r');
    expect(calls).toEqual([]);
    expect(lastFrame()).toContain('usage: /add-read-path <path>');
    unmount();
  });

  it('backend error propagates as a scrollback error line', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({
          addPathError: new Error('path does not exist'),
        })}
        sessionId="s"
        modelRef="m/m"
        model={TEST_MODEL}
        cwd="/tmp"
      />,
    );
    await type(stdin, '/add-read-path /does/not/exist\r');
    expect(lastFrame()).toContain('/add-read-path: path does not exist');
    unmount();
  });
});
