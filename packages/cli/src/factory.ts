import { dirname } from 'node:path';
import { Agent, composeSystemPrompt, loadSession } from '@chimera/core';
import type { Executor, SessionId } from '@chimera/core';
import { DefaultPermissionGate, GatedExecutor, type AutoApproveLevel } from '@chimera/permissions';
import {
  loadProviders,
  resolveContextWindow,
  type ProvidersConfig,
} from '@chimera/providers';
import { DockerExecutor, sandboxDockerDir } from '@chimera/sandbox';
import type { AgentFactory, BuildResult, SessionInit } from '@chimera/server';
import { buildSkillActivationLookup, type SkillRegistry } from '@chimera/skills';
import { buildSpawnAgentTool } from '@chimera/subagents';
import { buildTools, LocalExecutor } from '@chimera/tools';
import type { CliSandboxOptions } from './sandbox-config';

export interface CliAgentFactoryOptions {
  providersConfig: ProvidersConfig;
  autoApprove: AutoApproveLevel;
  warn?: (msg: string) => void;
  home?: string;
  /**
   * Per-model overrides keyed by `<providerId>/<modelId>`. Currently only
   * `contextWindow` is honored.
   */
  models?: Record<string, { contextWindow?: number }>;
  /**
   * Optional skill registry. When present, the factory wires its index into
   * the system prompt and registers activation detection on the Agent.
   */
  skills?: SkillRegistry;
  /** When set, sandbox-target tools route through a DockerExecutor. */
  sandbox?: CliSandboxOptions;
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
}

export class CliAgentFactory implements AgentFactory {
  private readonly registry: ReturnType<typeof loadProviders>;
  private readonly autoApprove: AutoApproveLevel;
  private readonly home: string | undefined;
  private readonly skills: SkillRegistry | undefined;
  private readonly sandbox: CliSandboxOptions | undefined;
  private readonly subagents: NonNullable<CliAgentFactoryOptions['subagents']>;
  private readonly warn: (msg: string) => void;
  private readonly providersConfig: ProvidersConfig;
  private readonly modelsConfig: Record<string, { contextWindow?: number }>;
  private readonly liveSandboxes = new Map<SessionId, DockerExecutor>();

  constructor(opts: CliAgentFactoryOptions) {
    this.registry = loadProviders(opts.providersConfig, { warn: opts.warn });
    this.autoApprove = opts.autoApprove;
    this.home = opts.home;
    this.skills = opts.skills;
    this.sandbox = opts.sandbox;
    this.subagents = opts.subagents ?? {};
    this.warn = opts.warn ?? ((m) => process.stderr.write(`${m}\n`));
    this.providersConfig = opts.providersConfig;
    this.modelsConfig = opts.models ?? {};
  }

  async build(init: SessionInit): Promise<BuildResult> {
    const ref = `${init.model.providerId}/${init.model.modelId}`;
    const { provider, modelId } = this.registry.resolve(ref);
    const languageModel = provider.getModel(modelId);
    const providerSpec = this.providersConfig.providers[init.model.providerId];
    const resolvedWindow = resolveContextWindow({
      providerShape: providerSpec?.shape ?? provider.shape,
      providerId: init.model.providerId,
      modelId,
      override: this.modelsConfig[ref]?.contextWindow,
      warn: this.warn,
    });

    const skillsReg = this.skills;
    const extensions = skillsReg
      ? [() => skillsReg.buildIndex() || null]
      : undefined;
    const skillActivation = skillsReg
      ? buildSkillActivationLookup(skillsReg, init.cwd)
      : undefined;

    // Skills often live outside cwd (e.g. `~/.claude/skills/tdd/`). Allow
    // read access to each resolved skill's directory so the model can
    // read the SKILL.md itself and any peer scripts bundled with it.
    const readAllowDirs = skillsReg
      ? skillsReg.all().map((s) => dirname(s.path))
      : undefined;
    const local = new LocalExecutor({ cwd: init.cwd, readAllowDirs });

    // Build agent first so we can wire its raisePermissionRequest into the gate.
    const session = init.sessionId ? await tryLoadSession(init.sessionId, this.home) : undefined;
    const agent = new Agent({
      cwd: init.cwd,
      model: init.model,
      languageModel,
      tools: {} as never, // filled in below after gate is built
      systemPrompt: composeSystemPrompt({
        cwd: init.cwd,
        model: init.model,
        sandboxMode: init.sandboxMode,
        extensions,
      }),
      sandboxMode: init.sandboxMode,
      session,
      home: this.home,
      skillActivation,
      contextWindow: resolvedWindow.value,
      contextWindowIsApproximate: resolvedWindow.source === 'fallback',
    });

    const gate = new DefaultPermissionGate({
      cwd: init.cwd,
      autoApprove: this.autoApprove,
      raiseRequest: (req) => agent.raisePermissionRequest(req),
      headlessAutoDeny: this.subagents.headlessAutoDeny,
    });

    // Wire remember handler so resolvePermission's `remember` arg persists a rule.
    agent.setRememberHandler((_requestId, scope, req) => {
      gate.applyRemember(scope, req, 'allow');
    });

    const hostExecutor = this.autoApprove === 'all'
      ? local
      : new GatedExecutor({ inner: local, gate });

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

    const built = buildTools({
      sandboxExecutor,
      hostExecutor,
      permissionGate: gate,
      sandboxMode: init.sandboxMode,
    });
    const tools = built.tools;
    const formatters = { ...built.formatters };

    if (this.subagents.enabled !== false) {
      const invocation = resolveChimeraInvocation();
      const spawn = buildSpawnAgentTool({
        emit: (ev) => agent.pushEvent(ev),
        resolveCallId: (id) => agent.resolveCallId(id),
        get parentAbortSignal() {
          return agent.signal;
        },
        parentSessionId: agent.session.id,
        cwd: init.cwd,
        defaultModelRef:
          this.subagents.defaultModelRef ??
          `${init.model.providerId}/${init.model.modelId}`,
        sandboxMode: init.sandboxMode,
        autoApprove: this.autoApprove,
        currentDepth: this.subagents.currentDepth ?? 0,
        maxDepth: this.subagents.maxDepth ?? 3,
        chimeraBin: this.subagents.chimeraBin ?? invocation.bin,
        chimeraBinArgs: invocation.preArgs,
        parentHasTty:
          this.subagents.parentHasTty ?? Boolean(process.stdin.isTTY),
      });
      tools.spawn_agent = spawn.tool;
      if (spawn.formatScrollback) formatters.spawn_agent = spawn.formatScrollback;
    }

    agent.setTools(tools);
    agent.setToolFormatters(formatters);

    return { agent, gate };
  }

  /** Live DockerExecutor for a session, if sandbox is on. */
  getSandbox(sessionId: SessionId): DockerExecutor | undefined {
    return this.liveSandboxes.get(sessionId);
  }

  /** Stop all running DockerExecutors. Safe to call multiple times. */
  async dispose(): Promise<void> {
    const stops = Array.from(this.liveSandboxes.values()).map((d) =>
      d.stop().catch((err) => {
        this.warn(`sandbox stop failed: ${(err as Error).message}`);
      }),
    );
    this.liveSandboxes.clear();
    await Promise.all(stops);
  }
}

async function tryLoadSession(sessionId: string, home?: string) {
  try {
    return await loadSession(sessionId, home);
  } catch {
    return undefined;
  }
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

function resolveChimeraBin(): string {
  return resolveChimeraInvocation().bin;
}
