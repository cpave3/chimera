import { readFileSync } from 'node:fs';
import { ChimeraClient } from '@chimera/client';
import { Compactor } from '@chimera/compaction';
import type { SandboxMode } from '@chimera/core';
import { loadProviders, resolveContextWindow } from '@chimera/providers';
import { forkOverlay } from '@chimera/sandbox';
import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import { loadAgentsFromConfig } from '../agents-loader';
import {
  checkCompactionInvariant,
  recallPrunerFactory,
  resolveCompactionConfig,
} from '../compaction';
import { loadConfig, resolveModel } from '../config';
import { CliAgentFactory } from '../factory';
import { launchSession, type SessionExistsPolicy } from '../launch-session';
import { removeLockfile, writeLockfile } from '../lockfile';
import { loadModesFromConfig } from '../modes-loader';
import { CHIMERA_CLI_VERSION } from '../program';
import { type ParseSandboxFlagsInput, parseSandboxFlags } from '../sandbox-config';
import { loadSkillsFromConfig } from '../skills-loader';

export interface ServeOptions {
  port?: number;
  host?: string;
  machineHandshake?: boolean;
  parent?: string;
  cwd: string;
  model?: string;
  sessionName?: string;
  sessionId?: string;
  sessionExists?: SessionExistsPolicy;
  maxSteps?: number;
  autoApprove?: 'none' | 'sandbox' | 'host' | 'all';
  home?: string;
  sandboxFlags?: Omit<ParseSandboxFlagsInput, 'cliVersion'>;
  /** Default true; commander populates `false` when `--no-subagents` is passed. */
  subagents?: boolean;
  maxSubagentDepth?: number;
  /** Internal: forwarded by parents to children. */
  currentSubagentDepth?: number;
  /** Internal: parent had no TTY; child auto-denies prompts. */
  headlessPermissionAutoDeny?: boolean;
  /** Initial mode for the server-bound default session. Falls back to config.defaultMode then "build". */
  mode?: string;
  /** False → skip mode discovery (from `--no-modes`). */
  modes?: boolean;
  /**
   * Path to a file whose contents fully replace the composed system prompt
   * for this server's default session. Used by parents spawning children
   * with an agent-definition body.
   */
  systemPromptFile?: string;
  /**
   * Comma-separated tool names that the server's default session is
   * restricted to (intersected with mode allowlists). Used by parents
   * spawning children with an agent-definition `tools:` field.
   */
  tools?: string;
  /**
   * Per-session override for compaction. When `false` (from `--no-compaction`),
   * compaction is disabled for this invocation.
   */
  compaction?: boolean;
  /** Additional absolute paths for read access outside cwd. */
  additionalReadPaths?: string[];
  /** Additional absolute paths for write access outside cwd. */
  additionalWritePaths?: string[];
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const sandboxOpts = opts.sandboxFlags
    ? parseSandboxFlags({ ...opts.sandboxFlags, cliVersion: CHIMERA_CLI_VERSION })
    : null;
  const sandboxMode: SandboxMode = sandboxOpts?.enabled ? sandboxOpts.mode : 'off';

  const config = loadConfig(opts.home);
  const { model, providersConfig } = resolveModel({
    cliModel: opts.model,
    maxSteps: opts.maxSteps,
    config,
  });

  const skills = loadSkillsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });

  const agents = loadAgentsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });

  let systemPromptOverride: string | undefined;
  if (opts.systemPromptFile) {
    try {
      systemPromptOverride = readFileSync(opts.systemPromptFile, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`--system-prompt-file: could not read ${opts.systemPromptFile}: ${message}`);
    }
  }
  const toolsAllowlist = opts.tools
    ? opts.tools
        .split(',')
        .map((tool) => tool.trim().toLowerCase())
        .filter((tool) => tool.length > 0)
    : undefined;

  const modes = loadModesFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    modesDisabled: opts.modes === false,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });
  const initialMode = opts.mode ?? config.defaultMode ?? 'build';

  const compactionConfig = resolveCompactionConfig({ cliOverride: opts.compaction, config });
  const resolvedWindow = resolveContextWindow({
    providerShape: providersConfig.providers[model.providerId]?.shape ?? 'openai',
    providerId: model.providerId,
    modelId: model.modelId,
    override: config.models?.[`${model.providerId}/${model.modelId}`]?.contextWindow,
  });
  const invariant = checkCompactionInvariant(compactionConfig, resolvedWindow.value);
  if (!invariant.ok) {
    process.stderr.write(`${invariant.error}\n`);
    process.exit(1);
  }

  let compactor: Compactor | undefined;
  if (compactionConfig.enabled) {
    const registry = loadProviders(providersConfig);
    const compactionRef = compactionConfig.model ?? `${model.providerId}/${model.modelId}`;
    const { provider, modelId } = registry.resolve(compactionRef);
    compactor = new Compactor({
      config: compactionConfig,
      contextWindow: resolvedWindow.value,
      resolveModel: async (_ref, sessionId) => provider.getModel(modelId, sessionId),
      home: opts.home,
      createPruner: recallPrunerFactory(config, opts.home),
    });
  }

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
      currentDepth: opts.currentSubagentDepth,
      headlessAutoDeny: opts.headlessPermissionAutoDeny,
    },
    systemPromptOverride,
    toolsAllowlist,
    models: config.models,
    defaultVisionModel: config.defaultVisionModel,
    compaction: compactionConfig,
    compactor,
    responseTimeoutMs: config.responseTimeoutMs,
    diagnostics: config.diagnostics,
    webSearch: config.webSearch,
    recall: config.recall,
  });

  const registry = new AgentRegistry({
    factory,
    instance: {
      pid: process.pid,
      cwd: opts.cwd,
      version: '0.1.0',
      sandboxMode,
      parentId: opts.parent,
    },
    loadSkills: () => skills.all(),
    loadModes: () => modes.all(),
    home: opts.home,
    workspaceCheckpoints: config.workspaceCheckpoints !== false,
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
  const server = await startServer({ app, port: opts.port, host: opts.host });

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
    { sessionExists: opts.sessionExists },
  );

  writeLockfile(
    {
      pid: process.pid,
      port: server.port,
      cwd: opts.cwd,
      sessionId,
      startedAt: Date.now(),
      version: '0.1.0',
      url: server.url,
    },
    opts.home,
  );

  const shutdown = async () => {
    removeLockfile(process.pid, opts.home);
    await factory.dispose();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  if (opts.machineHandshake) {
    process.stdout.write(
      `${JSON.stringify({
        ready: true,
        url: server.url,
        sessionId,
        pid: process.pid,
      })}\n`,
    );
  } else {
    process.stderr.write(`chimera server listening on ${server.url} (session ${sessionId})\n`);
  }

  // Stay alive.
  await new Promise(() => {});
}
