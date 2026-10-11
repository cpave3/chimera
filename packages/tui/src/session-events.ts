import type { AgentEvent, Usage } from '@chimera/core';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { mergePermissionQueue, type PendingPermission } from './permission-queue';
import type { Scrollback } from './scrollback';

export interface SessionHydrationState {
  lifecycleEventObserved: boolean;
  resolvedPermissionIds: Set<string>;
}

export interface ActiveSubagent {
  subagentId: string;
  childSessionId: string;
  url: string;
  purpose: string;
}

export interface UsageState {
  usage: Usage;
  contextWindow: number;
  usedContextTokens: number;
  unknownWindow: boolean;
}

/** The pieces of App state a session event may touch. */
export interface SessionEventContext {
  scrollback: Scrollback;
  sessionHydrationRef: MutableRefObject<SessionHydrationState>;
  subagentsRef: MutableRefObject<Map<string, ActiveSubagent>>;
  setRunning: Dispatch<SetStateAction<boolean>>;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  setPermissionQueue: Dispatch<SetStateAction<PendingPermission[]>>;
  setVisionRouteRef: Dispatch<SetStateAction<string | null>>;
  setUsageState: Dispatch<SetStateAction<UsageState | null>>;
  setActiveModeName: Dispatch<SetStateAction<string>>;
  setPendingModeName: Dispatch<SetStateAction<string | null>>;
  setCurrentModelRef: Dispatch<SetStateAction<string>>;
  setCompacting: Dispatch<SetStateAction<boolean>>;
  setTasks: Dispatch<SetStateAction<{ content: string; status: string }[]>>;
  /** The provider retry the run is waiting on, shown in the activity line. */
  setRetry: Dispatch<SetStateAction<{ attempt: number; maxAttempts: number } | null>>;
}

/**
 * Fold one event of the session stream into the transcript and the App's
 * run state. Called for live events and for the replay after a reconnect.
 */
export function applySessionEvent(
  ev: AgentEvent | { type: 'permission_timeout'; requestId: string },
  context: SessionEventContext,
): void {
  const {
    scrollback,
    sessionHydrationRef,
    subagentsRef,
    setRunning,
    setStreaming,
    setPermissionQueue,
    setVisionRouteRef,
    setUsageState,
    setActiveModeName,
    setPendingModeName,
    setCurrentModelRef,
    setCompacting,
    setTasks,
    setRetry,
  } = context;
  if (process.env.CHIMERA_DEBUG_SUBAGENTS) {
    const compact: Record<string, unknown> = { type: ev.type };
    if ('callId' in ev) compact.callId = ev.callId;
    if ('subagentId' in ev) compact.subagentId = ev.subagentId;
    if ('parentCallId' in ev) compact.parentCallId = ev.parentCallId;
    if (ev.type === 'subagent_event') {
      compact.inner = (ev as { event: { type: string } }).event.type;
      const inner = (ev as { event: Record<string, unknown> }).event;
      if ('callId' in inner) compact.innerCallId = inner.callId;
      if ('name' in inner) compact.innerName = inner.name;
    }
    if (ev.type === 'tool_call_start') compact.name = (ev as { name: string }).name;
    process.stderr.write(`[chimera-tui-apply] ${JSON.stringify(compact)}\n`);
  }
  scrollback.apply(ev as AgentEvent);
  if (
    ev.type === 'assistant_text_delta' ||
    ev.type === 'reasoning_text_delta' ||
    ev.type === 'tool_call_start' ||
    ev.type === 'tool_call_result' ||
    ev.type === 'permission_request' ||
    ev.type === 'permission_resolved' ||
    ev.type === 'run_finished'
  ) {
    sessionHydrationRef.current.lifecycleEventObserved = true;
  }
  if (ev.type === 'permission_resolved' || ev.type === 'permission_timeout') {
    sessionHydrationRef.current.resolvedPermissionIds.add(ev.requestId);
  }
  if (
    ev.type === 'assistant_text_delta' ||
    ev.type === 'reasoning_text_delta' ||
    ev.type === 'tool_call_start' ||
    ev.type === 'tool_call_result' ||
    ev.type === 'permission_request' ||
    ev.type === 'permission_resolved'
  ) {
    setRunning(true);
  }
  if (
    ev.type === 'assistant_text_delta' ||
    ev.type === 'reasoning_text_delta' ||
    ev.type === 'tool_call_start' ||
    ev.type === 'model_fallback' ||
    ev.type === 'run_finished'
  ) {
    // The step went through (or the run gave up): the retry wait is over.
    setRetry(null);
  }
  const all = scrollback.all();
  if (process.env.CHIMERA_DEBUG_SUBAGENTS && ev.type === 'tool_call_result') {
    const childCount = all.filter(
      (e) => e.kind === 'subagent' && e.parentEntryId !== undefined,
    ).length;
    process.stderr.write(
      `[chimera-tui-apply]   after tool_call_result: total entries=${all.length}, subagent-children=${childCount}\n`,
    );
  }
  if (ev.type === 'assistant_text_delta' || ev.type === 'reasoning_text_delta') {
    setStreaming(true);
  } else if (ev.type === 'permission_request') {
    setPermissionQueue((queue) => mergePermissionQueue(queue, [ev]));
  } else if (ev.type === 'permission_resolved' || ev.type === 'permission_timeout') {
    setPermissionQueue((queue) => queue.filter((item) => item.requestId !== ev.requestId));
  } else if (ev.type === 'subagent_spawned') {
    subagentsRef.current.set(ev.subagentId, {
      subagentId: ev.subagentId,
      childSessionId: ev.childSessionId,
      url: ev.url,
      purpose: ev.purpose,
    });
  } else if (ev.type === 'subagent_finished') {
    subagentsRef.current.delete(ev.subagentId);
  } else if (ev.type === 'subagent_event') {
    const inner = ev.event;
    const sa = subagentsRef.current.get(ev.subagentId);
    if (inner.type === 'permission_request' && sa && sa.url) {
      setPermissionQueue((queue) =>
        mergePermissionQueue(queue, [
          {
            requestId: inner.requestId,
            command: inner.command,
            reason: inner.reason,
            policyAnalysis: inner.policyAnalysis,
            mcp: inner.mcp,
            subagent: {
              id: ev.subagentId,
              purpose: sa.purpose,
              sessionId: sa.childSessionId,
              url: sa.url,
            },
          },
        ]),
      );
    } else if (inner.type === 'permission_resolved' || inner.type === 'permission_timeout') {
      setPermissionQueue((queue) => queue.filter((item) => item.requestId !== inner.requestId));
    }
  } else if (ev.type === 'user_input_required') {
    scrollback.addInfo(`Waiting for input: ${ev.request}`);
  } else if (ev.type === 'run_finished') {
    setRunning(false);
    setStreaming(false);
    setVisionRouteRef(null);
    if (ev.reason !== 'stop' && ev.reason !== 'waiting_for_input') {
      const statusMsg =
        ev.reason === 'max_steps'
          ? "run ended: max steps reached; type 'continue' to resume"
          : ev.reason === 'output_limit'
            ? "run ended: the answer kept hitting the model's output limit; type 'continue' to resume"
            : ev.reason === 'interrupted'
              ? 'run interrupted'
              : ev.reason === 'timeout'
                ? 'run timed out'
                : `run error: ${ev.error ?? 'unknown'}`;
      scrollback.addInfo(statusMsg);
    }
  } else if (ev.type === 'usage_updated') {
    setUsageState({
      usage: ev.usage,
      contextWindow: ev.contextWindow,
      usedContextTokens: ev.usedContextTokens,
      unknownWindow: ev.unknownWindow,
    });
  } else if (ev.type === 'mode_changed') {
    setActiveModeName(ev.to);
    setPendingModeName(null);
    scrollback.addModeChange(ev.from, ev.to);
  } else if (ev.type === 'model_changed') {
    setCurrentModelRef(ev.to);
    scrollback.addInfo(`model changed: ${ev.from} → ${ev.to}`);
  } else if (ev.type === 'vision_route_started') {
    setVisionRouteRef(ev.to);
    scrollback.addInfo(`vision: routing this turn to ${ev.to} (images present)`);
  } else if (ev.type === 'vision_route_ended') {
    setVisionRouteRef(null);
    scrollback.addInfo(`vision: turn finished, back on ${ev.restored}`);
  } else if (ev.type === 'vision_route_unavailable') {
    scrollback.addError(`vision: ${ev.reason}`);
  } else if (ev.type === 'provider_retry') {
    setRetry({ attempt: ev.attempt, maxAttempts: ev.maxAttempts });
    const seconds = Math.max(1, Math.round(ev.delayMs / 1000));
    scrollback.addInfo(
      `provider error: ${ev.error} — retry ${ev.attempt}/${ev.maxAttempts} in ${seconds}s`,
    );
  } else if (ev.type === 'model_fallback') {
    scrollback.addInfo(`${ev.from} is unavailable; finishing this run on ${ev.to}`);
  } else if (ev.type === 'output_continued') {
    scrollback.addInfo(
      `output limit reached; asking the model to continue (${ev.attempt}/${ev.maxAttempts})`,
    );
  } else if (ev.type === 'compaction_started') {
    if (ev.reason === 'overflow') {
      scrollback.addInfo('the provider rejected the prompt as too long; compacting');
    }
    setCompacting(true);
  } else if (ev.type === 'compaction_finished') {
    setCompacting(false);
    const delta = ev.tokensBefore - ev.tokensAfter;
    const strategyNote = ev.strategy ? ` [${ev.strategy}]` : '';
    const pruneNote =
      ev.prunedCount && ev.prunedCount > 0 ? `, ${ev.prunedCount} outputs archived` : '';
    scrollback.addInfo(
      `compaction done${strategyNote}: ${delta > 0 ? `-` : ''}${delta} tokens (${ev.messagesReplaced} messages replaced${pruneNote})`,
    );
  } else if (ev.type === 'compaction_failed') {
    setCompacting(false);
    scrollback.addError(`compaction failed: ${ev.error}`);
  } else if (ev.type === 'task_list_updated') {
    setTasks(ev.tasks);
  } else if (ev.type === 'background_process_exited') {
    const outcome = ev.status === 'killed' ? 'killed' : `exited (exit ${ev.exitCode ?? 'unknown'})`;
    scrollback.addInfo(`background process ${ev.shellId} ${outcome}: ${ev.command}`);
  }
}
