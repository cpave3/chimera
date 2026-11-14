import { newRequestId, permissionDenialMessage } from '@chimera/core';
import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { clip, stripCdPrefix } from './format';
import { sandboxBlockNote } from './os-sandbox';

const BASH_SCHEMA = z.object({
  command: z.string().describe('The shell command to run.'),
  timeout_ms: z.number().int().positive().optional().describe('Timeout in ms. Default 120000.'),
  target: z
    .enum(['sandbox', 'host'])
    .optional()
    .describe("Which executor to use. Defaults to 'host' when sandbox is off."),
  reason: z
    .string()
    .optional()
    .describe(
      "Short justification for running on the host (required when sandbox is on and target='host').",
    ),
  unsandboxed: z
    .boolean()
    .optional()
    .describe(
      'Run the command outside the OS sandbox. Needs a reason and user approval or an explicit saved bypass permission. ' +
        'Use it only after the sandbox blocked a command that must write outside the working ' +
        'directory or reach the network.',
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Run the command as a background process and return a shell_id immediately. ' +
        'Poll output with bash_output; terminate with bash_kill. Use for dev servers, ' +
        'watchers, and long builds. Background commands always run on the host.',
    ),
});
type BashArgs = z.infer<typeof BASH_SCHEMA>;
type BashResult =
  | {
      stdout: string;
      stderr: string;
      exit_code: number;
      timed_out: boolean;
      /** Present when the OS sandbox is why the command failed. */
      sandbox?: string;
      sandbox_retry?: {
        reason: string;
        initial_exit_code: number;
        initial_stdout: string;
        initial_stderr: string;
      };
    }
  | {
      shell_id: string;
      message: string;
    };

/** What the model must know of the OS sandbox before its first command, or nothing. */
function osSandboxDescription(ctx: ToolContext): string {
  if (!ctx.osSandbox || ctx.sandboxMode !== 'off') return '';
  const limits =
    ctx.osSandbox.spec.network === 'off'
      ? 'it can read every file, can write only in the working directory and the temp directory, and has no network access'
      : 'it can read every file and can write only in the working directory and the temp directory';
  return ` A command runs in an OS sandbox: ${limits}. A recognized sandbox failure is retried once on the host when an explicit saved bypass rule authorizes it. Otherwise, set unsandboxed: true with a reason to request approval. Do not ask the user to run the command manually.`;
}

export function buildBashTool(ctx: ToolContext) {
  return defineTool<BashArgs, BashResult>({
    description:
      'Execute a shell command and return its stdout, stderr, exit code, and whether it timed out. ' +
      'Use for builds, tests, git, inspecting the environment. ' +
      "In sandbox mode, set target='host' (with a 'reason') to run on the host instead of the sandbox." +
      osSandboxDescription(ctx),
    promptSnippet: 'Run a shell command: builds, tests, git, anything without a dedicated tool.',
    inputSchema: BASH_SCHEMA,
    execute: async (args, { abortSignal, toolCallId }) => {
      const command = args.command;
      if (args.run_in_background) {
        return launchBackground(ctx, args, toolCallId, abortSignal);
      }

      const target: 'sandbox' | 'host' =
        args.target ?? (ctx.sandboxMode === 'off' ? 'host' : 'sandbox');
      const refuse = (stderr: string): BashResult => ({
        stdout: '',
        stderr,
        exit_code: -1,
        timed_out: false,
      });

      const executor =
        target === 'host' ? (ctx.bashHostExecutor ?? ctx.hostExecutor) : ctx.sandboxExecutor;

      if (ctx.sandboxMode !== 'off' && target === 'host' && !args.reason) {
        return refuse("refused by chimera: target='host' requires a 'reason'.");
      }
      const scope = hostScope(ctx, args, target);
      if ('refusal' in scope) return refuse(scope.refusal);
      let sandboxed = scope.sandboxed;
      if (target === 'host' && ctx.permissionGate) {
        const requestId = newRequestId();
        const resolution = await ctx.permissionGate.request({
          requestId,
          tool: 'bash',
          target: 'host',
          command,
          cwd: executor.cwd(),
          ...(args.reason ? { reason: args.reason } : {}),
          ...(toolCallId ? { toolCallId } : {}),
          ...scope.request,
        });
        if (resolution.decision === 'deny') {
          return refuse(
            permissionDenialMessage(
              resolution.denialSource,
              resolution.reviewerReason ?? resolution.systemOneNote ?? resolution.feedback,
            ),
          );
        }
        if (resolution.authentication === 'sudo') {
          if (!ctx.hostAuthentication) {
            return refuse(
              'sudo authentication is unavailable in this session; use an owner-local interactive foreground session.',
            );
          }
          if (!ctx.hostAuthentication.consumeSudoAuthentication(requestId)) {
            return refuse(
              'sudo authentication was not completed by the owner-local TUI; the command was not executed.',
            );
          }
          // setuid does not work inside the sandbox, and the user approved this command by name.
          sandboxed = false;
        }
      }

      const timeoutMs = args.timeout_ms ?? 120_000;
      const startedAt = Date.now();
      let result = await executor.exec(
        sandboxed && ctx.osSandbox ? ctx.osSandbox.wrap(command) : command,
        { timeoutMs, signal: abortSignal },
      );
      const note = sandboxed && ctx.osSandbox ? sandboxBlockNote(result, ctx.osSandbox.spec) : null;
      let retry: Extract<BashResult, { exit_code: number }>['sandbox_retry'];
      if (note && !result.timedOut && !abortSignal?.aborted) {
        const reason = await sandboxRetryReason(ctx, command, executor.cwd(), result, toolCallId);
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (reason && remainingMs > 0 && !abortSignal?.aborted) {
          retry = {
            reason,
            initial_exit_code: result.exitCode,
            initial_stdout: result.stdout,
            initial_stderr: result.stderr,
          };
          result = await executor.exec(command, { timeoutMs: remainingMs, signal: abortSignal });
        }
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        ...(retry ? { sandbox_retry: retry } : note ? { sandbox: note } : {}),
      };
    },
    formatScrollback: (args, result) => {
      const head = clip(stripCdPrefix(args.command), 60);
      if (!result) return { summary: head };
      if ('shell_id' in result) return { summary: `${head} (background: ${result.shell_id})` };
      if (result.timed_out) return { summary: `${head} (timed out)` };
      return {
        summary: `${head} (exit ${result.exit_code})${result.sandbox_retry ? ' (host retry)' : ''}`,
      };
    },
  });
}

/**
 * Where a host command runs: in the OS sandbox, or outside it at the
 * model's request. `request` is what the permission gate needs to know.
 */
function hostScope(
  ctx: ToolContext,
  args: BashArgs,
  target: 'sandbox' | 'host',
): { refusal: string } | { sandboxed: boolean; request: { osSandbox?: true; unsandboxed?: true } } {
  if (target !== 'host') return { sandboxed: false, request: {} };
  if (ctx.hostCommandsRefused) return { refusal: ctx.hostCommandsRefused };
  // The Docker sandbox has its own rules for host commands.
  if (!ctx.osSandbox || ctx.sandboxMode !== 'off') return { sandboxed: false, request: {} };
  if (!args.unsandboxed) return { sandboxed: true, request: { osSandbox: true } };
  if (!args.reason) {
    return {
      refusal:
        "refused by chimera: unsandboxed requires a 'reason' that says why the command must run outside the OS sandbox.",
    };
  }
  if (!ctx.permissionGate) {
    return {
      refusal: 'refused by chimera: nobody can approve an unsandboxed command in this session.',
    };
  }
  return { sandboxed: false, request: { unsandboxed: true } };
}

async function sandboxRetryReason(
  ctx: ToolContext,
  command: string,
  cwd: string,
  result: { exitCode: number; stderr: string },
  toolCallId?: string,
): Promise<string | null> {
  if (!ctx.osSandbox || !ctx.permissionGate || !sandboxBlockNote(result, ctx.osSandbox.spec)) {
    return null;
  }
  const reason =
    'Automatic host retry after an OS sandbox failure under a saved bypass permission.';
  const resolution = await ctx.permissionGate.requestRememberedBypass({
    requestId: newRequestId(),
    tool: 'bash',
    target: 'host',
    command,
    cwd,
    unsandboxed: true,
    reason,
    ...(toolCallId ? { toolCallId } : {}),
  });
  return resolution?.decision === 'allow' ? reason : null;
}

async function launchBackground(
  ctx: ToolContext,
  args: BashArgs,
  toolCallId?: string,
  abortSignal?: AbortSignal,
): Promise<BashResult> {
  const refuse = (stderr: string): BashResult => ({
    stdout: '',
    stderr,
    exit_code: -1,
    timed_out: false,
  });
  if (args.target === 'sandbox') {
    return refuse('refused by chimera: background commands only run on the host.');
  }
  if (ctx.commandRequiresSudo && (await ctx.commandRequiresSudo(args.command))) {
    return refuse('refused by chimera: sudo commands must run in the foreground.');
  }
  const manager = ctx.backgroundProcesses;
  if (!manager) {
    return refuse('refused by chimera: background execution is not available in this session.');
  }
  const scope = hostScope(ctx, args, 'host');
  if ('refusal' in scope) return refuse(scope.refusal);
  if (ctx.permissionGate) {
    const resolution = await ctx.permissionGate.request({
      requestId: newRequestId(),
      tool: 'bash',
      target: 'host',
      command: args.command,
      cwd: (ctx.bashHostExecutor ?? ctx.hostExecutor).cwd(),
      ...(args.reason ? { reason: args.reason } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...scope.request,
    });
    if (resolution.decision === 'deny') {
      return refuse(
        permissionDenialMessage(
          resolution.denialSource,
          resolution.reviewerReason ?? resolution.systemOneNote ?? resolution.feedback,
        ),
      );
    }
  }
  const launched = manager.launch(
    args.command,
    scope.sandboxed && ctx.osSandbox
      ? {
          shellCommand: ctx.osSandbox.wrap(args.command),
          retryOnFailure: async (result) => {
            if (abortSignal?.aborted) return null;
            const reason = await sandboxRetryReason(
              ctx,
              args.command,
              (ctx.bashHostExecutor ?? ctx.hostExecutor).cwd(),
              result,
              toolCallId,
            );
            return reason && !abortSignal?.aborted ? { shellCommand: args.command, reason } : null;
          },
        }
      : {},
  );
  return {
    shell_id: launched.id,
    message: `Started background process ${launched.id}. Poll with bash_output; stop with bash_kill.`,
  };
}
