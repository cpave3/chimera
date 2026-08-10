import type {
  CommandPolicyStage,
  CommandPolicyStageContext,
  CommandPolicyStageResult,
  CommandRiskLevel,
} from '@chimera/core';
import type { CommandRiskClassifier } from './types';

const RISK_RANK: Record<CommandRiskLevel | 'none', number> = {
  none: -1,
  safe: 0,
  caution: 1,
  danger: 2,
  critical: 3,
};

export class RiskStage implements CommandPolicyStage {
  readonly id = 'risk';

  constructor(
    private readonly classifier: CommandRiskClassifier,
    private readonly autoAllowThrough: CommandRiskLevel | 'none',
  ) {}

  async evaluate(context: CommandPolicyStageContext): Promise<CommandPolicyStageResult> {
    const risk = await this.classifier.classify(context.command);
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
