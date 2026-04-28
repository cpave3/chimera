import { loadAgentsFromConfig } from '../agents-loader';
import { loadConfig } from '../config';

export interface ListAgentsOptions {
  cwd: string;
  json?: boolean;
  claudeCompat?: boolean;
  home?: string;
}

export async function runAgentsList(opts: ListAgentsOptions): Promise<void> {
  const config = loadConfig(opts.home);
  const registry = loadAgentsFromConfig({
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
    process.stdout.write('No agents found.\n');
    return;
  }

  const nameWidth = Math.max(4, ...list.map((agent) => agent.name.length));
  const srcWidth = Math.max(6, ...list.map((agent) => agent.source.length));
  process.stdout.write(`${'NAME'.padEnd(nameWidth)}  ${'SOURCE'.padEnd(srcWidth)}  DESCRIPTION\n`);
  for (const agent of list) {
    process.stdout.write(
      `${agent.name.padEnd(nameWidth)}  ${agent.source.padEnd(srcWidth)}  ${agent.description}\n`,
    );
  }
}
