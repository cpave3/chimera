import type { CallId } from '@chimera/core';
import { newCallId } from '@chimera/core';
import { defineTool } from '@chimera/tools';
import { z } from 'zod';
import { parseToolsCsv } from './agents/frontmatter';
import { driveChild, spawnChimeraChild, teardownChild, type ChildHandle } from './spawn-child';
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
  agent: z
    .string()
    .optional()
    .describe(
      'Name of an agent definition (e.g. "review-correctness"). When set, the ' +
        "definition's body becomes the child's system prompt and its frontmatter " +
        'tools/model are applied. Explicit `tools`/`model`/`system_prompt` args still override.',
    ),
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
  const baseDescription =
    'Spawn a fresh Chimera agent (a "subagent") to handle a delegated task. ' +
    "Returns the subagent's final answer as a string. Use for sub-investigations, " +
    'research, or parallelizable tool work where keeping the parent context clean matters.';
  const agentIndex = ctx.agents?.buildDescriptionIndex() ?? '';
  const modelIndex = buildModelIndex(ctx.availableModels);
  const description = [baseDescription, agentIndex, modelIndex].filter((s) => s).join('\n\n');

  return defineTool<SpawnAgentArgs, SubagentResult>({
    description,
    inputSchema: ARGS_SCHEMA,
    formatScrollback: (args, result) => {
      const label = args.purpose && args.purpose.length > 0 ? args.purpose : args.prompt;
      const head = clipSpawnLabel(label);
      if (!result) return { summary: head };
      const tag = result.reason === 'stop' ? 'done' : result.reason;
      return { summary: `${head} (${tag})` };
    },
    execute: async (args, opts): Promise<SubagentResult> => {
      const validated = ARGS_SCHEMA.parse(args);
      const { abortSignal } = opts;
      const aiSdkToolCallId = (opts as { toolCallId?: string }).toolCallId;
      const subagentId = newCallId();
      // The AI SDK calls `execute` in the same async tick that emits the
      // matching `tool-call` event onto `fullStream`. With one tool call a
      // single microtask yield was enough — but parallel calls (the SDK fires
      // them via `Promise.all`) race the agent's for-await consumer, and a
      // microtask hack drops the mapping for at least one. Prefer the
      // deterministic async resolver: the agent populates
      // `callIdByToolCallId` and wakes anyone awaiting that toolCallId. If
      // the host doesn't supply `awaitCallId`, fall back to the legacy
      // microtask + sync `resolveCallId` (still good enough for serial
      // calls).
      let parentCallId: CallId;
      if (aiSdkToolCallId && ctx.awaitCallId) {
        try {
          parentCallId = await ctx.awaitCallId(aiSdkToolCallId, ctx.parentAbortSignal);
        } catch {
          parentCallId = newCallId();
        }
      } else {
        await Promise.resolve();
        parentCallId =
          (aiSdkToolCallId ? ctx.resolveCallId?.(aiSdkToolCallId) : undefined) ?? newCallId();
      }
      const childCwd = validated.cwd ?? ctx.cwd;

      // Resolve agent definition (if any). Explicit args override frontmatter.
      let agentSystemPrompt: string | undefined;
      let agentTools: string[] | undefined;
      let agentModelRef: string | undefined;
      if (validated.agent) {
        if (!ctx.agents) {
          return errorResult({
            subagentId,
            message: `agent "${validated.agent}" requested but no agent registry is configured`,
          });
        }
        const def = ctx.agents.find(validated.agent);
        if (!def) {
          const available = ctx.agents
            .all()
            .map((agent) => agent.name)
            .join(', ');
          return errorResult({
            subagentId,
            message: available
              ? `unknown agent "${validated.agent}"; available: ${available}`
              : `unknown agent "${validated.agent}" (no agent definitions discovered)`,
          });
        }
        agentSystemPrompt = def.body;
        agentTools = parseToolsCsv(def.frontmatter['tools']);
        const rawModel = def.frontmatter['model']?.trim();
        if (rawModel && rawModel.includes('/')) {
          agentModelRef = rawModel;
        }
      }

      const effectiveSystemPrompt = validated.system_prompt ?? agentSystemPrompt;
      const effectiveTools =
        validated.tools ?? (agentTools && agentTools.length > 0 ? agentTools : undefined);
      const modelRef = validated.model ?? agentModelRef ?? ctx.defaultModelRef;
      const inProcess = validated.in_process === true;
      const timeoutMs = validated.timeout_ms ?? ctx.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

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
        const parsedModel = parseModelRef(modelRef, ctx.modelOptions);
        const desiredSandboxMode = inheritSandboxMode(ctx.sandboxMode, validated);
        try {
          const handle = await spawnInProcessChild({
            builder: ctx.inProcess,
            cwd: childCwd,
            modelRef,
            parsedModel,
            sandboxMode: desiredSandboxMode,
            parentAbortSignal: effectiveSignal,
            systemPrompt: effectiveSystemPrompt,
            toolNames: effectiveTools ?? DEFAULT_TOOLS,
            currentDepth: ctx.currentDepth + 1,
            maxDepth: ctx.maxDepth,
          });

          ctx.emit({
            type: 'subagent_spawned',
            subagentId,
            parentCallId,
            childSessionId: handle.childSessionId,
            url: '',
            purpose: validated.purpose,
          });

          const driven = await driveInProcess(
            handle,
            validated.prompt,
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
          sandbox: validated.sandbox === undefined ? ctx.sandboxMode !== 'off' : validated.sandbox,
          sandboxMode: validated.sandbox_mode,
          parentHasTty: ctx.parentHasTty,
          currentSubagentDepth: ctx.currentDepth + 1,
          maxSubagentDepth: ctx.maxDepth,
          systemPrompt: effectiveSystemPrompt,
          tools: effectiveTools,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // No subagent_spawned emitted — handshake never completed.
        return errorResult({ subagentId, message: msg });
      }

      ctx.emit({
        type: 'subagent_spawned',
        subagentId,
        parentCallId,
        childSessionId: handle.childSessionId,
        url: handle.url,
        purpose: validated.purpose,
      });

      const driven = await driveChild(
        handle,
        validated.prompt,
        (ev) => ctx.emit({ type: 'subagent_event', subagentId, event: ev }),
        { signal: effectiveSignal, timeoutMs },
      );

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

function buildModelIndex(refs: string[] | undefined): string {
  if (!refs || refs.length === 0) return '';
  const lines: string[] = ['Available models (pass via the `model` arg, default first):'];
  refs.forEach((ref, idx) => {
    lines.push(idx === 0 ? `- ${ref} (default)` : `- ${ref}`);
  });
  return lines.join('\n');
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

function parseModelRef(
  ref: string,
  modelOptions?: Record<string, { maxOutputTokens?: number }>,
): {
  providerId: string;
  modelId: string;
  maxSteps: number;
  maxOutputTokens?: number;
} {
  const slash = ref.indexOf('/');
  if (slash <= 0) {
    throw new Error(`invalid model ref "${ref}" (expected "<providerId>/<modelId>")`);
  }
  return {
    providerId: ref.slice(0, slash),
    modelId: ref.slice(slash + 1),
    maxSteps: 50,
    maxOutputTokens: modelOptions?.[ref]?.maxOutputTokens,
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
