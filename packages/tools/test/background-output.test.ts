import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BackgroundExitNotice,
  type BackgroundOutputBatch,
  BackgroundProcessManager,
} from '../src/background';

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Observed =
  | ({ kind: 'output' } & BackgroundOutputBatch)
  | ({ kind: 'exit' } & BackgroundExitNotice);

describe('BackgroundProcessManager output tap', () => {
  let root: string;
  let manager: BackgroundProcessManager;
  let observed: Observed[];

  const outputs = () =>
    observed.filter((event): event is { kind: 'output' } & BackgroundOutputBatch => {
      return event.kind === 'output';
    });

  function track(options: { maxOutputBytes?: number; maxBatchBytes?: number } = {}) {
    manager = new BackgroundProcessManager({
      cwd: root,
      maxOutputBytes: options.maxOutputBytes,
      output: {
        intervalMs: 50,
        maxBatchBytes: options.maxBatchBytes,
        onBatch: (batch) => observed.push({ kind: 'output', ...batch }),
      },
      onExit: (notice) => observed.push({ kind: 'exit', ...notice }),
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-bg-output-'));
    observed = [];
  });

  afterEach(async () => {
    manager.killAll();
    await rm(root, { recursive: true, force: true });
  });

  it('delivers output in order with contiguous sequence numbers, then the exit', async () => {
    track();
    const launched = manager.launch('echo hi; sleep 0.3; echo bye >&2; sleep 0.2; echo end');
    await until(() => observed.some((event) => event.kind === 'exit'));

    expect(observed.at(-1)).toMatchObject({ kind: 'exit', shellId: launched.id, exitCode: 0 });
    const batches = outputs();
    expect(batches.map((batch) => batch.seq)).toEqual(batches.map((_, index) => index + 1));
    expect(batches.every((batch) => batch.shellId === launched.id)).toBe(true);
    expect(batches.map((batch) => [batch.stream, batch.text])).toEqual([
      ['stdout', 'hi\n'],
      ['stderr', 'bye\n'],
      ['stdout', 'end\n'],
    ]);
  });

  it('leaves what the agent reads unchanged', async () => {
    const command = 'echo one; echo two >&2; sleep 0.2; echo three';
    const plain = new BackgroundProcessManager({ cwd: root });
    const plainJob = plain.launch(command);
    track();
    const tappedJob = manager.launch(command);
    await until(
      () =>
        plain.get(plainJob.id)?.status === 'exited' &&
        observed.some((event) => event.kind === 'exit'),
    );
    expect(manager.readOutput(tappedJob.id)).toEqual(plain.readOutput(plainJob.id));
    expect(manager.readOutput(tappedJob.id)).toMatchObject({ stdout: '', stderr: '' });
  });

  it('bounds the rate and size of events for a chatty process', async () => {
    track({ maxBatchBytes: 1_000 });
    const startedAt = Date.now();
    const launched = manager.launch(
      'i=0; while [ $i -lt 400 ]; do echo "line $i of chatty output"; i=$((i+1)); done; sleep 0.3',
    );
    await until(() => observed.some((event) => event.kind === 'exit'));
    const elapsed = Date.now() - startedAt;
    const batches = outputs();

    // One flush per interval, at most one event per stream in each, plus the final flush.
    expect(batches.length).toBeLessThanOrEqual(2 * (Math.ceil(elapsed / 50) + 1));
    for (const batch of batches) {
      expect(Buffer.byteLength(batch.text)).toBeLessThanOrEqual(1_000);
    }
    const delivered = batches.reduce((sum, batch) => sum + Buffer.byteLength(batch.text), 0);
    const dropped = batches.reduce((sum, batch) => sum + (batch.droppedBytes ?? 0), 0);
    expect(dropped).toBeGreaterThan(0);
    const agentRead = manager.readOutput(launched.id)!;
    expect(delivered + dropped).toBe(Buffer.byteLength(agentRead.stdout));
    expect(batches[0]!.text.startsWith('line 0 of chatty output\n')).toBe(true);
  });

  it('flushes the output of a killed process before its exit and nothing after', async () => {
    track();
    const launched = manager.launch('echo started; sleep 30');
    await until(() => outputs().length > 0);
    manager.kill(launched.id);
    await until(() => observed.some((event) => event.kind === 'exit'));
    await new Promise((r) => setTimeout(r, 120));

    expect(observed).toEqual([
      { kind: 'output', shellId: launched.id, stream: 'stdout', text: 'started\n', seq: 1 },
      expect.objectContaining({ kind: 'exit', shellId: launched.id, status: 'killed' }),
    ]);
  });

  it('sends only what the output limit lets the agent see, and flags truncation', async () => {
    track({ maxOutputBytes: 4 });
    manager.launch('printf abcdef');
    await until(() => observed.some((event) => event.kind === 'exit'));
    expect(outputs()).toEqual([
      expect.objectContaining({ stream: 'stdout', text: 'abcd', seq: 1, truncated: true }),
    ]);
  });

  it('decodes multibyte characters split across chunks', async () => {
    track();
    manager.launch("printf '\\342\\202'; sleep 0.2; printf '\\254\\n'");
    await until(() => observed.some((event) => event.kind === 'exit'));
    expect(
      outputs()
        .map((batch) => batch.text)
        .join(''),
    ).toBe('€\n');
  });
});
