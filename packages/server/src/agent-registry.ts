import type {
  Agent,
  AgentEvent,
  ModelConfig,
  PermissionGate,
  SandboxMode,
  Session,
  SessionId,
} from '@chimera/core';
import { EventBus } from './event-bus';

export interface SessionInit {
  cwd: string;
  model: ModelConfig;
  sandboxMode: SandboxMode;
  sessionId?: SessionId;
}

export interface BuildResult {
  agent: Agent;
  gate?: PermissionGate;
}

export interface AgentEntry {
  agent: Agent;
  gate?: PermissionGate;
  bus: EventBus;
  runActive: boolean;
  resolvedPermissionIds: Set<string>;
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

export interface AgentRegistryOptions {
  factory: AgentFactory;
  instance: InstanceInfo;
}

export class AgentRegistry {
  private readonly entries = new Map<SessionId, AgentEntry>();
  private readonly factory: AgentFactory;
  private readonly instance: InstanceInfo;

  constructor(opts: AgentRegistryOptions) {
    this.factory = opts.factory;
    this.instance = opts.instance;
  }

  getInstanceInfo(): InstanceInfo {
    return this.instance;
  }

  async create(init: SessionInit): Promise<{ sessionId: SessionId; entry: AgentEntry }> {
    const { agent, gate } = await this.factory.build(init);
    const bus = new EventBus(agent.session.id);
    const entry: AgentEntry = {
      agent,
      gate,
      bus,
      runActive: false,
      resolvedPermissionIds: new Set(),
    };
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
    const e = this.entries.get(id);
    if (!e) return false;
    e.agent.interrupt();
    this.entries.delete(id);
    return true;
  }

  /**
   * Start a message run for a session. Returns true on queued, false if a run
   * is already active.
   */
  async run(id: SessionId, content: string): Promise<'queued' | 'already-running' | 'missing'> {
    const e = this.entries.get(id);
    if (!e) return 'missing';
    if (e.runActive) return 'already-running';
    e.runActive = true;
    void (async () => {
      try {
        for await (const ev of e.agent.run(content)) {
          e.bus.publish(ev);
          if (ev.type === 'run_finished') break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const finished: AgentEvent = { type: 'run_finished', reason: 'error', error: msg };
        e.bus.publish(finished);
      } finally {
        e.runActive = false;
      }
    })();
    return 'queued';
  }
}
