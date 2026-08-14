import type { PermissionRequest, PermissionResolution, PermissionRule } from '@chimera/core';

export type AutoApproveLevel = 'none' | 'sandbox' | 'host' | 'all';

export type { PermissionRequest, PermissionResolution, PermissionRule };

export type RuleScope = 'session' | 'project';

export interface CommandRiskClassifier {
  classify(command: string): Promise<{
    score: number;
    level: 'safe' | 'caution' | 'danger' | 'critical';
    reasons: string[];
    riskFactors: string[];
  }>;
}

export interface ParsedShellCommand {
  command: string;
  executable: string;
  args: string[];
  flags: string[];
  hasPipe: boolean;
  hasRedirect: boolean;
  paths: string[];
  intent: string[];
  substitutionExecutables: string[];
}

export interface ShellCommandParser {
  parse(command: string): Promise<ParsedShellCommand>;
}

export interface StoredRulesFile {
  version: 1;
  rules: PermissionRule[];
}
