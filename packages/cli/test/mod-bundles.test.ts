import { describe, expect, it } from 'vitest';
import { type McpModBundle, mergeModMcpServers } from '../src/mod-bundles';

describe('mergeModMcpServers', () => {
  it.each([
    'env:MISSING_TOKEN',
    '${MISSING_TOKEN}',
  ])('reports missing env references (%s)', (value) => {
    expect(() =>
      mergeModMcpServers(
        {},
        [
          {
            name: 'audit',
            directory: '/mods/audit',
            manifest: {
              mcpServers: {
                audit: { transport: 'stdio', command: 'server', env: { TOKEN: value } },
              },
            },
          },
        ],
        { env: {} },
      ),
    ).toThrow('MCP server audit in mod audit needs environment variable MISSING_TOKEN');
  });

  it('starts bundled servers in children except opted-out winners, without falling back to a later mod', () => {
    const bundles: McpModBundle[] = [
      {
        name: 'first',
        directory: '/mods/first',
        manifest: {
          mcpServers: {
            shared: { transport: 'http', url: 'https://example.test/shared' },
            private: { transport: 'stdio', command: 'private', subagents: false },
          },
        },
      },
      {
        name: 'second',
        directory: '/mods/second',
        manifest: {
          mcpServers: {
            private: { transport: 'stdio', command: 'replacement' },
          },
        },
      },
    ];
    expect(Object.keys(mergeModMcpServers({}, bundles))).toEqual(['shared', 'private']);
    expect(mergeModMcpServers({}, bundles, { subagent: true })).toEqual({
      shared: { transport: 'http', url: 'https://example.test/shared' },
    });
  });

  it('uses only the default environment allowlist unless the entry has an env map', () => {
    const servers = mergeModMcpServers(
      {},
      [
        {
          name: 'audit',
          directory: '/mods/audit',
          manifest: {
            mcpServers: {
              defaults: { transport: 'stdio', command: 'server' },
              empty: { transport: 'stdio', command: 'server', env: {} },
            },
          },
        },
      ],
      {
        env: {
          HOME: '/home/alice',
          LOGNAME: 'alice',
          PATH: '/bin',
          SHELL: '/bin/sh',
          TERM: 'xterm',
          USER: 'alice',
          AWS_SECRET_ACCESS_KEY: 'secret',
        },
      },
    );
    expect(servers.defaults).toEqual({
      transport: 'stdio',
      command: 'server',
      cwd: '/mods/audit',
      env: {
        HOME: '/home/alice',
        LOGNAME: 'alice',
        PATH: '/bin',
        SHELL: '/bin/sh',
        TERM: 'xterm',
        USER: 'alice',
      },
      inheritEnv: false,
    });
    expect(servers.empty).toMatchObject({
      env: { HOME: '/home/alice', AWS_SECRET_ACCESS_KEY: 'secret' },
      inheritEnv: false,
    });
  });

  it('keeps config and CLI winners unchanged and takes the first loaded mod server', () => {
    const configured = {
      audit: { transport: 'stdio' as const, command: 'config-server' },
    };
    const bundles: McpModBundle[] = ['first', 'second'].map((name) => ({
      name,
      directory: `/mods/${name}`,
      manifest: {
        mcpServers: {
          audit: { transport: 'stdio', command: 'shadowed', env: { TOKEN: 'env:MISSING' } },
          docs: {
            transport: 'http',
            url: `https://${name}.example.test/mcp`,
            trustedTools: ['search'],
          },
        },
      },
    }));
    const servers = mergeModMcpServers(configured, bundles, { env: {} });
    expect(servers.audit).toBe(configured.audit);
    expect(servers.docs).toEqual({
      transport: 'http',
      url: 'https://first.example.test/mcp',
      trustedTools: ['search'],
    });
    expect(Object.keys(configured)).toEqual(['audit']);
  });

  it('prepares a bundled stdio server with mod paths, explicit environment and trusted tools', () => {
    const servers = mergeModMcpServers(
      {},
      [
        {
          name: 'audit',
          directory: '/mods/audit',
          manifest: {
            mcpServers: {
              audit: {
                transport: 'stdio',
                command: '${MOD_DIR}/bin/server',
                args: ['--root', '${MOD_DIR}/data'],
                env: {
                  TOKEN: 'env:AUDIT_TOKEN',
                  CACHE: '${MOD_DIR}/cache',
                  LABEL: 'audit-${USER}',
                },
                trustedTools: ['inspect'],
              },
            },
          },
        },
      ],
      { env: { AUDIT_TOKEN: 'secret', USER: 'alice', UNRELATED_SECRET: 'must not leak' } },
    );
    expect(servers.audit).toEqual({
      transport: 'stdio',
      command: '/mods/audit/bin/server',
      args: ['--root', '/mods/audit/data'],
      env: {
        AUDIT_TOKEN: 'secret',
        USER: 'alice',
        UNRELATED_SECRET: 'must not leak',
        TOKEN: 'secret',
        CACHE: '/mods/audit/cache',
        LABEL: 'audit-alice',
      },
      cwd: '/mods/audit',
      inheritEnv: false,
      trustedTools: ['inspect'],
    });
  });
});
