import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeSystemPrompt, discoverAgentsFiles } from '../src/prompts/compose';

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
});
