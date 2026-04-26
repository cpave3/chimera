import { newRequestId } from '@chimera/core';
import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { clip, stripCdPrefix } from './format';

const DESTRUCTIVE_PATTERNS: { match: RegExp; label: string }[] = [
  { match: /^\s*rm\s+(-[rRf]+\s+)*\/\s*(\*)?\s*(;.*)?$/, label: 'rm -rf /' },
  { match: /^\s*rm\s+(-[rRf]+\s+)*\/\*\s*(;.*)?$/, label: 'rm -rf /*' },
  { match: /:\(\)\s*\{\s*:\s*\|:&\s*\}\s*;\s*:/, label: 'fork bomb' },
  { match: /(^|[;&|])\s*(>|>>|tee)\s+\/etc\//, label: 'write to /etc' },
  { match: /(^|[;&|])\s*sh\s+(-c\s+)?['"]?.*>\s*\/etc\//, label: 'write to /etc' },
];

function checkDestructive(cmd: string): string | null {
  for (const { match, label } of DESTRUCTIVE_PATTERNS) {
    if (match.test(cmd)) return label;
  }
  return null;
}

const BASH_SCHEMA = z.object({
  command: z.string().describe('The shell command to run.'),
  timeout_ms: z.number().int().positive().optional().describe('Timeout in ms. Default 120000.'),
  target: z.enum(['sandbox', 'host']).optional().describe(
    "Which executor to use. Defaults to 'host' when sandbox is off.",
  ),
  reason: z.string().optional().describe(
    "Short justification for running on the host (required when sandbox is on and target='host').",
  ),
});
type BashArgs = z.infer<typeof BASH_SCHEMA>;
type BashResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
};

export function buildBashTool(ctx: ToolContext) {
  return defineTool<BashArgs, BashResult>({
    description:
      'Execute a shell command and return its stdout, stderr, exit code, and whether it timed out. ' +
      'Use for builds, tests, git, inspecting the environment. ' +
      "In sandbox mode, set target='host' (with a 'reason') to run on the host instead of the sandbox.",
    inputSchema: BASH_SCHEMA,
    execute: async (args, { abortSignal }) => {
      const command = args.command;
      const destructive = checkDestructive(command);
      if (destructive) {
        return {
          stdout: '',
          stderr: `refused by chimera: matches destructive pattern '${destructive}'`,
          exit_code: -1,
          timed_out: false,
        };
      }

      const target: 'sandbox' | 'host' =
        args.target ?? (ctx.sandboxMode === 'off' ? 'host' : 'sandbox');

      const executor = target === 'host' ? ctx.hostExecutor : ctx.sandboxExecutor;

      if (ctx.sandboxMode !== 'off' && target === 'host') {
        if (!args.reason) {
          return {
            stdout: '',
            stderr: "refused by chimera: target='host' requires a 'reason'.",
            exit_code: -1,
            timed_out: false,
          };
        }
        if (ctx.permissionGate) {
          const resolution = await ctx.permissionGate.request({
            requestId: newRequestId(),
            tool: 'bash',
            target: 'host',
            command,
            cwd: executor.cwd(),
            reason: args.reason,
          });
          if (resolution.decision === 'deny') {
            return {
              stdout: '',
              stderr: 'denied by user',
              exit_code: -1,
              timed_out: false,
            };
          }
        }
      }

      const result = await executor.exec(command, {
        timeoutMs: args.timeout_ms,
        signal: abortSignal,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
      };
    },
    formatScrollback: (args, result) => {
      const head = clip(stripCdPrefix(args.command), 60);
      if (!result) return { summary: head };
      if (result.timed_out) return { summary: `${head} (timed out)` };
      return { summary: `${head} (exit ${result.exit_code})` };
    },
  });
}
