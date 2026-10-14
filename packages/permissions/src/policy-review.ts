import { readFile } from 'node:fs/promises';
import { matchScaryCommand } from './scary-command-stage';

export interface BashPolicyReviewOptions {
  eventsPath: string;
  auditPath?: string;
  sessionId?: string;
}

export interface BashPolicyReview {
  summary: { total: number; blocked: number; prompted: number; automatic: number };
  commands: Array<{
    callId: string;
    command: string;
    target: string;
    startedAt: number;
    result?: unknown;
    error?: string;
    currentPolicy:
      | { outcome: 'blocked'; ruleId: string; message: string }
      | { outcome: 'automatic' };
    audit?: Record<string, unknown>;
  }>;
}

export async function reviewBashPolicy(
  options: BashPolicyReviewOptions,
): Promise<BashPolicyReview> {
  const eventLines = await readJsonLines(options.eventsPath);
  const auditLines = options.auditPath ? await readJsonLines(options.auditPath, true) : [];
  const audits = auditLines.filter(
    (record) => !options.sessionId || record.sessionId === options.sessionId,
  );
  const auditQueues = new Map<string, Record<string, unknown>[]>();
  for (const audit of audits) {
    if (typeof audit.command !== 'string') continue;
    const queue = auditQueues.get(audit.command) ?? [];
    queue.push(audit);
    auditQueues.set(audit.command, queue);
  }
  const byCallId = new Map<string, Record<string, unknown>>();
  for (const event of eventLines) {
    if (event.type !== 'step_finished' || !Array.isArray(event.toolCalls)) continue;
    for (const call of event.toolCalls) {
      if (isRecord(call) && call.name === 'bash' && typeof call.callId === 'string') {
        byCallId.set(call.callId, call);
      }
    }
  }

  const commands = [...byCallId.values()]
    .sort((left, right) => Number(left.startedAt) - Number(right.startedAt))
    .map((call) => {
      const args = isRecord(call.args) ? call.args : {};
      const rawCommand = typeof args.command === 'string' ? args.command : '';
      const scary = matchScaryCommand(rawCommand);
      const audit = auditQueues.get(rawCommand)?.shift();
      return {
        callId: String(call.callId),
        command: redactCommand(rawCommand),
        target: typeof call.target === 'string' ? call.target : 'unknown',
        startedAt: Number(call.startedAt),
        ...(call.result === undefined ? {} : { result: call.result }),
        ...(typeof call.error === 'string' ? { error: call.error } : {}),
        currentPolicy: scary
          ? { outcome: 'blocked' as const, ruleId: scary.ruleId, message: scary.message }
          : { outcome: 'automatic' as const },
        ...(audit ? { audit: redactAudit(audit) } : {}),
      };
    });
  return {
    summary: {
      total: commands.length,
      blocked: commands.filter((command) => command.currentPolicy.outcome === 'blocked').length,
      prompted: commands.filter((command) => command.audit?.source === 'user').length,
      automatic: commands.filter((command) => command.currentPolicy.outcome === 'automatic').length,
    },
    commands,
  };
}

async function readJsonLines(path: string, optional = false): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error('record is not an object');
        return parsed;
      } catch (error) {
        throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${(error as Error).message}`);
      }
    });
}

function redactAudit(audit: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(audit).map(([key, value]) => {
      if ((key === 'command' || key === 'feedback') && typeof value === 'string') {
        return [key, redactCommand(value)];
      }
      return [key, value];
    }),
  );
}

/** A command without the values that look like credentials. */
export function redactCommand(command: string): string {
  return command
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s]+)/g,
      '$1=[REDACTED]',
    )
    .replace(/(--(?:token|api-key|password|secret)(?:=|\s+))([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*(?:bearer\s+)?)([^\s'";]+)/gi, '$1[REDACTED]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
