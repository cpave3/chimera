import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReloadingCommandRegistry } from '../src/reloading';

const DEBOUNCE = 20;

async function waitForChange(
  registry: ReloadingCommandRegistry,
  ms = 500,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`timed out waiting for registry change (${ms}ms)`));
    }, ms);
    unsubscribe = registry.onChange(() => {
      clearTimeout(timer);
      unsubscribe?.();
      resolve();
    });
  });
}

describe('ReloadingCommandRegistry', () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-reload-'));
    cwd = join(home, 'proj');
    await mkdir(join(cwd, '.chimera', 'commands'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('loads initial commands at construction', async () => {
    await writeFile(join(cwd, '.chimera', 'commands', 'hi.md'), 'Hello!');
    const registry = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(registry.find('hi')?.body).toBe('Hello!');
    } finally {
      registry.close();
    }
  });

  it('picks up a new .md file and fires onChange once', async () => {
    const registry = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(registry.list()).toEqual([]);
      const changed = waitForChange(registry);
      await writeFile(join(cwd, '.chimera', 'commands', 'new.md'), 'Body');
      await changed;
      expect(registry.find('new')?.body).toBe('Body');
    } finally {
      registry.close();
    }
  });

  it('reflects modifications to an existing command', async () => {
    await writeFile(join(cwd, '.chimera', 'commands', 'hi.md'), 'v1');
    const registry = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(registry.find('hi')?.body).toBe('v1');
      const changed = waitForChange(registry);
      await writeFile(join(cwd, '.chimera', 'commands', 'hi.md'), 'v2');
      await changed;
      expect(registry.find('hi')?.body).toBe('v2');
    } finally {
      registry.close();
    }
  });

  it('drops a deleted command', async () => {
    await writeFile(join(cwd, '.chimera', 'commands', 'gone.md'), 'bye');
    const registry = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(registry.find('gone')).toBeDefined();
      const changed = waitForChange(registry);
      await unlink(join(cwd, '.chimera', 'commands', 'gone.md'));
      await changed;
      expect(registry.find('gone')).toBeUndefined();
    } finally {
      registry.close();
    }
  });

  it('coalesces a burst of writes into a single onChange', async () => {
    const registry = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: 60,
    });
    try {
      let notifications = 0;
      registry.onChange(() => {
        notifications += 1;
      });
      // Five rapid writes to five different files.
      for (let i = 0; i < 5; i += 1) {
        await writeFile(join(cwd, '.chimera', 'commands', `f${i}.md`), `b${i}`);
      }
      // Wait for debounce + slack.
      await new Promise((r) => setTimeout(r, 150));
      expect(notifications).toBe(1);
      expect(registry.list()).toHaveLength(5);
    } finally {
      registry.close();
    }
  });

  it('manual reload() re-reads disk and fires onChange', async () => {
    const registry = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: 10_000, // effectively disable file-watch side for this test
    });
    try {
      let notifications = 0;
      registry.onChange(() => {
        notifications += 1;
      });
      // Write the file but do NOT wait for fs.watch to fire — use reload().
      await writeFile(join(cwd, '.chimera', 'commands', 'only-manual.md'), 'ok');
      await registry.reload();
      expect(notifications).toBe(1);
      expect(registry.find('only-manual')?.body).toBe('ok');
    } finally {
      registry.close();
    }
  });

  it('picks up a file added inside a nested namespace directory', async () => {
    await mkdir(join(cwd, '.chimera', 'commands', 'ops'), { recursive: true });
    const registry = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(registry.find('ops:deploy')).toBeUndefined();
      const changed = waitForChange(registry);
      await writeFile(join(cwd, '.chimera', 'commands', 'ops', 'deploy.md'), 'ship it');
      await changed;
      expect(registry.find('ops:deploy')?.body).toBe('ship it');
    } finally {
      registry.close();
    }
  });

  it('close() stops firing events on subsequent writes', async () => {
    const registry = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    let notifications = 0;
    registry.onChange(() => {
      notifications += 1;
    });
    registry.close();
    await writeFile(join(cwd, '.chimera', 'commands', 'after.md'), 'x');
    await new Promise((r) => setTimeout(r, 150));
    expect(notifications).toBe(0);
  });
});
