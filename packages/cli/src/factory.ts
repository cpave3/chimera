import { Agent, composeSystemPrompt, loadSession } from '@chimera/core';
import { DefaultPermissionGate, GatedExecutor, type AutoApproveLevel } from '@chimera/permissions';
import { loadProviders, type ProvidersConfig } from '@chimera/providers';
import type { AgentFactory, BuildResult, SessionInit } from '@chimera/server';
import { buildTools, LocalExecutor } from '@chimera/tools';

export interface CliAgentFactoryOptions {
  providersConfig: ProvidersConfig;
  autoApprove: AutoApproveLevel;
  warn?: (msg: string) => void;
  home?: string;
}

export class CliAgentFactory implements AgentFactory {
  private readonly registry: ReturnType<typeof loadProviders>;
  private readonly autoApprove: AutoApproveLevel;
  private readonly home: string | undefined;

  constructor(opts: CliAgentFactoryOptions) {
    this.registry = loadProviders(opts.providersConfig, { warn: opts.warn });
    this.autoApprove = opts.autoApprove;
    this.home = opts.home;
  }

  async build(init: SessionInit): Promise<BuildResult> {
    const ref = `${init.model.providerId}/${init.model.modelId}`;
    const { provider, modelId } = this.registry.resolve(ref);
    const languageModel = provider.getModel(modelId);

    const local = new LocalExecutor({ cwd: init.cwd });

    // Build agent first so we can wire its raisePermissionRequest into the gate.
    const session = init.sessionId ? await tryLoadSession(init.sessionId, this.home) : undefined;
    const agent = new Agent({
      cwd: init.cwd,
      model: init.model,
      languageModel,
      tools: {} as never, // filled in below after gate is built
      systemPrompt: composeSystemPrompt({ cwd: init.cwd }),
      sandboxMode: init.sandboxMode,
      session,
      home: this.home,
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
