import { Updater, type UpdaterOptions } from '../updater';

export interface UpdateCommandOptions {
  check?: boolean;
  json?: boolean;
  /** Install this release (a rollback, say) instead of the newest. */
  version?: string;
}

export interface UpdateIo {
  write(text: string): void;
}

/**
 * `chimera update [--check] [--json] [--version vX.Y.Z]`. The output and the
 * exit codes follow `st update`, so legato's tool updater drives both the
 * same way: `--json` prints {"current", "latest", "available", "url"}, and
 * an install adds "updated". Failures throw, for a non-zero exit.
 */
export async function runUpdate(
  options: UpdateCommandOptions,
  io: UpdateIo = { write: (text) => process.stdout.write(text) },
  updaterOptions: UpdaterOptions = {},
): Promise<void> {
  const updater = new Updater(updaterOptions);
  const json = (value: unknown) => io.write(`${JSON.stringify(value)}\n`);
  if (options.check) {
    const report = await updater.check();
    if (options.json) return json(report);
    if (report.available) {
      io.write(
        `chimera ${report.current} is installed; ${report.latest} is available: ${report.url}\nRun 'chimera update' to install it.\n`,
      );
    } else if (!updater.release) {
      io.write(
        `chimera ${report.current} is not a release build; the newest release is ${report.latest}: ${report.url}\n`,
      );
    } else {
      io.write(`chimera ${report.current} is up to date (newest release: ${report.latest})\n`);
    }
    return;
  }
  const report = await updater.install(options.version);
  if (options.json) return json(report);
  if (report.updated) {
    io.write(
      `Updated chimera ${report.current} to ${report.latest}\nSessions already running keep the old binary until they restart.\n`,
    );
  } else {
    io.write(`chimera ${report.current} is up to date (newest release: ${report.latest})\n`);
  }
}
