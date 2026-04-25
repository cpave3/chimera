import type { ModelMessage } from 'ai';
import type { CallId, SessionId } from './ids';

export type SandboxMode = 'off' | 'bind' | 'overlay' | 'ephemeral';

export type ExecutionTarget = 'sandbox' | 'host';

export interface ModelConfig {
  providerId: string;
  modelId: string;
  maxSteps: number;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolCallRecord {
  callId: CallId;
  name: string;
  args: unknown;
  target: ExecutionTarget;
  result?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_permission'
  | 'error';

export interface Session {
  id: SessionId;
  cwd: string;
  createdAt: number;
  messages: ModelMessage[];
  toolCalls: ToolCallRecord[];
  status: SessionStatus;
  model: ModelConfig;
  sandboxMode: SandboxMode;
}

export type RememberScope =
  | { scope: 'session' }
  | { scope: 'project'; pattern: string; patternKind: 'exact' | 'glob' };
