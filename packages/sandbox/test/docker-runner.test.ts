import { describe, expect, it } from 'vitest';
import { SpawnDockerRunner } from '../src/docker-runner';

describe('SpawnDockerRunner timeout', () => {
  it('SIGTERM kills a long-running child near timeoutMs (no SIGKILL needed)', async () => {
    const runner = new SpawnDockerRunner({ command: 'sh' });
    const start = Date.now();
    const r = await runner.run(['-c', 'sleep 60'], { timeoutMs: 100 });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    // Should land well under the 2s SIGKILL fallback — `sleep` honors SIGTERM.
    expect(elapsed).toBeLessThan(1500);
  }, 10_000);

  it('child that finishes before the timeout reports timedOut=false', async () => {
    const runner = new SpawnDockerRunner({ command: 'sh' });
    const r = await runner.run(['-c', 'echo hi'], { timeoutMs: 5_000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/hi/);
    expect(r.stdoutTruncated).toBe(false);
    expect(r.stderrTruncated).toBe(false);
  });

  it('caps stdout at maxOutputBytes and reports stdoutTruncated', async () => {
    const runner = new SpawnDockerRunner({ command: 'sh' });
    const r = await runner.run(['-c', 'yes a | head -c 4096'], { maxOutputBytes: 1024 });
    expect(r.exitCode).toBe(0);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(false);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('caps stderr at maxOutputBytes and reports stderrTruncated', async () => {
    const runner = new SpawnDockerRunner({ command: 'sh' });
    const r = await runner.run(['-c', 'yes a | head -c 4096 1>&2'], { maxOutputBytes: 1024 });
    expect(r.stderrTruncated).toBe(true);
    expect(r.stdoutTruncated).toBe(false);
    expect(Buffer.byteLength(r.stderr, 'utf8')).toBeLessThanOrEqual(1024);
  });
});
