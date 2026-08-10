export type CommandRiskLevel = 'safe' | 'caution' | 'danger' | 'critical';

export interface CommandPolicyRoots {
  read: readonly string[];
  write: readonly string[];
}

export interface CommandPolicyContext {
  command: string;
  target: 'host';
  cwd: string;
  home: string;
  projectRoot: string;
  roots: CommandPolicyRoots;
  signal?: AbortSignal;
}

export type CommandPolicyFinding =
  | {
      kind: 'risk';
      stageId: string;
      level: CommandRiskLevel;
      score?: number;
      message: string;
      factors?: string[];
    }
  | {
      kind: 'path';
      stageId: string;
      operation: 'read' | 'write' | 'delete';
      path: string;
      resolvedPath?: string;
      requiredGrant: 'read' | 'write';
      message: string;
    }
  | {
      kind: 'unresolved';
      stageId: string;
      message: string;
    }
  | {
      kind: 'analyzer_error';
      stageId: string;
      message: string;
    };

export type CommandPolicyFact =
  | {
      kind: 'shell_effect';
      operation: 'read' | 'write' | 'delete';
      path: string;
    }
  | {
      kind: string;
      [key: string]: unknown;
    };

export interface CommandPolicyGrantProposal {
  id: string;
  kind: 'read' | 'write';
  path: string;
}

export type CommandPolicyStageResult =
  | { status: 'pass'; facts?: CommandPolicyFact[] }
  | {
      status: 'findings';
      facts?: CommandPolicyFact[];
      findings: CommandPolicyFinding[];
      grantProposal?: CommandPolicyGrantProposal;
    }
  | { status: 'error'; message: string };

export interface CommandPolicyStageContext extends CommandPolicyContext {
  facts: readonly CommandPolicyFact[];
}

export interface CommandPolicyStage {
  id: string;
  evaluate(context: CommandPolicyStageContext): Promise<CommandPolicyStageResult>;
}

export interface CommandPolicyStageSummary {
  id: string;
  status: 'pass' | 'findings' | 'error';
  findings: CommandPolicyFinding[];
}

export interface CommandPolicyEvaluator {
  evaluate(context: CommandPolicyContext): Promise<CommandPolicyAnalysis>;
}

export interface CommandPolicyAnalysis {
  version: 1;
  outcome: 'pass' | 'approval_required';
  stages: CommandPolicyStageSummary[];
  findings: CommandPolicyFinding[];
  grantProposal?: CommandPolicyGrantProposal;
}
