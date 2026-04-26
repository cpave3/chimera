import type { LanguageModel } from 'ai';
import type { ExecutionTarget } from './types';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface StatResult {
  exists: boolean;
  isDir: boolean;
  size: number;
}

export interface Executor {
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<StatResult | null>;
  cwd(): string;
  target(): ExecutionTarget;
}

export interface ModelClient {
  getModel(modelRef: string): LanguageModel;
}

export interface PermissionRequest {
  requestId: string;
  tool: string;
  target: 'host';
  command: string;
  reason?: string;
  cwd: string;
}

export interface PermissionResolution {
  decision: 'allow' | 'deny';
  remembered: boolean;
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
  denialSource?: 'rule' | 'hook' | 'headless' | 'user';
}

export interface PermissionGate {
  check(req: PermissionRequest): PermissionResolution | null;
  request(req: PermissionRequest): Promise<PermissionResolution>;
  addRule(rule: PermissionRule, persist: 'session' | 'project'): void;
  listRules(): PermissionRule[];
  removeRule(index: number): void;
}

export interface PermissionRule {
  tool: string;
  target: ExecutionTarget;
  pattern: string;
  patternKind: 'exact' | 'glob';
  decision: 'allow' | 'deny';
  createdAt: number;
}
