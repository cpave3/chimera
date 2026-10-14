import type {
  DirEntry,
  ExecOptions,
  ExecResult,
  Executor,
  PermissionGate,
  StatResult,
} from '@chimera/core';
import { newRequestId, permissionDenialMessage } from '@chimera/core';

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

  removeFile(path: string): Promise<void> {
    return this.inner.removeFile(path);
  }

  stat(path: string): Promise<StatResult | null> {
    return this.inner.stat(path);
  }

  readdir(path: string): Promise<DirEntry[]> {
    return this.inner.readdir(path);
  }

  async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    const toolName = opts?.toolName ?? 'bash';
    const resolution = await this.gate.request({
      requestId: newRequestId(),
      tool: toolName,
      target: 'host',
      command: cmd,
      cwd: this.inner.cwd(),
    });
    if (resolution.decision === 'deny') {
      return {
        stdout: '',
        stderr: permissionDenialMessage(
          resolution.denialSource,
          resolution.reviewerReason ?? resolution.systemOneNote,
        ),
        exitCode: -1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }
    return this.inner.exec(cmd, opts);
  }
}
