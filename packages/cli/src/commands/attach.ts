import { ChimeraClient } from '@chimera/client';
import { InMemoryCommandRegistry } from '@chimera/commands';
import { composeSystemPrompt } from '@chimera/core';
import { InMemoryModeRegistry } from '@chimera/modes';
import { InMemorySkillRegistry } from '@chimera/skills';
import { mountTui } from '@chimera/tui';
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
  const match = instances.find((i) => String(i.pid) === target || i.sessionId?.startsWith(target));
  if (!match) {
    throw new Error(
      `No running instance matches '${target}'. Run 'chimera ls' to see running instances.`,
    );
  }
  return { url: match.url, sessionId: match.sessionId };
}

export async function runAttach(opts: AttachOptions): Promise<void> {
  const { url, sessionId: lockfileSessionId } = resolveAttachTarget(opts.target, opts.home);
  const client = new ChimeraClient({ baseUrl: url });

  const instance = await client.getInstance();

  // Resolve the session to attach to.  Prefer the sessionId from the
  // lockfile; if not present (e.g. attach by URL), list sessions and pick
  // the most recently active one in the instance cwd.
  let sessionId = lockfileSessionId;
  if (!sessionId) {
    const sessions = await client.listSessions();
    const inCwd = sessions
      .filter((s) => s.cwd === instance.cwd)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    if (inCwd.length === 0) {
      throw new Error(
        `No sessions found for cwd ${instance.cwd}. Specify a session ID or start chimera in that directory.`,
      );
    }
    sessionId = inCwd[0]!.id;
  }

  // Fetch session info to get the model config and cwd.
  const session = await client.getSession(sessionId);

  // Fetch server-discovered commands, skills, and modes for this session.
  const [commands, skills, modes] = await Promise.all([
    client.listCommands(sessionId),
    client.listSkills(sessionId),
    client.listModes(sessionId),
  ]);

  const commandRegistry = new InMemoryCommandRegistry(commands, [], instance.cwd);
  const skillRegistry = new InMemorySkillRegistry(skills, []);
  const modeRegistry = new InMemoryModeRegistry(modes, []);

  // Get the current mode from the server.
  const currentMode = await client.getMode(sessionId);

  const handle = mountTui({
    client,
    sessionId,
    modelRef: session.userModelOverride ?? `${session.model.providerId}/${session.model.modelId}`,
    model: session.model,
    cwd: session.cwd,
    commands: commandRegistry,
    skills: skillRegistry,
    modes: modeRegistry,
    cycleModes: modeRegistry.all().filter((m) => m.cycle).map((m) => m.name),
    initialMode: currentMode.mode,
    sandboxMode: session.sandboxMode,
    // Attaching clients cannot perform owner-local overlay operations
    // or system-prompt reload — those depend on the owning process's
    // filesystem context.  Leave these undefined to disable them.
    overlay: undefined,
    reloadSystemPrompt: undefined,
  });

  try {
    await handle.waitUntilExit();
  } finally {
    handle.unmount();
  }
}
