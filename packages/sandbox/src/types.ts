import type { SandboxMode } from '@chimera/core';

export type SandboxRunMode = Exclude<SandboxMode, 'off'>;

export interface SandboxConfig {
  /** Image reference, e.g. `chimera-sandbox:dev` or `ghcr.io/.../chimera-sandbox:v0.1`. */
  image: string;
  /** Requested mode. May fall back to `bind` at start-time unless `strict`. */
  mode: SandboxRunMode;
  /** Stable session id used for container name and overlay upperdir path. */
  sessionId: string;
  /** Host cwd to mount as the workspace. */
  hostCwd: string;
  /** Refuse fallback when overlay is unavailable. */
  strict?: boolean;
  /** `none` or `host` (the latter meaning Docker's default network). */
  network?: 'none' | 'host';
  /** Docker --memory value (e.g. `2g`). */
  memory?: string;
  /** Docker --cpus value (e.g. `2`). */
  cpus?: string;
  /** Override location of `~/.chimera/overlays`. */
  overlaysHome?: string;
}

export interface OverlayDiff {
  modified: string[];
  added: string[];
  deleted: string[];
}

export interface OverlayApplySelection {
  paths?: string[];
  includeDeletions?: boolean;
}
