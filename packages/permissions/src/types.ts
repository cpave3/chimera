import type { PermissionRequest, PermissionResolution, PermissionRule } from '@chimera/core';

export type AutoApproveLevel = 'none' | 'sandbox' | 'host' | 'all';

export type { PermissionRequest, PermissionResolution, PermissionRule };

export type RuleScope = 'session' | 'project';

export interface StoredRulesFile {
  version: 1;
  rules: PermissionRule[];
}
