import { dirname } from 'node:path';
import { Agent, composeSystemPrompt, loadSession } from '@chimera/core';
import { DefaultPermissionGate, GatedExecutor, type AutoApproveLevel } from '@chimera/permissions';
import { loadProviders, type ProvidersConfig } from '@chimera/providers';
import type { AgentFactory, BuildResult, SessionInit } from '@chimera/server';
import { buildSkillActivationLookup, type SkillRegistry } from '@chimera/skills';
import { buildTools, LocalExecutor } from '@chimera/tools';

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
}

export class CliAgentFactory implements AgentFactory {
  private readonly registry: ReturnType<typeof loadProviders>;
  private readonly autoApprove: AutoApproveLevel;
  private readonly home: string | undefined;
  private readonly skills: SkillRegistry | undefined;

  constructor(opts: CliAgentFactoryOptions) {
    this.registry = loadProviders(opts.providersConfig, { warn: opts.warn });
    this.autoApprove = opts.autoApprove;
    this.home = opts.home;
    this.skills = opts.skills;
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
      systemPrompt: composeSystemPrompt({ cwd: init.cwd, extensions }),
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

    const tools = buildTools({
      sandboxExecutor: local,
      hostExecutor,
      permissionGate: gate,
      sandboxMode: init.sandboxMode,
    });

    agent.setTools(tools);

    return { agent, gate };
  }
}

async function tryLoadSession(sessionId: string, home?: string) {
  try {
    return await loadSession(sessionId, home);
  } catch {
    return undefined;
  }
}
