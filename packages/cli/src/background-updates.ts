import type { Updater } from './updater';

export type UpdatesMode = 'auto' | 'ask' | 'off';

/** The first check waits this long after start, so it never slows a start. */
export const FIRST_CHECK_MS = 60_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface BackgroundUpdatesOptions {
  /** `updates.mode`: `auto` installs, `ask` only says, `off` never checks. */
  mode: UpdatesMode;
  updater: Updater;
  env?: NodeJS.ProcessEnv;
  /** Something for the user to know: an installed or an available release. */
  onNotice(notice: string): void;
  /** Called after each check or install, so a status line can show the state. */
  onChange?(): void;
}

/** Background checks run for a release build, outside CI, unless switched off. */
export function backgroundUpdatesEnabled(
  mode: UpdatesMode,
  updater: Updater,
  env: NodeJS.ProcessEnv,
): boolean {
  return mode !== 'off' && updater.release && !env.CI;
}

/**
 * Check for a newer release a minute after start and then every 6 hours,
 * for the TUI and `chimera serve` (never `chimera run`). In `auto` the
 * release is installed: a running session keeps the binary it started
 * with, and the next start runs the new one. Returns a stop function.
 */
export function startBackgroundUpdates(options: BackgroundUpdatesOptions): () => void {
  const { mode, updater } = options;
  if (!backgroundUpdatesEnabled(mode, updater, options.env ?? process.env)) return () => {};
  let interval: NodeJS.Timeout | undefined;
  let busy = false;
  let announced: string | null = null;

  const announce = (notice: string) => {
    if (notice === announced) return;
    announced = notice;
    options.onNotice(notice);
  };

  const run = async () => {
    if (busy || updater.state === 'installed') return;
    busy = true;
    try {
      const report = await updater.check();
      options.onChange?.();
      if (!report.available) return;
      if (mode === 'ask') {
        announce(`${report.latest} available · chimera update`);
        return;
      }
      options.onChange?.();
      await updater.install();
      announce(`updated to ${report.latest}, restart to use`);
    } catch {
      // The updater keeps the reason; the next check tries again.
    } finally {
      busy = false;
      options.onChange?.();
    }
  };

  const first = setTimeout(() => {
    void run();
    interval = setInterval(() => void run(), CHECK_INTERVAL_MS);
    interval.unref?.();
  }, FIRST_CHECK_MS);
  first.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}

/** The `update` status line item's text for the updater's state. */
export function updateStatus(updater: Updater): string | null {
  const latest = updater.latest?.version;
  switch (updater.state) {
    case 'available':
      return latest ? `${latest} available` : null;
    case 'installing':
      return latest ? `installing ${latest}` : 'installing update';
    case 'installed':
      return latest ? `${latest} installed, restart` : 'update installed';
    case 'failed':
      return 'update failed';
    default:
      return null;
  }
}
