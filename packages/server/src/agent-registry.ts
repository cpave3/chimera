import type { Command } from '@chimera/commands';
import type {
  Agent,
  AgentEvent,
  ModelConfig,
  PermissionGate,
  SandboxMode,
  Session,
  SessionId,
} from '@chimera/core';
import type { HookRunner } from '@chimera/hooks';
import type { Mode } from '@chimera/modes';
import type { Skill } from '@chimera/skills';
import { EventBus } from './event-bus';
import { bridgeHooksToBus } from './hook-bridge';

export interface SessionInit {
  cwd: string;
  model: ModelConfig;
  sandboxMode: SandboxMode;
  /**
   * When set, the factory MUST call `loadSession(sessionId)` to populate
   * the new Agent's `messages` and `toolCalls`. This is the resume
   * contract: routes that pass `sessionId` (e.g. `POST /v1/sessions/:id/resume`)
   * rely on the factory honoring it.
   */
  sessionId?: SessionId;
}

export interface BuildResult {
  agent: Agent;
  gate?: PermissionGate;
  /**
   * Lifecycle-hook runner for this session. The registry wires it into the
   * event bus (firing UserPromptSubmit / PostToolUse / Stop) and fires
   * SessionEnd from `delete()`. Optional — factories that don't supply one
   * (e.g., subagent test factories) skip hook integration entirely.
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
  sandboxMode: SandboxMode;
  parentId?: string;
}

export interface AgentFactory {
  build(init: SessionInit): Promise<BuildResult>;
}

export type CommandsLoader = (ctx: { cwd: string }) => Command[];

export type SkillsLoader = (ctx: { cwd: string }) => Skill[];

export type ModesLoader = (ctx: { cwd: string }) => Mode[];

export interface AgentRegistryOptions {
  factory: AgentFactory;
  instance: InstanceInfo;
  /** Optional hook to load user commands at session-creation time. */
  loadCommands?: CommandsLoader;
  /** Optional hook to load skills at session-creation time. */
  loadSkills?: SkillsLoader;
  /** Optional hook to load modes at session-creation time. */
  loadModes?: ModesLoader;
}

const DEFAULT_DELETE_TIMEOUT_MS = 10_000;

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

  constructor(opts: AgentRegistryOptions) {
    this.factory = opts.factory;
    this.instance = opts.instance;
    this.loadCommands = opts.loadCommands;
    this.loadSkills = opts.loadSkills;
    this.loadModes = opts.loadModes;
  }

  getInstanceInfo(): InstanceInfo {
    return this.instance;
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
      bus,
      runActive: false,
      activeRun: null,
      injectActive: false,
      compactionActive: false,
      activeCompaction: null,
      compactionCount: 0,
      lastCompactedAt: null,
      resolvedPermissionIds: new Set(),
      commands,
      skills,
      modes,
      subagents,
    };
    if (hookRunner) {
      bridgeHooksToBus(bus, hookRunner);
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
    return { sessionId: agent.session.id, entry };
  }

  get(id: SessionId): AgentEntry | null {
    return this.entries.get(id) ?? null;
  }

  list(): Session[] {
    return Array.from(this.entries.values()).map((e) => e.agent.session);
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
    if (entry.hookRunner) {
      try {
        await entry.hookRunner.fire({ event: 'SessionEnd' });
      } catch (err) {
        // Hook failures must not abort the session lifecycle.
        console.debug(
          `[agent-registry] delete(${id}): SessionEnd hook rejection swallowed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    this.entries.delete(id);
    return true;
  }

  /**
   * Start a message run for a session. Returns `'queued'` on success,
   * `'already-running'` if a run is already active, and `'missing'` if the
   * session is not in the registry. Also returns `'already-running'` if a
   * compaction is currently active.
   */
  async run(id: SessionId, content: string): Promise<'queued' | 'already-running' | 'missing'> {
    const entry = this.entries.get(id);
    if (!entry) return 'missing';
    if (entry.runActive || entry.compactionActive) return 'already-running';
    entry.runActive = true;
    entry.activeRun = (async () => {
      try {
        for await (const event of entry.agent.run(content)) {
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
        entry.bus.publish(finished);
      } finally {
        entry.runActive = false;
        entry.activeRun = null;
      }
    })();
    return 'queued';
  }

  /**
   * Append a user message to the session history without invoking the LLM.
   * Returns `'injected'` on success, `'missing'` if the session is not found,
   * and `'already-running'` if a run is currently active.
   */
  async injectMessage(
    id: SessionId,
    content: string,
  ): Promise<'injected' | 'already-running' | 'missing'> {
    const entry = this.entries.get(id);
    if (!entry) return 'missing';
    if (entry.runActive || entry.compactionActive || entry.injectActive) return 'already-running';
    entry.injectActive = true;
    try {
      await entry.agent.appendMessage(content);
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
    if (entry.runActive || entry.compactionActive) return 'already-running';
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
}
