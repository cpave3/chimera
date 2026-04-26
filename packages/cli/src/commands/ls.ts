import { listLiveInstances } from '../lockfile';

export function runLs(home?: string): void {
  const instances = listLiveInstances(home);
  if (instances.length === 0) {
    process.stdout.write('No running chimera instances.\n');
    return;
  }
  process.stdout.write('PID\tPORT\tCWD\tSESSION\n');
  for (const inst of instances) {
    process.stdout.write(`${inst.pid}\t${inst.port}\t${inst.cwd}\t${inst.sessionId ?? ''}\n`);
  }
}
