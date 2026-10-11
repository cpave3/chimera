import type { ScrollbackEntry, ToolEntry } from './scrollback';

export interface TranscriptTextOptions {
  /** Add SGR colour codes (for a pager started with raw control characters on). */
  color: boolean;
}

const BODY_INDENT = '    ';

type Style = 'bold' | 'dim' | 'red' | 'green';
const SGR: Record<Style, string> = { bold: '1', dim: '2', red: '31', green: '32' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The lines a tool call produced, in full: what the live transcript abbreviates. */
function toolBody(entry: ToolEntry): Array<{ text: string; style?: Style }> {
  const lines: Array<{ text: string; style?: Style }> = [];
  const push = (text: string, style?: Style) => {
    for (const line of text.replace(/\n$/, '').split('\n')) lines.push({ text: line, style });
  };
  const args = isRecord(entry.toolArgs) ? entry.toolArgs : {};
  if (entry.toolName === 'edit') {
    if (typeof args.old_string === 'string') push(prefixLines(args.old_string, '- '), 'red');
    if (typeof args.new_string === 'string') push(prefixLines(args.new_string, '+ '), 'green');
  } else if (entry.toolName === 'write' && typeof args.content === 'string') {
    push(args.content);
  } else if (entry.toolName === 'apply_patch' && typeof args.input === 'string') {
    push(args.input);
  }

  const result = entry.toolResult;
  if (typeof result === 'string') {
    push(result);
  } else if (isRecord(result) && result.kind !== 'image') {
    const before = lines.length;
    for (const field of ['stdout', 'stderr', 'content', 'text', 'output', 'diagnostics']) {
      const value = result[field];
      if (typeof value === 'string' && value !== '') push(value);
    }
    if (Array.isArray(result.matches)) {
      for (const match of result.matches) {
        if (isRecord(match)) push(`${match.file}:${match.line}: ${match.text}`);
      }
    }
    for (const field of ['files', 'entries']) {
      const list = result[field];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        push(typeof item === 'string' ? item : isRecord(item) ? String(item.name) : String(item));
      }
    }
    // A result with none of the known fields is shown as it is.
    const edits = ['edit', 'write', 'apply_patch'].includes(entry.toolName);
    if (lines.length === before && !edits && Object.keys(result).length > 0) {
      push(JSON.stringify(result, null, 2));
    }
  }
  if (entry.toolError) push(`error: ${entry.toolError}`, 'red');
  return lines;
}

function prefixLines(text: string, prefix: string): string {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/**
 * The whole session as text for a pager. Unlike the live transcript, nothing
 * is collapsed or cut: every tool call has its own line and its full output.
 */
export function formatTranscript(
  entries: ScrollbackEntry[],
  options: TranscriptTextOptions,
): string {
  const paint = (text: string, style?: Style) =>
    options.color && style ? `\x1b[${SGR[style]}m${text}\x1b[0m` : text;
  const blocks: string[] = [];

  const addTool = (entry: ToolEntry) => {
    const name = entry.displayName ?? entry.toolName;
    const lines = [paint(`• ${name}: ${entry.text}`, 'bold')];
    for (const line of toolBody(entry)) {
      lines.push(paint(`${BODY_INDENT}${line.text}`, line.style ?? 'dim'));
    }
    blocks.push(lines.join('\n'));
  };

  for (const entry of entries) {
    if (entry.kind === 'subagent' && entry.parentEntryId) {
      blocks.push(paint(`${BODY_INDENT}└ ${entry.text}`, 'dim'));
    } else if (entry.kind === 'user') {
      blocks.push(paint(`› ${entry.text}`, 'bold'));
    } else if (entry.kind === 'assistant') {
      blocks.push(entry.text);
    } else if (entry.kind === 'thinking') {
      blocks.push(paint(entry.text, 'dim'));
    } else if (entry.kind === 'tool') {
      addTool(entry);
    } else if (entry.kind === 'explore') {
      for (const member of entry.members) addTool(member);
    } else if (entry.kind === 'error') {
      blocks.push(paint(entry.text, 'red'));
    } else {
      blocks.push(paint(entry.text, 'dim'));
    }
  }
  return `${blocks.join('\n\n')}\n`;
}
