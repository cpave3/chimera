import type {
  CommandPolicyAnalysis,
  CommandPolicyContext,
  CommandPolicyEvaluator,
  CommandPolicyFinding,
} from '@chimera/core';

export class BalancedPolicyEvaluator implements CommandPolicyEvaluator {
  constructor(private readonly inner: CommandPolicyEvaluator) {}

  async evaluate(context: CommandPolicyContext): Promise<CommandPolicyAnalysis> {
    const analysis = await this.inner.evaluate(context);
    const findings = analysis.findings.filter(requiresIntervention);
    return {
      ...analysis,
      outcome: findings.length === 0 ? 'pass' : 'approval_required',
      findings,
      stages: analysis.stages.map((stage) => ({
        ...stage,
        findings: stage.findings.filter(requiresIntervention),
      })),
      ...(findings.some((finding) => finding.kind === 'path')
        ? { grantProposal: analysis.grantProposal }
        : { grantProposal: undefined }),
    };
  }
}

function requiresIntervention(finding: CommandPolicyFinding): boolean {
  return finding.kind !== 'unresolved';
}
