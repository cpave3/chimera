import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { blockedDirGlobs } from './search-config';

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
  no_blocklist: z
    .boolean()
    .optional()
    .describe('Disable the default directory blocklist (node_modules, dist, .git, etc.).'),
  output_file: z
    .string()
    .optional()
    .describe(
      'If results are truncated, write the full un-truncated list to this file path before returning.',
    ),
});
type GlobArgs = z.infer<typeof GLOB_SCHEMA>;
type GlobResult = { files: string[]; truncated: boolean; spillFile?: string };

export function buildGlobTool(ctx: ToolContext) {
  return defineTool<GlobArgs, GlobResult>({
    description:
      'List files matching a glob pattern, gitignore-aware. Use this to discover paths before reading files. ' +
      'Backed by ripgrep. Capped at 1000 files; refine the pattern if truncated.',
    inputSchema: GLOB_SCHEMA,
    execute: async (args, { abortSignal }) => {
      const searchPath = args.path && args.path.length > 0 ? args.path : '.';
      const blockFlags = blockedDirGlobs(args.no_blocklist)
        .map((g) => `--glob ${shellQuote(g)}`)
        .join(' ');
      const cmd = `rg --files --hidden --no-messages --glob ${shellQuote(args.pattern)} ${blockFlags} -- ${shellQuote(searchPath)}`;
      const result = await ctx.sandboxExecutor.exec(cmd, { signal: abortSignal, toolName: 'glob' });

      if (result.exitCode === 127) {
        throw new Error(
          'glob: ripgrep (`rg`) is not installed in the current execution environment. ' +
            'Install it (https://github.com/BurntSushi/ripgrep) and retry.',
        );
      }
      // rg exits 1 when no files match and 2 when there were suppressed
      // read errors (e.g. permission denied); neither is fatal for us.
      if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== 2) {
        const stderr = result.stderr.trim() || `exit ${result.exitCode}`;
        throw new Error(`glob: ${stderr}`);
      }

      const lines = result.stdout.split('\n').filter((line) => line.length > 0);
      const truncated = lines.length > MAX_FILES;
      if (truncated && args.output_file) {
        await ctx.sandboxExecutor.writeFile(args.output_file, lines.join('\n') + '\n');
      }
      const files = truncated ? lines.slice(0, MAX_FILES) : lines;
      return {
        files,
        truncated,
        spillFile: truncated && args.output_file ? args.output_file : undefined,
      };
    },
    formatScrollback: (args, result) => {
      const where = args.path ? ` in ${args.path}` : '';
      const head = `${args.pattern}${where}`;
      if (!result) return { summary: head };
      const tail = result.truncated
        ? ` (${result.files.length}+ files, truncated)`
        : ` (${result.files.length} files)`;
      if (result.spillFile)
        return { summary: `${head}${tail}`, detail: `Full results written to ${result.spillFile}` };
      return { summary: `${head}${tail}` };
    },
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
