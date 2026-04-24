import type { Executor, PermissionGate, SandboxMode } from '@chimera/core';

export interface ToolContext {
  sandboxExecutor: Executor;
  hostExecutor: Executor;
  permissionGate?: PermissionGate;
  sandboxMode: SandboxMode;
}
