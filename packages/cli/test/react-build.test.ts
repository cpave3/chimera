import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BIN = join(__dirname, '..', 'dist', 'bin.js');
const REPORTER = join(__dirname, 'fixtures', 'report-react-build.mjs');

interface BuildReport {
  nodeEnv: string | null;
  reactBuilds: string[];
}

function startBinary(nodeEnv: string | undefined): BuildReport {
  // vitest sets NODE_ENV=test; drop it so the unset case is really unset.
  const { NODE_ENV: _vitestNodeEnv, ...env } = process.env;
  const result = spawnSync('node', ['--import', REPORTER, BIN, '--version'], {
    encoding: 'utf8',
    env: nodeEnv === undefined ? env : { ...env, NODE_ENV: nodeEnv },
  });
  expect(result.status).toBe(0);
  const reportLine = result.stderr.trim().split('\n').pop() ?? '';
  return JSON.parse(reportLine);
}

describe('React build loaded by the chimera binary', () => {
  it('loads the production build when NODE_ENV is unset, without leaking NODE_ENV', () => {
    const report = startBinary(undefined);
    expect(report.reactBuilds).toContain('react.production.js');
    expect(report.reactBuilds).not.toContain('react.development.js');
    expect(report.nodeEnv).toBeNull();
  });

  it('keeps a NODE_ENV the user set', () => {
    const report = startBinary('development');
    expect(report.reactBuilds).toContain('react.development.js');
    expect(report.nodeEnv).toBe('development');
  });
});
