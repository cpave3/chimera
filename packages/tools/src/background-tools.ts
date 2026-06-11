import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { clip } from './format';

const OUTPUT_SCHEMA = z.object({
  shell_id: z.string().describe('Id returned by bash with run_in_background.'),
});
type OutputArgs = z.infer<typeof OUTPUT_SCHEMA>;
type OutputResult =
  | {
      stdout: string;
      stderr: string;
      status: 'running' | 'exited' | 'killed';
      exit_code: number | null;
      truncated: boolean;
    }
  | { error: string };

export function buildBashOutputTool(ctx: ToolContext) {
  return defineTool<OutputArgs, OutputResult>({
    description:
      'Read output from a background process started by bash with run_in_background. ' +
      'Returns only output produced since the previous read, plus the process status ' +
      'and exit code once it has finished.',
    inputSchema: OUTPUT_SCHEMA,
    execute: async (args) => {
      const read = ctx.backgroundProcesses?.readOutput(args.shell_id);
      if (!read) {
        return { error: `no background process with id '${args.shell_id}'` };
      }
      return {
        stdout: read.stdout,
        stderr: read.stderr,
        status: read.status,
        exit_code: read.exitCode,
        truncated: read.truncated,
      };
    },
    formatScrollback: (args, result) => {
      if (!result) return { summary: args.shell_id };
      if ('error' in result) return { summary: `${args.shell_id} (unknown id)` };
      const bytes = result.stdout.length + result.stderr.length;
      const state =
        result.status === 'running' ? 'running' : `${result.status}, exit ${result.exit_code}`;
      return { summary: `${args.shell_id} (${state}, ${bytes} new bytes)` };
    },
  });
}

const KILL_SCHEMA = z.object({
  shell_id: z.string().describe('Id returned by bash with run_in_background.'),
});
type KillArgs = z.infer<typeof KILL_SCHEMA>;
type KillResult = { killed: boolean; message: string };

export function buildBashKillTool(ctx: ToolContext) {
  return defineTool<KillArgs, KillResult>({
    description:
      'Terminate a background process started by bash with run_in_background. ' +
      'Sends SIGTERM to the process group, escalating to SIGKILL after a grace period.',
    inputSchema: KILL_SCHEMA,
    execute: async (args) => {
      const manager = ctx.backgroundProcesses;
      if (!manager) {
        return { killed: false, message: 'background execution is not available' };
      }
      const record = manager.get(args.shell_id);
      if (!record) {
        return { killed: false, message: `no background process with id '${args.shell_id}'` };
      }
      if (!manager.kill(args.shell_id)) {
        return {
          killed: false,
          message: `${args.shell_id} already ${record.status} (${clip(record.command, 60)})`,
        };
      }
      return { killed: true, message: `sent SIGTERM to ${args.shell_id}` };
    },
    formatScrollback: (args, result) => {
      if (!result) return { summary: args.shell_id };
      return { summary: `${args.shell_id} (${result.killed ? 'killed' : result.message})` };
    },
  });
}
