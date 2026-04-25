import type {
  ExecOptions,
  ExecResult,
  Executor,
  StatResult,
} from '@chimera/core';
import { type DockerRunner, SpawnDockerRunner } from './docker-runner';
import { ensureOverlayDirs, overlayPaths, removeOverlayDirs } from './overlay';
import type { SandboxConfig, SandboxRunMode } from './types';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface DockerExecutorOptions extends SandboxConfig {
  runner?: DockerRunner;
  warn?: (message: string) => void;
  /**
   * If set, `start()` auto-builds the configured image from this directory
   * when `docker image inspect` reports it missing. Pass it only for the
   * bundled image — passing it for a user-supplied `--sandbox-image` would
   * silently turn a typo into a 5-minute build.
   */
  dockerfileDir?: string;
  /**
   * Host UID/GID to map into the container so files written by the agent
   * land on the host owned by the invoking user, not root. Default is
   * `process.getuid()` / `process.getgid()`. Pass `null` to opt out.
   */
  hostUid?: number | null;
  hostGid?: number | null;
}

export interface FallbackEvent {
  reason: string;
  fromMode: SandboxRunMode;
  toMode: SandboxRunMode;
}

export class DockerExecutor implements Executor {
  private readonly runner: DockerRunner;
  private readonly config: SandboxConfig;
  private readonly warn: (message: string) => void;
  private readonly containerName: string;
  private readonly dockerfileDir: string | undefined;
  private readonly hostUid: number | null;
  private readonly hostGid: number | null;
  private effectiveMode: SandboxRunMode;
  private started = false;
  private stopped = false;
  private fallback: FallbackEvent | null = null;

  constructor(opts: DockerExecutorOptions) {
    this.runner = opts.runner ?? new SpawnDockerRunner();
    this.config = opts;
    this.warn = opts.warn ?? ((m) => process.stderr.write(`${m}\n`));
    this.containerName = `chimera-${opts.sessionId}`;
    this.dockerfileDir = opts.dockerfileDir;
    this.hostUid = resolveHostId(opts.hostUid, process.getuid?.bind(process));
    this.hostGid = resolveHostId(opts.hostGid, process.getgid?.bind(process));
    this.effectiveMode = opts.mode;
  }

  cwd(): string {
    return this.config.hostCwd;
  }

  target(): 'sandbox' {
    return 'sandbox';
  }

  /** Mode actually in use after any overlay fallback. */
  mode(): SandboxRunMode {
    return this.effectiveMode;
  }

  /** Non-null when overlay-mode start() fell back to bind. */
  fallbackEvent(): FallbackEvent | null {
    return this.fallback;
  }

  async start(): Promise<void> {
    if (this.started) return;

    await this.ensureImage();

    if (this.config.mode === 'overlay') {
      await ensureOverlayDirs(this.config.sessionId, this.config.overlaysHome);
    }

    const tryStart = async (mode: SandboxRunMode): Promise<{ ok: true } | { ok: false; reason: string }> => {
      // Best-effort cleanup of any stale container from a previous crash.
      await this.runner.run(['rm', '-f', this.containerName]).catch(() => undefined);

      const args = this.buildRunArgs(mode);
      const r = await this.runner.run(args);
      if (r.exitCode !== 0) {
        return { ok: false, reason: `docker run failed: ${(r.stderr || r.stdout).trim()}` };
      }

      // Probe: in overlay/ephemeral, the entrypoint may exit with 78 if
      // overlayfs isn't available. Wait briefly for the container to be
      // running and inspect its state.
      if (mode === 'overlay' || mode === 'ephemeral') {
        const probe = await this.probeOverlay();
        if (!probe.ok) {
          await this.runner.run(['rm', '-f', this.containerName]).catch(() => undefined);
          return { ok: false, reason: probe.reason };
        }
      }
      return { ok: true };
    };

    const first = await tryStart(this.config.mode);
    if (first.ok) {
      this.effectiveMode = this.config.mode;
      this.started = true;
      return;
    }

    if (this.config.mode === 'overlay' || this.config.mode === 'ephemeral') {
      if (this.config.strict) {
        throw new Error(
          `sandbox: overlay unavailable (${first.reason}); refused under --sandbox-strict`,
        );
      }
      const second = await tryStart('bind');
      if (!second.ok) {
        throw new Error(`sandbox: bind fallback also failed: ${second.reason}`);
      }
      this.fallback = {
        reason: first.reason,
        fromMode: this.config.mode,
        toMode: 'bind',
      };
      this.effectiveMode = 'bind';
      this.warn(
        `sandbox: ${this.config.mode} unavailable (${first.reason}); falling back to bind mode.`,
      );
      this.started = true;
      return;
    }

    throw new Error(`sandbox: ${first.reason}`);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.started) return;
    // Tolerate the container already being gone.
    await this.runner.run(['rm', '-f', this.containerName]).catch(() => undefined);
    // Note: the upperdir is intentionally retained on stop() so a later
    // `chimera run --session <id>` can re-mount it. Apply/discard is the
    // caller's responsibility.
  }

  /**
   * Drop the upperdir (overlay mode only). Safe to call regardless of mode;
   * a no-op for bind / ephemeral.
   */
  async discardUpperdir(): Promise<void> {
    if (this.config.mode !== 'overlay') return;
    await removeOverlayDirs(this.config.sessionId, this.config.overlaysHome);
  }

  private async ensureImage(): Promise<void> {
    const ref = this.config.image;
    const inspect = await this.runner.run(['image', 'inspect', ref]);
    if (inspect.exitCode === 0) return;

    if (!this.dockerfileDir) {
      throw new Error(
        `sandbox: image '${ref}' not present locally. Pull it, or run ` +
          `'chimera sandbox build' (or 'pnpm sandbox:build') to produce the bundled image.`,
      );
    }

    this.warn(`sandbox: image '${ref}' missing — building from ${this.dockerfileDir} (one-time)`);
    const build = await this.runner.run(
      ['build', '-t', ref, this.dockerfileDir],
      { timeoutMs: 30 * 60_000 },
    );
    if (build.exitCode !== 0) {
      throw new Error(
        `sandbox: 'docker build -t ${ref}' failed: ${(build.stderr || build.stdout).trim()}`,
      );
    }
  }

  private buildRunArgs(mode: SandboxRunMode): string[] {
    const args = [
      'run',
      '-d',
      '--name',
      this.containerName,
      '-w',
      '/workspace',
      '-e',
      `CHIMERA_MODE=${mode}`,
    ];
    if (this.hostUid !== null) {
      args.push('-e', `CHIMERA_HOST_UID=${this.hostUid}`);
    }
    if (this.hostGid !== null) {
      args.push('-e', `CHIMERA_HOST_GID=${this.hostGid}`);
    }

    const network = this.config.network ?? 'host';
    args.push('--network', network === 'none' ? 'none' : 'bridge');
    if (this.config.memory) args.push('--memory', this.config.memory);
    if (this.config.cpus) args.push('--cpus', this.config.cpus);

    if (mode === 'bind') {
      args.push('-v', `${this.config.hostCwd}:/workspace:rw`);
    } else if (mode === 'overlay') {
      const { upper } = overlayPaths(this.config.sessionId, this.config.overlaysHome);
      args.push(
        '-v',
        `${this.config.hostCwd}:/lower:ro`,
        '-v',
        `${upper}:/upper`,
        '--cap-add',
        'SYS_ADMIN',
        '--security-opt',
        'apparmor=unconfined',
      );
    } else {
      // ephemeral: tmpfs upper, ro lower
      args.push(
        '-v',
        `${this.config.hostCwd}:/lower:ro`,
        '--tmpfs',
        '/upper',
        '--cap-add',
        'SYS_ADMIN',
        '--security-opt',
        'apparmor=unconfined',
      );
    }

    args.push(this.config.image);
    return args;
  }

  private async probeOverlay(): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Wait up to ~3s for the container to settle; entrypoint exits fast on
    // overlay failure.
    for (let i = 0; i < 30; i += 1) {
      const r = await this.runner.run([
        'inspect',
        '-f',
        '{{.State.Running}}|{{.State.ExitCode}}|{{.State.Status}}',
        this.containerName,
      ]);
      if (r.exitCode === 0) {
        const [running, exitCode, status] = r.stdout.trim().split('|');
        if (running === 'true') return { ok: true };
        if (status === 'exited' || status === 'dead') {
          // Capture entrypoint logs for the warning text.
          const logs = await this.runner.run(['logs', this.containerName]);
          const tail = (logs.stderr || logs.stdout).trim().split('\n').slice(-3).join(' ');
          return {
            ok: false,
            reason: `entrypoint exited ${exitCode}: ${tail || 'no output'}`,
          };
        }
      }
      await sleep(100);
    }
    return { ok: false, reason: 'container failed to enter Running state' };
  }

  /**
   * Common `docker exec -i [--user UID:GID]` prefix used by every exec-path
   * helper. The `--user` flag is what makes files written by the agent land
   * on the host owned by the invoking user instead of root.
   */
  private execPrefix(): string[] {
    const prefix = ['exec', '-i'];
    if (this.hostUid !== null && this.hostGid !== null) {
      prefix.push('--user', `${this.hostUid}:${this.hostGid}`);
    }
    return prefix;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertStarted();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const dockerArgs = this.execPrefix();
    if (opts.cwd) dockerArgs.push('-w', this.toContainerPath(opts.cwd));
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        dockerArgs.push('-e', `${k}=${v}`);
      }
    }
    dockerArgs.push(this.containerName, 'sh', '-c', cmd);

    const r = await this.runner.run(dockerArgs, {
      stdin: opts.stdin,
      signal: opts.signal,
      timeoutMs,
    });

    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    };
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBytes(path);
    return Buffer.from(bytes).toString('utf8');
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    this.assertStarted();
    const containerPath = this.toContainerPath(path);
    const r = await this.runner.runRaw([
      ...this.execPrefix(),
      this.containerName,
      'cat',
      containerPath,
    ]);
    if (r.exitCode !== 0) {
      throw new Error(`readFile(${path}) failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    }
    return r.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.assertStarted();
    const containerPath = this.toContainerPath(path);
    const dir = posixDirname(containerPath);
    const tmp = `${containerPath}.${process.pid}.${Date.now()}.tmp`;
    const cmd = `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(tmp)} && mv ${shellQuote(tmp)} ${shellQuote(containerPath)}`;
    const r = await this.runner.run(
      [...this.execPrefix(), this.containerName, 'sh', '-c', cmd],
      { stdin: content },
    );
    if (r.exitCode !== 0) {
      throw new Error(`writeFile(${path}) failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    }
  }

  async stat(path: string): Promise<StatResult | null> {
    this.assertStarted();
    const containerPath = this.toContainerPath(path);
    const r = await this.runner.run([
      ...this.execPrefix(),
      this.containerName,
      'stat',
      '-c',
      '%F|%s',
      containerPath,
    ]);
    if (r.exitCode !== 0) {
      // Distinguish missing from other errors: stat prints "No such file" to stderr.
      if (/No such file/i.test(r.stderr)) return null;
      // Treat any other error as not-found rather than throwing — the local
      // executor's contract returns null on ENOENT and throws otherwise, but
      // the only realistic failure mode here is missing path.
      return null;
    }
    const [kind, sizeStr] = r.stdout.trim().split('|');
    const size = Number.parseInt(sizeStr ?? '0', 10) || 0;
    return {
      exists: true,
      isDir: kind === 'directory',
      size,
    };
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error('DockerExecutor: start() must be called before use');
    }
    if (this.stopped) {
      throw new Error('DockerExecutor: cannot use after stop()');
    }
  }

  /**
   * Map a path the model gave us (relative or absolute against host cwd)
   * to its container counterpart under `/workspace`.
   */
  private toContainerPath(path: string): string {
    if (path.startsWith('/workspace')) return path;
    if (path.startsWith('/')) {
      // Absolute host path: rewrite the prefix iff it sits under hostCwd.
      const cwd = this.config.hostCwd;
      if (path === cwd) return '/workspace';
      if (path.startsWith(`${cwd}/`)) return `/workspace/${path.slice(cwd.length + 1)}`;
      // Otherwise pass through; the model is asking for an absolute path the
      // executor doesn't know how to translate — let the container resolve it
      // (and likely return ENOENT inside the container).
      return path;
    }
    if (path === '' || path === '.') return '/workspace';
    return `/workspace/${path}`;
  }
}

function posixDirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

function shellQuote(s: string): string {
  // Single-quote, with `'` → `'\''`.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveHostId(
  override: number | null | undefined,
  detect: (() => number) | undefined,
): number | null {
  if (override === null) return null;
  if (typeof override === 'number') return override;
  // process.getuid/getgid are POSIX-only; absent on Windows.
  return typeof detect === 'function' ? detect() : null;
}
