import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReloadingCommandRegistry } from '../src/reloading';

const DEBOUNCE = 20;

async function waitForChange(reg: ReloadingCommandRegistry, ms = 500): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for registry change (${ms}ms)`));
    }, ms);
    const unsub = reg.onChange(() => {
      clearTimeout(timer);
      unsub();
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
    const reg = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(reg.find('hi')?.body).toBe('Hello!');
    } finally {
      reg.close();
    }
  });

  it('picks up a new .md file and fires onChange once', async () => {
    const reg = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(reg.list()).toEqual([]);
      const changed = waitForChange(reg);
      await writeFile(join(cwd, '.chimera', 'commands', 'new.md'), 'Body');
      await changed;
      expect(reg.find('new')?.body).toBe('Body');
    } finally {
      reg.close();
    }
  });

  it('reflects modifications to an existing command', async () => {
    await writeFile(join(cwd, '.chimera', 'commands', 'hi.md'), 'v1');
    const reg = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(reg.find('hi')?.body).toBe('v1');
      const changed = waitForChange(reg);
      await writeFile(join(cwd, '.chimera', 'commands', 'hi.md'), 'v2');
      await changed;
      expect(reg.find('hi')?.body).toBe('v2');
    } finally {
      reg.close();
    }
  });

  it('drops a deleted command', async () => {
    await writeFile(join(cwd, '.chimera', 'commands', 'gone.md'), 'bye');
    const reg = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(reg.find('gone')).toBeDefined();
      const changed = waitForChange(reg);
      await unlink(join(cwd, '.chimera', 'commands', 'gone.md'));
      await changed;
      expect(reg.find('gone')).toBeUndefined();
    } finally {
      reg.close();
    }
  });

  it('coalesces a burst of writes into a single onChange', async () => {
    const reg = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: 60,
    });
    try {
      let notifications = 0;
      reg.onChange(() => {
        notifications += 1;
      });
      // Five rapid writes to five different files.
      for (let i = 0; i < 5; i += 1) {
        await writeFile(join(cwd, '.chimera', 'commands', `f${i}.md`), `b${i}`);
      }
      // Wait for debounce + slack.
      await new Promise((r) => setTimeout(r, 150));
      expect(notifications).toBe(1);
      expect(reg.list()).toHaveLength(5);
    } finally {
      reg.close();
    }
  });

  it('manual reload() re-reads disk and fires onChange', async () => {
    const reg = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: 10_000, // effectively disable file-watch side for this test
    });
    try {
      let notifications = 0;
      reg.onChange(() => {
        notifications += 1;
      });
      // Write the file but do NOT wait for fs.watch to fire — use reload().
      await writeFile(join(cwd, '.chimera', 'commands', 'only-manual.md'), 'ok');
      await reg.reload();
      expect(notifications).toBe(1);
      expect(reg.find('only-manual')?.body).toBe('ok');
    } finally {
      reg.close();
    }
  });

  it('picks up a file added inside a nested namespace directory', async () => {
    await mkdir(join(cwd, '.chimera', 'commands', 'ops'), { recursive: true });
    const reg = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    try {
      expect(reg.find('ops:deploy')).toBeUndefined();
      const changed = waitForChange(reg);
      await writeFile(join(cwd, '.chimera', 'commands', 'ops', 'deploy.md'), 'ship it');
      await changed;
      expect(reg.find('ops:deploy')?.body).toBe('ship it');
    } finally {
      reg.close();
    }
  });

  it('close() stops firing events on subsequent writes', async () => {
    const reg = new ReloadingCommandRegistry({
      cwd,
      userHome: home,
      debounceMs: DEBOUNCE,
    });
    let notifications = 0;
    reg.onChange(() => {
      notifications += 1;
    });
    reg.close();
    await writeFile(join(cwd, '.chimera', 'commands', 'after.md'), 'x');
    await new Promise((r) => setTimeout(r, 150));
    expect(notifications).toBe(0);
  });
});
