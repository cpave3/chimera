import type {
  CommandPolicyContext,
  CommandPolicyEvaluator,
  McpPermissionCall,
  McpPermissionGate,
  PermissionDecisionSource,
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
  home?: string;
  autoApprove: AutoApproveLevel;
  raiseRequest: RaiseRequestFn;
  sandboxMode?: 'off';
  /**
   * When true, host-target requests that would otherwise prompt the user are
   * auto-denied. Used by subagent children whose parent has no TTY — the
   * parent can't interactively resolve the prompt, so the child denies.
   */
  headlessAutoDeny?: boolean;
  /** Deny MCP prompts when no caller can answer them, without changing other tool policy. */
  mcpHeadlessAutoDeny?: boolean;
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
  emitResolved?: (requestId: string, decision: 'allow' | 'deny', remembered: boolean) => void;
  commandPolicy?: {
    evaluator: CommandPolicyEvaluator;
    context: (request: PermissionRequest) => CommandPolicyContext;
  };
  audit?: (entry: {
    request: PermissionRequest;
    resolution: PermissionResolution;
    source: PermissionDecisionSource;
  }) => void;
}

export class DefaultPermissionGate implements McpPermissionGate {
  private readonly store: RuleStore;
  private readonly autoApprove: AutoApproveLevel;
  private readonly raise: RaiseRequestFn;
  private readonly headlessAutoDeny: boolean;
  private readonly mcpHeadlessAutoDeny: boolean;
  private readonly hookRunner: HookRunner | undefined;
  private readonly emitResolved:
    | ((requestId: string, decision: 'allow' | 'deny', remembered: boolean) => void)
    | undefined;
  private readonly commandPolicy: GateOptions['commandPolicy'];
  private readonly audit: GateOptions['audit'];

  constructor(opts: GateOptions) {
    this.store = new RuleStore(opts.cwd, opts.home);
    this.autoApprove = opts.autoApprove;
    this.raise = opts.raiseRequest;
    this.headlessAutoDeny = opts.headlessAutoDeny ?? false;
    this.mcpHeadlessAutoDeny = opts.mcpHeadlessAutoDeny ?? false;
    this.hookRunner = opts.hookRunner;
    this.emitResolved = opts.emitResolved;
    this.commandPolicy = opts.commandPolicy;
    this.audit = opts.audit;
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
  async requestMcp(
    call: McpPermissionCall,
    trustedTools: readonly string[] = [],
  ): Promise<PermissionResolution> {
    const identity = `${call.server}/${call.tool}`;
    const request: PermissionRequest = {
      requestId: call.requestId,
      tool: 'mcp',
      target: 'host',
      command: identity,
      cwd: call.cwd,
      mcp: { server: call.server, tool: call.tool, preview: mcpArgumentPreview(call.args) },
    };
    const matchingRule = matchRule(request, this.store.all());
    if (matchingRule?.decision === 'deny') {
      return this.audited(
        request,
        { decision: 'deny', remembered: true, denialSource: 'rule' },
        'rule',
      );
    }
    if (matchingRule?.decision === 'allow') {
      return this.audited(request, { decision: 'allow', remembered: true }, 'rule');
    }
    if (trustedTools.includes(call.tool)) {
      return this.audited(request, { decision: 'allow', remembered: false }, 'automatic');
    }
    return this.prompt(request);
  }

  async request(req: PermissionRequest): Promise<PermissionResolution> {
    if (req.mcp) throw new Error('Use requestMcp for MCP permissions');
    let evaluatedRequest = req;
    if (req.tool === 'bash' && this.commandPolicy) {
      const policyAnalysis = await this.commandPolicy.evaluator.evaluate(
        this.commandPolicy.context(req),
      );
      evaluatedRequest = { ...req, policyAnalysis };
      if (policyAnalysis.findings.some((finding) => finding.kind === 'blocked')) {
        this.emitResolved?.(req.requestId, 'deny', false);
        return this.audited(
          evaluatedRequest,
          { decision: 'deny', remembered: false, denialSource: 'policy' },
          'policy',
        );
      }
      if (policyAnalysis.outcome === 'approval_required') {
        const denyRule = matchRule(
          req,
          this.store.all().filter((rule) => rule.decision === 'deny'),
        );
        if (denyRule) {
          return this.audited(
            evaluatedRequest,
            { decision: 'deny', remembered: true, denialSource: 'rule' },
            'rule',
          );
        }
        const resolution = await this.prompt(evaluatedRequest);
        return resolution.decision === 'allow' && requiresSudoAuthentication(policyAnalysis)
          ? { ...resolution, authentication: 'sudo' }
          : resolution;
      }
    }
    const matchingRule = matchRule(req, this.store.all());
    if (matchingRule?.decision === 'deny') {
      return this.audited(
        evaluatedRequest,
        { decision: 'deny', remembered: true, denialSource: 'rule' },
        'rule',
      );
    }
    if (this.autoApprove === 'all') {
      return this.audited(evaluatedRequest, { decision: 'allow', remembered: false }, 'automatic');
    }
    if (this.autoApprove === 'host' && req.target === 'host') {
      return this.audited(evaluatedRequest, { decision: 'allow', remembered: false }, 'automatic');
    }
    const byRule = matchingRule ? this.check(req) : null;
    if (byRule) return this.audited(evaluatedRequest, byRule, 'rule');
    return this.prompt(evaluatedRequest);
  }

  private async prompt(req: PermissionRequest): Promise<PermissionResolution> {
    if (this.hookRunner) {
      const result = await this.hookRunner.fire({
        event: 'PermissionRequest',
        tool_name: req.tool,
        tool_input: req.mcp
          ? { mcp: req.mcp }
          : { command: req.command, ...(req.reason ? { reason: req.reason } : {}) },
        target: req.target,
        command: req.command,
        ...(req.policyAnalysis ? { policy_analysis: req.policyAnalysis } : {}),
      });
      if (result.blocked) {
        this.emitResolved?.(req.requestId, 'deny', false);
        return this.audited(
          req,
          { decision: 'deny', remembered: false, denialSource: 'hook' },
          'hook',
        );
      }
    }
    if ((this.headlessAutoDeny || (req.mcp && this.mcpHeadlessAutoDeny)) && req.target === 'host') {
      this.emitResolved?.(req.requestId, 'deny', false);
      return this.audited(
        req,
        { decision: 'deny', remembered: false, denialSource: 'headless' },
        'headless',
      );
    }
    const raised = await this.raise(req);
    const resolution =
      raised.decision === 'deny' && !raised.denialSource
        ? { ...raised, denialSource: 'user' as const }
        : raised;
    return this.audited(req, resolution, 'user');
  }

  private audited(
    request: PermissionRequest,
    resolution: PermissionResolution,
    source: PermissionDecisionSource,
  ): PermissionResolution {
    this.audit?.({ request, resolution, source });
    return resolution;
  }

  addRule(rule: PermissionRule, persist: 'session' | 'project' | 'global'): void {
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
    if (req.mcp) {
      this.store.add(
        {
          tool: 'mcp',
          target: 'host',
          pattern: `${req.mcp.server}/${req.mcp.tool}`,
          patternKind: 'exact',
          decision,
          createdAt: Date.now(),
        },
        scope.scope,
      );
      return;
    }
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
      scope.scope,
    );
  }
}

function mcpArgumentPreview(args: unknown): Array<{ name: string; type: string }> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.entries(args)
    .slice(0, 16)
    .map(([name, value]) => ({
      name: /secret|token|password|key|auth|credential/i.test(name)
        ? '[redacted]'
        : name.slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '_'),
      type: /secret|token|password|key|auth|credential/i.test(name)
        ? 'redacted'
        : Array.isArray(value)
          ? 'array'
          : value === null
            ? 'null'
            : typeof value === 'object'
              ? 'object'
              : typeof value,
    }));
}

function requiresSudoAuthentication(
  analysis: Awaited<ReturnType<CommandPolicyEvaluator['evaluate']>>,
): boolean {
  return analysis.findings.some(
    (finding) => finding.kind === 'elevation' && finding.ruleId === 'sudo',
  );
}
