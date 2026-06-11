import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';
import { buildRecallTool, type RecallStoreApi } from '../src/recall';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };
const asAny = (def: { tool: unknown }) => def.tool as AnyTool;

function makeStore(entries: Record<string, { toolName: string; content: string }>): RecallStoreApi {
  return {
    get: async (id) => {
      const entry = entries[id];
      if (!entry) return null;
      return {
        id,
        createdAt: 0,
        toolName: entry.toolName,
        argsJson: '{}',
        content: entry.content,
        byteLen: Buffer.byteLength(entry.content, 'utf8'),
      };
    },
  };
}

function makeCtx(store: RecallStoreApi): ToolContext {
  const executor = new LocalExecutor({ cwd: '/tmp' });
  return {
    sandboxExecutor: executor,
    hostExecutor: executor,
    sandboxMode: 'off',
    recall: store,
  };
}

describe('recall tool', () => {
  it('returns the full archived content', async () => {
    const tool = asAny(
      buildRecallTool(makeCtx(makeStore({ pr_abc12345: { toolName: 'bash', content: 'a\nb\nc' } }))),
    );
    const result = await tool.execute({ id: 'pr_abc12345' }, {});
    expect(result.content).toBe('a\nb\nc');
    expect(result.tool_name).toBe('bash');
    expect(result.total_lines).toBe(3);
  });

  it('slices by start_line/end_line (1-based, inclusive)', async () => {
    const tool = asAny(
      buildRecallTool(
        makeCtx(makeStore({ pr_abc12345: { toolName: 'read', content: 'l1\nl2\nl3\nl4\nl5' } })),
      ),
    );
    const result = await tool.execute({ id: 'pr_abc12345', start_line: 2, end_line: 4 }, {});
    expect(result.content).toBe('l2\nl3\nl4');
  });

  it('filters lines by search, preserving order', async () => {
    const tool = asAny(
      buildRecallTool(
        makeCtx(makeStore({ pr_abc12345: { toolName: 'grep', content: 'foo 1\nbar\nfoo 2' } })),
      ),
    );
    const result = await tool.execute({ id: 'pr_abc12345', search: 'foo' }, {});
    expect(result.content).toBe('foo 1\nfoo 2');
  });

  it('caps oversized content and sets truncated', async () => {
    const big = 'x'.repeat(200_000);
    const tool = asAny(
      buildRecallTool(makeCtx(makeStore({ pr_abc12345: { toolName: 'bash', content: big } }))),
    );
    const result = await tool.execute({ id: 'pr_abc12345' }, {});
    expect(result.content.length).toBeLessThanOrEqual(100 * 1024);
    expect(result.truncated).toBe(true);
  });

  it('returns an error result for unknown ids without throwing', async () => {
    const tool = asAny(buildRecallTool(makeCtx(makeStore({}))));
    const result = await tool.execute({ id: 'pr_00000000' }, {});
    expect(result.error).toMatch(/no archived result/i);
  });
});
