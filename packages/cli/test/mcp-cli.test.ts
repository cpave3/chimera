import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpAuth } from '../src/mcp/auth';

const bin = join(__dirname, '..', 'dist', 'bin.js');

async function isolatedHome() {
  return mkdtemp(join(tmpdir(), 'chimera-mcp-cli-'));
}

function cli(home: string, ...args: string[]) {
  return spawnSync('node', [bin, 'mcp', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

describe('chimera mcp', () => {
  it('reports unknown server names instead of looking up inherited object properties', async () => {
    const home = await isolatedHome();
    const result = cli(home, 'tools', 'constructor');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MCP server 'constructor' is not configured");
  });
  it('logs out and removes credentials without revealing tokens or removing the wrong server', async () => {
    const home = await isolatedHome();
    await mkdir(join(home, '.chimera'));
    const url = 'http://127.0.0.1:1/mcp';
    const configPath = join(home, '.chimera', 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { remote: { transport: 'http', url } } }),
    );
    const auth = new McpAuth('remote', url, { directory: join(home, '.chimera', 'mcp-auth') });
    await auth.saveTokens({ access_token: 'secret-test-token', token_type: 'Bearer' });
    const listed = cli(home, 'list');
    expect(listed.stdout).toContain('credentials stored');
    expect(listed.stdout + listed.stderr).not.toContain('secret-test-token');
    expect(cli(home, 'logout', 'remote').status).toBe(0);
    expect(await auth.tokens()).toBeUndefined();
    expect(JSON.parse(await readFile(configPath, 'utf8')).mcpServers.remote.url).toBe(url);
    await auth.saveTokens({ access_token: 'secret-test-token', token_type: 'Bearer' });
    expect(cli(home, 'remove', 'remote').status).toBe(0);
    expect(await auth.tokens()).toBeUndefined();
    expect(JSON.parse(await readFile(configPath, 'utf8')).mcpServers).toEqual({});
  });
  it('denies a headless call before reaching a stdio tool, then allows a trusted tool', async () => {
    const home = await isolatedHome();
    await mkdir(join(home, '.chimera'));
    const marker = join(home, 'called');
    const script = join(home, 'server.cjs');
    await writeFile(
      script,
      `
      const fs = require('node:fs');
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }] }
            : (fs.writeFileSync(${JSON.stringify(marker)}, 'yes'), { content: [{ type: 'text', text: message.params.arguments.message }] });
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      });
    `,
    );
    const configPath = join(home, '.chimera', 'config.json');
    const config = {
      mcpServers: { local: { transport: 'stdio', command: 'node', args: [script] } },
    };
    await writeFile(configPath, JSON.stringify(config));
    const denied = cli(home, 'call', 'local', 'echo', '--args', '{"message":"hello"}');
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/denied/);
    await expect(readFile(marker)).rejects.toThrow();
    expect(cli(home, 'tools', 'local').stdout).toContain('echo');
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          local: { ...config.mcpServers.local, trustedTools: ['echo'] },
        },
      }),
    );
    const allowed = cli(home, 'call', 'local', 'echo', '--args', '{"message":"hello"}');
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain('hello');
    expect(await readFile(marker, 'utf8')).toBe('yes');
  });
  it('adds an HTTP server without attempting browser login in a headless terminal', async () => {
    const home = await isolatedHome();
    const result = cli(
      home,
      'add',
      'burnlite',
      '--transport',
      'http',
      'https://burnlite.dev/api/llm/mcp',
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('chimera mcp login burnlite');
    expect(
      JSON.parse(await readFile(join(home, '.chimera', 'config.json'), 'utf8')).mcpServers,
    ).toEqual({
      burnlite: { transport: 'http', url: 'https://burnlite.dev/api/llm/mcp' },
    });
    expect(
      cli(home, 'add', 'burnlite', '--transport', 'http', 'https://other.test/mcp').status,
    ).not.toBe(0);
    expect(
      cli(home, 'add', 'insecure', '--transport', 'http', 'http://remote.test/mcp').status,
    ).not.toBe(0);
    expect(cli(home, 'remove', 'burnlite').status).toBe(0);
    expect(
      JSON.parse(await readFile(join(home, '.chimera', 'config.json'), 'utf8')).mcpServers,
    ).toEqual({});
  });

  it('adds a stdio server and lists it while preserving unrelated config', async () => {
    const home = await isolatedHome();
    await mkdir(join(home, '.chimera'));
    await writeFile(
      join(home, '.chimera', 'config.json'),
      JSON.stringify({ defaultModel: 'example/model' }),
    );
    const added = cli(home, 'add', 'local', '--transport', 'stdio', '--', 'node', 'server.js');
    expect(added.status).toBe(0);
    const config = JSON.parse(await readFile(join(home, '.chimera', 'config.json'), 'utf8'));
    expect(config).toEqual({
      defaultModel: 'example/model',
      mcpServers: { local: { transport: 'stdio', command: 'node', args: ['server.js'] } },
    });
    const listed = cli(home, 'list');
    expect(listed.status).toBe(0);
    expect(listed.stdout).toMatch(/local.*stdio/);
  });
});
