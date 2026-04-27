import { stepCountIs, streamText, type ModelMessage, type LanguageModel, type ToolSet } from 'ai';
import { EventQueue } from './event-queue';
import { type AgentEvent, type ToolDisplay } from './events';

export type ToolFormatter = (args: unknown, result?: unknown) => ToolDisplay;
import { type CallId, type SessionId, newCallId, newRequestId, newSessionId } from './ids';
import type { PermissionRequest, PermissionResolution } from './interfaces';
import { appendSessionEvent, forkSession, loadSession, persistSession } from './persistence';
import {
  type ExecutionTarget,
  type ModelConfig,
  type RememberScope,
  type SandboxMode,
  type Session,
  type ToolCallRecord,
  type UsageStep,
  emptyUsage,
} from './types';
import { applyStepUsage, cloneUsage, readStepUsage, reconcileFinalUsage } from './usage';

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
  private toolFormatters: Record<string, ToolFormatter> = {};
  /**
   * Maps the AI SDK's per-call `toolCallId` (a short string the SDK generates)
   * to the agent's own `CallId` for the same tool invocation. Tools that emit
   * out-of-band events (notably `spawn_agent`, which fires `subagent_spawned`)
   * use `resolveCallId(toolCallId)` to attribute their events to the parent
   * tool call so the TUI can nest sub-events under the right entry.
   */
  private callIdByToolCallId = new Map<string, CallId>();

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
  emitPermissionResolved(
    requestId: string,
    decision: 'allow' | 'deny',
    remembered: boolean,
  ): void {
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
   * Translate an AI SDK `toolCallId` into the agent's `CallId` for the same
   * in-flight tool invocation. Returns `undefined` when no mapping exists
   * (e.g. the tool call has already produced its result/error and been
   * cleaned up). Used by tools that emit out-of-band events and need to
   * cite their parent tool call.
   */
  resolveCallId(toolCallId: string): CallId | undefined {
    return this.callIdByToolCallId.get(toolCallId);
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

  private async runInternal(userMessage: string, queue: EventQueue<AgentEvent>): Promise<void> {
    this.session.status = 'running';
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

    // Track accumulated assistant text per text-id to emit assistant_text_done.
    const textStreams = new Map<string, string>();
    // Map AI SDK tool call id → our CallId, name, target for tool-result correlation.
    const callInfo = new Map<
      string,
      { callId: CallId; name: string; target: ExecutionTarget; startedAt: number }
    >();

    let stepNumber = 0;
    let terminalReason: 'stop' | 'max_steps' | 'error' | 'interrupted' = 'stop';
    let errorMessage: string | undefined;
    // Run-local accumulator of step deltas, used to reconcile against the
    // terminal `finish.totalUsage` if the two disagree.
    const runDelta: UsageStep = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
    };
    let usageMissingLogged = false;

    try {
      const stream = streamText({
        model: this.opts.languageModel,
        messages: this.session.messages,
        tools: this.opts.tools,
        system: this.opts.systemPrompt,
        stopWhen: stepCountIs(this.opts.model.maxSteps),
        abortSignal: this.abortController.signal,
        temperature: this.opts.model.temperature,
      });

      for await (const part of stream.fullStream) {
        switch (part.type) {
          case 'text-start':
            textStreams.set(part.id, '');
            break;
          case 'text-delta':
            textStreams.set(part.id, (textStreams.get(part.id) ?? '') + part.text);
            queue.push({ type: 'assistant_text_delta', id: part.id, delta: part.text });
            break;
          case 'text-end': {
            const full = textStreams.get(part.id) ?? '';
            textStreams.delete(part.id);
            if (full.length > 0) {
              queue.push({ type: 'assistant_text_done', id: part.id, text: full });
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
            callInfo.delete(part.toolCallId);
            this.callIdByToolCallId.delete(part.toolCallId);
            break;
          }
          case 'tool-error': {
            const info = callInfo.get(part.toolCallId);
            if (!info) break;
            const errorValue = (part as { error?: unknown }).error;
            const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
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
            const stepUsage = readStepUsage((part as { usage?: unknown }).usage);
            if (stepUsage) {
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
            if (part.finishReason === 'length') {
              // not treated specially; finish-step already mapped
            }
            break;
          }
          case 'abort': {
            terminalReason = 'interrupted';
            break;
          }
          case 'error': {
            terminalReason = 'error';
            errorMessage = part.error instanceof Error ? part.error.message : String(part.error);
            break;
          }
          default:
            // Ignore reasoning, source, file, tool-input-*, start/start-step, raw.
            break;
        }
      }

      // After the stream finishes, attach response messages.
      const response = await stream.response;
      if (response && Array.isArray(response.messages)) {
        this.session.messages.push(...(response.messages as ModelMessage[]));
      }

      if (terminalReason === 'stop') {
        const finishReason = await stream.finishReason;
        // If we hit the step cap, map to max_steps.
        if (stepNumber >= this.opts.model.maxSteps && finishReason !== 'stop') {
          terminalReason = 'max_steps';
        } else if (finishReason === 'length') {
          terminalReason = 'max_steps';
        }
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
      if (this.abortController.signal.aborted) {
        terminalReason = 'interrupted';
      } else {
        terminalReason = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    }

    this.session.status = terminalReason === 'error' ? 'error' : 'idle';
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
