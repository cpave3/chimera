import { execFile } from 'node:child_process';

export interface WorktreeFile {
  path: string;
  /** Modified, added (or untracked), deleted, renamed, unmerged. */
  status: 'M' | 'A' | 'D' | 'R' | 'U';
  /** Lines against HEAD; absent for binary, untracked and renamed files. */
  added?: number;
  removed?: number;
}

export interface WorktreeStatus {
  /** The branch, or the short commit of a detached head. */
  branch: string;
  ahead: number;
  behind: number;
  files: WorktreeFile[];
}

const SHORT_COMMIT_LENGTH = 7;
// Fields before the path of an ordinary, a renamed and an unmerged entry.
const ORDINARY_FIELDS = 8;
const RENAMED_FIELDS = 9;
const UNMERGED_FIELDS = 10;

function pathAfter(line: string, fields: number): string {
  let position = 0;
  for (let field = 0; field < fields; field += 1) position = line.indexOf(' ', position) + 1;
  return line.slice(position);
}

function statusOf(code: string): WorktreeFile['status'] {
  if (code.includes('R')) return 'R';
  if (code.includes('A')) return 'A';
  if (code.includes('D')) return 'D';
  return 'M';
}

/**
 * Fold `git status --porcelain=v2 --branch` and `git diff --numstat HEAD`
 * into what the context panel shows.
 */
export function parseWorktree(status: string, numstat: string): WorktreeStatus {
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of numstat.split('\n')) {
    const [added, removed, ...path] = line.split('\t');
    if (!added || !removed || path.length === 0 || added === '-') continue;
    counts.set(path.join('\t'), { added: Number(added), removed: Number(removed) });
  }

  let branch = '';
  let commit = '';
  let ahead = 0;
  let behind = 0;
  const files: WorktreeFile[] = [];
  const add = (path: string, fileStatus: WorktreeFile['status']) => {
    files.push({ path, status: fileStatus, ...counts.get(path) });
  };
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length);
    else if (line.startsWith('# branch.oid ')) commit = line.slice('# branch.oid '.length);
    else if (line.startsWith('# branch.ab ')) {
      const [aheadField, behindField] = line.slice('# branch.ab '.length).split(' ');
      ahead = Math.abs(Number(aheadField));
      behind = Math.abs(Number(behindField));
    } else if (line.startsWith('1 '))
      add(pathAfter(line, ORDINARY_FIELDS), statusOf(line.slice(2, 4)));
    else if (line.startsWith('2 ')) add(pathAfter(line, RENAMED_FIELDS).split('\t')[0]!, 'R');
    else if (line.startsWith('u ')) add(pathAfter(line, UNMERGED_FIELDS), 'U');
    else if (line.startsWith('? ')) add(line.slice(2), 'A');
  }
  if (branch === '(detached)') branch = commit.slice(0, SHORT_COMMIT_LENGTH);
  return { branch, ahead, behind, files };
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** The working tree of `cwd`, or null when `cwd` is not in a git repository. */
export async function readWorktree(cwd: string): Promise<WorktreeStatus | null> {
  const [status, numstat] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2', '--branch']),
    // Fails before the first commit; the files then show without counts.
    git(cwd, ['diff', '--numstat', 'HEAD']),
  ]);
  if (status === null) return null;
  return parseWorktree(status, numstat ?? '');
}
