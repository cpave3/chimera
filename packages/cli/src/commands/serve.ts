import type { SandboxMode } from '@chimera/core';
import { forkOverlay } from '@chimera/sandbox';
import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import { loadConfig, resolveModel } from '../config';
import { CliAgentFactory } from '../factory';
import { removeLockfile, writeLockfile } from '../lockfile';
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

  const factory = new CliAgentFactory({
    providersConfig,
    autoApprove: opts.autoApprove ?? 'host',
    home: opts.home,
    skills,
    sandbox: sandboxOpts ?? undefined,
    subagents: {
      enabled: opts.subagents !== false,
      maxDepth: opts.maxSubagentDepth,
      currentDepth: opts.currentSubagentDepth,
      headlessAutoDeny: opts.headlessPermissionAutoDeny,
    },
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
    process.stderr.write(
      `chimera server listening on ${server.url} (session ${sessionId})\n`,
    );
  }

  // Stay alive.
  await new Promise(() => {});
}
