import { type McpPermissionGate, newRequestId } from '@chimera/core';
import { jsonSchema, type ToolSet, tool } from 'ai';
import type { McpServerConfig } from '../config';
import { McpClientManager, type McpTool } from './client';

function toolId(server: string, name: string): string {
  const encoded = [...name]
    .map((character) =>
      /[a-zA-Z0-9]/.test(character)
        ? character
        : `_x${character.codePointAt(0)?.toString(16).padStart(6, '0')}_`,
    )
    .join('');
  return `mcp_${server}_${encoded}`;
}

export async function registerMcpTools(options: {
  manager: McpClientManager;
  servers: Record<string, McpServerConfig>;
  tools: ToolSet;
  gate: McpPermissionGate;
  cwd: string;
  warn: (message: string) => void;
}): Promise<void> {
  const { manager, servers, tools, gate, cwd, warn } = options;
  for (const [server, config] of Object.entries(servers)) {
    let discovered: McpTool[];
    try {
      discovered = await manager.discover(server);
    } catch (error) {
      warn(`MCP server ${server} unavailable: ${(error as Error).message}`);
      continue;
    }
    for (const definition of discovered) {
      const id = toolId(server, definition.name);
      if (Object.hasOwn(tools, id)) {
        warn(`MCP tool ${server}/${definition.name} conflicts with registered tool ${id}`);
        continue;
      }
      tools[id] = tool({
        description: `[MCP ${server}] ${definition.description ?? definition.name}`,
        inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema),
        execute: async (args, { abortSignal }) => {
          const resolution = await gate.requestMcp(
            { requestId: newRequestId(), server, tool: definition.name, args, cwd },
            config.trustedTools ?? [],
          );
          if (resolution.decision === 'deny')
            return { error: `MCP call ${server}/${definition.name} denied` };
          try {
            const result = await manager.call(server, definition.name, args, abortSignal);
            return result.isError
              ? {
                  error: `MCP tool ${server}/${definition.name} returned an error`,
                  content: result.content,
                }
              : { content: result.content, structuredContent: result.structuredContent };
          } catch (error) {
            return { error: (error as Error).message };
          }
        },
      });
    }
  }
}
