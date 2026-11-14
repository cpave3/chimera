import { jsonSchema, type ToolSet, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { outputBudget, repeatNote } from '../src/guards';
import { interceptTools, type ToolCallInterceptor } from '../src/intercept';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };

/** One tool whose behaviour each test supplies, wrapped with the given interceptors. */
function intercepted(
  name: string,
  run: (args: any) => Promise<unknown>,
  interceptors: ToolCallInterceptor[],
): AnyTool {
  const tools = {
    [name]: tool({ description: name, inputSchema: z.object({}).passthrough(), execute: run }),
  } as ToolSet;
  return interceptTools(tools, interceptors)[name] as unknown as AnyTool;
}

describe('interceptTools', () => {
  it('wraps hooks and execution with validated rewritten arguments', async () => {
    const observed: unknown[] = [];
    const tools = interceptTools(
      {
        echo: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async (args) => {
            observed.push(args);
            return args.text;
          },
        }),
      },
      [
        {
          before: (call) => {
            observed.push(call.args);
          },
        },
      ],
      async (call, next) => {
        const result = await next({ ...call, args: { text: 'rewritten' } });
        return `${result}!`;
      },
    );

    expect(await tools.echo.execute!({ text: 'original' }, {} as never)).toBe('rewritten!');
    expect(observed).toEqual([{ text: 'rewritten' }, { text: 'rewritten' }]);
  });

  it('rejects invalid middleware arguments before hooks or execution', async () => {
    const observed: unknown[] = [];
    const tools = interceptTools(
      {
        echo: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async (args) => {
            observed.push(args);
            return args.text;
          },
        }),
      },
      [
        {
          before: (call) => {
            observed.push(call.args);
          },
        },
      ],
      (call, next) => next({ ...call, args: { text: 42 } }),
    );

    await expect(tools.echo.execute!({ text: 'original' }, {} as never)).rejects.toThrow();
    expect(observed).toEqual([]);
  });

  it('also validates JSON Schema tools such as MCP tools', async () => {
    let ran = false;
    const tools = interceptTools(
      {
        remote: tool({
          inputSchema: jsonSchema({
            type: 'object',
            properties: { count: { type: 'integer', minimum: 1 } },
            required: ['count'],
          }),
          execute: async () => {
            ran = true;
            return 'done';
          },
        }),
      },
      [],
      (call, next) => next({ ...call, args: { count: 0 } }),
    );

    await expect(tools.remote.execute!({}, {} as never)).rejects.toThrow(
      'Invalid arguments for remote',
    );
    expect(ran).toBe(false);
  });

  it('lets a before interceptor answer the call without running the tool', async () => {
    let ran = false;
    const guarded = intercepted('deploy', async () => {
      ran = true;
      return 'deployed';
    }, [{ before: async (call) => ({ result: `blocked ${call.name}` }) }]);

    expect(await guarded.execute({}, {})).toBe('blocked deploy');
    expect(ran).toBe(false);
  });

  it('lets a before interceptor fail the call', async () => {
    const guarded = intercepted('deploy', async () => 'deployed', [
      { before: async () => ({ error: new Error('not allowed here') }) },
    ]);

    await expect(guarded.execute({}, {})).rejects.toThrow('not allowed here');
  });

  it('passes the result through each after interceptor in order', async () => {
    const guarded = intercepted('echo', async (args) => args.text, [
      {
        after: async (_call, outcome) =>
          'result' in outcome ? { result: `${outcome.result}!` } : outcome,
      },
      {
        after: async (_call, outcome) =>
          'result' in outcome ? { result: `${outcome.result}?` } : outcome,
      },
    ]);

    expect(await guarded.execute({ text: 'hi' }, {})).toBe('hi!?');
  });

  it('shows a thrown error to after interceptors', async () => {
    const guarded = intercepted('fail', async () => {
      throw new Error('boom');
    }, [
      {
        after: async (_call, outcome) =>
          'error' in outcome ? { error: new Error(`${outcome.error.message} (seen)`) } : outcome,
      },
    ]);

    await expect(guarded.execute({}, {})).rejects.toThrow('boom (seen)');
  });
});

describe('repeatNote', () => {
  it('adds a note to the third identical failing call', async () => {
    const guarded = intercepted('edit', async () => {
      throw new Error('old_string not found');
    }, [repeatNote()]);
    const call = () => guarded.execute({ path: 'a.ts', old_string: 'x' }, {});

    await expect(call()).rejects.toThrow(/^old_string not found$/);
    await expect(call()).rejects.toThrow(/^old_string not found$/);
    await expect(call()).rejects.toThrow(/old_string not found[\s\S]*3 times in a row/);
  });

  it('adds a note to the third identical call with the same result', async () => {
    const guarded = intercepted('status', async () => ({ state: 'pending' }), [repeatNote()]);

    await guarded.execute({ id: 1 }, {});
    await guarded.execute({ id: 1 }, {});
    const third = await guarded.execute({ id: 1 }, {});

    expect(third.state).toBe('pending');
    expect(third.repeat_note).toMatch(/3 times in a row/);
  });

  it('stays quiet when the result changes', async () => {
    let tick = 0;
    const guarded = intercepted('poll', async () => ({ tick: ++tick }), [repeatNote()]);

    for (let i = 0; i < 4; i += 1) {
      expect((await guarded.execute({}, {})).repeat_note).toBeUndefined();
    }
  });

  it('starts counting again when the arguments change', async () => {
    const guarded = intercepted('status', async () => ({ state: 'pending' }), [repeatNote()]);

    await guarded.execute({ id: 1 }, {});
    await guarded.execute({ id: 1 }, {});
    expect((await guarded.execute({ id: 2 }, {})).repeat_note).toBeUndefined();
    expect((await guarded.execute({ id: 1 }, {})).repeat_note).toBeUndefined();
  });
});

describe('outputBudget', () => {
  function archive() {
    const entries = new Map<string, { toolName: string; content: string }>();
    return {
      entries,
      put: async (input: { toolName: string; args: unknown; content: string }) => {
        const id = `pr_${String(entries.size + 1).padStart(8, '0')}`;
        entries.set(id, { toolName: input.toolName, content: input.content });
        return { id };
      },
    };
  }

  const longOutput = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} of the build log`).join(
    '\n',
  );

  it('archives an oversized text field and keeps its head and tail', async () => {
    const store = archive();
    const guarded = intercepted(
      'bash',
      async () => ({ stdout: longOutput, stderr: '', exit_code: 0, timed_out: false }),
      [outputBudget({ budgetTokens: () => 500, store })],
    );

    const result = await guarded.execute({ command: 'make' }, {});

    expect(result.exit_code).toBe(0);
    expect(result.stdout.length).toBeLessThan(500 * 4 + 400);
    expect(result.stdout).toContain('line 1 of the build log');
    expect(result.stdout).toContain('line 2000 of the build log');
    expect(result.stdout).not.toContain('line 1000 of the build log');
    expect(result.output_archived).toEqual([
      { field: 'stdout', id: 'pr_00000001', tokens: Math.ceil(longOutput.length / 4) },
    ]);
    expect(result.stdout).toContain('recall({ id: "pr_00000001" })');
    expect(store.entries.get('pr_00000001')).toEqual({ toolName: 'bash', content: longOutput });
  });

  it('leaves a result within the budget unchanged', async () => {
    const store = archive();
    const original = { stdout: 'ok\n', stderr: '', exit_code: 0, timed_out: false };
    const guarded = intercepted('bash', async () => original, [
      outputBudget({ budgetTokens: () => 500, store }),
    ]);

    expect(await guarded.execute({ command: 'true' }, {})).toBe(original);
    expect(store.entries.size).toBe(0);
  });

  it('shortens a long list and archives every item', async () => {
    const store = archive();
    const matches = Array.from({ length: 600 }, (_, i) => ({
      file: `src/module-${i}.ts`,
      line: i + 1,
      text: 'export const value = compute();',
    }));
    const guarded = intercepted(
      'grep',
      async () => ({ mode: 'content', matches, truncated: false }),
      [outputBudget({ budgetTokens: () => 1000, store })],
    );

    const result = await guarded.execute({ pattern: 'compute' }, {});

    expect(result.matches.length).toBeLessThan(600);
    expect(result.matches[0]).toEqual(matches[0]);
    expect(JSON.stringify(result).length).toBeLessThan(1000 * 4 + 400);
    expect(result.output_archived).toEqual([
      expect.objectContaining({
        field: 'matches',
        id: 'pr_00000001',
        omitted_items: 600 - result.matches.length,
      }),
    ]);
    expect(store.entries.get('pr_00000001')?.content.split('\n')).toHaveLength(600);
  });

  it('reaches text nested inside a list, as MCP results have it', async () => {
    const store = archive();
    const guarded = intercepted(
      'mcp_docs_search',
      async () => ({ content: [{ type: 'text', text: longOutput }] }),
      [outputBudget({ budgetTokens: () => 500, store })],
    );

    const result = await guarded.execute({}, {});

    expect(result.content[0].text).toContain('recall({ id: "pr_00000001" })');
    expect(result.output_archived[0].field).toBe('content.0.text');
  });

  it('never shortens images or recalled output', async () => {
    const store = archive();
    const image = { kind: 'image', data: `data:image/png;base64,${'A'.repeat(50_000)}` };
    const recalled = {
      content: longOutput,
      tool_name: 'bash',
      total_lines: 2000,
      truncated: false,
    };
    const budget = outputBudget({ budgetTokens: () => 500, store });

    expect(await intercepted('read', async () => image, [budget]).execute({}, {})).toBe(image);
    expect(await intercepted('recall', async () => recalled, [budget]).execute({}, {})).toBe(
      recalled,
    );
    expect(store.entries.size).toBe(0);
  });

  it('still shortens the text when there is no archive', async () => {
    const guarded = intercepted('bash', async () => ({ stdout: longOutput, exit_code: 0 }), [
      outputBudget({ budgetTokens: () => 500 }),
    ]);

    const result = await guarded.execute({ command: 'make' }, {});

    expect(result.stdout.length).toBeLessThan(500 * 4 + 400);
    expect(result.stdout).toContain('lines omitted');
    expect(result.stdout).not.toContain('recall(');
    expect(result.output_archived).toEqual([
      { field: 'stdout', tokens: Math.ceil(longOutput.length / 4) },
    ]);
  });
});
