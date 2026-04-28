import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChimeraClient } from '@chimera/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHandshakeLine } from '../src/handshake';

/**
 * End-to-end coverage for the subagent infrastructure. Gated on
 * `CHIMERA_TEST_E2E=1` because these spin up real `chimera serve` processes.
 *
 * Model-dependent flows (a parent invoking `spawn_agent` and a child running
 * a real prompt — tasks 11.1, 11.4, 11.5) require provider credentials and
 * are intentionally skipped in CI without `ANTHROPIC_API_KEY` (or another
 * provider). They are also redundant with the unit tests in:
 *
 *   - `spawn-tool.test.ts` (depth cap, in-process happy path, single-child
 *     interrupt — tasks 11.2, 11.5).
 *   - `parallel-interrupt.test.ts` (parallel interrupt cascade — task 11.4).
 *
 * The non-model E2E here (task 11.3) directly exercises the
 * machine-handshake ↔ ChimeraClient seam that the production
 * `chimera attach <subagentId>` workflow depends on.
 */

const E2E_GATE = process.env.CHIMERA_TEST_E2E === '1';
const describeE2E = E2E_GATE ? describe : describe.skip;

const CLI_BIN = (() => {
  // Resolve via package layout; relies on `pnpm -r build` having produced
  // `packages/cli/dist/bin.js` before this suite runs.
  return new URL('../../cli/dist/bin.js', import.meta.url).pathname;
})();

describeE2E('subagent E2E (CHIMERA_TEST_E2E)', () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-subagent-e2e-'));
    cwd = await mkdtemp(join(tmpdir(), 'chimera-subagent-cwd-'));
    // Minimal providers config so `chimera serve` can resolve a default model
    // without actually contacting an upstream API (we never send a message).
    await mkdir(join(home, '.chimera'), { recursive: true });
    await writeFile(
      join(home, '.chimera', 'config.json'),
      JSON.stringify(
        {
          providers: {
            fake: {
              shape: 'openai',
              baseUrl: 'http://127.0.0.1:1',
              apiKey: 'test-not-used',
            },
          },
          defaultModel: 'fake/test-model',
        },
        null,
        2,
      ),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('11.3 chimera serve --machine-handshake produces a parseable ready line and ChimeraClient can talk to /healthz', async () => {
    const proc = spawn(
      process.execPath,
      [CLI_BIN, 'serve', '--machine-handshake', '--cwd', cwd, '--auto-approve', 'host'],
      {
        cwd,
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderrBuf = '';
    proc.stderr!.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf8');
    });

    try {
      // 10s budget — generous for cold starts.
      const handshake = await readHandshakeLine(proc.stdout!, 10_000);
      expect(handshake.ready).toBe(true);
      expect(handshake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(typeof handshake.sessionId).toBe('string');

      const client = new ChimeraClient({ baseUrl: handshake.url });
      const info = await client.getInstance();
      expect(info.pid).toBe(handshake.pid);
      expect(info.cwd).toBe(cwd);

      // Child should advertise itself with a `parentId` only when --parent
      // is set; here we left it unset.
      expect(info.parentId).toBeUndefined();

      // /v1/sessions/:id/subagents on the freshly-created default session
      // returns an empty list (no children spawned).
      const subs = await client.listSubagents(handshake.sessionId);
      expect(subs).toEqual([]);
    } catch (err) {
      // Surface stderr to make E2E diagnostics tractable.
      throw new Error(`${(err as Error).message}\n--- child stderr ---\n${stderrBuf}`);
    } finally {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    }
  });

  it('11.6 chimera serve --system-prompt-file --tools restricts the session', async () => {
    const promptFile = join(home, 'system-prompt.txt');
    await writeFile(
      promptFile,
      'You are a tightly scoped reviewer. Use only Read and Grep.',
      'utf8',
    );

    const proc = spawn(
      process.execPath,
      [
        CLI_BIN,
        'serve',
        '--machine-handshake',
        '--cwd',
        cwd,
        '--auto-approve',
        'host',
        '--system-prompt-file',
        promptFile,
        '--tools',
        'read,grep',
      ],
      {
        cwd,
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderrBuf = '';
    proc.stderr!.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf8');
    });

    try {
      const handshake = await readHandshakeLine(proc.stdout!, 10_000);
      const client = new ChimeraClient({ baseUrl: handshake.url });
      const info = await client.getInstance();
      expect(info.cwd).toBe(cwd);
      // Hand it back; the assertion that flags didn't crash boot is enough at
      // this layer — deeper coverage (system_prompt actually used; tool map
      // actually filtered) is exercised in unit tests where we capture builder
      // arguments directly.
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- child stderr ---\n${stderrBuf}`);
    } finally {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    }
  });
});
