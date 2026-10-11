import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Compactor } from '@chimera/compaction';
import type {
  CompactionConfig,
  Executor,
  HostAuthenticationCapability,
  ModelCapabilities,
  ModelConfig,
  ModelProfile,
  ModelSettings,
  SessionId,
  VisionModelResolution,
} from '@chimera/core';
import {
  Agent,
  composeSystemPrompt,
  type InterruptHook,
  loadSession,
  newSessionId,
  renderToolsSection,
  type StopHook,
  type TimeoutHook,
  type UserInputRequiredHook,
  validateModelSettings,
  writeSessionMetadata,
} from '@chimera/core';
import { DefaultHookRunner, type HookRunner } from '@chimera/hooks';
import {
  applyAllowlist,
  computeAllowlist,
  DEFAULT_MODE_NAME,
  expandAllowlist,
  type Mode,
  type ModeRegistry,
} from '@chimera/modes';
import {
  type AutoApproveLevel,
  BalancedPolicyEvaluator,
  CommandPolicyPipeline,
  commandRequiresSudo,
  DefaultPermissionGate,
  GatedExecutor,
  PathAuthorizationStage,
  PermissionDecisionAudit,
  PiSafeShellAdapter,
  RiskStage,
  ScaryCommandStage,
  ShellEffectsStage,
  SudoApprovalStage,
} from '@chimera/permissions';
import {
  buildKeyResolver,
  loadProviders,
  localCapabilities,
  type ProvidersConfig,
  resolveContextWindow,
  resolveModelProfile,
  resolveModelSettings,
} from '@chimera/providers';
import { RecallStore } from '@chimera/recall';
import { DockerExecutor, sandboxDockerDir } from '@chimera/sandbox';
import type { AgentFactory, BuildResult, SessionInit } from '@chimera/server';
import { buildSkillActivationLookup, type SkillRegistry } from '@chimera/skills';
import { type AgentRegistry, buildSpawnAgentTool } from '@chimera/subagents';
import {
  BackgroundProcessManager,
  buildDiagnosticsRunner,
  buildTools,
  createWebSearchProvider,
  type DiagnosticsConfig,
  type FormatScrollback,
  interceptTools,
  LocalExecutor,
  outputBudget,
  repeatNote,
  TaskListStore,
  type ToolCallInterceptor,
  type WebSearchProvider,
} from '@chimera/tools';
import type { ToolSet } from 'ai';
import type {
  HostBashPolicyConfig,
  McpServerConfig,
  ModelOptions,
  WebSearchConfig,
} from './config';
import { McpAuth } from './mcp/auth';
import { McpClientManager } from './mcp/client';
import { registerMcpTools } from './mcp/tools';
import type { CliSandboxOptions } from './sandbox-config';

export interface CliAgentFactoryOptions {
  providersConfig: ProvidersConfig;
  autoApprove: AutoApproveLevel;
  hostBashPolicy?: HostBashPolicyConfig;
  mcpServers?: Record<string, McpServerConfig>;
  mcpHeadlessAutoDeny?: boolean;
  warn?: (msg: string) => void;
  home?: string;
  /**
   * Per-model overrides keyed by `<providerId>/<modelId>`. Honored fields:
   * `contextWindow` (token-budget UI) and `maxOutputTokens` (per-step output
   * cap forwarded to the AI SDK).
   */
  models?: Record<string, ModelOptions>;
  /**
   * Optional skill registry. When present, the factory wires its index into
   * the system prompt and registers activation detection on the Agent.
   */
  skills?: SkillRegistry;
  /**
   * Optional mode registry. When present, the factory resolves the initial
   * mode (CLI flag → config.defaultMode → "build"), composes the system
   * prompt with that mode block, filters tools per its allowlist, and
   * registers a resolver on the Agent so mid-session `setMode` can
   * recompose without going through the factory again.
   */
  modes?: ModeRegistry;
  /**
   * Initial mode for new sessions. Falls back to `config.defaultMode` then
   * `DEFAULT_MODE_NAME` ("build"). Only relevant when `modes` is set.
   */
  initialMode?: string;
  /** When set, sandbox-target tools route through a DockerExecutor. */
  sandbox?: CliSandboxOptions;
  /**
   * Optional agent-definition registry. When present, `spawn_agent` resolves
   * its `agent` arg against this registry and surfaces available agents in
   * the tool description.
   */
  agents?: AgentRegistry;
  /**
   * When set, fully replaces the composed system prompt for sessions built
   * by this factory. Used by child subagent processes to inherit a system
   * prompt from an agent definition file.
   */
  systemPromptOverride?: string;
  /**
   * When set, restricts the registered tool set to this allowlist (intersected
   * with any active mode allowlist). Used by child subagent processes to
   * inherit `tools:` from an agent definition file.
   */
  toolsAllowlist?: string[];
  /** Subagent configuration. When omitted, `spawn_agent` is registered with defaults. */
  subagents?: {
    /** When false, the `spawn_agent` tool is NOT registered. Default true. */
    enabled?: boolean;
    /** Default 3. */
    maxDepth?: number;
    /** Default 0. Children pass their incremented depth via CLI flag. */
    currentDepth?: number;
    /** When true (auto-set in headless parent runs), child gates auto-deny prompts. */
    headlessAutoDeny?: boolean;
    /** Path to the chimera executable used to spawn child processes. */
    chimeraBin?: string;
    /** Default model ref to forward to children. */
    defaultModelRef?: string;
    /** Whether the parent process has a TTY. Defaults to `process.stdin.isTTY`. */
    parentHasTty?: boolean;
  };
  /** Compaction config and optional concrete compactor wired into every Agent built by this factory. */
  compaction?: CompactionConfig;
  /**
   * Optional compactor instance. When both `compaction` and this are set, the
   * factory threads them into the Agent's constructor.
   */
  compactor?: Compactor;
  /**
   * Idle timeout for a model step (ms): how long the model may produce no
   * stream output. Tool execution time does not count. A value of `0`
   * disables the timeout. Defaults to 120000.
   */
  responseTimeoutMs?: number;
  /** Post-edit diagnostics feedback config (auto-detection on by default). */
  diagnostics?: DiagnosticsConfig;
  /** Search backend for the web_search tool. Omitted = tool not registered. */
  webSearch?: WebSearchConfig;
  /** Archived-output recall store config. enabled defaults to true. */
  recall?: { enabled?: boolean; archiveThresholdTokens?: number; ttlDays?: number };
  /**
   * Model ref image turns route to when the active model is not
   * vision-capable. Resolved lazily per engagement, so a broken value only
   * surfaces (as an actionable error) when images actually appear.
   */
  defaultVisionModel?: string;
  /**
   * Model (`<providerId>/<modelId>`) a run moves to when its model stays
   * unavailable after every retry.
   */
  fallbackModel?: string;
  /** Present only for the owner-local interactive TUI. */
  hostAuthentication?: HostAuthenticationCapability;
}

export class CliAgentFactory implements AgentFactory {
  private readonly registry: ReturnType<typeof loadProviders>;
  private readonly autoApprove: AutoApproveLevel;
  private readonly hostBashPolicy: HostBashPolicyConfig;
  private readonly home: string | undefined;
  private readonly skills: SkillRegistry | undefined;
  private readonly agents: AgentRegistry | undefined;
  private readonly systemPromptOverride: string | undefined;
  private readonly toolsAllowlist: string[] | undefined;
  private readonly modes: ModeRegistry | undefined;
  private readonly initialMode: string | undefined;
  private readonly sandbox: CliSandboxOptions | undefined;
  private readonly subagents: NonNullable<CliAgentFactoryOptions['subagents']>;
  private readonly warn: (msg: string) => void;
  private readonly providersConfig: ProvidersConfig;
  private readonly modelsConfig: Record<string, ModelOptions>;
  private readonly liveSandboxes = new Map<SessionId, DockerExecutor>();
  private readonly liveExecutors = new Map<SessionId, LocalExecutor>();
  private readonly liveAgents = new Map<SessionId, Agent>();
  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly mcpHeadlessAutoDeny: boolean;
  private readonly liveMcpClients = new Map<SessionId, McpClientManager>();
  private readonly liveBackgroundManagers = new Map<SessionId, BackgroundProcessManager>();
  private readonly compaction: CompactionConfig | undefined;
  private readonly diagnosticsConfig: DiagnosticsConfig | undefined;
  private readonly webSearchProvider: WebSearchProvider | undefined;
  private readonly recallConfig: CliAgentFactoryOptions['recall'];
  private readonly liveRecallStores = new Map<SessionId, RecallStore>();
  private readonly compactor: Compactor | undefined;
  private readonly responseTimeoutMs: number | undefined;
  private readonly defaultVisionModel: string | undefined;
  private readonly fallbackModel: string | undefined;
  private readonly hostAuthentication: HostAuthenticationCapability | undefined;
  /**
   * Snapshot of the formatter map produced by the most recent `build()` call.
   * The TUI consumes this via `getFormatters()` so its scrollback can render
   * tool entries during session rehydration without reaching across the dep
   * DAG into `@chimera/tools`. Captured *after* `spawn_agent`'s formatter is
   * conditionally added — that hook is appended outside `buildTools()`.
   */
  private lastFormatters: Record<string, FormatScrollback<any, any>> = {};

  constructor(opts: CliAgentFactoryOptions) {
    this.registry = loadProviders(opts.providersConfig, { warn: opts.warn });
    this.autoApprove = opts.autoApprove;
    this.hostBashPolicy = opts.hostBashPolicy ?? {
      enabled: true,
      mode: 'balanced',
      autoAllowThrough: 'caution',
    };
    this.home = opts.home;
    this.skills = opts.skills;
    this.agents = opts.agents;
    this.systemPromptOverride = opts.systemPromptOverride;
    this.toolsAllowlist = opts.toolsAllowlist;
    this.modes = opts.modes;
    this.initialMode = opts.initialMode;
    this.sandbox = opts.sandbox;
    this.subagents = opts.subagents ?? {};
    this.warn = opts.warn ?? ((m) => process.stderr.write(`${m}\n`));
    this.providersConfig = opts.providersConfig;
    this.mcpServers = opts.mcpServers ?? {};
    this.mcpHeadlessAutoDeny = opts.mcpHeadlessAutoDeny ?? false;
    this.modelsConfig = opts.models ?? {};
    this.compaction = opts.compaction;
    this.compactor = opts.compactor;
    this.responseTimeoutMs = opts.responseTimeoutMs;
    this.defaultVisionModel = opts.defaultVisionModel;
    this.fallbackModel = opts.fallbackModel;
    this.hostAuthentication = opts.hostAuthentication;
    this.diagnosticsConfig = opts.diagnostics;
    this.recallConfig = opts.recall;
    this.webSearchProvider = opts.webSearch
      ? opts.webSearch.provider === 'searxng'
        ? createWebSearchProvider(opts.webSearch)
        : createWebSearchProvider({
            provider: opts.webSearch.provider,
            getApiKey: buildKeyResolver(opts.webSearch.apiKey, {
              providerId: `webSearch/${opts.webSearch.provider}`,
              warn: this.warn,
            }),
          })
      : undefined;
  }

  /**
   * Returns the formatter map captured during the most recent `build()` call.
   * Empty until `build()` runs at least once — the interactive command reads
   * this after `client.createSession()` resolves, so by mount time the map is
   * populated.
   */
  getFormatters(): Record<string, FormatScrollback<any, any>> {
    return this.lastFormatters;
  }

  async build(init: SessionInit): Promise<BuildResult> {
    const session = init.sessionId ? await tryLoadSession(init.sessionId, this.home) : undefined;
    if (session) init = { ...init, model: session.model };
    const sessionModelRef =
      session?.initialModelRef ?? `${init.model.providerId}/${init.model.modelId}`;
    const modelInputOverrides = session?.modelInputOverrides ?? {
      [`${init.model.providerId}/${init.model.modelId}`]: {
        vision: init.model.vision,
        imageLongEdge: init.model.imageLongEdge,
      },
    };
    const modelSettingsOverrides = session?.modelSettingsOverrides ?? {
      [`${init.model.providerId}/${init.model.modelId}`]: init.model.settings ?? {},
    };
    const creationSource = init.model.settingsDefaults ?? init.model;
    const modelCreationDefaults = session?.modelCreationDefaults ?? {
      [`${init.model.providerId}/${init.model.modelId}`]: Object.fromEntries(
        Object.entries({
          maxOutputTokens: creationSource.maxOutputTokens,
          parallelToolCalls: creationSource.parallelToolCalls,
          temperature: creationSource.temperature,
          topP: creationSource.topP,
        }).filter(([, value]) => value !== undefined),
      ),
    };
    // Profile fields the caller set on the model it asked for. They win over
    // config for that model only; any other model resolves from config.
    const explicitProfileByRef: Record<string, Partial<ModelProfile>> = {
      [`${init.model.providerId}/${init.model.modelId}`]: definedFields({
        toolCallShape: init.model.toolCallShape,
        editFormat: init.model.editFormat,
        promptStyle: init.model.promptStyle,
      }),
    };
    const profileFor = (profileRef: string, profileModelId: string, contextWindow: number) =>
      resolveModelProfile({
        modelId: profileModelId,
        contextWindow,
        options: { ...this.modelsConfig[profileRef], ...explicitProfileByRef[profileRef] },
      });
    const startupMode = this.modes?.find(session?.mode ?? this.initialMode ?? DEFAULT_MODE_NAME);
    if (!session && startupMode?.model && startupMode.model !== sessionModelRef) {
      const target = this.registry.resolve(startupMode.model);
      init = {
        ...init,
        model: {
          providerId: target.provider.id,
          modelId: target.modelId,
          maxSteps: init.model.maxSteps,
          vision: this.modelsConfig[startupMode.model]?.vision,
          imageLongEdge: this.modelsConfig[startupMode.model]?.imageLongEdge,
        },
      };
    }
    const ref = `${init.model.providerId}/${init.model.modelId}`;
    const { provider, modelId } = this.registry.resolve(ref);
    await this.getModelCapabilities(ref);
    for (const target of [
      this.defaultVisionModel,
      ...(this.modes?.all().map((mode) => mode.model) ?? []),
    ]) {
      if (target) await this.getModelCapabilities(target).catch(() => undefined);
    }
    const initialOverrides = modelSettingsOverrides[ref] ?? {};
    const initialGeneration = this.resolveGeneration(
      ref,
      initialOverrides,
      modelCreationDefaults[ref],
    );
    init = {
      ...init,
      model: {
        ...init.model,
        ...initialGeneration.modelFields,
        ...this.resolveModelInput(ref, modelInputOverrides[ref]),
      },
    };
    if (session) session.model = init.model;
    const sessionId = session?.id ?? init.requestedSessionId ?? newSessionId();
    const languageModel = provider.getModel(modelId, sessionId);

    const providerSpec = this.providersConfig.providers[init.model.providerId];
    const providerShape = providerSpec?.shape ?? provider.shape;
    const resolvedWindow = resolveContextWindow({
      providerShape,
      providerId: init.model.providerId,
      modelId,
      override: this.modelsConfig[ref]?.contextWindow,
      warn: this.warn,
    });

    const initialProfile = profileFor(ref, modelId, resolvedWindow.value);
    init = {
      ...init,
      model: {
        ...init.model,
        toolCallShape: initialProfile.toolCallShape,
        editFormat: initialProfile.editFormat,
        promptStyle: initialProfile.promptStyle,
        outputBudgetTokens: initialProfile.outputBudgetTokens,
      },
    };
    if (session) session.model = init.model;

    const skillsReg = this.skills;
    const extensions = skillsReg ? [() => skillsReg.buildIndex() || null] : undefined;
    const skillActivation = skillsReg ? buildSkillActivationLookup(skillsReg, init.cwd) : undefined;

    // Skills often live outside cwd (e.g. `~/.claude/skills/tdd/`). Allow
    // read access to each resolved skill's directory so the model can
    // read the SKILL.md itself and any peer scripts bundled with it.
    const skillDirs = skillsReg ? skillsReg.all().map((s) => dirname(s.path)) : [];
    const tmpDir = tmpdir();
    const userHome = this.home ?? homedir();
    // Merge persisted paths (on resume) with any newly-supplied CLI paths.
    const sessionReadPaths = session?.additionalReadPaths ?? [];
    const sessionWritePaths = session?.additionalWritePaths ?? [];
    const readAllowDirs = [
      ...skillDirs,
      tmpDir,
      join(userHome, '.claude'),
      join(userHome, '.agents'),
      ...sessionReadPaths,
      ...sessionWritePaths,
      ...(init.additionalReadPaths ?? []),
      ...(init.additionalWritePaths ?? []),
    ];
    const local = new LocalExecutor({
      cwd: init.cwd,
      readAllowDirs,
      writeAllowDirs: [tmpDir, ...sessionWritePaths, ...(init.additionalWritePaths ?? [])],
    });
    this.liveExecutors.set(sessionId, local);

    const modesReg = this.modes;
    const requestedMode = session?.mode ?? this.initialMode ?? DEFAULT_MODE_NAME;
    const initialModeObj = modesReg ? modesReg.find(requestedMode) : undefined;
    if (modesReg && !initialModeObj && requestedMode !== DEFAULT_MODE_NAME) {
      this.warn(
        `mode "${requestedMode}" not found in registry; falling back to "${DEFAULT_MODE_NAME}"`,
      );
    }
    const activeMode: Mode | undefined =
      initialModeObj ?? (modesReg ? modesReg.find(DEFAULT_MODE_NAME) : undefined);

    const hookRunner: HookRunner = new DefaultHookRunner({
      cwd: init.cwd,
      sessionId,
    });

    const stopHook: StopHook = {
      async fire(payload) {
        const result = await hookRunner.fire({ event: 'Stop', reason: payload.reason });
        return {
          blocked: result.blocked,
          reason: result.reason,
          additionalContext: result.parsedDecision?.additionalContext,
        };
      },
    };

    const timeoutHook: TimeoutHook = {
      async fire() {
        await hookRunner.fire({ event: 'Timeout' });
      },
    };
    const interruptHook: InterruptHook = {
      async fire() {
        await hookRunner.fire({ event: 'Interrupt' });
      },
    };
    const userInputRequiredHook: UserInputRequiredHook = {
      async fire(request) {
        await hookRunner.fire({ event: 'UserInputRequired', ...request });
      },
    };
    const permissionResolvedHook = {
      async fire(resolution: {
        requestId: string;
        decision: 'allow' | 'deny';
        remembered: boolean;
        sessionStatus: 'running' | 'waiting_for_permission';
        remainingPending: number;
      }) {
        await hookRunner.fire({
          event: 'PermissionResolved',
          request_id: resolution.requestId,
          decision: resolution.decision,
          remembered: resolution.remembered,
          session_status: resolution.sessionStatus,
          remaining_pending: resolution.remainingPending,
        });
      },
    };

    const agent = new Agent({
      cwd: init.cwd,
      model: init.model,
      languageModel,
      // Tools and system prompt are set below, once the gate exists and the
      // model profile has picked the tool surface.
      tools: {} as never,
      sandboxMode: init.sandboxMode,
      session,
      sessionId,
      sessionName: init.name,
      home: this.home,
      skillActivation,
      contextWindow: resolvedWindow.value,
      contextWindowIsApproximate: resolvedWindow.source === 'fallback',
      initialMode: activeMode?.name ?? requestedMode,
      compaction: this.compaction,
      compactor: this.compactor,
      stopHook,
      timeoutHook,
      interruptHook,
      userInputRequiredHook,
      permissionResolvedHook,
      responseTimeoutMs: this.responseTimeoutMs,
      providerOptions: initialGeneration.providerOptions,
    });
    agent.session.modelSettingsOverrides = modelSettingsOverrides;
    agent.session.modelCreationDefaults = modelCreationDefaults;
    agent.session.modelInputOverrides = modelInputOverrides;
    agent.session.initialModelRef ??= sessionModelRef;

    // Propagate CLI-supplied additional paths onto the session so they are
    // persisted (and inherited on fork). When loading from disk the values
    // already come from the persisted record; only overwrite for fresh sessions.
    if (!session) {
      agent.session.additionalReadPaths = init.additionalReadPaths ?? [];
      agent.session.additionalWritePaths = init.additionalWritePaths ?? [];
    }

    // Persist metadata immediately so the session appears in disk-scanned
    // listings before any model run produces a step_finished snapshot.
    try {
      await writeSessionMetadata(agent.session, this.home);
    } catch {
      // best-effort
    }

    const commandPolicy = this.hostBashPolicy.enabled
      ? (() => {
          const shellAdapter = new PiSafeShellAdapter();
          const strictPolicy = new CommandPolicyPipeline([
            new SudoApprovalStage(),
            new ScaryCommandStage(),
            new ShellEffectsStage(shellAdapter),
            new PathAuthorizationStage(),
            new RiskStage(shellAdapter, this.hostBashPolicy.autoAllowThrough),
          ]);
          return this.hostBashPolicy.mode === 'balanced'
            ? new BalancedPolicyEvaluator(strictPolicy)
            : strictPolicy;
        })()
      : new CommandPolicyPipeline([new SudoApprovalStage()]);
    if (!this.hostBashPolicy.enabled) {
      this.warn(
        'chimera: host bash advisory policy is disabled; mandatory sudo approval remains enabled',
      );
    }
    const decisionAudit = new PermissionDecisionAudit({
      home: this.home,
      sessionId: agent.session.id,
      mode: this.hostBashPolicy.enabled ? this.hostBashPolicy.mode : 'disabled',
      onWarning: this.warn,
    });
    const gate = new DefaultPermissionGate({
      cwd: init.cwd,
      home: this.home,
      audit: (entry) => decisionAudit.record(entry),
      autoApprove: this.autoApprove,
      ...(commandPolicy
        ? {
            commandPolicy: {
              evaluator: commandPolicy,
              context: (request: { command: string; cwd: string }) => ({
                command: request.command,
                target: 'host' as const,
                cwd: request.cwd,
                home: this.home ?? homedir(),
                projectRoot: init.cwd,
                roots: local.commandPolicyRoots(),
              }),
            },
          }
        : {}),
      raiseRequest: (req) => agent.raisePermissionRequest(req),
      headlessAutoDeny: this.subagents.headlessAutoDeny,
      mcpHeadlessAutoDeny: this.mcpHeadlessAutoDeny,
      hookRunner,
      emitResolved: (requestId, decision, remembered) =>
        agent.emitPermissionResolved(requestId, decision, remembered),
    });

    // Wire remember handler so resolvePermission's `remember` arg persists a rule.
    agent.setRememberHandler((_requestId, scope, req) => {
      gate.applyRemember(scope, req, 'allow');
    });

    const hostExecutor = new GatedExecutor({ inner: local, gate });

    let sandboxExecutor: Executor = local;
    if (this.sandbox?.enabled && init.sandboxMode !== 'off') {
      const docker = new DockerExecutor({
        image: this.sandbox.image,
        mode: this.sandbox.mode,
        sessionId: agent.session.id,
        hostCwd: init.cwd,
        strict: this.sandbox.strict,
        network: this.sandbox.network,
        memory: this.sandbox.memory,
        cpus: this.sandbox.cpus,
        warn: this.warn,
        // Auto-build only when the user is using the bundled image. A typo
        // in `--sandbox-image` should error loudly, not trigger a build.
        dockerfileDir: this.sandbox.imageIsDefault ? sandboxDockerDir() : undefined,
      });
      await docker.start();
      this.liveSandboxes.set(agent.session.id, docker);
      sandboxExecutor = docker;
    }

    const backgroundProcesses = new BackgroundProcessManager({
      cwd: init.cwd,
      onExit: (notice) =>
        agent.pushEvent({
          type: 'background_process_exited',
          shellId: notice.shellId,
          command: notice.command,
          status: notice.status === 'killed' ? 'killed' : 'exited',
          exitCode: notice.exitCode,
        }),
    });
    this.liveBackgroundManagers.set(agent.session.id, backgroundProcesses);

    const diagnostics = await buildDiagnosticsRunner({
      cwd: init.cwd,
      executor: sandboxExecutor,
      config: this.diagnosticsConfig,
    });

    let recallStore: RecallStore | undefined;
    if (this.recallConfig?.enabled !== false) {
      recallStore = new RecallStore({
        sessionId: agent.session.id,
        home: this.home,
        ttlDays: this.recallConfig?.ttlDays,
      });
      this.liveRecallStores.set(agent.session.id, recallStore);
    }

    const taskList = new TaskListStore({
      initial: agent.session.tasks,
      onUpdate: (tasks) => {
        agent.session.tasks = tasks;
        agent.pushEvent({ type: 'task_list_updated', tasks });
        void writeSessionMetadata(agent.session, this.home).catch((err) => {
          this.warn(`task list persistence failed: ${(err as Error).message}`);
        });
      },
    });

    // Tools registered outside @chimera/tools. They do not depend on the
    // model profile, so they are built once and merged into every surface.
    const extraTools: ToolSet = {};
    const extraFormatters: Record<string, FormatScrollback<any, any>> = {};
    const extraSnippets: Record<string, string> = {};

    if (this.subagents.enabled !== false) {
      const invocation = resolveChimeraInvocation();
      const defaultModelRef =
        this.subagents.defaultModelRef ?? `${init.model.providerId}/${init.model.modelId}`;
      const advertisedModels = [
        defaultModelRef,
        ...Object.keys(this.modelsConfig).filter((ref) => ref !== defaultModelRef),
      ];
      const spawn = buildSpawnAgentTool({
        emit: (ev) => agent.pushEvent(ev),
        resolveCallId: (id) => agent.resolveCallId(id),
        awaitCallId: (id, signal) => agent.awaitCallId(id, signal),
        get parentAbortSignal() {
          return agent.signal;
        },
        parentSessionId: agent.session.id,
        cwd: init.cwd,
        defaultModelRef,
        getParentModel: () =>
          this.subagents.defaultModelRef
            ? { ref: this.subagents.defaultModelRef }
            : {
                ref: `${agent.session.model.providerId}/${agent.session.model.modelId}`,
                settings: agent.session.model.settings,
              },
        sandboxMode: init.sandboxMode,
        autoApprove: this.autoApprove,
        currentDepth: this.subagents.currentDepth ?? 0,
        maxDepth: this.subagents.maxDepth ?? 3,
        chimeraBin: this.subagents.chimeraBin ?? invocation.bin,
        chimeraBinArgs: invocation.preArgs,
        parentHasTty: this.subagents.parentHasTty ?? Boolean(process.stdin.isTTY),
        agents: this.agents,
        availableModels: advertisedModels,
        modelOptions: this.modelsConfig,
      });
      extraTools.spawn_agent = spawn.tool;
      if (spawn.formatScrollback) extraFormatters.spawn_agent = spawn.formatScrollback;
      extraSnippets.spawn_agent = 'Delegate a focused task to a fresh agent and get its answer.';
    }

    if (Object.keys(this.mcpServers).length > 0) {
      if (init.sandboxMode !== 'off') {
        this.warn('MCP tools run on the host, outside the Docker sandbox');
      }
      const manager = new McpClientManager(
        this.mcpServers,
        (name, url) =>
          new McpAuth(name, url, {
            directory: join(this.home ?? homedir(), '.chimera', 'mcp-auth'),
            clientId:
              this.mcpServers[name].transport === 'http'
                ? this.mcpServers[name].clientId
                : undefined,
          }),
      );
      this.liveMcpClients.set(agent.session.id, manager);
      await registerMcpTools({
        manager,
        servers: this.mcpServers,
        tools: extraTools,
        formatters: extraFormatters,
        gate,
        cwd: init.cwd,
        warn: this.warn,
      });
    }

    this.liveAgents.set(agent.session.id, agent);

    // One tool surface per model profile: the built-in tools under that
    // profile's names and edit format, plus the profile-independent extras.
    // Built on first use, so a session that never changes model builds one.
    interface ToolSurface {
      tools: ToolSet;
      snippets: Record<string, string>;
    }
    const surfaces = new Map<string, ToolSurface>();
    const formatters: Record<string, FormatScrollback<any, any>> = {};
    // Every tool of every surface runs through the same interceptors, so
    // their state (the repeat counter) follows the session, not the surface.
    const toolInterceptors: ToolCallInterceptor[] = [
      outputBudget({
        budgetTokens: () =>
          agent.session.model.outputBudgetTokens ?? initialProfile.outputBudgetTokens,
        store: recallStore,
      }),
      repeatNote(),
    ];
    const surfaceFor = (
      surfaceModel: Pick<ModelConfig, 'toolCallShape' | 'editFormat'>,
    ): ToolSurface => {
      const key = `${surfaceModel.toolCallShape ?? 'chimera'}/${surfaceModel.editFormat ?? 'replace'}`;
      const existing = surfaces.get(key);
      if (existing) return existing;
      const built = buildTools({
        sandboxExecutor,
        hostExecutor,
        bashHostExecutor: local,
        permissionGate: gate,
        hostAuthentication: this.hostAuthentication,
        commandRequiresSudo,
        sandboxMode: init.sandboxMode,
        toolCallShape: surfaceModel.toolCallShape,
        editFormat: surfaceModel.editFormat,
        backgroundProcesses,
        diagnostics,
        webSearch: this.webSearchProvider,
        taskList,
        recall: recallStore,
        requestUserInput: async (request) => agent.requestUserInput(request),
      });
      let surfaceTools: ToolSet = { ...built.tools, ...extraTools };
      // An agent definition's tools list applies before mode filtering: a
      // mode that also restricts tools leaves the intersection of the two.
      if (this.toolsAllowlist) {
        const allowed = applyAllowlist(surfaceTools, new Set(this.toolsAllowlist));
        if (surfaceTools.request_user_input) {
          allowed.request_user_input = surfaceTools.request_user_input;
        }
        surfaceTools = allowed;
      }
      const surface: ToolSurface = {
        tools: interceptTools(surfaceTools, toolInterceptors),
        snippets: { ...built.snippets, ...extraSnippets },
      };
      surfaces.set(key, surface);
      // Formatters accumulate across surfaces: earlier tool calls in the
      // scrollback keep rendering after the model, and its tool names, change.
      Object.assign(formatters, built.formatters, extraFormatters);
      this.lastFormatters = formatters;
      agent.setToolFormatters(formatters);
      return surface;
    };

    const toolsInMode = (surface: ToolSurface, mode: Mode | undefined): ToolSet => {
      const allowlist = mode ? computeAllowlist(mode) : undefined;
      if (!allowlist) return surface.tools;
      const filtered = applyAllowlist(surface.tools, allowlist);
      if (surface.tools.request_user_input) {
        filtered.request_user_input = surface.tools.request_user_input;
      }
      return filtered;
    };

    const promptFor = (
      promptModel: ModelConfig,
      mode: Mode | undefined,
      promptToolSet: ToolSet,
      surface: ToolSurface,
    ): string => {
      const promptTools = Object.entries(promptToolSet).map(([name, definition]) => ({
        name,
        snippet: surface.snippets[name] ?? firstLine(definition.description ?? name),
      }));
      if (this.systemPromptOverride !== undefined) {
        return `${this.systemPromptOverride}\n\n${renderToolsSection(promptTools)}`;
      }
      return composeSystemPrompt({
        cwd: init.cwd,
        model: promptModel,
        sandboxMode: init.sandboxMode,
        extensions,
        mode: mode ? { name: mode.name, body: mode.body } : undefined,
        tools: promptTools,
        promptStyle: promptModel.promptStyle,
      });
    };

    const initialSurface = surfaceFor(init.model);
    const initialAllowlist = activeMode ? computeAllowlist(activeMode) : undefined;
    if (activeMode && initialAllowlist) {
      const { missing } = expandAllowlist(initialAllowlist, Object.keys(initialSurface.tools));
      for (const wanted of missing) {
        this.warn(
          `mode "${activeMode.name}" lists tool "${wanted}" but it is not registered; dropping`,
        );
      }
    }
    const initialTools = toolsInMode(initialSurface, activeMode);
    agent.setTools(initialTools);
    agent.setSystemPrompt(promptFor(init.model, activeMode, initialTools, initialSurface));

    // Everything about a model that follows from its ref: used when the user
    // or a mode moves the session to another model.
    const describeModel = (
      ref: string,
      overrides = agent.session.modelSettingsOverrides?.[ref] ?? {},
    ) => {
      const { provider: newProvider, modelId: newModelId } = this.registry.resolve(ref);
      const newProviderSpec = this.providersConfig.providers[newProvider.id];
      const newProviderShape = newProviderSpec?.shape ?? newProvider.shape;
      const newWindow = resolveContextWindow({
        providerShape: newProviderShape,
        providerId: newProvider.id,
        modelId: newModelId,
        override: this.modelsConfig[ref]?.contextWindow,
        warn: this.warn,
      });
      const generation = this.resolveGeneration(
        ref,
        overrides,
        agent.session.modelCreationDefaults?.[ref],
      );
      const profile = profileFor(ref, newModelId, newWindow.value);
      const newModel: ModelConfig = {
        providerId: newProvider.id,
        modelId: newModelId,
        maxSteps: agent.session.model.maxSteps,
        ...this.resolveModelInput(ref, agent.session.modelInputOverrides?.[ref]),
        toolCallShape: profile.toolCallShape,
        editFormat: profile.editFormat,
        promptStyle: profile.promptStyle,
        outputBudgetTokens: profile.outputBudgetTokens,
        ...generation.modelFields,
      };
      return { model: newModel, provider: newProvider, modelId: newModelId, newWindow, generation };
    };

    if (modesReg && activeMode) {
      // The resolver lets the agent recompose its own system prompt + tool
      // set when a queued mode switch is drained at the top of the next run.
      agent.setModeResolver((nextName) => {
        const next = modesReg.find(nextName);
        if (!next) {
          throw new Error(`Unknown mode "${nextName}"`);
        }
        // Resolve previous mode dynamically from `agent.session.mode` —
        // the static `activeMode` captured at session construction is only
        // accurate for the very first switch; later switches (build → plan
        // → review) need the *currently* active mode to compute
        // `effectiveModelChanged` correctly.
        const previousMode = modesReg.find(agent.session.mode);
        const effectiveModel = agent.session.userModelOverride ?? next.model ?? sessionModelRef;
        const previousModel =
          agent.session.userModelOverride ?? previousMode?.model ?? sessionModelRef;
        const effectiveModelChanged = effectiveModel !== previousModel;
        const nextModel = effectiveModelChanged
          ? describeModel(effectiveModel).model
          : agent.session.model;
        const surface = surfaceFor(nextModel);
        const nextTools = toolsInMode(surface, next);
        return {
          systemPrompt: promptFor(nextModel, next, nextTools, surface),
          tools: nextTools,
          effectiveModel,
          effectiveModelChanged,
        };
      });
    }

    // Model-change resolver: allows the user to switch models at runtime via
    // `/model <ref>` (or clear the override with `/model default`). The new
    // model brings its own profile, so the tool surface and prompt follow it.
    const resolveChange = (
      ref: string,
      overrides = agent.session.modelSettingsOverrides?.[ref] ?? {},
    ) => {
      const described = describeModel(ref, overrides);
      const currentMode = modesReg ? modesReg.find(agent.session.mode) : undefined;
      const surface = surfaceFor(described.model);
      const currentTools = toolsInMode(surface, currentMode);
      return {
        model: described.model,
        languageModel: described.provider.getModel(described.modelId, agent.session.id),
        systemPrompt: promptFor(described.model, currentMode, currentTools, surface),
        tools: currentTools,
        contextWindow: described.newWindow.value,
        contextWindowIsApproximate: described.newWindow.source === 'fallback',
        providerOptions: described.generation.providerOptions,
      };
    };
    agent.setModelChangeResolver(resolveChange);
    agent.setModelSettingsResolver(
      async (target, overrides) => {
        await this.getModelCapabilities(target, true);
        if (this.defaultVisionModel && this.defaultVisionModel !== target)
          await this.getModelCapabilities(this.defaultVisionModel, true).catch(() => undefined);
        return resolveChange(target, overrides);
      },
      () => this.modes?.find(agent.session.mode)?.model ?? sessionModelRef,
    );

    // Vision fallback resolver: turns carrying images run on
    // `defaultVisionModel` when the active model is text-only.
    agent.setVisionModelResolver((): VisionModelResolution => {
      const visionRef = this.defaultVisionModel;
      if (!visionRef) {
        return {
          status: 'unavailable',
          reason: '"defaultVisionModel" is not set in ~/.chimera/config.json',
        };
      }
      if (
        this.resolveModelInput(visionRef, agent.session.modelInputOverrides?.[visionRef]).vision !==
        true
      ) {
        return {
          status: 'unavailable',
          reason: `defaultVisionModel "${visionRef}" has no verified image support. Set "vision": true under "models" only if this endpoint accepts images.`,
        };
      }
      return this.resolveRunModel(agent, visionRef);
    });

    const fallbackRef = this.fallbackModel;
    if (fallbackRef) {
      agent.setFallbackModelResolver(() => this.resolveRunModel(agent, fallbackRef));
    }

    return { agent, gate, hookRunner };
  }

  /**
   * Resolve a model that takes over for the rest of one run (vision route or
   * fallback), with the session's step cap and that model's own settings.
   */
  private resolveRunModel(agent: Agent, ref: string): VisionModelResolution {
    try {
      const { provider, modelId } = this.registry.resolve(ref);
      const providerSpec = this.providersConfig.providers[provider.id];
      const window = resolveContextWindow({
        providerShape: providerSpec?.shape ?? provider.shape,
        providerId: provider.id,
        modelId,
        override: this.modelsConfig[ref]?.contextWindow,
        warn: this.warn,
      });
      const generation = this.resolveGeneration(ref);
      return {
        status: 'ok',
        ref,
        model: {
          providerId: provider.id,
          modelId,
          maxSteps: agent.session.model.maxSteps,
          ...this.resolveModelInput(ref, agent.session.modelInputOverrides?.[ref]),
          toolCallShape: this.modelsConfig[ref]?.toolCallShape,
          ...generation.modelFields,
        },
        languageModel: provider.getModel(modelId, agent.session.id),
        contextWindow: window.value,
        contextWindowIsApproximate: window.source === 'fallback',
        providerOptions: generation.providerOptions,
      };
    } catch (err) {
      return { status: 'unavailable', reason: (err as Error).message };
    }
  }

  private modelCapabilities = new Map<string, ModelCapabilities>();

  private resolveModelInput(ref: string, explicit?: Pick<ModelConfig, 'vision' | 'imageLongEdge'>) {
    const options = this.modelsConfig[ref];
    return {
      vision:
        options?.vision ??
        explicit?.vision ??
        this.modelCapabilities.get(ref)?.inputModalities?.includes('image'),
      imageLongEdge: options?.imageLongEdge ?? explicit?.imageLongEdge,
    };
  }

  async getModelCapabilities(ref: string, refresh = false): Promise<ModelCapabilities> {
    const { provider, modelId } = this.registry.resolve(ref);
    const modelOptions = this.modelsConfig[ref];
    const spec = this.providersConfig.providers[provider.id];
    const base = modelOptions?.requestProfile
      ? localCapabilities(modelId, { ...spec, requestProfile: modelOptions.requestProfile })
      : await provider.getCapabilities(modelId, refresh);
    const capabilities = modelOptions?.capabilities
      ? ({
          ...base,
          source: 'configuration',
          settings: { ...base.settings, ...modelOptions.capabilities },
        } as ModelCapabilities)
      : base;
    this.modelCapabilities.set(ref, capabilities);
    return capabilities;
  }

  async listModels() {
    return (
      await Promise.all(
        Object.entries(this.modelsConfig).map(async ([ref, options]) => {
          const capabilities = await this.getModelCapabilities(ref);
          return {
            ref,
            contextWindow: options.contextWindow,
            maxOutputTokens: options.maxOutputTokens,
            vision: this.resolveModelInput(ref).vision,
            isDefault: ref === this.providersConfig.defaultModel,
            capabilities,
            defaults: this.resolveGeneration(ref).modelFields.settingsDefaults,
          };
        }),
      )
    ).sort((a, b) =>
      a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : a.ref.localeCompare(b.ref),
    );
  }

  private resolveGeneration(ref: string, overrides: ModelSettings = {}, legacy?: ModelSettings) {
    const { provider, modelId } = this.registry.resolve(ref);
    const options = this.modelsConfig[ref];
    const spec = this.providersConfig.providers[provider.id];
    const capabilities =
      this.modelCapabilities.get(ref) ??
      localCapabilities(modelId, {
        ...spec,
        requestProfile: options?.requestProfile ?? spec.requestProfile,
      });
    validateModelSettings(options?.settings ?? {}, capabilities);
    const defaults: ModelSettings = {
      ...Object.fromEntries(
        Object.entries({
          maxOutputTokens: options?.maxOutputTokens ?? legacy?.maxOutputTokens,
          parallelToolCalls: options?.parallelToolCalls ?? legacy?.parallelToolCalls,
          temperature: legacy?.temperature,
          topP: legacy?.topP,
        }).filter(([, value]) => value !== undefined),
      ),
      ...options?.settings,
    };
    const resolved = resolveModelSettings(
      spec,
      capabilities,
      defaults,
      overrides,
      options?.providerExtensions,
    );
    return {
      providerOptions: resolved.providerOptions,
      modelFields: {
        settings: resolved.settings,
        settingsDefaults: defaults,
        capabilities,
        maxOutputTokens: resolved.settings.maxOutputTokens,
        temperature: resolved.settings.temperature,
        topP: resolved.settings.topP,
        parallelToolCalls: resolved.settings.parallelToolCalls,
      },
    };
  }

  /** Live DockerExecutor for a session, if sandbox is on. */
  getSandbox(sessionId: SessionId): DockerExecutor | undefined {
    return this.liveSandboxes.get(sessionId);
  }

  /** Live LocalExecutor for a session. Used by runtime mutators. */
  getLocalExecutor(sessionId: SessionId): LocalExecutor | undefined {
    return this.liveExecutors.get(sessionId);
  }

  async addSessionPath(
    sessionId: SessionId,
    kind: 'read' | 'write',
    path: string,
  ): Promise<{ absolute: string; added: boolean }> {
    const agent = this.liveAgents.get(sessionId);
    if (!agent) throw new Error('session not found');

    const absolute = isAbsolute(path) ? resolve(path) : resolve(agent.session.cwd, path);
    try {
      await stat(absolute);
    } catch {
      throw new Error(`no such file or directory: ${absolute}`);
    }
    const resolved = await realpath(absolute);

    const executor = this.liveExecutors.get(sessionId);
    if (!executor) throw new Error('session not found');

    const writeAlready = agent.session.additionalWritePaths.includes(resolved);
    if (kind === 'read') {
      if (agent.session.additionalReadPaths.includes(resolved)) {
        return { absolute: resolved, added: false };
      }
      executor.addReadAllowDir(resolved);
      agent.session.additionalReadPaths.push(resolved);
      try {
        await writeSessionMetadata(agent.session, this.home);
      } catch (error) {
        executor.removeReadAllowDir(resolved);
        agent.session.additionalReadPaths.pop();
        throw error;
      }
      return { absolute: resolved, added: true };
    }

    // kind === 'write': grant both write and read access.
    const addRead = !agent.session.additionalReadPaths.includes(resolved);
    if (addRead) {
      executor.addReadAllowDir(resolved);
      agent.session.additionalReadPaths.push(resolved);
    }
    if (!writeAlready) {
      executor.addWriteAllowDir(resolved);
      agent.session.additionalWritePaths.push(resolved);
    }

    try {
      await writeSessionMetadata(agent.session, this.home);
    } catch (error) {
      if (addRead) {
        executor.removeReadAllowDir(resolved);
        agent.session.additionalReadPaths.pop();
      }
      if (!writeAlready) {
        executor.removeWriteAllowDir(resolved);
        agent.session.additionalWritePaths.pop();
      }
      throw error;
    }
    return { absolute: resolved, added: !writeAlready };
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    const manager = this.liveMcpClients.get(sessionId);
    this.liveMcpClients.delete(sessionId);
    await manager?.close();
  }

  /** Stop all running DockerExecutors and background processes. Safe to call multiple times. */
  async dispose(): Promise<void> {
    const mcpStops = [...this.liveMcpClients.keys()].map((sessionId) =>
      this.disposeSession(sessionId),
    );
    for (const manager of this.liveBackgroundManagers.values()) {
      manager.killAll();
    }
    this.liveBackgroundManagers.clear();
    const stops = Array.from(this.liveSandboxes.values()).map((d) =>
      d.stop().catch((err) => {
        this.warn(`sandbox stop failed: ${(err as Error).message}`);
      }),
    );
    this.liveSandboxes.clear();
    this.liveExecutors.clear();
    this.liveAgents.clear();
    await Promise.all([...stops, ...mcpStops]);
  }
}

async function tryLoadSession(sessionId: string, home?: string) {
  try {
    return await loadSession(sessionId, home);
  } catch (err) {
    throw new Error(
      `Could not resume session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function definedFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Resolve the chimera invocation tuple. Honors `CHIMERA_BIN` if set; otherwise
 * uses `process.execPath` plus the current entrypoint script (so subagents
 * spawn through the same node binary as the parent).
 */
export function resolveChimeraInvocation(): { bin: string; preArgs: string[] } {
  const fromEnv = process.env.CHIMERA_BIN;
  if (fromEnv) return { bin: fromEnv, preArgs: [] };
  const entry = process.argv[1];
  if (entry && entry.length > 0) {
    return { bin: process.execPath, preArgs: [entry] };
  }
  return { bin: 'chimera', preArgs: [] };
}

function _resolveChimeraBin(): string {
  return resolveChimeraInvocation().bin;
}
