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

describe('parallel spawn_agent emission integrity', () => {
  it('emits distinct subagentId/parentCallId per parallel execute() call (single tool, shared ctx)', async () => {
    const events: AgentEvent[] = [];
    const builder: InProcessAgentBuilder = async ({ model: _m }) => {
      const sessionId = `child-${Math.random().toString(36).slice(2, 6)}`;
      return {
        sessionId,
        send: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: 'assistant_text_done', text: 'ok' };
            yield { type: 'run_finished', reason: 'stop' };
          })(),
        interrupt: () => {},
        dispose: async () => {},
      };
    };
    // Real shape: the agent registers ONE spawn_agent tool whose ctx is shared
    // across all concurrent execute() invocations. Mirror that here.
    const callIdMap = new Map<string, string>([
      ['ai-call-A', 'PARENT_CALL_A'],
      ['ai-call-B', 'PARENT_CALL_B'],
    ]);
    const ctx = makeCtx({
      emit: (ev) => events.push(ev),
      inProcess: builder,
      resolveCallId: (id) => callIdMap.get(id),
    });
    type Anyx = { execute: (a: any, c: any) => Promise<any> };
    const tool = buildSpawnAgentTool(ctx).tool as unknown as Anyx;

    const [resA, resB] = await Promise.all([
      tool.execute(
        { prompt: 'A', purpose: 'consistency', in_process: true },
        { abortSignal: new AbortController().signal, toolCallId: 'ai-call-A', messages: [] },
      ),
      tool.execute(
        { prompt: 'B', purpose: 'tests-docs', in_process: true },
        { abortSignal: new AbortController().signal, toolCallId: 'ai-call-B', messages: [] },
      ),
    ]);

    expect(resA.subagent_id).not.toBe(resB.subagent_id);

    const spawned = events.filter((e) => e.type === 'subagent_spawned') as Array<
      Extract<AgentEvent, { type: 'subagent_spawned' }>
    >;
    expect(spawned).toHaveLength(2);
    const purposeToParent = new Map(spawned.map((s) => [s.purpose, s.parentCallId]));
    expect(purposeToParent.get('consistency')).toBe('PARENT_CALL_A');
    expect(purposeToParent.get('tests-docs')).toBe('PARENT_CALL_B');
    // And the subagentIds in the spawn events match the result ids.
    const idByPurpose = new Map(spawned.map((s) => [s.purpose, s.subagentId]));
    expect(idByPurpose.get('consistency')).toBe(resA.subagent_id);
    expect(idByPurpose.get('tests-docs')).toBe(resB.subagent_id);
  });
});

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
