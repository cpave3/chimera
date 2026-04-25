import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/define';

describe('defineTool', () => {
  it('exposes both the AI SDK tool and the formatScrollback hook', async () => {
    const def = defineTool({
      description: 'echo back',
      inputSchema: z.object({ msg: z.string() }),
      execute: async (args: { msg: string }) => ({ echoed: args.msg }),
      formatScrollback: (args, result) => ({
        summary: result ? `${args.msg} → ${result.echoed}` : args.msg,
      }),
    });

    // `tool` is the AI SDK tool; carries the description we passed in.
    expect(def.tool).toBeDefined();
    expect((def.tool as { description?: string }).description).toBe('echo back');

    // formatScrollback returns args-only summary when result is absent…
    expect(def.formatScrollback?.({ msg: 'hi' })).toEqual({ summary: 'hi' });
    // …and result-aware summary when result is provided.
    expect(def.formatScrollback?.({ msg: 'hi' }, { echoed: 'hi' })).toEqual({
      summary: 'hi → hi',
    });
  });

  it('omits formatScrollback when not provided (current behaviour fallback)', () => {
    const def = defineTool({
      description: 'no formatter',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    expect(def.formatScrollback).toBeUndefined();
  });
});
