import type { SandboxRunMode } from '@chimera/sandbox';
import { defaultImageRef } from '@chimera/sandbox';

export interface CliSandboxOptions {
  /** True when --sandbox was passed. */
  enabled: boolean;
  mode: SandboxRunMode;
  strict: boolean;
  image: string;
  network: 'none' | 'host';
  memory: string;
  cpus: string;
  /** Implies overlay-mode "apply on `run_finished.reason === stop`" semantics. */
  applyOnSuccess: boolean;
  /** True when `image` was not overridden by `--sandbox-image`. */
  imageIsDefault: boolean;
}

export interface ParseSandboxFlagsInput {
  sandbox?: boolean;
  sandboxMode?: string;
  sandboxStrict?: boolean;
  sandboxImage?: string;
  sandboxNetwork?: string;
  sandboxMemory?: string;
  sandboxCpus?: string;
  applyOnSuccess?: boolean;
  cliVersion: string;
}

const VALID_MODES = new Set<SandboxRunMode>(['bind', 'overlay', 'ephemeral']);

export function parseSandboxFlags(opts: ParseSandboxFlagsInput): CliSandboxOptions | null {
  if (!opts.sandbox) {
    if (
      opts.sandboxMode ||
      opts.sandboxStrict ||
      opts.sandboxImage ||
      opts.sandboxNetwork ||
      opts.sandboxMemory ||
      opts.sandboxCpus ||
      opts.applyOnSuccess
    ) {
      throw new Error(
        'sandbox flags require --sandbox; pass --sandbox to enable Docker sandboxing.',
      );
    }
    return null;
  }

  const mode = (opts.sandboxMode ?? 'bind') as SandboxRunMode;
  if (!VALID_MODES.has(mode)) {
    throw new Error(`invalid --sandbox-mode '${opts.sandboxMode}': expected bind|overlay|ephemeral`);
  }

  const network = (opts.sandboxNetwork ?? 'host') as 'none' | 'host';
  if (network !== 'none' && network !== 'host') {
    throw new Error(`invalid --sandbox-network '${opts.sandboxNetwork}': expected none|host`);
  }

  return {
    enabled: true,
    mode,
    strict: !!opts.sandboxStrict,
    image: opts.sandboxImage ?? defaultImageRef(opts.cliVersion),
    imageIsDefault: !opts.sandboxImage,
    network,
    memory: opts.sandboxMemory ?? '2g',
    cpus: opts.sandboxCpus ?? '2',
    applyOnSuccess: !!opts.applyOnSuccess,
  };
}
