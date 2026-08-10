import type {
  CommandPolicyAnalysis,
  CommandPolicyContext,
  CommandPolicyFact,
  CommandPolicyFinding,
  CommandPolicyGrantProposal,
  CommandPolicyStage,
  CommandPolicyStageSummary,
} from '@chimera/core';

export class CommandPolicyPipeline {
  constructor(private readonly stages: readonly CommandPolicyStage[]) {}

  async evaluate(context: CommandPolicyContext): Promise<CommandPolicyAnalysis> {
    const facts: CommandPolicyFact[] = [];
    const findings: CommandPolicyFinding[] = [];
    const stages: CommandPolicyStageSummary[] = [];
    let grantProposal: CommandPolicyGrantProposal | undefined;

    for (const stage of this.stages) {
      try {
        const result = await stage.evaluate({ ...context, facts });
        if (result.facts) facts.push(...result.facts);
        const stageFindings = result.status === 'findings' ? result.findings : [];
        if (result.status === 'findings' && result.grantProposal) {
          grantProposal = result.grantProposal;
        }
        findings.push(...stageFindings);
        stages.push({ id: stage.id, status: result.status, findings: stageFindings });
      } catch (error) {
        const finding: CommandPolicyFinding = {
          kind: 'analyzer_error',
          stageId: stage.id,
          message: error instanceof Error ? error.message : String(error),
        };
        findings.push(finding);
        stages.push({ id: stage.id, status: 'error', findings: [finding] });
      }
    }

    return {
      outcome: findings.length === 0 ? 'pass' : 'approval_required',
      stages,
      findings,
      ...(grantProposal ? { grantProposal } : {}),
    };
  }
}
