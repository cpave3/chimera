export type HookEvent =
  | 'UserPromptSubmit'
  | 'PostToolUse'
  | 'PermissionRequest'
  | 'Stop'
  | 'SessionEnd'
  | 'CompactionStart'
  | 'CompactionEnd';

export const PRE_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set(['PermissionRequest']);

export const ALL_HOOK_EVENTS: readonly HookEvent[] = [
  'UserPromptSubmit',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
  'CompactionStart',
  'CompactionEnd',
];

export interface HookPayloadBase {
  event: HookEvent;
  session_id: string;
  cwd: string;
}

export interface UserPromptSubmitPayload extends HookPayloadBase {
  event: 'UserPromptSubmit';
  user_message: string;
}

export interface PostToolUsePayload extends HookPayloadBase {
  event: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result?: unknown;
  tool_error?: string;
}

export interface PermissionRequestPayload extends HookPayloadBase {
  event: 'PermissionRequest';
  tool_name: string;
  tool_input: Record<string, unknown>;
  target: string;
  command?: string;
}

export interface StopPayload extends HookPayloadBase {
  event: 'Stop';
  reason: string;
}

export interface SessionEndPayload extends HookPayloadBase {
  event: 'SessionEnd';
}

export interface CompactionStartPayload extends HookPayloadBase {
  event: 'CompactionStart';
  reason: string;
}

export interface CompactionEndPayload extends HookPayloadBase {
  event: 'CompactionEnd';
  success: boolean;
  error?: string;
}

export type HookPayload =
  | UserPromptSubmitPayload
  | PostToolUsePayload
  | PermissionRequestPayload
  | StopPayload
  | SessionEndPayload
  | CompactionStartPayload
  | CompactionEndPayload;

export type FirePayload =
  | { event: 'UserPromptSubmit'; user_message: string }
  | {
      event: 'PostToolUse';
      tool_name: string;
      tool_input: Record<string, unknown>;
      tool_result?: unknown;
      tool_error?: string;
    }
  | {
      event: 'PermissionRequest';
      tool_name: string;
      tool_input: Record<string, unknown>;
      target: string;
      command?: string;
    }
  | { event: 'Stop'; reason: string }
  | { event: 'SessionEnd' }
  | { event: 'CompactionStart'; reason: string }
  | { event: 'CompactionEnd'; success: boolean; error?: string };

export interface HookFireResult {
  /** True only if a pre-event hook exited with code 2. */
  blocked: boolean;
  /** Absolute path of the script that blocked, when `blocked` is true. */
  blockingScript?: string;
  /** Stderr from the blocking script (trimmed), when `blocked` is true. */
  reason?: string;
}

export interface HookRunner {
  fire(payload: FirePayload): Promise<HookFireResult>;
}

export type HookLogLevel = 'warn' | 'error';

export type HookLogger = (level: HookLogLevel, msg: string, meta?: Record<string, unknown>) => void;
