import type { AgentEvent, CallId, Session, ToolCallRecord, ToolDisplay } from '@chimera/core';
import { countImageParts, parseBackgroundAgentMessage, parseGoalMessage } from '@chimera/core';
import { formatElapsed } from './activity';
import { formatTokens } from './usage-format';

/** What a `goal_updated` event says, as one line of the transcript. */
export function goalLine(event: Extract<AgentEvent, { type: 'goal_updated' }>): string {
  const why = event.reason ? `: ${event.reason}` : '';
  switch (event.change) {
    case 'set':
      return `goal set: ${event.condition}`;
    case 'cleared':
      return 'goal cleared';
    case 'met':
      return `goal met${why}`;
    case 'not_met':
      return `goal not met (${event.continuation} of ${event.maxContinuations})${why}`;
    case 'limit':
      return `goal: limit of ${event.maxContinuations} continuations reached${why}`;
    case 'impossible':
      return `goal not possible${why}`;
    case 'unchecked':
      return `goal not checked${why}`;
  }
}

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
  imageCount?: number;
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
  displayName?: string;
  toolTarget: 'sandbox' | 'host';
  /** Raw `tool_call_start` args; consumed by `ToolBody` renderers. */
  toolArgs?: unknown;
  toolResult?: unknown;
  toolError?: string;
  /** How long the call ran; absent for calls restored from a saved session. */
  durationMs?: number;
  /** The approval reviewer allowed this call; the user was not asked. */
  reviewerApproved?: boolean;
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

/**
 * A run of consecutive successful exploration calls (reads, searches,
 * listings) shown as one line. `text` is the summary; `members` keeps every
 * call for the transcript view.
 */
export interface ExploreEntry extends BaseEntry {
  kind: 'explore';
  members: ToolEntry[];
  /** Set when the run ended while the group was still the last entry. */
  closed?: boolean;
}

/** The closing line of a run: how long it took and what it cost. */
export interface TurnEntry extends BaseEntry {
  kind: 'turn';
}

export type ScrollbackEntry =
  | UserEntry
  | AssistantEntry
  | ThinkingEntry
  | ToolEntry
  | ExploreEntry
  | TurnEntry
  | InfoEntry
  | ErrorEntry
  | SubagentEntry
  | ModeChangeEntry;

type RunUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number };

const SEARCH_TOOLS = new Set(['grep']);
const LISTING_TOOLS = new Set(['glob', 'find', 'ls']);
const EXPLORATION_TOOLS = new Set(['read', ...SEARCH_TOOLS, ...LISTING_TOOLS]);

function isExplorationInFlight(entry: ScrollbackEntry): boolean {
  return (
    entry.kind === 'tool' &&
    EXPLORATION_TOOLS.has(entry.toolName) &&
    entry.toolResult === undefined &&
    entry.toolError === undefined
  );
}

/** A finished call that only looked at things: the kind a group absorbs. */
function isGroupableExploration(entry: ToolEntry): boolean {
  if (!EXPLORATION_TOOLS.has(entry.toolName) || entry.toolError !== undefined) return false;
  if (entry.toolResult === undefined || entry.skillName !== undefined) return false;
  return (entry.toolResult as { kind?: unknown } | null)?.kind !== 'image';
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

function summarizeExploration(members: ToolEntry[]): string {
  const reads = members.filter((member) => member.toolName === 'read').length;
  const searches = members.filter((member) => SEARCH_TOOLS.has(member.toolName)).length;
  const listings = members.filter((member) => LISTING_TOOLS.has(member.toolName)).length;
  return [
    reads > 0 ? `read ${plural(reads, 'file')}` : '',
    searches > 0 ? plural(searches, 'search', 'searches') : '',
    listings > 0 ? plural(listings, 'listing') : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

export interface ScrollbackOptions {
  /**
   * Max line count the in-flight streaming entry may reach before completed
   * paragraphs spill into finalized chunk entries (which commit to <Static>).
   * Keeps Ink's dynamic region shorter than the terminal: once the dynamic
   * frame is taller than the viewport, Ink falls back to a clearTerminal +
   * full-rewrite per render, which flickers and floods scrollback.
   */
  streamSpillLines?: number;
}

const DEFAULT_STREAM_SPILL_LINES = 8;

/**
 * Streaming state for one delta/done text channel (assistant or thinking).
 *
 * `suppressSpill` is true while the current delta cycle re-streams a textId
 * that already completed (the SDK re-emits text parts across step
 * boundaries). Spilling is disabled for such cycles so the duplicate stays
 * one uncommitted entry that the done-time dedupe can still remove.
 */
interface TextStream {
  kind: 'assistant' | 'thinking';
  buf: string | null;
  /** Id of the active entry currently being streamed into. */
  entryId: string | null;
  /** Chars of `buf` already moved into finalized spill-chunk entries. */
  spilled: number;
  suppressSpill: boolean;
  /** textId → final text of completed streams, for re-emission dedupe. */
  completedTexts: Map<string, string>;
}

function newTextStream(kind: 'assistant' | 'thinking'): TextStream {
  return {
    kind,
    buf: null,
    entryId: null,
    spilled: 0,
    suppressSpill: false,
    completedTexts: new Map(),
  };
}

function isTextEntry(entry: ScrollbackEntry): entry is AssistantEntry | ThinkingEntry {
  return entry.kind === 'assistant' || entry.kind === 'thinking';
}

export class Scrollback {
  private entries: ScrollbackEntry[] = [];
  private streamSpillLines: number;
  private assistantStream = newTextStream('assistant');
  private thinkingStream = newTextStream('thinking');
  private toolsByCallId = new Map<CallId, ToolEntry>();
  /** Counters of the run in progress, for its closing summary line. */
  private run: {
    startedAt: number;
    steps: number;
    toolCalls: number;
    usageAtStart: RunUsage;
  } | null = null;
  private latestUsage: RunUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  /** subagentId → parent (spawn_agent) entry id, for routing child rows. */
  private subagentParents = new Map<string, string>();
  /** Children started with `background: true`; the transcript shows only their end. */
  private backgroundSubagents = new Set<string>();
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

  constructor(formatters: Record<string, Formatter> = {}, options: ScrollbackOptions = {}) {
    this.formatters = formatters;
    this.streamSpillLines = options.streamSpillLines ?? DEFAULT_STREAM_SPILL_LINES;
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
    if (entry.kind === 'assistant') return entry.id !== this.assistantStream.entryId;
    if (entry.kind === 'thinking') return entry.id !== this.thinkingStream.entryId;
    if (entry.kind === 'tool') {
      return entry.toolResult !== undefined || entry.toolError !== undefined;
    }
    // A group stays open, and uncommitted, while only exploration calls
    // still in flight follow it: each of them joins the group as it returns.
    if (entry.kind === 'explore') {
      return entry.closed === true || !this.entries.slice(index + 1).every(isExplorationInFlight);
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
      // Committing is what closes a group: nothing can join it once printed.
      if (entry.kind === 'explore') entry.closed = true;
      this.committedCount += 1;
    }
  }

  /** Count what a run did, from its first event to `run_finished`. */
  private trackRun(ev: AgentEvent): void {
    if (ev.type === 'usage_updated') {
      this.latestUsage = {
        inputTokens: ev.usage.inputTokens,
        outputTokens: ev.usage.outputTokens,
        cachedInputTokens: ev.usage.cachedInputTokens,
      };
    }
    const active =
      ev.type === 'user_message' ||
      ev.type === 'assistant_text_delta' ||
      ev.type === 'reasoning_text_delta' ||
      ev.type === 'tool_call_start' ||
      ev.type === 'step_finished';
    if (active && !this.run) {
      this.run = { startedAt: Date.now(), steps: 0, toolCalls: 0, usageAtStart: this.latestUsage };
    }
    if (!this.run) return;
    if (ev.type === 'step_finished') this.run.steps += 1;
    if (ev.type === 'tool_call_start') this.run.toolCalls += 1;
  }

  /** End the run in progress and describe it; undefined when it did nothing worth a line. */
  private finishRun(): string | undefined {
    const run = this.run;
    this.run = null;
    if (!run || (run.steps === 0 && run.toolCalls === 0)) return undefined;
    const input = this.latestUsage.inputTokens - run.usageAtStart.inputTokens;
    const output = this.latestUsage.outputTokens - run.usageAtStart.outputTokens;
    const cached = this.latestUsage.cachedInputTokens - run.usageAtStart.cachedInputTokens;
    return [
      formatElapsed(Date.now() - run.startedAt),
      plural(run.steps, 'step'),
      run.toolCalls > 0 ? plural(run.toolCalls, 'tool call') : '',
      input > 0 || output > 0 ? `↑ ${formatTokens(input)} ↓ ${formatTokens(output)} tokens` : '',
      input > 0 && cached > 0 ? `cache ${Math.min(100, Math.round((cached / input) * 100))}%` : '',
    ]
      .filter((part) => part !== '')
      .join(' · ');
  }

  /**
   * Fold a finished exploration call into the open group, or start a group
   * with it. A call that something other than exploration already followed
   * stays a plain tool line: its place in the transcript is taken.
   */
  private groupExploration(entry: ToolEntry): void {
    const index = this.entries.indexOf(entry);
    if (index < 0) return;
    const following = this.entries.slice(index + 1);
    let groupIndex = this.entries.length - 1;
    while (
      groupIndex >= 0 &&
      (groupIndex === index || isExplorationInFlight(this.entries[groupIndex]!))
    ) {
      groupIndex -= 1;
    }
    const candidate = groupIndex >= 0 ? this.entries[groupIndex] : undefined;
    if (candidate?.kind === 'explore' && !candidate.closed) {
      candidate.members.push(entry);
      candidate.text = summarizeExploration(candidate.members);
      this.entries.splice(index, 1);
      return;
    }
    if (!following.every(isExplorationInFlight)) return;
    this.entries[index] = {
      id: this.newId(),
      kind: 'explore',
      text: summarizeExploration([entry]),
      members: [entry],
    };
  }

  /** Take the last grouped call back out so it can carry its own annotations. */
  private ungroupLast(toolName: string): ToolEntry | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const candidate = this.entries[index]!;
      if (candidate.kind === 'tool' && candidate.toolName === toolName) return candidate;
      if (candidate.kind !== 'explore') continue;
      const member = candidate.members.at(-1);
      if (member?.toolName !== toolName) return undefined;
      candidate.members.pop();
      if (candidate.members.length === 0) {
        this.entries.splice(index, 1, member);
      } else {
        candidate.text = summarizeExploration(candidate.members);
        candidate.closed = true;
        this.entries.splice(index + 1, 0, member);
      }
      return member;
    }
    return undefined;
  }

  /**
   * When the in-flight streaming text grows past `streamSpillLines`, peel its
   * completed paragraphs off into the current entry — which finalizes — and
   * continue streaming into a fresh active entry. Returns the number of
   * chars of `tail` consumed by the spill (0 when no safe boundary exists).
   * Entries are only ever appended, so the commit cursor's append-only
   * invariant holds: the old active entry finalizes in place and the new
   * tail entry lands after it.
   */
  private spillStreamingParagraphs(stream: TextStream, tail: string): number {
    if (countLines(tail) <= this.streamSpillLines) return 0;
    const boundary = lastParagraphBoundary(tail);
    if (boundary <= 0) return 0;
    const active = this.entries.find((e) => e.id === stream.entryId);
    if (!active || !isTextEntry(active)) return 0;
    active.text = tail.slice(0, boundary).trimEnd();
    let consumed = boundary;
    while (tail[consumed] === '\n') consumed += 1;
    const newId = this.newId();
    this.entries.push({
      id: newId,
      kind: stream.kind,
      text: tail.slice(consumed),
      textId: active.textId,
    });
    stream.entryId = newId;
    return consumed;
  }

  private applyTextDelta(stream: TextStream, ev: { id?: string; delta: string }): void {
    if (stream.buf === null) {
      stream.buf = '';
      stream.spilled = 0;
      stream.suppressSpill = ev.id !== undefined && stream.completedTexts.has(ev.id);
      const id = this.newId();
      stream.entryId = id;
      this.entries.push({ id, kind: stream.kind, text: '', textId: ev.id });
    }
    stream.buf += ev.delta;
    if (!stream.suppressSpill) {
      stream.spilled += this.spillStreamingParagraphs(stream, stream.buf.slice(stream.spilled));
    }
    const target = this.entries.find((e) => e.id === stream.entryId);
    if (target && target.kind === stream.kind) {
      target.text = stream.buf.slice(stream.spilled);
    }
  }

  private applyTextDone(stream: TextStream, ev: { id?: string; text: string }): void {
    const streamed = stream.buf;
    const spilled = stream.spilled;
    stream.buf = null;
    stream.spilled = 0;
    const trackedIdx = this.entries.findIndex((e) => e.id === stream.entryId);
    stream.entryId = null;
    if (ev.id !== undefined) {
      // Group-aware dedupe: when an earlier emission of this textId produced
      // the same full text (possibly as several spilled chunks no
      // single-entry comparison could match), drop the re-streamed
      // duplicate wholesale.
      if (trackedIdx >= 0 && stream.completedTexts.get(ev.id) === ev.text) {
        this.entries.splice(trackedIdx, 1);
        return;
      }
      stream.completedTexts.set(ev.id, ev.text);
    }
    if (spilled > 0 && trackedIdx >= 0) {
      // Earlier paragraphs were spilled into already-committed entries,
      // which are immutable once printed by <Static>. Reconcile only the
      // tail: when the canonical text matches what we streamed, swap in
      // its remainder; otherwise keep the streamed tail as-is. Dedupe is
      // impossible here — the chunks are physically in the terminal.
      const target = this.entries[trackedIdx];
      if (target && isTextEntry(target)) {
        const prefixMatches =
          streamed !== null && ev.text.slice(0, spilled) === streamed.slice(0, spilled);
        const tailText = prefixMatches ? ev.text.slice(spilled) : target.text;
        if (tailText.length === 0) {
          this.entries.splice(trackedIdx, 1);
        } else {
          target.text = tailText;
          if (ev.id !== undefined) target.textId = ev.id;
        }
        return;
      }
    }
    if (trackedIdx >= 0) {
      const target = this.entries[trackedIdx];
      if (target && isTextEntry(target) && target.kind === stream.kind && target.text.length > 0) {
        target.text = ev.text;
        if (ev.id !== undefined) target.textId = ev.id;
        // Dedupe: the tracked entry may be a duplicate of an earlier one.
        if (ev.id !== undefined) {
          for (let i = trackedIdx - 1; i >= 0; i -= 1) {
            const candidate = this.entries[i];
            if (
              candidate &&
              candidate.kind === stream.kind &&
              isTextEntry(candidate) &&
              candidate.textId === ev.id &&
              candidate.text === target.text
            ) {
              this.entries.splice(trackedIdx, 1);
              return;
            }
          }
        } else {
          const above = this.entries[trackedIdx - 1];
          if (
            above &&
            above.kind === stream.kind &&
            isTextEntry(above) &&
            above.text === target.text &&
            above.textId === undefined
          ) {
            this.entries.splice(trackedIdx, 1);
          }
        }
        return;
      }
    }

    this.entries.push({ id: this.newId(), kind: stream.kind, text: ev.text, textId: ev.id });
    const finalEntry = this.entries[this.entries.length - 1]!;

    if (ev.id !== undefined) {
      for (let i = this.entries.length - 2; i >= 0; i -= 1) {
        const candidate = this.entries[i];
        if (
          candidate &&
          candidate.kind === stream.kind &&
          isTextEntry(candidate) &&
          candidate.textId === ev.id &&
          candidate.text === finalEntry.text
        ) {
          this.entries.pop();
          return;
        }
      }
      return;
    }

    const above = this.entries[this.entries.length - 2];
    if (
      above &&
      above.kind === stream.kind &&
      isTextEntry(above) &&
      above.text === finalEntry.text &&
      above.textId === undefined
    ) {
      this.entries.pop();
    }
  }

  private resetTextStream(stream: TextStream): void {
    stream.buf = null;
    stream.entryId = null;
    stream.spilled = 0;
    stream.suppressSpill = false;
    stream.completedTexts.clear();
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

  addUserMessage(content: string, imageCount?: number): void {
    this.entries.push({ id: this.newId(), kind: 'user', text: content, imageCount });
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
    this.run = null;
    this.entries = [];
    this.committedCount = 0;
    this.toolsByCallId.clear();
    this.subagentParents.clear();
    this.backgroundSubagents.clear();
    this.subagentToolsByCallId.clear();
    this.resetTextStream(this.assistantStream);
    this.resetTextStream(this.thinkingStream);
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
        const imageCount = countImageParts(msg.content);
        if (text || imageCount > 0) {
          this.apply({ type: 'user_message', content: text, imageCount });
        }
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
    this.trackRun(ev);
    try {
      if (ev.type === 'assistant_text_delta') {
        this.applyTextDelta(this.assistantStream, ev);
        dirty = true;
        return;
      }
      if (ev.type === 'assistant_text_done') {
        this.applyTextDone(this.assistantStream, ev);
        dirty = true;
        return;
      }
      if (ev.type === 'reasoning_text_delta') {
        this.applyTextDelta(this.thinkingStream, ev);
        dirty = true;
        return;
      }
      if (ev.type === 'reasoning_text_done') {
        this.applyTextDone(this.thinkingStream, ev);
        dirty = true;
        return;
      }
      if (ev.type === 'user_message') {
        if (this.suppressUserContent !== null) {
          const expected = this.suppressUserContent;
          this.suppressUserContent = null;
          if (expected === ev.content) return;
        }
        // A background subagent that ended reports through the user's place
        // in the conversation; on screen it is an event, not a message.
        const notice = parseBackgroundAgentMessage(ev.content);
        if (notice) {
          const text = `background agent ${notice.state}: ${notice.purpose}`;
          if (notice.state === 'failed') this.addError(text);
          else this.addInfo(text);
          return;
        }
        // What the goal check tells the agent has its own line, from `goal_updated`.
        if (parseGoalMessage(ev.content)) return;
        this.addUserMessage(ev.content, (ev as { imageCount?: number }).imageCount);
        return;
      }
      if (ev.type === 'goal_updated') {
        const line = goalLine(ev);
        if (ev.change === 'unchecked' || ev.change === 'impossible') this.addError(line);
        else this.addInfo(line);
        return;
      }
      if (ev.type === 'tool_call_start') {
        const entry: ScrollbackEntry = {
          id: this.newId(),
          kind: 'tool',
          text: ev.display?.summary ?? formatArgs(ev.args),
          toolName: ev.name,
          displayName: ev.display?.label,
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
          entry.durationMs = ev.durationMs;
          if (ev.display) {
            entry.text = ev.display.summary;
            entry.displayName = ev.display.label ?? entry.displayName;
            entry.detail = ev.display.detail;
          }
          if (isGroupableExploration(entry)) this.groupExploration(entry);
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
      if (ev.type === 'approval_reviewed') {
        const entry = ev.callId ? this.toolsByCallId.get(ev.callId) : undefined;
        if (entry && ev.decision === 'allow') {
          entry.reviewerApproved = true;
          dirty = true;
        }
        if (ev.stopped) {
          const limit = ev.stopped === 'consecutive' ? '3 escalations in a row' : '10 escalations';
          this.addInfo(
            `approval reviewer stopped for this session (${limit}); requests come to you again`,
          );
        }
        return;
      }
      if (ev.type === 'skill_activated') {
        // The read that loaded the skill has just been grouped with the reads
        // around it; it gets its own line again so the skill note has a home.
        const read = this.ungroupLast('read');
        if (read) {
          read.skillName = ev.skillName;
          read.skillSource = ev.source;
          dirty = true;
        }
        return;
      }
      if (ev.type === 'subagent_spawned' && ev.background) {
        // Its spawn line is finished the moment the call returns; rows under
        // a finished line would break the commit order.
        this.backgroundSubagents.add(ev.subagentId);
        return;
      }
      if (
        (ev.type === 'subagent_event' || ev.type === 'subagent_finished') &&
        this.backgroundSubagents.has(ev.subagentId)
      ) {
        if (ev.type === 'subagent_finished') this.backgroundSubagents.delete(ev.subagentId);
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
        if (inner.type === 'user_input_required') {
          this.entries.push({
            id: this.newId(),
            kind: 'subagent',
            text: `waiting for input: ${inner.request}`,
            subagentId: id,
            subagentStatus: 'running',
            parentEntryId,
          });
          dirty = true;
          return;
        }
        if (inner.type === 'tool_call_start') {
          const childTarget = inner.target === 'host' ? ' [host]' : '';
          const displayName = inner.display?.label ?? inner.name;
          const text = inner.display?.summary
            ? `${displayName}: ${inner.display.summary}${childTarget}`
            : `${displayName}${childTarget}`;
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
            entry.text = `${inner.display.label ?? entry.toolName}: ${inner.display.summary}${targetTag}`;
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
        this.resetTextStream(this.assistantStream);
        this.resetTextStream(this.thinkingStream);
        for (let i = this.entries.length - 1; i >= 0; i--) {
          const entry = this.entries[i]!;
          if (
            entry.kind === 'tool' &&
            entry.toolResult === undefined &&
            entry.toolError === undefined
          ) {
            entry.toolError = `run ended (${ev.reason}) before tool result`;
          }
          if (entry.kind === 'explore') entry.closed = true;
        }
        const summary = this.finishRun();
        if (summary) this.entries.push({ id: this.newId(), kind: 'turn', text: summary });
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

function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count += 1;
  }
  return count;
}

/**
 * Index of the newline ending the last completed paragraph in `text` — i.e.
 * the start of the last blank-line separator — or -1 when the text is a
 * single unbroken paragraph. Blank lines inside an open code fence are not
 * separators: each spilled chunk is lexed as standalone markdown, so a chunk
 * boundary there would leave both halves with unbalanced fences.
 */
function lastParagraphBoundary(text: string): number {
  let boundary = -1;
  let pos = 0;
  let insideFence = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // The segment after the final '\n' is not a completed line, so it
    // cannot act as a paragraph separator.
    if (i > 0 && i < lines.length - 1 && !insideFence && line.trim() === '') {
      boundary = pos - 1;
    }
    if (/^[ \t]*(```|~~~)/.test(line)) insideFence = !insideFence;
    pos += line.length + 1;
  }
  return boundary;
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
