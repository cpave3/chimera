import { homedir } from 'node:os';
import { type SessionId, sessionEventsPath } from '@chimera/core';
import { permissionAuditPath, reviewBashPolicy } from '@chimera/permissions';

export async function runBashPolicyReview(options: {
  sessionId: SessionId;
  home?: string;
  json?: boolean;
}): Promise<void> {
  const home = options.home ?? homedir();
  const report = await reviewBashPolicy({
    eventsPath: sessionEventsPath(options.sessionId, home),
    auditPath: permissionAuditPath(home),
    sessionId: options.sessionId,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`# Bash policy review: ${options.sessionId}\n\n`);
  process.stdout.write(
    `Commands: ${report.summary.total}; automatic: ${report.summary.automatic}; blocked: ${report.summary.blocked}; prompted: ${report.summary.prompted}\n\n`,
  );
  for (const command of report.commands) {
    process.stdout.write(`## ${command.currentPolicy.outcome}\n\n`);
    process.stdout.write(`\`${command.command.replaceAll('`', '\\`')}\`\n\n`);
    if (command.currentPolicy.outcome !== 'automatic') {
      process.stdout.write(
        `Rule: ${command.currentPolicy.ruleId} — ${command.currentPolicy.message}\n\n`,
      );
    }
    if (command.audit) {
      process.stdout.write(
        `Historical decision: ${String(command.audit.decision)} (${String(command.audit.source)})\n\n`,
      );
    }
  }
}
