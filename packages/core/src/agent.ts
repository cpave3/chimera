import { stepCountIs, streamText, type ModelMessage, type LanguageModel, type ToolSet } from 'ai';
import { EventQueue } from './event-queue';
import { type AgentEvent } from './events';
import {
  type CallId,
  type SessionId,
  newCallId,
  newRequestId,
  newSessionId,
} from './ids';
import type { PermissionRequest, PermissionResolution } from './interfaces';
import { persistSession } from './persistence';
import {
  type ExecutionTarget,
  type ModelConfig,
  type RememberScope,
  type SandboxMode,
  type Session,
  type ToolCallRecord,
} from './types';

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
   * Optional hook: if a `read` tool call resolves to a known SKILL.md, returns
   * `{ skillName, source }` so the agent can emit `skill_activated`. Purely
   * observational; return value does not change tool behavior.
   */
  skillActivation?: (readPath: string) => {
    skillName: string;
    source: 'project' | 'user' | 'claude-compat';
  } | undefined;
}

export type PermissionRaiseHandler = (
  req: PermissionRequest,
) => Promise<PermissionResolution>;

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

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.abortController = new AbortController();

    if (opts.session) {
      this.session = { ...opts.session, status: 'idle' };
    } else {
      this.session = {
        id: opts.sessionId ?? newSessionId(),
        cwd: opts.cwd,
        createdAt: Date.now(),
        messages: [],
        toolCalls: [],
        status: 'idle',
        model: opts.model,
        sandboxMode: opts.sandboxMode,
      };
    }
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

  resolvePermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember?: RememberScope,
  ): void {
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
  }

  hasPendingPermission(requestId: string): boolean {
    return this.pendingPermissions.has(requestId);
  }

  interrupt(): void {
    this.abortController.abort();
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

  private async runInternal(
    userMessage: string,
    queue: EventQueue<AgentEvent>,
  ): Promise<void> {
    this.session.status = 'running';
    this.session.messages.push({ role: 'user', content: userMessage });

    queue.push({ type: 'session_started', sessionId: this.session.id });
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
            textStreams.set(
              part.id,
              (textStreams.get(part.id) ?? '') + part.text,
            );
            queue.push({ type: 'assistant_text_delta', delta: part.text });
            break;
          case 'text-end': {
            const full = textStreams.get(part.id) ?? '';
            textStreams.delete(part.id);
            if (full.length > 0) {
              queue.push({ type: 'assistant_text_done', text: full });
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
            queue.push({
              type: 'tool_call_start',
              callId,
              name: part.toolName,
              args,
              target,
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
            break;
          }
          case 'tool-error': {
            const info = callInfo.get(part.toolCallId);
            if (!info) break;
            const err = (part as { error?: unknown }).error;
            const msg = err instanceof Error ? err.message : String(err);
            const rec = this.session.toolCalls.find((t) => t.callId === info.callId);
            if (rec) {
              rec.error = msg;
              rec.endedAt = Date.now();
            }
            queue.push({ type: 'tool_call_error', callId: info.callId, error: msg });
            callInfo.delete(part.toolCallId);
            break;
          }
          case 'finish-step': {
            stepNumber += 1;
            queue.push({
              type: 'step_finished',
              stepNumber,
              finishReason: part.finishReason,
            });
            try {
              await persistSession(this.session, this.opts.home);
            } catch (_e) {
              // persistence errors should not crash the run
            }
            break;
          }
          case 'finish': {
            // Handled by exiting the loop.
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
            errorMessage =
              part.error instanceof Error ? part.error.message : String(part.error);
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
      await persistSession(this.session, this.opts.home);
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
    const p = (args as { path?: unknown }).path;
    if (typeof p === 'string' && p.length > 0) return p;
  }
  return undefined;
}

function extractTarget(args: unknown, sandboxMode: SandboxMode): ExecutionTarget {
  if (args && typeof args === 'object' && 'target' in args) {
    const t = (args as { target?: unknown }).target;
    if (t === 'sandbox' || t === 'host') return t;
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
