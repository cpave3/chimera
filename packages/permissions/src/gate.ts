import type {
  PermissionGate,
  PermissionRequest,
  PermissionResolution,
  PermissionRule,
  RememberScope,
} from '@chimera/core';
import { matchRule } from './matching';
import { RuleStore } from './rule-store';
import type { AutoApproveLevel } from './types';

export type RaiseRequestFn = (req: PermissionRequest) => Promise<PermissionResolution>;

export interface GateOptions {
  cwd: string;
  autoApprove: AutoApproveLevel;
  raiseRequest: RaiseRequestFn;
  sandboxMode?: 'off';
}

export class DefaultPermissionGate implements PermissionGate {
  private readonly store: RuleStore;
  private readonly autoApprove: AutoApproveLevel;
  private readonly raise: RaiseRequestFn;

  constructor(opts: GateOptions) {
    this.store = new RuleStore(opts.cwd);
    this.autoApprove = opts.autoApprove;
    this.raise = opts.raiseRequest;
  }

  check(req: PermissionRequest): PermissionResolution | null {
    const rule = matchRule(req, this.store.all());
    if (!rule) return null;
    return { decision: rule.decision, remembered: true };
  }

  /**
   * Full gate semantics:
   * 1. If auto-approve level admits the call, return allow.
   * 2. If a rule matches, return the rule's resolution.
   * 3. Otherwise call raiseRequest to suspend the agent for user decision.
   */
  async request(req: PermissionRequest): Promise<PermissionResolution> {
    if (this.autoApprove === 'all') {
      return { decision: 'allow', remembered: false };
    }
    if (this.autoApprove === 'host' && req.target === 'host') {
      return { decision: 'allow', remembered: false };
    }
    const byRule = this.check(req);
    if (byRule) return byRule;
    return this.raise(req);
  }

  addRule(rule: PermissionRule, persist: 'session' | 'project'): void {
    this.store.add(rule, persist);
  }

  listRules(): PermissionRule[] {
    return this.store.all();
  }

  removeRule(index: number): void {
    this.store.removeAt(index);
  }

  /** Exposed so CLI/tests can inspect the file path. */
  getProjectPath(): string {
    return this.store.projectPathFor();
  }

  /** Apply a RememberScope by adding a rule based on the original request. */
  applyRemember(scope: RememberScope, req: PermissionRequest, decision: 'allow' | 'deny'): void {
    if (scope.scope === 'session') {
      this.store.add(
        {
          tool: req.tool,
          target: req.target,
          pattern: req.command,
          patternKind: 'exact',
          decision,
          createdAt: Date.now(),
        },
        'session',
      );
      return;
    }
    this.store.add(
      {
        tool: req.tool,
        target: req.target,
        pattern: scope.pattern,
        patternKind: scope.patternKind,
        decision,
        createdAt: Date.now(),
      },
      'project',
    );
  }
}
