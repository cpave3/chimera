import {
  type OAuthClientProvider,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type CallToolResult, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../version';
import { McpAuth } from './auth.js';

export type McpServerConfig =
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; clientId?: string };
export type McpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
export type McpCallResult = CallToolResult;
export type McpLimits = {
  connectMs?: number;
  discoveryMs?: number;
  callMs?: number;
  maxTools?: number;
  maxSchemaBytes?: number;
  maxResultBytes?: number;
};

const defaults = {
  connectMs: 10_000,
  discoveryMs: 10_000,
  callMs: 30_000,
  maxTools: 100,
  maxSchemaBytes: 32_000,
  maxResultBytes: 100_000,
};

export class McpClientManager {
  private readonly clients = new Map<string, Client>();
  private readonly tools = new Map<string, McpTool[]>();
  private readonly limits: Required<McpLimits>;

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly authProvider?: (name: string, url: string) => OAuthClientProvider,
    limits: McpLimits = {},
  ) {
    this.limits = { ...defaults, ...limits };
  }

  private async connect(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const config = this.servers[name];
    if (!config) throw new Error(`MCP server ${name} is not configured`);
    const transport: Transport =
      config.transport === 'stdio'
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: config.env
              ? {
                  ...(process.env as Record<string, string>),
                  ...Object.fromEntries(
                    Object.entries(config.env).map(([key, value]) => {
                      if (!value.startsWith('env:')) return [key, value];
                      const variable = value.slice(4);
                      const secret = process.env[variable];
                      if (secret === undefined)
                        throw new Error(
                          `MCP server ${name} needs environment variable ${variable}`,
                        );
                      return [key, secret];
                    }),
                  ),
                }
              : undefined,
            stderr: 'pipe',
            maxBufferSize: this.limits.maxResultBytes,
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            authProvider:
              this.authProvider?.(name, config.url) ??
              new McpAuth(name, config.url, { clientId: config.clientId }),
          });
    const client = new Client({ name: 'chimera', version: VERSION });
    try {
      await client.connect(transport, { timeout: this.limits.connectMs });
      this.clients.set(name, client);
      return client;
    } catch {
      await client.close();
      throw new Error(
        `MCP server ${name} could not connect${config.transport === 'http' ? `; run chimera mcp login ${name} if authorization is required` : ''}`,
      );
    }
  }

  async discover(name: string, signal?: AbortSignal): Promise<McpTool[]> {
    const cached = this.tools.get(name);
    if (cached) return cached;
    const client = await this.connect(name);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: this.limits.discoveryMs,
      });
      tools.push(...page.tools);
      if (tools.length > this.limits.maxTools)
        throw new Error(`MCP server ${name} has too many tools`);
      cursor = page.nextCursor;
    } while (cursor);
    for (const tool of tools) {
      if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > this.limits.maxSchemaBytes) {
        throw new Error(`MCP tool ${name}/${tool.name} has an oversized schema`);
      }
      if (tool.description && tool.description.length > 2000)
        tool.description = tool.description.slice(0, 2000);
    }
    this.tools.set(name, tools);
    return tools;
  }

  async call(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const tools = await this.discover(name, signal);
    if (!tools.some((tool) => tool.name === toolName))
      throw new Error(`Unknown MCP tool ${name}/${toolName}`);
    const client = await this.connect(name);
    try {
      // Parsed with the current schema, so the result always has `content`.
      const result = (await client.callTool(
        { name: toolName, arguments: args },
        CallToolResultSchema,
        { signal, timeout: this.limits.callMs },
      )) as CallToolResult;
      if (Buffer.byteLength(JSON.stringify(result)) > this.limits.maxResultBytes) {
        throw new Error(`MCP tool ${name}/${toolName} returned an oversized result`);
      }
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.includes('oversized result')) throw error;
      if (
        error instanceof UnauthorizedError ||
        (error instanceof StreamableHTTPError && error.code === 401) ||
        (error instanceof Error && error.message === 'Unauthorized')
      ) {
        throw new Error(
          `MCP tool ${name}/${toolName} needs authorization; run chimera mcp login ${name}`,
        );
      }
      throw new Error(
        `MCP tool ${name}/${toolName} failed${error instanceof Error && error.name === 'AbortError' ? ': aborted' : '; check server connection or authorization'}`,
      );
    }
  }

  getInstructions(): Record<string, string> {
    return Object.fromEntries(
      [...this.clients].flatMap(([name, client]) => {
        const instructions = client.getInstructions();
        return instructions ? [[name, instructions]] : [];
      }),
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
    this.tools.clear();
  }
}
