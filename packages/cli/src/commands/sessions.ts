import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionsDir } from '@chimera/core';

export function runSessionsList(home = homedir()): void {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) {
    process.stdout.write('No sessions.\n');
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    process.stdout.write('No sessions.\n');
    return;
  }
  process.stdout.write('ID\tCWD\tMESSAGES\tCREATED\n');
  for (const f of files) {
    try {
      const session = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const created = new Date(session.createdAt).toISOString();
      process.stdout.write(
        `${session.id}\t${session.cwd}\t${session.messages?.length ?? 0}\t${created}\n`,
      );
    } catch {
      // skip corrupt
    }
  }
}

export function runSessionsRm(sessionId: string, home = homedir()): void {
  const path = join(sessionsDir(home), `${sessionId}.json`);
  if (!existsSync(path)) {
    process.stderr.write(`No such session: ${sessionId}\n`);
    process.exit(1);
  }
  unlinkSync(path);
  process.stdout.write(`Deleted ${sessionId}\n`);
}
