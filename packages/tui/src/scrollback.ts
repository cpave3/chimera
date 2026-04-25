import type { AgentEvent, CallId } from '@chimera/core';

export interface ScrollbackEntry {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'info' | 'error' | 'subagent';
  text: string;
  toolName?: string;
  toolTarget?: 'sandbox' | 'host';
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

  apply(ev: AgentEvent): void {
    if (ev.type === 'assistant_text_delta') {
      if (this.assistantBuf === null) {
        this.assistantBuf = '';
        this.entries.push({ id: this.newId(), kind: 'assistant', text: '' });
      }
      this.assistantBuf += ev.delta;
      this.entries[this.entries.length - 1]!.text = this.assistantBuf;
      return;
    }
    if (ev.type === 'assistant_text_done') {
      this.assistantBuf = null;
      if (
        this.entries.length === 0 ||
        this.entries[this.entries.length - 1]!.kind !== 'assistant' ||
        this.entries[this.entries.length - 1]!.text.length === 0
      ) {
        this.entries.push({ id: this.newId(), kind: 'assistant', text: ev.text });
      } else {
        this.entries[this.entries.length - 1]!.text = ev.text;
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
        const e = this.entries[i]!;
        if (e.kind === 'tool' && e.toolName === 'read') {
          e.skillName = ev.skillName;
          e.skillSource = ev.source;
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
      const summary =
        ev.reason === 'stop'
          ? 'subagent finished'
          : `subagent ${ev.reason}`;
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
        const childTarget =
          inner.target === 'host' ? ' [host]' : '';
        const text =
          inner.display?.summary
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
          const targetTag =
            entry.text.endsWith('[host]') ? ' [host]' : '';
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
