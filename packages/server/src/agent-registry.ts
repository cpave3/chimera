import type { Command } from '@chimera/commands';
import {
  type Agent,
  type AgentEvent,
  type ModelConfig,
  type PermissionGate,
  type PromptSource,
  type SandboxMode,
  type Session,
  type SessionEndReason,
  type SessionId,
  type SessionStartReason,
  WorkspaceCheckpoints,
} from '@chimera/core';
import type { HookRunner } from '@chimera/hooks';
import type { Mode } from '@chimera/modes';
import type { Skill } from '@chimera/skills';
import { EventBus } from './event-bus';
import { bridgeHooksToLifecycle } from './hook-bridge';

export interface SessionInit {
  startReason?: SessionStartReason;
  cwd: string;
  model: ModelConfig;
  sandboxMode: SandboxMode;
  /** ID to load from persistence for an explicit resume. */
  sessionId?: SessionId;
  /** ID to use for a fresh session without loading persisted state. */
  requestedSessionId?: SessionId;
  /** Optional display name for a fresh session. */
  name?: string;
  /**
   * Extra absolute paths granted for read/write tool calls outside cwd.
   * Factory must merge these into its executor allow lists and set them
   * on the session for persistence.
   */
  additionalReadPaths?: string[];
  additionalWritePaths?: string[];
}

export interface BuildResult {
  agent: Agent;
  gate?: PermissionGate;
  /**
   * Shell-hook consumer for this session. The registry subscribes it to the
   * agent's lifecycle source. Optional for factories without shell hooks.
   */
  hookRunner?: HookRunner;
}

export interface SubagentInfo {
  subagentId: string;
  sessionId: SessionId;
  url: string;
  purpose: string;
  status: 'running' | 'finished';
}

export interface AgentEntry {
  agent: Agent;
  gate?: PermissionGate;
  hookRunner?: HookRunner;
  detachHooks?: () => void;
  lifecycleActive: boolean;
  lifecycleEnding: boolean;
  bus: EventBus;
  runActive: boolean;
  /**
   * Promise tracking the currently active run, if any. Awaited by
   * `delete()` so that the agent's final persistSession completes before the
   * caller tears down the session directory.
   */
  activeRun: Promise<void> | null;
  injectActive: boolean;
  compactionActive: boolean;
  /**
   * Promise tracking the currently active compaction, if any. Awaited by
   * `delete()` so compaction completes before the session directory is torn
   * down.
   */
  activeCompaction: Promise<void> | null;
  rewindActive: boolean;
  compactionCount: number;
  lastCompactedAt: number | null;
  resolvedPermissionIds: Set<string>;
  /**
   * Commands bound to this session at creation time. Captured once so that
   * mid-session filesystem changes do not affect what `listCommands` returns.
   */
  commands: Command[];
  /** Skills bound to this session at creation time. Same snapshot discipline. */
  skills: Skill[];
  /** Modes bound to this session at creation time. Same snapshot discipline. */
  modes: Mode[];
  /** Live subagents spawned by this session. Updated from the event bus. */
  subagents: Map<string, SubagentInfo>;
}

export interface InstanceInfo {
  pid: number;
  cwd: string;
  version: string;
  modApi: number[];
  sandboxMode: SandboxMode;
  parentId?: string;
}

/** Gives a session a message: into its run in progress, or as the start of a new run. */
export type MessageDelivery = (
  sessionId: SessionId,
  content: string,
) => Promise<'injected' | 'started' | 'missing' | 'busy'>;

export interface AgentFactory {
  build(init: SessionInit): Promise<BuildResult>;
  disposeSession?(sessionId: SessionId): Promise<void>;
  /**
   * Optional: the registry calls this once with a function that gives a
   * session a message from something other than its user, for example a
   * background subagent that ended.
   */
  setMessageDelivery?(deliver: MessageDelivery): void;
  /**
   * Optional: add a read or write directory for a live session.
   * Returns the absolute resolved path and whether it was newly added.
   */
  addSessionPath?(
    sessionId: SessionId,
    kind: 'read' | 'write',
    path: string,
  ): Promise<{ absolute: string; added: boolean }>;
}

export type CommandsLoader = (ctx: { cwd: string }) => Command[];

export type SkillsLoader = (ctx: { cwd: string }) => Skill[];

export type ModesLoader = (ctx: { cwd: string }) => Mode[];

export interface ModelListEntry {
  capabilities?: import('@chimera/core').ModelCapabilities;
  defaults?: import('@chimera/core').ModelSettings;
  ref: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  isDefault: boolean;
}

export type ModelsLoader = () => ModelListEntry[] | Promise<ModelListEntry[]>;

export interface AgentRegistryOptions {
  factory: AgentFactory;
  instance: Omit<InstanceInfo, 'modApi'>;
  /** Optional hook to load user commands at session-creation time. */
  loadCommands?: CommandsLoader;
  /** Optional hook to load skills at session-creation time. */
  loadSkills?: SkillsLoader;
  /** Optional hook to load modes at session-creation time. */
  loadModes?: ModesLoader;
  /** Optional hook to list available models for the API. */
  loadModels?: ModelsLoader;
  /** Chimera home dir override, used by workspace checkpoints. */
  home?: string;
  /**
   * Snapshot the session's working tree (shadow git) before each user
   * message, so /rewind can restore file state. Off unless explicitly
   * enabled — the CLI commands enable it from config.
   */
  workspaceCheckpoints?: boolean;
}

const DEFAULT_DELETE_TIMEOUT_MS = 10_000;
const DEFAULT_SWITCH_TIMEOUT_MS = 10_000;
// A compaction usually ends within a minute; a delivery waits that long for it.
const DELIVERY_ATTEMPTS = 120;
const DELIVERY_RETRY_MS = 500;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

export class AgentRegistry {
  private readonly entries = new Map<SessionId, AgentEntry>();
  private readonly factory: AgentFactory;
  private readonly instance: InstanceInfo;
  private readonly loadCommands?: CommandsLoader;
  private readonly loadSkills?: SkillsLoader;
  private readonly loadModes?: ModesLoader;
  private readonly loadModels?: ModelsLoader;
  private readonly home?: string;
  private readonly workspaceCheckpoints: boolean;
  private shutdownPromise: Promise<void> | null = null;

  constructor(opts: AgentRegistryOptions) {
    this.factory = opts.factory;
    this.instance = { ...opts.instance, modApi: [1] };
    this.loadCommands = opts.loadCommands;
    this.loadSkills = opts.loadSkills;
    this.loadModes = opts.loadModes;
    this.loadModels = opts.loadModels;
    this.home = opts.home;
    this.workspaceCheckpoints = opts.workspaceCheckpoints ?? false;
    this.factory.setMessageDelivery?.((sessionId, content) => this.deliver(sessionId, content));
  }

  /**
   * Best-effort working-tree snapshot before a user message runs. Failures
   * are logged inside WorkspaceCheckpoints and never block the run.
   */
  private async snapshotWorkspace(entry: AgentEntry, content: string): Promise<void> {
    if (!this.workspaceCheckpoints) return;
    const workspace = new WorkspaceCheckpoints({
      sessionId: entry.agent.session.id,
      cwd: entry.agent.session.cwd,
      home: this.home,
    });
    await workspace.snapshot(content);
  }

  private async fireOnError(entry: AgentEntry, error: string): Promise<void> {
    try {
      await entry.agent.dispatchLifecycle({ type: 'OnError', error });
    } catch (err) {
      console.debug(
        `[agent-registry] run(${entry.agent.session.id}): OnError hook rejection swallowed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  getInstanceInfo(): InstanceInfo {
    return this.instance;
  }

  listModels(): ModelListEntry[] | Promise<ModelListEntry[]> {
    return this.loadModels ? this.loadModels() : [];
  }

  async create(init: SessionInit): Promise<{ sessionId: SessionId; entry: AgentEntry }> {
    const { agent, gate, hookRunner } = await this.factory.build(init);
    const bus = new EventBus(agent.session.id);
    const commands = this.loadCommands ? this.loadCommands({ cwd: init.cwd }) : [];
    const skills = this.loadSkills ? this.loadSkills({ cwd: init.cwd }) : [];
    const modes = this.loadModes ? this.loadModes({ cwd: init.cwd }) : [];
    const subagents = new Map<string, SubagentInfo>();
    const entry: AgentEntry = {
      agent,
      gate,
      hookRunner,
      lifecycleActive: false,
      lifecycleEnding: false,
      bus,
      runActive: false,
      activeRun: null,
      injectActive: false,
      compactionActive: false,
      activeCompaction: null,
      rewindActive: false,
      compactionCount: 0,
      lastCompactedAt: null,
      resolvedPermissionIds: new Set(),
      commands,
      skills,
      modes,
      subagents,
    };
    if (hookRunner) {
      entry.detachHooks = bridgeHooksToLifecycle(agent.lifecycle, agent.session.id, hookRunner);
    }
    bus.subscribe((env) => {
      if (env.type === 'subagent_spawned') {
        subagents.set(env.subagentId, {
          subagentId: env.subagentId,
          sessionId: env.childSessionId,
          url: env.url,
          purpose: env.purpose,
          status: 'running',
        });
      } else if (env.type === 'subagent_finished') {
        // Drop on finish — `listSubagents` returns active children only.
        subagents.delete(env.subagentId);
      }
    });
    this.entries.set(agent.session.id, entry);
    bus.publish({ type: 'session_started', sessionId: agent.session.id });
    if (!init.sessionId) {
      await agent.dispatchLifecycle({
        type: 'SessionCreated',
        session_name: agent.session.name,
      });
    }
    await this.startSession(
      agent.session.id,
      init.startReason ?? (init.sessionId ? 'resume' : 'new'),
    );
    return { sessionId: agent.session.id, entry };
  }

  get(id: SessionId): AgentEntry | null {
    return this.entries.get(id) ?? null;
  }

  list(): Session[] {
    return Array.from(this.entries.values()).map((e) => e.agent.session);
  }

  async startSession(id: SessionId, reason: SessionStartReason): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || entry.lifecycleActive || entry.lifecycleEnding) return false;
    entry.lifecycleActive = true;
    await entry.agent.dispatchLifecycle({
      type: 'SessionStart',
      reason,
      session_name: entry.agent.session.name,
      parentSessionId: entry.agent.session.parentId ?? this.instance.parentId,
    });
    return true;
  }

  async endSession(id: SessionId, reason: SessionEndReason): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry?.lifecycleActive) return false;
    entry.lifecycleEnding = true;
    try {
      if (reason === 'switch') {
        entry.agent.interrupt();
        if (entry.activeRun) {
          await withTimeout(entry.activeRun, DEFAULT_SWITCH_TIMEOUT_MS, `switch(${id}) activeRun`);
          if (!entry.lifecycleActive) return false;
        }
      }
      entry.lifecycleActive = false;
      try {
        await entry.agent.dispatchLifecycle({ type: 'SessionEnd', reason });
      } catch (error) {
        console.error('[lifecycle] session end observer failed:', error);
      }
      return true;
    } finally {
      entry.lifecycleEnding = false;
    }
  }

  shutdown(reason: 'exit' | 'signal', timeoutMs = 2_000): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const entries = [...this.entries.values()];
    for (const entry of entries) {
      entry.lifecycleEnding = true;
      entry.agent.interrupt();
    }
    this.shutdownPromise = (async () => {
      try {
        await withTimeout(
          Promise.all(
            entries.map(async (entry) => {
              if (entry.activeRun) {
                try {
                  // Reserve half the shared window for SessionEnd, even if a
                  // provider ignores interruption and never settles its run.
                  await withTimeout(entry.activeRun, timeoutMs / 2, 'shutdown activeRun');
                } catch (error) {
                  console.debug('[lifecycle] ending run failed:', error);
                }
              }
              await this.endSession(entry.agent.session.id, reason);
            }),
          ),
          timeoutMs,
          'session shutdown',
        );
      } catch (error) {
        console.debug('[lifecycle] shutdown window ended:', error);
      } finally {
        for (const entry of entries) entry.hookRunner?.dispose?.();
      }
    })();
    return this.shutdownPromise;
  }

  async delete(id: SessionId): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.agent.interrupt();
    // Wait for any in-flight run (and its final persistSession) to settle so
    // the caller can safely tear down the session directory afterwards. Cap
    // with a timeout so a hung backend can't block SessionEnd forever.
    if (entry.activeRun) {
      try {
        await withTimeout(entry.activeRun, DEFAULT_DELETE_TIMEOUT_MS, `delete(${id}) activeRun`);
      } catch (err) {
        console.debug(
          `[agent-registry] delete(${id}): activeRun rejection/timed-out swallowed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    // Also wait for any active compaction to finish before tearing down.
    if (entry.activeCompaction) {
      try {
        await withTimeout(
          entry.activeCompaction,
          DEFAULT_DELETE_TIMEOUT_MS,
          `delete(${id}) activeCompaction`,
        );
      } catch (err) {
        console.debug(
          `[agent-registry] delete(${id}): activeCompaction rejection/timed-out swallowed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    await this.endSession(id, 'delete');
    entry.detachHooks?.();
    await this.factory.disposeSession?.(id);
    this.entries.delete(id);
    return true;
  }

  /**
   * Start a message run for a session. Returns `'queued'` on success,
   * `'already-running'` if a run is already active, and `'missing'` if the
   * session is not in the registry. Also returns `'already-running'` if a
   * compaction is currently active.
   */
  async run(
    id: SessionId,
    content: string,
    images?: string[],
    source: PromptSource = 'user',
  ): Promise<'queued' | 'already-running' | 'missing'> {
    const entry = this.entries.get(id);
    if (!entry) return 'missing';
    if (entry.runActive || entry.compactionActive || entry.rewindActive) return 'already-running';
    entry.runActive = true;
    entry.activeRun = (async () => {
      try {
        await this.snapshotWorkspace(entry, content);
        for await (const event of entry.agent.run(content, images, source)) {
          entry.bus.publish(event);
          if (event.type === 'run_finished') break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const finished: AgentEvent = {
          type: 'run_finished',
          reason: 'error',
          error: message,
        };
        await this.fireOnError(entry, message);
        entry.bus.publish(finished);
      } finally {
        entry.runActive = false;
        entry.activeRun = null;
      }
    })();
    return 'queued';
  }

  /**
   * Give a session a message that did not come from its user. During a run
   * the message joins the run at its next step boundary. Otherwise it starts
   * a run, so the agent acts on it without waiting for the user. A
   * compaction or a rewind holds the session for a moment; the delivery
   * waits for it and answers `'busy'` only when the wait runs out.
   */
  async deliver(
    id: SessionId,
    content: string,
  ): Promise<'injected' | 'started' | 'missing' | 'busy'> {
    for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt += 1) {
      const entry = this.entries.get(id);
      if (!entry) return 'missing';
      if (entry.runActive) {
        entry.agent.injectRunMessage(content);
        return 'injected';
      }
      const started = await this.run(id, content, undefined, 'background');
      if (started === 'queued') return 'started';
      if (started === 'missing') return 'missing';
      await new Promise((resolve) => setTimeout(resolve, DELIVERY_RETRY_MS));
    }
    return 'busy';
  }

  /**
   * Append a user message to the session history without invoking the LLM.
   * Returns `'injected'` on success, `'missing'` if the session is not found,
   * and `'already-running'` if a compaction, idle-inject, or rewind is active.
   *
   * When a run is active, the message is queued on the agent's mid-run
   * injection buffer and drained at the next clean step boundary — so the
   * model sees it after its current tool call finishes rather than only
   * after the whole run ends. The run loop emits the `user_message` event at
   * drain time, so no event is published here for the mid-run path.
   */
  async injectMessage(
    id: SessionId,
    content: string,
    images?: string[],
  ): Promise<'injected' | 'already-running' | 'missing'> {
    const entry = this.entries.get(id);
    if (!entry) return 'missing';
    if (entry.compactionActive || entry.injectActive || entry.rewindActive) {
      return 'already-running';
    }
    if (entry.runActive) {
      entry.agent.injectRunMessage(content, images, 'append');
      return 'injected';
    }
    entry.injectActive = true;
    try {
      await this.snapshotWorkspace(entry, content);
      await entry.agent.appendMessage(content, images);
    } catch (err) {
      if ((err as Error).message === 'Agent is already running') return 'already-running';
      throw err;
    } finally {
      entry.injectActive = false;
    }
    entry.bus.publish({ type: 'user_message', content });
    return 'injected';
  }

  /**
   * Force a compaction on a session. Returns `'queued'` on success,
   * `'already-running'` if a run or compaction is already active, and
   * `'missing'` if the session is not in the registry.
   */
  compact(id: SessionId): 'queued' | 'already-running' | 'missing' {
    const entry = this.entries.get(id);
    if (!entry) return 'missing';
    if (entry.runActive || entry.compactionActive || entry.injectActive || entry.rewindActive)
      return 'already-running';
    entry.compactionActive = true;
    entry.activeCompaction = (async () => {
      let success = false;
      try {
        for await (const event of entry.agent.compactSession()) {
          entry.bus.publish(event);
          if (event.type === 'compaction_finished') {
            success = true;
            break;
          }
          if (event.type === 'compaction_failed') break;
        }
        if (success) {
          entry.compactionCount += 1;
          entry.lastCompactedAt = Date.now();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        entry.bus.publish({ type: 'compaction_failed', error: message });
      } finally {
        entry.compactionActive = false;
        entry.activeCompaction = null;
      }
    })();
    return 'queued';
  }

  /**
   * Atomically acquire a rewind lock for a session. Returns `null` if the
   * entry doesn't exist, `'busy'` if run/compaction/inject/rewind is active,
   * or a release function on success. The caller MUST invoke `release()`.
   */
  tryAcquireRewind(id: SessionId): null | 'busy' | { release(): void } {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.runActive || entry.compactionActive || entry.injectActive || entry.rewindActive) {
      return 'busy';
    }
    entry.rewindActive = true;
    return {
      release: () => {
        entry.rewindActive = false;
      },
    };
  }

  async addSessionPath(
    sessionId: SessionId,
    kind: 'read' | 'write',
    path: string,
  ): Promise<{ absolute: string; added: boolean }> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error('not found');
    if (!entry.agent.session) throw new Error('not found');
    if (!this.factory.addSessionPath) {
      throw new Error('factory does not support runtime path mutation');
    }
    return this.factory.addSessionPath(sessionId, kind, path);
  }
}
