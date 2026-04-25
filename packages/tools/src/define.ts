import { tool } from 'ai';
import type { ChimeraToolDef, FormatScrollback } from './types';

export interface DefineToolOptions<I, O> {
  description: string;
  // Whatever Zod schema (or other AI SDK FlexibleSchema) the caller wants to
  // hand to `tool()`. We don't constrain it here — the I/O generics on
  // `defineTool` are what the formatter and execute see.
  inputSchema: unknown;
  execute: (args: I, opts: { abortSignal?: AbortSignal }) => Promise<O>;
  formatScrollback?: FormatScrollback<I, O>;
}

/**
 * Wraps the AI SDK `tool()` call and bundles an optional scrollback formatter.
 * This is the public API for both built-in tools and (future) plugin tools:
 * authoring a tool with a formatter is the same shape as authoring one
 * without — the field is simply optional.
 */
export function defineTool<I, O>(
  opts: DefineToolOptions<I, O>,
): ChimeraToolDef<I, O> {
  const aiSdkTool = (tool as unknown as (cfg: unknown) => unknown)({
    description: opts.description,
    inputSchema: opts.inputSchema,
    execute: opts.execute,
  });
  return {
    tool: aiSdkTool as ChimeraToolDef<I, O>['tool'],
    formatScrollback: opts.formatScrollback,
  };
}
