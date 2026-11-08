import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** The transcript after `events`, with each wrapped note joined back onto one line. */
async function transcriptAfter(...events: AgentEvent[]): Promise<string> {
  mounted = await mount();
  await mounted.event(...events);
  return mounted.screen().replace(/\s+/g, ' ');
}

describe('run recovery messages', () => {
  it('tells the user a failed step is being retried', async () => {
    const transcript = await transcriptAfter({
      type: 'provider_retry',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 2000,
      error: 'Overloaded',
    });

    expect(transcript).toContain('note provider error: Overloaded — retry 2/4 in 2s');
  });

  it('names the fallback model when a run moves to it', async () => {
    const transcript = await transcriptAfter({
      type: 'model_fallback',
      from: 'a/primary',
      to: 'a/backup',
      error: 'Overloaded',
    });

    expect(transcript).toContain('note a/primary is unavailable; finishing this run on a/backup');
  });

  it('reports an output cutoff and the continuation', async () => {
    const transcript = await transcriptAfter({
      type: 'output_continued',
      attempt: 1,
      maxAttempts: 2,
    });

    expect(transcript).toContain('note output limit reached; asking the model to continue (1/2)');
  });

  it('explains a run that ended on the output limit', async () => {
    const transcript = await transcriptAfter({ type: 'run_finished', reason: 'output_limit' });

    expect(transcript).toContain(
      "note run ended: the answer kept hitting the model's output limit; type 'continue' to resume",
    );
  });
});
