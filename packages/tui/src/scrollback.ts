import type { AgentEvent, CallId, Session, ToolCallRecord, ToolDisplay } from '@chimera/core';

/**
 * Structural type matching `@chimera/tools`' `FormatScrollback<I, O>`. Defined
 * locally so `@chimera/tui` does not need a dependency on `@chimera/tools` —
 * the CLI passes the formatter map in as a prop at mount time.
 */
export type Formatter = (args: unknown, result?: unknown) => ToolDisplay;

interface BaseEntry {
  id: string;
  text: string;
}

export interface UserEntry extends BaseEntry {
  kind: 'user';
}

export interface AssistantEntry extends BaseEntry {
  kind: 'assistant';
  /**
   * AI SDK `text-id` for the assistant turn — present when the originating
   * `assistant_text_delta`/`assistant_text_done` event carried `id`. `apply()`
   * uses this to collapse re-emitted text parts: the SDK can yield the same
   * `text-start`/`text-delta`/`text-end` cycle multiple times across step
   * boundaries for what `response.messages` ultimately consolidates into one
   * part.
   */
  textId?: string;
}

export interface ThinkingEntry extends BaseEntry {
  kind: 'thinking';
  /**
   * AI SDK `reasoning-id` for the reasoning turn — same dedupe semantics as
   * `textId` above.
   */
  textId?: string;
}

export interface ToolEntry extends BaseEntry {
  kind: 'tool';
  toolName: string;
  toolTarget: 'sandbox' | 'host';
  /** Raw `tool_call_start` args; consumed by `ToolBody` renderers. */
  toolArgs?: unknown;
  toolResult?: unknown;
  toolError?: string;
  /** Optional follow-on lines from a tool's formatScrollback hook. */
  detail?: string;
  /** Set when a `skill_activated` event follows a `read` tool call. */
  skillName?: string;
  skillSource?: 'project' | 'user' | 'claude-compat';
  /** Set on `spawn_agent` tool entries so the renderer can label nested children. */
  subagentId?: string;
  subagentPurpose?: string;
}

export interface InfoEntry extends BaseEntry {
  kind: 'info';
}

export interface ErrorEntry extends BaseEntry {
  kind: 'error';
}

export interface SubagentEntry extends BaseEntry {
  kind: 'subagent';
  subagentId?: string;
  subagentPurpose?: string;
  subagentStatus?: 'spawning' | 'running' | 'finished';
  /**
   * Id of another scrollback entry that owns this one — used to nest subagent
   * rows under the `spawn_agent` tool entry that produced them. The renderer
   * draws children inside the parent's box and skips them in the top-level
   * iteration.
   */
  parentEntryId?: string;
  /** Inner tool name when this row was synthesized from a child's `tool_call_start`. */
  toolName?: string;
  detail?: string;
}

export interface ModeChangeEntry extends BaseEntry {
  kind: 'mode_change';
  /** Original mode when a streak started — preserved across collapses. */
  modeFrom: string;
  /** Latest target mode in the streak. */
  modeTo: string;
}

export type ScrollbackEntry =
  | UserEntry
  | AssistantEntry
  | ThinkingEntry
  | ToolEntry
  | InfoEntry
  | ErrorEntry
  | SubagentEntry
  | ModeChangeEntry;

export class Scrollback {
  private entries: ScrollbackEntry[] = [];
  private assistantBuf: string | null = null;
  /** Id of the active assistant entry being streamed into by `assistant_text_delta`. */
  private assistantEntryId: string | null = null;
  private thinkingBuf: string | null = null;
  /** Id of the active thinking entry being streamed into by `reasoning_text_delta`. */
  private thinkingEntryId: string | null = null;
  private toolsByCallId = new Map<CallId, ToolEntry>();
  /** subagentId → parent (spawn_agent) entry id, for routing child rows. */
  private subagentParents = new Map<string, string>();
  /** subagentId → its own callId-keyed map of child tool entries. Lets us
   *  mutate a child row's text when the inner tool_call_result arrives. */
  private subagentToolsByCallId = new Map<string, Map<CallId, SubagentEntry>>();
  private idSeq = 0;
  private suppressUserContent: string | null = null;
  private formatters: Record<string, Formatter>;

  /** Observable-store: cached snapshot and subscriber list for useSyncExternalStore. */
  private _snapshot: ScrollbackEntry[] = [];
  private _listeners = new Set<() => void>();
  private _flushScheduled = false;

  /**
   * Monotonic commit cursor: entries[0..committedCount) are finalized and safe
   * to hand to Ink's `<Static>`, which renders positionally and append-only —
   * an item inserted before its cursor is never printed and displaces the
   * tail into duplicate prints. The cursor advances only while the *prefix*
   * is finalized: a pending tool or streaming text entry blocks everything
   * after it (those render in the dynamic region until the blocker resolves).
   * Never decremented except by clear().
   */
  private committedCount = 0;
  private _splitSnapshot: { entries: ScrollbackEntry[]; committedCount: number } = {
    entries: [],
    committedCount: 0,
  };


  constructor(formatters: Record<string, Formatter> = {}) {
    this.formatters = formatters;
  }

  private safeFormat(name: string, args: unknown, result?: unknown): ToolDisplay | undefined {
    const fmt = this.formatters[name];
    if (!fmt) return undefined;
    try {
      return fmt(args, result);
    } catch {
      return undefined;
    }
  }

  private newId(): string {
    this.idSeq += 1;
    return `s${this.idSeq}`;
  }

  all(): ScrollbackEntry[] {
    return [...this.entries];
  }

  /** useSyncExternalStore subscribe function. */
  subscribe(callback: () => void): () => void {
    this._listeners.add(callback);
    return () => {
      this._listeners.delete(callback);
    };
  }

  /** useSyncExternalStore getSnapshot function. */
  getSnapshot(): ScrollbackEntry[] {
    return this._snapshot;
  }

  /**
   * Entries plus the committed-prefix length, captured atomically so the
   * committed/in-flight split can never disagree with the entry list (the
   * race that React-state-based classification had).
   */
  splitSnapshot(): { entries: ScrollbackEntry[]; committedCount: number } {
    return this._splitSnapshot;
  }

  /** Update the cached snapshot and schedule a single notification microtask. */
  private updateSnapshot(): void {
    this.advanceCommitCursor();
    this._snapshot = [...this.entries];
    this._splitSnapshot = { entries: this._snapshot, committedCount: this.committedCount };
  }

  /**
   * An entry is finalized when its content can no longer change and its
   * position in the render order is settled.
   */
  private isFinalized(entry: ScrollbackEntry, index: number, lastTopLevelIdx: number): boolean {
    if (entry.kind === 'assistant') return entry.id !== this.assistantEntryId;
    if (entry.kind === 'thinking') return entry.id !== this.thinkingEntryId;
    if (entry.kind === 'tool') {
      return entry.toolResult !== undefined || entry.toolError !== undefined;
    }
    // A trailing mode_change stays uncommitted so consecutive switches can
    // collapse into one row before it is baked into <Static>.
    if (entry.kind === 'mode_change') return index !== lastTopLevelIdx;
    return true;
  }

  private advanceCommitCursor(): void {
    let lastTopLevelIdx = -1;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const candidate = this.entries[i]!;
      if (candidate.kind !== 'subagent' || !candidate.parentEntryId) {
        lastTopLevelIdx = i;
        break;
      }
    }
    while (this.committedCount < this.entries.length) {
      const entry = this.entries[this.committedCount]!;
      if (!this.isFinalized(entry, this.committedCount, lastTopLevelIdx)) break;
      this.committedCount += 1;
    }
  }

  private flushTimeout: ReturnType<typeof setTimeout> | undefined;

  private scheduleFlush(): void {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    this.flushTimeout = setTimeout(() => {
      this._flushScheduled = false;
      for (const listener of this._listeners) {
        listener();
      }
    }, 0);
  }

  addUserMessage(content: string): void {
    this.entries.push({ id: this.newId(), kind: 'user', text: content });
    this.updateSnapshot();
    this.scheduleFlush();
  }

  /**
   * Arm a one-shot filter that drops the next `user_message` event whose
   * content matches `content` exactly. Used when the TUI has already rendered
   * its own local representation of what the user sent (e.g. a `/command`
   * invocation displayed instead of the expanded template body).
   */
  suppressUserMessageMatching(content: string): void {
    this.suppressUserContent = content;
  }

  addInfo(text: string): void {
    this.entries.push({ id: this.newId(), kind: 'info', text });
    this.updateSnapshot();
    this.scheduleFlush();
  }

  addError(text: string): void {
    this.entries.push({ id: this.newId(), kind: 'error', text });
    this.updateSnapshot();
    this.scheduleFlush();
  }

  /**
   * Append (or collapse into) a mode-change entry. When the trailing entry
   * is also a `mode_change`, mutate its `modeTo` in place and keep the
   * original `modeFrom` — so a streak `build → plan → question → build`
   * renders as a single `build → build` row. The TUI keeps the trailing
   * mode-change row out of `<Static>` until any other entry lands, at
   * which point the collapsed row commits.
   */
  addModeChange(from: string, to: string): void {
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === 'mode_change') {
      last.modeTo = to;
      last.text = `Mode change: ${last.modeFrom} → ${to}`;
      this.updateSnapshot();
      this.scheduleFlush();
      return;
    }
    this.entries.push({
      id: this.newId(),
      kind: 'mode_change',
      modeFrom: from,
      modeTo: to,
      text: `Mode change: ${from} → ${to}`,
    });
    this.updateSnapshot();
    this.scheduleFlush();
  }

  /** Wipe all visible entries and reset transient streaming state. */
  clear(): void {
    this.entries = [];
    this.committedCount = 0;
    this.assistantBuf = null;
    this.toolsByCallId.clear();
    this.subagentParents.clear();
    this.subagentToolsByCallId.clear();
    this.assistantEntryId = null;
    this.thinkingBuf = null;
    this.thinkingEntryId = null;
    this.suppressUserContent = null;
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = undefined;
      this._flushScheduled = false;
    }
    this.updateSnapshot();
    this.scheduleFlush();
  }

  /**
   * Rebuild scrollback entries from a previously persisted session — used
   * after `/sessions` switching, `chimera resume`, or `chimera --continue`
   * so the user sees their prior conversation instead of an empty buffer.
   *
   * Synthesizes the relevant `AgentEvent`s from the session's `messages` and
   * `toolCalls` and feeds them through `apply()`. We don't have streaming
   * text-deltas in the persisted form, so assistant turns appear as a
   * single `assistant_text_done` per message rather than incrementally.
   */
  rehydrateFromSession(session: Pick<Session, 'messages' | 'toolCalls'>): void {
    this.clear();
    // The AI SDK's per-call `toolCallId` (carried on `tool-call` parts of
    // assistant messages and on `tool-result` parts of tool messages) is
    // distinct from the agent's internal `CallId` stored on
    // `session.toolCalls`. To attach the right `target` to a tool entry, we
    // first try to match by tool name + JSON-equal args; missing matches
    // default to 'host'.
    type LooseMessage = { role?: string; content?: unknown };
    type LoosePart = { type?: string; [k: string]: unknown };
    // Map AI-SDK toolCallId → (name, args), populated as we walk assistant
    // tool-call parts. The matching `tool-result` part later in the session
    // carries only `toolCallId`, so we use this to recover (name, args) for
    // the result-side formatter call.
    const seenCalls = new Map<string, { name: string; args: unknown }>();
    for (const msg of session.messages as LooseMessage[]) {
      if (msg.role === 'system') continue;
      if (msg.role === 'user') {
        const text = extractText(msg.content);
        if (text) this.apply({ type: 'user_message', content: text });
        continue;
      }
      if (msg.role === 'assistant') {
        const parts: LoosePart[] = Array.isArray(msg.content)
          ? (msg.content as LoosePart[])
          : [{ type: 'text', text: String(msg.content) }];
        for (const part of parts) {
          if (part.type === 'text') {
            const text = part.text;
            if (typeof text === 'string' && text.length > 0) {
              this.apply({ type: 'assistant_text_done', text });
            }
          } else if (part.type === 'tool-call') {
            const callId = part.toolCallId as string | undefined;
            const name = part.toolName as string | undefined;
            if (!callId || !name) continue;
            const args = part.input ?? part.args;
            const rec = findToolRecord(session.toolCalls, name, args);
            seenCalls.set(callId, { name, args });
            this.apply({
              type: 'tool_call_start',
              callId,
              name,
              args,
              target: rec?.target ?? 'host',
              display: this.safeFormat(name, args),
            });
          }
        }
        continue;
      }
      if (msg.role === 'tool') {
        // Tool-result messages contain `tool-result` parts whose
        // `toolCallId` matches the assistant's earlier `tool-call` part.
        // In AI SDK v5 the part's `output` is a discriminated union —
        // `{ type: 'json', value: <obj> }`, `{ type: 'text', value: '...' }`,
        // `{ type: 'error-json' | 'error-text', value: ... }`, etc. — so we
        // unwrap the inner value before handing it to scrollback.
        const parts: LoosePart[] = Array.isArray(msg.content) ? (msg.content as LoosePart[]) : [];
        for (const part of parts) {
          if (part.type !== 'tool-result') continue;
          const callId = part.toolCallId as string | undefined;
          if (!callId) continue;
          const { result, isError } = unwrapToolResultOutput(
            part as Parameters<typeof unwrapToolResultOutput>[0],
          );
          if (isError) {
            const err = typeof result === 'string' ? result : JSON.stringify(result);
            this.apply({ type: 'tool_call_error', callId, error: err });
          } else {
            const seen = seenCalls.get(callId);
            this.apply({
              type: 'tool_call_result',
              callId,
              result,
              durationMs: 0,
              display: seen ? this.safeFormat(seen.name, seen.args, result) : undefined,
            });
          }
        }
      }
    }
  }

  apply(ev: AgentEvent): void {
    let dirty = false;
    try {
      if (ev.type === 'assistant_text_delta') {
        if (this.assistantBuf === null) {
          this.assistantBuf = '';
          const id = this.newId();
          this.assistantEntryId = id;
          this.entries.push({
            id,
            kind: 'assistant',
            text: '',
            textId: ev.id,
          });
        }
        this.assistantBuf += ev.delta;
        const target = this.entries.find((e) => e.id === this.assistantEntryId);
        if (target && target.kind === 'assistant') {
          target.text = this.assistantBuf;
        }
        dirty = true;
        return;
      }
      if (ev.type === 'assistant_text_done') {
        this.assistantBuf = null;
        const trackedIdx = this.entries.findIndex((e) => e.id === this.assistantEntryId);
        this.assistantEntryId = null;
        if (trackedIdx >= 0) {
          const target = this.entries[trackedIdx];
          if (target && target.kind === 'assistant' && target.text.length > 0) {
            target.text = ev.text;
            if (ev.id !== undefined) target.textId = ev.id;
            // Dedupe: the tracked entry may be a duplicate of an earlier one.
            if (ev.id !== undefined) {
              for (let i = trackedIdx - 1; i >= 0; i -= 1) {
                const candidate = this.entries[i];
                if (
                  candidate &&
                  candidate.kind === 'assistant' &&
                  candidate.textId === ev.id &&
                  candidate.text === target.text
                ) {
                  this.entries.splice(trackedIdx, 1);
                  dirty = true;
                  return;
                }
              }
            } else {
              const above = this.entries[trackedIdx - 1];
              if (
                above &&
                above.kind === 'assistant' &&
                above.text === target.text &&
                above.textId === undefined
              ) {
                this.entries.splice(trackedIdx, 1);
              }
            }
            dirty = true;
            return;
          }
        }

        this.entries.push({
          id: this.newId(),
          kind: 'assistant',
          text: ev.text,
          textId: ev.id,
        });

        const finalEntry = this.entries[this.entries.length - 1];
        if (!finalEntry || finalEntry.kind !== 'assistant') return;

        if (ev.id !== undefined) {
          for (let i = this.entries.length - 2; i >= 0; i -= 1) {
            const candidate = this.entries[i];
            if (
              candidate &&
              candidate.kind === 'assistant' &&
              candidate.textId === ev.id &&
              candidate.text === finalEntry.text
            ) {
              this.entries.pop();
              dirty = true;
              return;
            }
          }
          dirty = true;
          return;
        }

        const above = this.entries[this.entries.length - 2];
        if (
          above &&
          above.kind === 'assistant' &&
          above.text === finalEntry.text &&
          above.textId === undefined
        ) {
          this.entries.pop();
        }
        dirty = true;
        return;
      }
      if (ev.type === 'reasoning_text_delta') {
        if (this.thinkingBuf === null) {
          this.thinkingBuf = '';
          const id = this.newId();
          this.thinkingEntryId = id;
          this.entries.push({
            id,
            kind: 'thinking',
            text: '',
            textId: ev.id,
          });
        }
        this.thinkingBuf += ev.delta;
        const target = this.entries.find((e) => e.id === this.thinkingEntryId);
        if (target && target.kind === 'thinking') {
          target.text = this.thinkingBuf;
        }
        dirty = true;
        return;
      }
      if (ev.type === 'reasoning_text_done') {
        this.thinkingBuf = null;
        const trackedIdx = this.entries.findIndex((e) => e.id === this.thinkingEntryId);
        this.thinkingEntryId = null;
        if (trackedIdx >= 0) {
          const target = this.entries[trackedIdx];
          if (target && target.kind === 'thinking' && target.text.length > 0) {
            target.text = ev.text;
            if (ev.id !== undefined) target.textId = ev.id;
            // Dedupe: same logic as assistant_text_done.
            if (ev.id !== undefined) {
              for (let i = trackedIdx - 1; i >= 0; i -= 1) {
                const candidate = this.entries[i];
                if (
                  candidate &&
                  candidate.kind === 'thinking' &&
                  candidate.textId === ev.id &&
                  candidate.text === target.text
                ) {
                  this.entries.splice(trackedIdx, 1);
                  dirty = true;
                  return;
                }
              }
            } else {
              const above = this.entries[trackedIdx - 1];
              if (
                above &&
                above.kind === 'thinking' &&
                above.text === target.text &&
                above.textId === undefined
              ) {
                this.entries.splice(trackedIdx, 1);
              }
            }
            dirty = true;
            return;
          }
        }

        this.entries.push({
          id: this.newId(),
          kind: 'thinking',
          text: ev.text,
          textId: ev.id,
        });

        const finalEntry = this.entries[this.entries.length - 1];
        if (!finalEntry || finalEntry.kind !== 'thinking') return;

        if (ev.id !== undefined) {
          for (let i = this.entries.length - 2; i >= 0; i -= 1) {
            const candidate = this.entries[i];
            if (
              candidate &&
              candidate.kind === 'thinking' &&
              candidate.textId === ev.id &&
              candidate.text === finalEntry.text
            ) {
              this.entries.pop();
              dirty = true;
              return;
            }
          }
          dirty = true;
          return;
        }

        const above = this.entries[this.entries.length - 2];
        if (
          above &&
          above.kind === 'thinking' &&
          above.text === finalEntry.text &&
          above.textId === undefined
        ) {
          this.entries.pop();
        }
        dirty = true;
        return;
      }
      if (ev.type === 'user_message') {
        if (this.suppressUserContent !== null) {
          const expected = this.suppressUserContent;
          this.suppressUserContent = null;
          if (expected === ev.content) return;
        }
        this.addUserMessage(ev.content);
        return;
      }
      if (ev.type === 'tool_call_start') {
        const entry: ScrollbackEntry = {
          id: this.newId(),
          kind: 'tool',
          text: ev.display?.summary ?? formatArgs(ev.args),
          toolName: ev.name,
          toolTarget: ev.target,
          toolArgs: ev.args,
          detail: ev.display?.detail,
        };
        this.toolsByCallId.set(ev.callId, entry);
        this.entries.push(entry);
        dirty = true;
        return;
      }
      if (ev.type === 'tool_call_result') {
        const entry = this.toolsByCallId.get(ev.callId);
        if (entry) {
          entry.toolResult = ev.result;
          if (ev.display) {
            entry.text = ev.display.summary;
            entry.detail = ev.display.detail;
          }
          dirty = true;
        }
        return;
      }
      if (ev.type === 'tool_call_error') {
        const entry = this.toolsByCallId.get(ev.callId);
        if (entry) {
          entry.toolError = ev.error;
          dirty = true;
        } else {
          this.addError(`tool error: ${ev.error}`);
        }
        return;
      }
      if (ev.type === 'skill_activated') {
        for (let i = this.entries.length - 1; i >= 0; i -= 1) {
          const candidate = this.entries[i]!;
          if (candidate.kind === 'tool' && candidate.toolName === 'read') {
            candidate.skillName = ev.skillName;
            candidate.skillSource = ev.source;
            dirty = true;
            return;
          }
        }
        return;
      }
      if (ev.type === 'subagent_spawned') {
        const parent = this.toolsByCallId.get(ev.parentCallId);
        const parentEntryId = parent?.id;
        if (parentEntryId) this.subagentParents.set(ev.subagentId, parentEntryId);
        if (parentEntryId && parent) {
          parent.subagentId = ev.subagentId;
          parent.subagentPurpose = ev.purpose;
          dirty = true;
          return;
        }
        this.entries.push({
          id: this.newId(),
          kind: 'subagent',
          text: `subagent spawned · ${ev.url || 'in-process'}`,
          subagentId: ev.subagentId,
          subagentPurpose: ev.purpose,
          subagentStatus: 'running',
        });
        dirty = true;
        return;
      }
      if (ev.type === 'subagent_finished') {
        const parentEntryId = this.subagentParents.get(ev.subagentId);
        if (parentEntryId) {
          this.subagentParents.delete(ev.subagentId);
          this.subagentToolsByCallId.delete(ev.subagentId);
          dirty = true;
          return;
        }
        const summary = ev.reason === 'stop' ? 'subagent finished' : `subagent ${ev.reason}`;
        this.entries.push({
          id: this.newId(),
          kind: 'subagent',
          text: summary,
          subagentId: ev.subagentId,
          subagentStatus: 'finished',
        });
        dirty = true;
        return;
      }
      if (ev.type === 'subagent_event') {
        const inner = ev.event;
        const id = ev.subagentId;
        const parentEntryId = this.subagentParents.get(id);
        if (inner.type === 'assistant_text_done' && inner.text.length > 0) {
          this.entries.push({
            id: this.newId(),
            kind: 'subagent',
            text: previewLine(inner.text),
            subagentId: id,
            subagentStatus: 'running',
            parentEntryId,
          });
          dirty = true;
          return;
        }
        if (inner.type === 'reasoning_text_done' && inner.text.length > 0) {
          this.entries.push({
            id: this.newId(),
            kind: 'subagent',
            text: previewLine(inner.text),
            subagentId: id,
            subagentStatus: 'running',
            parentEntryId,
          });
          dirty = true;
          return;
        }
        if (inner.type === 'tool_call_start') {
          const childTarget = inner.target === 'host' ? ' [host]' : '';
          const text = inner.display?.summary
            ? `${inner.name}: ${inner.display.summary}${childTarget}`
            : `${inner.name}${childTarget}`;
          const entry: ScrollbackEntry = {
            id: this.newId(),
            kind: 'subagent',
            text,
            subagentId: id,
            subagentStatus: 'running',
            parentEntryId,
            toolName: inner.name,
            detail: inner.display?.detail,
          };
          let map = this.subagentToolsByCallId.get(id);
          if (!map) {
            map = new Map<CallId, SubagentEntry>();
            this.subagentToolsByCallId.set(id, map);
          }
          map.set(inner.callId, entry);
          this.entries.push(entry);
          dirty = true;
          return;
        }
        if (inner.type === 'tool_call_result') {
          const map = this.subagentToolsByCallId.get(id);
          const entry = map?.get(inner.callId);
          if (entry && inner.display) {
            const targetTag = entry.text.endsWith('[host]') ? ' [host]' : '';
            entry.text = `${entry.toolName}: ${inner.display.summary}${targetTag}`;
            entry.detail = inner.display.detail;
            dirty = true;
          }
          return;
        }
        if (inner.type === 'tool_call_error') {
          this.entries.push({
            id: this.newId(),
            kind: 'subagent',
            text: `tool error: ${inner.error}`,
            subagentId: id,
            subagentStatus: 'running',
            parentEntryId,
          });
          dirty = true;
          return;
        }
        if (inner.type === 'run_finished' && inner.reason === 'error' && inner.error) {
          this.entries.push({
            id: this.newId(),
            kind: 'subagent',
            text: `error: ${inner.error}`,
            subagentId: id,
            subagentStatus: 'running',
            parentEntryId,
          });
          dirty = true;
          return;
        }
        return;
      }
      if (ev.type === 'run_finished') {
        // Finalize dangling state so the commit cursor can't wedge: an
        // interrupted run may leave a streaming text entry without its
        // *_done event and pending tool entries without results, which
        // would otherwise block every later entry from committing.
        this.assistantBuf = null;
        this.assistantEntryId = null;
        this.thinkingBuf = null;
        this.thinkingEntryId = null;
        for (let i = this.entries.length - 1; i >= 0; i--) {
          const entry = this.entries[i]!;
          if (
            entry.kind === 'tool' &&
            entry.toolResult === undefined &&
            entry.toolError === undefined
          ) {
            entry.toolError = `run ended (${ev.reason}) before tool result`;
          }
        }
        dirty = true;
        if (ev.reason === 'error' && ev.error) {
          this.addError(ev.error);
        }
        return;
      }
    } finally {
      if (dirty) {
        this.updateSnapshot();
        this.scheduleFlush();
      }
    }
  }
}

function previewLine(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

function formatArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args);
    return json.length > 80 ? `${json.slice(0, 77)}...` : json;
  } catch {
    return '';
  }
}

/**
 * Unwrap an AI-SDK `tool-result` part's `output` (discriminated union in
 * v5: `{type:'json'|'text'|'error-json'|'error-text'|'content', value}`),
 * falling back to legacy v4 shapes (`output` raw, `result`, `content`).
 */
function unwrapToolResultOutput(part: {
  output?: unknown;
  result?: unknown;
  content?: unknown;
  isError?: unknown;
  is_error?: unknown;
}): { result: unknown; isError: boolean } {
  let isError = (part.isError ?? part.is_error) === true;
  let result: unknown = part.output ?? part.result ?? part.content;
  if (
    result &&
    typeof result === 'object' &&
    'type' in (result as Record<string, unknown>) &&
    'value' in (result as Record<string, unknown>)
  ) {
    const wrapped = result as { type: string; value: unknown };
    if (wrapped.type === 'error-json' || wrapped.type === 'error-text') {
      isError = true;
    }
    result = wrapped.value;
  }
  return { result, isError };
}

/**
 * Best-effort match of an AI-SDK `tool-call` part to its
 * `ToolCallRecord` so we can attach the recorded `target` (sandbox vs.
 * host). The agent's internal `CallId` differs from the SDK's
 * `toolCallId`, so we match by name + JSON-equal args. Returns the first
 * record whose result is unconsumed; falls back to any matching record.
 */
function findToolRecord(
  records: ToolCallRecord[],
  name: string,
  args: unknown,
): ToolCallRecord | undefined {
  let argsKey: string;
  try {
    argsKey = JSON.stringify(args);
  } catch {
    argsKey = '';
  }
  for (const rec of records) {
    if (rec.name !== name) continue;
    let recKey: string;
    try {
      recKey = JSON.stringify(rec.args);
    } catch {
      recKey = '';
    }
    if (recKey === argsKey) return rec;
  }
  return undefined;
}

/**
 * Pull text out of an AI-SDK message `content` field, which is either a
 * plain string or an array of typed parts (`{type: 'text', text: '...'}`,
 * etc.). Non-text parts (images, tool calls, etc.) are skipped here.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      const t = (part as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('');
}
