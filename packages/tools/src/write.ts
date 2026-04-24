import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './context';

export function buildWriteTool(ctx: ToolContext) {
  return tool({
    description:
      'Create or overwrite a file with the given content. Parent directories are created as needed. ' +
      'Refuses paths outside the working directory.',
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
    }),
    execute: async (args) => {
      const existing = await ctx.sandboxExecutor.stat(args.path);
      const created = !existing;
      await ctx.sandboxExecutor.writeFile(args.path, args.content);
      return {
        bytes_written: Buffer.byteLength(args.content, 'utf8'),
        created,
      };
    },
  });
}
