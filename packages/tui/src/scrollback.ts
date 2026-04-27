import type { AgentEvent, CallId, Session, ToolCallRecord } from '@chimera/core';

export interface ScrollbackEntry {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'info' | 'error' | 'subagent';
  text: string;
  toolName?: string;
  toolTarget?: 'sandbox' | 'host';
  /** Raw `tool_call_start` args; consumed by `ToolBody` renderers. Not set for subagent inner tool calls. */
  toolArgs?: unknown;
  toolResult?: unknown;
  toolError?: string;
  /** Optional follow-on lines from a tool's formatScrollback hook. */
  detail?: string;
  /** Set when a `skill_activated` event follows a `read` tool call. */
  skillName?: string;
  skillSource?: 'project' | 'user' | 'claude-compat';
  /** For `subagent` entries: short id + purpose for the header label. */
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
  /**
   * AI SDK `text-id` for assistant entries — present when the originating
   * `assistant_text_delta`/`assistant_text_done` event carried `id`. `apply()`
   * uses this to collapse re-emitted text parts: the SDK can yield the same
   * `text-start`/`text-delta`/`text-end` cycle multiple times across step
   * boundaries for what `response.messages` ultimately consolidates into one
   * part.
   */
  textId?: string;
}

export class Scrollback {
  private entries: ScrollbackEntry[] = [];
  private assistantBuf: string | null = null;
  private toolsByCallId = new Map<CallId, ScrollbackEntry>();
  /** subagentId → parent (spawn_agent) entry id, for routing child rows. */
  private subagentParents = new Map<string, string>();
  /** subagentId → its own callId-keyed map of child tool entries. Lets us
   *  mutate a child row's text when the inner tool_call_result arrives. */
  private subagentToolsByCallId = new Map<string, Map<CallId, ScrollbackEntry>>();
  private idSeq = 0;
  private suppressUserContent: string | null = null;

  private newId(): string {
    this.idSeq += 1;
    return `s${this.idSeq}`;
  }

  all(): ScrollbackEntry[] {
    return [...this.entries];
  }

  addUserMessage(content: string): void {
    this.entries.push({ id: this.newId(), kind: 'user', text: content });
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
  }

  addError(text: string): void {
    this.entries.push({ id: this.newId(), kind: 'error', text });
  }

  clear(): void {
    this.entries = [];
    this.assistantBuf = null;
    this.toolsByCallId.clear();
    this.subagentParents.clear();
    this.subagentToolsByCallId.clear();
    this.suppressUserContent = null;
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
            this.apply({
              type: 'tool_call_start',
              callId,
              name,
              args,
              target: rec?.target ?? 'host',
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
            this.apply({
              type: 'tool_call_result',
              callId,
              result,
              durationMs: 0,
            });
          }
        }
      }
    }
  }

  apply(ev: AgentEvent): void {
    if (ev.type === 'assistant_text_delta') {
      if (this.assistantBuf === null) {
        this.assistantBuf = '';
        this.entries.push({
          id: this.newId(),
          kind: 'assistant',
          text: '',
          textId: ev.id,
        });
      }
      this.assistantBuf += ev.delta;
      this.entries[this.entries.length - 1]!.text = this.assistantBuf;
      return;
    }
    if (ev.type === 'assistant_text_done') {
      this.assistantBuf = null;
      const last = this.entries[this.entries.length - 1];
      if (last && last.kind === 'assistant' && last.text.length > 0) {
        last.text = ev.text;
        if (ev.id !== undefined) last.textId = ev.id;
      } else {
        this.entries.push({
          id: this.newId(),
          kind: 'assistant',
          text: ev.text,
          textId: ev.id,
        });
      }

      const finalEntry = this.entries[this.entries.length - 1];
      if (!finalEntry || finalEntry.kind !== 'assistant') return;

      if (ev.id !== undefined) {
        // Id-aware dedup: the AI SDK reuses a `text-id` across step
        // boundaries when re-emitting a logical text part. Scan back through
        // prior assistant entries (skipping tool calls etc.) for one with
        // the same `textId` and `text` — a match means the part was already
        // rendered, so the just-finalized entry is a duplicate.
        for (let i = this.entries.length - 2; i >= 0; i -= 1) {
          const candidate = this.entries[i];
          if (
            candidate &&
            candidate.kind === 'assistant' &&
            candidate.textId === ev.id &&
            candidate.text === finalEntry.text
          ) {
            this.entries.pop();
            return;
          }
        }
        return;
      }

      // Id-less fallback: rehydrated history and legacy producers don't
      // carry `text-id`, so the only available signal is the immediately
      // preceding entry. Gate on the preceding entry's `textId` being
      // undefined too — an id-tagged entry deserves the id-aware path's
      // discrimination, not a content match against an id-less event.
      const above = this.entries[this.entries.length - 2];
      if (
        above &&
        above.kind === 'assistant' &&
        above.text === finalEntry.text &&
        above.textId === undefined
      ) {
        this.entries.pop();
      }
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
        // Args-only summary; the renderer prepends the tool name itself so
        // that the prefix style stays consistent across formatters and the
        // raw-JSON fallback.
        text: ev.display?.summary ?? formatArgs(ev.args),
        toolName: ev.name,
        toolTarget: ev.target,
        toolArgs: ev.args,
        detail: ev.display?.detail,
      };
      this.toolsByCallId.set(ev.callId, entry);
      this.entries.push(entry);
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
      }
      return;
    }
    if (ev.type === 'tool_call_error') {
      const entry = this.toolsByCallId.get(ev.callId);
      if (entry) entry.toolError = ev.error;
      else this.addError(`tool error: ${ev.error}`);
      return;
    }
    if (ev.type === 'skill_activated') {
      // Attach to the most recent `read` tool entry, which is the one that
      // triggered activation. Walk backwards — there's usually only one
      // entry between the read and this event.
      for (let i = this.entries.length - 1; i >= 0; i -= 1) {
        const candidate = this.entries[i]!;
        if (candidate.kind === 'tool' && candidate.toolName === 'read') {
          candidate.skillName = ev.skillName;
          candidate.skillSource = ev.source;
          return;
        }
      }
      return;
    }
    if (ev.type === 'subagent_spawned') {
      const parent = this.toolsByCallId.get(ev.parentCallId);
      const parentEntryId = parent?.id;
      if (parentEntryId) this.subagentParents.set(ev.subagentId, parentEntryId);
      // Stash the parent's purpose label on the parent itself so the renderer
      // can render the group header. Skip pushing a stand-alone "spawned"
      // row when we have a parent — the parent tool entry already represents
      // the spawn — keep the row only as an orphan fallback.
      if (parentEntryId && parent) {
        parent.subagentId = ev.subagentId;
        parent.subagentPurpose = ev.purpose;
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
      return;
    }
    if (ev.type === 'subagent_finished') {
      const parentEntryId = this.subagentParents.get(ev.subagentId);
      // Children are rendered nested under the parent's tool_call_result; the
      // explicit "finished" row is redundant when grouped, so only add it as
      // an orphan fallback.
      if (parentEntryId) {
        this.subagentParents.delete(ev.subagentId);
        this.subagentToolsByCallId.delete(ev.subagentId);
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
          map = new Map<CallId, ScrollbackEntry>();
          this.subagentToolsByCallId.set(id, map);
        }
        map.set(inner.callId, entry);
        this.entries.push(entry);
        return;
      }
      if (inner.type === 'tool_call_result') {
        const map = this.subagentToolsByCallId.get(id);
        const entry = map?.get(inner.callId);
        if (entry && inner.display) {
          const targetTag = entry.text.endsWith('[host]') ? ' [host]' : '';
          entry.text = `${entry.toolName}: ${inner.display.summary}${targetTag}`;
          entry.detail = inner.display.detail;
          entry.toolResult = inner.result;
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
        return;
      }
      // Other inner events (deltas, step finishes) are noisy; skip.
      return;
    }
    if (ev.type === 'run_finished' && ev.reason === 'error' && ev.error) {
      this.addError(ev.error);
      return;
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
