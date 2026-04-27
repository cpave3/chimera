import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, release as osRelease, type as osType } from 'node:os';
import type { ModelConfig, SandboxMode } from '../types';
import { ROLE_PROMPT } from './role';

export interface ComposeOptions {
  cwd: string;
  home?: string;
  model?: Pick<ModelConfig, 'providerId' | 'modelId'>;
  sandboxMode?: SandboxMode;
  extensions?: ((ctx: { cwd: string }) => string | null)[];
  /**
   * Active mode block, appended last. Composers pass `{ name, body }` from the
   * resolved Mode object; the rendered section is `# Current mode: <name>`
   * followed by the body verbatim. Replaces nothing else in the prompt.
   */
  mode?: { name: string; body: string };
}

const SANDBOX_HINTS: Record<SandboxMode, string> = {
  off: "no sandbox; tools run directly on the host. 'target' defaults to 'host' and may be omitted on bash calls.",
  bind: "file tools and bash (default target='sandbox') run inside a Docker container with the host cwd bind-mounted rw; writes appear on the host immediately.",
  overlay:
    "file tools and bash (default target='sandbox') run inside a Docker container with the host cwd as an overlayfs lowerdir; writes go to a per-session upperdir and only land on the host when the user runs `/apply`.",
  ephemeral:
    "file tools and bash (default target='sandbox') run inside a Docker container with a tmpfs upperdir; all writes are discarded at session end.",
};

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
  if (opts.sandboxMode) {
    lines.push(`- sandbox: ${opts.sandboxMode} — ${SANDBOX_HINTS[opts.sandboxMode]}`);
  }
  return lines.join('\n');
}

/**
 * Walk from cwd up to nearest git root (or home), collecting AGENTS.md files.
 * Returns in order root-first, closer-last so that closer files override.
 */
export function discoverAgentsFiles(cwd: string, home = homedir()): string[] {
  const files: string[] = [];
  let dir = resolve(cwd);
  const stopAt = resolve(home);
  let hitGitRoot = false;

  while (true) {
    const candidate = join(dir, 'AGENTS.md');
    try {
      const st = statSync(candidate);
      if (st.isFile()) files.push(candidate);
    } catch {
      // absent
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

export function composeSystemPrompt(opts: ComposeOptions): string {
  // Order: role → session block (system-injected) → AGENTS.md files
  // (user-authored) → extensions. The session block goes BEFORE AGENTS.md
  // so the model can't mistake it for one of them.
  const parts: string[] = [ROLE_PROMPT, `\n\n${buildEnvironmentBlock(opts)}`];

  const files = discoverAgentsFiles(opts.cwd, opts.home);
  for (const f of files) {
    try {
      const body = readFileSync(f, 'utf8');
      parts.push(`\n\n# ${f}\n\n${body}`);
    } catch {
      // race: file vanished; skip
    }
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
