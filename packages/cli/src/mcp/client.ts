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
import {
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../version';
import { McpAuth } from './auth.js';

export type McpServerConfig =
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      inheritEnv?: false;
    }
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

type McpConnection = {
  client: Client;
  ready: Promise<void>;
  closed: boolean;
  receiveLimitExceeded?: boolean;
  tools?: Promise<McpTool[]>;
};

export class McpClientManager {
  private readonly connections = new Map<string, McpConnection>();
  private closed = false;
  private readonly limits: Required<McpLimits>;

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly authProvider?: (name: string, url: string) => OAuthClientProvider,
    limits: McpLimits = {},
  ) {
    this.limits = { ...defaults, ...limits };
  }

  private async connect(name: string): Promise<McpConnection> {
    if (this.closed) throw new Error('MCP client manager is closed');
    let connection = this.connections.get(name);
    if (!connection) {
      connection = this.start(name);
      this.connections.set(name, connection);
    }
    await connection.ready;
    if (connection.closed || this.closed) throw new Error(`MCP server ${name} connection closed`);
    return connection;
  }

  private start(name: string): McpConnection {
    const config = this.servers[name];
    if (!config) throw new Error(`MCP server ${name} is not configured`);
    const transport: Transport =
      config.transport === 'stdio'
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            env:
              config.inheritEnv === false
                ? config.env
                : config.env
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
    // Consume diagnostics without retaining server-controlled text or blocking its pipe.
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'chimera', version: VERSION });
    const connection: McpConnection = {
      client,
      ready: Promise.resolve(),
      closed: false,
    };
    client.onerror = (error) => {
      if (
        error.message === `ReadBuffer exceeded maximum size of ${this.limits.maxResultBytes} bytes`
      ) {
        connection.receiveLimitExceeded = true;
      }
    };
    client.onclose = () => {
      connection.closed = true;
      if (this.connections.get(name) === connection) this.connections.delete(name);
    };
    connection.ready = client
      .connect(transport, { timeout: this.limits.connectMs })
      .catch(async () => {
        await client.close();
        throw new Error(
          `MCP server ${name} could not connect${config.transport === 'http' ? `; run chimera mcp login ${name} if authorization is required` : ''}`,
        );
      });
    return connection;
  }

  async discover(name: string, signal?: AbortSignal): Promise<McpTool[]> {
    const connection = await this.connect(name);
    return this.discoverTools(name, connection, signal);
  }

  private discoverTools(
    name: string,
    connection: McpConnection,
    signal?: AbortSignal,
  ): Promise<McpTool[]> {
    if (!connection.tools) {
      connection.tools = this.listTools(name, connection.client, signal).catch(async (error) => {
        connection.tools = undefined;
        throw await this.requestError(name, connection, error, signal);
      });
    }
    return connection.tools;
  }

  private async listTools(name: string, client: Client, signal?: AbortSignal): Promise<McpTool[]> {
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
    return tools;
  }

  async call(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const connection = await this.connect(name);
    const tools = await this.discoverTools(name, connection, signal);
    if (!tools.some((tool) => tool.name === toolName))
      throw new Error(`Unknown MCP tool ${name}/${toolName}`);
    const { client } = connection;
    let result: McpCallResult;
    try {
      // Parsed with the current schema, so the result always has `content`.
      result = (await client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, {
        signal,
        timeout: this.limits.callMs,
      })) as CallToolResult;
    } catch (error) {
      throw await this.requestError(name, connection, error, signal, toolName);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > this.limits.maxResultBytes) {
      throw new Error(
        `MCP tool ${name}/${toolName} returned an oversized result. The call was not retried. Check the result before retrying a mutation.`,
      );
    }
    return result;
  }

  private async requestError(
    name: string,
    connection: McpConnection,
    error: unknown,
    signal?: AbortSignal,
    toolName?: string,
  ): Promise<Error> {
    const subject = toolName ? `MCP tool ${name}/${toolName}` : `MCP server ${name} discovery`;
    if (
      error instanceof UnauthorizedError ||
      (error instanceof StreamableHTTPError && error.code === 401) ||
      (error instanceof Error && error.message === 'Unauthorized')
    ) {
      return new Error(`${subject} needs authorization; run chimera mcp login ${name}`);
    }
    const expiredSession = error instanceof StreamableHTTPError && error.code === 404;
    if (expiredSession) {
      if (this.connections.get(name) === connection) this.connections.delete(name);
      await connection.client.close();
    }
    const reason = connection.receiveLimitExceeded
      ? `response exceeded the ${this.limits.maxResultBytes}-byte receive limit`
      : expiredSession
        ? 'HTTP session expired or endpoint unavailable; a new call will reconnect'
        : signal?.aborted
          ? 'aborted'
          : connection.closed
            ? 'connection closed; a new call will reconnect'
            : error instanceof McpError && error.code === ErrorCode.RequestTimeout
              ? 'timed out'
              : 'request failed; check server health';
    return new Error(
      `${subject} failed: ${reason}. ${toolName ? 'The call was not retried. Check the result before retrying a mutation.' : 'No tool call was sent.'}`,
    );
  }

  getInstructions(): Record<string, string> {
    return Object.fromEntries(
      [...this.connections].flatMap(([name, { client }]) => {
        const instructions = client.getInstructions();
        return instructions ? [[name, instructions]] : [];
      }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.connections.values()].map(({ client }) => client.close()));
    this.connections.clear();
  }
}
