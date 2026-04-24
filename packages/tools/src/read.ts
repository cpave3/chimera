import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './context';

const MAX_LINES = 2000;
const MAX_BYTES = 100 * 1024;

export function buildReadTool(ctx: ToolContext) {
  return tool({
    description:
      'Read a file from the working directory. Returns line-number-prefixed content. ' +
      'Limited to 2000 lines or 100 KB (whichever is smaller); specify start_line/end_line to read a slice.',
    inputSchema: z.object({
      path: z.string(),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
    }),
    execute: async (args) => {
      const raw = await ctx.sandboxExecutor.readFile(args.path);
      const allLines = raw.split('\n');
      // If the file ends with \n, split yields a trailing empty string; drop it
      // so `total_lines` matches what users expect.
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
        allLines.pop();
      }
      const total = allLines.length;

      const startIdx = args.start_line ? Math.max(1, args.start_line) : 1;
      const endIdx = args.end_line ? Math.min(total, args.end_line) : total;
      const sliced = allLines.slice(startIdx - 1, endIdx);

      let truncated = false;
      const capped: string[] = [];
      let byteCount = 0;
      for (let i = 0; i < sliced.length && i < MAX_LINES; i += 1) {
        const line = sliced[i] ?? '';
        const prefixed = `${startIdx + i}\t${line}`;
        const bytes = Buffer.byteLength(prefixed, 'utf8') + 1;
        if (byteCount + bytes > MAX_BYTES) {
          truncated = true;
          break;
        }
        capped.push(prefixed);
        byteCount += bytes;
      }
      if (sliced.length > MAX_LINES) truncated = true;

      return {
        content: capped.join('\n'),
        total_lines: total,
        truncated,
      };
    },
  });
}
