import type {
  PermissionGate,
  PermissionRequest,
  PermissionResolution,
  PermissionRule,
  RememberScope,
} from '@chimera/core';
import type { HookRunner } from '@chimera/hooks';
import { matchRule } from './matching';
import { RuleStore } from './rule-store';
import type { AutoApproveLevel } from './types';

export type RaiseRequestFn = (req: PermissionRequest) => Promise<PermissionResolution>;

export interface GateOptions {
  cwd: string;
  autoApprove: AutoApproveLevel;
  raiseRequest: RaiseRequestFn;
  sandboxMode?: 'off';
  /**
   * When true, host-target requests that would otherwise prompt the user are
   * auto-denied. Used by subagent children whose parent has no TTY — the
   * parent can't interactively resolve the prompt, so the child denies.
   */
  headlessAutoDeny?: boolean;
  /**
   * Optional lifecycle-hook runner. When set, fired with `PermissionRequest`
   * between rule check and user prompt. A blocking hook (exit 2) denies the
   * call without raising the prompt; the executor renders this as
   * `{ error: "denied by hook" }`.
   */
  hookRunner?: HookRunner;
  /**
   * Optional callback invoked when the gate resolves a request without
   * routing through `raiseRequest` (e.g., the hook subsystem blocks the
   * call). The factory wires this to `Agent.emitPermissionResolved` so the
   * `permission_resolved` event still fires for hook-decided denials.
   */
  emitResolved?: (
    requestId: string,
    decision: 'allow' | 'deny',
    remembered: boolean,
  ) => void;
}

export class DefaultPermissionGate implements PermissionGate {
  private readonly store: RuleStore;
  private readonly autoApprove: AutoApproveLevel;
  private readonly raise: RaiseRequestFn;
  private readonly headlessAutoDeny: boolean;
  private readonly hookRunner: HookRunner | undefined;
  private readonly emitResolved:
    | ((requestId: string, decision: 'allow' | 'deny', remembered: boolean) => void)
    | undefined;

  constructor(opts: GateOptions) {
    this.store = new RuleStore(opts.cwd);
    this.autoApprove = opts.autoApprove;
    this.raise = opts.raiseRequest;
    this.headlessAutoDeny = opts.headlessAutoDeny ?? false;
    this.hookRunner = opts.hookRunner;
    this.emitResolved = opts.emitResolved;
  }

  check(req: PermissionRequest): PermissionResolution | null {
    const rule = matchRule(req, this.store.all());
    if (!rule) return null;
    return {
      decision: rule.decision,
      remembered: true,
      ...(rule.decision === 'deny' ? { denialSource: 'rule' as const } : {}),
    };
  }

  /**
   * Full gate semantics:
   * 1. If auto-approve level admits the call, return allow.
   * 2. If a rule matches, return the rule's resolution.
   * 3. If a hookRunner is configured, fire PermissionRequest. A pre-hook
   *    block (exit 2) denies without raising the user prompt — the executor
   *    renders this denial as `{ error: "denied by hook" }`.
   * 4. If headlessAutoDeny and host target, deny without raising.
   * 5. Otherwise call raiseRequest to suspend the agent for user decision.
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
    if (this.hookRunner) {
      const result = await this.hookRunner.fire({
        event: 'PermissionRequest',
        tool_name: req.tool,
        tool_input: { command: req.command, ...(req.reason ? { reason: req.reason } : {}) },
        target: req.target,
        command: req.command,
      });
      if (result.blocked) {
        this.emitResolved?.(req.requestId, 'deny', false);
        return { decision: 'deny', remembered: false, denialSource: 'hook' };
      }
    }
    if (this.headlessAutoDeny && req.target === 'host') {
      this.emitResolved?.(req.requestId, 'deny', false);
      return { decision: 'deny', remembered: false, denialSource: 'headless' };
    }
    const raised = await this.raise(req);
    if (raised.decision === 'deny' && !raised.denialSource) {
      return { ...raised, denialSource: 'user' };
    }
    return raised;
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
