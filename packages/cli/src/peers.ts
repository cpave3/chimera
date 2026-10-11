import { basename } from 'node:path';
import { ChimeraClient } from '@chimera/client';
import type { Peer } from '@chimera/tui';
import { type Lockfile, listLiveInstances } from './lockfile';

// A peer that is busy answers late; the panel shows it without a state
// rather than hold every other row back.
const PEER_TIMEOUT_MS = 1_000;
const SHORT_ID_LENGTH = 4;

export interface ListPeersOptions {
  home?: string;
  /** The instance asking, which is not its own peer. Defaults to this process. */
  selfPid?: number;
  fetch?: typeof fetch;
}

/** A directory name for each instance; instances that share one also get their session. */
function peerLabels(instances: Lockfile[]): string[] {
  const names = instances.map((instance) => basename(instance.cwd) || instance.cwd);
  return instances.map((instance, index) => {
    const name = names[index]!;
    const shared = names.filter((other) => other === name).length > 1;
    return shared && instance.sessionId
      ? `${name} ${instance.sessionId.slice(-SHORT_ID_LENGTH)}`
      : name;
  });
}

/**
 * The other live Chimera instances on this machine, from their lockfiles,
 * each asked what its session is doing.
 */
export async function listPeers(options: ListPeersOptions = {}): Promise<Peer[]> {
  const selfPid = options.selfPid ?? process.pid;
  const baseFetch = options.fetch ?? fetch;
  const others = listLiveInstances(options.home).filter((instance) => instance.pid !== selfPid);
  const labels = peerLabels(others);
  return Promise.all(
    others.map(async (instance, index): Promise<Peer> => {
      const label = labels[index]!;
      if (!instance.sessionId) return { label };
      const client = new ChimeraClient({
        baseUrl: instance.url,
        fetch: (input, init) =>
          baseFetch(input, { ...init, signal: AbortSignal.timeout(PEER_TIMEOUT_MS) }),
      });
      try {
        const { mode, status } = await client.getSessionStatus(instance.sessionId);
        return { label, mode, status };
      } catch {
        return { label };
      }
    }),
  );
}
