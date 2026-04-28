import { type FSWatcher, watch } from 'node:fs';
import { buildTiers } from './discover';
import { loadAgents } from './load';
import type { AgentCollision, AgentDefinition, AgentRegistry, LoadAgentsOptions } from './types';

export interface ReloadingAgentsOptions extends LoadAgentsOptions {
  /** Debounce window for coalescing rapid file events. Default 150ms. */
  debounceMs?: number;
}

/**
 * An `AgentRegistry` that watches its tier directories and swaps in a freshly
 * loaded inner registry when `*.md` files change. Mirrors
 * `ReloadingCommandRegistry` from @chimera/commands. Tier dirs that do not
 * exist at startup are not picked up until `reload()` is invoked manually.
 */
export class ReloadingAgentRegistry implements AgentRegistry {
  private inner: AgentRegistry;
  private readonly opts: ReloadingAgentsOptions;
  private readonly listeners = new Set<() => void>();
  private readonly watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: ReloadingAgentsOptions) {
    this.opts = opts;
    this.inner = loadAgents(opts);
    this.installWatchers();
  }

  all(): AgentDefinition[] {
    return this.inner.all();
  }

  find(name: string): AgentDefinition | undefined {
    return this.inner.find(name);
  }

  collisions(): AgentCollision[] {
    return this.inner.collisions();
  }

  buildDescriptionIndex(): string {
    return this.inner.buildDescriptionIndex();
  }

  async reload(): Promise<void> {
    if (this.closed) return;
    this.inner = loadAgents(this.opts);
    this.notify();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // already dead
      }
    }
    this.watchers.length = 0;
    this.listeners.clear();
  }

  private installWatchers(): void {
    const tiers = buildTiers(this.opts);
    for (const tier of tiers) {
      try {
        const watcher = watch(tier.dir, { recursive: true }, (_event, filename) => {
          this.onFsEvent(filename);
        });
        watcher.on('error', () => {
          // tier dir disappearing isn't fatal
        });
        this.watchers.push(watcher);
      } catch {
        // tier dir missing — matches discovery
      }
    }
  }

  private onFsEvent(filename: string | Buffer | null): void {
    if (this.closed) return;
    const name = typeof filename === 'string' ? filename : (filename?.toString() ?? '');
    if (name && !name.endsWith('.md')) return;
    this.scheduleReload();
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const delay = this.opts.debounceMs ?? 150;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.closed) return;
      this.inner = loadAgents(this.opts);
      this.notify();
    }, delay);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // one bad listener shouldn't break the rest
      }
    }
  }
}
