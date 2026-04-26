import { type FSWatcher, watch } from 'node:fs';
import { buildTiers } from './discover';
import { loadCommands } from './load';
import type {
  Command,
  CommandCollision,
  CommandRegistry,
  ExpandContext,
  LoadCommandsOptions,
} from './types';

export interface ReloadingOptions extends LoadCommandsOptions {
  /** Debounce window for coalescing rapid file events. Default 150ms. */
  debounceMs?: number;
}

/**
 * A `CommandRegistry` that watches its source tier directories and swaps in a
 * freshly-loaded inner registry whenever `*.md` files change. `list`, `find`,
 * `expand`, `collisions` all delegate to the current inner.
 *
 * Scope (intentional):
 * - Watches only tier dirs that exist at startup. Tier dirs created later are
 *   only picked up via an explicit `reload()` (e.g. the TUI `/reload`
 *   command).
 * - `fs.watch` semantics. No chokidar.
 */
export class ReloadingCommandRegistry implements CommandRegistry {
  private inner: CommandRegistry;
  private readonly opts: ReloadingOptions;
  private readonly listeners = new Set<() => void>();
  private readonly watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: ReloadingOptions) {
    this.opts = opts;
    this.inner = loadCommands(opts);
    this.installWatchers();
  }

  list(): Command[] {
    return this.inner.list();
  }

  find(name: string): Command | undefined {
    return this.inner.find(name);
  }

  expand(name: string, args: string, ctx?: ExpandContext): string {
    return this.inner.expand(name, args, ctx);
  }

  collisions(): CommandCollision[] {
    return this.inner.collisions();
  }

  async reload(): Promise<void> {
    if (this.closed) return;
    this.inner = loadCommands(this.opts);
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
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // watcher may already be dead
      }
    }
    this.watchers.length = 0;
    this.listeners.clear();
  }

  private installWatchers(): void {
    const tiers = buildTiers(this.opts);
    for (const tier of tiers) {
      try {
        const w = watch(tier.dir, { recursive: true }, (_event, filename) => {
          this.onFsEvent(filename);
        });
        w.on('error', () => {
          // Silent: tier dir disappearing is not fatal.
        });
        this.watchers.push(w);
      } catch {
        // Dir doesn't exist (or permissions). Skip — matches discovery.
      }
    }
  }

  private onFsEvent(filename: string | Buffer | null): void {
    if (this.closed) return;
    const name = typeof filename === 'string' ? filename : (filename?.toString() ?? '');
    // Only react to markdown files. `fs.watch` sometimes fires with empty
    // names on macOS or when a dir itself changes; reload in that case too so
    // we don't miss moves. Nested paths (e.g. `ops/deploy.md`) still match.
    if (name && !name.endsWith('.md')) return;
    this.scheduleReload();
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const delay = this.opts.debounceMs ?? 150;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.closed) return;
      this.inner = loadCommands(this.opts);
      this.notify();
    }, delay);
  }

  private notify(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // One bad listener shouldn't break the rest.
      }
    }
  }
}
