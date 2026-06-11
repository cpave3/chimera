import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Executor } from '@chimera/core';

const DEFAULT_MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

export interface DiagnosticsCheck {
  name: string;
  /**
   * Shell command run after a mutating tool call. `{file}` is replaced with
   * the (shell-quoted) path of the changed file. Exit 0 means clean; any
   * other exit code feeds the command's output back to the model as
   * diagnostics.
   */
  command: string;
  /** Regex a changed file path must match for this check to run. */
  match: string;
  timeoutMs?: number;
}

export interface DiagnosticsRunnerOptions {
  executor: Executor;
  checks: DiagnosticsCheck[];
  maxOutputChars?: number;
}

/**
 * Runs configured checks against a just-changed file and formats failures for
 * inclusion in the edit/write tool result. Checks are user-configured (or
 * auto-detected from project config files), never model-authored, so they run
 * ungated. A failing or crashing check never throws — the worst outcome is
 * diagnostics text the model can ignore.
 */
export class DiagnosticsRunner {
  private readonly executor: Executor;
  private readonly checks: { check: DiagnosticsCheck; pattern: RegExp }[];
  private readonly maxOutputChars: number;

  constructor(opts: DiagnosticsRunnerOptions) {
    this.executor = opts.executor;
    this.maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.checks = opts.checks.flatMap((check) => {
      try {
        return [{ check, pattern: new RegExp(check.match) }];
      } catch {
        return [];
      }
    });
  }

  hasChecks(): boolean {
    return this.checks.length > 0;
  }

  /**
   * Run every check whose pattern matches `file`. Returns formatted failure
   * output, or null when all applicable checks pass (or none apply).
   */
  async collect(file: string): Promise<string | null> {
    const failures: string[] = [];
    for (const { check, pattern } of this.checks) {
      if (!pattern.test(file)) continue;
      const command = check.command.replaceAll('{file}', shellQuote(file));
      let output: string;
      let exitCode: number;
      try {
        const result = await this.executor.exec(command, {
          timeoutMs: check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
        });
        exitCode = result.exitCode;
        output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      } catch (err) {
        exitCode = -1;
        output = String((err as Error)?.message ?? err);
      }
      if (exitCode === 0) continue;
      failures.push(`[${check.name}] (exit ${exitCode})\n${output.trim()}`);
    }
    if (failures.length === 0) return null;
    return clipOutput(failures.join('\n\n'), this.maxOutputChars);
  }
}

export interface DiagnosticsConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /** Auto-detect fast project checks (biome, cerberus). Default true. */
  autoDetect?: boolean;
  /** Explicit checks. Override auto-detected checks with the same name. */
  checks?: DiagnosticsCheck[];
}

/**
 * Resolve a DiagnosticsConfig into a runner, or undefined when diagnostics
 * are disabled or no checks apply to the project.
 */
export async function buildDiagnosticsRunner(opts: {
  cwd: string;
  executor: Executor;
  config?: DiagnosticsConfig;
}): Promise<DiagnosticsRunner | undefined> {
  if (opts.config?.enabled === false) return undefined;
  const explicit = opts.config?.checks ?? [];
  const detected = opts.config?.autoDetect === false ? [] : await detectDiagnosticsChecks(opts.cwd);
  const merged = [
    ...detected.filter((check) => !explicit.some((override) => override.name === check.name)),
    ...explicit,
  ];
  if (merged.length === 0) return undefined;
  return new DiagnosticsRunner({ executor: opts.executor, checks: merged });
}

/**
 * Detect fast, file-scoped checks from project config files. Only tools that
 * are cheap enough to run on every edit are auto-detected; anything heavier
 * (tsc, test suites) is opt-in via the `diagnostics.checks` config block.
 */
export async function detectDiagnosticsChecks(cwd: string): Promise<DiagnosticsCheck[]> {
  const checks: DiagnosticsCheck[] = [];
  const biomeBin = 'node_modules/@biomejs/biome/bin/biome';
  const hasBiomeConfig =
    (await exists(join(cwd, 'biome.json'))) || (await exists(join(cwd, 'biome.jsonc')));
  if (hasBiomeConfig && (await exists(join(cwd, biomeBin)))) {
    checks.push({
      name: 'biome',
      command: `node ./${biomeBin} check {file}`,
      match: '\\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$',
    });
  }
  if (await exists(join(cwd, '.cerberus', 'config.yaml'))) {
    checks.push({
      name: 'cerberus',
      command: 'cerberus run quick',
      match: '\\.[a-zA-Z0-9]+$',
    });
  }
  return checks;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function clipOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}
