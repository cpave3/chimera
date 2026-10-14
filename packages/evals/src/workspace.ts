import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Directories that the harness, git or chimera write, and no task owns. */
const IGNORED_DIRECTORIES = new Set(['.git', '.chimera', 'node_modules', '.eval-check']);

export type WorkspaceFiles = Record<string, string>;

/**
 * Writes the files to a new directory under `parentDir` and commits them, so
 * the agent starts in a clean git repository, as it would in a real project.
 */
export function createWorkspace(files: WorkspaceFiles, parentDir: string): string {
  const workspace = mkdtempSync(join(parentDir, 'workspace-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(workspace, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git(
    '-c',
    'user.name=Chimera Evals',
    '-c',
    'user.email=evals@chimera.invalid',
    'commit',
    '--quiet',
    '--message',
    'Initial commit',
  );
  return workspace;
}

/** The text files of a workspace, by path relative to it. */
export function readWorkspace(workspace: string): WorkspaceFiles {
  const files: WorkspaceFiles = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(path);
      } else if (entry.isFile()) {
        files[relative(workspace, path)] = readFileSync(path, 'utf8');
      }
    }
  };
  visit(workspace);
  return files;
}
