import { Command } from 'commander';
import { runAttach } from './commands/attach';
import { runCommandsList } from './commands/commands';
import { runInteractive } from './commands/interactive';
import { runLs } from './commands/ls';
import { runOneShot } from './commands/run';
import { runSandboxBuild } from './commands/sandbox';
import { runServe } from './commands/serve';
import {
  findLatestSessionInCwd,
  pickSessionInteractive,
  resolveSessionId,
  runSessionsList,
  runSessionsRm,
} from './commands/sessions';
import { runSkillsList } from './commands/skills';

export const CHIMERA_CLI_VERSION = '0.1.0';

function applySubagentOptions(cmd: Command): Command {
  return cmd
    .option(
      '--max-subagent-depth <n>',
      'Maximum subagent nesting depth (default 3)',
      (v) => Number.parseInt(v, 10),
    )
    .option('--no-subagents', 'Disable the spawn_agent tool');
}

function applySandboxOptions(cmd: Command): Command {
  return cmd
    .option('--sandbox', 'Run tools inside a Docker sandbox', false)
    .option(
      '--sandbox-mode <mode>',
      "Sandbox mode: bind|overlay|ephemeral (default: bind)",
    )
    .option(
      '--sandbox-strict',
      'Refuse fallback to bind when overlay/ephemeral is unavailable',
      false,
    )
    .option('--sandbox-image <ref>', 'Sandbox image reference')
    .option('--sandbox-network <mode>', 'Sandbox network: none|host (default: host)')
    .option('--sandbox-memory <size>', 'Sandbox --memory value (default: 2g)')
    .option('--sandbox-cpus <n>', 'Sandbox --cpus value (default: 2)')
    .option(
      '--apply-on-success',
      'In overlay mode, apply the upperdir iff the run finished cleanly',
      false,
    );
}

export function buildProgram(): Command {
  const program = new Command('chimera');
  program.version(CHIMERA_CLI_VERSION);
  // Required so `--sandbox-mode <value>` registered on subcommands doesn't get
  // shadowed by the same option on the program (default action). See
  // https://github.com/tj/commander.js#parsing-and-positional-options.
  program.enablePositionalOptions();

  applySubagentOptions(
    applySandboxOptions(
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
        .option('-q, --quiet', 'Suppress non-essential logging', false),
    ),
  ).action(async (promptArgs: string[], opts) => {
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
      sandboxFlags: opts,
      subagents: opts.subagents,
      maxSubagentDepth: opts.maxSubagentDepth,
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

  applySubagentOptions(
    applySandboxOptions(
      program
        .command('serve')
        .description('Start only the HTTP/SSE server.')
        .option('-m, --model <modelRef>', 'Default model')
        .option('--cwd <path>', 'Working directory', process.cwd())
        .option('--port <n>', 'Override ephemeral port', (v) => Number.parseInt(v, 10))
        .option('--host <addr>', 'Bind address', '127.0.0.1')
        .option('--machine-handshake', 'Emit a single JSON line on ready', false)
        .option('--parent <sessionId>', 'Parent session id (for subagents)')
        .option(
          '--current-subagent-depth <n>',
          'Internal: nesting depth of this child agent',
          (v) => Number.parseInt(v, 10),
        )
        .option(
          '--headless-permission-auto-deny',
          'Internal: auto-deny host-target permission requests instead of prompting',
          false,
        )
        .option('--auto-approve <level>', 'none|sandbox|host|all')
        .option('--max-steps <n>', 'Agent loop cap', (v) => Number.parseInt(v, 10)),
    ),
  ).action(async (opts) => {
    await runServe({
      port: opts.port,
      host: opts.host,
      machineHandshake: opts.machineHandshake,
      parent: opts.parent,
      cwd: opts.cwd,
      model: opts.model,
      maxSteps: opts.maxSteps,
      autoApprove: opts.autoApprove,
      sandboxFlags: opts,
      subagents: opts.subagents,
      maxSubagentDepth: opts.maxSubagentDepth,
      currentSubagentDepth: opts.currentSubagentDepth,
      headlessPermissionAutoDeny: opts.headlessPermissionAutoDeny,
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
    .description('List persisted sessions in the current directory (use --all for every directory).')
    .option('--cwd <path>', 'Filter by this directory', process.cwd())
    .option('-a, --all', 'List sessions from every directory', false)
    .action(async (opts) => {
      await runSessionsList({ cwd: opts.cwd, all: opts.all });
    });
  sessions
    .command('rm <id>')
    .description('Delete a persisted session.')
    .option('--cwd <path>', 'Scope suffix matching to this directory', process.cwd())
    .option('-a, --all', 'Resolve suffix across every directory', false)
    .action(async (id: string, options: { cwd?: string; all?: boolean }) => {
      try {
        const resolved = await resolveSessionId(id, {
          cwd: options.all ? undefined : options.cwd,
        });
        await runSessionsRm(resolved);
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      }
    });

  applySubagentOptions(
    applySandboxOptions(
      program
        .command('resume [id]')
        .description(
          'Resume a persisted session. With <id>, resumes that session directly. Without an id, opens a picker scoped to the current directory.',
        )
        .option('-m, --model <modelRef>', 'Model (providerId/modelId)')
        .option('--cwd <path>', 'Working directory', process.cwd())
        .option('--max-steps <n>', 'Agent loop cap', (v) => Number.parseInt(v, 10))
        .option('--auto-approve <level>', 'none|sandbox|host|all')
        .option('--no-claude-compat', 'Skip .claude/commands/ and .claude/skills/ discovery')
        .option('--no-skills', 'Skip skill discovery and system-prompt injection'),
    ),
  ).action(async (id: string | undefined, opts) => {
    let sessionId = id;
    if (!sessionId) {
      const picked = await pickSessionInteractive(opts.cwd ?? process.cwd(), opts.home);
      if (!picked) process.exit(1);
      sessionId = picked;
    } else {
      try {
        sessionId = await resolveSessionId(sessionId, {
          home: opts.home,
          cwd: opts.cwd ?? process.cwd(),
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      }
    }
    await runInteractive({
      cwd: opts.cwd ?? process.cwd(),
      model: opts.model,
      maxSteps: opts.maxSteps,
      autoApprove: opts.autoApprove,
      session: sessionId,
      claudeCompat: opts.claudeCompat,
      skills: opts.skills,
      sandboxFlags: opts,
      subagents: opts.subagents,
      maxSubagentDepth: opts.maxSubagentDepth,
    });
  });

  applySubagentOptions(
    applySandboxOptions(
      program
        .command('continue')
        .alias('c')
        .description(
          'Resume the most-recently-active session in the current directory.',
        )
        .option('-m, --model <modelRef>', 'Model (providerId/modelId)')
        .option('--cwd <path>', 'Working directory', process.cwd())
        .option('--max-steps <n>', 'Agent loop cap', (v) => Number.parseInt(v, 10))
        .option('--auto-approve <level>', 'none|sandbox|host|all')
        .option('--no-claude-compat', 'Skip .claude/commands/ and .claude/skills/ discovery')
        .option('--no-skills', 'Skip skill discovery and system-prompt injection'),
    ),
  ).action(async (opts) => {
    const cwd = opts.cwd ?? process.cwd();
    const latest = await findLatestSessionInCwd(cwd, opts.home);
    if (!latest) {
      process.stderr.write(
        `No sessions in ${cwd}. Run \`chimera\` to start a new one.\n`,
      );
      process.exit(1);
    }
    await runInteractive({
      cwd,
      model: opts.model,
      maxSteps: opts.maxSteps,
      autoApprove: opts.autoApprove,
      session: latest.id,
      claudeCompat: opts.claudeCompat,
      skills: opts.skills,
      sandboxFlags: opts,
      subagents: opts.subagents,
      maxSubagentDepth: opts.maxSubagentDepth,
    });
  });

  const sandbox = program.command('sandbox').description('Manage the sandbox image.');
  sandbox
    .command('build')
    .description('Build the local sandbox image as chimera-sandbox:dev.')
    .action(async () => {
      const { exitCode } = await runSandboxBuild();
      process.exit(exitCode);
    });

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
  applySubagentOptions(
    applySandboxOptions(
      program
        .option('-m, --model <modelRef>', 'Model (providerId/modelId)')
        .option('--cwd <path>', 'Working directory', process.cwd())
        .option('--max-steps <n>', 'Agent loop cap', (v) => Number.parseInt(v, 10))
        .option('--auto-approve <level>', 'none|sandbox|host|all')
        .option('--session <id>', 'Resume a persisted session')
        .option(
          '--resume [id]',
          'Resume a persisted session. With <id> resumes directly; without, opens a picker scoped to --cwd.',
        )
        .option(
          '-c, --continue',
          'Resume the most-recently-active session in the current directory.',
          false,
        )
        .option('--no-claude-compat', 'Skip .claude/commands/ and .claude/skills/ discovery')
        .option('--no-skills', 'Skip skill discovery and system-prompt injection'),
    ),
  ).action(async (opts) => {
    const cwd = opts.cwd ?? process.cwd();
    if (opts.session && opts.resume !== undefined) {
      process.stderr.write(
        'warning: --session takes precedence over --resume; --resume ignored\n',
      );
    }
    if (opts.session && opts.continue) {
      process.stderr.write(
        'warning: --session takes precedence over --continue; --continue ignored\n',
      );
    }
    let session: string | undefined = opts.session;
    if (!session && opts.continue) {
      const latest = await findLatestSessionInCwd(cwd, opts.home);
      if (!latest) {
        process.stderr.write(
          `No sessions in ${cwd}. Run \`chimera\` to start a new one.\n`,
        );
        process.exit(1);
      }
      session = latest.id;
    }
    if (!session && opts.resume !== undefined) {
      // `--resume` with a value: opts.resume is the id (a string).
      // `--resume` with no value: commander's `[id]` form yields `true`.
      if (typeof opts.resume === 'string') {
        session = opts.resume;
      } else {
        const picked = await pickSessionInteractive(cwd, opts.home);
        if (!picked) process.exit(1);
        session = picked;
      }
    }
    const userSuppliedId =
      typeof opts.session === 'string'
        ? opts.session
        : typeof opts.resume === 'string'
          ? opts.resume
          : null;
    if (session && userSuppliedId && session === userSuppliedId) {
      try {
        session = await resolveSessionId(session, {
          home: opts.home,
          cwd,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      }
    }
    await runInteractive({
      cwd,
      model: opts.model,
      maxSteps: opts.maxSteps,
      autoApprove: opts.autoApprove,
      session,
      claudeCompat: opts.claudeCompat,
      skills: opts.skills,
      sandboxFlags: opts,
      subagents: opts.subagents,
      maxSubagentDepth: opts.maxSubagentDepth,
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
