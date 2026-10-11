import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { PromptStyle } from './types';

/** Lines of `MEMORY.md` a session loads into its system prompt. */
export const MEMORY_INDEX_LINES = 200;
export const MEMORY_INDEX_FILE = 'MEMORY.md';

/**
 * The main working tree of the repository a `.git` file belongs to. A linked
 * worktree's `.git` is a file that points into `<main>/.git/worktrees/<name>`,
 * and that directory's `commondir` leads back to `<main>/.git`.
 */
function mainWorktreeOf(gitFile: string, worktree: string): string {
  try {
    const pointer = readFileSync(gitFile, 'utf8')
      .match(/^gitdir: (.+)$/m)?.[1]
      ?.trim();
    if (!pointer) return worktree;
    const gitDirectory = isAbsolute(pointer) ? pointer : resolve(worktree, pointer);
    const common = readFileSync(join(gitDirectory, 'commondir'), 'utf8').trim();
    return dirname(resolve(gitDirectory, common));
  } catch {
    // A submodule's `.git` file has no `commondir`: it is its own project.
    return worktree;
  }
}

/**
 * The directory a project's memory belongs to: the main working tree of the
 * repository that holds `cwd`, so that every worktree of one repository
 * shares one memory; `cwd` itself outside a repository.
 */
export function resolveProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  for (let directory = start; ; directory = dirname(directory)) {
    const git = join(directory, '.git');
    try {
      const entry = statSync(git);
      if (entry.isDirectory()) return directory;
      if (entry.isFile()) return mainWorktreeOf(git, directory);
    } catch {
      // no .git here
    }
    if (dirname(directory) === directory) return start;
  }
}

/** A directory name a person can match to the project: its path with dashes for separators. */
export function projectIdFor(projectRoot: string): string {
  return resolve(projectRoot).split(sep).join('-').replaceAll(':', '');
}

export function projectMemoryDir(cwd: string, home = homedir()): string {
  return join(home, '.chimera', 'projects', projectIdFor(resolveProjectRoot(cwd)), 'memory');
}

export interface MemoryIndex {
  /** The first lines of `MEMORY.md`. */
  text: string;
  /** Lines of the file after those. */
  omittedLines: number;
}

/** The start of a project's memory index, or null when nothing was saved yet. */
export function readMemoryIndex(memoryDirectory: string): MemoryIndex | null {
  let raw: string;
  try {
    raw = readFileSync(join(memoryDirectory, MEMORY_INDEX_FILE), 'utf8');
  } catch {
    return null;
  }
  const lines = raw.trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') return null;
  return {
    text: lines.slice(0, MEMORY_INDEX_LINES).join('\n'),
    omittedLines: Math.max(0, lines.length - MEMORY_INDEX_LINES),
  };
}

export interface MemorySectionInput {
  directory: string;
  index: MemoryIndex | null;
  /**
   * `write`: a top-level session. `read`: a subagent. `none`: the file tools
   * cannot reach the directory (a Docker sandbox), so only the index helps.
   */
  access: 'write' | 'read' | 'none';
  promptStyle: PromptStyle;
}

const LAYOUT = `Each memory is one file in that directory, named for its topic (\`testing.md\`), holding one fact and why it matters. Each file has one line in \`${MEMORY_INDEX_FILE}\`: \`- [Title](file.md) — what it is about\`. Update a file that already covers the topic instead of adding a second one, and delete a memory that turned out to be wrong.`;

const SAVE_WHEN_LEAN = `Save a memory when the user states a lasting preference, corrects your approach in a way that will matter again, or tells you a fact about the project that the repository does not record. Do not save what the code, the git history or the instruction files already say, and do not save what matters only to the task in progress.`;

const SAVE_WHEN_GUIDED =
  'Save a memory only when the user asks you to remember something. Do not save anything on your own.';

/**
 * The system prompt's project memory section. It is composed when the
 * session starts and at a reload; a memory saved in between does not change
 * it, so the provider's cache of the conversation holds.
 */
export function renderMemorySection(input: MemorySectionInput): string {
  const { directory, index, access, promptStyle } = input;
  const lines = [
    '# Project memory',
    '',
    `Facts from earlier sessions in this project are kept in \`${directory}\`. A memory says what was true when it was written; check it against the repository before you rely on it.`,
    '',
  ];
  if (access === 'write') {
    lines.push(
      'Read a memory file when its index line is relevant to the task.',
      promptStyle === 'guided' ? SAVE_WHEN_GUIDED : SAVE_WHEN_LEAN,
      LAYOUT,
    );
  } else if (access === 'read') {
    lines.push(
      'Read a memory file when its index line is relevant to the task. The memory is read-only for you: do not write to it.',
    );
  } else {
    lines.push(
      'The memory files cannot be reached from this session, which runs in a sandbox. Use what the index below says, and do not try to read or write them.',
    );
  }
  lines.push('', `## ${MEMORY_INDEX_FILE}`, '');
  if (index === null) {
    lines.push('Nothing is saved yet.');
  } else {
    lines.push(index.text);
    if (index.omittedLines > 0) {
      lines.push(
        '',
        `[The index has ${index.omittedLines} more lines that are not shown. Read ${MEMORY_INDEX_FILE} for the rest, and shorten it when you next edit it.]`,
      );
    }
  }
  return lines.join('\n');
}
