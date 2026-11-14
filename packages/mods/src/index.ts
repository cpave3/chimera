import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ModProcesses } from './process';
import { createStore } from './store';
import { delimiter, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ModEvent {
  type: string;
  sessionId: string;
  [key: string]: unknown;
}

export interface ModManifest {
  name: string;
  version: string;
  apiVersion: 1;
  module?: string;
}

export interface ModContext {
  [key: string]: unknown;
}

export type Next = () => Promise<unknown>;
export type ModHandler = (context: ModContext, event: ModEvent, next: Next) => unknown;
export type On = (name: string, handler: ModHandler) => void;

export interface Registration {
  readonly mod: string;
  readonly name: string;
  readonly folder: string;
}

interface Hook extends Registration {
  handler: ModHandler;
}

export interface ModHostOptions {
  folders?: readonly string[];
  envDirs?: string;
  noMods?: boolean;
  userDirectory?: string;
  disabled?: readonly string[];
  dataDirectory?: string;
  version?: string;
  serverUrl?: () => string;
  warn?: (message: string) => void;
  ui?: (
    text: string,
    options: { to: 'debug' | 'status' | 'scrollback' },
    sessionId?: string,
  ) => void | Promise<void>;
  sessionContext: (sessionId: string) => Record<string, unknown>;
  timeouts?: { hookMs?: number; totalMs?: number; registrationMs?: number };
}

export class SessionEnded extends Error {
  constructor(sessionId: string) {
    super(`Session ended: ${sessionId}`);
    this.name = 'SessionEnded';
  }
}

export class ModTimeout extends Error {
  constructor(label: string) {
    super(`Mod timeout: ${label}`);
    this.name = 'ModTimeout';
  }
}

function deadline<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ModTimeout(label)), milliseconds);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

export class ModHost {
  private readonly hooks: Hook[] = [];
  private readonly queues = new Map<string, Promise<void>>();
  private readonly ended = new Set<string>();
  private readonly epochs = new Map<string, number>();
  private stopped = false;
  private readonly processes = new ModProcesses();

  private constructor(private readonly options: ModHostOptions) {}

  static async create(options: ModHostOptions): Promise<ModHost> {
    const host = new ModHost(options);
    if (options.noMods) return host;
    for (const folder of options.folders ?? []) await host.load(folder);
    for (const folder of (options.envDirs ?? process.env.CHIMERA_MOD_DIRS ?? '')
      .split(delimiter)
      .filter(Boolean)) {
      await host.load(folder);
    }
    return host;
  }

  get registrations(): readonly Registration[] {
    return this.hooks.map(({ mod, name, folder }) => ({ mod, name, folder }));
  }

  private async load(folder: string): Promise<void> {
    try {
      await this.loadFolder(folder);
    } catch (error) {
      (this.options.warn ?? console.warn)(
        `Mod ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async loadFolder(folder: string): Promise<void> {
    const manifest: ModManifest = JSON.parse(
      await readFile(join(folder, 'chimera-mod.json'), 'utf8'),
    );
    if (
      typeof manifest.name !== 'string' ||
      !manifest.name ||
      typeof manifest.version !== 'string' ||
      !manifest.version ||
      manifest.apiVersion !== 1 ||
      (manifest.module !== undefined && typeof manifest.module !== 'string')
    )
      throw new Error(`Invalid mod manifest: ${folder}`);
    const modulePath = resolve(folder, manifest.module ?? 'index.mjs');
    if (!modulePath.startsWith(resolve(folder) + sep) || extname(modulePath) !== '.mjs') {
      throw new Error(`Mod module must be a .mjs file inside its folder: ${folder}`);
    }
    const pending: Hook[] = [];
    let registering = true;
    const on: On = (name, handler) => {
      if (!registering) throw new Error(`Registration closed: ${manifest.name}`);
      if (typeof name !== 'string' || !name || typeof handler !== 'function') {
        throw new Error(`Invalid hook registration: ${manifest.name}`);
      }
      pending.push({ mod: manifest.name, name, folder: resolve(folder), handler });
    };
    try {
      await deadline(
        (async () => {
          const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
          if (typeof module.register !== 'function')
            throw new Error(`Missing register(on): ${folder}`);
          await module.register(on);
        })(),
        this.options.timeouts?.registrationMs ?? 5_000,
        `registration ${manifest.name}`,
      );
      this.hooks.push(...pending);
    } finally {
      registering = false;
    }
  }

  private async context(
    hook: Hook,
    sessionId: string | undefined,
    pause: () => void,
    resume: () => void,
  ): Promise<ModContext> {
    const directory = join(
      this.options.dataDirectory ?? join(homedir(), '.chimera', 'mod-data'),
      hook.mod === '.' || hook.mod === '..'
        ? hook.mod.replaceAll('.', '%2E')
        : encodeURIComponent(hook.mod),
    );
    await mkdir(directory, { recursive: true });
    const epoch = sessionId === undefined ? 0 : (this.epochs.get(sessionId) ?? 0);
    const delegated = sessionId === undefined ? {} : this.options.sessionContext(sessionId);
    const context = {
      ...delegated,
      chimera: { version: this.options.version ?? '0.1.0' },
      api: { version: 1 },
      server: { url: () => this.options.serverUrl?.() },
      process: { spawn: this.processes.spawn.bind(this.processes) },
      store: createStore(directory),
      env: {
        get: (name: string) => process.env[name],
        set: (name: string, value: string | undefined) => {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        },
      },
      clock: {
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      },
      http: {
        fetch: (input: string | URL | Request, init?: RequestInit) =>
          fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
              : AbortSignal.timeout(30_000),
          }),
      },
      ui: {
        log: (
          text: string,
          options: { to: 'debug' | 'status' | 'scrollback' } = { to: 'debug' },
        ) => {
          return this.options.ui ? this.options.ui(text, options, sessionId) : console.debug(text);
        },
      },
    };
    const wrap = (
      target: Record<string, unknown>,
      sessionBound = true,
    ): Record<string, unknown> => {
      // Frozen provider snapshots cannot be proxy targets when their methods are wrapped.
      const proxyTarget = Object.isFrozen(target)
        ? Array.isArray(target)
          ? [...target]
          : { ...target }
        : target;
      return new Proxy(proxyTarget, {
        get: (_object, key) => {
          const value = Reflect.get(target, key);
          if (typeof value === 'function')
            return (...args: unknown[]) => {
              if (
                this.stopped ||
                (sessionBound &&
                  sessionId !== undefined &&
                  (this.ended.has(sessionId) || epoch !== (this.epochs.get(sessionId) ?? 0)))
              )
                throw new SessionEnded(sessionId ?? 'process');
              pause();
              let result: unknown;
              try {
                result = Reflect.apply(value, target, args);
              } catch (error) {
                resume();
                throw error;
              }
              if (result instanceof Promise)
                return result.then((value) => wrapValue(value, sessionBound)).finally(resume);
              resume();
              // Children belong to the process lifetime, not the spawning session's epoch.
              return wrapValue(result, sessionBound && value !== context.process.spawn);
            };
          if (value instanceof Promise) {
            pause();
            return value.then((result) => wrapValue(result, sessionBound)).finally(resume);
          }
          if (value && typeof value === 'object')
            return wrap(value as Record<string, unknown>, sessionBound);
          return value;
        },
        set: (_object, key, value) => Reflect.set(target, key, value),
        deleteProperty: (_object, key) => Reflect.deleteProperty(target, key),
      }) as Record<string, unknown>;
    };
    const wrapValue = (value: unknown, sessionBound = true): unknown =>
      value && typeof value === 'object'
        ? wrap(value as Record<string, unknown>, sessionBound)
        : value;
    return wrap(context);
  }

  observe(event: ModEvent): Promise<void> {
    const previous = this.queues.get(event.sessionId) ?? Promise.resolve();
    const dispatch = previous.then(async () => {
      if (event.type === 'session.start') this.ended.delete(event.sessionId);
      await this.run(event.type, event, async () => undefined, true);
    });
    const settled = dispatch.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(event.sessionId, settled);
    void settled.then(() => {
      if (this.queues.get(event.sessionId) === settled) this.queues.delete(event.sessionId);
    });
    return dispatch;
  }

  intercept<T>(name: string, event: ModEvent, terminal: () => Promise<T>): Promise<T> {
    return this.run(name, event, terminal, false) as Promise<T>;
  }

  private run(name: string, event: ModEvent, terminal: Next, observer: boolean): Promise<unknown> {
    if (this.stopped || this.ended.has(event.sessionId))
      return Promise.reject(new SessionEnded(event.sessionId));
    const hooks = this.hooks.filter((hook) => hook.name === name);
    const invoke = async (index: number): Promise<unknown> => {
      if (index === hooks.length) return terminal();
      const hook = hooks[index];
      let remaining = this.options.timeouts?.hookMs ?? 10_000;
      let started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectTimeout: (error: Error) => void;
      let active = true;
      const expired = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
      });
      let paused = 0;
      const pause = () => {
        if (paused++ === 0) {
          clearTimeout(timer);
          remaining -= performance.now() - started;
        }
      };
      const resume = () => {
        if (paused > 0 && --paused > 0) return;
        if (!active) return;
        started = performance.now();
        timer = setTimeout(
          () => rejectTimeout(new ModTimeout(`hook ${hook.mod}:${name}`)),
          remaining,
        );
      };
      let called = false;
      const next = async () => {
        if (!active) throw new Error(`Hook already completed: ${hook.mod}:${name}`);
        if (called) throw new Error(`next() called twice: ${hook.mod}:${name}`);
        called = true;
        pause();
        try {
          return await invoke(index + 1);
        } finally {
          if (active) resume();
        }
      };
      const context = await this.context(hook, event.sessionId, pause, resume);
      resume();
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => hook.handler(context, event, next)),
          expired,
        ]);
        if (observer && !called) {
          active = false;
          clearTimeout(timer);
          await invoke(index + 1);
        }
        return result;
      } finally {
        active = false;
        clearTimeout(timer);
      }
    };
    return deadline(invoke(0), this.options.timeouts?.totalMs ?? 60_000, `dispatch ${name}`);
  }

  endSession(sessionId: string): void {
    this.ended.add(sessionId);
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.processes.shutdown();
  }
}
