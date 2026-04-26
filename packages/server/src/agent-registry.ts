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
  resolvedPermissionIds: Set<string>;
  /**
   * Commands bound to this session at creation time. Captured once so that
   * mid-session filesystem changes do not affect what `listCommands` returns.
   */
  commands: Command[];
  /** Skills bound to this session at creation time. Same snapshot discipline. */
  skills: Skill[];
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

export interface AgentRegistryOptions {
  factory: AgentFactory;
  instance: InstanceInfo;
  /** Optional hook to load user commands at session-creation time. */
  loadCommands?: CommandsLoader;
  /** Optional hook to load skills at session-creation time. */
  loadSkills?: SkillsLoader;
}

export class AgentRegistry {
  private readonly entries = new Map<SessionId, AgentEntry>();
  private readonly factory: AgentFactory;
  private readonly instance: InstanceInfo;
  private readonly loadCommands?: CommandsLoader;
  private readonly loadSkills?: SkillsLoader;

  constructor(opts: AgentRegistryOptions) {
    this.factory = opts.factory;
    this.instance = opts.instance;
    this.loadCommands = opts.loadCommands;
    this.loadSkills = opts.loadSkills;
  }

  getInstanceInfo(): InstanceInfo {
    return this.instance;
  }

  async create(init: SessionInit): Promise<{ sessionId: SessionId; entry: AgentEntry }> {
    const { agent, gate, hookRunner } = await this.factory.build(init);
    const bus = new EventBus(agent.session.id);
    const commands = this.loadCommands ? this.loadCommands({ cwd: init.cwd }) : [];
    const skills = this.loadSkills ? this.loadSkills({ cwd: init.cwd }) : [];
    const subagents = new Map<string, SubagentInfo>();
    const entry: AgentEntry = {
      agent,
      gate,
      hookRunner,
      bus,
      runActive: false,
      activeRun: null,
      resolvedPermissionIds: new Set(),
      commands,
      skills,
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
    // the caller can safely tear down the session directory afterwards.
    if (entry.activeRun) {
      try {
        await entry.activeRun;
      } catch {
        // run errors already surfaced via the event bus; we only need it done
      }
    }
    if (entry.hookRunner) {
      try {
        await entry.hookRunner.fire({ event: 'SessionEnd' });
      } catch {
        // Hook failures must not abort the session lifecycle.
      }
    }
    this.entries.delete(id);
    return true;
  }

  /**
   * Start a message run for a session. Returns true on queued, false if a run
   * is already active.
   */
  async run(id: SessionId, content: string): Promise<'queued' | 'already-running' | 'missing'> {
    const entry = this.entries.get(id);
    if (!entry) return 'missing';
    if (entry.runActive) return 'already-running';
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
}
