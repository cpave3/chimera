import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyOverlay,
  defaultOverlaysHome,
  discardOverlay,
  DockerExecutor,
  overlayPaths,
} from '@chimera/sandbox';
import { afterAll, beforeEach, describe, expect, it, afterEach } from 'vitest';

/**
 * Tasks 11.1–11.4: end-to-end sandbox tests. These spin up real Docker
 * containers, so they're gated on `CHIMERA_TEST_DOCKER=1` and silently
 * skip otherwise.
 *
 * Override the image with `CHIMERA_TEST_SANDBOX_IMAGE` (default
 * `chimera-sandbox:dev`, produced by `chimera sandbox build`).
 */
const DOCKER_GATED = process.env.CHIMERA_TEST_DOCKER === '1';
const SANDBOX_IMAGE = process.env.CHIMERA_TEST_SANDBOX_IMAGE ?? 'chimera-sandbox:dev';

const dockerAvailable = (() => {
  if (!DOCKER_GATED) return false;
  const r = spawnSync('docker', ['version'], { encoding: 'utf8' });
  return r.status === 0;
})();

const describeDocker = dockerAvailable ? describe : describe.skip;

describeDocker('sandbox E2E (Docker-gated)', () => {
  let home: string;
  let workspace: string;
  let overlaysHome: string;
  const liveExecutors: DockerExecutor[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-sandbox-e2e-'));
    workspace = join(home, 'workspace');
    overlaysHome = join(home, 'overlays');
    await mkdir(workspace, { recursive: true });
    await mkdir(overlaysHome, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(liveExecutors.map((d) => d.stop().catch(() => undefined)));
    liveExecutors.length = 0;
    await rm(home, { recursive: true, force: true });
  });

  afterAll(() => {
    spawnSync('sh', [
      '-c',
      'docker ps -aq --filter "name=chimera-e2e-" | xargs -r docker rm -f',
    ]);
  });

  function track(d: DockerExecutor): DockerExecutor {
    liveExecutors.push(d);
    return d;
  }

  it('11.1 bind: bash inside sandbox produces stdout', { timeout: 60000 }, async () => {
    const docker = track(
      new DockerExecutor({
        image: SANDBOX_IMAGE,
        mode: 'bind',
        sessionId: `e2e-bind-${Date.now()}`,
        hostCwd: workspace,
      }),
    );
    await docker.start();
    const r = await docker.exec('echo hello-sandbox');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/hello-sandbox/);
  });

  it(
    '11.2 overlay apply: rsync brings sandbox writes back to the host',
    { timeout: 90000 },
    async () => {
      const sessionId = `e2e-overlay-apply-${Date.now()}`;
      const docker = track(
        new DockerExecutor({
          image: SANDBOX_IMAGE,
          mode: 'overlay',
          sessionId,
          hostCwd: workspace,
          overlaysHome,
        }),
      );
      await docker.start();
      // Skip if the host kernel/Docker doesn't support overlayfs in containers.
      if (docker.mode() !== 'overlay') {
        return;
      }
      const w = await docker.exec("sh -c 'echo applied > /workspace/from-overlay.txt'");
      expect(w.exitCode).toBe(0);
      // Nothing on host yet.
      expect(existsSync(join(workspace, 'from-overlay.txt'))).toBe(false);

      await applyOverlay(sessionId, workspace, undefined, { overlaysHome });
      expect(readFileSync(join(workspace, 'from-overlay.txt'), 'utf8')).toMatch(
        /applied/,
      );
    },
  );

  it(
    '11.3 overlay discard: writes do NOT appear on host',
    { timeout: 90000 },
    async () => {
      const sessionId = `e2e-overlay-discard-${Date.now()}`;
      const docker = track(
        new DockerExecutor({
          image: SANDBOX_IMAGE,
          mode: 'overlay',
          sessionId,
          hostCwd: workspace,
          overlaysHome,
        }),
      );
      await docker.start();
      if (docker.mode() !== 'overlay') return;

      await docker.exec("sh -c 'echo nope > /workspace/should-not-apply.txt'");
      await docker.stop();
      await discardOverlay(sessionId, { overlaysHome });

      expect(existsSync(join(workspace, 'should-not-apply.txt'))).toBe(false);
      const { root } = overlayPaths(sessionId, overlaysHome);
      expect(existsSync(root)).toBe(false);
    },
  );

  it(
    '11.4 ephemeral: tmpfs upperdir, no host writes, no overlays-home entry',
    { timeout: 60000 },
    async () => {
      const sessionId = `e2e-ephemeral-${Date.now()}`;
      const docker = track(
        new DockerExecutor({
          image: SANDBOX_IMAGE,
          mode: 'ephemeral',
          sessionId,
          hostCwd: workspace,
          overlaysHome,
        }),
      );
      await docker.start();
      if (docker.mode() !== 'ephemeral') return;

      await docker.exec("sh -c 'echo gone > /workspace/transient.txt'");
      // Visible inside the container.
      const inside = await docker.exec('cat /workspace/transient.txt');
      expect(inside.stdout).toMatch(/gone/);

      // Nothing on host.
      expect(existsSync(join(workspace, 'transient.txt'))).toBe(false);
      // No upperdir on host.
      const root = defaultOverlaysHome(home);
      // overlaysHome was passed explicitly so the default location stays empty,
      // and the explicit one only ever sees a directory once we use overlay,
      // not ephemeral.
      void root;
      expect(existsSync(join(overlaysHome, sessionId))).toBe(false);
    },
  );

});
