import { ChimeraClient } from '@chimera/client';
import { Compactor } from '@chimera/compaction';
import type { GoalChange, ModelConfig, RunFinishedReason, SandboxMode } from '@chimera/core';
import { loadProviders, resolveContextWindow } from '@chimera/providers';
import { applyOverlay, discardOverlay } from '@chimera/sandbox';
import {
  type AgentFactory,
  AgentRegistry,
  buildApp,
  type ModelListEntry,
  startServer,
} from '@chimera/server';
import { loadAgentsFromConfig } from '../agents-loader';
import { loadCommandsFromConfig } from '../commands-loader';
import {
  checkCompactionInvariant,
  compactionCallOptions,
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
import { type ModOptions, ModRuntime } from '../mod-runtime';
import { loadModesFromConfig } from '../modes-loader';
import { RunRows } from '../run-rows';
import { type ParseSandboxFlagsInput, parseSandboxFlags } from '../sandbox-config';
import { readServerSecret } from '../server-secret';
import { onShutdownSignals, type ShutdownReason, shutdownLifecycle } from '../session-shutdown';
import { loadSkillsFromConfig } from '../skills-loader';
import { VERSION } from '../version';

export interface RunOptions extends ModOptions {
  prompt: string;
  json?: boolean;
  model?: string;
  modelSettings?: string;
  maxSteps?: number;
  cwd: string;
  autoApprove?: 'none' | 'sandbox' | 'host' | 'all';
  session?: string;
  sessionName?: string;
  sessionId?: string;
  sessionExists?: SessionExistsPolicy;
  home?: string;
  /** Name of a user command template to expand into the prompt. */
  command?: string;
  /** Raw args string for the command template. */
  commandArgs?: string;
  /** If false, skip `.claude/commands/` and `.claude/skills/` discovery. */
  claudeCompat?: boolean;
  /** If false, skip skill discovery + system-prompt injection entirely. */
  skills?: boolean;
  /** If false, skip mode discovery (from `--no-modes`). */
  modes?: boolean;
  /** Initial mode for the session. Falls back to config.defaultMode then "build". */
  mode?: string;
  /**
   * A completion condition for the session (`--goal`). A checker model
   * examines it at each clean stop, and the exit code says how it ended.
   */
  goal?: string;
  /** Test hook: bypass provider loading and supply a pre-built factory. */
  factoryOverride?: AgentFactory;
  /** Test hook: override model config when `factoryOverride` is supplied. */
  modelOverride?: ModelConfig;
  /** Raw sandbox flags from commander. */
  sandboxFlags?: Omit<ParseSandboxFlagsInput, 'cliVersion'>;
  /** Default true; commander populates `false` when `--no-subagents` is passed. */
  subagents?: boolean;
  maxSubagentDepth?: number;
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
}

export interface RunResult {
  exitCode: number;
}

export async function runOneShot(opts: RunOptions): Promise<RunResult> {
  const secret = readServerSecret();
  const sandboxOpts = opts.sandboxFlags
    ? parseSandboxFlags({ ...opts.sandboxFlags, cliVersion: VERSION })
    : null;
  const sandboxMode: SandboxMode = sandboxOpts?.enabled ? sandboxOpts.mode : 'off';

  let model: ModelConfig;
  let factory: AgentFactory;
  let cliFactory: CliAgentFactory | undefined;
  const config = opts.factoryOverride && opts.modelOverride ? {} : loadConfig(opts.home);
  const modRuntime = await ModRuntime.create(opts);
  // Resolved before anything else is set up, so a bad --mcp-config stops the
  // command at once instead of after a model has been chosen.
  const mcpServers = resolveMcpServers(config, opts.mcpConfig);
  const skills = loadSkillsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    skillsDisabled: opts.skills === false,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });
  const modes = loadModesFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    modesDisabled: opts.modes === false,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });
  const initialMode = opts.mode ?? config.defaultMode ?? 'build';
  const agents = loadAgentsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });
  if (opts.factoryOverride && opts.modelOverride) {
    model = opts.modelOverride;
    factory = opts.factoryOverride;
  } else {
    const resolved = resolveModel({
      cliModel: opts.model,
      cliSettings: opts.modelSettings,
      maxSteps: opts.maxSteps,
      config,
    });
    model = resolved.model;

    const compactionConfig = resolveCompactionConfig({ cliOverride: opts.compaction, config });
    const resolvedWindow = resolveContextWindow({
      providerShape: resolved.providersConfig.providers[model.providerId]?.shape ?? 'openai',
      providerId: model.providerId,
      modelId: model.modelId,
      override: config.models?.[`${model.providerId}/${model.modelId}`]?.contextWindow,
    });
    const invariant = checkCompactionInvariant(compactionConfig, resolvedWindow.value);
    if (!invariant.ok) {
      process.stderr.write(`${invariant.error}\n`);
      return { exitCode: 1 };
    }

    let compactor: Compactor | undefined;
    if (compactionConfig.enabled) {
      const registry = loadProviders(resolved.providersConfig);
      compactor = new Compactor({
        config: compactionConfig,
        contextWindow: resolvedWindow.value,
        imageLongEdge: config.models?.[`${model.providerId}/${model.modelId}`]?.imageLongEdge,
        resolveModel: async (ref, sessionId) => {
          const target = registry.resolve(ref);
          return target.provider.getModel(target.modelId, sessionId);
        },
        resolveCallOptions: compactionCallOptions(config, registry),
        home: opts.home,
        createPruner: recallPrunerFactory(config, opts.home),
      });
    }

    cliFactory = new CliAgentFactory({
      mods: modRuntime.host,
          providersConfig: resolved.providersConfig,
      autoApprove: opts.autoApprove ?? 'host',
      hostBashPolicy: resolveHostBashPolicy(config, opts.home),
      mcpServers,
      mcpHeadlessAutoDeny: true,
      home: opts.home,
      skills,
      agents,
      modes,
      initialMode,
      sandbox: sandboxOpts ?? undefined,
      subagents: {
        enabled: opts.subagents !== false,
        maxDepth: opts.maxSubagentDepth,
        // The process ends with the run, so it cannot wait for a child.
        background: false,
      },
      models: config.models,
      defaultVisionModel: config.defaultVisionModel,
      fallbackModel: config.fallbackModel,
      utilityModel: config.utilityModel,
      approvalReviewer: approvalReviewerEnabled(config),
      systemOne: resolveSystemOne(config),
      goal: { maxContinuations: goalMaxContinuations(config) },
      memory: config.memory,
      compaction: compactionConfig,
      compactor,
      responseTimeoutMs: config.responseTimeoutMs,
      diagnostics: config.diagnostics,
      webSearch: config.webSearch,
      recall: config.recall,
    });
    factory = cliFactory;
  }

  // Load the commands registry for both server introspection and client-side
  // expansion (when `--command` is used).
  const commands = loadCommandsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });

  let effectivePrompt = opts.prompt;
  if (opts.command) {
    const cmd = commands.find(opts.command);
    if (!cmd) {
      process.stderr.write(`unknown command: ${opts.command}\n`);
      return { exitCode: 1 };
    }
    effectivePrompt = commands.expand(opts.command, opts.commandArgs ?? '', {
      cwd: opts.cwd,
    });
  }

  const modelsList: ModelListEntry[] = Object.entries(config.models ?? {})
    .map(([ref, opts]) => ({
      ref,
      contextWindow: opts.contextWindow,
      maxOutputTokens: opts.maxOutputTokens,
      vision: opts.vision,
      isDefault: ref === config.defaultModel,
    }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.ref.localeCompare(b.ref);
    });

  const registry = new AgentRegistry({
    factory,
    instance: { pid: process.pid, cwd: opts.cwd, version: VERSION, sandboxMode },
    loadCommands: () => commands.list(),
    loadSkills: () => skills.all(),
    loadModes: () => modes.all(),
    loadModels: () => (cliFactory ? cliFactory.listModels() : modelsList),
    home: opts.home,
    workspaceCheckpoints: config.workspaceCheckpoints !== false,
  });
  const app = buildApp({ registry, home: opts.home, secret });
  const server = await startServer({ app, secret });
  modRuntime.bind(registry, server.url);

  const client = new ChimeraClient({ baseUrl: server.url });
  let closing: Promise<void> | undefined;
  const shutdown = (reason: ShutdownReason) => {
    closing ??= (async () => {
      await shutdownLifecycle(registry, modRuntime, reason);
      if (cliFactory) await cliFactory.dispose();
      await server.close();
    })();
    return closing;
  };
  const stopSignals = onShutdownSignals(async (reason) => {
    await shutdown(reason);
    process.exit(reason === 'exit' ? 130 : 0);
  });
  let sessionId: string | undefined;
  try {
    const sessionResult = await launchSession(
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
    sessionId = sessionResult.sessionId;

    if (opts.goal) await client.setGoal(sessionId, opts.goal);

    let finalText = '';
    let exitReason: RunFinishedReason = 'stop';
    let errorMessage: string | undefined;
    let goalChange: GoalChange | undefined;

    const activeSessionId = sessionId;
    const rows = new RunRows({
      write: (text) => process.stderr.write(text),
      color: process.stderr.isTTY === true,
      width:
        process.stderr.isTTY && process.stderr.columns > 0 ? process.stderr.columns : undefined,
      sandboxActive: sandboxMode !== 'off',
    });
    for await (const ev of client.send(activeSessionId, effectivePrompt)) {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(ev)}\n`);
      } else if (ev.type === 'assistant_text_delta') {
        process.stdout.write(ev.delta);
      } else if (ev.type === 'assistant_text_done') {
        finalText = ev.text;
      } else {
        rows.apply(ev);
      }
      if (ev.type === 'goal_updated') goalChange = ev.change;
      if (ev.type === 'run_finished') {
        exitReason = ev.reason;
        errorMessage = ev.error;
      }
    }

    if (!opts.json) {
      rows.finish();
      if (finalText && !finalText.endsWith('\n')) process.stdout.write('\n');
      if (errorMessage) process.stderr.write(`${errorMessage}\n`);
    }

    if (sandboxOpts?.enabled && cliFactory) {
      const docker = cliFactory.getSandbox(activeSessionId);
      if (docker && docker.mode() === 'overlay') {
        try {
          await finalizeOverlay({
            sessionId: activeSessionId,
            cwd: opts.cwd,
            exitReason,
            applyOnSuccess: sandboxOpts.applyOnSuccess,
          });
        } catch (err) {
          process.stderr.write(`overlay finalization failed: ${(err as Error).message}\n`);
        }
      }
    }

    return { exitCode: exitCodeFor(exitReason, opts.goal ? goalChange : undefined) };
  } finally {
    await shutdown('exit');
    stopSignals();
  }
}

export interface FinalizeOverlayInput {
  sessionId: string;
  cwd: string;
  exitReason: RunFinishedReason;
  applyOnSuccess: boolean;
}

/**
 * Apply the upperdir to the host iff the run finished cleanly and the user
 * asked for it; in every other case, discard. Exposed for direct testing —
 * the inline call site in `runOneShot` is unreachable under `factoryOverride`.
 */
export async function finalizeOverlay(input: FinalizeOverlayInput): Promise<void> {
  if (input.applyOnSuccess && input.exitReason === 'stop') {
    await applyOverlay(input.sessionId, input.cwd);
  }
  await discardOverlay(input.sessionId);
}

/**
 * The exit code of a run. `goalChange` is the last word on the run's goal,
 * for a run that was given one.
 */
function exitCodeFor(reason: RunFinishedReason, goalChange?: GoalChange): number {
  if (reason === 'stop' && goalChange === 'impossible') return 3;
  // The run ended cleanly, but nothing says that the goal is met.
  if (reason === 'stop' && goalChange === 'unchecked') return 1;
  if (reason === 'stop' || reason === 'waiting_for_input') return 0;
  if (reason === 'max_steps' || reason === 'output_limit') return 2;
  if (reason === 'interrupted') return 130;
  return 1;
}
