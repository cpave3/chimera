import type { ToolSet } from 'ai';
import { buildBashTool } from './bash';
import type { ToolContext } from './context';
import { buildEditTool } from './edit';
import { buildReadTool } from './read';
import type { ChimeraToolDef, FormatScrollback } from './types';
import { buildWriteTool } from './write';

export interface BuildToolsResult {
  tools: ToolSet;
  formatters: Record<string, FormatScrollback<any, any>>;
}

export function buildTools(ctx: ToolContext): BuildToolsResult {
  const defs: Record<string, ChimeraToolDef<any, any>> = {
    bash: buildBashTool(ctx),
    read: buildReadTool(ctx),
    write: buildWriteTool(ctx),
    edit: buildEditTool(ctx),
  };
  return splitDefs(defs);
}

/**
 * Split a Chimera tool-def map into the AI SDK `ToolSet` consumed by
 * `streamText` and the parallel `formatters` map keyed by tool name.
 * Exported so the CLI factory can fold in dynamically-added tools
 * (e.g. `spawn_agent`) before handing both halves to the agent.
 */
export function splitDefs(
  defs: Record<string, ChimeraToolDef<any, any>>,
): BuildToolsResult {
  const tools: ToolSet = {};
  const formatters: Record<string, FormatScrollback<any, any>> = {};
  for (const [name, def] of Object.entries(defs)) {
    tools[name] = def.tool;
    if (def.formatScrollback) formatters[name] = def.formatScrollback;
  }
  return { tools, formatters };
}
