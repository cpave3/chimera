import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

interface AgentEvent {
  type: string;
}

function stubClient(
  overrides: {
    addPathSpy?: (kind: 'read' | 'write', path: string) => void;
    addPathError?: Error;
    appendMessageSpy?: (content: string) => void;
    sendSpy?: (msg: string) => void;
  } = {},
) {
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
    send: async function* (_id: string, msg: string) {
      overrides.sendSpy?.(msg);
      yield* [];
    },
    interrupt: async () => {},
    listRules: async () => [],
    addRule: async () => {},
    removeRule: async () => {},
    resolvePermission: async () => {},
    listSubagents: async () => [],
    getSession: async (_id: string) => {
      return {
        id: _id,
        parentId: null,
        children: [],
        cwd: '/tmp',
        createdAt: 1700000000000,
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
    },
    listSessions: async () => [],
    createSession: async () => ({ sessionId: '01HZNEWSESS00000000000000000' }),
    resumeSession: async () => ({ sessionId: '01HZRESUMED00000000000000000' }),
    forkSession: async () => ({
      sessionId: '01HZFORK00000000000000000000',
      parentId: '01HZPARENT000000000000000000',
    }),
    compact: async () => {},
    appendMessage: async (_id: string, content: string) => {
      overrides.appendMessageSpy?.(content);
    },
    addPath: async (_id: string, kind: 'read' | 'write', path: string) => {
      overrides.addPathSpy?.(kind, path);
      if (overrides.addPathError) throw overrides.addPathError;
    },
    listPaths: async () => ({ read: [], write: [] }),
    pushEvent: (ev: AgentEvent) => {
      queue.push(ev);
      wake?.();
      wake = null;
    },
  } as unknown as import('@chimera/client').ChimeraClient;
}

async function type(stdin: NodeJS.WritableStream, text: string): Promise<void> {
  for (const ch of text) {
    (stdin as any).write(ch);
    await new Promise((r) => setTimeout(r, 1));
  }
  await new Promise((r) => setTimeout(r, 100));
}

describe('attach paths App flow', () => {
  it('parses @token, calls addPath, appendMessage, then send with the original text', async () => {
    const addPathCalls: Array<{ kind: 'read' | 'write'; path: string }> = [];
    const appendCalls: string[] = [];
    const sendCalls: string[] = [];

    const client = stubClient({
      addPathSpy: (kind, path) => addPathCalls.push({ kind, path }),
      appendMessageSpy: (content) => appendCalls.push(content),
      sendSpy: (msg) => sendCalls.push(msg),
    });

    const { stdin, unmount } = render(
      <App client={client} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );

    await type(stdin, 'look at @/etc/hosts and tell me\r');
    await new Promise((r) => setTimeout(r, 200));

    // addPath for /etc/hosts
    expect(addPathCalls).toEqual([{ kind: 'read', path: '/etc/hosts' }]);

    // appendMessage with auto-attached content
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]).toContain('[auto-attached @/etc/hosts]');

    // sendUserMessage receives the original text with @token still present
    expect(sendCalls).toEqual(['look at @/etc/hosts and tell me']);

    unmount();
  });

  it('skips appendMessage when addPath 400s and emits an error', async () => {
    const error = Object.assign(new Error('no such file or directory'), { status: 400 });
    const addPathCalls: Array<{ kind: 'read' | 'write'; path: string }> = [];
    const appendCalls: string[] = [];
    const sendCalls: string[] = [];

    const client = stubClient({
      addPathError: error,
      addPathSpy: (kind, path) => addPathCalls.push({ kind, path }),
      appendMessageSpy: (content) => appendCalls.push(content),
      sendSpy: (msg) => sendCalls.push(msg),
    });

    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );

    await type(stdin, 'look at @/does/not/exist and tell me\r');
    await new Promise((r) => setTimeout(r, 200));

    // addPath was attempted
    expect(addPathCalls).toEqual([{ kind: 'read', path: '/does/not/exist' }]);

    // No appendMessage since addPath failed
    expect(appendCalls).toEqual([]);

    // send still proceeds with original text
    expect(sendCalls).toEqual(['look at @/does/not/exist and tell me']);

    // Error shows in scrollback
    expect(lastFrame()).toContain('attach /does/not/exist');

    unmount();
  });
});
