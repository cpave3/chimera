import { join } from 'node:path';
import { ChimeraClient } from '@chimera/client';
import type { ReloadingCommandRegistry } from '@chimera/commands';
import { Compactor } from '@chimera/compaction';
import {
  INSTRUCTION_FILE_LIMIT_BYTES,
  MEMORY_INDEX_FILE,
  oversizedInstructionFiles,
  projectMemoryDir,
  type SandboxMode,
} from '@chimera/core';
import { loadProviders, resolveContextWindow } from '@chimera/providers';
import { applyOverlay, diffOverlay, discardOverlay, forkOverlay } from '@chimera/sandbox';
import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import type { ReloadingAgentRegistry } from '@chimera/subagents';
import {
  authenticateSudoPassword,
  checkSudoAuthentication,
  mountTui,
  type OverlayHandlers,
} from '@chimera/tui';
import { loadReloadingAgentsFromConfig } from '../agents-loader';
import { startBackgroundUpdates, updateStatus } from '../background-updates';
import { loadReloadingCommandsFromConfig } from '../commands-loader';
import {
  checkCompactionInvariant,
  compactionCallOptions,
  compactionModelOptions,
  recallPrunerFactory,
  resolveCompactionConfig,
} from '../compaction';
import {
  approvalReviewerEnabled,
  goalMaxContinuations,
  loadConfig,
  resolveHostBashPolicy,
  resolveMcpServers,
  resolveModel,
  resolveSystemOne,
} from '../config';
import { CliAgentFactory } from '../factory';
import { launchSession, type SessionExistsPolicy } from '../launch-session';
import { removeLockfile, removeLockfileOnExit, writeLockfile } from '../lockfile';
import { mergeModMcpServers } from '../mod-bundles';
import { type ModOptions, ModRuntime } from '../mod-runtime';
import { loadModesFromConfig } from '../modes-loader';
import { type ParseSandboxFlagsInput, parseSandboxFlags } from '../sandbox-config';
import { readServerSecret } from '../server-secret';
import { onShutdownSignals, type ShutdownReason, shutdownLifecycle } from '../session-shutdown';
import { loadSkillsFromConfig } from '../skills-loader';
import { OwnerLocalSudoAuthentication } from '../sudo-authentication';
import { Updater } from '../updater';
import { VERSION } from '../version';

export interface InteractiveOptions extends ModOptions {
  cwd: string;
  model?: string;
  modelSettings?: string;
  maxSteps?: number;
  autoApprove?: 'none' | 'sandbox' | 'host' | 'all';
  session?: string;
  sessionName?: string;
  sessionId?: string;
  sessionExists?: SessionExistsPolicy;
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
  /** Initial message to submit when the TUI mounts (from `--prompt <text>`). */
  initialPrompt?: string;
  /**
   * Per-session override for compaction. When `false` (from `--no-compaction`),
   * compaction is disabled for this invocation.
   */
  compaction?: boolean;
  /** Additional absolute paths for read access outside cwd. */
  additionalReadPaths?: string[];
  /** Additional absolute paths for write access outside cwd. */
  additionalWritePaths?: string[];
  /**
   * Raw `--mcp-config` value: MCP servers for this session only, as JSON or
   * `@<path>`. Merged over the global config by `resolveMcpServers`.
   */
  mcpConfig?: string;
  /** From `--inline`: print into the terminal's scrollback for this invocation. */
  inline?: boolean;
}

/** One notice per instruction file of the system prompt that was cut to the size limit. */
export function instructionFileNotices(cwd: string, home?: string): string[] {
  const kib = (bytes: number) => Math.round(bytes / 1024);
  return oversizedInstructionFiles(cwd, home).map(
    (file) =>
      `${file.path} is ${kib(file.bytes)} KiB; only its first ${kib(INSTRUCTION_FILE_LIMIT_BYTES)} KiB are used. Move detail into files the agent can read when it needs them.`,
  );
}

/** What a fullscreen session leaves on the terminal when it ends. */
export function formatExitSummary(sessionId: string): string {
  return `chimera session ${sessionId}\nresume with: chimera --session ${sessionId}\n`;
}

export async function runInteractive(opts: InteractiveOptions): Promise<void> {
  const secret = readServerSecret();
  const sandboxOpts = opts.sandboxFlags
    ? parseSandboxFlags({ ...opts.sandboxFlags, cliVersion: VERSION })
    : null;
  const sandboxMode: SandboxMode = sandboxOpts?.enabled ? sandboxOpts.mode : 'off';

  const config = loadConfig(opts.home);
  const modRuntime = await ModRuntime.create({ ...opts, disabled: config.mods?.disabled });
  // Resolved before anything else is set up, so a bad --mcp-config stops the
  // command at once instead of after a model has been chosen.
  const mcpServers = mergeModMcpServers(
    resolveMcpServers(config, opts.mcpConfig),
    modRuntime.bundles,
    {},
  );
  const { model, ref, providersConfig } = resolveModel({
    cliModel: opts.model,
    cliSettings: opts.modelSettings,
    maxSteps: opts.maxSteps,
    config,
  });

  const skills = loadSkillsFromConfig({
    modBundles: modRuntime.bundles,
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
    modBundles: modRuntime.bundles,
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    modesDisabled: opts.modes === false,
  });

  const initialMode = opts.mode ?? config.defaultMode ?? 'build';

  const agents = loadReloadingAgentsFromConfig({
    modBundles: modRuntime.bundles,
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
  });

  const compactionConfig = resolveCompactionConfig({ cliOverride: opts.compaction, config });
  const resolvedWindow = resolveContextWindow({
    providerShape: providersConfig.providers[model.providerId]?.shape ?? 'openai',
    providerId: model.providerId,
    modelId: model.modelId,
    override: config.models?.[ref]?.contextWindow,
  });
  const invariant = checkCompactionInvariant(compactionConfig, resolvedWindow.value);
  if (!invariant.ok) {
    process.stderr.write(`${invariant.error}\n`);
    process.exit(1);
  }

  let compactor: Compactor | undefined;
  if (compactionConfig.enabled) {
    const registry = loadProviders(providersConfig);
    compactor = new Compactor({
      config: compactionConfig,
      contextWindow: resolvedWindow.value,
      imageLongEdge: config.models?.[ref]?.imageLongEdge,
      resolveModel: async (ref, sessionId) => {
        const target = registry.resolve(ref);
        return target.provider.getModel(target.modelId, sessionId);
      },
      resolveCallOptions: compactionCallOptions(config, registry),
      ...compactionModelOptions(config, registry),
      home: opts.home,
      createPruner: recallPrunerFactory(config, opts.home),
    });
  }

  const hostAuthentication = new OwnerLocalSudoAuthentication(
    ({ signal }) => checkSudoAuthentication({ signal, effectiveUserId: () => process.geteuid?.() }),
    ({ password, signal }) => authenticateSudoPassword({ password, signal }),
  );
  const factory = new CliAgentFactory({
    mods: modRuntime.host,
    modDirs: opts.modDirs,
    noMods: opts.mods === false,
    providersConfig,
    autoApprove: opts.autoApprove ?? 'host',
    hostBashPolicy: resolveHostBashPolicy(config, opts.home),
    mcpServers,
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
    defaultVisionModel: config.defaultVisionModel,
    fallbackModel: config.fallbackModel,
    utilityModel: config.utilityModel,
    approvalReviewer: approvalReviewerEnabled(config),
    systemOne: resolveSystemOne(config),
    goal: { maxContinuations: goalMaxContinuations(config) },
    memory: config.memory,
    userCanAnswer: true,
    compaction: compactionConfig,
    compactor,
    responseTimeoutMs: config.responseTimeoutMs,
    diagnostics: config.diagnostics,
    webSearch: config.webSearch,
    recall: config.recall,
    hostAuthentication,
  });

  const commands = loadReloadingCommandsFromConfig({
    modBundles: modRuntime.bundles,
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
      version: VERSION,
      sandboxMode,
    },
    loadCommands: () => commands.list(),
    loadSkills: () => skills.all(),
    loadModes: () => modes.all(),
    loadModels: () => factory.listModels(),
    home: opts.home,
    workspaceCheckpoints: config.workspaceCheckpoints !== false,
  });
  const app = buildApp({
    registry,
    secret,
    home: opts.home,
    onSessionChange: (activeSessionId) => {
      writeLockfile(
        {
          ...lockfile,
          sessionId: activeSessionId,
          parentId: registry.get(activeSessionId)?.agent.session.parentId ?? undefined,
        },
        opts.home,
      );
    },
    onFork: async (parent, childId) => {
      if (parent.sandboxMode === 'overlay') {
        await forkOverlay(parent.id, childId, {});
      }
    },
  });
  const server = await startServer({ app, secret });
  modRuntime.bind(registry, server.url);

  let stopUpdates = () => {};
  let stopLockfileCleanup = () => {};
  let unmount = () => {};
  let closing: Promise<void> | undefined;
  const shutdown = (reason: ShutdownReason) => {
    closing ??= (async () => {
      stopUpdates();
      stopLockfileCleanup();
      removeLockfile(process.pid, opts.home);
      (commands as Partial<ReloadingCommandRegistry>).close?.();
      (agents as Partial<ReloadingAgentRegistry>).close?.();
      await shutdownLifecycle(registry, modRuntime, reason);
      await factory.dispose();
      await server.close();
    })();
    return closing;
  };
  const stopSignals = onShutdownSignals(async (reason) => {
    const closing = shutdown(reason);
    unmount();
    await closing;
    process.exit(0);
  });

  const client = new ChimeraClient({ baseUrl: server.url });
  const { sessionId } = await launchSession(
    client,
    {
      cwd: opts.cwd,
      model,
      sandboxMode,
      name: opts.sessionName,
      requestedSessionId: opts.sessionId,
      additionalReadPaths: opts.additionalReadPaths,
      additionalWritePaths: opts.additionalWritePaths,
    },
    { resumeSessionId: opts.session, sessionExists: opts.sessionExists },
  );

  // Make this instance discoverable by `chimera attach` and `chimera ls`.
  // Same lockfile format as `chimera serve`; removed on exit so stale
  // lockfiles don't accumulate.
  const lockfile = {
    pid: process.pid,
    port: server.port,
    cwd: opts.cwd,
    sessionId,
    parentId: registry.get(sessionId)?.agent.session.parentId ?? undefined,
    startedAt: Date.now(),
    version: VERSION,
    url: new URL(server.url).origin,
  };
  writeLockfile(lockfile, opts.home);

  stopLockfileCleanup = removeLockfileOnExit(process.pid, opts.home);

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
    startupNotices: instructionFileNotices(opts.cwd, opts.home),
    // A sandbox's file tools cannot reach the memory, but the user's editor can.
    memoryIndexPath:
      config.memory?.enabled === false
        ? undefined
        : join(projectMemoryDir(opts.cwd, opts.home), MEMORY_INDEX_FILE),
    layout: opts.inline ? 'inline' : config.tui?.layout,
    mouse: config.tui?.mouse,
    notifications: config.tui?.notifications,
    statusLine: config.statusLine,
    version: VERSION,
    client,
    sessionId,
    modelRef: ref,
    model,
    cwd: opts.cwd,
    commands,
    skills,
    modes,
    formatters: factory.getFormatters(),
    initialPrompt: opts.initialPrompt,
    checkSudo: (request) => hostAuthentication.checkSudo(request),
    authenticateSudo: (request) => hostAuthentication.authenticateSudo(request),
    // Default cycle = every discovered mode (alphabetical). If a user wants
    // a smaller cycle they set `cycleModes: ["build", "plan"]` explicitly.
    cycleModes: config.cycleModes ?? modes.all().map((mode) => mode.name),
    initialMode,
    sandboxMode,
    osSandbox: factory.osSandboxOf(sessionId) !== undefined,
    overlay,
    // The factory composes the prompt the same way it did at session start:
    // instruction files, skills, mode and tool list as they are now.
    reloadSystemPrompt: ({ sessionId: activeSessionId }) => {
      const prompt = factory.composeSystemPromptFor(activeSessionId);
      if (prompt === undefined) throw new Error(`session ${activeSessionId} is not loaded`);
      return prompt;
    },
  });
  const updater = new Updater();
  unmount = () => handle.unmount();
  modRuntime.connectUi((text, options) => handle.modLog(text, options));
  stopUpdates = startBackgroundUpdates({
    mode: config.updates?.mode ?? 'auto',
    updater,
    onNotice: (notice) => handle.updateStatus(updateStatus(updater), notice),
    onChange: () => handle.updateStatus(updateStatus(updater)),
  });
  try {
    await handle.waitUntilExit();
    // The transcript stays in the scrollback; say how to get back to it.
    process.stdout.write(formatExitSummary(handle.activeSessionId()));
  } finally {
    await shutdown('exit');
    stopSignals();
  }
}
