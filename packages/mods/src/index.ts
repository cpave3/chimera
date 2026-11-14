import { mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModProcesses } from './process';
import { createStore } from './store';
import { validateModule } from './validate';

export interface ModEvent {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ModManifest {
  name: string;
  version: string;
  apiVersion: 1;
  module?: string;
  description?: string;
  mcpServers?: Record<string, ModMcpServer>;
  skills?: string;
  commands?: string;
  agents?: string;
  modes?: string;
}

export type ModMcpServer = (
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; clientId?: string }
) & { trustedTools?: string[]; subagents?: boolean };

export interface ModRecord {
  folder: string;
  source: 'flag' | 'env' | 'user';
  name?: string;
  version?: string;
  manifest?: ModManifest;
  status: 'loaded' | 'disabled' | 'failed' | 'duplicate' | 'unsupported-api';
  error?: string;
  hooks: string[];
}

const HOOK_NAMES = new Set([
  'session.start',
  'session.end',
  'turn.start',
  'turn.complete',
  'permission.request',
  'permission.resolved',
  'question.request',
  'question.resolved',
  'agent.spawn',
  'agent.finish',
  'background.start',
  'background.exit',
  'compaction.start',
  'compaction.end',
  'message.append',
  'tool.call',
  'turn.step',
  'prompt.submit',
  'turn.stop',
]);

function validBundleFields(manifest: Record<string, unknown>): boolean {
  for (const key of ['description', 'skills', 'commands', 'agents', 'modes']) {
    if (manifest[key] !== undefined && typeof manifest[key] !== 'string') return false;
  }
  const servers = manifest.mcpServers;
  if (servers === undefined) return true;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  return Object.values(servers).every((server) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
    if (server.subagents !== undefined && typeof server.subagents !== 'boolean') return false;
    if (server.trustedTools !== undefined && !strings(server.trustedTools)) return false;
    if (server.transport === 'http') {
      return (
        typeof server.url === 'string' &&
        (server.clientId === undefined || typeof server.clientId === 'string')
      );
    }
    if (server.transport !== 'stdio' || typeof server.command !== 'string') return false;
    if (server.args !== undefined && !strings(server.args)) return false;
    return (
      server.env === undefined ||
      (server.env &&
        typeof server.env === 'object' &&
        !Array.isArray(server.env) &&
        Object.values(server.env).every((value) => typeof value === 'string'))
    );
  });
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
  userDirectory?: string;
  disabled?: readonly string[];
  noMods?: boolean;
  sessionContext: (sessionId: string) => Record<string, unknown>;
  dataDirectory?: string;
  version?: string;
  serverUrl?: () => string;
  ui?: (
    text: string,
    options: { to: 'debug' | 'status' | 'scrollback' },
    sessionId?: string,
  ) => void | Promise<void>;
  warn?: (message: string) => void;
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
  const started = performance.now();
  const completed = work.then((value) => {
    if (performance.now() - started > milliseconds) throw new ModTimeout(label);
    return value;
  });
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ModTimeout(label)), milliseconds);
  });
  return Promise.race([completed, expired]).finally(() => clearTimeout(timer));
}

export class ModHost {
  private readonly hooks: Hook[] = [];
  private readonly queues = new Map<string | undefined, Promise<void>>();
  private readonly records: ModRecord[] = [];
  private readonly names = new Set<string>();
  private readonly ended = new Set<string>();
  private readonly epochs = new Map<string, number>();
  private stopped = false;
  private readonly processes = new ModProcesses();

  private constructor(private readonly options: ModHostOptions) {}

  static async create(options: ModHostOptions): Promise<ModHost> {
    const host = new ModHost(options);
    if (options.noMods) return host;
    for (const folder of options.folders ?? []) await host.load(folder, 'flag');
    for (const folder of (options.envDirs ?? process.env.CHIMERA_MOD_DIRS ?? '')
      .split(delimiter)
      .filter(Boolean)) {
      await host.load(folder, 'env');
    }
    const userDirectory = options.userDirectory ?? join(homedir(), '.chimera', 'mods');
    try {
      const entries = await readdir(userDirectory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      )) {
        if (entry.isDirectory() || entry.isSymbolicLink())
          await host.load(join(userDirectory, entry.name), 'user');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        host.options.warn?.(`Cannot read mods directory ${userDirectory}: ${error}`);
    }
    const failed = host.records.filter(
      ({ status }) => status === 'failed' || status === 'unsupported-api',
    ).length;
    if (failed)
      await options.ui?.(`${failed} mod${failed === 1 ? '' : 's'} failed – chimera mod list`, {
        to: 'status',
      });
    return host;
  }

  get mods(): readonly ModRecord[] {
    return this.records;
  }

  get registrations(): readonly Registration[] {
    return this.hooks.map(({ mod, name, folder }) => ({ mod, name, folder }));
  }

  private async load(folder: string, source: ModRecord['source']): Promise<void> {
    folder = resolve(folder);
    const record: ModRecord = { folder, source, status: 'failed', hooks: [] };
    this.records.push(record);
    let registering = true;
    try {
      const manifest = JSON.parse(await readFile(join(folder, 'chimera-mod.json'), 'utf8'));
      if (
        !manifest ||
        typeof manifest !== 'object' ||
        Array.isArray(manifest) ||
        typeof manifest.name !== 'string' ||
        !manifest.name ||
        typeof manifest.version !== 'string' ||
        !manifest.version ||
        !Number.isInteger(manifest.apiVersion) ||
        !validBundleFields(manifest) ||
        (manifest.module !== undefined && (typeof manifest.module !== 'string' || !manifest.module))
      ) {
        throw new Error(`Invalid mod manifest: ${folder}`);
      }
      record.name = manifest.name;
      record.version = manifest.version;
      record.manifest = manifest;
      if (this.names.has(manifest.name)) {
        record.status = 'duplicate';
        return;
      }
      this.names.add(manifest.name);
      if (source === 'user' && this.options.disabled?.includes(manifest.name)) {
        record.status = 'disabled';
        return;
      }
      if (manifest.apiVersion !== 1) {
        record.status = 'unsupported-api';
        throw new Error(`Unsupported mod apiVersion ${manifest.apiVersion}; supported: 1`);
      }
      if (manifest.module === undefined) {
        record.status = 'loaded';
        return;
      }
      const modulePath = resolve(folder, manifest.module);
      if (!modulePath.startsWith(folder + sep) || !['.mjs', '.mts'].includes(extname(modulePath))) {
        throw new Error(`Mod module must be a .mjs or .mts file inside its folder: ${folder}`);
      }
      const pending: Hook[] = [];
      const on: On = (name, handler) => {
        if (!registering) throw new Error(`Registration closed: ${manifest.name}`);
        if (!HOOK_NAMES.has(name) || typeof handler !== 'function')
          throw new Error(`Invalid hook registration: ${name}`);
        pending.push({ mod: manifest.name, name, folder, handler });
      };
      await deadline(
        (async () => {
          await validateModule(modulePath);
          const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
          if (typeof module.register !== 'function')
            throw new Error(`Missing register(on): ${folder}`);
          await module.register(on);
        })(),
        this.options.timeouts?.registrationMs ?? 5_000,
        `registration ${manifest.name}`,
      );
      this.hooks.push(...pending);
      record.hooks = pending.map(({ name }) => name);
      record.status = 'loaded';
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      this.options.warn?.(`Mod ${record.name ?? folder}: ${record.error}`);
    } finally {
      registering = false;
    }
  }

  private async context(
    hook: Hook,
    sessionId: string | undefined,
    pause: () => void,
    resume: () => void,
    usable: () => boolean,
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
          return this.options.ui?.(text, options, sessionId);
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
              if (!usable()) throw new ModTimeout(`hook ${hook.mod}`);
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
      if (event.type === 'session.start' && event.sessionId !== undefined) {
        this.ended.delete(event.sessionId);
      }
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
    if (this.stopped || (event.sessionId !== undefined && this.ended.has(event.sessionId)))
      return Promise.reject(new SessionEnded(event.sessionId ?? 'process'));
    const hooks = this.hooks.filter((hook) => hook.name === name);
    let terminalResult: Promise<unknown> | undefined;
    const finish = () => (terminalResult ??= Promise.resolve().then(terminal));
    let totalExpired = false;
    const cancel = new Set<() => void>();
    const invoke = async (index: number): Promise<unknown> => {
      if (totalExpired || index === hooks.length) return finish();
      const hook = hooks[index];
      let remaining = this.options.timeouts?.hookMs ?? 10_000;
      let started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectTimeout: (error: Error) => void;
      let active = true;
      let timedOut = false;
      const deactivate = () => {
        active = false;
        clearTimeout(timer);
      };
      cancel.add(deactivate);
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
      let downstream: Promise<unknown> | undefined;
      const next = async () => {
        if (!active) throw new Error(`Hook already completed: ${hook.mod}:${name}`);
        if (called) throw new Error(`next() called twice: ${hook.mod}:${name}`);
        called = true;
        pause();
        try {
          downstream = invoke(index + 1);
          return await downstream;
        } finally {
          if (active) resume();
        }
      };
      const context = await this.context(
        hook,
        event.sessionId,
        pause,
        resume,
        () => !timedOut && !totalExpired,
      );
      resume();
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => hook.handler(context, event, next)),
          expired,
        ]);
        if (paused === 0 && performance.now() - started > remaining) {
          throw new ModTimeout(`hook ${hook.mod}:${name}`);
        }
        if (observer) {
          active = false;
          clearTimeout(timer);
          await (downstream ?? invoke(index + 1));
        }
        return result;
      } catch (error) {
        if (!(error instanceof ModTimeout)) throw error;
        timedOut = true;
        deactivate();
        this.options.warn?.(error.message);
        return downstream ?? invoke(index + 1);
      } finally {
        deactivate();
        cancel.delete(deactivate);
      }
    };
    return deadline(invoke(0), this.options.timeouts?.totalMs ?? 60_000, `dispatch ${name}`).catch(
      (error) => {
        if (!(error instanceof ModTimeout)) throw error;
        totalExpired = true;
        for (const deactivate of cancel) deactivate();
        this.options.warn?.(error.message);
        return observer ? undefined : finish();
      },
    );
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
