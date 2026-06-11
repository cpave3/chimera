import { resolve } from 'node:path';
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from 'ai';
import { EventQueue } from './event-queue';
import { type AgentEvent, type ToolDisplay } from './events';

export type ToolFormatter = (args: unknown, result?: unknown) => ToolDisplay;

import { type CallId, newCallId, newRequestId, newSessionId, type SessionId } from './ids';
import type { PermissionRequest, PermissionResolution } from './interfaces';
import {
  appendSessionEvent,
  forkSession,
  loadSession,
  persistSession,
  writeSessionMetadata,
} from './persistence';
import {
  type CompactionConfig,
  type CompactorApi,
  DEFAULT_SESSION_MODE,
  type ExecutionTarget,
  emptyUsage,
  type ModelConfig,
  type RememberScope,
  type SandboxMode,
  type Session,
  type ToolCallRecord,
  type UsageStep,
} from './types';
import { ContextTracker, shouldCompact } from './context-tracker';
import { applyStepUsage, cloneUsage, readStepUsage, reconcileFinalUsage } from './usage';

export interface StopHook {
  fire(payload: { reason: string }): Promise<{
    blocked: boolean;
    reason?: string;
    additionalContext?: string;
  }>;
}

export interface TimeoutHook {
  fire(): Promise<void>;
}

export interface InterruptHook {
  fire(): Promise<void>;
}

export interface AgentOptions {
  cwd: string;
  model: ModelConfig;
  languageModel: LanguageModel;
  tools: ToolSet;
  systemPrompt?: string;
  sandboxMode: SandboxMode;
  sessionId?: SessionId;
  session?: Session;
  /** Home directory for session persistence. Defaults to os.homedir(). */
  home?: string;
  /**
   * Resolved context window for the session's model, used to compute
   * "remaining budget" on `usage_updated` events. The factory resolves this
   * once via the provider/config table and passes it through.
   */
  contextWindow: number;
  /**
   * `true` when `contextWindow` came from the unknown-model fallback rather
   * than a config override or the built-in table. Surfaced on `usage_updated`
   * so the TUI can flag the value as approximate.
   */
  contextWindowIsApproximate?: boolean;
  /**
   * Optional hook: if a `read` tool call resolves to a known SKILL.md, returns
   * `{ skillName, source }` so the agent can emit `skill_activated`. Purely
   * observational; return value does not change tool behavior.
   */
  skillActivation?: (readPath: string) =>
    | {
        skillName: string;
        source: 'project' | 'user' | 'claude-compat';
      }
    | undefined;
  /** Initial mode for new sessions (no `session` provided). Defaults to "build". */
  initialMode?: string;
  /** Initial sticky user model override. Defaults to null. */
  initialUserModelOverride?: string | null;
  /**
   * Optional compaction configuration. When provided, the agent will invoke
   * `compactor.maybeCompact` before each `streamText` call.
   */
  compaction?: CompactionConfig;
  /**
   * Optional compactor instance. If `compaction` is also provided, this must
   * be set to the concrete compactor built from that config.  Used by
   * `compactSession()`.
   */
  compactor?: CompactorApi;
  /**
   * Optional stop hook. When provided, fired synchronously before the agent
   * emits `run_finished` with reason `"stop"`. If the hook returns
   * `blocked: true`, the agent appends a user message containing the block
   * reason and loops into a fresh LLM turn instead of finishing.
   */
  stopHook?: StopHook;
  /**
   * Optional timeout hook. When provided, fired synchronously when a step
   * exceeds `responseTimeoutMs` and the agent aborts. Purely observational;
   * the agent always proceeds to emit `run_finished { reason: "timeout" }`
   * after the hook resolves.
   */
  timeoutHook?: TimeoutHook;
  /**
   * Optional interrupt hook. When provided, fired synchronously when the
   * run terminates with reason `"interrupted"` (e.g. from `Agent.interrupt()`
   * or Ctrl+C in the TUI). Purely observational.
   */
  interruptHook?: InterruptHook;
  /**
   * Per-step wall-clock timeout for LLM `streamText` calls (ms).
   * A value of `0` disables the timeout. Defaults to 120000.
   */
  responseTimeoutMs?: number;
}

export type PermissionRaiseHandler = (req: PermissionRequest) => Promise<PermissionResolution>;

export class Agent {
  readonly session: Session;
  private opts: AgentOptions;
  private abortController: AbortController;
  private pendingPermissions = new Map<
    string,
    {
      resolve: (r: PermissionResolution) => void;
      request: PermissionRequest;
      rememberHandler?: (scope: RememberScope) => void;
    }
  >();
  private currentQueue: EventQueue<AgentEvent> | null = null;
  private running = false;
  private static readonly MAX_STOP_RETRIES = 5;
  private toolFormatters: Record<string, ToolFormatter> = {};
  /**
   * Maps the AI SDK's per-call `toolCallId` (a short string the SDK generates)
   * to the agent's own `CallId` for the same tool invocation. Tools that emit
   * out-of-band events (notably `spawn_agent`, which fires `subagent_spawned`)
   * use `resolveCallId(toolCallId)` to attribute their events to the parent
   * tool call so the TUI can nest sub-events under the right entry.
   */
  private callIdByToolCallId = new Map<string, CallId>();
  /**
   * Resolvers waiting for `toolCallId → CallId` to be registered. The AI SDK
   * fires `tool-call` events into `fullStream` in the same async tick that it
   * kicks off `execute()`, and when multiple tool calls land in parallel a
   * single microtask yield in the tool body isn't enough to guarantee the
   * agent's for-await consumer has populated `callIdByToolCallId` for *every*
   * pending call. Tools that need the mapping (notably `spawn_agent`, for
   * `subagent_spawned`'s `parentCallId`) use `awaitCallId(toolCallId)` to
   * block until the agent registers it.
   */
  private callIdWaiters = new Map<string, Array<(callId: CallId) => void>>();
  /**
   * Single-slot pending mode switch. Drained at the top of each run() so
   * mid-run requests take effect on the next turn (last-writer-wins).
   */
  private queuedMode: string | null = null;
  /**
   * Set when a mode switch leaves `plan` mode; consumed by the next run,
   * which appends a one-shot system note telling the model to record the
   * accepted plan via task_list before executing it.
   */
  private planHandoffPending = false;
  /** Real-usage projection of the next prompt size for compaction decisions. */
  private contextTracker = new ContextTracker();
  /** Mid-run compaction guard: require at least one step since the last one. */
  private stepsSinceCompaction = 1;
  /**
   * Latched when a threshold compaction fails or leaves the projection over
   * the trigger (e.g. a giant keep-tail) — prevents a compact-every-step
   * loop. Cleared at the next user turn.
   */
  private compactionIneffective = false;
  /**
   * Optional callback invoked when a queued mode switch is drained. Returns
   * the freshly-recomposed system prompt + filtered tool set + effective
   * model to apply for the next run. Embedders register it via
   * `setModeResolver()`.
   */
  private modeResolver?: (name: string) => {
    systemPrompt: string;
    tools: ToolSet;
    effectiveModel: string;
    effectiveModelChanged: boolean;
  };
  /**
   * Optional callback invoked when the user requests a runtime model change.
   * The factory (or embedder) registers this to resolve a new model ref into
   * a `LanguageModel`, its associated `ModelConfig` + `contextWindow`, and a
   * fresh system prompt (so the `# Chimera Session` block shows the current
   * model name).
   */
  private modelChangeResolver?: (ref: string) => {
    model: ModelConfig;
    languageModel: LanguageModel;
    contextWindow: number;
    contextWindowIsApproximate: boolean;
    systemPrompt: string;
  };

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.abortController = new AbortController();

    if (opts.session) {
      this.session = {
        ...opts.session,
        parentId: opts.session.parentId ?? null,
        children: opts.session.children ?? [],
        status: 'idle',
        usage: opts.session.usage ?? emptyUsage(),
        mode: opts.session.mode ?? DEFAULT_SESSION_MODE,
        userModelOverride: opts.session.userModelOverride ?? null,
        fileOps: opts.session.fileOps ?? { reads: new Set(), writes: new Set() },
        additionalReadPaths: opts.session.additionalReadPaths ?? [],
        additionalWritePaths: opts.session.additionalWritePaths ?? [],
        tasks: opts.session.tasks ?? [],
      };
    } else {
      this.session = {
        id: opts.sessionId ?? newSessionId(),
        parentId: null,
        children: [],
        cwd: opts.cwd,
        createdAt: Date.now(),
        messages: [],
        toolCalls: [],
        status: 'idle',
        model: opts.model,
        sandboxMode: opts.sandboxMode,
        usage: emptyUsage(),
        mode: opts.initialMode ?? DEFAULT_SESSION_MODE,
        userModelOverride: opts.initialUserModelOverride ?? null,
        fileOps: { reads: new Set(), writes: new Set() },
        additionalReadPaths: [],
        additionalWritePaths: [],
        tasks: [],
      };
    }
  }

  /**
   * Resume a previously persisted session from disk and construct an Agent
   * around it.
   */
  static async resume(
    opts: Omit<AgentOptions, 'session' | 'sessionId'> & { sessionId: SessionId },
  ): Promise<Agent> {
    const session = await loadSession(opts.sessionId, opts.home);
    return new Agent({ ...opts, session });
  }

  /**
   * Fork an existing session. Copies the parent's `events.jsonl`, appends a
   * `forked_from` marker to the child's log, and updates the parent's
   * `children[]`. Returns an Agent attached to the new child session.
   */
  static async fork(
    opts: Omit<AgentOptions, 'session' | 'sessionId'> & {
      parentSessionId: SessionId;
      purpose?: string;
    },
  ): Promise<Agent> {
    const { session } = await forkSession({
      parentId: opts.parentSessionId,
      purpose: opts.purpose,
      home: opts.home,
    });
    return new Agent({ ...opts, session });
  }

  /**
   * Called by PermissionGate (or any permission source) to raise a request.
   * Returns a promise that resolves when `resolvePermission` is called.
   */
  raisePermissionRequest(req: PermissionRequest): Promise<PermissionResolution> {
    return new Promise<PermissionResolution>((resolve) => {
      this.pendingPermissions.set(req.requestId, { resolve, request: req });
      this.session.status = 'waiting_for_permission';
      this.currentQueue?.push({
        type: 'permission_request',
        requestId: req.requestId,
        tool: req.tool,
        target: req.target,
        command: req.command,
        reason: req.reason,
      });
    });
  }

  /**
   * Register a handler called when the consumer resolves a permission with
   * a `remember` scope. The permissions package wires this up to addRule.
   */
  setRememberHandler(
    handler: (requestId: string, scope: RememberScope, req: PermissionRequest) => void,
  ): void {
    this.rememberHandler = handler;
  }

  private rememberHandler?: (
    requestId: string,
    scope: RememberScope,
    req: PermissionRequest,
  ) => void;

  resolvePermission(requestId: string, decision: 'allow' | 'deny', remember?: RememberScope): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request: ${requestId}`);
    }
    this.pendingPermissions.delete(requestId);

    if (remember && this.rememberHandler) {
      this.rememberHandler(requestId, remember, pending.request);
    }

    pending.resolve({ decision, remembered: !!remember });
    this.session.status = 'running';
    this.currentQueue?.push({
      type: 'permission_resolved',
      requestId,
      decision,
      remembered: !!remember,
    });
    void appendSessionEvent(
      this.session.id,
      {
        type: 'permission_resolved',
        requestId,
        decision,
        remembered: !!remember,
      },
      this.opts.home,
    ).catch(() => {
      // persistence errors are non-fatal
    });
  }

  hasPendingPermission(requestId: string): boolean {
    return this.pendingPermissions.has(requestId);
  }

  /**
   * Emit a `permission_resolved` event without going through the
   * raise/resolve dance. Used by the gate when the hook subsystem decides
   * the call before the user is ever prompted — there is no pending request
   * to settle, but the spec still requires the resolved event to fire.
   */
  emitPermissionResolved(requestId: string, decision: 'allow' | 'deny', remembered: boolean): void {
    this.currentQueue?.push({
      type: 'permission_resolved',
      requestId,
      decision,
      remembered,
    });
    void appendSessionEvent(
      this.session.id,
      {
        type: 'permission_resolved',
        requestId,
        decision,
        remembered,
      },
      this.opts.home,
    ).catch(() => {
      // persistence errors are non-fatal
    });
  }

  interrupt(): void {
    this.abortController.abort();
  }

  /**
   * The parent's AbortSignal for the current run. Tools that want to react to
   * `interrupt()` (e.g. `spawn_agent` cascading SIGTERM to its child) read it
   * via this getter rather than holding a reference to a stale controller.
   */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Push an arbitrary event onto the current run's stream. Used by tools that
   * need to emit out-of-band events (subagent spawn/finish, sub-stream
   * forwarding). No-op if no run is active.
   */
  pushEvent(event: AgentEvent): void {
    this.currentQueue?.push(event);
  }

  /**
   * Replace the tool set. Useful for breaking the tools ↔ permission-gate
   * construction cycle: build the Agent first, then the gate (which captures
   * `raisePermissionRequest`), then the tools that use the gate, then
   * `setTools` them back onto the Agent.
   */
  setTools(tools: ToolSet): void {
    this.opts = { ...this.opts, tools };
  }

  /**
   * Replace the system prompt. Called by the server when the user runs
   * `/reload` to pick up changes to AGENTS.md/CLAUDE.md files.
   */
  setSystemPrompt(systemPrompt: string): void {
    this.opts = { ...this.opts, systemPrompt };
  }

  /**
   * Register the embedder's mode-resolution callback. The callback is invoked
   * synchronously at the top of each `run()` when a switch is queued; it is
   * expected to (a) look the mode up in the registry, (b) recompose the
   * system prompt with the new mode block, (c) compute the filtered tool set,
   * and (d) report the effective model. Throwing from the resolver aborts the
   * switch — the agent stays in its previous mode.
   */
  setModeResolver(
    resolver: (name: string) => {
      systemPrompt: string;
      tools: ToolSet;
      effectiveModel: string;
      effectiveModelChanged: boolean;
    },
  ): void {
    this.modeResolver = resolver;
  }

  /**
   * Register the callback used to resolve a model ref into a concrete
   * `LanguageModel` + `ModelConfig` + `contextWindow` + fresh `systemPrompt`
   * at runtime. Called by the factory during session construction.
   */
  setModelChangeResolver(
    resolver: (ref: string) => {
      model: ModelConfig;
      languageModel: LanguageModel;
      contextWindow: number;
      contextWindowIsApproximate: boolean;
      systemPrompt: string;
    },
  ): void {
    this.modelChangeResolver = resolver;
  }

  /**
   * Set (or clear) the user model override. On an idle agent, this resolves
   * the new model via the registered `modelChangeResolver`, swaps the
   * session's model and languageModel, persists metadata, and returns `applied`.
   * On a running agent, returns `running` so the caller may surface a message.
   */
  setUserModelOverride(
    ref: string | null,
  ):
    | { status: 'applied'; from: string; to: string }
    | { status: 'running' }
    | { status: 'invalid'; error: string } {
    if (this.running) {
      return { status: 'running' };
    }
    const currentRef = `${this.session.model.providerId}/${this.session.model.modelId}`;
    const targetRef = ref ?? currentRef;
    if (targetRef === currentRef) {
      this.session.userModelOverride = ref;
      void writeSessionMetadata(this.session, this.opts.home).catch(() => {});
      return { status: 'applied', from: currentRef, to: targetRef };
    }
    if (!this.modelChangeResolver) {
      return { status: 'invalid', error: 'model change resolver not registered' };
    }
    let resolved: ReturnType<NonNullable<typeof this.modelChangeResolver>>;
    try {
      resolved = this.modelChangeResolver(targetRef);
    } catch (err) {
      return { status: 'invalid', error: (err as Error).message };
    }
    this.opts = {
      ...this.opts,
      model: resolved.model,
      languageModel: resolved.languageModel,
      systemPrompt: resolved.systemPrompt,
      contextWindow: resolved.contextWindow,
      contextWindowIsApproximate: resolved.contextWindowIsApproximate,
    };
    this.session.model = resolved.model;
    this.session.userModelOverride = ref;
    void writeSessionMetadata(this.session, this.opts.home).catch(() => {});
    return { status: 'applied', from: currentRef, to: targetRef };
  }

  /**
   * Queue a mode switch. If a run is active, the switch is queued (last-
   * writer-wins, single-slot) and drained at the top of the next `run()`.
   * If the agent is idle, the switch is applied immediately: the resolver
   * recomposes the system prompt + tools, the session snapshot is updated,
   * and the result is returned so the caller (typically the server) can
   * publish a `mode_changed` event on its event bus.
   *
   * Validation (registry membership, tool allowlist) happens inside the
   * resolver registered via `setModeResolver()`. Returns `{ status: 'invalid' }`
   * if the resolver throws.
   */
  queueModeSwitch(name: string):
    | { status: 'queued' }
    | { status: 'noop' }
    | {
        status: 'applied';
        from: string;
        to: string;
        effectiveModel: string;
        effectiveModelChanged: boolean;
      }
    | { status: 'invalid'; error: string } {
    if (name === this.session.mode) {
      // Noop check runs *before* the running guard so rapid Shift+Tab
      // presses can't queue a switch to the current mode (which would
      // briefly render `[mode:X → X]` in the chrome before the runtime
      // drain discards it).
      this.queuedMode = null;
      return { status: 'noop' };
    }
    if (this.running) {
      this.queuedMode = name;
      return { status: 'queued' };
    }
    if (!this.modeResolver) {
      const from = this.session.mode;
      if (from === 'plan') this.planHandoffPending = true;
      this.session.mode = name;
      this.queuedMode = null;
      return {
        status: 'applied',
        from,
        to: name,
        effectiveModel: `${this.session.model.providerId}/${this.session.model.modelId}`,
        effectiveModelChanged: false,
      };
    }
    let resolved: ReturnType<NonNullable<typeof this.modeResolver>>;
    try {
      resolved = this.modeResolver(name);
    } catch (err) {
      this.queuedMode = null;
      return { status: 'invalid', error: (err as Error).message };
    }
    const from = this.session.mode;
    if (from === 'plan') this.planHandoffPending = true;
    this.opts = {
      ...this.opts,
      systemPrompt: resolved.systemPrompt,
      tools: resolved.tools,
    };
    this.session.mode = name;
    this.queuedMode = null;
    void writeSessionMetadata(this.session, this.opts.home).catch(() => {});
    return {
      status: 'applied',
      from,
      to: name,
      effectiveModel: resolved.effectiveModel,
      effectiveModelChanged: resolved.effectiveModelChanged,
    };
  }

  /** The queued mode name, or null when no switch is pending. */
  get pendingMode(): string | null {
    return this.queuedMode;
  }

  /**
   * Register optional per-tool scrollback formatters keyed by tool name.
   * Called by the agent on tool_call_start/result to compute the `display`
   * payload that ships with each event. Errors thrown from a formatter are
   * caught and the event simply omits `display` — falling back to the
   * generic JSON-args rendering on the client.
   */
  setToolFormatters(formatters: Record<string, ToolFormatter>): void {
    this.toolFormatters = { ...formatters };
  }

  /**
   * Manually trigger a compaction on this session. Emits
   * `compaction_started`/`compaction_finished` (or `compaction_failed`) into
   * the returned event stream. Requires `opts.compactor` to be set.
   *
   * If no compactor is available (config disabled), the stream immediately
   * yields `compaction_failed { error: 'not configured' }`.
   */
  async *compactSession(): AsyncIterable<AgentEvent> {
    const compactor = this.opts.compactor;
    if (!compactor) {
      yield { type: 'compaction_failed', error: 'not configured' };
      return;
    }
    yield { type: 'compaction_started', reason: 'manual' };
    try {
      const result = await compactor.compact(this.session, 'manual');
      this.contextTracker.noteCompaction();
      yield {
        type: 'compaction_finished',
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        messagesReplaced: result.messagesReplaced,
        strategy: result.strategy,
        prunedCount: result.prunedCount,
        prunedTokensSaved: result.prunedTokensSaved,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      yield { type: 'compaction_failed', error };
    }
  }

  /**
   * Resolve a path relative to session.cwd, then track it in fileOps.  Called
   * after a read/write/edit tool result arrives.
   */
  private resolveAndTrackPath(args: unknown, write: boolean): void {
    const path = extractPathFromToolArgs(args);
    if (!path) return;
    const abs = resolve(this.session.cwd, path);
    if (write) {
      this.session.fileOps.writes.add(abs);
    } else {
      this.session.fileOps.reads.add(abs);
    }
  }

  /**
   * Translate an AI SDK `toolCallId` into the agent's `CallId` for the same
   * in-flight tool invocation. Returns `undefined` when no mapping exists
   * (e.g. the tool call has already produced its result/error and been
   * cleaned up). Used by tools that emit out-of-band events and need to
   * cite their parent tool call.
   */
  resolveCallId(toolCallId: string): CallId | undefined {
    return this.callIdByToolCallId.get(toolCallId);
  }

  /**
   * Wait for the agent to register `toolCallId → CallId`. Resolves immediately
   * if already mapped. Used by tools that fire out-of-band events whose
   * `parentCallId` must reference the in-flight call — without this, parallel
   * tool calls race the for-await consumer and one of them gets `undefined`
   * from `resolveCallId`, leaving the parent row orphaned in the TUI.
   */
  awaitCallId(toolCallId: string, signal?: AbortSignal): Promise<CallId> {
    const existing = this.callIdByToolCallId.get(toolCallId);
    if (existing) return Promise.resolve(existing);
    return new Promise<CallId>((resolve, reject) => {
      const list = this.callIdWaiters.get(toolCallId) ?? [];
      list.push(resolve);
      this.callIdWaiters.set(toolCallId, list);
      if (signal) {
        const onAbort = () => {
          const current = this.callIdWaiters.get(toolCallId);
          if (current) {
            const idx = current.indexOf(resolve);
            if (idx >= 0) current.splice(idx, 1);
            if (current.length === 0) this.callIdWaiters.delete(toolCallId);
          }
          reject(new Error('aborted'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private safeFormat(name: string, args: unknown, result?: unknown): ToolDisplay | undefined {
    const fmt = this.toolFormatters[name];
    if (!fmt) return undefined;
    try {
      return fmt(args, result);
    } catch {
      return undefined;
    }
  }

  snapshot(): Session {
    return JSON.parse(JSON.stringify(this.session)) as Session;
  }

  /**
   * Append a user message to the session without invoking the LLM.
   * Requires the agent to be idle (not running) to avoid corrupting
   * the message array the AI SDK may be reading.
   */
  async appendMessage(content: string): Promise<void> {
    if (this.running) {
      throw new Error('Agent is already running');
    }
    this.session.messages.push({ role: 'user', content });
    try {
      await persistSession(
        this.session,
        {
          type: 'message_appended',
          messages: this.session.messages,
          toolCalls: this.session.toolCalls,
          usage: cloneUsage(this.session.usage),
        },
        this.opts.home,
      );
    } catch {
      // best-effort persistence
    }
  }

  run(userMessage: string): AsyncIterable<AgentEvent> {
    if (this.running) {
      throw new Error('Agent is already running');
    }
    this.running = true;
    // Fresh abort controller per run.
    this.abortController = new AbortController();

    const queue = new EventQueue<AgentEvent>();
    this.currentQueue = queue;

    // Start the engine in the background; consumer drains the queue.
    void this.runInternal(userMessage, queue).finally(() => {
      queue.close();
      this.currentQueue = null;
      this.running = false;
    });

    return queue.drain();
  }

  /**
   * The system prompt actually sent to the model: the static mode prompt
   * plus live task-list state (so the list survives compaction in the
   * model's view, not just on disk) and the one-shot plan-handoff note.
   * Evaluated per step, so mid-run task updates are visible on the next step.
   */
  private composeSystemPrompt(planHandoff: boolean): string | undefined {
    const parts: string[] = [];
    if (this.opts.systemPrompt) parts.push(this.opts.systemPrompt);
    if (this.session.tasks.length > 0) {
      const lines = this.session.tasks.map((task) => `- [${task.status}] ${task.content}`);
      parts.push(
        '# Current tasks\n\n' +
          'Authoritative task-list state for this session (persisted outside the ' +
          'conversation; update it with the task_list tool):\n' +
          lines.join('\n'),
      );
    }
    if (planHandoff) {
      parts.push(
        '# Plan accepted\n\n' +
          'The user has just switched out of plan mode. If their message approves ' +
          'the plan you proposed, first record it with the task_list tool (one task ' +
          'per step, the first marked in_progress), then execute it step by step, ' +
          'updating statuses as you go. If they ask for changes instead, revise the ' +
          'plan before recording anything.',
      );
    }
    if (parts.length === 0) return undefined;
    return parts.join('\n\n');
  }

  /**
   * True when the projected next prompt crosses the compaction trigger.
   * Projection uses the provider's last reported inputTokens plus a char/4
   * estimate of messages appended since (pure estimate before the first
   * usage report and right after a compaction).
   */
  private overCompactionThreshold(): boolean {
    const config = this.opts.compaction;
    if (!config?.enabled || !this.opts.compactor) return false;
    return shouldCompact({
      projected: this.contextTracker.projectedNextPrompt(this.session.messages),
      contextWindow: this.opts.contextWindow,
      thresholdPercent: config.thresholdPercent ?? 85,
      reserveTokens: config.reserveTokens,
      maxOutputTokens: this.opts.model.maxOutputTokens,
    });
  }

  /**
   * Run a threshold compaction (at run start or between steps), emitting the
   * event pair and persisting a snapshot so a crash before the next step
   * cannot resurrect the pre-compaction history. Failure emits
   * `compaction_failed` and latches further attempts off for this turn —
   * a degraded run beats a dead one.
   */
  private async runThresholdCompaction(queue: EventQueue<AgentEvent>): Promise<void> {
    const compactor = this.opts.compactor;
    if (!compactor) return;
    queue.push({ type: 'compaction_started', reason: 'threshold' });
    try {
      const result = await compactor.compact(this.session, 'threshold');
      queue.push({
        type: 'compaction_finished',
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        messagesReplaced: result.messagesReplaced,
        strategy: result.strategy,
        prunedCount: result.prunedCount,
        prunedTokensSaved: result.prunedTokensSaved,
      });
      this.contextTracker.noteCompaction();
      this.stepsSinceCompaction = 0;
      if (this.overCompactionThreshold()) {
        this.compactionIneffective = true;
      }
      try {
        await persistSession(
          this.session,
          {
            type: 'message_appended',
            messages: this.session.messages,
            toolCalls: this.session.toolCalls,
            usage: cloneUsage(this.session.usage),
          },
          this.opts.home,
        );
      } catch {
        // Persistence errors must not crash the run.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      queue.push({ type: 'compaction_failed', error: message });
      this.compactionIneffective = true;
    }
  }

  private async runInternal(userMessage: string, queue: EventQueue<AgentEvent>): Promise<void> {
    this.session.status = 'running';

    // Drain any queued mode switch before the user message lands. The resolver
    // is responsible for recomposing the system prompt, filtering tools, and
    // resolving the effective model for the new mode. We then emit
    // `mode_changed` ahead of any other run-time event so consumers observe
    // the switch before they see effects of it.
    const queuedMode = this.queuedMode;
    if (queuedMode !== null && queuedMode !== this.session.mode) {
      this.queuedMode = null;
      try {
        if (this.modeResolver) {
          const resolved = this.modeResolver(queuedMode);
          const previousMode = this.session.mode;
          if (previousMode === 'plan') this.planHandoffPending = true;
          this.opts = {
            ...this.opts,
            systemPrompt: resolved.systemPrompt,
            tools: resolved.tools,
          };
          this.session.mode = queuedMode;
          queue.push({
            type: 'mode_changed',
            from: previousMode,
            to: queuedMode,
            reason: 'user',
            effectiveModel: resolved.effectiveModel,
            effectiveModelChanged: resolved.effectiveModelChanged,
          });
        } else {
          // Resolver missing → just record the mode on the session without
          // recomposing the prompt. Embedders that care about the system
          // prompt block always register a resolver.
          const previousMode = this.session.mode;
          if (previousMode === 'plan') this.planHandoffPending = true;
          this.session.mode = queuedMode;
          queue.push({
            type: 'mode_changed',
            from: previousMode,
            to: queuedMode,
            reason: 'user',
            effectiveModel: `${this.session.model.providerId}/${this.session.model.modelId}`,
            effectiveModelChanged: false,
          });
        }
      } catch (err) {
        // Validation failure: surface as a tool_call_error-shaped error event
        // is overkill — we just leave the mode unchanged and emit nothing.
        // The caller (TUI) gets the rejection from `setMode` synchronously.
        process.stderr.write(
          `[chimera] mode resolver rejected switch to "${queuedMode}": ${(err as Error).message}\n`,
        );
      }
    }

    // One-shot: a switch out of plan mode arms the handoff note for exactly
    // this run, telling the model to record the accepted plan via task_list.
    const planHandoff = this.planHandoffPending;
    this.planHandoffPending = false;

    this.session.messages.push({ role: 'user', content: userMessage });

    queue.push({ type: 'session_started', sessionId: this.session.id });

    // Resumed-session snapshot: if prior usage is non-zero, emit one
    // usage_updated immediately so consumers see the persisted totals before
    // any new step finishes.
    if (this.session.usage.totalTokens > 0) {
      queue.push({
        type: 'usage_updated',
        usage: cloneUsage(this.session.usage),
        contextWindow: this.opts.contextWindow,
        usedContextTokens: this.session.usage.lastStep?.inputTokens ?? 0,
        unknownWindow: this.opts.contextWindowIsApproximate ?? false,
      });
    }

    queue.push({ type: 'user_message', content: userMessage });

    // Compaction: a fresh user turn clears the ineffective latch, then the
    // same projection-based trigger used between steps runs once up front.
    this.compactionIneffective = false;
    if (this.overCompactionThreshold()) {
      await this.runThresholdCompaction(queue);
    }

    // Track accumulated assistant text per text-id to emit assistant_text_done.
    const textStreams = new Map<string, string>();
    // Most recent fully-emitted text content per text-id. Used to detect
    // replays: when a text-start arrives for an id whose content was already
    // emitted, we enter "shadow" mode and compare the new content against the
    // stored content. Identical -> silently suppressed. Different -> emitted
    // under a synthetic id so the TUI's id-aware dedup doesn't pop it.
    //
    // This handles two distinct cases that both surface as "missing final
    // text" in the TUI:
    //   - Cross-step id reuse (synthetic.new + Kimi/GLM restart ids at each
    //     `doStream`, so step N+1 legitimately reuses step N's id).
    //   - Same-step text -> tool-call -> text where the model emits both text
    //     blocks under the same id.
    const emittedTextById = new Map<string, string>();
    type ShadowState = { buf: string; syntheticId?: string };
    const shadows = new Map<string, ShadowState>();
    let syntheticTextCounter = 0;

    // Same machinery for reasoning parts (e.g. o1, o3-mini, DeepSeek-R1).
    const reasoningStreams = new Map<string, string>();
    const emittedReasoningById = new Map<string, string>();
    const reasoningShadows = new Map<string, ShadowState>();
    let syntheticReasoningCounter = 0;

    let stepNumber = 0;
    let terminalStepCount = 0;
    let terminalReason: 'stop' | 'max_steps' | 'error' | 'interrupted' | 'timeout' = 'stop';
    let errorMessage: string | undefined;
    let stopRetryCount = 0;

    while (true) {
      let usageMissingLogged = false;
      const maxTerminalSteps = this.opts.model.maxSteps;
      const safetyMaxIterations = Math.max(maxTerminalSteps * 5, 200);
      // True when the loop exhausted its iteration budget without a clean break.
      let hitSafetyCap = true;

      terminalReason = 'stop';
      errorMessage = undefined;
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      try {
        for (let iteration = 0; iteration < safetyMaxIterations; iteration++) {
          timedOut = false;
          timeoutHandle = undefined;
          // Map AI SDK tool call id -> our CallId, name, target for tool-result correlation.
          const callInfo = new Map<
            string,
            { callId: CallId; name: string; target: ExecutionTarget; startedAt: number }
          >();
          // True when the current step emitted at least one tool call. Used to
          // decide whether to loop again: tool-call steps are intermediate (the
          // model needs to see results), stop/length steps are terminal.
          let stepHadToolCalls = false;
          // Run-local accumulator of step deltas, used to reconcile against the
          // terminal `finish.totalUsage` if the two disagree.
          const runDelta: UsageStep = {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 0,
          };

          const responseTimeoutMs = this.opts.responseTimeoutMs ?? 120_000;
          if (responseTimeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              this.abortController.abort();
            }, responseTimeoutMs);
          }

          // Message count the prompt was built from; pairs with the step's
          // reported inputTokens in the context tracker.
          const messageCountAtPrompt = this.session.messages.length;
          const stream = streamText({
            model: this.opts.languageModel,
            messages: this.session.messages,
            tools: this.opts.tools,
            system: this.composeSystemPrompt(planHandoff),
            stopWhen: stepCountIs(1),
            abortSignal: this.abortController.signal,
            temperature: this.opts.model.temperature,
            maxOutputTokens: this.opts.model.maxOutputTokens,
          });

          for await (const part of stream.fullStream) {
            switch (part.type) {
              case 'text-start': {
                // Flush an unconcluded text block before starting a new one.
                // Some providers reuse the same id mid-step (text -> tool-call
                // -> text) without sending text-end for the first block.
                const activeText = textStreams.get(part.id);
                if (activeText !== undefined && activeText.length > 0) {
                  queue.push({ type: 'assistant_text_done', id: part.id, text: activeText });
                  emittedTextById.set(part.id, activeText);
                  textStreams.delete(part.id);
                }
                const shadow = shadows.get(part.id);
                if (shadow) {
                  shadows.delete(part.id);
                  if (shadow.syntheticId) {
                    queue.push({
                      type: 'assistant_text_done',
                      id: shadow.syntheticId,
                      text: shadow.buf,
                    });
                    emittedTextById.set(part.id, shadow.buf);
                  } else if (shadow.buf.length > 0) {
                    syntheticTextCounter += 1;
                    const syntheticId = `${part.id}#${syntheticTextCounter}`;
                    queue.push({
                      type: 'assistant_text_delta',
                      id: syntheticId,
                      delta: shadow.buf,
                    });
                    queue.push({
                      type: 'assistant_text_done',
                      id: syntheticId,
                      text: shadow.buf,
                    });
                    emittedTextById.set(part.id, shadow.buf);
                  }
                }
                if (emittedTextById.has(part.id)) {
                  shadows.set(part.id, { buf: '' });
                } else {
                  textStreams.set(part.id, '');
                }
                break;
              }
              case 'text-delta': {
                const shadow = shadows.get(part.id);
                if (shadow) {
                  shadow.buf += part.text;
                  if (shadow.syntheticId) {
                    queue.push({
                      type: 'assistant_text_delta',
                      id: shadow.syntheticId,
                      delta: part.text,
                    });
                  } else {
                    const stored = emittedTextById.get(part.id) ?? '';
                    if (!stored.startsWith(shadow.buf)) {
                      syntheticTextCounter += 1;
                      shadow.syntheticId = `${part.id}#${syntheticTextCounter}`;
                      queue.push({
                        type: 'assistant_text_delta',
                        id: shadow.syntheticId,
                        delta: shadow.buf,
                      });
                    }
                  }
                  break;
                }
                textStreams.set(part.id, (textStreams.get(part.id) ?? '') + part.text);
                queue.push({ type: 'assistant_text_delta', id: part.id, delta: part.text });
                break;
              }
              case 'text-end': {
                const shadow = shadows.get(part.id);
                if (shadow) {
                  shadows.delete(part.id);
                  if (shadow.syntheticId) {
                    queue.push({
                      type: 'assistant_text_done',
                      id: shadow.syntheticId,
                      text: shadow.buf,
                    });
                    emittedTextById.set(part.id, shadow.buf);
                  } else if (shadow.buf.length > 0 && shadow.buf !== emittedTextById.get(part.id)) {
                    // Buf is a strict prefix of stored content — model emitted a
                    // shorter "new" text under the same id. Surface it as new.
                    syntheticTextCounter += 1;
                    const syntheticId = `${part.id}#${syntheticTextCounter}`;
                    queue.push({
                      type: 'assistant_text_delta',
                      id: syntheticId,
                      delta: shadow.buf,
                    });
                    queue.push({
                      type: 'assistant_text_done',
                      id: syntheticId,
                      text: shadow.buf,
                    });
                    emittedTextById.set(part.id, shadow.buf);
                  }
                  break;
                }
                const full = textStreams.get(part.id) ?? '';
                textStreams.delete(part.id);
                if (full.length > 0) {
                  queue.push({ type: 'assistant_text_done', id: part.id, text: full });
                  emittedTextById.set(part.id, full);
                }
                break;
              }
              case 'reasoning-start': {
                // Same provider quirk as text-start: mid-step id reuse without reasoning-end.
                const activeReasoning = reasoningStreams.get(part.id);
                if (activeReasoning !== undefined && activeReasoning.length > 0) {
                  queue.push({ type: 'reasoning_text_done', id: part.id, text: activeReasoning });
                  emittedReasoningById.set(part.id, activeReasoning);
                  reasoningStreams.delete(part.id);
                }
                const reasoningShadow = reasoningShadows.get(part.id);
                if (reasoningShadow) {
                  reasoningShadows.delete(part.id);
                  if (reasoningShadow.syntheticId) {
                    queue.push({
                      type: 'reasoning_text_done',
                      id: reasoningShadow.syntheticId,
                      text: reasoningShadow.buf,
                    });
                    emittedReasoningById.set(part.id, reasoningShadow.buf);
                  } else if (reasoningShadow.buf.length > 0) {
                    syntheticReasoningCounter += 1;
                    const syntheticId = `${part.id}#${syntheticReasoningCounter}`;
                    queue.push({
                      type: 'reasoning_text_delta',
                      id: syntheticId,
                      delta: reasoningShadow.buf,
                    });
                    queue.push({
                      type: 'reasoning_text_done',
                      id: syntheticId,
                      text: reasoningShadow.buf,
                    });
                    emittedReasoningById.set(part.id, reasoningShadow.buf);
                  }
                }
                if (emittedReasoningById.has(part.id)) {
                  reasoningShadows.set(part.id, { buf: '' });
                } else {
                  reasoningStreams.set(part.id, '');
                }
                break;
              }
              case 'reasoning-delta': {
                const reasoningShadow = reasoningShadows.get(part.id);
                if (reasoningShadow) {
                  reasoningShadow.buf += part.text;
                  if (reasoningShadow.syntheticId) {
                    queue.push({
                      type: 'reasoning_text_delta',
                      id: reasoningShadow.syntheticId,
                      delta: part.text,
                    });
                  } else {
                    const stored = emittedReasoningById.get(part.id) ?? '';
                    if (!stored.startsWith(reasoningShadow.buf)) {
                      syntheticReasoningCounter += 1;
                      reasoningShadow.syntheticId = `${part.id}#${syntheticReasoningCounter}`;
                      queue.push({
                        type: 'reasoning_text_delta',
                        id: reasoningShadow.syntheticId,
                        delta: reasoningShadow.buf,
                      });
                    }
                  }
                  break;
                }
                reasoningStreams.set(
                  part.id,
                  (reasoningStreams.get(part.id) ?? '') + part.text,
                );
                queue.push({ type: 'reasoning_text_delta', id: part.id, delta: part.text });
                break;
              }
              case 'reasoning-end': {
                const reasoningShadow = reasoningShadows.get(part.id);
                if (reasoningShadow) {
                  reasoningShadows.delete(part.id);
                  if (reasoningShadow.syntheticId) {
                    queue.push({
                      type: 'reasoning_text_done',
                      id: reasoningShadow.syntheticId,
                      text: reasoningShadow.buf,
                    });
                    emittedReasoningById.set(part.id, reasoningShadow.buf);
                  } else if (
                    reasoningShadow.buf.length > 0 &&
                    reasoningShadow.buf !== emittedReasoningById.get(part.id)
                  ) {
                    syntheticReasoningCounter += 1;
                    const syntheticId = `${part.id}#${syntheticReasoningCounter}`;
                    queue.push({
                      type: 'reasoning_text_delta',
                      id: syntheticId,
                      delta: reasoningShadow.buf,
                    });
                    queue.push({
                      type: 'reasoning_text_done',
                      id: syntheticId,
                      text: reasoningShadow.buf,
                    });
                    emittedReasoningById.set(part.id, reasoningShadow.buf);
                  }
                  break;
                }
                const reasoningFull = reasoningStreams.get(part.id) ?? '';
                reasoningStreams.delete(part.id);
                if (reasoningFull.length > 0) {
                  queue.push({ type: 'reasoning_text_done', id: part.id, text: reasoningFull });
                  emittedReasoningById.set(part.id, reasoningFull);
                }
                break;
              }
              case 'tool-call': {
                const callId = newCallId();
                const args = (part as { input?: unknown }).input;
                const target = extractTarget(args, this.session.sandboxMode);
                const record: ToolCallRecord = {
                  callId,
                  name: part.toolName,
                  args,
                  target,
                  startedAt: Date.now(),
                };
                this.session.toolCalls.push(record);
                callInfo.set(part.toolCallId, {
                  callId,
                  name: part.toolName,
                  target,
                  startedAt: record.startedAt,
                });
                this.callIdByToolCallId.set(part.toolCallId, callId);
                const waiters = this.callIdWaiters.get(part.toolCallId);
                if (waiters) {
                  this.callIdWaiters.delete(part.toolCallId);
                  for (const w of waiters) w(callId);
                }
                stepHadToolCalls = true;
                queue.push({
                  type: 'tool_call_start',
                  callId,
                  name: part.toolName,
                  args,
                  target,
                  display: this.safeFormat(part.toolName, args),
                });
                break;
              }
              case 'tool-result': {
                const info = callInfo.get(part.toolCallId);
                if (!info) break;
                const result = (part as { output?: unknown }).output;
                const rec = this.session.toolCalls.find((t) => t.callId === info.callId);
                if (rec) {
                  rec.result = result;
                  rec.endedAt = Date.now();
                }
                queue.push({
                  type: 'tool_call_result',
                  callId: info.callId,
                  result,
                  durationMs: Date.now() - info.startedAt,
                  display: this.safeFormat(info.name, rec?.args, result),
                });
                if (info.name === 'read' && this.opts.skillActivation) {
                  const readPath = extractReadPath(rec?.args);
                  if (readPath) {
                    const hit = this.opts.skillActivation(readPath);
                    if (hit) {
                      queue.push({
                        type: 'skill_activated',
                        skillName: hit.skillName,
                        source: hit.source,
                      });
                    }
                  }
                }
                if (info.name === 'read') {
                  this.resolveAndTrackPath(rec?.args, false);
                } else if (info.name === 'write' || info.name === 'edit') {
                  this.resolveAndTrackPath(rec?.args, true);
                }
                callInfo.delete(part.toolCallId);
                this.callIdByToolCallId.delete(part.toolCallId);
                break;
              }
              case 'tool-error': {
                const info = callInfo.get(part.toolCallId);
                if (!info) break;
                const errorValue = (part as { error?: unknown }).error;
                const message =
                  errorValue instanceof Error ? errorValue.message : String(errorValue);
                const record = this.session.toolCalls.find(
                  (toolCall) => toolCall.callId === info.callId,
                );
                if (record) {
                  record.error = message;
                  record.endedAt = Date.now();
                }
                queue.push({ type: 'tool_call_error', callId: info.callId, error: message });
                callInfo.delete(part.toolCallId);
                this.callIdByToolCallId.delete(part.toolCallId);
                break;
              }
              case 'finish-step': {
                stepNumber += 1;
                queue.push({
                  type: 'step_finished',
                  stepNumber,
                  finishReason: part.finishReason,
                });
                this.stepsSinceCompaction += 1;
                const stepUsage = readStepUsage((part as { usage?: unknown }).usage);
                if (stepUsage) {
                  this.contextTracker.noteUsage(stepUsage.inputTokens, messageCountAtPrompt);
                  applyStepUsage(this.session.usage, stepUsage);
                  runDelta.inputTokens += stepUsage.inputTokens;
                  runDelta.outputTokens += stepUsage.outputTokens;
                  runDelta.cachedInputTokens += stepUsage.cachedInputTokens;
                  runDelta.totalTokens += stepUsage.totalTokens;
                  queue.push({
                    type: 'usage_updated',
                    usage: cloneUsage(this.session.usage),
                    contextWindow: this.opts.contextWindow,
                    usedContextTokens: stepUsage.inputTokens,
                    unknownWindow: this.opts.contextWindowIsApproximate ?? false,
                  });
                } else if (!usageMissingLogged) {
                  usageMissingLogged = true;
                  // Provider does not report usage on this step. Log once per
                  // session at debug level; the loop continues with stale totals.
                  if (typeof process !== 'undefined' && process.env?.DEBUG) {
                    process.stderr.write(
                      `[chimera] debug: model ${this.session.model.providerId}/${this.session.model.modelId} did not report usage on finish-step\n`,
                    );
                  }
                }
                try {
                  await persistSession(
                    this.session,
                    {
                      type: 'step_finished',
                      stepNumber,
                      finishReason: part.finishReason,
                      messages: this.session.messages,
                      toolCalls: this.session.toolCalls,
                      usage: cloneUsage(this.session.usage),
                    },
                    this.opts.home,
                  );
                } catch (_e) {
                  // persistence errors should not crash the run
                }
                break;
              }
              case 'finish': {
                const total = readStepUsage((part as { totalUsage?: unknown }).totalUsage);
                if (reconcileFinalUsage(this.session.usage, runDelta, total)) {
                  queue.push({
                    type: 'usage_updated',
                    usage: cloneUsage(this.session.usage),
                    contextWindow: this.opts.contextWindow,
                    usedContextTokens: this.session.usage.inputTokens,
                    unknownWindow: this.opts.contextWindowIsApproximate ?? false,
                  });
                }
                break;
              }
              case 'abort': {
                terminalReason = timedOut ? 'timeout' : 'interrupted';
                break;
              }
              case 'error': {
                terminalReason = 'error';
                errorMessage =
                  part.error instanceof Error ? part.error.message : String(part.error);
                break;
              }
              default:
                // Ignore source, file, tool-input-*, start/start-step, raw.
                break;
            }
          }

          if (timeoutHandle) clearTimeout(timeoutHandle);
          timeoutHandle = undefined;

          // After the stream finishes, attach response messages.
          const response = await stream.response;
          if (response && Array.isArray(response.messages)) {
            this.session.messages.push(...(response.messages as ModelMessage[]));
          }

          if (terminalReason !== 'stop') {
            // Interrupted or errored during the stream
            break;
          }

          const finishReason = await stream.finishReason;

          if (stepHadToolCalls) {
            // Intermediate step — the model emitted tool calls and needs to
            // consume results. Compact here if the projected next prompt
            // crosses the trigger, so long tool loops never die on a
            // context-window overflow mid-run.
            if (
              this.stepsSinceCompaction >= 1 &&
              !this.compactionIneffective &&
              this.overCompactionThreshold()
            ) {
              await this.runThresholdCompaction(queue);
            }
            continue;
          }

          // Terminal step
          terminalStepCount += 1;

          if (finishReason === 'length') {
            terminalReason = 'max_steps';
          }

          if (terminalStepCount > maxTerminalSteps) {
            terminalReason = 'max_steps';
          }

          hitSafetyCap = false;
          break;
        }

        if (hitSafetyCap && terminalReason === 'stop') {
          terminalReason = 'max_steps';
        }

        // The AI SDK only exposes the assistant + tool messages from the run
        // via `await stream.response` *after* the stream completes — so the
        // per-step `step_finished` events persisted during the loop captured
        // a snapshot that still only had the user message. Emit one more
        // `step_finished` here, carrying the now-complete `messages` /
        // `toolCalls`, so resume can see the full conversation.
        try {
          await persistSession(
            this.session,
            {
              type: 'step_finished',
              stepNumber,
              finishReason: terminalReason === 'stop' ? 'stop' : terminalReason,
              messages: this.session.messages,
              toolCalls: this.session.toolCalls,
              usage: cloneUsage(this.session.usage),
            },
            this.opts.home,
          );
        } catch {
          // best-effort
        }
      } catch (err) {
        if (timedOut) {
          terminalReason = 'timeout';
          errorMessage = `step timed out after ${this.opts.responseTimeoutMs ?? 120_000}ms`;
        } else if (this.abortController.signal.aborted) {
          terminalReason = 'interrupted';
        } else {
          terminalReason = 'error';
          errorMessage = err instanceof Error ? err.message : String(err);
        }
      }

      if (timedOut && this.opts.timeoutHook) {
        await this.opts.timeoutHook.fire();
      }
      if (terminalReason === 'interrupted' && this.opts.interruptHook) {
        await this.opts.interruptHook.fire();
      }

      // Stop hook: only for clean "stop", not error/interrupted/timeout.
      if (terminalReason === 'stop' && this.opts.stopHook && stopRetryCount < Agent.MAX_STOP_RETRIES) {
        const hookResult = await this.opts.stopHook.fire({ reason: terminalReason });
        if (hookResult.blocked) {
          const parts: string[] = [];
          if (hookResult.reason) parts.push(hookResult.reason);
          if (hookResult.additionalContext) parts.push(hookResult.additionalContext);
          const blockMessage = parts.length > 0 ? parts.join('\n\n') : 'Blocked by stop hook';
          this.session.messages.push({ role: 'user', content: blockMessage });
          queue.push({ type: 'user_message', content: blockMessage });
          stopRetryCount++;
          // Fresh abort controller for the next turn.
          this.abortController = new AbortController();
          continue;
        }
      }

      if (terminalReason === 'stop' && stopRetryCount >= Agent.MAX_STOP_RETRIES) {
        terminalReason = 'max_steps';
      }

      break; // No more retries.
    }

    this.session.status =
      terminalReason === 'error' || terminalReason === 'timeout' ? 'error' : 'idle';
    try {
      await persistSession(
        this.session,
        {
          type: 'run_finished',
          reason: terminalReason,
          ...(errorMessage !== undefined ? { error: errorMessage } : {}),
        },
        this.opts.home,
      );
    } catch (_e) {
      // ignore
    }

    queue.push({
      type: 'run_finished',
      reason: terminalReason,
      error: errorMessage,
    });
  }
}

function extractReadPath(args: unknown): string | undefined {
  if (args && typeof args === 'object' && 'path' in args) {
    const pathValue = (args as { path?: unknown }).path;
    if (typeof pathValue === 'string' && pathValue.length > 0) return pathValue;
  }
  return undefined;
}

function extractPathFromToolArgs(args: unknown): string | undefined {
  return extractReadPath(args);
}

function extractTarget(args: unknown, sandboxMode: SandboxMode): ExecutionTarget {
  if (args && typeof args === 'object' && 'target' in args) {
    const targetValue = (args as { target?: unknown }).target;
    if (targetValue === 'sandbox' || targetValue === 'host') return targetValue;
  }
  // No explicit `target` in the tool args — match the bash tool's default
  // and the routing of file tools (read/write/edit always use the sandbox
  // executor when sandbox is on).
  return sandboxMode === 'off' ? 'host' : 'sandbox';
}

export function buildPermissionRequest(args: {
  tool: string;
  command: string;
  cwd: string;
  reason?: string;
}): PermissionRequest {
  return {
    requestId: newRequestId(),
    tool: args.tool,
    target: 'host',
    command: args.command,
    cwd: args.cwd,
    reason: args.reason,
  };
}
