import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { relPath } from './format';

const WRITE_SCHEMA = z.object({
  path: z.string(),
  content: z.string(),
});
type WriteArgs = z.infer<typeof WRITE_SCHEMA>;
type WriteResult = { bytes_written: number; created: boolean };

export function buildWriteTool(ctx: ToolContext) {
  const cwd = ctx.sandboxExecutor.cwd();
  return defineTool<WriteArgs, WriteResult>({
    description:
      'Create or overwrite a file with the given content. Parent directories are created as needed. ' +
      'Refuses paths outside the working directory.',
    inputSchema: WRITE_SCHEMA,
    execute: async (args) => {
      const existing = await ctx.sandboxExecutor.stat(args.path);
      const created = !existing;
      await ctx.sandboxExecutor.writeFile(args.path, args.content);
      return {
        bytes_written: Buffer.byteLength(args.content, 'utf8'),
        created,
      };
    },
    formatScrollback: (args, result) => {
      const head = relPath(args.path, cwd);
      if (!result) return { summary: head };
      const tag = result.created
        ? `(created, ${result.bytes_written} bytes)`
        : `(${result.bytes_written} bytes)`;
      return { summary: `${head} ${tag}` };
    },
  });
}
