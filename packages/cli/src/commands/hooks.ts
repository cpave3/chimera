import { ALL_HOOK_EVENTS, defaultGlobalRoot, defaultProjectRoot, discover } from '@chimera/hooks';

export interface ListHooksOptions {
  cwd: string;
  json?: boolean;
}

export async function runHooksList(opts: ListHooksOptions): Promise<void> {
  const globalRoot = defaultGlobalRoot();
  const projectRoot = defaultProjectRoot(opts.cwd);

  const events: Record<string, { global: string[]; project: string[] }> = {};
  for (const event of ALL_HOOK_EVENTS) {
    const r = await discover(event, opts.cwd, { globalRoot, projectRoot });
    events[event] = r;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ events })}\n`);
    return;
  }

  for (const event of ALL_HOOK_EVENTS) {
    const { global, project } = events[event]!;
    process.stdout.write(`${event}\n`);
    if (global.length === 0 && project.length === 0) {
      process.stdout.write('  (none)\n');
      continue;
    }
    for (const path of global) {
      process.stdout.write(`  global   ${path}\n`);
    }
    for (const path of project) {
      process.stdout.write(`  project  ${path}\n`);
    }
  }
}
