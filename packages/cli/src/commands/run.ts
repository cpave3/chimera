import { ChimeraClient } from '@chimera/client';
import { AgentRegistry, buildApp, startServer, type AgentFactory } from '@chimera/server';
import { loadCommandsFromConfig } from '../commands-loader';
import { loadConfig, resolveModel } from '../config';
import { CliAgentFactory } from '../factory';
import { loadSkillsFromConfig } from '../skills-loader';

export interface RunOptions {
  prompt: string;
  json?: boolean;
  model?: string;
  maxSteps?: number;
  cwd: string;
  autoApprove?: 'none' | 'sandbox' | 'host' | 'all';
  session?: string;
  home?: string;
  /** Name of a user command template to expand into the prompt. */
  command?: string;
  /** Raw args string for the command template. */
  commandArgs?: string;
  /** If false, skip `.claude/commands/` and `.claude/skills/` discovery. */
  claudeCompat?: boolean;
  /** If false, skip skill discovery + system-prompt injection entirely. */
  skills?: boolean;
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
  const config = opts.factoryOverride && opts.modelOverride ? {} : loadConfig(opts.home);
  const skills = loadSkillsFromConfig({
    cwd: opts.cwd,
    home: opts.home,
    config,
    claudeCompatOverride: opts.claudeCompat,
    skillsDisabled: opts.skills === false,
    onWarning: (m) => process.stderr.write(`${m}\n`),
  });
  if (opts.factoryOverride && opts.modelOverride) {
    model = opts.modelOverride;
    factory = opts.factoryOverride;
  } else {
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
      skills,
    });
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

  const registry = new AgentRegistry({
    factory,
    instance: { pid: process.pid, cwd: opts.cwd, version: '0.1.0', sandboxMode: 'off' },
    loadCommands: () => commands.list(),
    loadSkills: () => skills.all(),
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

    for await (const ev of client.send(sessionId, effectivePrompt)) {
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
