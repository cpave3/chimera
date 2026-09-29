import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DefaultPermissionGate } from '@chimera/permissions';
import { configPath, loadConfig, type McpServerConfig, validateMcpServers } from '../config';
import { McpAuth } from '../mcp/auth';
import { McpClientManager } from '../mcp/client';

function authDirectory(home: string): string {
  return join(home, '.chimera', 'mcp-auth');
}

function serverFor(name: string, home: string): McpServerConfig {
  const servers = loadConfig(home).mcpServers ?? {};
  if (!Object.hasOwn(servers, name)) throw new Error(`MCP server '${name}' is not configured`);
  return servers[name];
}

function managerFor(name: string, server: McpServerConfig, home: string): McpClientManager {
  return new McpClientManager(
    { [name]: server },
    (serverName, url) =>
      new McpAuth(serverName, url, {
        directory: authDirectory(home),
        clientId: server.transport === 'http' ? server.clientId : undefined,
      }),
  );
}

async function saveServers(servers: Record<string, McpServerConfig>, home: string): Promise<void> {
  const path = configPath(home);
  const config = loadConfig(home);
  validateMcpServers(servers, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function runMcpAdd(
  name: string,
  server: McpServerConfig,
  home = homedir(),
): Promise<void> {
  const servers = loadConfig(home).mcpServers ?? {};
  if (Object.hasOwn(servers, name)) throw new Error(`MCP server '${name}' is already configured`);
  await saveServers({ ...servers, [name]: server }, home);
  process.stdout.write(`Added MCP server ${name}\n`);
  if (server.transport === 'http') {
    if (process.stdin.isTTY && process.stderr.isTTY) {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      let answer: string;
      try {
        answer = await prompt.question('Log in and test this server now? [y/N] ');
      } finally {
        prompt.close();
      }
      if (/^y(es)?$/i.test(answer.trim())) {
        try {
          await runMcpLogin(name, home);
          await runMcpTools(name, home);
        } catch (error) {
          process.stderr.write(
            `MCP server ${name} was saved, but login/test failed: ${(error as Error).message}\n`,
          );
        }
      }
    } else {
      process.stdout.write(`Run chimera mcp login ${name} to authorize this server.\n`);
    }
  }
}

export async function runMcpList(home = homedir()): Promise<void> {
  const servers = loadConfig(home).mcpServers ?? {};
  for (const [name, server] of Object.entries(servers)) {
    const auth =
      server.transport === 'http'
        ? (await new McpAuth(name, server.url, { directory: authDirectory(home) }).tokens())
          ? 'credentials stored'
          : 'login required'
        : 'not applicable';
    const manager = managerFor(name, server, home);
    let connection = 'connected';
    try {
      await manager.discover(name);
    } catch {
      connection = 'unavailable';
    } finally {
      await manager.close();
    }
    const target = server.transport === 'http' ? new URL(server.url).origin : server.command;
    process.stdout.write(`${name}\t${server.transport}\t${target}\t${connection}\t${auth}\n`);
  }
}

export async function runMcpRemove(name: string, home = homedir()): Promise<void> {
  const servers = loadConfig(home).mcpServers ?? {};
  if (!Object.hasOwn(servers, name)) throw new Error(`MCP server '${name}' is not configured`);
  const { [name]: removed, ...remaining } = servers;
  await saveServers(remaining, home);
  if (removed.transport === 'http')
    await new McpAuth(name, removed.url, { directory: authDirectory(home) }).logout();
  process.stdout.write(`Removed MCP server ${name}\n`);
}

export async function runMcpTools(name: string, home = homedir()): Promise<void> {
  const server = serverFor(name, home);
  const manager = managerFor(name, server, home);
  try {
    const tools = await manager.discover(name);
    for (const tool of tools) process.stdout.write(`${tool.name}\t${tool.description ?? ''}\n`);
  } finally {
    await manager.close();
  }
}

export async function runMcpCall(
  name: string,
  toolName: string,
  argsJson: string,
  home = homedir(),
): Promise<void> {
  const server = serverFor(name, home);
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    throw new Error('--args must be a JSON object');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('--args must be a JSON object');
  }
  const gate = new DefaultPermissionGate({
    cwd: process.cwd(),
    home,
    autoApprove: 'none',
    headlessAutoDeny: !process.stdin.isTTY || !process.stderr.isTTY,
    raiseRequest: async (request) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await prompt.question(
          `Allow MCP ${request.mcp?.server}/${request.mcp?.tool} on host? Arguments: ${request.mcp?.preview.map((item) => `${item.name} (${item.type})`).join(', ') ?? ''} [y/N] `,
        );
        return { decision: /^y(es)?$/i.test(answer.trim()) ? 'allow' : 'deny', remembered: false };
      } finally {
        prompt.close();
      }
    },
  });
  const resolution = await gate.requestMcp(
    {
      requestId: randomUUID(),
      cwd: process.cwd(),
      server: name,
      tool: toolName,
      args: args as Record<string, unknown>,
    },
    server.trustedTools ?? [],
  );
  if (resolution.decision !== 'allow') {
    throw new Error(
      `MCP call ${name}/${toolName} denied; approve it in a terminal or configure trustedTools for this server`,
    );
  }
  const manager = managerFor(name, server, home);
  try {
    const result = await manager.call(name, toolName, args as Record<string, unknown>);
    if (result.isError)
      throw new Error(
        `MCP tool ${name}/${toolName} returned an error: ${JSON.stringify(result.content)}`,
      );
    for (const content of result.content ?? []) {
      if (content.type === 'text') process.stdout.write(`${content.text}\n`);
      else process.stdout.write(`[MCP ${content.type} content is not printable]\n`);
    }
    if (result.structuredContent)
      process.stdout.write(`${JSON.stringify(result.structuredContent)}\n`);
  } finally {
    await manager.close();
  }
}

export async function runMcpLogin(name: string, home = homedir()): Promise<void> {
  const server = serverFor(name, home);
  if (server.transport !== 'http') throw new Error('Only HTTP MCP servers use OAuth login');
  const provider = new McpAuth(name, server.url, {
    directory: authDirectory(home),
    clientId: server.clientId,
  });
  await provider.login({
    onCallback: () => process.stderr.write(`MCP callback received for ${name}; exchanging code.\n`),
    onUrl: (url) => {
      process.stderr.write(`Open this URL to authorize ${name}: ${url}\n`);
      if (process.stdin.isTTY && process.stderr.isTTY) {
        const browser = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        browser.on('error', () => {});
        browser.unref();
      }
    },
  });
  process.stdout.write(`Logged in to MCP server ${name}\n`);
}

export async function runMcpLogout(name: string, home = homedir()): Promise<void> {
  const server = serverFor(name, home);
  if (server.transport !== 'http') throw new Error('Only HTTP MCP servers use OAuth login');
  await new McpAuth(name, server.url, { directory: authDirectory(home) }).logout();
  process.stdout.write(`Logged out of MCP server ${name}\n`);
}
