import { ChimeraClient } from '@chimera/client';
import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import { mountTui } from '@chimera/tui';
import { loadConfig, resolveModel } from '../config';
import { CliAgentFactory } from '../factory';

export interface InteractiveOptions {
  cwd: string;
  model?: string;
  maxSteps?: number;
  autoApprove?: 'none' | 'sandbox' | 'host' | 'all';
  session?: string;
  home?: string;
}

export async function runInteractive(opts: InteractiveOptions): Promise<void> {
  const config = loadConfig(opts.home);
  const { model, ref, providersConfig } = resolveModel({
    cliModel: opts.model,
    maxSteps: opts.maxSteps,
    config,
  });

  const factory = new CliAgentFactory({
    providersConfig,
    autoApprove: opts.autoApprove ?? 'host',
    home: opts.home,
  });

  const registry = new AgentRegistry({
    factory,
    instance: {
      pid: process.pid,
      cwd: opts.cwd,
      version: '0.1.0',
      sandboxMode: 'off',
    },
  });
  const app = buildApp({ registry });
  const server = await startServer({ app });

  const client = new ChimeraClient({ baseUrl: server.url });
  const { sessionId } = await client.createSession({
    cwd: opts.cwd,
    model,
    sandboxMode: 'off',
    sessionId: opts.session,
  });

  const handle = mountTui({ client, sessionId, modelRef: ref, cwd: opts.cwd });
  try {
    await handle.waitUntilExit();
  } finally {
    await server.close();
  }
}
