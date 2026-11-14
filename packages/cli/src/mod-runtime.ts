import { randomUUID } from 'node:crypto';
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
  private url = '';
  private unsubscribe = () => {};
  private readonly turns = new Map<string, string>();
  private readonly prompts = new Map<string, Promise<unknown>>();
  private readonly background = new Map<string, { description: string; background: boolean }>();

  static async create(
    options: ModOptions & { home?: string },
  ): Promise<ModRuntime> {
    const runtime = new ModRuntime();
    const logger = new Logger({ home: options.home });
    runtime.host = await ModHost.create({
      folders: options.modDirs,
      noMods: options.mods === false,
      serverUrl: () => runtime.url,
      sessionContext: (id) => runtime.context(id),
      warn: (message) => logger.warn(message),
      ui: (text) => logger.debug(text),
    });
    runtime.unsubscribe = lifecycleSource.subscribe(async (event) => {
      if (!runtime.registry?.get(event.sessionId as SessionId)) return;
      if (event.type === 'Stop') {
        const decision = await runtime.host.intercept<unknown>(
          'turn.stop',
          {
            type: 'turn.stop',
            sessionId: event.sessionId,
            reason: event.reason,
          },
          async () => ({ decision: 'pass' }),
        );
        if (
          decision &&
          typeof decision === 'object' &&
          'decision' in decision &&
          decision.decision === 'block'
        ) {
          return {
            blocked: true,
            reason: 'reason' in decision ? String(decision.reason) : 'Continue',
          };
        }
        return;
      }
      const mapped = runtime.map(event);
      if (!mapped) return;
      await runtime.host
        .observe(mapped)
        .catch((error) => logger.warn(`Mod observer failed: ${error}`));
      if (mapped.type === 'session.end') runtime.host.endSession(event.sessionId);
    });
    return runtime;
  }

  bind(registry: AgentRegistry, url: string): void {
    this.registry = registry;
    this.url = url;
  }

  private context(id: string): Record<string, unknown> {
    const entry = this.registry?.get(id as SessionId);
    if (!entry) throw new SessionEnded(id);
    const snapshot = entry.agent.snapshot();
    const readOnly = <T>(value: T): T => {
      if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) readOnly(nested);
        Object.freeze(value);
      }
      return value;
    };
    return {
      session: readOnly({
        id,
        name: snapshot.name,
        cwd: snapshot.cwd,
        status: snapshot.status,
        parentId: snapshot.parentId ?? this.registry!.getInstanceInfo().parentId ?? null,
        isSubagent: !!this.registry!.getInstanceInfo().parentId,
        model: snapshot.model,
        usage: snapshot.usage,
        messages: () => readOnly(entry.agent.snapshot().messages),
      }),
      prompt: { submit: ({ text }: { text: string }) => this.submit(id, text) },
      message: {
        append: async (text: string) => {
          const result = await this.registry!.injectMessage(id as SessionId, text);
          if (result === 'missing') throw new SessionEnded(id);
          if (result === 'already-running') throw new Error('Session is busy');
        },
      },
      turn: { abort: () => entry.agent.interrupt() },
    };
  }

  private submit(id: string, text: string): Promise<unknown> {
    const entry = this.registry?.get(id as SessionId);
    if (!entry) return Promise.reject(new SessionEnded(id));
    const queued = (entry.runActive && entry.agent.snapshot().status === 'running') || this.prompts.has(id);
    const previous = this.prompts.get(id) ?? Promise.resolve();
    const submitted = previous.then(async () => {
      while (true) {
        const current = this.registry?.get(id as SessionId);
        if (!current) throw new SessionEnded(id);
        if (current.activeRun) await current.activeRun;
        if (current.activeCompaction) await current.activeCompaction;
        if (
          !current.lifecycleActive ||
          current.lifecycleEnding ||
          this.registry!.get(id as SessionId) !== current
        ) {
          throw new SessionEnded(id);
        }
        let unsubscribe = () => {};
        const started = new Promise<unknown>((resolve) => {
          unsubscribe = current.bus.subscribe((event) => {
            if (event.type === 'user_message') {
              unsubscribe();
              resolve(queued ? { queued: true } : { accepted: true });
            } else if (event.type === 'prompt_dropped') {
              unsubscribe();
              resolve({ dropped: true, reason: event.reason });
            } else if (event.type === 'run_finished') {
              unsubscribe();
              resolve({ dropped: true, reason: event.error ?? event.reason });
            }
          });
        });
        try {
          const result = await this.registry!.run(id as SessionId, text);
          if (result === 'queued') return await started;
          if (result === 'missing') throw new SessionEnded(id);
        } finally {
          unsubscribe();
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    this.prompts.set(id, submitted);
    const cleanup = () => {
      if (this.prompts.get(id) === submitted) this.prompts.delete(id);
    };
    void submitted.then(cleanup, cleanup);
    return submitted;
  }

  private map(event: LifecycleEvent): ModEvent | undefined {
    const sessionId = event.sessionId;
    const payload = event as LifecycleEvent & Record<string, unknown>;
    switch (event.type) {
      case 'SessionStart':
        return {
          ...payload,
          type: 'session.start',
          sessionId,
          name: payload.session_name ?? payload.name,
          parentSessionId: payload.parentSessionId,
        };
      case 'SessionEnd':
        return { ...payload, type: 'session.end', sessionId, reason: payload.reason ?? 'delete' };
      case 'user_message': {
        const turnId = randomUUID();
        this.turns.set(sessionId, turnId);
        return { type: 'turn.start', sessionId, turnId, source: payload.source ?? 'user' };
      }
      case 'run_finished': {
        return {
          type: 'turn.complete',
          sessionId,
          turnId: this.turns.get(sessionId),
          reason: event.reason,
          error: event.error,
          model: payload.model,
          usage: payload.usage,
          contextFill: payload.contextFill,
        };
      }
      // The gate already dispatched this interception with its stable requestId.
      case 'permission_request':
        return undefined;
      case 'permission_resolved':
        return { ...payload, type: 'permission.resolved', sessionId };
      case 'question_request':
        return { ...payload, type: 'question.request', sessionId };
      case 'question_resolved':
        return { ...payload, type: 'question.resolved', sessionId };
      case 'compaction_started':
        return { ...payload, type: 'compaction.start', sessionId };
      case 'compaction_finished':
        return { ...payload, type: 'compaction.end', sessionId, success: true };
      case 'compaction_failed':
        return { ...payload, type: 'compaction.end', sessionId, success: false };
      case 'message_appended':
        return { type: 'message.append', sessionId, text: payload.text };
      case 'background_process_started':
        return { ...payload, type: 'background.start', sessionId, jobId: payload.shellId };
      case 'background_process_exited':
        return { ...payload, type: 'background.exit', sessionId, jobId: event.shellId };
      case 'subagent_spawned': {
        const child = { description: event.purpose, background: !!event.background };
        this.background.set(event.subagentId, child);
        return { type: 'agent.spawn', sessionId, agentId: event.subagentId, ...child };
      }
      case 'subagent_finished': {
        const child = this.background.get(event.subagentId);
        this.background.delete(event.subagentId);
        return {
          type: 'agent.finish',
          sessionId,
          agentId: event.subagentId,
          ...child,
          background: payload.background ?? child?.background,
          reason: event.reason,
          result: event.result,
        };
      }
    }
    return undefined;
  }

  async shutdown(): Promise<void> {
    this.unsubscribe();
    await this.host.shutdown();
  }
}
