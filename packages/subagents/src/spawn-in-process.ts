import type { AgentEvent, SessionId } from '@chimera/core';
import { type DriveResult, driveSubagent, type SubagentTransport } from './subagent-driver';
import type { InProcessAgentBuilder } from './types';

export interface InProcessHandle {
  childSessionId: SessionId;
  send: (prompt: string, opts?: { signal?: AbortSignal }) => AsyncIterable<AgentEvent>;
  interrupt: () => void;
  dispose: () => Promise<void>;
}

export async function spawnInProcessChild(args: {
  builder: InProcessAgentBuilder;
  cwd: string;
  modelRef: string;
  parsedModel: {
    providerId: string;
    modelId: string;
    maxSteps: number;
    maxOutputTokens?: number;
    parallelToolCalls?: boolean;
  };
  sandboxMode: 'off' | 'bind' | 'overlay' | 'ephemeral';
  parentAbortSignal: AbortSignal;
  systemPrompt?: string;
  toolNames: string[];
  currentDepth: number;
  maxDepth: number;
}): Promise<InProcessHandle> {
  const built = await args.builder({
    cwd: args.cwd,
    model: args.parsedModel,
    sandboxMode: args.sandboxMode,
    parentAbortSignal: args.parentAbortSignal,
    systemPrompt: args.systemPrompt,
    toolNames: args.toolNames,
    currentDepth: args.currentDepth,
    maxDepth: args.maxDepth,
    // Always headless: the parent TUI cannot resolve a permission prompt
    // raised inside its own event loop. See SUBAGENTS.md.
    headlessAutoDeny: true,
  });
  return {
    childSessionId: built.sessionId,
    send: built.send,
    interrupt: built.interrupt,
    dispose: built.dispose,
  };
}

export type DriveInProcessResult = DriveResult;

class InProcessTransport implements SubagentTransport {
  constructor(private handle: InProcessHandle) {}

  send(prompt: string, opts: { signal: AbortSignal }): AsyncIterable<AgentEvent> {
    return this.handle.send(prompt, opts);
  }

  interrupt(): void {
    this.handle.interrupt();
  }
}

export async function driveInProcess(
  handle: InProcessHandle,
  prompt: string,
  onChildEvent: (event: AgentEvent) => void,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<DriveInProcessResult> {
  return driveSubagent(new InProcessTransport(handle), prompt, onChildEvent, opts);
}
