import { dirname } from 'node:path';
import { Agent, composeSystemPrompt, loadSession } from '@chimera/core';
import type { Executor, SessionId } from '@chimera/core';
import { DefaultPermissionGate, GatedExecutor, type AutoApproveLevel } from '@chimera/permissions';
import { loadProviders, type ProvidersConfig } from '@chimera/providers';
import { DockerExecutor, sandboxDockerDir } from '@chimera/sandbox';
import type { AgentFactory, BuildResult, SessionInit } from '@chimera/server';
import { buildSkillActivationLookup, type SkillRegistry } from '@chimera/skills';
import { buildTools, LocalExecutor } from '@chimera/tools';
import type { CliSandboxOptions } from './sandbox-config';

export interface CliAgentFactoryOptions {
  providersConfig: ProvidersConfig;
  autoApprove: AutoApproveLevel;
  warn?: (msg: string) => void;
  home?: string;
  /**
   * Optional skill registry. When present, the factory wires its index into
   * the system prompt and registers activation detection on the Agent.
   */
  skills?: SkillRegistry;
  /** When set, sandbox-target tools route through a DockerExecutor. */
  sandbox?: CliSandboxOptions;
}

export class CliAgentFactory implements AgentFactory {
  private readonly registry: ReturnType<typeof loadProviders>;
  private readonly autoApprove: AutoApproveLevel;
  private readonly home: string | undefined;
  private readonly skills: SkillRegistry | undefined;
  private readonly sandbox: CliSandboxOptions | undefined;
  private readonly warn: (msg: string) => void;
  private readonly liveSandboxes = new Map<SessionId, DockerExecutor>();

  constructor(opts: CliAgentFactoryOptions) {
    this.registry = loadProviders(opts.providersConfig, { warn: opts.warn });
    this.autoApprove = opts.autoApprove;
    this.home = opts.home;
    this.skills = opts.skills;
    this.sandbox = opts.sandbox;
    this.warn = opts.warn ?? ((m) => process.stderr.write(`${m}\n`));
  }

  async build(init: SessionInit): Promise<BuildResult> {
    const ref = `${init.model.providerId}/${init.model.modelId}`;
    const { provider, modelId } = this.registry.resolve(ref);
    const languageModel = provider.getModel(modelId);

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
    });

    const gate = new DefaultPermissionGate({
      cwd: init.cwd,
      autoApprove: this.autoApprove,
      raiseRequest: (req) => agent.raisePermissionRequest(req),
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

    const tools = buildTools({
      sandboxExecutor,
      hostExecutor,
      permissionGate: gate,
      sandboxMode: init.sandboxMode,
    });

    agent.setTools(tools);

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
