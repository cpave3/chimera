import { ChimeraClient } from '@chimera/client';
import type { ReloadingCommandRegistry } from '@chimera/commands';
import type { SandboxMode } from '@chimera/core';
import { applyOverlay, diffOverlay, discardOverlay } from '@chimera/sandbox';
import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import { mountTui, type OverlayHandlers } from '@chimera/tui';
import { loadReloadingCommandsFromConfig } from '../commands-loader';
import { loadConfig, resolveModel } from '../config';
import { CliAgentFactory } from '../factory';
import { CHIMERA_CLI_VERSION } from '../program';
import { parseSandboxFlags, type ParseSandboxFlagsInput } from '../sandbox-config';
import { loadSkillsFromConfig } from '../skills-loader';

export interface InteractiveOptions {
  cwd: string;
  model?: string;
  maxSteps?: number;
  autoApprove?: 'none' | 'sandbox' | 'host' | 'all';
  session?: string;
  home?: string;
  claudeCompat?: boolean;
  /** False → skip skill discovery + injection (from `--no-skills`). */
  skills?: boolean;
  sandboxFlags?: Omit<ParseSandboxFlagsInput, 'cliVersion'>;
  subagents?: boolean;
  maxSubagentDepth?: number;
}

export async function runInteractive(opts: InteractiveOptions): Promise<void> {
  const sandboxOpts = opts.sandboxFlags
    ? parseSandboxFlags({ ...opts.sandboxFlags, cliVersion: CHIMERA_CLI_VERSION })
    : null;
  const sandboxMode: SandboxMode = sandboxOpts?.enabled ? sandboxOpts.mode : 'off';

  const config = loadConfig(opts.home);
  const { model, ref, providersConfig } = resolveModel({
    cliModel: opts.model,
    maxSteps: opts.maxSteps,
    config,
  });

  const skills = loadSkillsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    skillsDisabled: opts.skills === false,
    // Interactive TUI: swallow frontmatter-validation warnings rather than
    // bleeding them into the terminal above the header. Users who want the
    // diagnostic run `chimera skills` which keeps the warnings.
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
    },
  });

  const commands = loadReloadingCommandsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
  });

  const registry = new AgentRegistry({
    factory,
    instance: {
      pid: process.pid,
      cwd: opts.cwd,
      version: '0.1.0',
      sandboxMode,
    },
    loadCommands: () => commands.list(),
    loadSkills: () => skills.all(),
  });
  const app = buildApp({ registry });
  const server = await startServer({ app });

  const client = new ChimeraClient({ baseUrl: server.url });
  const { sessionId } = await client.createSession({
    cwd: opts.cwd,
    model,
    sandboxMode,
    sessionId: opts.session,
  });

  const overlay: OverlayHandlers | undefined =
    sandboxMode === 'overlay'
      ? {
          diff: () => diffOverlay(sessionId, opts.cwd),
          apply: async (paths) => {
            await applyOverlay(sessionId, opts.cwd, paths ? { paths } : {});
          },
          discard: () => discardOverlay(sessionId),
        }
      : undefined;

  const handle = mountTui({
    client,
    sessionId,
    modelRef: ref,
    cwd: opts.cwd,
    commands,
    skills,
    sandboxMode,
    overlay,
  });
  try {
    await handle.waitUntilExit();
  } finally {
    (commands as Partial<ReloadingCommandRegistry>).close?.();
    await factory.dispose();
    await server.close();
  }
}
