import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import { loadConfig, resolveModel } from '../config';
import { CliAgentFactory } from '../factory';
import { removeLockfile, writeLockfile } from '../lockfile';
import { loadSkillsFromConfig } from '../skills-loader';

export interface ServeOptions {
  port?: number;
  host?: string;
  machineHandshake?: boolean;
  parent?: string;
  cwd: string;
  model?: string;
  maxSteps?: number;
  autoApprove?: 'none' | 'sandbox' | 'host' | 'all';
  home?: string;
}

export async function runServe(opts: ServeOptions): Promise<void> {
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

  const factory = new CliAgentFactory({
    providersConfig,
    autoApprove: opts.autoApprove ?? 'host',
    home: opts.home,
    skills,
  });

  const registry = new AgentRegistry({
    factory,
    instance: {
      pid: process.pid,
      cwd: opts.cwd,
      version: '0.1.0',
      sandboxMode: 'off',
      parentId: opts.parent,
    },
    loadSkills: () => skills.all(),
  });

  const app = buildApp({ registry });
  const server = await startServer({ app, port: opts.port, host: opts.host });

  // Create a default session bound to the working directory.
  const { sessionId } = await registry.create({
    cwd: opts.cwd,
    model,
    sandboxMode: 'off',
  });

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
    process.stderr.write(
      `chimera server listening on ${server.url} (session ${sessionId})\n`,
    );
  }

  // Stay alive.
  await new Promise(() => {});
}
