import { z } from 'zod';
import { defineTool } from './define';
import type { ChimeraToolDef } from './types';

const CODEX_BASH_SCHEMA = z.object({
  command: z.string().describe('Bash command to execute.'),
  timeout: z.number().positive().optional().describe('Timeout in seconds.'),
  target: z
    .enum(['sandbox', 'host'])
    .optional()
    .describe("Which executor to use. Defaults to 'host' when sandbox is off."),
  reason: z
    .string()
    .optional()
    .describe('Short justification for running on the host or outside the OS sandbox.'),
  unsandboxed: z
    .boolean()
    .optional()
    .describe(
      'Run outside the OS sandbox. Requires a reason and user approval or an explicit saved bypass permission.',
    ),
});

const CODEX_BACKGROUND_BASH_SCHEMA = CODEX_BASH_SCHEMA.extend({
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Run the command as a background process and return a shell_id immediately. ' +
        'Poll output with bash_output; terminate with bash_kill.',
    ),
});

type CodexBashArgs = z.infer<typeof CODEX_BACKGROUND_BASH_SCHEMA>;

function toNativeBashArgs(args: CodexBashArgs) {
  return {
    command: args.command,
    ...(args.target !== undefined ? { target: args.target } : {}),
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
    ...(args.unsandboxed !== undefined ? { unsandboxed: args.unsandboxed } : {}),
    ...(args.timeout !== undefined ? { timeout_ms: Math.ceil(args.timeout * 1000) } : {}),
    ...(args.run_in_background ? { run_in_background: true } : {}),
  };
}

const CODEX_GREP_SCHEMA = z.object({
  pattern: z.string().describe('Search pattern.'),
  path: z.string().optional().describe('Directory or file to search. Defaults to cwd.'),
  glob: z.string().optional().describe('Filter files by glob pattern.'),
  ignoreCase: z.boolean().optional().describe('Case-insensitive search.'),
  literal: z.boolean().optional().describe('Treat pattern as a literal string.'),
  context: z.number().optional().describe('Accepted for Codex compatibility; ignored by Chimera.'),
  limit: z.number().int().positive().optional().describe('Maximum number of matches to return.'),
});

const CODEX_FIND_SCHEMA = z.object({
  pattern: z.string().describe('Glob pattern to match files.'),
  path: z.string().optional().describe('Directory to search in. Defaults to cwd.'),
  limit: z.number().int().positive().optional().describe('Accepted for Codex compatibility.'),
});

const CODEX_LS_SCHEMA = z.object({
  path: z.string().optional().describe('Directory to list. Defaults to cwd.'),
  limit: z.number().int().positive().optional().describe('Maximum number of entries to return.'),
});

type ExecutableTool = { execute: (args: unknown, opts?: unknown) => Promise<unknown> };

function executable(def: ChimeraToolDef<any, any>): ExecutableTool {
  return def.tool as unknown as ExecutableTool;
}

/**
 * Re-key the native tool definitions for models that expect Codex-style tool
 * names and argument schemas. Only `bash`, `grep` and `glob` (as `find`) are
 * reshaped, and `ls` is added; every other native tool passes through
 * unchanged, so a codex-shape session has the same capabilities.
 */
export function buildCodexToolDefs(
  nativeDefs: Record<string, ChimeraToolDef<any, any>>,
): Record<string, ChimeraToolDef<any, any>> {
  const bash = executable(nativeDefs.bash);
  const grep = executable(nativeDefs.grep);
  const glob = executable(nativeDefs.glob);
  const read = executable(nativeDefs.read);
  const { glob: _glob, ...passThrough } = nativeDefs;

  return {
    ...passThrough,
    bash: defineTool({
      description: nativeDefs.bash.tool.description!,
      promptSnippet: nativeDefs.bash.promptSnippet,
      inputSchema: nativeDefs.bash_output ? CODEX_BACKGROUND_BASH_SCHEMA : CODEX_BASH_SCHEMA,
      execute: async (args: CodexBashArgs, opts) => bash.execute(toNativeBashArgs(args), opts),
      formatScrollback: nativeDefs.bash.formatScrollback
        ? (args: CodexBashArgs, result?: unknown) =>
            nativeDefs.bash.formatScrollback?.(toNativeBashArgs(args), result) ?? {
              summary: args.command,
            }
        : undefined,
    }),
    grep: defineTool({
      description:
        'Search file contents for a pattern. Returns matching lines with file paths and line numbers.',
      promptSnippet: nativeDefs.grep.promptSnippet,
      inputSchema: CODEX_GREP_SCHEMA,
      execute: async (
        args: {
          pattern: string;
          path?: string;
          glob?: string;
          ignoreCase?: boolean;
          literal?: boolean;
          context?: number;
          limit?: number;
        },
        opts,
      ) => {
        const pattern = args.literal ? escapeRegex(args.pattern) : args.pattern;
        return grep.execute(
          {
            pattern,
            path: args.path,
            glob: args.glob,
            case_insensitive: args.ignoreCase,
            max_count: args.limit,
          },
          opts,
        );
      },
      formatScrollback: nativeDefs.grep.formatScrollback
        ? (
            args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean },
            result?: unknown,
          ) =>
            nativeDefs.grep.formatScrollback?.(
              {
                pattern: args.pattern,
                path: args.path,
                glob: args.glob,
                case_insensitive: args.ignoreCase,
              },
              result,
            ) ?? { summary: args.pattern }
        : undefined,
    }),
    find: defineTool({
      description: 'Search for files by glob pattern. Returns matching file paths.',
      promptSnippet: nativeDefs.glob.promptSnippet,
      inputSchema: CODEX_FIND_SCHEMA,
      execute: async (args: { pattern: string; path?: string; limit?: number }, opts) => {
        const result = (await glob.execute({ pattern: args.pattern, path: args.path }, opts)) as {
          files: string[];
          truncated: boolean;
        };
        if (args.limit !== undefined && result.files.length > args.limit) {
          return {
            files: result.files.slice(0, args.limit),
            truncated: true,
          };
        }
        return result;
      },
      formatScrollback: nativeDefs.glob.formatScrollback
        ? (args: { pattern: string; path?: string }, result?: unknown) =>
            nativeDefs.glob.formatScrollback?.(args, result) ?? { summary: args.pattern }
        : undefined,
    }),
    ls: defineTool({
      description:
        'List directory contents. Returns entries sorted alphabetically with / suffixes for directories.',
      promptSnippet: 'List a directory.',
      inputSchema: CODEX_LS_SCHEMA,
      execute: async (args: { path?: string; limit?: number }, opts) => {
        const result = (await read.execute({ path: args.path ?? '.' }, opts)) as {
          kind: string;
          entries?: Array<{ name: string; isDir: boolean }>;
          truncated?: boolean;
        };
        if (result.kind !== 'directory') {
          throw new Error(`Not a directory: ${args.path ?? '.'}`);
        }
        const formatted = (result.entries ?? []).map((entry) =>
          entry.isDir ? `${entry.name}/` : entry.name,
        );
        const limited =
          args.limit !== undefined && formatted.length > args.limit
            ? formatted.slice(0, args.limit)
            : formatted;
        return {
          entries: limited,
          truncated: Boolean(result.truncated) || limited.length < formatted.length,
        };
      },
      formatScrollback: (
        args: { path?: string },
        result?: { entries?: string[]; truncated?: boolean },
      ) => {
        const path = args.path ?? '.';
        if (!result) return { summary: path };
        const suffix = result.truncated
          ? ` (${result.entries?.length ?? 0}+ entries, truncated)`
          : ` (${result.entries?.length ?? 0} entries)`;
        return { summary: `${path}${suffix}` };
      },
    }),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
