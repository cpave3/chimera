import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logsDir } from '@chimera/core';
import type { SystemOneRecord } from './system-one';

export interface SystemOneAuditOptions {
  home?: string;
  sessionId: string;
  onWarning?: (message: string) => void;
}

export function systemOneAuditPath(home = homedir()): string {
  return join(logsDir(home), 'system-one-decisions.jsonl');
}

/** The log of every command the System One model was asked about. */
export class SystemOneAudit {
  private readonly path: string;

  constructor(private readonly options: SystemOneAuditOptions) {
    this.path = systemOneAuditPath(options.home);
  }

  record(entry: SystemOneRecord): void {
    try {
      this.append(entry);
    } catch (error) {
      this.options.onWarning?.(`System One audit write failed: ${(error as Error).message}`);
    }
  }

  private append(entry: SystemOneRecord): void {
    const directory = logsDir(this.options.home ?? homedir());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const { request, verdict } = entry;
    const record = {
      version: 1,
      timestamp: Date.now(),
      sessionId: this.options.sessionId,
      requestId: request.requestId,
      cwd: request.cwd,
      command: request.command,
      ...(request.osSandbox ? { osSandbox: true } : {}),
      ...(request.unsandboxed ? { unsandboxed: true } : {}),
      outcome: verdict.failed ? 'failed' : verdict.decision === 'allow' ? 'approved' : 'rejected',
      ...(verdict.safety === undefined ? {} : { safety: verdict.safety }),
      threshold: verdict.threshold,
      note: verdict.note,
      url: entry.url,
      model: entry.model,
      ...(entry.servedBy ? { servedBy: entry.servedBy } : {}),
      promptVersion: entry.promptVersion,
      ...(entry.answers ? { answers: entry.answers } : {}),
      durationMs: entry.durationMs,
    };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}
