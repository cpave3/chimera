import type { AgentEvent, ToolDisplay } from '@chimera/core';
import {
  createPlainStyle,
  goalLine,
  type RowContext,
  renderEntry,
  resolveTheme,
  type ScrollbackEntry,
  type Style,
} from '@chimera/tui';

/** Width of the rows when stderr is not a terminal: wide enough to keep facts on the row. */
const PIPED_WIDTH = 100;

interface StartedCall {
  name: string;
  args: unknown;
  display?: ToolDisplay;
  target: 'sandbox' | 'host';
}

export interface RunRowsOptions {
  write(text: string): void;
  /** Colour with the user's theme: stderr is a terminal. */
  color: boolean;
  width?: number;
  /** A Docker sandbox runs some calls: rows say where. */
  sandboxActive?: boolean;
  env?: NodeJS.ProcessEnv;
}

function shortArgs(args: unknown): string {
  const text = JSON.stringify(args) ?? '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * The stderr of `chimera run`: tool calls, their results and goal lines
 * as Ledger rows, the same rows the TUI's transcript draws. Each call is
 * printed once, when it ends, with its facts and collapsed output.
 */
export class RunRows {
  private readonly started = new Map<string, StartedCall>();
  private readonly style: Style;
  private readonly context: RowContext;
  private nextId = 0;

  constructor(private readonly options: RunRowsOptions) {
    const theme = resolveTheme({ env: options.env ?? process.env });
    this.style = options.color ? theme.style : createPlainStyle(theme.tokens);
    this.context = {
      width: options.width ?? PIPED_WIDTH,
      style: this.style,
      spinner: '○',
      sandboxActive: options.sandboxActive ?? false,
      isExpanded: () => false,
      children: new Map(),
    };
  }

  private print(entry: ScrollbackEntry): void {
    const lines = renderEntry(entry, this.context).filter(
      (line, index) => index > 0 || line !== '',
    );
    this.options.write(`${lines.join('\n')}\n`);
  }

  private id(): string {
    this.nextId += 1;
    return `run${this.nextId}`;
  }

  private printCall(
    callId: string,
    end: { result?: unknown; error?: string; durationMs?: number; display?: ToolDisplay },
  ): void {
    const call = this.started.get(callId);
    if (!call) return;
    this.started.delete(callId);
    const display = end.display ?? call.display;
    this.print({
      id: this.id(),
      kind: 'tool',
      toolName: call.name,
      ...(display?.label ? { displayName: display.label } : {}),
      text: display?.summary ?? `${call.name} ${shortArgs(call.args)}`,
      ...(display?.detail ? { detail: display.detail } : {}),
      toolTarget: call.target,
      toolArgs: call.args,
      ...(end.error === undefined ? { toolResult: end.result ?? null } : { toolError: end.error }),
      ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs }),
    });
  }

  apply(event: AgentEvent): void {
    if (event.type === 'tool_call_start') {
      this.started.set(event.callId, {
        name: event.name,
        args: event.args,
        display: event.display,
        target: event.target === 'sandbox' ? 'sandbox' : 'host',
      });
    } else if (event.type === 'tool_call_result') {
      this.printCall(event.callId, {
        result: event.result,
        durationMs: event.durationMs,
        display: event.display,
      });
    } else if (event.type === 'tool_call_error') {
      this.printCall(event.callId, { error: event.error });
    } else if (event.type === 'goal_updated') {
      const text = goalLine(event);
      const failed = event.change === 'unchecked' || event.change === 'impossible';
      this.print({ id: this.id(), kind: failed ? 'error' : 'info', text });
    } else if (event.type === 'user_input_required') {
      this.print({ id: this.id(), kind: 'info', text: `Waiting for input: ${event.request}` });
    }
  }

  /** Calls still running when the run ended, as running rows. */
  finish(): void {
    for (const [callId, call] of [...this.started]) {
      this.started.delete(callId);
      this.print({
        id: this.id(),
        kind: 'tool',
        toolName: call.name,
        text: call.display?.summary ?? `${call.name} ${shortArgs(call.args)}`,
        toolTarget: call.target,
        toolArgs: call.args,
      });
    }
  }
}
