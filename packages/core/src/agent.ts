import { existsSync } from 'node:fs';
import { type FileHandle, open, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from 'ai';
import { type ContextBreakdown, computeContextBreakdown } from './context-breakdown';
import { ContextTracker, shouldCompact } from './context-tracker';
import { EventQueue } from './event-queue';
import { type AgentEvent, type ToolDisplay } from './events';
import { type CallId, newCallId, newRequestId, newSessionId, type SessionId } from './ids';
import { readImageDimensions } from './image-header';
import type { PermissionRequest, PermissionResolution } from './interfaces';
import { elideImageToolResults } from './message-parts';
import {
  type ModelSettings,
  type ModelSettingsPatch,
  type ModelSettingsState,
  patchModelSettings,
} from './model-settings';
import type { QuestionRequest, QuestionResolution } from './questions';

type ModelResolution = {
  model: ModelConfig;
  languageModel: LanguageModel;
  contextWindow: number;
  contextWindowIsApproximate: boolean;
  systemPrompt: string;
  /** The tool set for this model's profile; omitted keeps the current tools. */
  tools?: ToolSet;
  providerOptions?: ProviderOptions;
};

export type ToolFormatter = (args: unknown, result?: unknown) => ToolDisplay;

/**
 * Provider-specific options forwarded to the AI SDK's `streamText` call.
 * Structurally compatible with the AI SDK's `ProviderOptions`
 * (`Record<string, JSONObject>`), which is not re-exported by the `ai`
 * package so we define a local alias.
 */
export type ProviderOptions = Record<string, Record<string, unknown>>;

import {
  buildGoalCheckPrompt,
  DEFAULT_GOAL_MAX_CONTINUATIONS,
  formatGoalMessage,
  type Goal,
  type GoalVerdict,
  parseGoalVerdict,
} from './goal';
import {
  appendSessionEvent,
  forkSession,
  loadSession,
  persistSession,
  writeSessionMetadata,
} from './persistence';
import { classifyProviderError, describeProviderError } from './provider-errors';
import { repairToolCall } from './tool-repair';
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
import { applyStepUsage, cloneUsage, readStepUsage, reconcileFinalUsage } from './usage';

export interface StopHook {
  fire(payload: { reason: string }): Promise<{
    blocked: boolean;
    reason?: string;
    additionalContext?: string;
  }>;
}

export interface GoalCheck {
  /** One question to the checker's model: the text of its reply. */
  ask(prompt: { system: string; prompt: string }, signal: AbortSignal): Promise<string>;
  /** `not_met` continuations one run may take. Default 20. */
  maxContinuations?: number;
  /** How long the model may take. Default 60 seconds. */
  timeoutMs?: number;
}

export interface TimeoutHook {
  fire(): Promise<void>;
}

export interface InterruptHook {
  fire(): Promise<void>;
}

export interface UserInputRequest {
  request: string;
  kind?: 'information' | 'action';
}

export interface UserInputRequiredHook {
  fire(request: UserInputRequest): Promise<void>;
}

export interface PermissionResolvedHook {
  fire(resolution: {
    requestId: string;
    decision: 'allow' | 'deny';
    remembered: boolean;
    sessionStatus: 'running' | 'waiting_for_permission';
    remainingPending: number;
  }): Promise<void>;
}

export interface AgentOptions {
  cwd: string;
  model: ModelConfig;
  languageModel: LanguageModel;
  tools: ToolSet;
  systemPrompt?: string;
  sandboxMode: SandboxMode;
  sessionId?: SessionId;
  sessionName?: string;
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
   * Checks the session's goal at each clean stop, after the Stop hook let
   * the run end. Without it a goal is kept but never checked.
   */
  goalCheck?: GoalCheck;
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
  /** Awaited before a user-input handoff emits its terminal run event. */
  userInputRequiredHook?: UserInputRequiredHook;
  /** Awaited after permission state changes and before the suspended tool resumes. */
  permissionResolvedHook?: PermissionResolvedHook;
  /**
   * Idle timeout for a model step (ms): how long the model may produce no
   * stream output. Tool execution time does not count. A value of `0`
   * disables the timeout. Defaults to 120000.
   */
  responseTimeoutMs?: number;
  /**
   * Provider-specific options forwarded to the AI SDK's `streamText` call
   * (under the `providerOptions` parameter). Built by the factory from the
   * provider shape and `ModelConfig.parallelToolCalls`. Keyed by provider
   * name (e.g. `{ openai: { parallelToolCalls: true } }`).
   */
  providerOptions?: ProviderOptions;
}

/**
 * Result of resolving the configured `defaultVisionModel` for a turn that
 * carries images the active model cannot see. `unavailable` reasons are
 * user-facing (they end up in error messages / `vision_route_unavailable`).
 */
export type VisionModelResolution =
  | {
      status: 'ok';
      ref: string;
      model: ModelConfig;
      languageModel: LanguageModel;
      contextWindow: number;
      contextWindowIsApproximate: boolean;
      providerOptions?: ProviderOptions;
    }
  | { status: 'unavailable'; reason: string };

export type PermissionRaiseHandler = (req: PermissionRequest) => Promise<PermissionResolution>;

export class Agent {
  readonly session: Session;
  private opts: AgentOptions;
  private abortController: AbortController;
  private pendingQuestions = new Map<
    string,
    { resolve: (resolution: QuestionResolution) => void; request: QuestionRequest }
  >();
  private pendingPermissions = new Map<
    string,
    {
      resolve: (r: PermissionResolution) => void;
      request: PermissionRequest;
      rememberHandler?: (scope: RememberScope) => void;
    }
  >();
  private currentQueue: EventQueue<AgentEvent> | null = null;
  private pendingUserInputRequest: UserInputRequest | null = null;
  private running = false;
  private updatingModelSettings = false;
  private modelSettingsResolver?: (
    ref: string,
    settings: ModelSettings,
  ) => Promise<ModelResolution>;
  private defaultModelRef?: string | (() => string);
  private static readonly MAX_STOP_RETRIES = 5;
  private static readonly MAX_PROVIDER_RETRIES = 4;
  private static readonly MAX_OUTPUT_CONTINUATIONS = 2;
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
   * Pending image data URIs collected from `read` tool results during the
   * current step. Injected as a user message with image parts at the end of
   * each step that had tool calls, so the model sees the images as vision
   * inputs on the next turn.
   */
  private pendingImageMessages: Array<{
    type: 'image';
    image: string;
    /**
     * `chimera.sourcePath` records the read target so a later non-vision
     * turn can substitute the image with a re-readable path reference.
     * Providers ignore unknown providerOptions keys.
     */
    providerOptions?: { chimera: { sourcePath: string } };
  }> = [];
  /**
   * Mid-run user messages queued via `injectRunMessage()` while a run is
   * active. Drained at each clean step boundary (after the response messages
   * are attached and after the `terminalReason !== 'stop'` check, so an
   * interrupted/errored step drops pending injects — "interrupt means stop").
   * On an intermediate step the next `streamText` call sees them; on a
   * terminal step the loop continues so the model responds to them (still
   * subject to `maxTerminalSteps`).
   */
  private pendingInjectMessages: Array<{ content: string; images?: string[] }> = [];
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
    /** The tool set for the new model's profile; omitted keeps the current tools. */
    tools?: ToolSet;
    providerOptions?: ProviderOptions;
  };
  /**
   * Optional callback resolving the configured `defaultVisionModel` when a
   * turn carries images the active model cannot see. Registered by the
   * factory; core never reads config directly.
   */
  private visionModelResolver?: () => VisionModelResolution;
  /**
   * Resolver for the model a run moves to when the active model stays
   * unavailable after every retry. Returns the same resolution shape as the
   * vision route, since both swap the model for the rest of one run.
   */
  private fallbackModelResolver?: () => VisionModelResolution;
  /**
   * Run-scoped model override: engaged while a vision-routed turn is in
   * flight, or after a run fell back because its model stayed unavailable.
   * Layered over `opts` via the `active*()` accessors and cleared at the end
   * of every run (plus defensively at run start), so interrupted or errored
   * runs revert for free and `session.model` / `session.userModelOverride`
   * are never touched.
   */
  private modelOverride: {
    model: ModelConfig;
    languageModel: LanguageModel;
    contextWindow: number;
    contextWindowIsApproximate: boolean;
    providerOptions?: ProviderOptions;
    trigger: 'user_images' | 'tool_image' | 'fallback';
  } | null = null;
  /** Once-per-run latch for `vision_route_unavailable`. */
  private visionUnavailableEmitted = false;

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
        name: opts.sessionName,
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
        policyAnalysis: req.policyAnalysis,
        mcp: req.mcp,
        ...(req.reviewerReason ? { reviewerReason: req.reviewerReason } : {}),
        ...(req.systemOneNote ? { systemOneNote: req.systemOneNote } : {}),
      });
    });
  }

  /**
   * Put questions to the user and wait for the answer. The tool call that
   * asks stays open; `resolveQuestion` settles it. An interrupt of the run
   * cancels the questions, so the call ends and the run can stop.
   */
  askQuestions(request: QuestionRequest): Promise<QuestionResolution> {
    return new Promise<QuestionResolution>((resolve) => {
      const { signal } = this.abortController;
      const onInterrupt = () => {
        if (this.pendingQuestions.has(request.requestId)) {
          this.resolveQuestion(request.requestId, { status: 'cancelled' });
        }
      };
      this.pendingQuestions.set(request.requestId, {
        request,
        resolve: (resolution) => {
          signal.removeEventListener('abort', onInterrupt);
          resolve(resolution);
        },
      });
      signal.addEventListener('abort', onInterrupt, { once: true });
      this.currentQueue?.push({
        type: 'question_request',
        requestId: request.requestId,
        questions: request.questions,
      });
    });
  }

  pendingQuestionRequests(): QuestionRequest[] {
    return [...this.pendingQuestions.values()].map(({ request }) => structuredClone(request));
  }

  hasPendingQuestion(requestId: string): boolean {
    return this.pendingQuestions.has(requestId);
  }

  /** Settle a pending question with the user's answers, or with their refusal to answer. */
  resolveQuestion(requestId: string, resolution: QuestionResolution): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) throw new Error(`No pending question: ${requestId}`);
    this.pendingQuestions.delete(requestId);
    this.currentQueue?.push({ type: 'question_resolved', requestId, status: resolution.status });
    pending.resolve(resolution);
  }

  requestUserInput(request: UserInputRequest): void {
    if (this.pendingUserInputRequest) {
      throw new Error('User input has already been requested in this run');
    }
    this.pendingUserInputRequest = request;
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
  private permissionResolutionChain: Promise<void> = Promise.resolve();

  pendingPermissionRequest(requestId: string): PermissionRequest | undefined {
    return this.pendingPermissions.get(requestId)?.request;
  }

  pendingPermissionRequests(): PermissionRequest[] {
    return [...this.pendingPermissions.values()].map(({ request }) => structuredClone(request));
  }

  async resolvePermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember?: RememberScope,
    feedback?: string,
    grant?: PermissionResolution['grant'],
  ): Promise<void> {
    const resolution = this.permissionResolutionChain.then(() =>
      this.resolvePermissionSerial(requestId, decision, remember, feedback, grant),
    );
    this.permissionResolutionChain = resolution.catch(() => {});
    return resolution;
  }

  private async resolvePermissionSerial(
    requestId: string,
    decision: 'allow' | 'deny',
    remember?: RememberScope,
    feedback?: string,
    grant?: PermissionResolution['grant'],
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request: ${requestId}`);
    }

    if (remember && this.rememberHandler) {
      this.rememberHandler(requestId, remember, pending.request);
    }
    if (feedback) {
      this.session.pendingPermissionFeedback ??= [];
      this.session.pendingPermissionFeedback.push(feedback);
      try {
        await writeSessionMetadata(this.session, this.opts.home);
      } catch (error) {
        this.session.pendingPermissionFeedback.pop();
        throw error;
      }
    }
    this.pendingPermissions.delete(requestId);
    const remainingPending = this.pendingPermissions.size;
    this.session.status = remainingPending > 0 ? 'waiting_for_permission' : 'running';
    try {
      await this.opts.permissionResolvedHook?.fire({
        requestId,
        decision,
        remembered: !!remember,
        sessionStatus: this.session.status,
        remainingPending,
      });
    } catch {
      // observational hook failures must not strand the suspended tool call
    }

    pending.resolve({
      decision,
      remembered: !!remember,
      ...(feedback ? { feedback } : {}),
      ...(grant ? { grant } : {}),
    });
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
   * Set the session's goal, or clear it with null. A new goal replaces the
   * one before. Returns the event that says so; the caller publishes it,
   * because the session can be idle.
   */
  setGoal(condition: string | null): Extract<AgentEvent, { type: 'goal_updated' }> {
    const text = condition?.trim() ?? '';
    if (text === '') delete this.session.goal;
    else this.session.goal = { condition: text };
    void writeSessionMetadata(this.session, this.opts.home).catch(() => {
      // best-effort; the next step writes the metadata again
    });
    return text === ''
      ? { type: 'goal_updated', condition: null, change: 'cleared' }
      : { type: 'goal_updated', condition: text, change: 'set' };
  }

  /**
   * Ask the checker whether the goal is met. `message` is set when the run
   * goes on: it is what the agent is told. `interrupted`: the user stopped
   * the run while the checker worked.
   */
  private async checkGoal(
    goal: Goal,
    continuations: number,
  ): Promise<
    'interrupted' | { event: Extract<AgentEvent, { type: 'goal_updated' }>; message?: string }
  > {
    const check = this.opts.goalCheck!;
    const maxContinuations = check.maxContinuations ?? DEFAULT_GOAL_MAX_CONTINUATIONS;
    const timeoutMs = check.timeoutMs ?? GOAL_CHECK_TIMEOUT_MS;
    const lastAssistant = this.session.messages
      .filter((message) => message.role === 'assistant')
      .at(-1);
    const prompt = buildGoalCheckPrompt({
      condition: goal.condition,
      lastAssistantMessage: lastAssistant ? textOf(lastAssistant.content) : '',
      tasks: this.session.tasks,
      toolCalls: this.session.toolCalls,
    });
    const stop = new AbortController();
    const interrupt = this.abortController.signal;
    const onInterrupt = () => stop.abort();
    interrupt.addEventListener('abort', onInterrupt, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A timer of its own: a model call that ignores the signal must not hold the run.
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        stop.abort();
        resolve(null);
      }, timeoutMs);
    });
    const interrupted = new Promise<'interrupted'>((resolve) => {
      stop.signal.addEventListener('abort', () => {
        if (interrupt.aborted) resolve('interrupted');
      });
    });
    let verdict: GoalVerdict | null = null;
    let failure = "the checker's reply had no answer";
    try {
      const reply = await Promise.race([check.ask(prompt, stop.signal), late, interrupted]);
      if (reply === 'interrupted') return 'interrupted';
      if (reply === null) {
        failure = `the checker did not answer in ${Math.round(timeoutMs / 1000)} seconds`;
      } else {
        verdict = parseGoalVerdict(reply);
      }
    } catch (error) {
      if (interrupt.aborted) return 'interrupted';
      failure = `the checker failed: ${(error as Error).message}`;
    } finally {
      clearTimeout(timer);
      interrupt.removeEventListener('abort', onInterrupt);
    }

    const { condition } = goal;
    if (!verdict) {
      return { event: { type: 'goal_updated', condition, change: 'unchecked', reason: failure } };
    }
    if (verdict.result === 'not_met') {
      if (continuations >= maxContinuations) {
        return {
          event: {
            type: 'goal_updated',
            condition,
            change: 'limit',
            reason: verdict.reason,
            continuation: continuations,
            maxContinuations,
          },
        };
      }
      const continuation = continuations + 1;
      return {
        event: {
          type: 'goal_updated',
          condition,
          change: 'not_met',
          reason: verdict.reason,
          continuation,
          maxContinuations,
        },
        message: formatGoalMessage({
          condition,
          reason: verdict.reason,
          continuation,
          maxContinuations,
        }),
      };
    }
    // Met, or not possible: either way the goal has had its answer.
    delete this.session.goal;
    return {
      event: {
        type: 'goal_updated',
        condition: null,
        change: verdict.result,
        reason: verdict.reason,
      },
    };
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
   * `/reload` to pick up changes to AGENTS.md/AGENTS.local.md/CLAUDE.md files.
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
      tools?: ToolSet;
      providerOptions?: ProviderOptions;
    },
  ): void {
    this.modelChangeResolver = resolver;
  }

  setModelSettingsResolver(
    resolver: (ref: string, settings: ModelSettings) => Promise<ModelResolution>,
    defaultModelRef?: string | (() => string),
  ): void {
    this.modelSettingsResolver = resolver;
    this.defaultModelRef = defaultModelRef;
  }

  get modelSettingsState(): ModelSettingsState | undefined {
    const model = this.session.model;
    if (!model.capabilities) return undefined;
    const ref = `${model.providerId}/${model.modelId}`;
    return {
      model: ref,
      overrides: this.session.modelSettingsOverrides?.[ref] ?? {},
      defaults: model.settingsDefaults ?? {},
      effective: model.settings ?? {},
      capabilities: model.capabilities,
    };
  }

  async updateModelSettings(request: {
    model?: string | null;
    settings?: ModelSettingsPatch;
    resetSettings?: boolean;
    expectedModel?: string;
  }): Promise<
    | { status: 'applied'; from: string; to: string; settingsState?: ModelSettingsState }
    | { status: 'running' }
    | { status: 'invalid'; error: string }
  > {
    if (this.running || this.updatingModelSettings) return { status: 'running' };
    const from = `${this.session.model.providerId}/${this.session.model.modelId}`;
    if (request.expectedModel !== undefined && request.expectedModel !== from)
      return { status: 'invalid', error: 'The selected model changed. Reload its settings.' };
    if (!this.modelSettingsResolver) {
      if (!request.settings && !request.resetSettings && request.model !== undefined)
        return this.setUserModelOverride(request.model);
      return { status: 'invalid', error: 'Model settings are unavailable in this agent' };
    }
    this.updatingModelSettings = true;
    try {
      const defaultRef =
        typeof this.defaultModelRef === 'function' ? this.defaultModelRef() : this.defaultModelRef;
      const to = request.model === null ? (defaultRef ?? from) : (request.model ?? from);
      const overrides = patchModelSettings(
        request.resetSettings ? {} : (this.session.modelSettingsOverrides?.[to] ?? {}),
        request.settings ?? {},
      );
      let resolved: ModelResolution;
      try {
        resolved = await this.modelSettingsResolver(to, overrides);
      } catch (error) {
        return { status: 'invalid', error: (error as Error).message };
      }
      const modelSettingsOverrides = { ...this.session.modelSettingsOverrides, [to]: overrides };
      const userModelOverride =
        request.model === undefined ? this.session.userModelOverride : request.model;
      const candidate = {
        ...this.session,
        model: resolved.model,
        modelSettingsOverrides,
        userModelOverride,
      };
      await writeSessionMetadata(candidate, this.opts.home);
      this.opts = { ...this.opts, ...resolved };
      this.session.model = candidate.model;
      this.session.modelSettingsOverrides = modelSettingsOverrides;
      this.session.userModelOverride = userModelOverride;
      return { status: 'applied', from, to, settingsState: this.modelSettingsState };
    } finally {
      this.updatingModelSettings = false;
    }
  }

  /**
   * Register the callback used to resolve the configured vision fallback
   * model when a turn carries images the active model cannot see. Called by
   * the factory during session construction; invoked lazily per engagement.
   */
  setVisionModelResolver(resolver: () => VisionModelResolution): void {
    this.visionModelResolver = resolver;
  }

  /**
   * Register the resolver for `fallbackModel`. Invoked at most once per run,
   * after a step has used all of its retries on a temporary provider error.
   */
  setFallbackModelResolver(resolver: () => VisionModelResolution): void {
    this.fallbackModelResolver = resolver;
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
    if (this.running || this.updatingModelSettings) {
      return { status: 'running' };
    }
    const currentRef = `${this.session.model.providerId}/${this.session.model.modelId}`;
    const defaultRef =
      typeof this.defaultModelRef === 'function' ? this.defaultModelRef() : this.defaultModelRef;
    const targetRef = ref ?? defaultRef ?? currentRef;
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
      ...(resolved.tools ? { tools: resolved.tools } : {}),
      contextWindow: resolved.contextWindow,
      contextWindowIsApproximate: resolved.contextWindowIsApproximate,
      providerOptions: resolved.providerOptions,
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
    if (this.updatingModelSettings)
      return { status: 'invalid', error: 'A model settings update is in progress' };
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
      if (resolved.effectiveModelChanged && this.modelChangeResolver) {
        const model = this.modelChangeResolver(resolved.effectiveModel);
        this.opts = { ...this.opts, ...model };
        this.session.model = model.model;
      }
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
  /**
   * Prefer a path reference over inline base64: history stays small on disk and
   * `prepareMessagesForModel` re-reads the file at send time. Only valid when
   * the host can actually see the file — with a sandbox on, `read` runs inside
   * the container and the path need not resolve out here (an overlay's writes
   * never touch the host), so the snapshot we already hold is the only copy.
   */
  private storableImage(result: ReadImageResult, sourcePath: string | undefined): string {
    if (!sourcePath || this.opts.sandboxMode !== 'off') return result.data;
    return sourcePath;
  }

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
      const display = fmt(args, result);
      const shortened = describeShortenedOutput(result);
      if (!shortened) return display;
      return { ...display, detail: display.detail ? `${display.detail}\n${shortened}` : shortened };
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
  async appendMessage(content: string, imagePaths?: string[]): Promise<void> {
    if (this.running) {
      throw new Error('Agent is already running');
    }
    this.session.messages.push(await buildUserMessage(content, imagePaths));
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

  /**
   * Queue a user message for injection into the active run at the next clean
   * step boundary. No-op when no run is active (the caller should fall back to
   * `appendMessage` for the idle case). Synchronous and safe to call from
   * another async context while `runInternal` is awaiting — the buffer is
   * only read at step boundaries where `session.messages` is not mid-mutation.
   */
  injectRunMessage(content: string, images?: string[]): void {
    this.pendingInjectMessages.push({ content, images });
  }

  run(userMessage: string, imagePaths?: string[]): AsyncIterable<AgentEvent> {
    if (this.running || this.updatingModelSettings) {
      throw new Error('Agent is already running');
    }
    this.running = true;
    // Fresh abort controller per run.
    this.abortController = new AbortController();
    // Defensive: a crashed run must not leak its vision override into this one.
    this.modelOverride = null;
    this.visionUnavailableEmitted = false;

    const queue = new EventQueue<AgentEvent>();
    this.currentQueue = queue;

    // Start the engine in the background; consumer drains the queue.
    void this.runInternal(userMessage, queue, imagePaths).finally(() => {
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
  /** The model config in effect for the current step (vision override aware). */
  /** Resolves after `delayMs`, or as soon as the current run is aborted. */
  private waitUnlessInterrupted(delayMs: number): Promise<void> {
    const { signal } = this.abortController;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private activeModel(): ModelConfig {
    return this.modelOverride?.model ?? this.opts.model;
  }

  private activeLanguageModel(): LanguageModel {
    return this.modelOverride?.languageModel ?? this.opts.languageModel;
  }

  private activeContextWindow(): number {
    return this.modelOverride?.contextWindow ?? this.opts.contextWindow;
  }

  private activeContextWindowIsApproximate(): boolean {
    return this.modelOverride?.contextWindowIsApproximate ?? !!this.opts.contextWindowIsApproximate;
  }

  private activeProviderOptions(): ProviderOptions | undefined {
    return this.modelOverride ? this.modelOverride.providerOptions : this.opts.providerOptions;
  }

  private composeSystemPrompt(planHandoff: boolean): string | undefined {
    const parts: string[] = [];
    // Nothing that changes between steps belongs here: the system prompt is
    // the head of the provider's cached prefix. The task list lives in the
    // conversation (latest task_list call, or the <tasks> block compaction
    // writes into a summary).
    if (this.opts.systemPrompt) parts.push(this.opts.systemPrompt);
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
    if (this.modelOverride && this.modelOverride.trigger !== 'fallback') {
      parts.push(
        '# Vision turn\n\n' +
          "This turn is routed to you because it contains images the session's " +
          'primary model cannot see. Briefly state what each image shows before ' +
          'acting on it, so your description survives in the conversation for ' +
          'models that cannot view the images.',
      );
    }
    if (parts.length === 0) return undefined;
    return parts.join('\n\n');
  }

  /**
   * Per-category accounting of the current context for the /context command.
   */
  contextBreakdown(): ContextBreakdown {
    return computeContextBreakdown({
      messages: this.session.messages,
      systemPrompt: this.composeSystemPrompt(false) ?? '',
      lastPromptTokens: this.session.usage.lastStep?.inputTokens ?? null,
      contextWindow: this.opts.contextWindow,
      compaction: this.opts.compaction,
      maxOutputTokens: this.opts.model.maxOutputTokens,
      imageLongEdge: this.activeModel().imageLongEdge,
    });
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
      projected: this.contextTracker.projectedNextPrompt(this.session.messages, {
        imageLongEdge: this.activeModel().imageLongEdge,
      }),
      contextWindow: this.activeContextWindow(),
      thresholdPercent: config.thresholdPercent ?? 85,
      reserveTokens: config.reserveTokens,
      maxOutputTokens: this.activeModel().maxOutputTokens,
    });
  }

  /**
   * Run a compaction inside a run, emitting the event pair and persisting a
   * snapshot so a crash before the next step cannot resurrect the
   * pre-compaction history. `threshold` runs at run start or between steps;
   * `overflow` runs after the provider rejected the prompt for its length,
   * which means the size estimate was wrong, so it forces the summarizing
   * pass instead of letting a prune-only pass count as enough. Failure emits
   * `compaction_failed` and latches further attempts off for this turn —
   * a degraded run beats a dead one. Returns true when the conversation
   * got smaller.
   */
  private async runCompaction(
    queue: EventQueue<AgentEvent>,
    trigger: 'threshold' | 'overflow',
  ): Promise<boolean> {
    const compactor = this.opts.compactor;
    if (!compactor) return false;
    queue.push({ type: 'compaction_started', reason: trigger });
    try {
      const result = await compactor.compact(
        this.session,
        trigger === 'overflow' ? 'manual' : 'threshold',
      );
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
      return result.tokensAfter < result.tokensBefore;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      queue.push({ type: 'compaction_failed', error: message });
      this.compactionIneffective = true;
      return false;
    }
  }

  private async runInternal(
    userMessage: string,
    queue: EventQueue<AgentEvent>,
    imagePaths?: string[],
  ): Promise<void> {
    this.session.status = 'running';
    this.pendingUserInputRequest = null;

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
          if (resolved.effectiveModelChanged && this.modelChangeResolver) {
            const model = this.modelChangeResolver(resolved.effectiveModel);
            this.opts = { ...this.opts, ...model };
            this.session.model = model.model;
          }
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

    if (this.modelSettingsResolver) {
      const ref = `${this.session.model.providerId}/${this.session.model.modelId}`;
      try {
        const resolved = await this.modelSettingsResolver(
          ref,
          this.session.modelSettingsOverrides?.[ref] ?? {},
        );
        await writeSessionMetadata({ ...this.session, model: resolved.model }, this.opts.home);
        this.opts = { ...this.opts, ...resolved };
        this.session.model = resolved.model;
        const settingsState = this.modelSettingsState;
        if (settingsState) queue.push({ type: 'model_settings_changed', settingsState });
      } catch (error) {
        this.session.status = 'error';
        queue.push({
          type: 'run_finished',
          reason: 'error',
          error: `Model settings: ${(error as Error).message}`,
        });
        return;
      }
    }

    // One-shot: a switch out of plan mode arms the handoff note for exactly
    // this run, telling the model to record the accepted plan via task_list.
    const planHandoff = this.planHandoffPending;
    this.planHandoffPending = false;

    // Fresh run: discard any stale pending images from a previous run that
    // was interrupted before they could be injected.
    this.pendingImageMessages = [];
    // Likewise discard stale mid-run injects from a prior interrupted run.
    this.pendingInjectMessages = [];

    // Vision routing: a turn carrying new images while the active model is
    // text-only runs entirely on the configured vision model (reverted at
    // the end of the run).
    const turnHasNewImages =
      (imagePaths?.length ?? 0) > 0 || tailHasImageParts(this.session.messages);
    if (turnHasNewImages && this.activeModel().vision !== true) {
      const resolution = this.visionModelResolver?.() ?? {
        status: 'unavailable' as const,
        reason: 'no vision model resolver registered',
      };
      if (resolution.status === 'ok') {
        this.modelOverride = {
          model: { ...resolution.model, maxSteps: this.session.model.maxSteps },
          languageModel: resolution.languageModel,
          contextWindow: resolution.contextWindow,
          contextWindowIsApproximate: resolution.contextWindowIsApproximate,
          providerOptions: resolution.providerOptions,
          trigger: 'user_images',
        };
      } else {
        // No usable fallback: reject the turn before the user message lands
        // anywhere, so the user can fix the config and simply resend.
        const currentRef = `${this.opts.model.providerId}/${this.opts.model.modelId}`;
        const error =
          `Cannot send images: model ${currentRef} is not vision-capable and no usable ` +
          `vision fallback is configured (${resolution.reason}). Set "defaultVisionModel" ` +
          `in ~/.chimera/config.json to a model with verified image support, or use ` +
          `/model to switch to a vision-capable model.`;
        queue.push({ type: 'session_started', sessionId: this.session.id });
        queue.push({ type: 'user_message', content: userMessage, imageCount: imagePaths?.length });
        this.session.status = 'error';
        try {
          await persistSession(
            this.session,
            { type: 'run_finished', reason: 'error', error },
            this.opts.home,
          );
        } catch {
          // best-effort persistence
        }
        queue.push({ type: 'run_finished', reason: 'error', error });
        return;
      }
    }

    this.session.messages.push(await buildUserMessage(userMessage, imagePaths));

    queue.push({ type: 'session_started', sessionId: this.session.id });

    // Resumed-session snapshot: if prior usage is non-zero, emit one
    // usage_updated immediately so consumers see the persisted totals before
    // any new step finishes.
    if (this.session.usage.totalTokens > 0) {
      queue.push({
        type: 'usage_updated',
        usage: cloneUsage(this.session.usage),
        contextWindow: this.activeContextWindow(),
        usedContextTokens: this.session.usage.lastStep?.inputTokens ?? 0,
        unknownWindow: this.activeContextWindowIsApproximate(),
      });
    }

    queue.push({ type: 'user_message', content: userMessage, imageCount: imagePaths?.length });

    if (this.modelOverride && this.modelOverride.trigger !== 'fallback') {
      queue.push({
        type: 'vision_route_started',
        from: `${this.opts.model.providerId}/${this.opts.model.modelId}`,
        to: `${this.modelOverride.model.providerId}/${this.modelOverride.model.modelId}`,
        trigger: this.modelOverride.trigger,
      });
    }

    // Compaction: a fresh user turn clears the ineffective latch, then the
    // same projection-based trigger used between steps runs once up front.
    this.compactionIneffective = false;
    if (this.overCompactionThreshold()) {
      await this.runCompaction(queue, 'threshold');
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
    let terminalReason:
      | 'stop'
      | 'max_steps'
      | 'error'
      | 'interrupted'
      | 'timeout'
      | 'waiting_for_input'
      | 'output_limit' = 'stop';
    let errorMessage: string | undefined;
    let stopRetryCount = 0;
    let goalContinuations = 0;
    // Retries already spent on the step currently being attempted; reset each
    // time a step completes.
    let providerRetries = 0;
    let overflowCompactionTried = false;
    let fallbackUsed = false;
    let outputContinuations = 0;
    // Lazy once-per-run probe of the vision fallback, used to word image
    // placeholders when a text-only model receives history with images.
    let visionFallbackProbe: { configured: boolean; ref?: string } | null = null;

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
          // The timer measures model silence only: every stream part restarts
          // it, and it stays off while a tool of this step is executing (the
          // AI SDK runs tools inside the stream, so the loop below does not
          // finish until they return).
          let toolsInFlight = 0;
          const armResponseTimeout = () => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
            if (responseTimeoutMs <= 0 || toolsInFlight > 0) return;
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              this.abortController.abort();
            }, responseTimeoutMs);
          };
          armResponseTimeout();

          // Message count the prompt was built from; pairs with the step's
          // reported inputTokens in the context tracker.
          const messageCountAtPrompt = this.session.messages.length;
          const activeVision = this.activeModel().vision === true;
          if (!activeVision && visionFallbackProbe === null) {
            const probe = this.visionModelResolver?.();
            visionFallbackProbe =
              probe?.status === 'ok' ? { configured: true, ref: probe.ref } : { configured: false };
          }
          let stepError: unknown;
          const stream = streamText({
            model: this.activeLanguageModel(),
            messages: await prepareMessagesForModel(this.session.messages, {
              vision: activeVision,
              visionConfigured: activeVision || (visionFallbackProbe?.configured ?? false),
              visionRef: visionFallbackProbe?.ref,
            }),
            tools: this.opts.tools,
            system: this.composeSystemPrompt(planHandoff),
            stopWhen: stepCountIs(1),
            // The loop below owns retries so that request failures and
            // mid-stream failures follow one policy.
            maxRetries: 0,
            // Errors arrive as `error` stream parts; the SDK's default handler
            // would also print each one to stderr, under the TUI.
            onError: () => {},
            experimental_repairToolCall: repairToolCall,
            abortSignal: this.abortController.signal,
            temperature: this.activeModel().temperature,
            topP: this.activeModel().topP,
            maxOutputTokens: this.activeModel().maxOutputTokens,
            providerOptions: this.activeProviderOptions() as Parameters<
              typeof streamText
            >[0]['providerOptions'],
          });

          for await (const part of stream.fullStream) {
            if (part.type === 'tool-call') {
              toolsInFlight += 1;
            } else if (
              part.type === 'tool-error' ||
              (part.type === 'tool-result' && !(part as { preliminary?: boolean }).preliminary)
            ) {
              toolsInFlight = Math.max(0, toolsInFlight - 1);
            }
            armResponseTimeout();
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
                reasoningStreams.set(part.id, (reasoningStreams.get(part.id) ?? '') + part.text);
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
                // When the read tool returns an image, queue it for injection
                // as a user message so the model can see it as a vision input.
                if (info.name === 'read') {
                  this.resolveAndTrackPath(rec?.args, false);
                  if (
                    result &&
                    typeof result === 'object' &&
                    'kind' in result &&
                    (result as { kind?: string }).kind === 'image' &&
                    'data' in result &&
                    typeof (result as { data?: unknown }).data === 'string'
                  ) {
                    const readPath = extractReadPath(rec?.args);
                    const sourcePath = readPath ? resolve(this.session.cwd, readPath) : undefined;
                    this.pendingImageMessages.push({
                      type: 'image',
                      image: this.storableImage(result as ReadImageResult, sourcePath),
                      ...(sourcePath
                        ? {
                            providerOptions: {
                              chimera: { sourcePath, ...imageSize(result) },
                            },
                          }
                        : {}),
                    });
                  }
                } else if (info.name === 'write' || info.name === 'edit') {
                  this.resolveAndTrackPath(rec?.args, true);
                } else if (info.name === 'apply_patch') {
                  // One patch touches several files; its result lists them.
                  const files = (result as { files?: unknown } | undefined)?.files;
                  for (const file of Array.isArray(files) ? files : []) {
                    const { path, movedTo } = file as { path?: unknown; movedTo?: unknown };
                    for (const changedPath of [path, movedTo]) {
                      if (typeof changedPath === 'string') {
                        this.session.fileOps.writes.add(resolve(this.session.cwd, changedPath));
                      }
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
                    contextWindow: this.activeContextWindow(),
                    usedContextTokens: stepUsage.inputTokens,
                    unknownWindow: this.activeContextWindowIsApproximate(),
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
                    contextWindow: this.activeContextWindow(),
                    usedContextTokens: this.session.usage.inputTokens,
                    unknownWindow: this.activeContextWindowIsApproximate(),
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
                errorMessage = describeProviderError(part.error);
                stepError = part.error;
                break;
              }
              default:
                // Ignore source, file, tool-input-*, start/start-step, raw.
                break;
            }
          }

          if (timeoutHandle) clearTimeout(timeoutHandle);
          timeoutHandle = undefined;

          // A step that failed before any tool call started has had no side
          // effects, so it is safe to send again.
          if (terminalReason === 'error' && !stepHadToolCalls) {
            const failure = classifyProviderError(stepError);
            if (
              failure.kind === 'overflow' &&
              !overflowCompactionTried &&
              this.opts.compaction?.enabled
            ) {
              overflowCompactionTried = true;
              if (await this.runCompaction(queue, 'overflow')) {
                terminalReason = 'stop';
                errorMessage = undefined;
                continue;
              }
            }
            if (failure.kind === 'temporary' && providerRetries < Agent.MAX_PROVIDER_RETRIES) {
              providerRetries += 1;
              const delayMs = failure.retryAfterMs ?? 1000 * 2 ** (providerRetries - 1);
              queue.push({
                type: 'provider_retry',
                attempt: providerRetries,
                maxAttempts: Agent.MAX_PROVIDER_RETRIES,
                delayMs,
                error: failure.message,
              });
              await this.waitUnlessInterrupted(delayMs);
              if (this.abortController.signal.aborted) {
                terminalReason = 'interrupted';
                break;
              }
              terminalReason = 'stop';
              errorMessage = undefined;
              continue;
            }
            const activeModel = this.activeModel();
            const activeRef = `${activeModel.providerId}/${activeModel.modelId}`;
            const fallback =
              failure.kind === 'temporary' && !fallbackUsed
                ? this.fallbackModelResolver?.()
                : undefined;
            if (fallback?.status === 'ok' && fallback.ref !== activeRef) {
              fallbackUsed = true;
              providerRetries = 0;
              if (this.modelOverride && this.modelOverride.trigger !== 'fallback') {
                queue.push({
                  type: 'vision_route_ended',
                  restored: `${this.opts.model.providerId}/${this.opts.model.modelId}`,
                });
              }
              this.modelOverride = {
                model: { ...fallback.model, maxSteps: this.session.model.maxSteps },
                languageModel: fallback.languageModel,
                contextWindow: fallback.contextWindow,
                contextWindowIsApproximate: fallback.contextWindowIsApproximate,
                providerOptions: fallback.providerOptions,
                trigger: 'fallback',
              };
              queue.push({
                type: 'model_fallback',
                from: activeRef,
                to: fallback.ref,
                error: failure.message,
              });
              terminalReason = 'stop';
              errorMessage = undefined;
              continue;
            }
          }
          if (terminalReason === 'error') {
            // `stream.response` rejects with a generic "No output generated"
            // for a failed step, which would replace the provider's message.
            break;
          }
          providerRetries = 0;
          overflowCompactionTried = false;

          // After the stream finishes, attach response messages.
          const response = await stream.response;
          if (response && Array.isArray(response.messages)) {
            this.session.messages.push(...(response.messages as ModelMessage[]));
          }

          const userInputRequest = this.pendingUserInputRequest as UserInputRequest | null;
          if (userInputRequest) {
            terminalReason = 'waiting_for_input';
            queue.push({ type: 'user_input_required', ...userInputRequest });
          }

          // Inject queued images as a user message so the model sees them as
          // vision inputs on the next turn. Do this after the response messages
          // are attached so the image parts land in the right order.
          if (this.pendingImageMessages.length > 0) {
            this.session.messages.push({
              role: 'user',
              content: this.pendingImageMessages,
            });
            this.pendingImageMessages = [];

            // Mid-run vision routing: a tool just produced images the active
            // model cannot see, so the remaining steps of this run switch to
            // the vision model (the next iteration's streamText picks the
            // override up through the active*() accessors).
            if (this.activeModel().vision !== true) {
              const resolution = this.visionModelResolver?.() ?? {
                status: 'unavailable' as const,
                reason: 'no vision model resolver registered',
              };
              if (resolution.status === 'ok') {
                this.modelOverride = {
                  model: { ...resolution.model, maxSteps: this.session.model.maxSteps },
                  languageModel: resolution.languageModel,
                  contextWindow: resolution.contextWindow,
                  contextWindowIsApproximate: resolution.contextWindowIsApproximate,
                  providerOptions: resolution.providerOptions,
                  trigger: 'tool_image',
                };
                queue.push({
                  type: 'vision_route_started',
                  from: `${this.opts.model.providerId}/${this.opts.model.modelId}`,
                  to: `${resolution.model.providerId}/${resolution.model.modelId}`,
                  trigger: 'tool_image',
                });
              } else if (!this.visionUnavailableEmitted) {
                this.visionUnavailableEmitted = true;
                queue.push({ type: 'vision_route_unavailable', reason: resolution.reason });
              }
            }
          }

          if (terminalReason !== 'stop') {
            // Interrupted or errored during the stream
            break;
          }

          // Drain mid-run user injections queued via `injectRunMessage()`.
          // Placed after the interrupt/error break so an interrupted run drops
          // pending injects ("interrupt means stop"); a clean step drains them
          // whether it was intermediate (tool calls) or terminal. A fresh abort
          // controller is installed so the new turn is independently
          // interruptible, and `terminalStepCount` advances so a user spamming
          // injects cannot exceed `maxTerminalSteps`.
          let injectedThisStep = false;
          if ((this.session.pendingPermissionFeedback?.length ?? 0) > 0) {
            const feedbackMessages = this.session.pendingPermissionFeedback ?? [];
            this.session.pendingPermissionFeedback = [];
            for (const feedback of feedbackMessages) {
              this.session.messages.push(await buildUserMessage(feedback));
              queue.push({ type: 'user_message', content: feedback });
            }
            injectedThisStep = true;
            this.abortController = new AbortController();
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
          }
          if (this.pendingInjectMessages.length > 0) {
            const injects = this.pendingInjectMessages;
            this.pendingInjectMessages = [];
            for (const inject of injects) {
              this.session.messages.push(await buildUserMessage(inject.content, inject.images));
              queue.push({
                type: 'user_message',
                content: inject.content,
                imageCount: inject.images?.length,
              });
            }
            injectedThisStep = true;
            this.abortController = new AbortController();
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
              await this.runCompaction(queue, 'threshold');
            }
            continue;
          }

          // Terminal step
          terminalStepCount += 1;

          if (terminalStepCount > maxTerminalSteps) {
            terminalReason = 'max_steps';
          } else if (finishReason === 'length') {
            // The model hit its output limit mid-answer. The partial answer
            // is already in the conversation, so ask for the rest.
            if (outputContinuations < Agent.MAX_OUTPUT_CONTINUATIONS) {
              outputContinuations += 1;
              this.session.messages.push({ role: 'user', content: OUTPUT_CONTINUATION_NOTE });
              queue.push({
                type: 'output_continued',
                attempt: outputContinuations,
                maxAttempts: Agent.MAX_OUTPUT_CONTINUATIONS,
              });
              this.abortController = new AbortController();
              hitSafetyCap = false;
              continue;
            }
            terminalReason = 'output_limit';
          }

          // If user messages were injected this step, loop back so the model
          // responds to them. `terminalStepCount` already advanced above, so
          // the `maxTerminalSteps` cap still bounds runaway inject loops.
          if (injectedThisStep && terminalReason === 'stop') {
            hitSafetyCap = false;
            continue;
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
      if (
        terminalReason === 'waiting_for_input' &&
        this.pendingUserInputRequest &&
        this.opts.userInputRequiredHook
      ) {
        await this.opts.userInputRequiredHook.fire(this.pendingUserInputRequest);
      }

      // Stop hook: only for clean "stop", not error/interrupted/timeout.
      if (
        terminalReason === 'stop' &&
        this.opts.stopHook &&
        stopRetryCount < Agent.MAX_STOP_RETRIES
      ) {
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

      // Goal check: the last word on a clean stop, after the user's Stop hook
      // let the run end.
      if (terminalReason === 'stop' && this.session.goal && this.opts.goalCheck) {
        const outcome = await this.checkGoal(this.session.goal, goalContinuations);
        if (outcome === 'interrupted') {
          terminalReason = 'interrupted';
        } else {
          queue.push(outcome.event);
          if (outcome.message !== undefined) {
            goalContinuations++;
            this.session.messages.push({ role: 'user', content: outcome.message });
            queue.push({ type: 'user_message', content: outcome.message });
            // Fresh abort controller for the next turn.
            this.abortController = new AbortController();
            continue;
          }
          if (outcome.event.change === 'limit') terminalReason = 'max_steps';
        }
      }

      break; // No more retries.
    }

    this.session.status =
      terminalReason === 'waiting_for_input'
        ? 'waiting_for_input'
        : terminalReason === 'error' || terminalReason === 'timeout'
          ? 'error'
          : 'idle';
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

    if (this.modelOverride) {
      if (this.modelOverride.trigger !== 'fallback') {
        queue.push({
          type: 'vision_route_ended',
          restored: `${this.opts.model.providerId}/${this.opts.model.modelId}`,
        });
      }
      this.modelOverride = null;
    }

    queue.push({
      type: 'run_finished',
      reason: terminalReason,
      error: errorMessage,
    });
  }
}

/**
 * A line for the scrollback when the output budget shortened a tool result:
 * the user sees less than the tool produced and should know where the rest is.
 */
function describeShortenedOutput(result: unknown): string | undefined {
  const archived = (result as { output_archived?: unknown } | undefined)?.output_archived;
  if (!Array.isArray(archived) || archived.length === 0) return undefined;
  const entries = archived as Array<{ id?: string; tokens?: number }>;
  const tokens = entries.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
  const ids = entries.flatMap((entry) => (entry.id ? [entry.id] : []));
  const size = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
  return ids.length > 0
    ? `output shortened (${size} tokens); full text archived as ${ids.join(', ')}`
    : `output shortened (${size} tokens)`;
}

const OUTPUT_CONTINUATION_NOTE =
  'Your previous message was cut off by the output limit. Continue from exactly ' +
  'where it stopped. Do not repeat text you already wrote.';

interface ReadImageResult {
  data: string;
  width?: number;
  height?: number;
}

/** The dimensions the read tool parsed, omitted entirely when it could not. */
function imageSize(result: unknown): { width: number; height: number } | Record<string, never> {
  const { width, height } = result as ReadImageResult;
  if (typeof width !== 'number' || typeof height !== 'number') return {};
  return { width, height };
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
  policyAnalysis?: PermissionRequest['policyAnalysis'];
}): PermissionRequest {
  return {
    requestId: newRequestId(),
    tool: args.tool,
    target: 'host',
    command: args.command,
    cwd: args.cwd,
    reason: args.reason,
    policyAnalysis: args.policyAnalysis,
  };
}

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/**
 * True when a user message *after the last assistant/tool message* carries
 * image parts — i.e. images the model has not seen yet. Covers images
 * attached via `appendMessage` while idle, followed by a plain `run()`.
 */
function tailHasImageParts(messages: ModelMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') return false;
    if (Array.isArray(msg.content) && msg.content.some((part) => part.type === 'image')) {
      return true;
    }
  }
  return false;
}

/**
 * Enough to reach the dimensions in any format we accept. PNG/GIF/WebP/BMP put
 * them in the first bytes; a JPEG's SOF marker sits past whatever EXIF the
 * camera wrote, so read a chunk rather than paying to load whole files.
 */
const GOAL_CHECK_TIMEOUT_MS = 60_000;

/** The text of a message's content: the string itself, or its text parts. */
function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

const IMAGE_HEADER_BYTES = 64 * 1024;

async function readImageHeader(path: string): Promise<Uint8Array | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, IMAGE_HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

type ImagePartParam = { type: 'image'; image: string; providerOptions?: unknown };

/**
 * Attached images persist as a path; the prompt builder inflates them to base64
 * per request. Dimensions ride along so the estimator can price the image
 * without re-reading it on every step.
 */
async function imagePartForPath(path: string): Promise<ImagePartParam> {
  const header = await readImageHeader(path);
  const dims = header ? readImageDimensions(header) : undefined;
  return { type: 'image', image: path, ...(dims ? { providerOptions: { chimera: dims } } : {}) };
}

async function buildUserMessage(text: string, imagePaths?: string[]): Promise<ModelMessage> {
  if (!imagePaths || imagePaths.length === 0) {
    return { role: 'user', content: text };
  }
  const parts: Array<{ type: 'text'; text: string } | ImagePartParam> = [{ type: 'text', text }];
  for (const path of imagePaths) {
    parts.push(await imagePartForPath(path));
  }
  return { role: 'user', content: parts } as ModelMessage;
}

interface MessagePrepOptions {
  /** Whether the model receiving this prompt accepts image parts. */
  vision: boolean;
  /** Whether a usable vision fallback model is configured. */
  visionConfigured: boolean;
  /** Ref ("provider/model") of the vision fallback, when configured. */
  visionRef?: string;
}

/**
 * The file path an image part originated from: the part value itself for
 * user-attached images (persisted as paths), or the recorded read target
 * for tool-produced images (persisted as data URIs).
 */
function imageSourcePath(part: { image: unknown; providerOptions?: unknown }): string | undefined {
  if (typeof part.image === 'string' && !part.image.startsWith('data:')) return part.image;
  const chimeraOptions = (part.providerOptions as { chimera?: { sourcePath?: unknown } })?.chimera;
  return typeof chimeraOptions?.sourcePath === 'string' ? chimeraOptions.sourcePath : undefined;
}

/**
 * Text stand-in for an image part when the active model cannot see images.
 * Points the model back at the file (re-reading routes to the vision model
 * again) or, with no fallback configured, tells it how the user can fix it.
 */
function imagePlaceholder(sourcePath: string | undefined, opts: MessagePrepOptions): string {
  if (!opts.visionConfigured) {
    const subject = sourcePath ? `Image at ${sourcePath}` : 'Image';
    return (
      `[${subject}: this model cannot view images and no defaultVisionModel is ` +
      'configured. Tell the user to set "defaultVisionModel" in ~/.chimera/config.json ' +
      'if image understanding is needed.]'
    );
  }
  if (!sourcePath) {
    return '[Image: previously provided inline; not viewable by the current model.]';
  }
  const viewed =
    `[Image: ${sourcePath} — viewed by the vision model (${opts.visionRef}) earlier in ` +
    'this conversation; its description appears in the assistant messages that follow.';
  return existsSync(sourcePath)
    ? `${viewed} Read the file again with the read tool to re-examine it.]`
    : `${viewed} The file no longer exists on disk.]`;
}

/**
 * Build the live prompt copy of `messages` for the model about to be called.
 * Vision-capable models get image paths resolved to base64 data URIs;
 * text-only models get image parts replaced with text placeholders. The
 * original `session.messages` is untouched (paths persist small on disk).
 */
async function prepareMessagesForModel(
  messages: ModelMessage[],
  opts: MessagePrepOptions,
): Promise<ModelMessage[]> {
  const prepared: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      prepared.push(elideImageToolResults(msg));
      continue;
    }
    if (msg.role !== 'user' || typeof msg.content === 'string') {
      prepared.push(msg);
      continue;
    }
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const newParts: typeof parts = [];
    for (const part of parts) {
      if (part.type !== 'image' || typeof part.image !== 'string') {
        newParts.push(part);
        continue;
      }
      if (!opts.vision) {
        newParts.push({ type: 'text', text: imagePlaceholder(imageSourcePath(part), opts) });
        continue;
      }
      if (part.image.startsWith('data:')) {
        newParts.push(part);
        continue;
      }
      try {
        const data = await readFile(part.image);
        const ext = extname(part.image).toLowerCase();
        const mime = EXT_TO_MIME[ext] ?? 'image/png';
        const base64 = data.toString('base64');
        newParts.push({ type: 'image', image: `data:${mime};base64,${base64}` });
      } catch {
        // A raw path would be rejected by the provider; degrade to text.
        newParts.push({
          type: 'text',
          text: `[Image unavailable: ${part.image} could not be read]`,
        });
      }
    }
    prepared.push({ ...msg, content: newParts });
  }
  return prepared;
}
