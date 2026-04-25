import type { Command } from '@chimera/commands';
import type {
  AgentEvent,
  AgentEventEnvelope,
  EventId,
  ModelConfig,
  PermissionRule,
  RememberScope,
  SandboxMode,
  Session,
  SessionId,
} from '@chimera/core';
import type { Skill } from '@chimera/skills';
import { ChimeraHttpError, PermissionAlreadyResolvedError } from './errors';
import { parseSSE } from './sse';

export interface ChimeraClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Max auto-reconnects per subscribe/send loop. Default 3. */
  maxRetries?: number;
  /**
   * Deadline after which a still-pending permission request yields a synthetic
   * `permission_timeout` event. Default 5 minutes.
   */
  permissionTimeoutMs?: number;
}

export interface InstanceInfo {
  pid: number;
  cwd: string;
  version: string;
  sandboxMode: SandboxMode;
  parentId?: string;
}

export interface SubagentInfo {
  subagentId: string;
  sessionId: SessionId;
  url: string;
  purpose: string;
  status: 'running' | 'finished';
}

export interface CreateSessionOpts {
  cwd: string;
  model: ModelConfig;
  sandboxMode?: SandboxMode;
  sessionId?: SessionId;
}

export interface SubscribeOpts {
  sinceEventId?: EventId;
  signal?: AbortSignal;
}

export class ChimeraClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly permissionTimeoutMs: number;

  constructor(opts: ChimeraClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = opts.maxRetries ?? 3;
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? 5 * 60 * 1000;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      const body = await safeBody(res);
      throw new ChimeraHttpError(res.status, body, `${init?.method ?? 'GET'} ${path} → ${res.status}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  }

  async getInstance(): Promise<InstanceInfo> {
    return this.json<InstanceInfo>('/v1/instance');
  }

  async createSession(opts: CreateSessionOpts): Promise<{ sessionId: SessionId }> {
    return this.json('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    });
  }

  async listSessions(): Promise<Session[]> {
    return this.json<Session[]>('/v1/sessions');
  }

  async getSession(id: SessionId): Promise<Session> {
    return this.json<Session>(`/v1/sessions/${id}`);
  }

  async deleteSession(id: SessionId): Promise<void> {
    await this.json<void>(`/v1/sessions/${id}`, { method: 'DELETE' });
  }

  async interrupt(id: SessionId): Promise<void> {
    await this.json<void>(`/v1/sessions/${id}/interrupt`, { method: 'POST' });
  }

  /**
   * Reload session configuration (e.g., AGENTS.md/CLAUDE.md changes).
   * The server composes the new system prompt; this method accepts it
   * as an argument because the server may need additional context
   * (cwd, extensions) to compose it correctly.
   */
  async reloadSession(id: SessionId, systemPrompt: string): Promise<void> {
    await this.json<void>(`/v1/sessions/${id}/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt }),
    });
  }

  async resolvePermission(
    sessionId: SessionId,
    requestId: string,
    decision: 'allow' | 'deny',
    remember?: RememberScope,
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/sessions/${sessionId}/permissions/${requestId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, remember }),
      },
    );
    if (res.status === 409) {
      throw new PermissionAlreadyResolvedError(requestId);
    }
    if (!res.ok) {
      throw new ChimeraHttpError(res.status, await safeBody(res));
    }
  }

  async listRules(sessionId: SessionId): Promise<PermissionRule[]> {
    return this.json<PermissionRule[]>(`/v1/sessions/${sessionId}/permissions/rules`);
  }

  async addRule(
    sessionId: SessionId,
    rule: PermissionRule,
    scope: 'session' | 'project',
  ): Promise<void> {
    await this.json<void>(`/v1/sessions/${sessionId}/permissions/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule, scope }),
    });
  }

  async removeRule(sessionId: SessionId, index: number): Promise<void> {
    await this.json<void>(`/v1/sessions/${sessionId}/permissions/rules/${index}`, {
      method: 'DELETE',
    });
  }

  async listCommands(sessionId: SessionId): Promise<Command[]> {
    return this.json<Command[]>(`/v1/sessions/${sessionId}/commands`);
  }

  async listSkills(sessionId: SessionId): Promise<Skill[]> {
    return this.json<Skill[]>(`/v1/sessions/${sessionId}/skills`);
  }

  async listSubagents(sessionId: SessionId): Promise<SubagentInfo[]> {
    return this.json<SubagentInfo[]>(`/v1/sessions/${sessionId}/subagents`);
  }

  /**
   * Subscribe to the event stream first to avoid missing events, POST the
   * message once the SSE connection is established, then yield events until
   * `run_finished`.
   */
  async *send(
    sessionId: SessionId,
    message: string,
    opts: { signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentEvent | { type: 'permission_timeout'; requestId: string }, void, void> {
    // Open SSE connection up front.
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/sessions/${sessionId}/events`,
      { headers: { accept: 'text/event-stream' }, signal: opts.signal },
    );
    if (!res.ok) {
      throw new ChimeraHttpError(res.status, await safeBody(res));
    }

    // Give the server a microtask to register the subscriber before we POST.
    await new Promise((r) => setTimeout(r, 0));

    // POST the message.
    const postRes = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: message }),
      signal: opts.signal,
    });
    if (!postRes.ok && postRes.status !== 202) {
      throw new ChimeraHttpError(postRes.status, await safeBody(postRes));
    }

    // Iterate the already-open SSE.
    let lastEventId: string | undefined;
    try {
      for await (const env of parseSSE(res.body, (id) => {
        lastEventId = id;
      })) {
        yield stripEnvelopeMeta(env);
        if (env.type === 'run_finished') return;
      }
    } finally {
      // lastEventId unused here; kept in case future logic wants to resume.
      void lastEventId;
    }
  }

  /**
   * Subscribe to the SSE stream. Auto-reconnects up to `maxRetries` times,
   * passing the last-seen eventId as `since`.
   * Also emits a synthetic `permission_timeout` event if a
   * `permission_request` is not resolved within `permissionTimeoutMs`.
   */
  async *subscribe(
    sessionId: SessionId,
    opts: SubscribeOpts = {},
  ): AsyncGenerator<AgentEvent | { type: 'permission_timeout'; requestId: string }, void, void> {
    let lastEventId = opts.sinceEventId;
    let retries = 0;

    const pendingPermissionIds = new Set<string>();
    const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const timeoutQueue: { requestId: string }[] = [];

    try {
      while (true) {
        const url = lastEventId
          ? `${this.baseUrl}/v1/sessions/${sessionId}/events?since=${encodeURIComponent(lastEventId)}`
          : `${this.baseUrl}/v1/sessions/${sessionId}/events`;
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            headers: { accept: 'text/event-stream' },
            signal: opts.signal,
          });
        } catch (err) {
          if (retries >= this.maxRetries) throw err;
          retries += 1;
          await delay(Math.min(1000 * 2 ** (retries - 1), 5000));
          continue;
        }
        if (!res.ok) {
          throw new ChimeraHttpError(res.status, await safeBody(res));
        }

        try {
          for await (const env of parseSSE(res.body, (id) => {
            lastEventId = id;
          })) {
            // Permission tracking.
            if (env.type === 'permission_request') {
              pendingPermissionIds.add(env.requestId);
              const t = setTimeout(() => {
                if (pendingPermissionIds.has(env.requestId)) {
                  timeoutQueue.push({ requestId: env.requestId });
                }
              }, this.permissionTimeoutMs);
              pendingTimers.set(env.requestId, t);
            } else if (env.type === 'permission_resolved' || env.type === 'permission_timeout') {
              pendingPermissionIds.delete(env.requestId);
              const t = pendingTimers.get(env.requestId);
              if (t) clearTimeout(t);
              pendingTimers.delete(env.requestId);
            }
            yield stripEnvelopeMeta(env);

            // Drain any timeouts.
            while (timeoutQueue.length > 0) {
              const to = timeoutQueue.shift()!;
              if (pendingPermissionIds.has(to.requestId)) {
                pendingPermissionIds.delete(to.requestId);
                yield { type: 'permission_timeout', requestId: to.requestId };
              }
            }

            // subscribe() is a long-lived stream by design; do NOT terminate
            // on run_finished. The caller decides when to stop (via signal
            // abort, or by breaking out of the iterator).
          }
          // The server closed the stream cleanly. Try to reconnect with the
          // last-seen eventId so we don't miss events that fired during the
          // gap.
          if (opts.signal?.aborted) return;
          continue;
        } catch (err) {
          if (opts.signal?.aborted) return;
          if (retries >= this.maxRetries) throw err;
          retries += 1;
          await delay(Math.min(1000 * 2 ** (retries - 1), 5000));
        }
      }
    } finally {
      for (const t of pendingTimers.values()) clearTimeout(t);
    }
  }
}

function stripEnvelopeMeta(env: AgentEventEnvelope): AgentEvent {
  const { eventId: _e, sessionId: _s, ts: _t, ...rest } = env;
  return rest as AgentEvent;
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
