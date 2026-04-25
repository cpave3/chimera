import type { Tool as AiTool } from 'ai';

/**
 * One-line summary (and optional follow-on detail) shown in the TUI scrollback
 * for a tool call. Computed by a tool's `formatScrollback` hook and emitted
 * inside `tool_call_start` and `tool_call_result` events.
 */
export type ToolDisplay = {
  summary: string;
  detail?: string;
};

/**
 * Optional hook on a tool definition. Invoked twice: once at call start with
 * `args` only, then again on completion with `(args, result)` so the display
 * can grow to reflect the outcome (e.g. "edit foo.ts (3 replacements)").
 *
 * Errors thrown from the hook are caught by the agent — the call still
 * dispatches and the scrollback falls back to the generic JSON renderer.
 */
export type FormatScrollback<I, O> = (args: I, result?: O) => ToolDisplay;

/**
 * The Chimera-level tool definition produced by `defineTool`. `tool` is the
 * vanilla AI SDK tool consumed by `streamText`; `formatScrollback` is an
 * optional cosmetic enhancement.
 */
export interface ChimeraToolDef<I = unknown, O = unknown> {
  tool: AiTool;
  formatScrollback?: FormatScrollback<I, O>;
}
