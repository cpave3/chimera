import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';

const MAX_FILES = 1000;

const GLOB_SCHEMA = z.object({
  pattern: z
    .string()
    .describe(
      'Glob pattern, e.g. "**/*.ts", "modules/**/*.php", "src/**/Foo*". Standard glob syntax.',
    ),
  path: z
    .string()
    .optional()
    .describe('Subdirectory to search under (relative to cwd). Defaults to the working directory.'),
});
type GlobArgs = z.infer<typeof GLOB_SCHEMA>;
type GlobResult = { files: string[]; truncated: boolean };

export function buildGlobTool(ctx: ToolContext) {
  return defineTool<GlobArgs, GlobResult>({
    description:
      'List files matching a glob pattern, gitignore-aware. Use this to discover paths before reading files. ' +
      'Backed by ripgrep. Capped at 1000 files; refine the pattern if truncated.',
    inputSchema: GLOB_SCHEMA,
    execute: async (args, { abortSignal }) => {
      const searchPath = args.path && args.path.length > 0 ? args.path : '.';
      const cmd = `rg --files --hidden --glob ${shellQuote(args.pattern)} -- ${shellQuote(searchPath)}`;
      const result = await ctx.sandboxExecutor.exec(cmd, { signal: abortSignal });

      if (result.exitCode === 127) {
        throw new Error(
          'glob: ripgrep (`rg`) is not installed in the current execution environment. ' +
            'Install it (https://github.com/BurntSushi/ripgrep) and retry.',
        );
      }
      // rg exits 1 when no files match; that's not an error for us.
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        const stderr = result.stderr.trim() || `exit ${result.exitCode}`;
        throw new Error(`glob: ${stderr}`);
      }

      const lines = result.stdout.split('\n').filter((line) => line.length > 0);
      const truncated = lines.length > MAX_FILES;
      const files = truncated ? lines.slice(0, MAX_FILES) : lines;
      return { files, truncated };
    },
    formatScrollback: (args, result) => {
      const where = args.path ? ` in ${args.path}` : '';
      const head = `${args.pattern}${where}`;
      if (!result) return { summary: head };
      const tail = result.truncated
        ? ` (${result.files.length}+ files, truncated)`
        : ` (${result.files.length} files)`;
      return { summary: `${head}${tail}` };
    },
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
