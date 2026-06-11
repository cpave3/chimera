import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { blockedDirGlobs } from './search-config';

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
    .describe(
      `Cap on results (lines or files). Default ${DEFAULT_MAX_MATCHES}, hard max ${HARD_MAX_MATCHES}.`,
    ),
  no_blocklist: z
    .boolean()
    .optional()
    .describe('Disable the default directory blocklist (node_modules, dist, .git, etc.).'),
  output_file: z
    .string()
    .optional()
    .describe(
      'If results are truncated, write the full un-truncated results to this file path before returning.',
    ),
});
type GrepArgs = z.infer<typeof GREP_SCHEMA>;
type GrepResult =
  | {
      mode: 'content';
      matches: Array<{ file: string; line: number; text: string }>;
      truncated: boolean;
      spillFile?: string;
    }
  | { mode: 'files'; files: string[]; truncated: boolean; spillFile?: string };

export function buildGrepTool(ctx: ToolContext) {
  return defineTool<GrepArgs, GrepResult>({
    description:
      'Search file contents with a regex, gitignore-aware. Returns matched lines (default) or just file paths ' +
      '(set files_with_matches=true). Backed by ripgrep. Cap results with max_count to avoid context blowups.',
    inputSchema: GREP_SCHEMA,
    execute: async (args, { abortSignal }) => {
      const limit = Math.min(args.max_count ?? DEFAULT_MAX_MATCHES, HARD_MAX_MATCHES);

      const makeFlags = (capped: boolean): string[] => {
        const flags: string[] = ['--hidden', '--no-messages'];
        if (args.case_insensitive) flags.push('-i');
        if (args.glob) flags.push('--glob', shellQuote(args.glob));
        for (const blockedGlob of blockedDirGlobs(args.no_blocklist)) {
          flags.push('--glob', shellQuote(blockedGlob));
        }
        if (args.files_with_matches) {
          flags.push('-l');
        } else {
          flags.push('--line-number', '--no-heading', '--color', 'never');
          if (capped) {
            flags.push('-m', String(limit + 1));
          }
        }
        return flags;
      };

      const searchPath = args.path && args.path.length > 0 ? args.path : '.';
      const runRg = async (flags: string[]) => {
        const cmd = `rg ${flags.join(' ')} -e ${shellQuote(args.pattern)} -- ${shellQuote(searchPath)}`;
        const res = await ctx.sandboxExecutor.exec(cmd, { signal: abortSignal, toolName: 'grep' });
        if (res.exitCode === 127) {
          throw new Error(
            'grep: ripgrep (`rg`) is not installed in the current execution environment. ' +
              'Install it (https://github.com/BurntSushi/ripgrep) and retry.',
          );
        }
        if (res.exitCode !== 0 && res.exitCode !== 1 && res.exitCode !== 2) {
          const stderr = res.stderr.trim() || `exit ${res.exitCode}`;
          throw new Error(`grep: ${stderr}`);
        }
        return res.stdout;
      };

      const boundedStdout = await runRg(makeFlags(true));
      const lines = boundedStdout.split('\n').filter((line) => line.length > 0);

      if (args.files_with_matches) {
        const truncated = lines.length > limit;
        if (truncated && args.output_file) {
          const full = await runRg(makeFlags(false));
          await ctx.sandboxExecutor.writeFile(args.output_file, full);
        }
        return {
          mode: 'files',
          files: truncated ? lines.slice(0, limit) : lines,
          truncated,
          spillFile: truncated && args.output_file ? args.output_file : undefined,
        };
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
      if (truncated && args.output_file) {
        const full = await runRg(makeFlags(false));
        await ctx.sandboxExecutor.writeFile(args.output_file, full);
      }
      return {
        mode: 'content',
        matches,
        truncated,
        spillFile: truncated && args.output_file ? args.output_file : undefined,
      };
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
        if (result.spillFile)
          return {
            summary: `${head}${tail}`,
            detail: `Full results written to ${result.spillFile}`,
          };
        return { summary: `${head}${tail}` };
      }
      const tail = result.truncated
        ? ` (${result.matches.length}+ matches, truncated)`
        : ` (${result.matches.length} matches)`;
      if (result.spillFile)
        return { summary: `${head}${tail}`, detail: `Full results written to ${result.spillFile}` };
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
