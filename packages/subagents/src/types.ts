import type { AgentEvent, CallId, ModelConfig, SandboxMode, SessionId } from '@chimera/core';
import type { AutoApproveLevel } from '@chimera/permissions';

export type SubagentReason =
  | 'stop'
  | 'max_steps'
  | 'error'
  | 'timeout'
  | 'interrupted';

export interface SubagentSpawnOptions {
  prompt: string;
  purpose: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  sandbox?: boolean;
  sandboxMode?: 'bind' | 'overlay' | 'ephemeral';
  timeoutMs?: number;
  inProcess?: boolean;
}

export interface SubagentResult {
  subagent_id: string;
  result: string;
  reason: SubagentReason;
  session_id: SessionId;
  steps: number;
  tool_calls_count: number;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Builds a fresh in-process Agent for `in_process: true` spawns. The CLI
 * supplies this when registering the tool; when omitted, in-process mode
 * returns an error result rather than crashing.
 */
export interface InProcessAgentBuilder {
  (init: {
    cwd: string;
    model: ModelConfig;
    sandboxMode: SandboxMode;
    parentAbortSignal: AbortSignal;
    systemPrompt?: string;
    toolNames: string[];
    currentDepth: number;
    maxDepth: number;
    /**
     * Always `true` for in-process spawns: the parent's TUI cannot resolve a
     * permission prompt raised inside the parent's own event loop without
     * re-entrant scheduling, so in-process children auto-deny host prompts
     * regardless of the parent's TTY state. See SUBAGENTS.md.
     */
    headlessAutoDeny: boolean;
  }): Promise<{
    sessionId: SessionId;
    send: (
      prompt: string,
      opts?: { signal?: AbortSignal },
    ) => AsyncIterable<AgentEvent>;
    interrupt: () => void;
    dispose: () => Promise<void>;
  }>;
}

export interface SpawnAgentToolContext {
  /** Emit an event into the parent's event stream. */
  emit: (event: AgentEvent) => void;
  /** Parent's abort signal. When fired, the tool cascades the interrupt. */
  parentAbortSignal: AbortSignal;
  /** Parent's session id (used for `--parent` on the child). */
  parentSessionId: SessionId;
  /** Parent's working directory. */
  cwd: string;
  /** Default model ref (`provider/model`) to use when child does not override. */
  defaultModelRef: string;
  /** Parent's sandbox mode (children inherit unless overridden). */
  sandboxMode: SandboxMode;
  /** Parent's auto-approve level (children inherit). */
  autoApprove: AutoApproveLevel;
  /** Current nesting depth of the parent. Children get `currentDepth + 1`. */
  currentDepth: number;
  /** Max nesting depth (default 3). Tool returns an error at >= maxDepth. */
  maxDepth: number;
  /** Path to the `chimera` executable used to spawn child processes. */
  chimeraBin: string;
  /** Optional args to prepend before the chimera subcommand (for `node bin.js` style invocation). */
  chimeraBinArgs?: string[];
  /** Optional in-process builder; when absent, `in_process: true` errors. */
  inProcess?: InProcessAgentBuilder;
  /** Whether the parent has a TTY (controls headless permission auto-deny). */
  parentHasTty: boolean;
  /** Default per-call timeout in ms when the model does not specify one. */
  defaultTimeoutMs?: number;
  /**
   * Resolves the AI SDK's per-call `toolCallId` to the parent agent's
   * `CallId` for the same in-flight tool invocation. The CLI factory wires
   * this to `agent.resolveCallId`. When present, the spawn tool uses the
   * resolved CallId as `parentCallId` on emitted `subagent_spawned` /
   * `subagent_finished` events so the TUI can nest sub-events under the
   * `spawn_agent` row that produced them.
   */
  resolveCallId?: (toolCallId: string) => CallId | undefined;
}

export type SpawnEmit = (event: AgentEvent) => void;
