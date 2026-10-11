import { ChimeraClient } from '@chimera/client';
import { Compactor } from '@chimera/compaction';
import type {
  AgentEvent,
  GoalChange,
  ModelConfig,
  RunFinishedReason,
  SandboxMode,
} from '@chimera/core';
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
} from '../config';
import { CliAgentFactory } from '../factory';
import { launchSession, type SessionExistsPolicy } from '../launch-session';
import { loadModesFromConfig } from '../modes-loader';
import { CHIMERA_CLI_VERSION } from '../program';
import { type ParseSandboxFlagsInput, parseSandboxFlags } from '../sandbox-config';
import { loadSkillsFromConfig } from '../skills-loader';

export interface RunOptions {
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
  const sandboxOpts = opts.sandboxFlags
    ? parseSandboxFlags({ ...opts.sandboxFlags, cliVersion: CHIMERA_CLI_VERSION })
    : null;
  const sandboxMode: SandboxMode = sandboxOpts?.enabled ? sandboxOpts.mode : 'off';

  let model: ModelConfig;
  let factory: AgentFactory;
  let cliFactory: CliAgentFactory | undefined;
  const config = opts.factoryOverride && opts.modelOverride ? {} : loadConfig(opts.home);
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
    instance: { pid: process.pid, cwd: opts.cwd, version: '0.1.0', sandboxMode },
    loadCommands: () => commands.list(),
    loadSkills: () => skills.all(),
    loadModes: () => modes.all(),
    loadModels: () => (cliFactory ? cliFactory.listModels() : modelsList),
    home: opts.home,
    workspaceCheckpoints: config.workspaceCheckpoints !== false,
  });
  const app = buildApp({ registry, home: opts.home });
  const server = await startServer({ app });

  const client = new ChimeraClient({ baseUrl: server.url });
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
    const sigintHandler = () => {
      void client.interrupt(activeSessionId);
    };
    process.once('SIGINT', sigintHandler);

    for await (const ev of client.send(activeSessionId, effectivePrompt)) {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(ev)}\n`);
      } else if (ev.type === 'assistant_text_delta') {
        process.stdout.write(ev.delta);
      } else if (ev.type === 'assistant_text_done') {
        finalText = ev.text;
      } else if (ev.type === 'tool_call_start') {
        process.stderr.write(`[tool] ${ev.name} ${formatArgsShort(ev.args)}\n`);
      } else if (ev.type === 'tool_call_error') {
        process.stderr.write(`[tool error] ${ev.error}\n`);
      } else if (ev.type === 'user_input_required') {
        process.stderr.write(`[waiting for input] ${ev.request}\n`);
      }
      if (ev.type === 'goal_updated') {
        goalChange = ev.change;
        if (!opts.json) process.stderr.write(`${goalLine(ev)}\n`);
      }
      if (ev.type === 'run_finished') {
        exitReason = ev.reason;
        errorMessage = ev.error;
      }
    }

    process.removeListener('SIGINT', sigintHandler);

    if (!opts.json) {
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
    // Best-effort delete the session so SessionEnd hooks fire.
    if (sessionId) await client.deleteSession(sessionId).catch(() => {});
    if (cliFactory) {
      await cliFactory.dispose();
    }
    await server.close();
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

/** What a `goal_updated` event says, as one line for the terminal. */
function goalLine(event: Extract<AgentEvent, { type: 'goal_updated' }>): string {
  const why = event.reason ? `: ${event.reason}` : '';
  if (event.change === 'set') return `[goal] ${event.condition}`;
  if (event.change === 'not_met') {
    return `[goal] not met (${event.continuation} of ${event.maxContinuations})${why}`;
  }
  if (event.change === 'limit') {
    return `[goal] limit of ${event.maxContinuations} continuations reached${why}`;
  }
  if (event.change === 'impossible') return `[goal] not possible${why}`;
  if (event.change === 'unchecked') return `[goal] not checked${why}`;
  return `[goal] ${event.change}${why}`;
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

function formatArgsShort(args: unknown): string {
  const raw = JSON.stringify(args);
  return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
}
