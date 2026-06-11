import type { ModelMessage } from 'ai';
import type { RecallStore } from './store';

const DEFAULT_ARCHIVE_THRESHOLD_TOKENS = 500;
const STUB_PREFIX = '[Result archived — retrieve with: recall(';

export interface ArchivedRef {
  id: string;
  toolName: string;
  argsBrief: string;
}

export interface PruneResult {
  archivedCount: number;
  tokensSaved: number;
  archived: ArchivedRef[];
}

/**
 * Structurally matches `MessagePruner` in `@chimera/compaction` (declared
 * there too, without an import, to keep the dependency DAG flat).
 */
export interface RecallPruner {
  prune(messages: ModelMessage[], endIndex: number): Promise<PruneResult>;
}

export interface RecallPrunerOptions {
  archiveThresholdTokens?: number;
}

/**
 * Compaction prune phase: swap oversized tool-result outputs in
 * `messages[0..endIndex)` for recall stubs, archiving the full content in
 * the store. Messages are rewritten in place, never removed, so tool-call /
 * tool-result pairing and message ordering are unaffected. Stubs themselves
 * are skipped, so repeated passes are idempotent.
 */
export function createRecallPruner(
  store: RecallStore,
  opts: RecallPrunerOptions = {},
): RecallPruner {
  const thresholdChars = (opts.archiveThresholdTokens ?? DEFAULT_ARCHIVE_THRESHOLD_TOKENS) * 4;
  return {
    async prune(messages, endIndex) {
      const callArgsById = collectToolCallArgs(messages);
      const archived: ArchivedRef[] = [];
      let tokensSaved = 0;

      for (let i = 0; i < Math.min(endIndex, messages.length); i++) {
        const message = messages[i]!;
        if (message.role !== 'tool' || typeof message.content === 'string') continue;
        for (const part of message.content as Array<Record<string, unknown>>) {
          if (part.type !== 'tool-result') continue;
          const extracted = extractOutputText(part.output);
          if (extracted === null) continue;
          if (extracted.startsWith(STUB_PREFIX)) continue;
          if (extracted.length <= thresholdChars) continue;

          const toolName = typeof part.toolName === 'string' ? part.toolName : 'tool';
          const args = callArgsById.get(part.toolCallId as string) ?? {};
          const entry = await store.put({ toolName, args, content: extracted });
          const stub =
            `${STUB_PREFIX}{ id: "${entry.id}" })] — ${toolName} output, ` +
            `${entry.byteLen} bytes. Slice with start_line/end_line or search.`;
          part.output = { type: 'text', value: stub };

          tokensSaved += Math.ceil((extracted.length - stub.length) / 4);
          archived.push({
            id: entry.id,
            toolName,
            argsBrief: briefArgs(args),
          });
        }
      }
      return { archivedCount: archived.length, tokensSaved, archived };
    },
  };
}

function collectToolCallArgs(messages: ModelMessage[]): Map<string, unknown> {
  const argsById = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type !== 'tool-call') continue;
      argsById.set(part.toolCallId as string, part.input ?? part.args ?? {});
    }
  }
  return argsById;
}

/**
 * Pull the meaningful text out of an AI SDK v5 tool-result `output`
 * (`{ type: 'text'|'json'|'error-text'|'error-json', value }`) or a legacy
 * raw value. Returns null for shapes we don't understand (left untouched).
 */
function extractOutputText(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && 'value' in output) {
    const value = (output as { value: unknown }).value;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  if (output && typeof output === 'object') {
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return null;
}

function briefArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args);
    return json.length > 60 ? `${json.slice(0, 57)}...` : json;
  } catch {
    return '{}';
  }
}
