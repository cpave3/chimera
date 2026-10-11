import type { McpPermissionCall, McpPermissionGate, PermissionResolution } from '@chimera/core';
import type { ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
import type { McpClientManager } from '../src/mcp/client';
import { registerMcpTools } from '../src/mcp/tools';

type Callable = { execute: (args: object, options: object) => Promise<unknown> };

async function trackerTool(resolution: PermissionResolution) {
  const asked: McpPermissionCall[] = [];
  const gate = {
    requestMcp: async (call: McpPermissionCall) => {
      asked.push(call);
      return resolution;
    },
  } as unknown as McpPermissionGate;
  const manager = {
    discover: async () => [
      {
        name: 'create_issue',
        description: 'Create an issue.',
        inputSchema: { type: 'object' as const, properties: { title: { type: 'string' } } },
      },
    ],
    call: async () => ({ content: [{ type: 'text', text: 'created' }] }),
  } as unknown as McpClientManager;
  const tools: ToolSet = {};
  await registerMcpTools({
    manager,
    servers: { tracker: { transport: 'stdio', command: 'tracker' } },
    tools,
    formatters: {},
    gate,
    cwd: '/tmp',
    warn: () => {},
  });
  return { tool: Object.values(tools)[0] as unknown as Callable, asked };
}

describe('an MCP tool and the approval reviewer', () => {
  it('tells the gate which tool call asks', async () => {
    const { tool, asked } = await trackerTool({ decision: 'allow', remembered: false });

    await tool.execute({ title: 'Docs site is down' }, { toolCallId: 'call-4', messages: [] });

    expect(asked[0]).toMatchObject({
      server: 'tracker',
      tool: 'create_issue',
      toolCallId: 'call-4',
    });
  });

  it('gives the model the reason when the reviewer escalated and nobody could be asked', async () => {
    const { tool } = await trackerTool({
      decision: 'deny',
      remembered: false,
      denialSource: 'reviewer',
      reviewerReason: 'the user did not ask for an issue',
    });

    const result = await tool.execute({ title: 'x' }, { toolCallId: 'call-5', messages: [] });

    expect(result).toEqual({
      error: 'MCP call tracker/create_issue denied by reviewer: the user did not ask for an issue',
    });
  });

  it('keeps the plain denial text for a denial from another source', async () => {
    const { tool } = await trackerTool({
      decision: 'deny',
      remembered: false,
      denialSource: 'user',
    });

    expect(await tool.execute({ title: 'x' }, { toolCallId: 'c', messages: [] })).toEqual({
      error: 'MCP call tracker/create_issue denied',
    });
  });
});
