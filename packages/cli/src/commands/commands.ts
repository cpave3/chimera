import { loadCommandsFromConfig } from '../commands-loader';
import { loadConfig } from '../config';

export interface ListCommandsOptions {
  cwd: string;
  json?: boolean;
  claudeCompat?: boolean;
  home?: string;
}

export async function runCommandsList(opts: ListCommandsOptions): Promise<void> {
  const config = loadConfig(opts.home);
  const registry = loadCommandsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });

  const list = registry.list();

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return;
  }

  if (list.length === 0) {
    process.stdout.write('No commands found.\n');
    return;
  }

  const nameWidth = Math.max(4, ...list.map((c) => c.name.length));
  const srcWidth = Math.max(6, ...list.map((c) => c.source.length));
  process.stdout.write(
    `${'NAME'.padEnd(nameWidth)}  ${'SOURCE'.padEnd(srcWidth)}  DESCRIPTION\n`,
  );
  for (const c of list) {
    process.stdout.write(
      `${c.name.padEnd(nameWidth)}  ${c.source.padEnd(srcWidth)}  ${c.description ?? ''}\n`,
    );
  }
}
