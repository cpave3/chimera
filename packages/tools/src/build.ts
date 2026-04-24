import type { ToolSet } from 'ai';
import { buildBashTool } from './bash';
import type { ToolContext } from './context';
import { buildEditTool } from './edit';
import { buildReadTool } from './read';
import { buildWriteTool } from './write';

export function buildTools(ctx: ToolContext): ToolSet {
  return {
    bash: buildBashTool(ctx),
    read: buildReadTool(ctx),
    write: buildWriteTool(ctx),
    edit: buildEditTool(ctx),
  };
}
