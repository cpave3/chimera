import type { Executor, PermissionGate, SandboxMode } from '@chimera/core';
import type { BackgroundProcessManager } from './background';

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
}
