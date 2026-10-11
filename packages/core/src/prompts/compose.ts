import { readFileSync, statSync } from 'node:fs';
import { homedir, release as osRelease, type as osType } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ModelConfig, PromptStyle, SandboxMode } from '../types';
import { composeRolePrompt, type PromptTool } from './role';

export interface ComposeOptions {
  cwd: string;
  home?: string;
  model?: Pick<ModelConfig, 'providerId' | 'modelId'>;
  sandboxMode?: SandboxMode;
  /**
   * Set when host bash commands run in the operating system's sandbox. It
   * applies only without a Docker sandbox.
   */
  osSandbox?: { network: 'on' | 'off' };
  extensions?: ((ctx: { cwd: string }) => string | null)[];
  /**
   * Active mode block, appended last. Composers pass `{ name, body }` from the
   * resolved Mode object; the rendered section is `# Current mode: <name>`
   * followed by the body verbatim. Replaces nothing else in the prompt.
   */
  mode?: { name: string; body: string };
  /**
   * The tools registered for this session, after the mode allowlist. When
   * omitted the tools section carries only the file-access rules.
   */
  tools?: PromptTool[];
  /** Defaults to `lean`. */
  promptStyle?: PromptStyle;
}

const SANDBOX_HINTS: Record<SandboxMode, string> = {
  off: "no sandbox; tools run directly on the host. 'target' defaults to 'host' and may be omitted on bash calls.",
  bind: "file tools and bash (default target='sandbox') run inside a Docker container with the host cwd bind-mounted rw; writes appear on the host immediately.",
  overlay:
    "file tools and bash (default target='sandbox') run inside a Docker container with the host cwd as an overlayfs lowerdir; writes go to a per-session upperdir and only land on the host when the user runs `/apply`.",
  ephemeral:
    "file tools and bash (default target='sandbox') run inside a Docker container with a tmpfs upperdir; all writes are discarded at session end.",
};

function osSandboxHint(network: 'on' | 'off'): string {
  const limits =
    network === 'off'
      ? 'they read every file, write only in the working directory and the temp directory, and have no network access'
      : 'they read every file and write only in the working directory and the temp directory';
  return `tools run on the host, and bash commands run in an OS sandbox: ${limits}. For a command that must do more, set unsandboxed: true with a short reason; that call needs approval. 'target' defaults to 'host' and may be omitted on bash calls.`;
}

/** The session's OS sandbox, which a Docker sandbox replaces. */
function activeOsSandbox(opts: ComposeOptions): ComposeOptions['osSandbox'] {
  return opts.sandboxMode === 'off' ? opts.osSandbox : undefined;
}

/**
 * Build the `# Chimera Session` block. The header is deliberately distinct
 * from `# Environment` (which the model tends to attribute to one of the
 * AGENTS.md files concatenated below) and from anything a user is likely to
 * write in their own AGENTS.md.
 */
function buildEnvironmentBlock(opts: ComposeOptions): string {
  // Date is rebuilt per call; if a prompt cache is added, exclude this line from the cache key.
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    '# Chimera Session',
    '',
    'The values below are injected by the Chimera runtime for this session — they are not from any AGENTS.md file.',
    '',
    `- cwd: ${opts.cwd.replace(/\n/g, ' ')}`,
    `- platform: ${process.platform}`,
    `- os: ${osType()} ${osRelease()}`,
    `- date: ${date}`,
  ];
  if (opts.model) {
    lines.push(`- model: ${opts.model.providerId}/${opts.model.modelId}`);
  }
  const osSandbox = activeOsSandbox(opts);
  if (osSandbox) {
    lines.push(`- sandbox: os — ${osSandboxHint(osSandbox.network)}`);
  } else if (opts.sandboxMode) {
    lines.push(`- sandbox: ${opts.sandboxMode} — ${SANDBOX_HINTS[opts.sandboxMode]}`);
  }
  return lines.join('\n');
}

/**
 * Walk from cwd up to nearest git root (or home), collecting AGENTS.md and
 * optional AGENTS.local.md files at each level.  Returns in order
 * root-first, closer-last so that closer files override.
 */
export function discoverAgentsFiles(cwd: string, home = homedir()): string[] {
  const files: string[] = [];
  let dir = resolve(cwd);
  const stopAt = resolve(home);
  let hitGitRoot = false;

  while (true) {
    const agentsCandidate = join(dir, 'AGENTS.md');
    const claudeCandidate = join(dir, 'CLAUDE.md');
    const localCandidate = join(dir, 'AGENTS.local.md');
    let foundAtThisLevel = false;

    // Push AGENTS.local.md BEFORE the non-local file so that after the
    // final reverse() it appears AFTER the non-local file at the same level.
    try {
      const st = statSync(localCandidate);
      if (st.isFile()) {
        files.push(localCandidate);
      }
    } catch {
      // AGENTS.local.md absent
    }

    try {
      const st = statSync(agentsCandidate);
      if (st.isFile()) {
        files.push(agentsCandidate);
        foundAtThisLevel = true;
      }
    } catch {
      // AGENTS.md absent
    }

    if (!foundAtThisLevel) {
      try {
        const st = statSync(claudeCandidate);
        if (st.isFile()) {
          files.push(claudeCandidate);
        }
      } catch {
        // CLAUDE.md absent
      }
    }

    try {
      const gitStat = statSync(join(dir, '.git'));
      if (gitStat.isDirectory() || gitStat.isFile()) {
        hitGitRoot = true;
      }
    } catch {
      // not a git root
    }

    if (hitGitRoot) break;
    if (dir === stopAt) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Closer (deeper) files should appear *later* so they override.
  // Walk collected in deep→shallow order; reverse to get shallow→deep.
  return files.reverse();
}

/** What one instruction file may add to the model's context. */
export const INSTRUCTION_FILE_LIMIT_BYTES = 32 * 1024;
const KIB = 1024;

export interface InstructionFile {
  content: string;
  /** Size of the file on disk. */
  bytes: number;
  /** True when `content` is the start of the file only. */
  cut: boolean;
}

/**
 * Read an instruction file for the model. A file over the limit is cut at
 * a line boundary and ends with a line that says so, so the model knows it
 * has not seen everything. Returns null when the file cannot be read.
 */
export function readInstructionFile(path: string): InstructionFile | null {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return null;
  }
  if (raw.byteLength <= INSTRUCTION_FILE_LIMIT_BYTES) {
    return { content: raw.toString('utf8'), bytes: raw.byteLength, cut: false };
  }
  const head = raw.subarray(0, INSTRUCTION_FILE_LIMIT_BYTES).toString('utf8');
  const lastBreak = head.lastIndexOf('\n');
  // A file that is one long line has no boundary to cut at.
  const kept = lastBreak > 0 ? head.slice(0, lastBreak + 1) : head;
  const note = `[This file was cut: only the first ${INSTRUCTION_FILE_LIMIT_BYTES / KIB} KiB of ${Math.round(raw.byteLength / KIB)} KiB are shown.]`;
  return { content: `${kept}\n${note}`, bytes: raw.byteLength, cut: true };
}

/** The instruction files of the system prompt that are over the size limit. */
export function oversizedInstructionFiles(
  cwd: string,
  home?: string,
): Array<{ path: string; bytes: number }> {
  const oversized: Array<{ path: string; bytes: number }> = [];
  for (const path of discoverAgentsFiles(cwd, home)) {
    try {
      const bytes = statSync(path).size;
      if (bytes > INSTRUCTION_FILE_LIMIT_BYTES) oversized.push({ path, bytes });
    } catch {
      // gone since discovery
    }
  }
  return oversized;
}

export function composeSystemPrompt(opts: ComposeOptions): string {
  // Order: role → session block (system-injected) → AGENTS.md / AGENTS.local.md
  // files (user-authored) → extensions. The session block goes BEFORE AGENTS.md
  // so the model can't mistake it for one of them.
  const parts: string[] = [
    composeRolePrompt({
      tools: opts.tools,
      promptStyle: opts.promptStyle,
      osSandbox: activeOsSandbox(opts) !== undefined,
    }),
    `\n\n${buildEnvironmentBlock(opts)}`,
  ];

  const files = discoverAgentsFiles(opts.cwd, opts.home);
  for (const f of files) {
    const file = readInstructionFile(f);
    // null: the file vanished since discovery
    if (file) parts.push(`\n\n# ${f}\n\n${file.content}`);
  }

  for (const ext of opts.extensions ?? []) {
    const chunk = ext({ cwd: opts.cwd });
    if (chunk) parts.push(`\n\n${chunk}`);
  }

  if (opts.mode) {
    parts.push(`\n\n# Current mode: ${opts.mode.name}\n\n${opts.mode.body}`);
  }

  return parts.join('');
}
