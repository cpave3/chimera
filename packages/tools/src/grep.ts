import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';

const DEFAULT_MAX_MATCHES = 200;
const HARD_MAX_MATCHES = 2000;

const GREP_SCHEMA = z.object({
  pattern: z.string().describe('Regex pattern to search for. Ripgrep regex syntax.'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search under. Defaults to the working directory.'),
  glob: z
    .string()
    .optional()
    .describe('Restrict search to files matching this glob, e.g. "*.ts" or "modules/**/*.php".'),
  case_insensitive: z.boolean().optional().describe('Match case-insensitively.'),
  files_with_matches: z
    .boolean()
    .optional()
    .describe('Return only file paths instead of matched lines.'),
  max_count: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Cap on results (lines or files). Default ${DEFAULT_MAX_MATCHES}, hard max ${HARD_MAX_MATCHES}.`),
});
type GrepArgs = z.infer<typeof GREP_SCHEMA>;
type GrepResult =
  | { mode: 'content'; matches: Array<{ file: string; line: number; text: string }>; truncated: boolean }
  | { mode: 'files'; files: string[]; truncated: boolean };

export function buildGrepTool(ctx: ToolContext) {
  return defineTool<GrepArgs, GrepResult>({
    description:
      'Search file contents with a regex, gitignore-aware. Returns matched lines (default) or just file paths ' +
      "(set files_with_matches=true). Backed by ripgrep. Cap results with max_count to avoid context blowups.",
    inputSchema: GREP_SCHEMA,
    execute: async (args, { abortSignal }) => {
      const limit = Math.min(args.max_count ?? DEFAULT_MAX_MATCHES, HARD_MAX_MATCHES);
      const flags: string[] = ['--hidden'];
      if (args.case_insensitive) flags.push('-i');
      if (args.glob) flags.push('--glob', shellQuote(args.glob));
      if (args.files_with_matches) {
        flags.push('-l');
      } else {
        flags.push('--line-number', '--no-heading', '--color', 'never');
      }
      const searchPath = args.path && args.path.length > 0 ? args.path : '.';
      const cmd = `rg ${flags.join(' ')} -e ${shellQuote(args.pattern)} -- ${shellQuote(searchPath)}`;
      const result = await ctx.sandboxExecutor.exec(cmd, { signal: abortSignal });

      if (result.exitCode === 127) {
        throw new Error(
          'grep: ripgrep (`rg`) is not installed in the current execution environment. ' +
            'Install it (https://github.com/BurntSushi/ripgrep) and retry.',
        );
      }
      // rg exits 1 when no matches; that's not an error.
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        const stderr = result.stderr.trim() || `exit ${result.exitCode}`;
        throw new Error(`grep: ${stderr}`);
      }

      const lines = result.stdout.split('\n').filter((line) => line.length > 0);

      if (args.files_with_matches) {
        const truncated = lines.length > limit;
        return { mode: 'files', files: truncated ? lines.slice(0, limit) : lines, truncated };
      }

      const matches: Array<{ file: string; line: number; text: string }> = [];
      let truncated = false;
      for (const raw of lines) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        const parsed = parseRgLine(raw);
        if (parsed) matches.push(parsed);
      }
      return { mode: 'content', matches, truncated };
    },
    formatScrollback: (args, result) => {
      const where = args.path ? ` in ${args.path}` : '';
      const filter = args.glob ? ` (${args.glob})` : '';
      const head = `${args.pattern}${where}${filter}`;
      if (!result) return { summary: head };
      if (result.mode === 'files') {
        const tail = result.truncated
          ? ` (${result.files.length}+ files, truncated)`
          : ` (${result.files.length} files)`;
        return { summary: `${head}${tail}` };
      }
      const tail = result.truncated
        ? ` (${result.matches.length}+ matches, truncated)`
        : ` (${result.matches.length} matches)`;
      return { summary: `${head}${tail}` };
    },
  });
}

function parseRgLine(line: string): { file: string; line: number; text: string } | null {
  // rg with --line-number --no-heading prints `path:lineno:content`. The path
  // can contain colons on exotic filesystems, but ripgrep itself never quotes
  // them, so the safest split is "first two colons from the left".
  const firstColon = line.indexOf(':');
  if (firstColon < 0) return null;
  const secondColon = line.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  const file = line.slice(0, firstColon);
  const lineNumStr = line.slice(firstColon + 1, secondColon);
  const lineNum = Number.parseInt(lineNumStr, 10);
  if (!Number.isFinite(lineNum)) return null;
  const text = line.slice(secondColon + 1);
  return { file, line: lineNum, text };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
