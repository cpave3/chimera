import type {
  DirEntry,
  ExecOptions,
  ExecResult,
  Executor,
  PermissionGate,
  StatResult,
} from '@chimera/core';
import { newRequestId } from '@chimera/core';

export interface GatedExecutorOptions {
  inner: Executor;
  gate: PermissionGate;
}

/**
 * Wraps an inner Executor, routing every exec() through the permission gate.
 * File operations pass through unchanged.
 */
export class GatedExecutor implements Executor {
  private readonly inner: Executor;
  private readonly gate: PermissionGate;

  constructor(opts: GatedExecutorOptions) {
    this.inner = opts.inner;
    this.gate = opts.gate;
  }

  cwd(): string {
    return this.inner.cwd();
  }

  target() {
    return this.inner.target();
  }

  readFile(path: string): Promise<string> {
    return this.inner.readFile(path);
  }

  readFileBytes(path: string): Promise<Uint8Array> {
    return this.inner.readFileBytes(path);
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.inner.writeFile(path, content);
  }

  stat(path: string): Promise<StatResult | null> {
    return this.inner.stat(path);
  }

  readdir(path: string): Promise<DirEntry[]> {
    return this.inner.readdir(path);
  }

  async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    const resolution = await this.gate.request({
      requestId: newRequestId(),
      tool: 'bash',
      target: 'host',
      command: cmd,
      cwd: this.inner.cwd(),
    });
    if (resolution.decision === 'deny') {
      return {
        stdout: '',
        stderr: denialMessage(resolution.denialSource),
        exitCode: -1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }
    return this.inner.exec(cmd, opts);
  }
}

function denialMessage(source: 'rule' | 'hook' | 'headless' | 'user' | undefined): string {
  if (source === 'rule') return 'denied by rule';
  if (source === 'hook') return 'denied by hook';
  if (source === 'headless') return 'denied by policy';
  return 'denied by user';
}
