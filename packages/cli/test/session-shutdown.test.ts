import { afterEach, expect, it, vi } from 'vitest';
import { shutdownLifecycle } from '../src/session-shutdown';

afterEach(() => vi.useRealTimers());

it('bounds end hooks but waits for mod child reaping after that window', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const registry = {
    shutdown: vi.fn(async (reason: string, timeout: number) => {
      calls.push(`${reason}:${timeout}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }),
  };
  const mods = {
    shutdown: async () => {
      calls.push('mods');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    },
  };
  let finished = false;
  const shutdown = shutdownLifecycle(registry, mods, 'signal').then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(1999);
  expect(calls).toEqual(['signal:2000', 'mods']);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(4500);
  await shutdown;
  expect(finished).toBe(true);
});

it('does not spend the rest of the budget when hooks and mods finish early', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  await shutdownLifecycle(
    {
      shutdown: async () => {
        calls.push('sessions');
      },
    },
    {
      shutdown: async () => {
        calls.push('mods');
      },
    },
    'exit',
  );
  expect(calls).toEqual(['sessions', 'mods']);
  expect(vi.getTimerCount()).toBe(0);
});
