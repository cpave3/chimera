import { newCallId } from '@chimera/core';
import { defineTool } from '@chimera/tools';
import { z } from 'zod';
import {
  driveChild,
  interruptChild,
  spawnChimeraChild,
  teardownChild,
  type ChildHandle,
} from './spawn-child';
import { driveInProcess, spawnInProcessChild } from './spawn-in-process';
import type { SpawnAgentToolContext, SubagentResult } from './types';

const DEFAULT_TOOLS = ['bash', 'read', 'write', 'edit', 'glob', 'grep'];
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes per spec.

const ARGS_SCHEMA = z.object({
  prompt: z.string().min(1).describe('The instructions for the subagent.'),
  purpose: z
    .string()
    .min(1)
    .describe('Short label (≤80 chars) shown in the parent TUI alongside the subagent id.'),
  cwd: z.string().optional().describe('Override the working directory.'),
  model: z
    .string()
    .optional()
    .describe('Override the model ref (e.g. anthropic/claude-haiku-4-5).'),
  tools: z
    .array(z.string())
    .optional()
    .describe('Tool names to enable in the child. Defaults to bash/read/write/edit.'),
  system_prompt: z.string().optional().describe("Replace the child's system prompt."),
  sandbox: z.boolean().optional().describe("Override the parent's sandbox setting."),
  sandbox_mode: z
    .enum(['bind', 'overlay', 'ephemeral'])
    .optional()
    .describe("Override the child's sandbox mode."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Per-call wall-clock cap. Default 600000 (10 minutes).'),
  in_process: z
    .boolean()
    .optional()
    .describe(
      'Run the child in-process (no separate chimera serve). Default false. ' +
        'In-process children are not visible to chimera ls / chimera attach.',
    ),
});

export type SpawnAgentArgs = z.infer<typeof ARGS_SCHEMA>;

export function buildSpawnAgentTool(ctx: SpawnAgentToolContext) {
  return defineTool<SpawnAgentArgs, SubagentResult>({
    description:
      'Spawn a fresh Chimera agent (a "subagent") to handle a delegated task. ' +
      "Returns the subagent's final answer as a string. Use for sub-investigations, " +
      'research, or parallelizable tool work where keeping the parent context clean matters.',
    inputSchema: ARGS_SCHEMA,
    formatScrollback: (args, result) => {
      const label = args.purpose && args.purpose.length > 0 ? args.purpose : args.prompt;
      const head = clipSpawnLabel(label);
      if (!result) return { summary: head };
      const tag = result.reason === 'stop' ? 'done' : result.reason;
      return { summary: `${head} (${tag})` };
    },
    execute: async (args, opts): Promise<SubagentResult> => {
      const { abortSignal } = opts;
      const aiSdkToolCallId = (opts as { toolCallId?: string }).toolCallId;
      const subagentId = newCallId();
      // AI SDK invokes `execute` from inside the same transformer tick that
      // emits the `tool-call` stream event, so the agent's for-await consumer
      // hasn't yet populated `callIdByToolCallId` for this call. Yield one
      // microtask so the consumer's tool-call branch runs first; only then is
      // the resolver guaranteed to find our entry.
      await Promise.resolve();
      const parentCallId =
        (aiSdkToolCallId ? ctx.resolveCallId?.(aiSdkToolCallId) : undefined) ?? newCallId();
      const childCwd = args.cwd ?? ctx.cwd;
      const modelRef = args.model ?? ctx.defaultModelRef;
      const inProcess = args.in_process === true;
      const timeoutMs = args.timeout_ms ?? ctx.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

      // Effective signal: combine the AI SDK's per-call abortSignal with the
      // parent agent's own signal so either can interrupt the child.
      const effectiveSignal = combineSignals(abortSignal, ctx.parentAbortSignal);

      // Depth check.
      if (ctx.currentDepth >= ctx.maxDepth) {
        return errorResult({
          subagentId,
          message: `max subagent depth (${ctx.maxDepth}) reached`,
        });
      }

      if (inProcess) {
        if (!ctx.inProcess) {
          return errorResult({
            subagentId,
            message: 'in_process subagents are not enabled in this runtime',
          });
        }
        const parsedModel = parseModelRef(modelRef);
        const desiredSandboxMode = inheritSandboxMode(ctx.sandboxMode, args);
        try {
          const handle = await spawnInProcessChild({
            builder: ctx.inProcess,
            cwd: childCwd,
            modelRef,
            parsedModel,
            sandboxMode: desiredSandboxMode,
            parentAbortSignal: effectiveSignal,
            systemPrompt: args.system_prompt,
            toolNames: args.tools ?? DEFAULT_TOOLS,
            currentDepth: ctx.currentDepth + 1,
            maxDepth: ctx.maxDepth,
          });

          ctx.emit({
            type: 'subagent_spawned',
            subagentId,
            parentCallId,
            childSessionId: handle.childSessionId,
            url: '',
            purpose: args.purpose,
          });

          const driven = await driveInProcess(
            handle,
            args.prompt,
            (ev) => ctx.emit({ type: 'subagent_event', subagentId, event: ev }),
            { signal: effectiveSignal, timeoutMs },
          );

          await handle.dispose();

          ctx.emit({
            type: 'subagent_finished',
            subagentId,
            parentCallId,
            result: driven.finalText,
            reason: driven.reason,
          });

          return {
            subagent_id: subagentId,
            result: driven.finalText || (driven.errorMessage ?? ''),
            reason: driven.reason,
            session_id: handle.childSessionId,
            steps: driven.steps,
            tool_calls_count: driven.toolCallsCount,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.emit({
            type: 'subagent_finished',
            subagentId,
            parentCallId,
            result: msg,
            reason: 'error',
          });
          return errorResult({ subagentId, message: msg });
        }
      }

      // Child-process path.
      let handle: ChildHandle | undefined;
      try {
        handle = await spawnChimeraChild({
          chimeraBin: ctx.chimeraBin,
          chimeraBinArgs: ctx.chimeraBinArgs,
          cwd: childCwd,
          parentSessionId: ctx.parentSessionId,
          modelRef,
          autoApprove: ctx.autoApprove,
          sandbox: args.sandbox === undefined ? ctx.sandboxMode !== 'off' : args.sandbox,
          sandboxMode: args.sandbox_mode,
          parentHasTty: ctx.parentHasTty,
          currentSubagentDepth: ctx.currentDepth + 1,
          maxSubagentDepth: ctx.maxDepth,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // No subagent_spawned emitted — handshake never completed.
        return errorResult({ subagentId, message: msg });
      }

      const onAbort = () => {
        if (handle) void interruptChild(handle).catch(() => {});
      };
      effectiveSignal.addEventListener('abort', onAbort, { once: true });

      ctx.emit({
        type: 'subagent_spawned',
        subagentId,
        parentCallId,
        childSessionId: handle.childSessionId,
        url: handle.url,
        purpose: args.purpose,
      });

      let driven;
      try {
        driven = await driveChild(
          handle,
          args.prompt,
          (ev) => ctx.emit({ type: 'subagent_event', subagentId, event: ev }),
          { signal: effectiveSignal, timeoutMs },
        );
      } finally {
        effectiveSignal.removeEventListener('abort', onAbort);
      }

      await teardownChild(handle);

      ctx.emit({
        type: 'subagent_finished',
        subagentId,
        parentCallId,
        result: driven.finalText,
        reason: driven.reason,
      });

      return {
        subagent_id: subagentId,
        result: driven.finalText || (driven.errorMessage ?? ''),
        reason: driven.reason,
        session_id: handle.childSessionId,
        steps: driven.steps,
        tool_calls_count: driven.toolCallsCount,
      };
    },
  });
}

function clipSpawnLabel(s: string): string {
  const firstLine = s.split('\n', 1)[0] ?? '';
  if (firstLine.length <= 60) return firstLine;
  return `${firstLine.slice(0, 60)}…`;
}

function errorResult(opts: { subagentId: string; message: string }): SubagentResult {
  return {
    subagent_id: opts.subagentId,
    result: opts.message,
    reason: 'error',
    session_id: '',
    steps: 0,
    tool_calls_count: 0,
  };
}

function inheritSandboxMode(
  parent: 'off' | 'bind' | 'overlay' | 'ephemeral',
  args: SpawnAgentArgs,
): 'off' | 'bind' | 'overlay' | 'ephemeral' {
  if (args.sandbox === false) return 'off';
  if (args.sandbox_mode) return args.sandbox_mode;
  if (args.sandbox === true && parent === 'off') return 'bind';
  return parent;
}

function parseModelRef(ref: string): {
  providerId: string;
  modelId: string;
  maxSteps: number;
} {
  const slash = ref.indexOf('/');
  if (slash <= 0) {
    throw new Error(`invalid model ref "${ref}" (expected "<providerId>/<modelId>")`);
  }
  return {
    providerId: ref.slice(0, slash),
    modelId: ref.slice(slash + 1),
    maxSteps: 50,
  };
}

function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 0) return new AbortController().signal;
  if (live.length === 1) return live[0];
  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      controller.abort();
      return controller.signal;
    }
    s.addEventListener(
      'abort',
      () => {
        if (!controller.signal.aborted) controller.abort();
      },
      { once: true },
    );
  }
  return controller.signal;
}
