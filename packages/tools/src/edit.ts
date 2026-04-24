import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './context';

export function buildEditTool(ctx: ToolContext) {
  return tool({
    description:
      'Exact-string replace in a file. Errors if old_string is not found, or is found more than once without replace_all=true. ' +
      'No regex — old_string and new_string are literal.',
    inputSchema: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    execute: async (args) => {
      const content = await ctx.sandboxExecutor.readFile(args.path);
      const count = countOccurrences(content, args.old_string);
      if (count === 0) {
        throw new Error('old_string not found');
      }
      if (count > 1 && !args.replace_all) {
        throw new Error(
          `old_string matches ${count} occurrences; pass replace_all=true or disambiguate`,
        );
      }
      const next = args.replace_all
        ? content.split(args.old_string).join(args.new_string)
        : content.replace(args.old_string, args.new_string);
      await ctx.sandboxExecutor.writeFile(args.path, next);
      return { replacements: count };
    },
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) return count;
    count += 1;
    idx = found + needle.length;
  }
}
