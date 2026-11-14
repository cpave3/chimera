import { type McpPermissionGate, newRequestId, type ToolDisplay } from '@chimera/core';
import { jsonSchema, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { McpServerConfig } from '../config';
import { McpClientManager, type McpTool } from './client';

/** The share of the context window MCP tool schemas may take before they are held back. */
export const MCP_DEFERRAL_SHARE = 0.1;
// The estimate used across Chimera: four characters a token.
const CHARACTERS_PER_TOKEN = 4;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const NAME_WORD_WEIGHT = 4;
const NAME_PART_WEIGHT = 2;
const SERVER_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;

type Formatter = (args: unknown, result?: unknown) => ToolDisplay;

/** One MCP tool, ready to register. */
export interface McpToolEntry {
  /** The name the model calls. */
  id: string;
  server: string;
  /** The tool's own name on its server. */
  name: string;
  description: string;
  /** Estimated tokens the tool's name, description and input schema cost in each request. */
  tokens: number;
  tool: ToolSet[string];
  formatter: Formatter;
}

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

interface DescribeOptions {
  manager: McpClientManager;
  servers: Record<string, McpServerConfig>;
  /** Names that are taken already; an MCP tool with such a name is skipped. */
  taken: (id: string) => boolean;
  gate: McpPermissionGate;
  cwd: string;
  warn: (message: string) => void;
}

/** Ask every server for its tools and build a callable tool for each. */
async function describeMcpTools(options: DescribeOptions): Promise<McpToolEntry[]> {
  const { manager, servers, taken, gate, cwd, warn } = options;
  const entries: McpToolEntry[] = [];
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
      if (taken(id) || entries.some((entry) => entry.id === id)) {
        warn(`MCP tool ${server}/${definition.name} conflicts with registered tool ${id}`);
        continue;
      }
      const description = `[MCP ${server}] ${definition.description ?? definition.name}`;
      entries.push({
        id,
        server,
        name: definition.name,
        description: definition.description ?? definition.name,
        tokens: Math.ceil(
          JSON.stringify({ name: id, description, input_schema: definition.inputSchema }).length /
            CHARACTERS_PER_TOKEN,
        ),
        formatter: (args, result) => {
          const fields =
            args && typeof args === 'object' && !Array.isArray(args)
              ? Object.keys(args).slice(0, 5).join(', ')
              : '';
          const failed = result && typeof result === 'object' && 'error' in result;
          return {
            label: `${server} / ${definition.name}`,
            summary: `${fields || 'no arguments'}${failed ? ' (failed)' : ''}`,
          };
        },
        tool: tool({
          description,
          inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema),
          execute: async (args, { abortSignal, toolCallId }) => {
            const resolution = await gate.requestMcp(
              { requestId: newRequestId(), server, tool: definition.name, args, cwd, toolCallId },
              config.trustedTools ?? [],
            );
            if (resolution.decision === 'deny') {
              const byReviewer =
                resolution.denialSource === 'reviewer'
                  ? ` by reviewer: ${resolution.reviewerReason ?? 'the request needs the user'}`
                  : resolution.denialSource === 'mod'
                    ? ` by mod${resolution.feedback ? `: ${resolution.feedback}` : ''}`
                    : '';
              return { error: `MCP call ${server}/${definition.name} denied${byReviewer}` };
            }
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
        }),
      });
    }
  }
  return entries;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * How well a tool answers a query. A query word that is a whole word of the
 * tool's name counts most, then one that is part of the name, then the
 * server's name, then the description.
 */
function score(entry: McpToolEntry, query: string[]): number {
  const nameWords = new Set(words(entry.name));
  const name = entry.name.toLowerCase();
  const serverWords = new Set(words(entry.server));
  const descriptionWords = new Set(words(entry.description));
  let total = 0;
  for (const word of query) {
    if (nameWords.has(word)) total += NAME_WORD_WEIGHT;
    // One letter or digit is part of almost every name.
    else if (word.length > 1 && name.includes(word)) total += NAME_PART_WEIGHT;
    if (serverWords.has(word)) total += SERVER_WEIGHT;
    if (descriptionWords.has(word)) total += DESCRIPTION_WEIGHT;
  }
  return total;
}

function serverOverview(entries: McpToolEntry[]): Array<{ server: string; tools: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.server, (counts.get(entry.server) ?? 0) + 1);
  return [...counts].map(([server, tools]) => ({ server, tools }));
}

const SEARCH_ARGS = z.object({
  query: z
    .string()
    .describe(
      'A few words for what you need, for example "create issue". Empty lists the servers.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(`How many tools to return. Default ${DEFAULT_SEARCH_LIMIT}.`),
});

interface SearchResult {
  tools: Array<{ name: string; server: string; description: string }>;
  /** Names registered by this call. */
  registered: string[];
  servers?: Array<{ server: string; tools: number }>;
  note: string;
}

/**
 * `tool_search`: the door to MCP tools that were held back. A tool it
 * returns is registered for the rest of the session, so its schema enters
 * the context only when the task needs it.
 */
function buildToolSearch(
  entries: McpToolEntry[],
  activate: (entries: McpToolEntry[]) => void,
): { tool: ToolSet[string]; formatter: Formatter } {
  const registered = new Set<string>();
  const overview = serverOverview(entries);
  const serverList = overview
    .map(({ server, tools }) => `${server} (${tools} ${tools === 1 ? 'tool' : 'tools'})`)
    .join(', ');
  return {
    formatter: (args, result) => {
      const query = (args as { query?: string } | undefined)?.query || 'servers';
      const found = (result as SearchResult | undefined)?.tools.length;
      return { summary: found === undefined ? query : `${query} (${found} found)` };
    },
    tool: tool({
      description: `Find and enable tools of the connected MCP servers. Their tools are not registered until you search for them, which keeps the context small. Servers: ${serverList}. Search with a few words for what you need; the tools returned are registered, and you can call them from your next step.`,
      inputSchema: SEARCH_ARGS,
      execute: async (args): Promise<SearchResult> => {
        const { query, limit } = SEARCH_ARGS.parse(args);
        const queryWords = words(query);
        if (queryWords.length === 0) {
          return {
            tools: [],
            registered: [],
            servers: overview,
            note: 'These servers have tools. Search with a few words for what you need.',
          };
        }
        const matches = entries
          .map((entry) => ({ entry, score: score(entry, queryWords) }))
          .filter((match) => match.score > 0)
          .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
          .slice(0, limit ?? DEFAULT_SEARCH_LIMIT)
          .map((match) => match.entry);
        if (matches.length === 0) {
          return {
            tools: [],
            registered: [],
            servers: overview,
            note: 'No tool matched. Try other words, or an empty query to see the servers.',
          };
        }
        const fresh = matches.filter((entry) => !registered.has(entry.id));
        for (const entry of fresh) registered.add(entry.id);
        if (fresh.length > 0) activate(fresh);
        return {
          tools: matches.map((entry) => ({
            name: entry.id,
            server: entry.server,
            description: entry.description,
          })),
          registered: fresh.map((entry) => entry.id),
          note: 'These tools are registered. Call them by name from your next step.',
        };
      },
    }),
  };
}

export interface RegisterMcpToolsOptions {
  manager: McpClientManager;
  servers: Record<string, McpServerConfig>;
  tools: ToolSet;
  formatters: Record<string, Formatter>;
  gate: McpPermissionGate;
  cwd: string;
  warn: (message: string) => void;
  /**
   * The session model's context window. With it, tool schemas that would
   * take more than a tenth of the window are held back behind `tool_search`.
   */
  contextWindow?: number;
  /** Registers held-back tools on the live session when `tool_search` returns them. */
  activate?: (entries: McpToolEntry[]) => void;
}

/**
 * Put the MCP servers' tools into the session's tool set: all of them when
 * their schemas are a small share of the context window, or `tool_search`
 * alone when they are not.
 */
export async function registerMcpTools(
  options: RegisterMcpToolsOptions,
): Promise<{ deferred: boolean }> {
  const { tools, formatters, contextWindow, activate } = options;
  const entries = await describeMcpTools({
    ...options,
    taken: (id) => Object.hasOwn(tools, id),
  });
  const schemaTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const deferred =
    contextWindow !== undefined &&
    activate !== undefined &&
    schemaTokens > contextWindow * MCP_DEFERRAL_SHARE;
  if (!deferred) {
    for (const entry of entries) {
      tools[entry.id] = entry.tool;
      formatters[entry.id] = entry.formatter;
    }
    return { deferred: false };
  }
  const search = buildToolSearch(entries, activate);
  tools.tool_search = search.tool;
  formatters.tool_search = search.formatter;
  return { deferred: true };
}
