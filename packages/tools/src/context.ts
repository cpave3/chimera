import type {
  EditFormat,
  Executor,
  HostAuthenticationCapability,
  PermissionGate,
  QuestionRequest,
  QuestionResolution,
  SandboxMode,
} from '@chimera/core';
import type { BackgroundProcessManager } from './background';
import type { DiagnosticsRunner } from './diagnostics';
import type { OsSandbox } from './os-sandbox';
import type { RecallStoreApi } from './recall';
import type { UserInputRequest } from './request-user-input';
import type { TaskListStore } from './task-list';
import type { WebSearchProvider } from './web-search';

export interface ToolContext {
  sandboxExecutor: Executor;
  hostExecutor: Executor;
  /** Raw host executor used only after the bash tool's explicit policy gate. */
  bashHostExecutor?: Executor;
  permissionGate?: PermissionGate;
  hostAuthentication?: HostAuthenticationCapability;
  commandRequiresSudo?: (command: string) => Promise<boolean>;
  sandboxMode: SandboxMode;
  /**
   * Tool-call compatibility surface exposed to the model. Undefined uses
   * Chimera's native tool names and schemas.
   */
  toolCallShape?: 'chimera' | 'codex';
  /**
   * `patch` registers `apply_patch` in place of `edit`. Undefined means
   * `replace`.
   */
  editFormat?: EditFormat;
  /**
   * When present, the bash tool accepts `run_in_background` and the
   * `bash_output` / `bash_kill` tools are registered. Background processes
   * always run on the host.
   */
  backgroundProcesses?: BackgroundProcessManager;
  /**
   * When present, edit/write run the matching checks after each successful
   * mutation and attach failures to the tool result as a `diagnostics` field,
   * so the model sees breakage in the same step that caused it.
   */
  diagnostics?: DiagnosticsRunner;
  /** When present, the web_search tool is registered. */
  webSearch?: WebSearchProvider;
  /** When present, the task_list tool is registered. */
  taskList?: TaskListStore;
  /** When present, the recall tool is registered (archived tool outputs). */
  recall?: RecallStoreApi;
  /** When present, the request_user_input tool is registered. */
  requestUserInput?: (request: UserInputRequest) => Promise<void>;
  /** When present, host bash commands run inside the operating system's sandbox. */
  osSandbox?: OsSandbox;
  /**
   * Set when the OS sandbox is required and not available: every host bash
   * command is refused with this message.
   */
  hostCommandsRefused?: string;
  /**
   * When present, the ask_question tool is registered. `ask` puts the
   * questions to the user; without it the tool answers that no user is
   * available.
   */
  questions?: { ask?: (request: QuestionRequest) => Promise<QuestionResolution> };
}
