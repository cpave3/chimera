import type { AgentEvent } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { buildSpawnAgentTool } from '../src/spawn-tool';
import type { InProcessAgentBuilder, SpawnAgentToolContext } from '../src/types';

function makeCtx(over: Partial<SpawnAgentToolContext> = {}): SpawnAgentToolContext {
  return {
    emit: () => {},
    parentAbortSignal: new AbortController().signal,
    parentSessionId: 'p',
    cwd: '/tmp',
    defaultModelRef: 'anthropic/claude-haiku-4-5',
    sandboxMode: 'off',
    autoApprove: 'host',
    currentDepth: 0,
    maxDepth: 3,
    chimeraBin: '/usr/bin/false',
    parentHasTty: true,
    ...over,
  };
}

describe('parallel spawn_agent interrupt cascade', () => {
  it('aborts both in-flight children when the parent signal fires', async () => {
    const interrupts: string[] = [];
    const builder =
      (label: string): InProcessAgentBuilder =>
      async () => {
        const send = async function* (
          _p: string,
          opts?: { signal?: AbortSignal },
        ): AsyncGenerator<AgentEvent> {
          await new Promise<void>((resolve) => {
            if (opts?.signal?.aborted) return resolve();
            opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { type: 'run_finished', reason: 'interrupted' };
        };
        return {
          sessionId: `child-${label}`,
          send: (p, o) => send(p, o),
          interrupt: () => interrupts.push(label),
          dispose: async () => {},
        };
      };

    const parentCtl = new AbortController();
    const ctxA = makeCtx({
      inProcess: builder('a'),
      parentAbortSignal: parentCtl.signal,
    });
    const ctxB = makeCtx({
      inProcess: builder('b'),
      parentAbortSignal: parentCtl.signal,
    });

    type Anyx = { execute: (a: any, c: any) => Promise<any> };
    const toolA = buildSpawnAgentTool(ctxA).tool as unknown as Anyx;
    const toolB = buildSpawnAgentTool(ctxB).tool as unknown as Anyx;

    const pA = toolA.execute(
      { prompt: 'a', purpose: 'a', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 'a', messages: [] },
    );
    const pB = toolB.execute(
      { prompt: 'b', purpose: 'b', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 'b', messages: [] },
    );

    // Let both start.
    await new Promise((r) => setTimeout(r, 20));
    parentCtl.abort();
    const [rA, rB] = await Promise.all([pA, pB]);

    expect(rA.reason).toBe('interrupted');
    expect(rB.reason).toBe('interrupted');
    expect(interrupts.sort()).toEqual(['a', 'b']);
  });
});
