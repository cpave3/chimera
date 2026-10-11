import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { describeMiss, locateTolerant, type MatchLevel } from './edit-match';
import { relPath } from './format';

const EDIT_SCHEMA = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
type EditArgs = z.infer<typeof EDIT_SCHEMA>;
/**
 * `startLine` and `contextBefore` come from the **pre-edit** file (so the TUI
 * can show what was replaced and where it lived); `contextAfter` comes from
 * the **post-edit** file (so the trailing context matches what's now on disk).
 */
type EditResult = {
  replacements: number;
  startLine: number;
  contextBefore: string[];
  contextAfter: string[];
  /** Present when old_string only matched after whitespace was ignored. */
  matched?: Exclude<MatchLevel, 'exact'>;
  diagnostics?: string;
};

const CONTEXT_LINES = 3;

export function buildEditTool(ctx: ToolContext) {
  const cwd = ctx.sandboxExecutor.cwd();
  return defineTool<EditArgs, EditResult>({
    description:
      'Exact-string replace in a file under the working directory or /tmp. Errors if old_string is not found, or is found more than once without replace_all=true. ' +
      'No regex — old_string and new_string are literal. If old_string differs from the file only in whitespace and matches one place, the edit still applies and the result says so.',
    promptSnippet: 'Replace an exact string in a file.',
    inputSchema: EDIT_SCHEMA,
    execute: async (args) => {
      const content = await ctx.sandboxExecutor.readFile(args.path);
      const count = countOccurrences(content, args.old_string);
      if (count > 1 && !args.replace_all) {
        throw new Error(
          `old_string matches ${count} occurrences; pass replace_all=true or disambiguate`,
        );
      }
      // An exact miss is usually whitespace: fall back to matching whole
      // lines with trailing whitespace, then indentation, ignored.
      const tolerant =
        count === 0 && !args.replace_all
          ? locateTolerant(content, args.old_string, args.new_string)
          : undefined;
      if (count === 0 && !tolerant) {
        throw new Error(describeMiss(content, args.old_string));
      }
      const matchIndex = tolerant ? tolerant.start : content.indexOf(args.old_string);
      const matchEnd = tolerant ? tolerant.end : matchIndex + args.old_string.length;
      const replacement = tolerant ? tolerant.replacement : args.new_string;
      const startLine = lineNumberAt(content, matchIndex);
      const contextBefore = linesAbove(content, matchIndex, CONTEXT_LINES);
      // String.prototype.replace expands $&, $`, $', $$ in the replacement string
      // even when the search argument is a string. That's a silent corruption hazard
      // when new_string contains shell regex anchors like '^foo$'.
      const next = args.replace_all
        ? content.split(args.old_string).join(args.new_string)
        : content.slice(0, matchIndex) + replacement + content.slice(matchEnd);
      await ctx.sandboxExecutor.writeFile(args.path, next);
      const afterEnd = matchIndex + replacement.length;
      const contextAfter = linesBelow(next, afterEnd, CONTEXT_LINES);
      const diagnostics = await ctx.diagnostics?.collect(args.path);
      return {
        replacements: tolerant ? 1 : count,
        startLine,
        contextBefore,
        contextAfter,
        ...(tolerant ? { matched: tolerant.level } : {}),
        ...(diagnostics ? { diagnostics } : {}),
      };
    },
    formatScrollback: (args, result) => {
      const head = relPath(args.path, cwd);
      if (!result) return { summary: head };
      const noun = result.replacements === 1 ? 'replacement' : 'replacements';
      const tolerance = result.matched ? ', matched ignoring whitespace' : '';
      return { summary: `${head} (${result.replacements} ${noun}${tolerance})` };
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

function lineNumberAt(content: string, byteOffset: number): number {
  let line = 1;
  for (let i = 0; i < byteOffset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function linesAbove(content: string, matchStart: number, count: number): string[] {
  if (matchStart === 0) return [];
  const prefix = content.slice(0, matchStart);
  const lines = prefix.split('\n');
  // The final element is the partial line where the match starts (everything
  // on the line before the match). Drop it; we want full lines preceding it.
  lines.pop();
  return lines.slice(Math.max(0, lines.length - count));
}

function linesBelow(content: string, afterEnd: number, count: number): string[] {
  if (afterEnd >= content.length) return [];
  // If the replaced span ended at a line boundary (because new_string ends
  // with `\n`, or the span was at offset 0), the next full line starts at
  // `afterEnd` itself. Otherwise we need to skip the remainder of the line
  // the span landed inside.
  const atLineStart = afterEnd === 0 || content.charCodeAt(afterEnd - 1) === 10;
  let rest: string;
  if (atLineStart) {
    rest = content.slice(afterEnd);
  } else {
    const suffix = content.slice(afterEnd);
    const newline = suffix.indexOf('\n');
    if (newline === -1) return [];
    rest = suffix.slice(newline + 1);
  }
  const stripped = rest.endsWith('\n') ? rest.slice(0, -1) : rest;
  if (stripped.length === 0) return [];
  return stripped.split('\n').slice(0, count);
}
