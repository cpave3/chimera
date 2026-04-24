import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BIN = join(__dirname, '..', 'dist', 'bin.js');

describe('chimera CLI smoke', () => {
  it('--version prints a semver', () => {
    const r = spawnSync('node', [BIN, '--version'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects --sandbox with a helpful message and nonzero exit', () => {
    const r = spawnSync('node', [BIN, '--sandbox', 'run', 'hi'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/sandbox/i);
    expect(r.stderr).toMatch(/not yet supported/i);
  });

  it('rejects --max-subagent-depth', () => {
    const r = spawnSync('node', [BIN, '--max-subagent-depth', '3', 'run', 'hi'], {
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not yet supported/i);
  });

  it('ls prints a header or "No running" when no instances exist', () => {
    const r = spawnSync('node', [BIN, 'ls'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: '/tmp/chimera-ls-nohome-' + Date.now() },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No running|PID/);
  });
});
