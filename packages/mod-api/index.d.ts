/** Types only. Use import type; mods receive their runtime API through register(on). */
export type Awaitable<T> = T | Promise<T>;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type TurnSource = 'user' | 'continuation' | 'background' | 'stop_retry' | 'goal';
export type RunEndReason =
  | 'stop'
  | 'max_steps'
  | 'error'
  | 'interrupted'
  | 'timeout'
  | 'waiting_for_input'
  | 'output_limit';
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  stepCount: number;
  lastStep?: Omit<Usage, 'stepCount' | 'lastStep'>;
}
export interface ModModel {
  providerId: string;
  modelId: string;
  maxSteps: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  [key: string]: unknown;
}
export interface ModSession {
  readonly id: string;
  readonly name: string | undefined;
  readonly cwd: string;
  readonly status: string;
  readonly parentId: string | null;
  readonly isSubagent: boolean;
  readonly model: Readonly<ModModel>;
  readonly usage: Readonly<Usage>;
  messages(): readonly Readonly<{ role: string; content: unknown }>[];
}
export type PromptResult =
  | { accepted: true }
  | { queued: true }
  | { dropped: true; reason: string };
export interface ProcessOptions {
  argv: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}
export interface ProcessHandle {
  write(text: string): Promise<void>;
  close(): void;
  kill(signal?: string): void;
  readonly output: AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>;
  readonly exitPromise: Promise<{ code: number | null; signal: string | null }>;
}
export interface ModContext {
  readonly chimera: { readonly version: string };
  readonly api: { readonly version: 1 };
  readonly session: ModSession;
  readonly server: { url(): string };
  readonly prompt: { submit(input: { text: string }): Promise<PromptResult> };
  readonly message: { append(text: string): Promise<void> };
  readonly turn: { abort(): Awaitable<void> };
  readonly process: { spawn(options: ProcessOptions): ProcessHandle };
  readonly http: { fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> };
  readonly env: {
    get(name: string): string | undefined;
    set(name: string, value: string | undefined): void;
  };
  readonly clock: { now(): number; sleep(milliseconds: number): Promise<void> };
  readonly ui: {
    log(text: string, options: { to: 'debug' | 'status' | 'scrollback' }): Awaitable<void>;
  };
  readonly store: {
    readonly directory: string;
    get<T = Json>(key: string): Promise<T | undefined>;
    set(key: string, value: Json): Promise<void>;
    delete(key: string): Promise<void>;
  };
}
export interface EventBase {
  sessionId: string;
  [key: string]: unknown;
}
export interface ModEventMap {
  'session.start': EventBase & {
    reason: 'new' | 'resume' | 'fork' | 'switch';
    name: string;
    parentSessionId?: string;
  };
  'session.end': EventBase & { reason: 'exit' | 'signal' | 'delete' | 'switch' };
  'turn.start': EventBase & { turnId: string; source: TurnSource };
  'turn.complete': EventBase & {
    turnId?: string;
    reason: RunEndReason;
    error?: string;
    model: ModModel;
    usage: Usage;
    contextFill: number;
  };
  'permission.request': EventBase & { requestId: string; toolName: string; args: unknown };
  'permission.resolved': EventBase & {
    requestId: string;
    decision: 'allow' | 'deny';
    remembered: boolean;
  };
  'question.request': EventBase & {
    requestId: string;
    questions: {
      question: string;
      header?: string;
      options: { label: string; description?: string }[];
    }[];
  };
  'question.resolved': EventBase & { requestId: string; status: 'answered' | 'cancelled' };
  'agent.spawn': EventBase & { agentId: string; description: string; background: boolean };
  'agent.finish': EventBase & {
    agentId: string;
    description?: string;
    background?: boolean;
    reason?: string;
  };
  'background.start': EventBase & { jobId: string; command: string };
  'background.exit': EventBase & { jobId: string; command?: string; exitCode?: number | null };
  'compaction.start': EventBase & { reason: 'threshold' | 'manual' | 'overflow' };
  'compaction.end': EventBase &
    (
      | {
          success: true;
          summary: string;
          tokensBefore: number;
          tokensAfter: number;
          messagesReplaced: number;
        }
      | { success: false; error: string }
    );
  'message.append': EventBase & { text: string };
  'tool.call': EventBase & { toolName: string; args: unknown; additionalContext?: string };
  'turn.step': EventBase & {
    model: string;
    effort?: string;
    providerOptions?: Record<string, unknown>;
    systemPrompt: string;
    usage?: Omit<Usage, 'stepCount' | 'lastStep'>;
  };
  'prompt.submit': EventBase & { text: string; source?: TurnSource };
  'turn.stop': EventBase & { reason: RunEndReason };
}
export type HookName = keyof ModEventMap;
export type ModEvent<Name extends HookName = HookName> = {
  [Key in Name]: ModEventMap[Key] & { type: Key };
}[Name];
export type PermissionDecision =
  | 'allow'
  | 'deny'
  | 'pass'
  | { decision: 'allow' | 'deny' | 'pass'; message?: string };
export type ToolBlock = { decision: 'block'; reason?: string };
export type PromptDecision = { decision: 'drop'; reason: string } | { decision: 'accept' };
export type StopDecision = { decision: 'block'; reason?: string };
export type InterceptionResult =
  | PermissionDecision
  | ToolBlock
  | PromptDecision
  | StopDecision
  | Json
  | undefined;
export type Next = () => Promise<unknown>;
export type ModHandler<Name extends HookName> = (
  $: ModContext,
  event: ModEvent<Name>,
  next: Next,
) => Awaitable<unknown>;
export type On = <Name extends HookName>(name: Name, handler: ModHandler<Name>) => void;
export type Register = (on: On) => Awaitable<void>;
export interface ModManifest {
  name: string;
  version: string;
  apiVersion: 1;
  description?: string;
  module?: string;
  skills?: string;
  commands?: string;
  agents?: string;
  modes?: string;
  mcpServers?: Record<
    string,
    (
      | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
      | { transport: 'http'; url: string; clientId?: string }
    ) & { trustedTools?: string[]; subagents?: boolean }
  >;
}
export interface ModCall {
  path: string;
  args: unknown[];
}
export interface ModEmission {
  event: ModEvent;
  result: unknown;
}
/** Each test file exports test(harness). No runtime Chimera import is needed. */
export interface ModTestHarness {
  readonly $: ModContext;
  readonly calls: ModCall[];
  readonly results: ModEmission[];
  readonly processes: ProcessOptions[];
  setResult(path: string, result: unknown): void;
  emit(event: ModEvent, terminalResult?: unknown): Promise<unknown>;
}
export type ModTest = (harness: ModTestHarness) => Awaitable<void>;
