import { describe, expect, it } from 'vitest';
import { buildSpawnAgentTool } from '../src/spawn-tool';
import type { SpawnAgentToolContext } from '../src/types';

function baseCtx(): SpawnAgentToolContext {
  return {
    emit: () => {},
    parentAbortSignal: new AbortController().signal,
    parentSessionId: 'parent-1',
    cwd: '/tmp',
    defaultModelRef: 'anthropic/claude-haiku-4-5',
    sandboxMode: 'off',
    autoApprove: 'host',
    currentDepth: 0,
    maxDepth: 3,
    chimeraBin: '/usr/bin/false',
    parentHasTty: true,
  };
}

describe('spawn_agent formatScrollback', () => {
  it('summarizes by `purpose` when available', () => {
    const f = buildSpawnAgentTool(baseCtx()).formatScrollback!;
    expect(f({ prompt: 'do something complex', purpose: 'investigate auth bug' })).toEqual({
      summary: 'investigate auth bug',
    });
  });

  it('falls back to a clipped prompt when purpose is missing', () => {
    const f = buildSpawnAgentTool(baseCtx()).formatScrollback!;
    const longPrompt = 'do this thing '.repeat(20);
    const out = f({ prompt: longPrompt, purpose: '' });
    expect(out.summary.length).toBeLessThanOrEqual(61);
    expect(out.summary.endsWith('…')).toBe(true);
  });

  it('appends "(done)" on a successful result', () => {
    const f = buildSpawnAgentTool(baseCtx()).formatScrollback!;
    expect(
      f(
        { prompt: '', purpose: 'investigate' },
        {
          subagent_id: 's',
          result: 'ok',
          reason: 'stop',
          session_id: 'x',
          steps: 1,
          tool_calls_count: 0,
        },
      ).summary,
    ).toBe('investigate (done)');
  });

  it('shows the stop reason when not "stop"', () => {
    const f = buildSpawnAgentTool(baseCtx()).formatScrollback!;
    expect(
      f(
        { prompt: '', purpose: 'investigate' },
        {
          subagent_id: 's',
          result: 'oops',
          reason: 'error',
          session_id: '',
          steps: 0,
          tool_calls_count: 0,
        },
      ).summary,
    ).toBe('investigate (error)');
  });
});
