import type { ToolSet } from 'ai';
import { buildBashKillTool, buildBashOutputTool } from './background-tools';
import { buildBashTool } from './bash';
import { buildCodexToolDefs } from './codex-adapter';
import type { ToolContext } from './context';
import { buildEditTool } from './edit';
import { buildGlobTool } from './glob';
import { buildGrepTool } from './grep';
import { buildReadTool } from './read';
import { buildRecallTool } from './recall';
import { buildTaskListTool } from './task-list';
import type { ChimeraToolDef, FormatScrollback } from './types';
import { buildFetchTool } from './web';
import { buildWebSearchTool } from './web-search';
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
    glob: buildGlobTool(ctx),
    grep: buildGrepTool(ctx),
    fetch: buildFetchTool(ctx),
  };
  if (ctx.webSearch) {
    defs.web_search = buildWebSearchTool(ctx);
  }
  if (ctx.taskList) {
    defs.task_list = buildTaskListTool(ctx);
  }
  if (ctx.recall) {
    defs.recall = buildRecallTool(ctx);
  }
  if (ctx.backgroundProcesses) {
    defs.bash_output = buildBashOutputTool(ctx);
    defs.bash_kill = buildBashKillTool(ctx);
  }
  if (ctx.toolCallShape === 'codex') {
    return splitDefs(buildCodexToolDefs(defs));
  }
  return splitDefs(defs);
}

/**
 * Split a Chimera tool-def map into the AI SDK `ToolSet` consumed by
 * `streamText` and the parallel `formatters` map keyed by tool name.
 * Exported so the CLI factory can fold in dynamically-added tools
 * (e.g. `spawn_agent`) before handing both halves to the agent.
 */
export function splitDefs(defs: Record<string, ChimeraToolDef<any, any>>): BuildToolsResult {
  const tools: ToolSet = {};
  const formatters: Record<string, FormatScrollback<any, any>> = {};
  for (const [name, def] of Object.entries(defs)) {
    tools[name] = def.tool;
    if (def.formatScrollback) formatters[name] = def.formatScrollback;
  }
  return { tools, formatters };
}
