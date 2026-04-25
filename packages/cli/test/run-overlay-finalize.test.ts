import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chimera/sandbox', async (importOriginal) => {
  const real = await importOriginal<typeof import('@chimera/sandbox')>();
  return {
    ...real,
    applyOverlay: vi.fn(async () => undefined),
    discardOverlay: vi.fn(async () => undefined),
  };
});

import { applyOverlay, discardOverlay } from '@chimera/sandbox';
import { finalizeOverlay } from '../src/commands/run';

const SESSION = 's1';
const CWD = '/tmp/finalize-fixture';

describe('finalizeOverlay', () => {
  beforeEach(() => {
    vi.mocked(applyOverlay).mockClear();
    vi.mocked(discardOverlay).mockClear();
  });

  afterEach(() => {
    vi.mocked(applyOverlay).mockClear();
    vi.mocked(discardOverlay).mockClear();
  });

  it("applies then discards when applyOnSuccess && exitReason === 'stop'", async () => {
    await finalizeOverlay({
      sessionId: SESSION,
      cwd: CWD,
      exitReason: 'stop',
      applyOnSuccess: true,
    });
    expect(applyOverlay).toHaveBeenCalledOnce();
    expect(applyOverlay).toHaveBeenCalledWith(SESSION, CWD);
    expect(discardOverlay).toHaveBeenCalledOnce();
    expect(discardOverlay).toHaveBeenCalledWith(SESSION);
    // Apply must precede discard.
    const applyOrder = vi.mocked(applyOverlay).mock.invocationCallOrder[0]!;
    const discardOrder = vi.mocked(discardOverlay).mock.invocationCallOrder[0]!;
    expect(applyOrder).toBeLessThan(discardOrder);
  });

  it('discards (no apply) on max_steps even with applyOnSuccess=true', async () => {
    await finalizeOverlay({
      sessionId: SESSION,
      cwd: CWD,
      exitReason: 'max_steps',
      applyOnSuccess: true,
    });
    expect(applyOverlay).not.toHaveBeenCalled();
    expect(discardOverlay).toHaveBeenCalledOnce();
  });

  it.each(['error', 'interrupted', 'timeout'] as const)(
    "discards (no apply) on exit '%s' even with applyOnSuccess=true",
    async (reason) => {
      await finalizeOverlay({
        sessionId: SESSION,
        cwd: CWD,
        exitReason: reason,
        applyOnSuccess: true,
      });
      expect(applyOverlay).not.toHaveBeenCalled();
      expect(discardOverlay).toHaveBeenCalledOnce();
    },
  );

  it('discards (no apply) on a clean stop when applyOnSuccess is false', async () => {
    await finalizeOverlay({
      sessionId: SESSION,
      cwd: CWD,
      exitReason: 'stop',
      applyOnSuccess: false,
    });
    expect(applyOverlay).not.toHaveBeenCalled();
    expect(discardOverlay).toHaveBeenCalledOnce();
  });
});
