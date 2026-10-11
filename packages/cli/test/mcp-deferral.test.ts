import type { McpPermissionGate } from '@chimera/core';
import type { ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
import type { McpClientManager } from '../src/mcp/client';
import { type McpToolEntry, registerMcpTools } from '../src/mcp/tools';

const gate = {
  requestMcp: async () => ({ decision: 'allow' }),
} as unknown as McpPermissionGate;

/** Servers with tools whose descriptions have a known size. */
function manager(catalog: Record<string, Array<{ name: string; description: string }>>) {
  const called: string[] = [];
  const fake = {
    discover: async (server: string) =>
      (catalog[server] ?? []).map((entry) => ({
        ...entry,
        inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
      })),
    call: async (server: string, name: string) => {
      called.push(`${server}/${name}`);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as McpClientManager;
  return { fake, called };
}

const catalog = {
  tracker: [
    {
      name: 'create_issue',
      description: 'Create an issue in the tracker with a title and a body.',
    },
    { name: 'list_issues', description: 'List the issues of a project, newest first.' },
    { name: 'close_issue', description: 'Close an issue by its number.' },
  ],
  docs: [{ name: 'search_pages', description: 'Search the documentation pages for a phrase.' }],
};

async function register(contextWindow: number) {
  const { fake, called } = manager(catalog);
  const tools: ToolSet = {};
  const formatters = {};
  const activated: McpToolEntry[][] = [];
  const result = await registerMcpTools({
    manager: fake,
    servers: {
      tracker: { transport: 'stdio', command: 'tracker' },
      docs: { transport: 'stdio', command: 'docs' },
    },
    tools,
    formatters,
    gate,
    cwd: '/tmp',
    warn: () => {},
    contextWindow,
    activate: (entries) => {
      activated.push(entries);
      for (const entry of entries) tools[entry.id] = entry.tool;
    },
  });
  const search = (args: object) =>
    (
      tools.tool_search as unknown as { execute: (args: object, options: object) => Promise<any> }
    ).execute(args, {});
  return { tools, formatters, activated, called, result, search };
}

describe('MCP tools and the context window', () => {
  it('registers every tool when their schemas are a small share of the window', async () => {
    const { tools, result } = await register(200_000);

    expect(Object.keys(tools).sort()).toEqual([
      'mcp_docs_search_x00005f_pages',
      'mcp_tracker_close_x00005f_issue',
      'mcp_tracker_create_x00005f_issue',
      'mcp_tracker_list_x00005f_issues',
    ]);
    expect(result.deferred).toBe(false);
  });

  it('holds the tools back behind tool_search when they would take over 10% of the window', async () => {
    // Four schemas of about 60 tokens each against a 1,000-token window.
    const { tools, result } = await register(1_000);

    expect(Object.keys(tools)).toEqual(['tool_search']);
    expect(result.deferred).toBe(true);
    const description = (tools.tool_search as unknown as { description: string }).description;
    expect(description).toContain('tracker (3 tools)');
    expect(description).toContain('docs (1 tool)');
  });
});

describe('tool_search', () => {
  it('finds tools by what they do and registers them for the next step', async () => {
    const { tools, activated, called, search } = await register(1_000);

    const result = await search({ query: 'create issue' });

    expect(result.tools[0]).toMatchObject({
      name: 'mcp_tracker_create_x00005f_issue',
      server: 'tracker',
      description: 'Create an issue in the tracker with a title and a body.',
    });
    expect(result.registered).toContain('mcp_tracker_create_x00005f_issue');
    expect(activated).toHaveLength(1);
    const created = tools.mcp_tracker_create_x00005f_issue as unknown as {
      execute: (args: object, options: object) => Promise<unknown>;
    };
    expect(await created.execute({ text: 'x' }, {})).toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(called).toEqual(['tracker/create_issue']);
  });

  it('puts the best match first', async () => {
    const { search } = await register(1_000);

    const result = await search({ query: 'close issue' });

    expect(result.tools.map((tool: { name: string }) => tool.name)[0]).toBe(
      'mcp_tracker_close_x00005f_issue',
    );
  });

  it('registers nothing twice', async () => {
    const { activated, search } = await register(1_000);
    await search({ query: 'search pages' });

    const again = await search({ query: 'search pages' });

    expect(again.registered).toEqual([]);
    expect(again.tools).toHaveLength(1);
    expect(activated).toHaveLength(1);
  });

  it('says so when nothing matches, and names the servers', async () => {
    const { activated, search } = await register(1_000);

    const result = await search({ query: 'deploy kubernetes' });

    expect(result.tools).toEqual([]);
    expect(result.servers).toEqual([
      { server: 'tracker', tools: 3 },
      { server: 'docs', tools: 1 },
    ]);
    expect(activated).toEqual([]);
  });

  it('gives an overview for an empty query, and registers nothing', async () => {
    const { activated, search } = await register(1_000);

    const result = await search({ query: '' });

    expect(result.servers).toEqual([
      { server: 'tracker', tools: 3 },
      { server: 'docs', tools: 1 },
    ]);
    expect(activated).toEqual([]);
  });

  it('respects the limit', async () => {
    const { search } = await register(1_000);
    expect((await search({ query: 'issue', limit: 2 })).tools).toHaveLength(2);
  });
});
