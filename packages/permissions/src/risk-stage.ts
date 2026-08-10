import { analyzeCommand, initParser } from '@aslamplr/pi-safe-shell/src/ast-analyzer.ts';
import { scoreCommandV2 } from '@aslamplr/pi-safe-shell/src/ast-analyzer-v2.ts';
import type {
  CommandPolicyStage,
  CommandPolicyStageContext,
  CommandPolicyStageResult,
  CommandRiskLevel,
} from '@chimera/core';

const RISK_RANK: Record<CommandRiskLevel | 'none', number> = {
  none: -1,
  safe: 0,
  caution: 1,
  danger: 2,
  critical: 3,
};

let parserInitialization: Promise<void> | undefined;

export class PiSafeShellRiskStage implements CommandPolicyStage {
  readonly id = 'risk';

  constructor(private readonly autoAllowThrough: CommandRiskLevel | 'none') {}

  async evaluate(context: CommandPolicyStageContext): Promise<CommandPolicyStageResult> {
    parserInitialization ??= initParser();
    await parserInitialization;
    const risk = scoreCommandV2(analyzeCommand(context.command));
    if (RISK_RANK[risk.level] <= RISK_RANK[this.autoAllowThrough]) {
      return { status: 'pass' };
    }
    return {
      status: 'findings',
      findings: [
        {
          kind: 'risk',
          stageId: this.id,
          level: risk.level,
          score: risk.score,
          message: risk.reasons.join('; ') || `${risk.level} command risk`,
          factors: risk.riskFactors,
        },
      ],
    };
  }
}
