import type { McpServerConfig } from './config';

export interface McpModBundle {
  name: string;
  directory: string;
  manifest: {
    mcpServers?: Record<string, McpServerConfig & { subagents?: boolean }>;
  };
}

export type BundledMcpServerConfig = McpServerConfig & {
  cwd?: string;
  inheritEnv?: false;
};

export interface MergeModMcpOptions {
  subagent?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function mergeModMcpServers(
  configured: Record<string, McpServerConfig>,
  bundles: readonly McpModBundle[],
  options: MergeModMcpOptions = {},
): Record<string, BundledMcpServerConfig> {
  const servers: Record<string, BundledMcpServerConfig> = { ...configured };
  const seen = new Set(Object.keys(configured));
  const environment = options.env ?? process.env;
  for (const bundle of bundles) {
    for (const [name, entry] of Object.entries(bundle.manifest.mcpServers ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (options.subagent && entry.subagents === false) continue;
      const { subagents: _subagents, ...server } = entry;
      const expandPath = (value: string) => value.replaceAll('${MOD_DIR}', bundle.directory);
      const resolveVariable = (variable: string): string => {
        const value = environment[variable];
        if (value === undefined) {
          throw new Error(
            `MCP server ${name} in mod ${bundle.name} needs environment variable ${variable}`,
          );
        }
        return value;
      };
      const resolveValue = (value: string): string => {
        if (value.startsWith('env:')) return resolveVariable(value.slice(4));
        return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) =>
          variable === 'MOD_DIR' ? bundle.directory : resolveVariable(variable),
        );
      };
      if (server.transport === 'stdio') {
        const defaultEnv = Object.fromEntries(
          ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']
            .filter((key) => environment[key] !== undefined)
            .map((key) => [key, environment[key]!]),
        );
        servers[name] = {
          ...server,
          command: expandPath(server.command),
          args: server.args?.map(expandPath),
          env:
            server.env === undefined
              ? defaultEnv
              : {
                  ...Object.fromEntries(
                    Object.entries(environment).filter(
                      (entry): entry is [string, string] => entry[1] !== undefined,
                    ),
                  ),
                  ...Object.fromEntries(
                    Object.entries(server.env).map(([key, value]) => [key, resolveValue(value)]),
                  ),
                },
          cwd: bundle.directory,
          inheritEnv: false,
        };
      } else {
        servers[name] = { ...server, url: expandPath(server.url) };
      }
    }
  }
  return servers;
}
