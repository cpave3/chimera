import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  PermissionDecisionSource,
  PermissionRequest,
  PermissionResolution,
} from '@chimera/core';
import { logsDir } from '@chimera/core';

export interface PermissionDecisionAuditOptions {
  home?: string;
  sessionId: string;
  mode: 'balanced' | 'strict' | 'disabled';
  onWarning?: (message: string) => void;
}

export interface PermissionAuditEntry {
  request: PermissionRequest;
  resolution: PermissionResolution;
  source: PermissionDecisionSource;
  feedback?: string;
  grant?: { id: string; kind: 'read' | 'write'; path: string };
}

export function permissionAuditPath(home = homedir()): string {
  return join(logsDir(home), 'permission-decisions.jsonl');
}

export class PermissionDecisionAudit {
  private readonly path: string;

  constructor(private readonly options: PermissionDecisionAuditOptions) {
    this.path = permissionAuditPath(options.home);
  }

  record(entry: PermissionAuditEntry): void {
    try {
      this.append(entry);
    } catch (error) {
      this.options.onWarning?.(`permission audit write failed: ${(error as Error).message}`);
    }
  }

  private append(entry: PermissionAuditEntry): void {
    const directory = logsDir(this.options.home ?? homedir());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const findings = entry.request.policyAnalysis?.findings ?? [];
    const feedback = entry.feedback ?? entry.resolution.feedback;
    const grant = entry.grant ?? entry.resolution.grant;
    const record = {
      version: 1,
      timestamp: Date.now(),
      sessionId: this.options.sessionId,
      requestId: entry.request.requestId,
      cwd: entry.request.cwd,
      command: entry.request.command,
      tool: entry.request.tool,
      target: entry.request.target,
      mode: this.options.mode,
      decision: entry.resolution.decision,
      source: entry.source,
      remembered: entry.resolution.remembered,
      findings,
      ...(feedback ? { feedback } : {}),
      ...(grant ? { grant } : {}),
    };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}
