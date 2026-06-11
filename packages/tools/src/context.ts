import type { Executor, PermissionGate, SandboxMode } from '@chimera/core';
import type { BackgroundProcessManager } from './background';
import type { DiagnosticsRunner } from './diagnostics';
import type { TaskListStore } from './task-list';
import type { WebSearchProvider } from './web-search';

export interface ToolContext {
  sandboxExecutor: Executor;
  hostExecutor: Executor;
  permissionGate?: PermissionGate;
  sandboxMode: SandboxMode;
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
}
