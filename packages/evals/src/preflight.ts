import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Selection } from './selection';

export interface PreflightChecks {
  fileExists(path: string): boolean;
  /** Whether chimera can keep host commands in the sandbox of the operating system. */
  hasOsSandbox(): boolean;
  /** The ids of the models the server at `baseUrl` offers. */
  serverModels(baseUrl: string): Promise<string[]>;
}

export const systemChecks: PreflightChecks = {
  fileExists: existsSync,
  hasOsSandbox: () => {
    if (process.platform !== 'linux') return true;
    try {
      execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  serverModels: async (baseUrl) => {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data: { id: string }[] };
    return body.data.map((model) => model.id);
  },
};

/** The reasons a run cannot start, each with the command that removes it. */
export async function preflight(
  selection: Selection,
  checks: PreflightChecks = systemChecks,
): Promise<string[]> {
  const problems: string[] = [];

  const binary = selection.settings.command.at(-1)!;
  if (binary.includes('/') && !checks.fileExists(binary)) {
    problems.push(`The chimera binary ${binary} does not exist. Build it with: pnpm -r build`);
  }
  if (!checks.hasOsSandbox()) {
    problems.push(
      'bubblewrap (bwrap) is not installed. The evals keep the commands of a model in the OS sandbox and do not run without it.',
    );
  }

  const { baseUrl } = selection.settings;
  let available: string[];
  try {
    available = await checks.serverModels(baseUrl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    problems.push(
      `No model server answers at ${baseUrl} (${reason}). Start it with: lms server start`,
    );
    return problems;
  }
  for (const model of selection.models) {
    if (!available.includes(model.key)) {
      problems.push(
        `The server does not have the model ${model.key}. Download it with: lms get ${model.key}`,
      );
    }
  }
  return problems;
}
