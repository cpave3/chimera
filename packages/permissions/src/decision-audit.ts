import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  PermissionDecisionSource,
  PermissionRequest,
  PermissionResolution,
} from '@chimera/core';
import { logsDir } from '@chimera/core';
import type { ApprovalReview } from './reviewer';
import type { SystemOneVerdict } from './system-one';

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
  /** What the approval reviewer decided before this decision was made. */
  review?: ApprovalReview;
  /** What the System One check found before this decision was made. */
  systemOne?: SystemOneVerdict;
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
      ...(entry.request.mcp
        ? { mcp: { server: entry.request.mcp.server, tool: entry.request.mcp.tool } }
        : { command: entry.request.command }),
      tool: entry.request.tool,
      target: entry.request.target,
      mode: this.options.mode,
      decision: entry.resolution.decision,
      source: entry.source,
      remembered: entry.resolution.remembered,
      findings,
      ...(entry.review ? { reviewer: this.reviewerRecord(entry) } : {}),
      ...(entry.systemOne ? { systemOne: entry.systemOne } : {}),
      ...(!entry.request.mcp && feedback ? { feedback } : {}),
      ...(!entry.request.mcp && grant ? { grant } : {}),
    };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  private reviewerRecord(entry: PermissionAuditEntry) {
    const { decision, reason, stopped } = entry.review!;
    return {
      decision,
      // The reviewer read the arguments of an MCP call and can repeat them.
      ...(entry.request.mcp ? {} : { reason }),
      ...(stopped ? { stopped } : {}),
    };
  }
}
