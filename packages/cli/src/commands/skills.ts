import { loadConfig } from '../config';
import { loadSkillsFromConfig } from '../skills-loader';

export interface ListSkillsOptions {
  cwd: string;
  json?: boolean;
  claudeCompat?: boolean;
  home?: string;
}

export async function runSkillsList(opts: ListSkillsOptions): Promise<void> {
  const config = loadConfig(opts.home);
  const registry = loadSkillsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });

  const list = registry.all();

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return;
  }

  if (list.length === 0) {
    process.stdout.write('No skills found.\n');
    return;
  }

  const nameWidth = Math.max(4, ...list.map((s) => s.name.length));
  const srcWidth = Math.max(6, ...list.map((s) => s.source.length));
  process.stdout.write(`${'NAME'.padEnd(nameWidth)}  ${'SOURCE'.padEnd(srcWidth)}  DESCRIPTION\n`);
  for (const s of list) {
    process.stdout.write(
      `${s.name.padEnd(nameWidth)}  ${s.source.padEnd(srcWidth)}  ${s.description}\n`,
    );
  }
}
