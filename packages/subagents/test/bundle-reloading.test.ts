import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ReloadingAgentRegistry } from '../src/agents/reloading';

it('reloads bundled agent edits through its public registry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'chimera-agent-bundle-reload-'));
  const directory = join(home, 'mod');
  mkdirSync(join(directory, 'reviewers'), { recursive: true });
  const path = join(directory, 'reviewers/audit.md');
  writeFileSync(path, '---\ndescription: Audit code\n---\nBefore');
  const registry = new ReloadingAgentRegistry({
    cwd: home,
    userHome: home,
    modBundles: [{ name: 'audit', directory, manifest: { agents: 'reviewers' } }],
    debounceMs: 10,
  });
  try {
    expect(registry.find('audit')?.source).toBe('mod:audit');
    writeFileSync(path, '---\ndescription: Audit code\n---\nAfter');
    await expect.poll(() => registry.find('audit')?.body, { timeout: 1000 }).toBe('After');
  } finally {
    registry.close();
    rmSync(home, { recursive: true, force: true });
  }
});
