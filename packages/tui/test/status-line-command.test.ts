import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLineCommand } from '../src/ledger/status-command';

const SCRIPT = join(import.meta.dirname, 'fixtures', 'status-line-command.mjs');

describe('StatusLineCommand', () => {
  let dir: string;
  let log: string;
  let command: StatusLineCommand | undefined;
  const updates: string[][] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chimera-status-'));
    log = join(dir, 'runs.log');
    updates.length = 0;
  });
  afterEach(() => {
    command?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(options: { timeoutMs?: number; debounceMs?: number } = {}) {
    command = new StatusLineCommand({
      command: `node ${SCRIPT}`,
      cwd: dir,
      env: { ...process.env, STATUS_LOG: log },
      debounceMs: options.debounceMs ?? 30,
      timeoutMs: options.timeoutMs ?? 5_000,
      onOutput: (lines) => updates.push(lines),
    });
    return command;
  }

  const payload = (id: string) => ({ model: { id }, chimera: { mode: 'build' } });
  const runs = () => readFileSync(log, 'utf8').trim().split('\n');

  it('passes the payload on stdin with COLUMNS set, and reports every output line', async () => {
    start().update(payload('m1'), 88);
    await vi.waitFor(() => expect(updates).toHaveLength(1), { timeout: 5_000 });
    expect(updates[0]).toEqual(['model m1 · build · 88 cols', 'second row']);
    expect(command!.lines).toEqual(updates[0]);
  });

  it('runs once for a burst of events inside the debounce', async () => {
    const statusCommand = start({ debounceMs: 80 });
    statusCommand.update(payload('a'), 80);
    statusCommand.update(payload('b'), 80);
    statusCommand.update(payload('c'), 80);
    await vi.waitFor(() => expect(updates).toHaveLength(1), { timeout: 5_000 });
    expect(runs()).toEqual(['c']);
    expect(updates[0]![0]).toContain('model c');
  });

  it('cancels a run in flight when a new event arrives', async () => {
    const statusCommand = start();
    statusCommand.update(payload('slow2000'), 80);
    await vi.waitFor(() => expect(runs()).toEqual(['slow2000']), { timeout: 5_000 });
    statusCommand.update(payload('fast'), 80);
    await vi.waitFor(() => expect(updates).toHaveLength(1), { timeout: 5_000 });
    expect(updates[0]![0]).toContain('model fast');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(updates).toHaveLength(1);
  });

  it('keeps the last good output when a run times out', async () => {
    const statusCommand = start({ timeoutMs: 400 });
    statusCommand.update(payload('good'), 80);
    await vi.waitFor(() => expect(updates).toHaveLength(1), { timeout: 5_000 });
    statusCommand.update(payload('slow3000'), 80);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(updates).toHaveLength(1);
    expect(statusCommand.lines[0]).toContain('model good');
    expect(statusCommand.lastError).toMatch(/timed out/);
  });

  it('keeps the last good output when the command exits non-zero', async () => {
    const statusCommand = start();
    statusCommand.update(payload('good'), 80);
    await vi.waitFor(() => expect(updates).toHaveLength(1), { timeout: 5_000 });
    statusCommand.update(payload('fail'), 80);
    await vi.waitFor(() => expect(statusCommand.lastError).toMatch(/exit 3/), { timeout: 5_000 });
    expect(statusCommand.lines[0]).toContain('model good');
    expect(updates).toHaveLength(1);
  });
});
