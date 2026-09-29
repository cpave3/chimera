import type { LanguageModel } from 'ai';
import type { CommandPolicyAnalysis, CommandPolicyGrantProposal } from './command-policy';
import type { ExecutionTarget, RememberScope } from './types';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
  /**
   * Tool name that triggered this exec call, forwarded to the permission gate
   * so rule matching works correctly (e.g. `glob`, `grep`, `bash`).
   */
  toolName?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** True when stdout exceeded the executor's per-stream byte cap and was truncated. */
  stdoutTruncated: boolean;
  /** True when stderr exceeded the executor's per-stream byte cap and was truncated. */
  stderrTruncated: boolean;
}

export interface StatResult {
  exists: boolean;
  isDir: boolean;
  size: number;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface Executor {
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<StatResult | null>;
  readdir(path: string): Promise<DirEntry[]>;
  cwd(): string;
  target(): ExecutionTarget;
}

export interface ModelClient {
  getModel(modelRef: string): LanguageModel;
}

export interface McpPermissionCall {
  requestId: string;
  server: string;
  tool: string;
  cwd: string;
  args: unknown;
}

export interface McpPermissionPreview {
  server: string;
  tool: string;
  preview: Array<{ name: string; type: string }>;
}

export interface PermissionRequest {
  requestId: string;
  tool: string;
  target: 'host';
  command: string;
  reason?: string;
  cwd: string;
  /** Set only for host bash requests that require mandatory policy approval. */
  policyAnalysis?: CommandPolicyAnalysis;
  /** MCP identity and bounded, value-free argument shape. Never contains raw arguments. */
  mcp?: McpPermissionPreview;
}

export type PermissionDecisionAction =
  | { decision: 'allow'; remember?: RememberScope }
  | { decision: 'deny'; feedback?: string }
  | {
      decision: 'allow_with_grant';
      grant: CommandPolicyGrantProposal;
    };

export type PermissionDecisionSource =
  | 'automatic'
  | 'rule'
  | 'hook'
  | 'headless'
  | 'policy'
  | 'user';

export interface PermissionResolution {
  decision: 'allow' | 'deny';
  remembered: boolean;
  feedback?: string;
  grant?: CommandPolicyGrantProposal;
  /** Post-approval OS authentication required before executing this request. */
  authentication?: 'sudo';
  /**
   * Origin of the decision, used by the executor to render the right
   * "denied by ..." message and by consumers that need to distinguish
   * automated denials from interactive ones. Optional — absent on paths
   * that don't track denial origin (e.g. pre-existing factories).
   *
   * - `rule`     — matched a deny rule in the rule store.
   * - `hook`     — blocked by a `PermissionRequest` lifecycle hook.
   * - `headless` — server-side auto-deny when the parent has no TTY.
   * - `user`     — interactively rejected at the prompt.
   */
  denialSource?: Exclude<PermissionDecisionSource, 'automatic'>;
}

export type HostAuthenticationResult =
  | { status: 'validated' }
  | { status: 'failed' | 'cancelled' | 'unavailable'; message: string };

export type HostAuthenticationCheckResult =
  | { status: 'validated' | 'password_required' }
  | { status: 'unavailable'; message: string };

export interface HostAuthenticationCapability {
  checkSudo(request: {
    requestId: string;
    command: string;
    signal?: AbortSignal;
  }): Promise<HostAuthenticationCheckResult>;
  authenticateSudo(request: {
    requestId: string;
    command: string;
    password: Uint8Array;
    signal?: AbortSignal;
  }): Promise<HostAuthenticationResult>;
  consumeSudoAuthentication(requestId: string): boolean;
}

export interface PermissionGate {
  check(req: PermissionRequest): PermissionResolution | null;
  request(req: PermissionRequest): Promise<PermissionResolution>;
  addRule(rule: PermissionRule, persist: 'session' | 'project' | 'global'): void;
  listRules(): PermissionRule[];
  removeRule(index: number): void;
}

export interface McpPermissionGate extends PermissionGate {
  /** MCP calls must pass this gate before tools/call, not the host execution gate. */
  requestMcp(
    call: McpPermissionCall,
    trustedTools?: readonly string[],
  ): Promise<PermissionResolution>;
}

export interface PermissionRule {
  tool: string;
  target: ExecutionTarget;
  pattern: string;
  patternKind: 'exact' | 'glob';
  decision: 'allow' | 'deny';
  createdAt: number;
}
