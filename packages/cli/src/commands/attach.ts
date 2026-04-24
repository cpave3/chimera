import { ChimeraClient } from '@chimera/client';
import { listLiveInstances } from '../lockfile';

export interface AttachOptions {
  target: string;
  home?: string;
}

export interface AttachTarget {
  url: string;
  sessionId?: string;
}

export function resolveAttachTarget(target: string, home?: string): AttachTarget {
  if (target.startsWith('http://') || target.startsWith('https://')) {
    return { url: target };
  }
  const instances = listLiveInstances(home);
  // Match by pid or session id prefix.
  const match = instances.find(
    (i) => String(i.pid) === target || i.sessionId?.startsWith(target),
  );
  if (!match) {
    throw new Error(
      `No running instance matches '${target}'. Run 'chimera ls' to see running instances.`,
    );
  }
  return { url: match.url, sessionId: match.sessionId };
}

export async function runAttach(opts: AttachOptions): Promise<ChimeraClient> {
  const { url } = resolveAttachTarget(opts.target, opts.home);
  return new ChimeraClient({ baseUrl: url });
}
