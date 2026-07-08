import { z } from 'zod';
import { defineTool } from './define';
import type { ChimeraToolDef } from './types';

const CODEX_BASH_SCHEMA = z.object({
  command: z.string().describe('Bash command to execute.'),
  timeout: z.number().positive().optional().describe('Timeout in seconds.'),
});

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

export function buildCodexToolDefs(
  nativeDefs: Record<string, ChimeraToolDef<any, any>>,
): Record<string, ChimeraToolDef<any, any>> {
  const bash = executable(nativeDefs.bash);
  const grep = executable(nativeDefs.grep);
  const glob = executable(nativeDefs.glob);
  const read = executable(nativeDefs.read);

  return {
    read: nativeDefs.read,
    bash: defineTool({
      description: 'Execute a bash command and return stdout, stderr, exit code, and timeout status.',
      inputSchema: CODEX_BASH_SCHEMA,
      execute: async (args: { command: string; timeout?: number }, opts) => {
        return bash.execute(
          {
            command: args.command,
            ...(args.timeout !== undefined ? { timeout_ms: Math.ceil(args.timeout * 1000) } : {}),
          },
          opts,
        );
      },
      formatScrollback: nativeDefs.bash.formatScrollback
        ? (args: { command: string; timeout?: number }, result?: unknown) =>
            nativeDefs.bash.formatScrollback?.(
              {
                command: args.command,
                ...(args.timeout !== undefined ? { timeout_ms: Math.ceil(args.timeout * 1000) } : {}),
              },
              result,
            ) ?? { summary: args.command }
        : undefined,
    }),
    edit: nativeDefs.edit,
    write: nativeDefs.write,
    grep: defineTool({
      description:
        'Search file contents for a pattern. Returns matching lines with file paths and line numbers.',
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
        ? (args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean }, result?: unknown) =>
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
      description: 'List directory contents. Returns entries sorted alphabetically with / suffixes for directories.',
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
      formatScrollback: (args: { path?: string }, result?: { entries?: string[]; truncated?: boolean }) => {
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
