import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundProcessManager } from '../src/background';
import { LocalExecutor } from '../src/local-executor';

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('BackgroundProcessManager', () => {
  let root: string;
  let manager: BackgroundProcessManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-bg-'));
    manager = new BackgroundProcessManager({ cwd: root });
  });

  afterEach(async () => {
    manager.killAll();
    await rm(root, { recursive: true, force: true });
  });

  it('launches a process and returns its output incrementally', async () => {
    const launched = manager.launch(
      'echo first; while [ ! -f go ]; do sleep 0.05; done; echo second',
    );
    expect(launched.id).toMatch(/^shell_\d+$/);
    expect(launched.status).toBe('running');

    let accumulated = '';
    await until(() => {
      accumulated += manager.readOutput(launched.id)?.stdout ?? '';
      return accumulated.includes('first');
    });
    expect(accumulated).not.toContain('second');

    await new LocalExecutor({ cwd: root }).writeFile('go', '');
    await until(() => manager.get(launched.id)?.status === 'exited');
    const finalRead = manager.readOutput(launched.id);
    expect(finalRead?.stdout).toContain('second');
    expect(finalRead?.stdout).not.toContain('first');
    expect(finalRead?.exitCode).toBe(0);
  });

  it('fires onExit with the exit code when the process finishes', async () => {
    const notices: unknown[] = [];
    const notifying = new BackgroundProcessManager({
      cwd: root,
      onExit: (notice) => notices.push(notice),
    });
    const launched = notifying.launch('exit 3');
    await until(() => notices.length === 1);
    expect(notices[0]).toMatchObject({
      shellId: launched.id,
      command: 'exit 3',
      status: 'exited',
      exitCode: 3,
    });
  });

  it('kill terminates a running process and marks it killed', async () => {
    const launched = manager.launch('sleep 30');
    expect(manager.kill(launched.id)).toBe(true);
    await until(() => manager.get(launched.id)?.status !== 'running');
    expect(manager.get(launched.id)?.status).toBe('killed');
    expect(manager.kill(launched.id)).toBe(false);
  });

  it('readOutput returns null for unknown ids', () => {
    expect(manager.readOutput('shell_999')).toBeNull();
  });
});
