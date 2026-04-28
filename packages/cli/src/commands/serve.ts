import { readFileSync } from 'node:fs';
import type { SandboxMode } from '@chimera/core';
import { forkOverlay } from '@chimera/sandbox';
import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import { loadAgentsFromConfig } from '../agents-loader';
import { loadConfig, resolveModel } from '../config';
import { CliAgentFactory } from '../factory';
import { removeLockfile, writeLockfile } from '../lockfile';
import { loadModesFromConfig } from '../modes-loader';
import { CHIMERA_CLI_VERSION } from '../program';
import { parseSandboxFlags, type ParseSandboxFlagsInput } from '../sandbox-config';
import { loadSkillsFromConfig } from '../skills-loader';

export interface ServeOptions {
  port?: number;
  host?: string;
  machineHandshake?: boolean;
  parent?: string;
  cwd: string;
  model?: string;
  maxSteps?: number;
  autoApprove?: 'none' | 'sandbox' | 'host' | 'all';
  home?: string;
  sandboxFlags?: Omit<ParseSandboxFlagsInput, 'cliVersion'>;
  /** Default true; commander populates `false` when `--no-subagents` is passed. */
  subagents?: boolean;
  maxSubagentDepth?: number;
  /** Internal: forwarded by parents to children. */
  currentSubagentDepth?: number;
  /** Internal: parent had no TTY; child auto-denies prompts. */
  headlessPermissionAutoDeny?: boolean;
  /** Initial mode for the server-bound default session. Falls back to config.defaultMode then "build". */
  mode?: string;
  /** False → skip mode discovery (from `--no-modes`). */
  modes?: boolean;
  /**
   * Path to a file whose contents fully replace the composed system prompt
   * for this server's default session. Used by parents spawning children
   * with an agent-definition body.
   */
  systemPromptFile?: string;
  /**
   * Comma-separated tool names that the server's default session is
   * restricted to (intersected with mode allowlists). Used by parents
   * spawning children with an agent-definition `tools:` field.
   */
  tools?: string;
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const sandboxOpts = opts.sandboxFlags
    ? parseSandboxFlags({ ...opts.sandboxFlags, cliVersion: CHIMERA_CLI_VERSION })
    : null;
  const sandboxMode: SandboxMode = sandboxOpts?.enabled ? sandboxOpts.mode : 'off';

  const config = loadConfig(opts.home);
  const { model, providersConfig } = resolveModel({
    cliModel: opts.model,
    maxSteps: opts.maxSteps,
    config,
  });

  const skills = loadSkillsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });

  const agents = loadAgentsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });

  let systemPromptOverride: string | undefined;
  if (opts.systemPromptFile) {
    try {
      systemPromptOverride = readFileSync(opts.systemPromptFile, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`--system-prompt-file: could not read ${opts.systemPromptFile}: ${message}`);
    }
  }
  const toolsAllowlist = opts.tools
    ? opts.tools
        .split(',')
        .map((tool) => tool.trim().toLowerCase())
        .filter((tool) => tool.length > 0)
    : undefined;

  const modes = loadModesFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    modesDisabled: opts.modes === false,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });
  const initialMode = opts.mode ?? config.defaultMode ?? 'build';

  const factory = new CliAgentFactory({
    providersConfig,
    autoApprove: opts.autoApprove ?? 'host',
    home: opts.home,
    skills,
    agents,
    modes,
    initialMode,
    sandbox: sandboxOpts ?? undefined,
    subagents: {
      enabled: opts.subagents !== false,
      maxDepth: opts.maxSubagentDepth,
      currentDepth: opts.currentSubagentDepth,
      headlessAutoDeny: opts.headlessPermissionAutoDeny,
    },
    systemPromptOverride,
    toolsAllowlist,
    models: config.models,
  });

  const registry = new AgentRegistry({
    factory,
    instance: {
      pid: process.pid,
      cwd: opts.cwd,
      version: '0.1.0',
      sandboxMode,
      parentId: opts.parent,
    },
    loadSkills: () => skills.all(),
    loadModes: () => modes.all(),
  });

  const app = buildApp({
    registry,
    home: opts.home,
    onFork: async (parent, childId) => {
      if (parent.sandboxMode === 'overlay') {
        await forkOverlay(parent.id, childId, {});
      }
    },
  });
  const server = await startServer({ app, port: opts.port, host: opts.host });

  // Create a default session bound to the working directory.
  const { sessionId } = await registry.create({
    cwd: opts.cwd,
    model,
    sandboxMode,
  });

  writeLockfile(
    {
      pid: process.pid,
      port: server.port,
      cwd: opts.cwd,
      sessionId,
      startedAt: Date.now(),
      version: '0.1.0',
      url: server.url,
    },
    opts.home,
  );

  const shutdown = async () => {
    removeLockfile(process.pid, opts.home);
    await factory.dispose();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  if (opts.machineHandshake) {
    process.stdout.write(
      `${JSON.stringify({
        ready: true,
        url: server.url,
        sessionId,
        pid: process.pid,
      })}\n`,
    );
  } else {
    process.stderr.write(`chimera server listening on ${server.url} (session ${sessionId})\n`);
  }

  // Stay alive.
  await new Promise(() => {});
}
