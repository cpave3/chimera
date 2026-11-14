import type {
  CommandPolicyAnalysis,
  CommandPolicyContext,
  CommandPolicyEvaluator,
  CommandPolicyFinding,
  LifecycleDecision,
  LifecycleHookData,
  McpPermissionCall,
  McpPermissionGate,
  PermissionDecisionSource,
  PermissionRequest,
  PermissionResolution,
  PermissionRule,
  RememberScope,
} from '@chimera/core';
import { matchRule } from './matching';
import type { ApprovalReview, ApprovalReviewer } from './reviewer';
import { RuleStore } from './rule-store';
import type { SystemOneCheck, SystemOneVerdict } from './system-one';
import type { AutoApproveLevel } from './types';

export type RaiseRequestFn = (req: PermissionRequest) => Promise<PermissionResolution>;

export type ModPermissionDecision =
  | 'allow'
  | 'deny'
  | 'pass'
  | { decision: 'allow' | 'deny' | 'pass'; message?: string };

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
  /** Runs after rules and automatic approvals, before the remaining approval chain. */
  interceptPermission?: (
    request: PermissionRequest,
    args: unknown,
  ) => Promise<ModPermissionDecision>;
  /**
   * Optional lifecycle callback. When set, dispatched with `PermissionRequest`
   * between rule check and user prompt. A blocking hook (exit 2) denies the
   * call without raising the prompt; the executor renders this as
   * `{ error: "denied by hook" }`.
   */
  permissionRequest?: (
    payload: Extract<LifecycleHookData, { type: 'PermissionRequest' }>,
  ) => Promise<LifecycleDecision>;
  /**
   * Optional callback invoked when the gate resolves a request without
   * routing through `raiseRequest` (e.g., the hook subsystem blocks the
   * call). The factory wires this to `Agent.emitPermissionResolved` so the
   * `permission_resolved` event and lifecycle hook finish before execution resumes.
   */
  emitResolved?: (
    requestId: string,
    decision: 'allow' | 'deny',
    remembered: boolean,
  ) => void | Promise<void>;
  commandPolicy?: {
    evaluator: CommandPolicyEvaluator;
    context: (request: PermissionRequest) => CommandPolicyContext;
  };
  audit?: (entry: {
    request: PermissionRequest;
    resolution: PermissionResolution;
    source: PermissionDecisionSource;
    review?: ApprovalReview;
    systemOne?: SystemOneVerdict;
  }) => void;
  /**
   * Examines a request before the user is asked about it. Without one,
   * every request that needs approval goes to the user.
   */
  reviewer?: ApprovalReviewer;
  /** Called with each decision of the reviewer. */
  onReview?: (request: PermissionRequest, review: ApprovalReview) => void;
  /**
   * Rates a bash command before the reviewer and the user. A command it
   * approves runs; one it rejects goes to the user with its note.
   */
  systemOne?: SystemOneCheck;
  /** Called with each verdict of the System One check. */
  onSystemOne?: (request: PermissionRequest, verdict: SystemOneVerdict) => void;
}

/**
 * Adjust what the policy found to where the command will run.
 *
 * In the OS sandbox the kernel refuses a write outside the allowed
 * directories and reads are allowed by design, so a path finding is no
 * reason to ask the user. A request to leave the sandbox is the opposite: it
 * requires explicit authorization, so it gains a finding of its own.
 */
function forExecutionScope(
  analysis: CommandPolicyAnalysis,
  request: PermissionRequest,
): CommandPolicyAnalysis {
  if (request.osSandbox) {
    const enforcedByKernel = (finding: CommandPolicyFinding) => finding.kind === 'path';
    const findings = analysis.findings.filter((finding) => !enforcedByKernel(finding));
    return {
      ...analysis,
      outcome: findings.length === 0 ? 'pass' : 'approval_required',
      findings,
      stages: analysis.stages.map((stage) => ({
        ...stage,
        findings: stage.findings.filter((finding) => !enforcedByKernel(finding)),
      })),
      grantProposal: undefined,
    };
  }
  if (request.unsandboxed) {
    const finding: CommandPolicyFinding = {
      kind: 'elevation',
      stageId: 'os_sandbox',
      ruleId: 'unsandboxed',
      message: `Runs outside the OS sandbox: ${request.reason ?? 'no reason given'}`,
    };
    return {
      ...analysis,
      outcome: 'approval_required',
      findings: [...analysis.findings, finding],
      stages: [...analysis.stages, { id: 'os_sandbox', status: 'findings', findings: [finding] }],
    };
  }
  return analysis;
}

export class DefaultPermissionGate implements McpPermissionGate {
  private readonly store: RuleStore;
  private readonly autoApprove: AutoApproveLevel;
  private readonly raise: RaiseRequestFn;
  private readonly headlessAutoDeny: boolean;
  private readonly mcpHeadlessAutoDeny: boolean;
  private readonly interceptPermission: GateOptions['interceptPermission'];
  private readonly permissionRequest: GateOptions['permissionRequest'];
  private readonly emitResolved:
    | ((requestId: string, decision: 'allow' | 'deny', remembered: boolean) => void | Promise<void>)
    | undefined;
  private readonly commandPolicy: GateOptions['commandPolicy'];
  private readonly audit: GateOptions['audit'];
  private readonly reviewer: ApprovalReviewer | undefined;
  private readonly onReview: GateOptions['onReview'];
  private readonly systemOne: SystemOneCheck | undefined;
  private readonly onSystemOne: GateOptions['onSystemOne'];

  constructor(opts: GateOptions) {
    this.store = new RuleStore(opts.cwd, opts.home);
    this.autoApprove = opts.autoApprove;
    this.raise = opts.raiseRequest;
    this.headlessAutoDeny = opts.headlessAutoDeny ?? false;
    this.mcpHeadlessAutoDeny = opts.mcpHeadlessAutoDeny ?? false;
    this.interceptPermission = opts.interceptPermission;
    this.permissionRequest = opts.permissionRequest;
    this.emitResolved = opts.emitResolved;
    this.commandPolicy = opts.commandPolicy;
    this.audit = opts.audit;
    this.reviewer = opts.reviewer;
    this.onReview = opts.onReview;
    this.systemOne = opts.systemOne;
    this.onSystemOne = opts.onSystemOne;
  }

  async check(req: PermissionRequest): Promise<PermissionResolution | null> {
    const rule = await matchRule(req, this.store.all());
    if (!rule) return null;
    return {
      decision: rule.decision,
      remembered: true,
      ...(rule.decision === 'deny' ? { denialSource: 'rule' as const } : {}),
    };
  }

  /**
   * Full gate semantics:
   * 1. Deny rules and blocked policy findings cannot be overridden.
   * 2. Apply automatic approvals and matching allow rules, then mod interception.
   * 3. If a permissionRequest callback is configured, dispatch PermissionRequest.
   *    A pre-hook block (exit 2) denies without raising the user prompt — the executor
   *    renders this denial as `{ error: "denied by hook" }`.
   * 4. If a System One check is configured and the request is its to decide,
   *    its `allow` allows the call. Its rejection goes to the user with its
   *    note, past the reviewer.
   * 5. If an approval reviewer is configured and the request is its to
   *    decide, its `allow` allows the call and its `escalate` goes on.
   * 6. If headlessAutoDeny and host target, deny without raising.
   * 7. Otherwise call raiseRequest to suspend the agent for user decision.
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
      ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
    };
    const matchingRule = await matchRule(request, this.store.all());
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
    return this.prompt(request, call.args);
  }

  async request(req: PermissionRequest): Promise<PermissionResolution> {
    return (await this.decide(req, false))!;
  }

  async requestRememberedBypass(req: PermissionRequest): Promise<PermissionResolution | null> {
    return this.decide({ ...req, unsandboxed: true, osSandbox: false }, true);
  }

  private async decide(
    req: PermissionRequest,
    rememberedBypassOnly: boolean,
  ): Promise<PermissionResolution | null> {
    if (req.mcp) throw new Error('Use requestMcp for MCP permissions');
    let evaluatedRequest = req;
    // A request to leave the OS sandbox is decided by the user also when the
    // command policy is turned off.
    if (req.tool === 'bash' && (this.commandPolicy || req.unsandboxed)) {
      const policyAnalysis = forExecutionScope(
        this.commandPolicy
          ? await this.commandPolicy.evaluator.evaluate(this.commandPolicy.context(req))
          : { version: 1, outcome: 'pass', stages: [], findings: [] },
        req,
      );
      evaluatedRequest = { ...req, policyAnalysis };
      if (policyAnalysis.findings.some((finding) => finding.kind === 'blocked')) {
        await this.emitResolved?.(req.requestId, 'deny', false);
        return this.audited(
          evaluatedRequest,
          { decision: 'deny', remembered: false, denialSource: 'policy' },
          'policy',
        );
      }
      if (policyAnalysis.outcome === 'approval_required') {
        const denyRule = await matchRule(
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
        const bypassRule = req.unsandboxed
          ? await matchRule(
              req,
              this.store
                .all()
                .filter(
                  (rule) =>
                    rule.decision === 'allow' &&
                    rule.allowUnsandboxed &&
                    rule.patternKind !== 'glob',
                ),
            )
          : null;
        if (
          bypassRule &&
          policyAnalysis.findings.every(
            (finding) =>
              finding.kind === 'elevation' &&
              finding.stageId === 'os_sandbox' &&
              finding.ruleId === 'unsandboxed',
          )
        ) {
          return this.audited(evaluatedRequest, { decision: 'allow', remembered: true }, 'rule');
        }
        if (rememberedBypassOnly) return this.retryApprovedBySystemOne(evaluatedRequest);
        const resolution = await this.prompt(evaluatedRequest);
        return resolution.decision === 'allow' && requiresSudoAuthentication(policyAnalysis)
          ? { ...resolution, authentication: 'sudo' }
          : resolution;
      }
    }
    if (rememberedBypassOnly) return null;
    const matchingRule = await matchRule(req, this.store.all());
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
    const byRule = matchingRule ? await this.check(req) : null;
    if (byRule) return this.audited(evaluatedRequest, byRule, 'rule');
    return this.prompt(evaluatedRequest);
  }

  /** The denial of a blocking `PermissionRequest` hook, or null when no hook blocks. */
  private async deniedByHook(req: PermissionRequest): Promise<PermissionResolution | null> {
    if (!this.permissionRequest) return null;
    const result = await this.permissionRequest({
      type: 'PermissionRequest',
      tool_name: req.tool,
      tool_input: req.mcp
        ? { mcp: req.mcp }
        : { command: req.command, ...(req.reason ? { reason: req.reason } : {}) },
      target: req.target,
      command: req.command,
      ...(req.policyAnalysis ? { policy_analysis: req.policyAnalysis } : {}),
    });
    if (!result.blocked) return null;
    await this.emitResolved?.(req.requestId, 'deny', false);
    return this.audited(req, { decision: 'deny', remembered: false, denialSource: 'hook' }, 'hook');
  }

  /** The System One check's verdict on a request, or undefined when it has none. */
  private async checkedBySystemOne(req: PermissionRequest): Promise<SystemOneVerdict | undefined> {
    const verdict = (await this.systemOne?.check(req)) ?? undefined;
    if (verdict) this.onSystemOne?.(req, verdict);
    return verdict;
  }

  /**
   * The automatic host retry of a command the OS sandbox stopped. Nobody is
   * asked: the retry happens only when the System One check approves it. A
   * hook can still block what the check approved.
   */
  private async retryApprovedBySystemOne(
    req: PermissionRequest,
  ): Promise<PermissionResolution | null> {
    const intercepted = await this.interceptedByMod(req);
    if (intercepted) return intercepted;
    const verdict = await this.checkedBySystemOne(req);
    if (verdict?.decision !== 'allow') return null;
    const hookDenial = await this.deniedByHook(req);
    if (hookDenial) return hookDenial;
    await this.emitResolved?.(req.requestId, 'allow', false);
    return this.audited(
      req,
      { decision: 'allow', remembered: false },
      'system_one',
      undefined,
      verdict,
    );
  }

  /**
   * Put a request to whoever decides it: a blocking hook, the System One
   * check, the approval reviewer, then the user. `mcpArguments` are for the
   * reviewer only; the request itself goes to clients without argument values.
   */
  private async prompt(
    req: PermissionRequest,
    mcpArguments?: unknown,
  ): Promise<PermissionResolution> {
    const intercepted = await this.interceptedByMod(req, mcpArguments);
    if (intercepted) return intercepted;
    const hookDenial = await this.deniedByHook(req);
    if (hookDenial) return hookDenial;
    const verdict = await this.checkedBySystemOne(req);
    if (verdict?.decision === 'allow') {
      await this.emitResolved?.(req.requestId, 'allow', false);
      return this.audited(
        req,
        { decision: 'allow', remembered: false },
        'system_one',
        undefined,
        verdict,
      );
    }
    // A rejection is for the user. The reviewer gets only what the check had no opinion on.
    const rejected = verdict !== undefined && !verdict.failed;
    const review =
      req.unsandboxed || rejected
        ? undefined
        : ((await this.reviewer?.review({
            request: req,
            ...(mcpArguments === undefined ? {} : { mcpArguments }),
          })) ?? undefined);
    if (review) this.onReview?.(req, review);
    if (review?.decision === 'allow') {
      await this.emitResolved?.(req.requestId, 'allow', false);
      return this.audited(
        req,
        { decision: 'allow', remembered: false },
        'reviewer',
        review,
        verdict,
      );
    }
    if ((this.headlessAutoDeny || (req.mcp && this.mcpHeadlessAutoDeny)) && req.target === 'host') {
      await this.emitResolved?.(req.requestId, 'deny', false);
      // Somebody wanted the user to decide, and there is nobody to ask: the
      // model gets that reason in place of a bare denial.
      if (review) {
        return this.audited(
          req,
          {
            decision: 'deny',
            remembered: false,
            denialSource: 'reviewer',
            reviewerReason: review.reason,
          },
          'reviewer',
          review,
          verdict,
        );
      }
      if (rejected) {
        return this.audited(
          req,
          {
            decision: 'deny',
            remembered: false,
            denialSource: 'system_one',
            systemOneNote: verdict.note,
          },
          'system_one',
          undefined,
          verdict,
        );
      }
      return this.audited(
        req,
        { decision: 'deny', remembered: false, denialSource: 'headless' },
        'headless',
        undefined,
        verdict,
      );
    }
    const raised = await this.raise({
      ...req,
      ...(review ? { reviewerReason: review.reason } : {}),
      ...(verdict ? { systemOneNote: verdict.note } : {}),
    });
    const resolution =
      raised.decision === 'deny' && !raised.denialSource
        ? { ...raised, denialSource: 'user' as const }
        : raised;
    return this.audited(req, resolution, 'user', review, verdict);
  }

  private async interceptedByMod(
    request: PermissionRequest,
    args?: unknown,
  ): Promise<PermissionResolution | null> {
    if (!this.interceptPermission) return null;
    const result = await this.interceptPermission(request, args);
    const decision = typeof result === 'string' ? result : result.decision;
    if (decision === 'pass') return null;
    await this.emitResolved?.(request.requestId, decision, false);
    return this.audited(
      request,
      {
        decision,
        remembered: false,
        ...(decision === 'deny' ? { denialSource: 'mod' as const } : {}),
        ...(typeof result === 'object' && result.message ? { feedback: result.message } : {}),
      },
      'mod',
    );
  }

  private audited(
    request: PermissionRequest,
    resolution: PermissionResolution,
    source: PermissionDecisionSource,
    review?: ApprovalReview,
    systemOne?: SystemOneVerdict,
  ): PermissionResolution {
    this.audit?.({
      request,
      resolution,
      source,
      ...(review ? { review } : {}),
      ...(systemOne ? { systemOne } : {}),
    });
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
    this.store.add(
      {
        tool: req.tool,
        target: req.target,
        pattern: scope.pattern,
        patternKind: scope.patternKind,
        ...(scope.allowUnsandboxed && req.unsandboxed ? { allowUnsandboxed: true } : {}),
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
