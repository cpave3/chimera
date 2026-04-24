import type { AgentEvent, CallId } from '@chimera/core';

export interface ScrollbackEntry {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'info' | 'error';
  text: string;
  toolName?: string;
  toolTarget?: 'sandbox' | 'host';
  toolResult?: unknown;
  toolError?: string;
}

export class Scrollback {
  private entries: ScrollbackEntry[] = [];
  private assistantBuf: string | null = null;
  private toolsByCallId = new Map<CallId, ScrollbackEntry>();
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
        text: `${ev.name} ${formatArgs(ev.args)}`,
        toolName: ev.name,
        toolTarget: ev.target,
      };
      this.toolsByCallId.set(ev.callId, entry);
      this.entries.push(entry);
      return;
    }
    if (ev.type === 'tool_call_result') {
      const entry = this.toolsByCallId.get(ev.callId);
      if (entry) entry.toolResult = ev.result;
      return;
    }
    if (ev.type === 'tool_call_error') {
      const entry = this.toolsByCallId.get(ev.callId);
      if (entry) entry.toolError = ev.error;
      else this.addError(`tool error: ${ev.error}`);
      return;
    }
    if (ev.type === 'run_finished' && ev.reason === 'error' && ev.error) {
      this.addError(ev.error);
      return;
    }
  }
}

function formatArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args);
    return json.length > 80 ? `${json.slice(0, 77)}...` : json;
  } catch {
    return '';
  }
}
