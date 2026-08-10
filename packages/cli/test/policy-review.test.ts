import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runBashPolicyReview } from '../src/commands/policy-review';

const originalWrite = process.stdout.write;

afterEach(() => {
  process.stdout.write = originalWrite;
});

it('renders a persisted session bash review as structured JSON', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-cli-policy-review-'));
  const sessionId = '01ABCDEFGHJKMNPQRSTVWXYZ12';
  const sessionDir = join(home, '.chimera', 'sessions', sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, 'events.jsonl'),
    `${JSON.stringify({
      type: 'step_finished',
      toolCalls: [
        {
          callId: 'call-1',
          name: 'bash',
          args: { command: 'pnpm test' },
          target: 'host',
          startedAt: 1,
        },
      ],
    })}\n`,
  );
  const output: string[] = [];
  process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  await runBashPolicyReview({ sessionId: sessionId as never, home, json: true });

  expect(JSON.parse(output.join(''))).toMatchObject({
    summary: { total: 1, automatic: 1 },
    commands: [{ command: 'pnpm test', currentPolicy: { outcome: 'automatic' } }],
  });
});
