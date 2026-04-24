import { Command } from 'commander';
import { runAttach } from './commands/attach';
import { runCommandsList } from './commands/commands';
import { runInteractive } from './commands/interactive';
import { runLs } from './commands/ls';
import { runOneShot } from './commands/run';
import { runServe } from './commands/serve';
import { runSessionsList, runSessionsRm } from './commands/sessions';
import { runSkillsList } from './commands/skills';

const BANNED_SANDBOX_FLAGS = [
  '--sandbox',
  '--sandbox-mode',
  '--sandbox-strict',
  '--sandbox-image',
  '--sandbox-network',
  '--sandbox-memory',
  '--sandbox-cpus',
  '--max-subagent-depth',
  '--no-subagents',
];

function guardDeferredFlags(argv: string[]): void {
  for (const arg of argv) {
    for (const flag of BANNED_SANDBOX_FLAGS) {
      if (arg === flag || arg.startsWith(`${flag}=`)) {
        process.stderr.write(
          `error: flag '${flag}' is not yet supported in this release ` +
            '(sandbox and subagent features land in a follow-on change).\n',
        );
        process.exit(1);
      }
    }
  }
}

export function buildProgram(): Command {
  const program = new Command('chimera');
  program.version('0.1.0');

  program
    .command('run [prompt...]', { isDefault: false })
    .description('Run a one-shot prompt non-interactively.')
    .option('-m, --model <modelRef>', 'Model (providerId/modelId)')
    .option('--cwd <path>', 'Working directory', process.cwd())
    .option('--max-steps <n>', 'Agent loop cap', (v) => Number.parseInt(v, 10))
    .option('--auto-approve <level>', 'none|sandbox|host|all')
    .option('--json', 'Emit NDJSON AgentEvents to stdout', false)
    .option('--session <id>', 'Resume a persisted session')
    .option('--stdin', 'Read prompt from stdin', false)
    .option('--command <name>', 'Run a user command template by name')
    .option('--args <args>', 'Arguments for --command (quoted string)')
    .option('--no-claude-compat', 'Skip .claude/commands/ and .claude/skills/ discovery')
    .option('--no-skills', 'Skip skill discovery and system-prompt injection')
    .option('-v, --verbose', 'Verbose logging', false)
    .option('-q, --quiet', 'Suppress non-essential logging', false)
    .action(async (promptArgs: string[], opts) => {
      let prompt = promptArgs.join(' ');
      if (opts.stdin) {
        prompt = await readStdin();
      }
      if (opts.command && prompt.length > 0) {
        process.stderr.write(
          'error: --command is mutually exclusive with a positional prompt.\n',
        );
        process.exit(1);
      }
      if (!opts.command && prompt.length === 0) {
        process.stderr.write('error: run requires a prompt or --command <name>.\n');
        process.exit(1);
      }
      const { exitCode } = await runOneShot({
        prompt,
        json: opts.json,
        model: opts.model,
        maxSteps: opts.maxSteps,
        cwd: opts.cwd,
        autoApprove: opts.autoApprove,
        session: opts.session,
        command: opts.command,
        commandArgs: opts.args,
        claudeCompat: opts.claudeCompat,
        skills: opts.skills,
      });
      process.exit(exitCode);
    });

  program
    .command('commands')
    .description('List user commands discovered from the current working directory.')
    .option('--cwd <path>', 'Working directory', process.cwd())
    .option('--json', 'Emit JSON', false)
    .option('--no-claude-compat', 'Skip .claude/commands/ discovery')
    .action(async (opts) => {
      await runCommandsList({
        cwd: opts.cwd,
        json: opts.json,
        claudeCompat: opts.claudeCompat,
      });
    });

  program
    .command('skills')
    .description('List skills discovered from the current working directory.')
    .option('--cwd <path>', 'Working directory', process.cwd())
    .option('--json', 'Emit JSON', false)
    .option('--no-claude-compat', 'Skip .claude/skills/ discovery')
    .action(async (opts) => {
      await runSkillsList({
        cwd: opts.cwd,
        json: opts.json,
        claudeCompat: opts.claudeCompat,
      });
    });

  program
    .command('serve')
    .description('Start only the HTTP/SSE server.')
    .option('-m, --model <modelRef>', 'Default model')
    .option('--cwd <path>', 'Working directory', process.cwd())
    .option('--port <n>', 'Override ephemeral port', (v) => Number.parseInt(v, 10))
    .option('--host <addr>', 'Bind address', '127.0.0.1')
    .option('--machine-handshake', 'Emit a single JSON line on ready', false)
    .option('--parent <sessionId>', 'Parent session id (for subagents)')
    .option('--auto-approve <level>', 'none|sandbox|host|all')
    .option('--max-steps <n>', 'Agent loop cap', (v) => Number.parseInt(v, 10))
    .action(async (opts) => {
      await runServe({
        port: opts.port,
        host: opts.host,
        machineHandshake: opts.machineHandshake,
        parent: opts.parent,
        cwd: opts.cwd,
        model: opts.model,
        maxSteps: opts.maxSteps,
        autoApprove: opts.autoApprove,
      });
    });

  program
    .command('ls')
    .description('List running chimera instances.')
    .action(() => {
      runLs();
    });

  const sessions = program.command('sessions').description('Manage persisted sessions.');
  sessions
    .command('list', { isDefault: true })
    .description('List persisted sessions.')
    .action(() => runSessionsList());
  sessions
    .command('rm <id>')
    .description('Delete a persisted session.')
    .action((id: string) => runSessionsRm(id));

  program
    .command('attach <target>')
    .description('Attach to a running instance by id or URL.')
    .action(async (target: string) => {
      const client = await runAttach({ target });
      const info = await client.getInstance();
      process.stdout.write(`attached to pid=${info.pid} at ${info.cwd}\n`);
      process.stdout.write(
        'The interactive TUI is not yet mounted in `attach`; use `chimera` for the TUI.\n',
      );
    });

  // Default (no subcommand): interactive TUI session.
  program
    .option('-m, --model <modelRef>', 'Model (providerId/modelId)')
    .option('--cwd <path>', 'Working directory', process.cwd())
    .option('--max-steps <n>', 'Agent loop cap', (v) => Number.parseInt(v, 10))
    .option('--auto-approve <level>', 'none|sandbox|host|all')
    .option('--session <id>', 'Resume a persisted session')
    .option('--no-claude-compat', 'Skip .claude/commands/ and .claude/skills/ discovery')
    .option('--no-skills', 'Skip skill discovery and system-prompt injection')
    .action(async (opts) => {
      await runInteractive({
        cwd: opts.cwd ?? process.cwd(),
        model: opts.model,
        maxSteps: opts.maxSteps,
        autoApprove: opts.autoApprove,
        session: opts.session,
        claudeCompat: opts.claudeCompat,
        skills: opts.skills,
      });
    });

  program.exitOverride();
  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
  });
  return program;
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk.toString();
  }
  return data;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  guardDeferredFlags(argv.slice(2));
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    const code = (err as { code?: string; exitCode?: number }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.version') {
      return;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit((err as { exitCode?: number }).exitCode ?? 1);
  }
}
