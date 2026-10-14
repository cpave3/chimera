import type { AgentEvent, PermissionRequest } from '@chimera/core';

export interface PendingPermission {
  requestId: string;
  command: string;
  reason?: string;
  /** Why the approval reviewer sent the request to the user. */
  reviewerReason?: string;
  /** What the System One check found before the request came to the user. */
  systemOneNote?: string;
  policyAnalysis?: Extract<AgentEvent, { type: 'permission_request' }>['policyAnalysis'];
  mcp?: PermissionRequest['mcp'];
  /**
   * When set, the request was raised inside a subagent and resolution must
   * be sent to the child's server (via a freshly built ChimeraClient).
   */
  subagent?: {
    id: string;
    purpose: string;
    sessionId: string;
    url: string;
  };
}

export function requiresSudoAuthentication(
  policyAnalysis: PendingPermission['policyAnalysis'],
): boolean {
  return (
    policyAnalysis?.findings.some(
      (finding) => finding.kind === 'elevation' && finding.ruleId === 'sudo',
    ) ?? false
  );
}

export function mergePermissionQueue(
  queue: PendingPermission[],
  requests: Array<PermissionRequest | PendingPermission>,
): PendingPermission[] {
  const merged = [...queue];
  for (const request of requests) {
    const existingIndex = merged.findIndex((item) => item.requestId === request.requestId);
    if (existingIndex >= 0) {
      const existing = merged[existingIndex]!;
      if (!existing.subagent && 'subagent' in request && request.subagent) {
        merged[existingIndex] = { ...existing, subagent: request.subagent };
      }
      continue;
    }
    merged.push({
      requestId: request.requestId,
      command: request.command,
      reason: request.reason,
      reviewerReason: request.reviewerReason,
      systemOneNote: request.systemOneNote,
      policyAnalysis: request.policyAnalysis,
      mcp: request.mcp,
      ...('subagent' in request ? { subagent: request.subagent } : {}),
    });
  }
  return merged;
}
