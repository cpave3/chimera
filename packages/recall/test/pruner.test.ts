import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecallPruner } from '../src/pruner';
import { RecallStore } from '../src/store';

const SESSION_ID = '01TESTPRUNER00000000000000';

function toolPair(callId: string, toolName: string, output: unknown): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: callId, toolName, input: { path: `/f-${callId}` } },
      ],
    } as ModelMessage,
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: callId, toolName, output }],
    } as ModelMessage,
  ];
}

describe('createRecallPruner', () => {
  let home: string;
  let store: RecallStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-pruner-'));
    store = new RecallStore({ sessionId: SESSION_ID, home });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('replaces oversized tool-result outputs with recall stubs and archives them', async () => {
    const big = 'line\n'.repeat(2000);
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      ...toolPair('c1', 'bash', { type: 'json', value: { stdout: big } }),
      { role: 'assistant', content: 'done' },
    ];
    const pruner = createRecallPruner(store, { archiveThresholdTokens: 100 });
    const result = await pruner.prune(messages, messages.length);

    expect(result.archivedCount).toBe(1);
    expect(result.tokensSaved).toBeGreaterThan(1000);
    expect(result.archived[0]!.id).toMatch(/^pr_[0-9a-f]{8}$/);
    expect(result.archived[0]!.toolName).toBe('bash');

    const toolMsg = messages[2]!;
    const part = (toolMsg.content as Array<{ output?: unknown }>)[0]!;
    const stub = part.output as { type: string; value: string };
    expect(stub.type).toBe('text');
    expect(stub.value).toContain('[Result archived — retrieve with: recall({ id: "pr_');

    // JSON outputs are archived as their serialized form.
    const entry = await store.get(result.archived[0]!.id);
    expect(entry?.content).toContain('"stdout"');
    expect(entry?.content).toContain('line\\nline');
    // The assistant tool-call args remain intact.
    const callMsg = messages[1]!;
    const callPart = (callMsg.content as Array<{ input?: unknown }>)[0]!;
    expect(callPart.input).toEqual({ path: '/f-c1' });
  });

  it('leaves small outputs untouched', async () => {
    const messages: ModelMessage[] = [...toolPair('c1', 'read', { type: 'text', value: 'tiny' })];
    const pruner = createRecallPruner(store, { archiveThresholdTokens: 100 });
    const result = await pruner.prune(messages, messages.length);
    expect(result.archivedCount).toBe(0);
    const part = (messages[1]!.content as Array<{ output?: unknown }>)[0]!;
    expect(part.output).toEqual({ type: 'text', value: 'tiny' });
  });

  it('does not touch results at or beyond endIndex (the keep-tail)', async () => {
    const big = 'x'.repeat(10_000);
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      ...toolPair('c1', 'bash', { type: 'text', value: big }),
    ];
    const pruner = createRecallPruner(store, { archiveThresholdTokens: 100 });
    // endIndex = 1: only the user message is prunable territory.
    const result = await pruner.prune(messages, 1);
    expect(result.archivedCount).toBe(0);
    const part = (messages[2]!.content as Array<{ output?: unknown }>)[0]!;
    expect((part.output as { value: string }).value).toBe(big);
  });

  it('does not re-archive stubs on a second pass', async () => {
    const big = 'y'.repeat(10_000);
    const messages: ModelMessage[] = [...toolPair('c1', 'bash', { type: 'text', value: big })];
    const pruner = createRecallPruner(store, { archiveThresholdTokens: 100 });
    await pruner.prune(messages, messages.length);

    const dir = join(home, '.chimera', 'recall', SESSION_ID);
    const countAfterFirst = (await readdir(dir)).length;
    const second = await pruner.prune(messages, messages.length);
    expect(second.archivedCount).toBe(0);
    expect((await readdir(dir)).length).toBe(countAfterFirst);
  });

  it('handles plain string outputs (no discriminated union)', async () => {
    const big = 'z'.repeat(10_000);
    const messages: ModelMessage[] = [...toolPair('c1', 'grep', big)];
    const pruner = createRecallPruner(store, { archiveThresholdTokens: 100 });
    const result = await pruner.prune(messages, messages.length);
    expect(result.archivedCount).toBe(1);
    const entry = await store.get(result.archived[0]!.id);
    expect(entry?.content).toBe(big);
  });
});
