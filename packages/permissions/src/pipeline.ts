import type {
  CommandPolicyAnalysis,
  CommandPolicyContext,
  CommandPolicyFact,
  CommandPolicyFinding,
  CommandPolicyGrantProposal,
  CommandPolicyStage,
  CommandPolicyStageResult,
  CommandPolicyStageSummary,
} from '@chimera/core';

export class CommandPolicyPipeline {
  constructor(
    private readonly stages: readonly CommandPolicyStage[],
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  async evaluate(context: CommandPolicyContext): Promise<CommandPolicyAnalysis> {
    const facts: CommandPolicyFact[] = [];
    const findings: CommandPolicyFinding[] = [];
    const stages: CommandPolicyStageSummary[] = [];
    let grantProposal: CommandPolicyGrantProposal | undefined;
    const deadline = Date.now() + (this.options.timeoutMs ?? 5_000);

    for (const stage of this.stages) {
      try {
        const result = await withTimeout(
          stage.evaluate({ ...context, facts }),
          Math.max(1, deadline - Date.now()),
        );
        validateResult(result);
        if (result.status === 'error') throw new Error(result.message);
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
      version: 1,
      outcome: findings.length === 0 ? 'pass' : 'approval_required',
      stages,
      findings,
      ...(grantProposal ? { grantProposal } : {}),
    };
  }
}

function validateResult(result: CommandPolicyStageResult): void {
  if (
    !result ||
    (result.status !== 'pass' && result.status !== 'findings' && result.status !== 'error')
  ) {
    throw new Error('stage returned malformed result');
  }
  if (result.status === 'error' && !result.message) {
    throw new Error('stage returned malformed error');
  }
  if (
    result.status === 'findings' &&
    (!Array.isArray(result.findings) || result.findings.length === 0)
  ) {
    throw new Error('stage returned malformed findings');
  }
  if (result.status !== 'error' && result.facts && !Array.isArray(result.facts)) {
    throw new Error('stage returned malformed facts');
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('stage timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
