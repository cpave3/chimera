import { type BackgroundAgentState, formatBackgroundAgentMessage } from '@chimera/core';
import { defineTool } from '@chimera/tools';
import { z } from 'zod';
import type { DriveResult } from './subagent-driver';

export interface BackgroundAgent {
  id: string;
  purpose: string;
  /** The agent definition used, when there was one. */
  agent?: string;
  state: 'running' | BackgroundAgentState;
  startedAt: number;
  endedAt?: number;
  /** The child's final answer, or what went wrong. */
  result?: string;
}

export interface BackgroundAgentsOptions {
  /** Gives the parent session the message of a child that ended on its own. */
  deliver: (message: string) => Promise<unknown> | unknown;
  now?: () => number;
}

interface Tracked {
  record: BackgroundAgent;
  controller: AbortController;
  ended: Promise<void>;
}

/**
 * The background subagents of one session. A child here is not tied to the
 * run that started it: it goes on when that run ends, and stops only when it
 * is done, when the model stops it, or when the session ends.
 */
export class BackgroundAgents {
  private readonly tracked = new Map<string, Tracked>();
  private readonly deliver: BackgroundAgentsOptions['deliver'];
  private readonly now: () => number;

  constructor(options: BackgroundAgentsOptions) {
    this.deliver = options.deliver;
    this.now = options.now ?? Date.now;
  }

  /**
   * Track a child that has started. `run` drives it to its end and must
   * stop it when the signal fires.
   */
  start(
    info: { id: string; purpose: string; agent?: string },
    run: (signal: AbortSignal) => Promise<DriveResult>,
  ): void {
    const controller = new AbortController();
    const record: BackgroundAgent = { ...info, state: 'running', startedAt: this.now() };
    if (record.agent === undefined) delete record.agent;
    const ended = run(controller.signal)
      .catch(
        (error): DriveResult => ({
          finalText: '',
          reason: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
          steps: 0,
          toolCallsCount: 0,
        }),
      )
      .then(async (driven) => {
        record.endedAt = this.now();
        // A child that was told to stop ends as `interrupted`; nobody waits for its answer.
        if (controller.signal.aborted) {
          record.state = 'stopped';
          return;
        }
        record.state = driven.reason === 'stop' ? 'done' : 'failed';
        record.result =
          driven.finalText || driven.errorMessage || `the agent ended with ${driven.reason}`;
        await this.deliver(
          formatBackgroundAgentMessage({
            id: record.id,
            purpose: record.purpose,
            state: record.state,
            answer: record.result,
          }),
        );
      })
      .catch(() => {
        // A delivery that fails must not take the session down; the answer stays in `agent_status`.
      });
    this.tracked.set(info.id, { record, controller, ended });
  }

  list(): BackgroundAgent[] {
    return [...this.tracked.values()].map((tracked) => ({ ...tracked.record }));
  }

  get(id: string): BackgroundAgent | undefined {
    const tracked = this.tracked.get(id);
    return tracked ? { ...tracked.record } : undefined;
  }

  /** How long a child has run, or ran, in whole seconds. */
  secondsOf(agent: BackgroundAgent): number {
    return Math.round(((agent.endedAt ?? this.now()) - agent.startedAt) / 1000);
  }

  runningCount(): number {
    return this.list().filter((agent) => agent.state === 'running').length;
  }

  /** Stop one child and wait for it to end. False when there is no such child. */
  async stop(id: string): Promise<boolean> {
    const tracked = this.tracked.get(id);
    if (!tracked) return false;
    if (tracked.record.state === 'running') tracked.controller.abort();
    await tracked.ended;
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.tracked.keys()].map((id) => this.stop(id)));
  }
}

const STATUS_ARGS = z.object({
  id: z
    .string()
    .optional()
    .describe("One background agent. With an id, the result also has that agent's final answer."),
});
const STOP_ARGS = z.object({ id: z.string().describe('The background agent to stop.') });

interface StatusRow {
  id: string;
  purpose: string;
  state: BackgroundAgent['state'];
  /** How long the agent has run, or ran. */
  seconds: number;
  result?: string;
}

/** `agent_status` and `agent_stop`: how the model looks after the children it started in the background. */
export function buildBackgroundAgentTools(agents: BackgroundAgents) {
  const row = (agent: BackgroundAgent): StatusRow => ({
    id: agent.id,
    purpose: agent.purpose,
    state: agent.state,
    seconds: agents.secondsOf(agent),
  });

  const agent_status = defineTool<
    z.infer<typeof STATUS_ARGS>,
    { agents: StatusRow[]; error?: string }
  >({
    description:
      'List the agents this session started in the background: id, purpose, state (running, done, failed, stopped) and running time. Pass an id to also get the final answer of that agent. A background agent sends its answer as a message when it ends, so call this only to check on one that is still running.',
    inputSchema: STATUS_ARGS,
    formatScrollback: (args, result) => {
      if (!result) return { summary: args.id ?? 'all' };
      const running = result.agents.filter((agent) => agent.state === 'running').length;
      return { summary: `${result.agents.length} agents, ${running} running` };
    },
    execute: async (args) => {
      const { id } = STATUS_ARGS.parse(args);
      if (id === undefined) return { agents: agents.list().map(row) };
      const agent = agents.get(id);
      if (!agent) return { agents: [], error: `no background agent with id "${id}"` };
      return {
        agents: [
          { ...row(agent), ...(agent.result === undefined ? {} : { result: agent.result }) },
        ],
      };
    },
  });

  const agent_stop = defineTool<
    z.infer<typeof STOP_ARGS>,
    { id: string; state?: BackgroundAgent['state']; note?: string; error?: string }
  >({
    description:
      'Stop one agent that this session started in the background. Its work so far is lost and it sends no answer.',
    inputSchema: STOP_ARGS,
    formatScrollback: (args, result) => ({
      summary: result?.state ? `${args.id} (${result.state})` : args.id,
    }),
    execute: async (args) => {
      const { id } = STOP_ARGS.parse(args);
      const before = agents.get(id);
      if (!before) return { id, error: `no background agent with id "${id}"` };
      await agents.stop(id);
      const state = agents.get(id)?.state;
      return before.state === 'running'
        ? { id, state }
        : { id, state, note: 'the agent had already ended' };
    },
  });

  return { agent_status, agent_stop };
}
