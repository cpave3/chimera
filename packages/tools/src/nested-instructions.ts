import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readInstructionFile } from '@chimera/core';
import type { ToolCallInterceptor, ToolOutcome } from './intercept';

export interface NestedInstructionsOptions {
  /** The session's working directory. Its own instruction files are in the system prompt. */
  cwd: string;
}

/** One instruction file handed to the model with a tool result. */
export interface NestedInstruction {
  /** Relative to the working directory. */
  path: string;
  content: string;
}

const PATCH_FILE_LINE = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm;

/** The files a call names, as the model wrote them. */
function touchedPaths(name: string, args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return [];
  if (name === 'apply_patch') {
    const input = (args as { input?: unknown }).input;
    if (typeof input !== 'string') return [];
    return [...input.matchAll(PATCH_FILE_LINE)].map((match) => match[1]!.trim());
  }
  if (name === 'read' || name === 'edit' || name === 'write') {
    const path = (args as { path?: unknown }).path;
    return typeof path === 'string' ? [path] : [];
  }
  return [];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The instruction files of one directory, in the order the system prompt uses at the root. */
function instructionFilesIn(directory: string): string[] {
  const shared = ['AGENTS.md', 'CLAUDE.md'].map((name) => join(directory, name)).find(isFile);
  const local = join(directory, 'AGENTS.local.md');
  return [...(shared ? [shared] : []), ...(isFile(local) ? [local] : [])];
}

/**
 * Give the model the instruction file of a subdirectory when it first works
 * there. The file rides on the tool result rather than the system prompt:
 * a system prompt that changed would cost the provider's cache of the whole
 * conversation.
 */
export function nestedInstructions(options: NestedInstructionsOptions): ToolCallInterceptor {
  const root = resolve(options.cwd);
  // Directories looked at once already, with or without a file in them.
  const seen = new Set<string>([root]);

  /** Directories from just below the working directory down to the file's own, not seen before. */
  function newDirectories(path: string): string[] {
    const file = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (!file.startsWith(root + sep)) return [];
    const directories: string[] = [];
    for (let directory = dirname(file); directory !== root; directory = dirname(directory)) {
      if (!seen.has(directory)) directories.unshift(directory);
    }
    return directories;
  }

  return {
    after(call, outcome): ToolOutcome {
      // A call that failed did not start work in the directory.
      if ('error' in outcome) return outcome;
      const instructions: NestedInstruction[] = [];
      for (const path of touchedPaths(call.name, call.args)) {
        for (const directory of newDirectories(path)) {
          seen.add(directory);
          for (const instructionPath of instructionFilesIn(directory)) {
            const file = readInstructionFile(instructionPath);
            if (file) {
              instructions.push({ path: relative(root, instructionPath), content: file.content });
            }
          }
        }
      }
      if (instructions.length === 0) return outcome;
      const { result } = outcome;
      if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
        return { result: { ...result, instructions } };
      }
      if (typeof result === 'string') {
        const blocks = instructions.map(
          (instruction) => `[Project instructions: ${instruction.path}]\n${instruction.content}`,
        );
        return { result: [result, ...blocks].join('\n\n') };
      }
      return outcome;
    },
  };
}
