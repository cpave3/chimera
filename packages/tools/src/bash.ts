import { newRequestId } from '@chimera/core';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './context';

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

export function buildBashTool(ctx: ToolContext) {
  return tool({
    description:
      'Execute a shell command and return its stdout, stderr, exit code, and whether it timed out. ' +
      'Use for builds, tests, git, inspecting the environment. ' +
      "In sandbox mode, set target='host' (with a 'reason') to run on the host instead of the sandbox.",
    inputSchema: z.object({
      command: z.string().describe('The shell command to run.'),
      timeout_ms: z.number().int().positive().optional().describe('Timeout in ms. Default 120000.'),
      target: z.enum(['sandbox', 'host']).optional().describe(
        "Which executor to use. Defaults to 'host' when sandbox is off.",
      ),
      reason: z.string().optional().describe(
        "Short justification for running on the host (required when sandbox is on and target='host').",
      ),
    }),
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
          const res = await ctx.permissionGate.request({
            requestId: newRequestId(),
            tool: 'bash',
            target: 'host',
            command,
            cwd: executor.cwd(),
            reason: args.reason,
          });
          if (res.decision === 'deny') {
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
  });
}
