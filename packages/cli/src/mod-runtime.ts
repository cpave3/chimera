import { type LifecycleEvent, Logger, lifecycleSource, type SessionId } from '@chimera/core';
import { type ModEvent, ModHost, SessionEnded } from '@chimera/mods';
import type { AgentRegistry } from '@chimera/server';

export interface ModOptions {
  modDirs?: string[];
  mods?: boolean;
}

export class ModRuntime {
  host!: ModHost;
  private registry?: AgentRegistry;
  private unsubscribe = () => {};

  static async create(
    options: ModOptions & { home?: string },
  ): Promise<ModRuntime> {
    const runtime = new ModRuntime();
    const logger = new Logger({ home: options.home });
    runtime.host = await ModHost.create({
      folders: options.modDirs,
      noMods: options.mods === false,
      sessionContext: (id) => runtime.context(id),
      warn: (message) => logger.warn(message),
      ui: (text) => logger.debug(text),
    });
    runtime.unsubscribe = lifecycleSource.subscribe(async (event) => {
      if (!runtime.registry?.get(event.sessionId as SessionId)) return;
      const mapped = runtime.map(event);
      if (!mapped) return;
      await runtime.host
        .observe(mapped)
        .catch((error) => logger.warn(`Mod observer failed: ${error}`));
    });
    return runtime;
  }

  bind(registry: AgentRegistry, _url: string): void {
    this.registry = registry;
  }

  private context(id: string): Record<string, unknown> {
    const entry = this.registry?.get(id as SessionId);
    if (!entry) throw new SessionEnded(id);
    return { session: { id, cwd: entry.agent.snapshot().cwd } };
  }

  private map(event: LifecycleEvent): ModEvent | undefined {
    if (event.type !== 'run_finished') return undefined;
    return {
      type: 'turn.complete',
      sessionId: event.sessionId,
      reason: event.reason,
      error: event.error,
    };
  }

  async shutdown(): Promise<void> {
    this.unsubscribe();
    await this.host.shutdown();
  }
}
