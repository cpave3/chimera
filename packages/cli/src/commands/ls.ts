import { listVerifiedInstances } from '../lockfile';

/** List the instances that are running: each is asked, so a stale lockfile is not shown. */
export async function runLs(home?: string): Promise<void> {
  const instances = await listVerifiedInstances({ home });
  if (instances.length === 0) {
    process.stdout.write('No running chimera instances.\n');
    return;
  }
  process.stdout.write('PID\tPORT\tCWD\tSESSION\n');
  for (const inst of instances) {
    process.stdout.write(`${inst.pid}\t${inst.port}\t${inst.cwd}\t${inst.sessionId ?? ''}\n`);
  }
}
