import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MountOptions } from '../src/mount';
import { type Mounted, mount } from './harness';

let directory: string;
let mounted: Mounted | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'chimera-memory-command-'));
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  rmSync(directory, { recursive: true, force: true });
});

async function runMemory(overrides: Partial<MountOptions>): Promise<string> {
  mounted = await mount(overrides);
  await mounted.keys('/memory\r', 80);
  return mounted.screen();
}

describe('/memory', () => {
  it('opens the memory index in the editor, creating it first', async () => {
    const indexPath = join(directory, 'memory', 'MEMORY.md');
    const opened: Array<{ path: string; existed: boolean }> = [];

    const screen = await runMemory({
      memoryIndexPath: indexPath,
      openFileInEditor: async ({ path }) => {
        opened.push({ path, existed: existsSync(path) });
        return { ok: true };
      },
    });

    expect(opened).toEqual([{ path: indexPath, existed: true }]);
    expect(readFileSync(indexPath, 'utf8')).toBe('# Memory index\n\n');
    expect(screen.replace(/\s+/g, ' ')).toContain(
      `note memory index saved: ${indexPath} · /reload brings it into this session`,
    );
  });

  it('says what went wrong when the editor fails', async () => {
    const screen = await runMemory({
      memoryIndexPath: join(directory, 'MEMORY.md'),
      openFileInEditor: async () => ({ ok: false, reason: 'editor exited with status 1' }),
    });

    expect(screen).toContain('   note  memory: editor exited with status 1');
  });

  it('says so when project memory is not available', async () => {
    const screen = await runMemory({});

    expect(screen).toContain('   note  project memory is not available in this session');
  });
});
