import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentsFromConfig, loadReloadingAgentsFromConfig } from '../src/agents-loader';
import { loadCommandsFromConfig, loadReloadingCommandsFromConfig } from '../src/commands-loader';
import { loadModesFromConfig } from '../src/modes-loader';
import { loadSkillsFromConfig } from '../src/skills-loader';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bundle loader integration', () => {
  it.each([
    ['commands', loadCommandsFromConfig],
    ['commands', loadReloadingCommandsFromConfig],
    ['agents', loadAgentsFromConfig],
    ['agents', loadReloadingAgentsFromConfig],
    ['skills', loadSkillsFromConfig],
    ['modes', loadModesFromConfig],
  ] as const)('passes %s bundles into discovery (%#)', (asset, load) => {
    const home = mkdtempSync(join(tmpdir(), 'chimera-bundle-loader-'));
    roots.push(home);
    const directory = join(home, 'mod');
    const path =
      asset === 'skills'
        ? join(directory, 'assets/audit/SKILL.md')
        : join(directory, 'assets/audit.md');
    mkdirSync(asset === 'skills' ? join(directory, 'assets/audit') : join(directory, 'assets'), {
      recursive: true,
    });
    writeFileSync(path, '---\nname: audit\ndescription: Audit code\n---\nAudit body');
    const registry = load({
      cwd: home,
      home,
      config: {},
      modBundles: [{ name: 'audit-mod', directory, manifest: { [asset]: 'assets' } }],
    });
    try {
      expect(registry.find('audit')).toMatchObject({ source: 'mod:audit-mod', path });
    } finally {
      if ('close' in registry && typeof registry.close === 'function') registry.close();
    }
  });
});
