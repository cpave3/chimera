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

  it('rejects --sandbox-mode without --sandbox', () => {
    const r = spawnSync('node', [BIN, 'run', '--sandbox-mode', 'overlay', 'hi'], {
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/sandbox flags require --sandbox/i);
  });

  it('--help advertises --max-subagent-depth and --no-subagents', () => {
    const r = spawnSync('node', [BIN, 'run', '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--max-subagent-depth/);
    expect(r.stdout).toMatch(/--no-subagents/);
  });

  it('ls prints a header or "No running" when no instances exist', () => {
    const r = spawnSync('node', [BIN, 'ls'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: '/tmp/chimera-ls-nohome-' + Date.now() },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No running|PID/);
  });

  it('--help advertises resume / continue / -c entry points', () => {
    const helpResult = spawnSync('node', [BIN, '--help'], { encoding: 'utf8' });
    expect(helpResult.status).toBe(0);
    expect(helpResult.stdout).toMatch(/resume \[id\]/);
    expect(helpResult.stdout).toMatch(/continue/);
    expect(helpResult.stdout).toMatch(/-c, --continue/);
    expect(helpResult.stdout).toMatch(/--resume \[id\]/);
  });

  it('continue with no sessions in cwd exits non-zero', () => {
    const isolatedHome = '/tmp/chimera-continue-empty-' + Date.now();
    const continueResult = spawnSync('node', [BIN, 'continue'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: isolatedHome },
    });
    expect(continueResult.status).not.toBe(0);
    expect(continueResult.stderr).toMatch(/No sessions in/);
  });
});
