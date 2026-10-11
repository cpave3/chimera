import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { relPath } from './format';

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const END_OF_FILE = '*** End of File';

interface HunkLine {
  kind: 'context' | 'remove' | 'add';
  text: string;
}

interface Hunk {
  /** Text after `@@`: a line (class or function header) the hunk sits below. */
  header: string;
  lines: HunkLine[];
  endOfFile: boolean;
}

/** The lines a hunk expects to find in the file: its context and removals. */
function oldLinesOf(lines: HunkLine[]): string[] {
  return lines.filter((line) => line.kind !== 'add').map((line) => line.text);
}

type PatchOperation =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] };

export type MatchLevel = 'exact' | 'trailing-whitespace' | 'any-whitespace';

export interface PatchedFile {
  path: string;
  operation: 'added' | 'updated' | 'deleted' | 'moved';
  movedTo?: string;
  additions: number;
  deletions: number;
  /** Present when a hunk only matched after whitespace was ignored. */
  matched?: MatchLevel;
}

export interface ApplyPatchResult {
  files: PatchedFile[];
  diagnostics?: string;
}

export class PatchError extends Error {}

/**
 * Parse the Codex patch envelope. Strict about the closing `*** End Patch`:
 * a patch cut off by the model's output limit must not be applied.
 */
export function parsePatch(text: string): PatchOperation[] {
  const lines = unwrap(text.replace(/\r\n/g, '\n').split('\n'));
  if (lines[0] !== BEGIN) {
    throw new PatchError(`The patch must start with "${BEGIN}".`);
  }
  if (lines.at(-1) !== END) {
    throw new PatchError(
      `The patch must end with "${END}". It looks cut off; send the whole patch again.`,
    );
  }

  const operations: PatchOperation[] = [];
  let index = 1;
  const last = lines.length - 1;
  while (index < last) {
    const line = lines[index]!;
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      const added: string[] = [];
      index += 1;
      while (index < last && !lines[index]!.startsWith('*** ')) {
        const content = lines[index]!;
        if (!content.startsWith('+')) {
          throw new PatchError(`${path}: every line of an added file must start with "+".`);
        }
        added.push(content.slice(1));
        index += 1;
      }
      operations.push({ kind: 'add', path, lines: added });
    } else if (line.startsWith(DELETE)) {
      operations.push({ kind: 'delete', path: line.slice(DELETE.length).trim() });
      index += 1;
    } else if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      index += 1;
      let moveTo: string | undefined;
      if (index < last && lines[index]!.startsWith(MOVE)) {
        moveTo = lines[index]!.slice(MOVE.length).trim();
        index += 1;
      }
      const hunks: Hunk[] = [];
      let hunk: Hunk | undefined;
      while (index < last && !isFileHeader(lines[index]!)) {
        const content = lines[index]!;
        index += 1;
        if (content.startsWith('@@')) {
          hunk = { header: content.slice(2).trim(), lines: [], endOfFile: false };
          hunks.push(hunk);
          continue;
        }
        if (!hunk) {
          // The first hunk may omit its `@@` line.
          hunk = { header: '', lines: [], endOfFile: false };
          hunks.push(hunk);
        }
        if (content === END_OF_FILE) {
          hunk.endOfFile = true;
        } else if (content.startsWith('+')) {
          hunk.lines.push({ kind: 'add', text: content.slice(1) });
        } else if (content.startsWith('-')) {
          hunk.lines.push({ kind: 'remove', text: content.slice(1) });
        } else if (content.startsWith(' ') || content === '') {
          // A bare empty line is an empty context line whose leading space was dropped.
          hunk.lines.push({ kind: 'context', text: content.slice(1) });
        } else {
          throw new PatchError(
            `${path}: a hunk line must start with " ", "+" or "-". Got: ${JSON.stringify(content)}`,
          );
        }
      }
      if (hunks.length === 0 && !moveTo) {
        throw new PatchError(`${path}: the update has no changes.`);
      }
      operations.push({ kind: 'update', path, moveTo, hunks });
    } else if (line.trim() === '') {
      index += 1;
    } else {
      throw new PatchError(
        `Expected "${ADD.trim()}", "${DELETE.trim()}" or "${UPDATE.trim()}". Got: ${JSON.stringify(line)}`,
      );
    }
  }
  if (operations.length === 0) throw new PatchError('The patch has no file sections.');
  return operations;
}

function isFileHeader(line: string): boolean {
  return line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE);
}

/** Drop blank padding, a markdown fence, or a shell heredoc around the patch. */
function unwrap(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start += 1;
  while (end > start && lines[end - 1]!.trim() === '') end -= 1;
  const first = lines[start]?.trim() ?? '';
  if (first.startsWith('```') || /^apply_patch\s+<<\s*['"]?\w+['"]?$/.test(first)) {
    start += 1;
    end -= 1;
  }
  return lines.slice(start, end).map((line) => (isMarker(line.trim()) ? line.trim() : line));
}

function isMarker(line: string): boolean {
  return line === BEGIN || line === END || line === END_OF_FILE || isFileHeader(line);
}

const MATCHERS: Array<{ level: MatchLevel; same: (a: string, b: string) => boolean }> = [
  { level: 'exact', same: (a, b) => a === b },
  { level: 'trailing-whitespace', same: (a, b) => a.trimEnd() === b.trimEnd() },
  { level: 'any-whitespace', same: (a, b) => a.trim() === b.trim() },
];

function findMatches(
  lines: string[],
  wanted: string[],
  from: number,
  same: (a: string, b: string) => boolean,
): number[] {
  const starts: number[] = [];
  for (let start = from; start + wanted.length <= lines.length; start += 1) {
    if (wanted.every((line, offset) => same(lines[start + offset]!, line))) starts.push(start);
  }
  return starts;
}

/**
 * Apply an update's hunks to a file's text. Hunks are located by their old
 * lines, searching forward from the end of the previous hunk. A hunk with no
 * `@@` header must match exactly one place: silently taking the first of
 * several candidates is how a patch lands in the wrong function.
 */
export function applyHunks(
  original: string,
  hunks: Hunk[],
  path: string,
): { content: string; matched: MatchLevel } {
  const endsWithNewline = original.endsWith('\n');
  const lines = original.split('\n');
  if (endsWithNewline) lines.pop();
  let cursor = 0;
  let weakest = 0;

  for (const hunk of hunks) {
    if (hunk.header) {
      const anchor =
        findMatches(lines, [hunk.header], cursor, MATCHERS[0]!.same)[0] ??
        findMatches(lines, [hunk.header], cursor, MATCHERS[2]!.same)[0];
      if (anchor === undefined) {
        throw new PatchError(`${path}: the line after "@@" was not found: ${hunk.header}`);
      }
      cursor = anchor + 1;
    }

    if (hunk.lines.every((line) => line.kind === 'add')) {
      const at = hunk.header && !hunk.endOfFile ? cursor : lines.length;
      const addedLines = hunk.lines.map((line) => line.text);
      lines.splice(at, 0, ...addedLines);
      cursor = at + addedLines.length;
      continue;
    }

    const located = locate(lines, hunk, cursor, path);
    weakest = Math.max(weakest, located.levelIndex);
    // Context lines keep the file's own text: after a whitespace-tolerant
    // match, writing the patch's copy would re-indent lines nobody changed.
    const replacement: string[] = [];
    let fileIndex = located.start;
    for (const line of located.lines) {
      if (line.kind === 'add') {
        replacement.push(line.text);
        continue;
      }
      if (line.kind === 'context') replacement.push(lines[fileIndex]!);
      fileIndex += 1;
    }
    lines.splice(located.start, fileIndex - located.start, ...replacement);
    cursor = located.start + replacement.length;
  }

  return {
    content: lines.join('\n') + (endsWithNewline || original === '' ? '\n' : ''),
    matched: MATCHERS[weakest]!.level,
  };
}

function locate(
  lines: string[],
  hunk: Hunk,
  cursor: number,
  path: string,
): { start: number; levelIndex: number; lines: HunkLine[] } {
  // Models often end a hunk with a blank context line that the file does not
  // have (the file's final newline); retry without it before giving up.
  const variants = [hunk.lines];
  const lastLine = hunk.lines.at(-1);
  if (lastLine?.kind === 'context' && lastLine.text === '' && hunk.lines.length > 1) {
    variants.push(hunk.lines.slice(0, -1));
  }
  for (const variant of variants) {
    const wanted = oldLinesOf(variant);
    for (const [levelIndex, matcher] of MATCHERS.entries()) {
      const starts = findMatches(lines, wanted, cursor, matcher.same);
      if (starts.length === 0) continue;
      if (hunk.endOfFile) {
        return { start: starts.at(-1)!, levelIndex, lines: variant };
      }
      if (starts.length > 1 && !hunk.header) {
        throw new PatchError(
          `${path}: these lines match ${starts.length} places (lines ${starts
            .map((start) => start + 1)
            .join(', ')}). Add more context lines, or put the enclosing function or class ` +
            `after "@@" to say which one:\n${wanted.join('\n')}`,
        );
      }
      return { start: starts[0]!, levelIndex, lines: variant };
    }
  }
  throw new PatchError(
    `${path}: these lines were not found in the file. Read the file again and copy the ` +
      `context exactly:\n${oldLinesOf(hunk.lines).join('\n')}`,
  );
}

const APPLY_PATCH_SCHEMA = z.object({
  input: z.string().describe('The whole patch, from "*** Begin Patch" to "*** End Patch".'),
});
type ApplyPatchArgs = z.infer<typeof APPLY_PATCH_SCHEMA>;

const DESCRIPTION = `Edit files with a patch. One call can add, update, delete and move several files; either the whole patch applies or nothing changes.

*** Begin Patch
*** Add File: path/new.ts
+every line of the new file starts with a plus
*** Update File: path/existing.ts
*** Move to: path/renamed.ts
@@ optional: the function or class line the change sits under
 unchanged context line (starts with a space)
-line to remove
+line to add
*** Delete File: path/old.ts
*** End Patch

Rules: paths are relative to the working directory. Give about three unchanged lines of context around each change, copied exactly from the file. "*** Move to:" is optional and follows its "*** Update File:" line. Start a new "@@" for each separate place in a file.`;

interface PlannedChange {
  file: PatchedFile;
  /** Path whose previous state must come back on rollback. */
  path: string;
  before: string | null;
  after: string | null;
}

export function buildApplyPatchTool(ctx: ToolContext) {
  const executor = ctx.sandboxExecutor;
  const cwd = executor.cwd();

  const readIfExists = async (path: string): Promise<string | null> =>
    (await executor.stat(path)) ? executor.readFile(path) : null;

  const put = async (path: string, content: string | null): Promise<void> => {
    if (content === null) {
      if (await executor.stat(path)) await executor.removeFile(path);
    } else {
      await executor.writeFile(path, content);
    }
  };

  /** Read every target and compute every new content before touching the disk. */
  async function plan(operations: PatchOperation[]): Promise<PlannedChange[]> {
    const changes: PlannedChange[] = [];
    for (const operation of operations) {
      const before = await readIfExists(operation.path);
      if (operation.kind === 'add') {
        if (before !== null) {
          throw new PatchError(
            `${operation.path}: the file already exists. Use "*** Update File:" to change it.`,
          );
        }
        changes.push({
          file: {
            path: operation.path,
            operation: 'added',
            additions: operation.lines.length,
            deletions: 0,
          },
          path: operation.path,
          before,
          after: operation.lines.length > 0 ? `${operation.lines.join('\n')}\n` : '',
        });
        continue;
      }
      if (before === null) {
        throw new PatchError(`${operation.path}: the file does not exist.`);
      }
      if (operation.kind === 'delete') {
        changes.push({
          file: {
            path: operation.path,
            operation: 'deleted',
            additions: 0,
            deletions: countLines(before),
          },
          path: operation.path,
          before,
          after: null,
        });
        continue;
      }
      const applied = applyHunks(before, operation.hunks, operation.path);
      const file: PatchedFile = {
        path: operation.path,
        operation: operation.moveTo ? 'moved' : 'updated',
        ...(operation.moveTo ? { movedTo: operation.moveTo } : {}),
        additions: countKind(operation.hunks, 'add'),
        deletions: countKind(operation.hunks, 'remove'),
        ...(applied.matched !== 'exact' ? { matched: applied.matched } : {}),
      };
      if (operation.moveTo) {
        if ((await readIfExists(operation.moveTo)) !== null) {
          throw new PatchError(`${operation.moveTo}: the move target already exists.`);
        }
        changes.push({ file, path: operation.moveTo, before: null, after: applied.content });
        changes.push({ file, path: operation.path, before, after: null });
      } else {
        changes.push({ file, path: operation.path, before, after: applied.content });
      }
    }
    return changes;
  }

  return defineTool<ApplyPatchArgs, ApplyPatchResult>({
    description: DESCRIPTION,
    promptSnippet: 'Edit files with a patch: add, update, delete or move, several files per call.',
    inputSchema: APPLY_PATCH_SCHEMA,
    execute: async (args) => {
      const changes = await plan(parsePatch(args.input));
      const done: PlannedChange[] = [];
      try {
        for (const change of changes) {
          await put(change.path, change.after);
          done.push(change);
        }
      } catch (error) {
        for (const change of done.reverse()) {
          await put(change.path, change.before).catch(() => {});
        }
        throw new PatchError(`${(error as Error).message}. No file was changed by this patch.`);
      }

      const files = [...new Set(changes.map((change) => change.file))];
      const reports: string[] = [];
      for (const file of files) {
        if (file.operation === 'deleted') continue;
        const report = await ctx.diagnostics?.collect(file.movedTo ?? file.path);
        if (report) reports.push(report);
      }
      return { files, ...(reports.length > 0 ? { diagnostics: reports.join('\n') } : {}) };
    },
    formatScrollback: (args, result) => {
      if (!result) return { summary: summarizeTargets(args.input, cwd) };
      const additions = result.files.reduce((sum, file) => sum + file.additions, 0);
      const deletions = result.files.reduce((sum, file) => sum + file.deletions, 0);
      const target =
        result.files.length === 1
          ? relPath(result.files[0]!.movedTo ?? result.files[0]!.path, cwd)
          : `${result.files.length} files`;
      return { summary: `${target} (+${additions} −${deletions})` };
    },
  });
}

function countKind(hunks: Hunk[], kind: HunkLine['kind']): number {
  return hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.kind === kind).length,
    0,
  );
}

function countLines(content: string): number {
  if (content === '') return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

function summarizeTargets(input: string, cwd: string): string {
  const paths = input
    .split('\n')
    .map((line) => line.trim())
    .filter(isFileHeader)
    .map((line) => relPath(line.slice(line.indexOf(': ') + 2).trim(), cwd));
  if (paths.length === 0) return 'patch';
  return paths.length === 1 ? paths[0]! : `${paths.length} files`;
}
