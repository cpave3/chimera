import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readWorkspace, type WorkspaceFiles } from '../workspace';
import type { CheckResult } from './types';

const PACKAGE_JSON = `${JSON.stringify(
  { name: 'workspace', private: true, type: 'module', scripts: { test: 'node --test' } },
  null,
  2,
)}\n`;

/** A task's files plus the files every workspace has. */
export function project(files: WorkspaceFiles): WorkspaceFiles {
  return { 'package.json': PACKAGE_JSON, '.gitignore': '.chimera/\nnode_modules/\n', ...files };
}

/**
 * Writes the test files, replacing whatever the agent left at those paths, and
 * runs them. A task passes on these tests only, so an agent cannot pass by
 * editing a test.
 */
export function runTests(workspace: string, testFiles: WorkspaceFiles): CheckResult {
  for (const [path, content] of Object.entries(testFiles)) {
    const target = join(workspace, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const result = spawnSync(process.execPath, ['--test', ...Object.keys(testFiles)], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status === 0) return { pass: true, detail: 'The tests pass.' };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failures = output
    .split('\n')
    .filter((line) => /not ok|✖|Error|expected|actual/i.test(line))
    .slice(0, 8)
    .map((line) => line.trim());
  return { pass: false, detail: `The tests fail: ${failures.join(' | ').slice(0, 600)}` };
}

export function readFile(workspace: string, path: string): string | undefined {
  try {
    return readFileSync(join(workspace, path), 'utf8');
  } catch {
    return undefined;
  }
}

export function replaceInFile(workspace: string, path: string, from: string, to: string): void {
  const target = join(workspace, path);
  const content = readFileSync(target, 'utf8');
  if (!content.includes(from)) throw new Error(`${path} does not contain: ${from}`);
  writeFileSync(target, content.replace(from, to));
}

/** Paths that were added, removed or given other content since the workspace was created. */
export function changedPaths(original: WorkspaceFiles, workspace: string): string[] {
  const current = readWorkspace(workspace);
  const paths = new Set([...Object.keys(original), ...Object.keys(current)]);
  return [...paths].filter((path) => original[path] !== current[path]).sort();
}

export function expectUnchanged(original: WorkspaceFiles, workspace: string): CheckResult {
  const changed = changedPaths(original, workspace);
  return changed.length === 0
    ? { pass: true, detail: 'No file changed.' }
    : { pass: false, detail: `Files changed: ${changed.join(', ')}` };
}

/**
 * The zero-based numbers of the lines that differ, or undefined when the two
 * texts do not have the same number of lines.
 */
export function changedLines(before: string, after: string): number[] | undefined {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (beforeLines.length !== afterLines.length) return undefined;
  const changed: number[] = [];
  for (let i = 0; i < beforeLines.length; i += 1) {
    if (beforeLines[i] !== afterLines[i]) changed.push(i);
  }
  return changed;
}

export function all(...results: CheckResult[]): CheckResult {
  return results.find((result) => !result.pass) ?? results[results.length - 1]!;
}
