import { ChimeraClient } from '@chimera/client';
import type { ReloadingCommandRegistry } from '@chimera/commands';
import { composeSystemPrompt, type SandboxMode } from '@chimera/core';
import { applyOverlay, diffOverlay, discardOverlay, forkOverlay } from '@chimera/sandbox';
import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import type { ReloadingAgentRegistry } from '@chimera/subagents';
import { mountTui, type OverlayHandlers } from '@chimera/tui';
import { loadReloadingAgentsFromConfig } from '../agents-loader';
import { loadReloadingCommandsFromConfig } from '../commands-loader';
import { loadConfig, resolveModel } from '../config';
import { CliAgentFactory } from '../factory';
import { loadModesFromConfig } from '../modes-loader';
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
  /** False → skip mode discovery (from `--no-modes`). */
  modes?: boolean;
  /** Initial mode for new sessions (from `--mode <name>`). Falls back to config.defaultMode. */
  mode?: string;
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

  const modes = loadModesFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    modesDisabled: opts.modes === false,
  });

  const initialMode = opts.mode ?? config.defaultMode ?? 'build';

  const agents = loadReloadingAgentsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
  });

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
    },
    models: config.models,
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

  // Build extensions array matching the factory's logic for skills.
  const extensions = skills ? [() => skills.buildIndex() || null] : undefined;

  const handle = mountTui({
    client,
    sessionId,
    modelRef: ref,
    model,
    cwd: opts.cwd,
    commands,
    skills,
    modes,
    // Default cycle = every discovered mode (alphabetical). If a user wants
    // a smaller cycle they set `cycleModes: ["build", "plan"]` explicitly.
    cycleModes: config.cycleModes ?? modes.all().map((mode) => mode.name),
    initialMode,
    sandboxMode,
    overlay,
    reloadSystemPrompt: async ({ cwd }) => {
      // Look up the session's active mode so the recomposed prompt keeps
      // the `# Current mode: <name>` block — without this, /reload would
      // strip the mode body and the next run would lose the mode's
      // directive entirely.
      let modeBlock: { name: string; body: string } | undefined;
      try {
        const current = await client.getMode(sessionId);
        const found = modes.find(current.mode);
        if (found) modeBlock = { name: found.name, body: found.body };
      } catch {
        // best-effort: fall back to initialMode below
      }
      if (!modeBlock) {
        const fallback = modes.find(initialMode);
        if (fallback) modeBlock = { name: fallback.name, body: fallback.body };
      }
      return composeSystemPrompt({
        cwd,
        home: opts.home,
        model,
        sandboxMode,
        extensions,
        mode: modeBlock,
      });
    },
  });
  try {
    await handle.waitUntilExit();
  } finally {
    (commands as Partial<ReloadingCommandRegistry>).close?.();
    (agents as Partial<ReloadingAgentRegistry>).close?.();
    await factory.dispose();
    await server.close();
  }
}
