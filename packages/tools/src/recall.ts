import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { clip } from './format';

const MAX_RECALL_BYTES = 100 * 1024;

/**
 * Minimal store surface the tool needs. Implemented by `RecallStore` in
 * `@chimera/recall`; declared here so `@chimera/tools` does not depend on it.
 */
export interface RecallStoreApi {
  get(id: string): Promise<{
    id: string;
    createdAt: number;
    toolName: string;
    argsJson: string;
    content: string;
    byteLen: number;
  } | null>;
}

const RECALL_SCHEMA = z.object({
  id: z.string().describe('Archive id from a pruned tool result, e.g. "pr_abc123de".'),
  start_line: z.number().int().positive().optional().describe('1-based first line to return.'),
  end_line: z.number().int().positive().optional().describe('1-based last line (inclusive).'),
  search: z
    .string()
    .optional()
    .describe('Return only lines containing this substring (applied before slicing).'),
});
type RecallArgs = z.infer<typeof RECALL_SCHEMA>;
type RecallResult =
  | {
      content: string;
      tool_name: string;
      total_lines: number;
      truncated: boolean;
    }
  | { error: string };

export function buildRecallTool(ctx: ToolContext) {
  return defineTool<RecallArgs, RecallResult>({
    description:
      'Retrieve a tool result that was archived during context compaction. Archived ' +
      'results appear in the conversation as "[Result archived — retrieve with: ' +
      'recall({ id: ... })]". Use start_line/end_line or search to fetch just the ' +
      'part you need instead of the whole output.',
    inputSchema: RECALL_SCHEMA,
    execute: async (args) => {
      const entry = await ctx.recall?.get(args.id);
      if (!entry) {
        return { error: `no archived result with id '${args.id}' (expired or never archived)` };
      }
      let lines = entry.content.split('\n');
      const totalLines = lines.length;
      if (args.search !== undefined) {
        lines = lines.filter((line) => line.includes(args.search!));
      }
      if (args.start_line !== undefined || args.end_line !== undefined) {
        const start = (args.start_line ?? 1) - 1;
        const end = args.end_line ?? lines.length;
        lines = lines.slice(start, end);
      }
      let content = lines.join('\n');
      let truncated = false;
      if (Buffer.byteLength(content, 'utf8') > MAX_RECALL_BYTES) {
        content = content.slice(0, MAX_RECALL_BYTES);
        truncated = true;
      }
      return {
        content,
        tool_name: entry.toolName,
        total_lines: totalLines,
        truncated,
      };
    },
    formatScrollback: (args, result) => {
      if (!result) return { summary: args.id };
      if ('error' in result) return { summary: `${args.id} (${clip(result.error, 40)})` };
      const filters = args.search !== undefined || args.start_line !== undefined ? ' (sliced)' : '';
      return { summary: `${args.id} → ${result.tool_name}${filters}` };
    },
  });
}
