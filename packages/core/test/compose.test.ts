import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeSystemPrompt, discoverAgentsFiles } from '../src/prompts/compose';
import { ROLE_PROMPT } from '../src/prompts/role';

describe('composeSystemPrompt', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-prompt-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('includes the role prompt by default', () => {
    const out = composeSystemPrompt({ cwd: home, home });
    expect(out).toContain('Chimera');
    expect(out).toContain('bash');
  });

  it('includes core behavioral rules in the role prompt', () => {
    const out = composeSystemPrompt({ cwd: home, home });
    // Read-before-edit rule
    expect(out).toMatch(/Read a file before editing/i);
    // Trust-internal / validate-at-boundaries rule
    expect(out).toMatch(/Validate only at system boundaries/i);
    // Verify-before-claim-done rule
    expect(out).toMatch(/verify it works/i);
    // Risky-actions section
    expect(out).toContain('## Risky actions');
    // Parallel-tools rule
    expect(out).toMatch(/Call independent tools in parallel/i);
    // file:line output convention
    expect(out).toMatch(/path\/to\/file\.ts:42/);
  });

  it('walks up to a git root and concatenates AGENTS.md files with closer files last', async () => {
    const repo = join(home, 'repo');
    const sub = join(repo, 'pkg');
    await mkdir(sub, { recursive: true });
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, 'AGENTS.md'), 'ROOT-INSTRUCTIONS');
    await writeFile(join(sub, 'AGENTS.md'), 'SUB-INSTRUCTIONS');

    const files = discoverAgentsFiles(sub, home);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/\/repo\/AGENTS\.md$/);
    expect(files[1]).toMatch(/\/pkg\/AGENTS\.md$/);

    const prompt = composeSystemPrompt({ cwd: sub, home });
    const rootIdx = prompt.indexOf('ROOT-INSTRUCTIONS');
    const subIdx = prompt.indexOf('SUB-INSTRUCTIONS');
    expect(rootIdx).toBeGreaterThan(0);
    expect(subIdx).toBeGreaterThan(rootIdx);
  });

  it('runs extension hooks after AGENTS.md concatenation', () => {
    const prompt = composeSystemPrompt({
      cwd: home,
      home,
      extensions: [() => '=== SKILL INDEX ==='],
    });
    expect(prompt).toContain('=== SKILL INDEX ===');
    expect(prompt.indexOf('Chimera')).toBeLessThan(prompt.indexOf('=== SKILL INDEX ==='));
  });

  it('places the Chimera Session block before any AGENTS.md content', async () => {
    const repo = join(home, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, 'AGENTS.md'), 'PROJECT-INSTRUCTIONS');
    const prompt = composeSystemPrompt({ cwd: repo, home });
    const sessionIdx = prompt.indexOf('# Chimera Session');
    const agentsIdx = prompt.indexOf('PROJECT-INSTRUCTIONS');
    expect(sessionIdx).toBeGreaterThan(0);
    expect(agentsIdx).toBeGreaterThan(sessionIdx);
  });

  it('includes a Chimera Session block after the role prompt and before extensions', () => {
    const prompt = composeSystemPrompt({
      cwd: home,
      home,
      extensions: [() => '=== SKILL INDEX ==='],
    });
    expect(prompt).toContain('# Chimera Session');
    expect(prompt).toContain(`- cwd: ${home}`);
    expect(prompt).toMatch(/^- platform: /m);
    expect(prompt).toMatch(/^- os: /m);
    expect(prompt).toMatch(/^- date: \d{4}-\d{2}-\d{2}$/m);
    const envIdx = prompt.indexOf('# Chimera Session');
    const skillIdx = prompt.indexOf('=== SKILL INDEX ===');
    expect(prompt.indexOf(ROLE_PROMPT)).toBe(0);
    expect(prompt.indexOf(ROLE_PROMPT)).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(skillIdx);
  });

  it('includes the model identity in the Environment block when provided', () => {
    const prompt = composeSystemPrompt({
      cwd: home,
      home,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6' },
    });
    expect(prompt).toContain('- model: anthropic/claude-opus-4-6');
  });

  it('omits the model line when no model is provided', () => {
    const prompt = composeSystemPrompt({ cwd: home, home });
    expect(prompt).not.toContain('- model:');
  });

  it('includes a sandbox line and mode hint when sandboxMode is bind', () => {
    const prompt = composeSystemPrompt({ cwd: home, home, sandboxMode: 'bind' });
    expect(prompt).toMatch(/^- sandbox: bind — /m);
    expect(prompt).toContain('bind-mounted rw');
  });

  it('includes overlay-specific hint for sandboxMode=overlay', () => {
    const prompt = composeSystemPrompt({ cwd: home, home, sandboxMode: 'overlay' });
    expect(prompt).toMatch(/^- sandbox: overlay — /m);
    expect(prompt).toContain('/apply');
  });

  it('includes ephemeral hint for sandboxMode=ephemeral', () => {
    const prompt = composeSystemPrompt({ cwd: home, home, sandboxMode: 'ephemeral' });
    expect(prompt).toMatch(/^- sandbox: ephemeral — /m);
    expect(prompt).toContain('discarded');
  });

  it("emits 'sandbox: off' explicitly so the model never has to infer", () => {
    const prompt = composeSystemPrompt({ cwd: home, home, sandboxMode: 'off' });
    expect(prompt).toMatch(/^- sandbox: off — /m);
    expect(prompt).toContain('no sandbox');
  });

  it('omits the sandbox line entirely when sandboxMode is unset', () => {
    const prompt = composeSystemPrompt({ cwd: home, home });
    expect(prompt).not.toContain('- sandbox:');
  });
});
