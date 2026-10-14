import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Variant } from './variants';

export const PROVIDER_ID = 'lm-studio';

export interface EvalHomeOptions {
  /** The directory the run uses as `$HOME`. */
  home: string;
  /** The OpenAI-compatible endpoint of the local server. */
  baseUrl: string;
  /** The model key the local server knows, for example `qwen/qwen3.5-9b`. */
  modelId: string;
  contextWindow: number;
  variant: Variant;
}

/**
 * Writes the `~/.chimera` of one run, so the run sees the variant's profile
 * and none of the user's own config, skills, modes or hooks. Returns the
 * `chimera run` flags that select the model and the variant.
 */
export function writeEvalHome(options: EvalHomeOptions): string[] {
  const modelRef = `${PROVIDER_ID}/${options.modelId}`;
  const chimeraDir = join(options.home, '.chimera');
  mkdirSync(chimeraDir, { recursive: true });

  const config = {
    providers: {
      [PROVIDER_ID]: {
        shape: 'openai',
        baseUrl: options.baseUrl,
        apiKey: 'lm-studio',
        ...options.variant.providerOptions,
      },
    },
    defaultModel: modelRef,
    models: {
      [modelRef]: { contextWindow: options.contextWindow, ...options.variant.modelOptions },
    },
    // A small model runs shell commands on this machine: refuse them when the
    // kernel cannot confine their writes to the workspace.
    commandPolicy: { hostBash: { osSandbox: 'required' } },
    // Chimera's defaults (16384 + 20000) are more than a small local context
    // window holds, and it refuses to start when they do not fit.
    compaction: {
      reserveTokens: Math.min(16_384, Math.round(options.contextWindow / 8)),
      keepRecentTokens: Math.min(20_000, Math.round(options.contextWindow / 4)),
    },
    workspaceCheckpoints: false,
    memory: { enabled: false },
  };
  writeFileSync(join(chimeraDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const flags = ['--model', modelRef, ...(options.variant.flags ?? [])];
  const mode = options.variant.mode;
  if (mode) {
    const modesDir = join(chimeraDir, 'modes');
    mkdirSync(modesDir, { recursive: true });
    writeFileSync(
      join(modesDir, `${mode.name}.md`),
      [
        '---',
        `name: ${mode.name}`,
        'description: Build mode with a reduced tool set, for evals.',
        `tools: [${mode.tools.join(', ')}]`,
        '---',
        '',
        'You can read, search, edit and run commands. Do the task the user gave you.',
        '',
      ].join('\n'),
    );
    flags.push('--mode', mode.name);
  }
  return flags;
}
