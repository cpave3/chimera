import type { Command } from '@chimera/commands';
import type { Mode } from '@chimera/modes';
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
  SessionInfo,
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

export interface ForkResponse {
  sessionId: SessionId;
  parentId: SessionId;
}

export type { SessionInfo } from '@chimera/core';

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
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      const body = await safeBody(response);
      throw new ChimeraHttpError(
        response.status,
        body,
        `${init?.method ?? 'GET'} ${path} → ${response.status}`,
      );
    }
    if (response.status === 204) return undefined as unknown as T;
    return (await response.json()) as T;
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

  async listSessions(): Promise<SessionInfo[]> {
    return this.json<SessionInfo[]>('/v1/sessions');
  }

  async getSession(id: SessionId): Promise<Session> {
    return this.json<Session>(`/v1/sessions/${id}`);
  }

  async deleteSession(id: SessionId): Promise<void> {
    await this.json<void>(`/v1/sessions/${id}`, { method: 'DELETE' });
  }

  async resumeSession(id: SessionId): Promise<{ sessionId: SessionId }> {
    return this.json<{ sessionId: SessionId }>(`/v1/sessions/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  }

  async forkSession(id: SessionId, purpose?: string): Promise<ForkResponse> {
    return this.json<ForkResponse>(`/v1/sessions/${id}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(purpose !== undefined ? { purpose } : {}),
    });
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
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/sessions/${sessionId}/permissions/${requestId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, remember }),
      },
    );
    if (response.status === 409) {
      throw new PermissionAlreadyResolvedError(requestId);
    }
    if (!response.ok) {
      throw new ChimeraHttpError(response.status, await safeBody(response));
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

  async listModes(sessionId: SessionId): Promise<Mode[]> {
    return this.json<Mode[]>(`/v1/sessions/${sessionId}/modes`);
  }

  async getMode(sessionId: SessionId): Promise<{ mode: string; pending: string | null }> {
    return this.json<{ mode: string; pending: string | null }>(`/v1/sessions/${sessionId}/mode`);
  }

  async setMode(sessionId: SessionId, mode: string): Promise<void> {
    await this.json<void>(`/v1/sessions/${sessionId}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
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
    const eventsResponse = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${sessionId}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: opts.signal,
    });
    if (!eventsResponse.ok) {
      throw new ChimeraHttpError(eventsResponse.status, await safeBody(eventsResponse));
    }

    // Give the server a microtask to register the subscriber before we POST.
    await new Promise((r) => setTimeout(r, 0));

    // POST the message.
    const postResponse = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: message }),
      signal: opts.signal,
    });
    if (!postResponse.ok && postResponse.status !== 202) {
      throw new ChimeraHttpError(postResponse.status, await safeBody(postResponse));
    }

    // Iterate the already-open SSE.
    let lastEventId: string | undefined;
    try {
      for await (const envelope of parseSSE(eventsResponse.body, (id) => {
        lastEventId = id;
      })) {
        yield stripEnvelopeMeta(envelope);
        if (envelope.type === 'run_finished') return;
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
        let streamResponse: Response;
        try {
          streamResponse = await this.fetchImpl(url, {
            headers: { accept: 'text/event-stream' },
            signal: opts.signal,
          });
        } catch (err) {
          if (retries >= this.maxRetries) throw err;
          retries += 1;
          await delay(Math.min(1000 * 2 ** (retries - 1), 5000));
          continue;
        }
        if (!streamResponse.ok) {
          throw new ChimeraHttpError(streamResponse.status, await safeBody(streamResponse));
        }

        try {
          for await (const envelope of parseSSE(streamResponse.body, (id) => {
            lastEventId = id;
          })) {
            // Permission tracking.
            if (envelope.type === 'permission_request') {
              pendingPermissionIds.add(envelope.requestId);
              const timer = setTimeout(() => {
                if (pendingPermissionIds.has(envelope.requestId)) {
                  timeoutQueue.push({ requestId: envelope.requestId });
                }
              }, this.permissionTimeoutMs);
              pendingTimers.set(envelope.requestId, timer);
            } else if (
              envelope.type === 'permission_resolved' ||
              envelope.type === 'permission_timeout'
            ) {
              pendingPermissionIds.delete(envelope.requestId);
              const timer = pendingTimers.get(envelope.requestId);
              if (timer) clearTimeout(timer);
              pendingTimers.delete(envelope.requestId);
            }
            yield stripEnvelopeMeta(envelope);
            // Successful delivery — clear the retry budget so transient
            // disconnects later in the session don't accumulate toward the
            // cap.
            retries = 0;

            // Drain any timeouts.
            while (timeoutQueue.length > 0) {
              const timeout = timeoutQueue.shift()!;
              if (pendingPermissionIds.has(timeout.requestId)) {
                pendingPermissionIds.delete(timeout.requestId);
                yield {
                  type: 'permission_timeout',
                  requestId: timeout.requestId,
                };
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
        } catch (err) {
          if (opts.signal?.aborted) return;
          if (retries >= this.maxRetries) throw err;
          retries += 1;
          await delay(Math.min(1000 * 2 ** (retries - 1), 5000));
        }
      }
    } finally {
      for (const timer of pendingTimers.values()) clearTimeout(timer);
    }
  }
}

function stripEnvelopeMeta(envelope: AgentEventEnvelope): AgentEvent {
  const { eventId: _e, sessionId: _s, ts: _t, ...rest } = envelope;
  return rest as AgentEvent;
}

async function safeBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
