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
