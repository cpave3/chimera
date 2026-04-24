import { ChimeraClient } from '@chimera/client';
import { AgentRegistry, buildApp, startServer, type AgentFactory } from '@chimera/server';
import { loadConfig, resolveModel } from '../config';
import { CliAgentFactory } from '../factory';

export interface RunOptions {
  prompt: string;
  json?: boolean;
  model?: string;
  maxSteps?: number;
  cwd: string;
  autoApprove?: 'none' | 'sandbox' | 'host' | 'all';
  session?: string;
  home?: string;
  /** Test hook: bypass provider loading and supply a pre-built factory. */
  factoryOverride?: AgentFactory;
  /** Test hook: override model config when `factoryOverride` is supplied. */
  modelOverride?: { providerId: string; modelId: string; maxSteps: number };
}

export interface RunResult {
  exitCode: number;
}

export async function runOneShot(opts: RunOptions): Promise<RunResult> {
  let model: { providerId: string; modelId: string; maxSteps: number };
  let factory: AgentFactory;
  if (opts.factoryOverride && opts.modelOverride) {
    model = opts.modelOverride;
    factory = opts.factoryOverride;
  } else {
    const config = loadConfig(opts.home);
    const resolved = resolveModel({
      cliModel: opts.model,
      maxSteps: opts.maxSteps,
      config,
    });
    model = resolved.model;
    factory = new CliAgentFactory({
      providersConfig: resolved.providersConfig,
      autoApprove: opts.autoApprove ?? 'host',
      home: opts.home,
    });
  }

  const registry = new AgentRegistry({
    factory,
    instance: { pid: process.pid, cwd: opts.cwd, version: '0.1.0', sandboxMode: 'off' },
  });
  const app = buildApp({ registry });
  const server = await startServer({ app });

  const client = new ChimeraClient({ baseUrl: server.url });
  try {
    const { sessionId } = await client.createSession({
      cwd: opts.cwd,
      model,
      sandboxMode: 'off',
      sessionId: opts.session,
    });

    let finalText = '';
    let exitReason: 'stop' | 'error' | 'max_steps' | 'interrupted' | 'timeout' = 'stop';
    let errorMessage: string | undefined;

    const sigintHandler = () => {
      void client.interrupt(sessionId);
    };
    process.once('SIGINT', sigintHandler);

    for await (const ev of client.send(sessionId, opts.prompt)) {
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

    return { exitCode: exitCodeFor(exitReason) };
  } finally {
    await server.close();
  }
}

function exitCodeFor(reason: 'stop' | 'error' | 'max_steps' | 'interrupted' | 'timeout'): number {
  if (reason === 'stop') return 0;
  if (reason === 'max_steps') return 2;
  if (reason === 'interrupted') return 130;
  return 1;
}

function formatArgsShort(args: unknown): string {
  const raw = JSON.stringify(args);
  return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
}
