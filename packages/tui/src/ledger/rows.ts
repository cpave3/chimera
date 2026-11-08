import { formatElapsed } from '../activity';
import { lineDiff } from '../diff';
import { displayPath } from '../display-path';
import type { ScrollbackEntry, SubagentEntry, ToolEntry } from '../scrollback';
import { clipToWidth, displayWidth, padToWidth } from '../terminal/width';
import type { ColorToken } from '../theme/palette';
import type { Style } from '../theme/style';
import { renderMarkdown } from './markdown';
import { BODY_INDENT, bodyWidth, LABEL_WIDTH, wrapText } from './text';

/** What every transcript row needs besides its entry. */
export interface RowContext {
  width: number;
  style: Style;
  /** The spinner frame for calls still running. */
  spinner: string;
  /** A Docker sandbox runs some calls: tool rows say where each one ran. */
  sandboxActive: boolean;
  /** Whether an entry's output or thinking is shown in full. */
  isExpanded(entryId: string): boolean;
  /** Subagent rows that belong to a `spawn_agent` entry, by its id. */
  children: Map<string, SubagentEntry[]>;
}

/** The lines one entry drew, `[start, end)` in the transcript's lines. */
export interface EntrySpan {
  id: string;
  start: number;
  end: number;
}

export interface RenderedTranscript {
  lines: string[];
  spans: EntrySpan[];
}

/** Rows of output a collapsed call shows. */
export const COLLAPSED_OUTPUT_ROWS = 3;
/** Diff rows a collapsed edit shows: the change is what the reader came for. */
export const COLLAPSED_DIFF_ROWS = 12;

/** A label right-aligned in the label column, then the gap. */
export function label(text: string, tone: ColorToken, style: Style): string {
  const clipped = displayWidth(text) > LABEL_WIDTH ? clipToWidth(text, LABEL_WIDTH) : text;
  return `${style.fg(tone, ' '.repeat(LABEL_WIDTH - displayWidth(clipped)) + clipped)}  `;
}

/** Lines under one label: the label on the first, the body indent on the rest. */
function labelled(text: string, tone: ColorToken, body: string[], style: Style): string[] {
  return body.map(
    (line, index) => `${index === 0 ? label(text, tone, style) : BODY_INDENT}${line}`,
  );
}

/** Blank lines go before your messages and before assistant text only. */
function gapBefore(entry: ScrollbackEntry): boolean {
  return entry.kind === 'user' || entry.kind === 'assistant';
}

export function renderTranscript(
  entries: readonly ScrollbackEntry[],
  context: RowContext,
): RenderedTranscript {
  const lines: string[] = [];
  const spans: EntrySpan[] = [];
  for (const entry of entries) {
    if (entry.kind === 'subagent' && entry.parentEntryId) continue;
    const start = lines.length;
    lines.push(...renderEntry(entry, context));
    spans.push({ id: entry.id, start, end: lines.length });
  }
  return { lines, spans };
}

/** One entry's lines, with the blank line it starts with when it has one. */
export function renderEntry(entry: ScrollbackEntry, context: RowContext): string[] {
  const rows = renderEntryRows(entry, context).map((line) =>
    displayWidth(line) > context.width ? clipToWidth(line, context.width) : line,
  );
  return gapBefore(entry) ? ['', ...rows] : rows;
}

function renderEntryRows(entry: ScrollbackEntry, context: RowContext): string[] {
  const { style, width } = context;
  const body = bodyWidth(width);
  switch (entry.kind) {
    case 'user': {
      const images = entry.imageCount
        ? ` ${Array.from({ length: entry.imageCount }, (_, i) => `[Image #${i + 1}]`).join(' ')}`
        : '';
      return labelled('you', 'accent', wrapText(`${entry.text}${images}`, body, style.bold), style);
    }
    case 'assistant':
      return renderMarkdown(entry.text, body, style).map((line) =>
        line === '' ? '' : `${BODY_INDENT}${line}`,
      );
    case 'thinking': {
      const paint = (text: string) => style.italic(style.fg('dim', text));
      const rows = context.isExpanded(entry.id)
        ? wrapText(entry.text.trim(), body, paint)
        : [paint(clipToWidth(entry.text.trim().replace(/\s*\n\s*/g, ' '), body))];
      return labelled('think', 'dim', rows, style);
    }
    case 'tool':
      return renderTool(entry, context);
    case 'explore':
      return entry.members.flatMap((member) => renderTool(member, context));
    case 'subagent':
      return labelled(
        'agent',
        'muted',
        wrapText(entry.text, body, (text) => style.fg('muted', text)),
        style,
      );
    case 'error':
      return labelled(
        '✗ error',
        'error',
        wrapText(entry.text, body, (text) => style.fg('error', text)),
        style,
      );
    case 'mode_change':
      return labelled('mode', 'accent', wrapText(entry.text, body), style);
    case 'turn':
      return labelled(
        'done',
        'dim',
        wrapText(entry.text, body, (text) => style.fg('dim', text)),
        style,
      );
    case 'info': {
      const [name, tone] = noticeLabel(entry.text);
      return labelled(
        name,
        tone,
        wrapText(entry.text, body, (text) => style.fg('muted', text)),
        style,
      );
    }
  }
}

function noticeLabel(text: string): [string, ColorToken] {
  if (text.startsWith('goal')) return ['goal', 'success'];
  if (text.startsWith('compact')) return ['compact', 'muted'];
  if (text.startsWith('background agent')) return ['agent', 'muted'];
  return ['note', 'dim'];
}

const SHORT_NAMES: Record<string, string> = {
  apply_patch: 'patch',
  spawn_agent: 'agent',
  ask_question: 'ask',
  request_user_input: 'ask',
};

/** The tool's name as the label column shows it: short enough for seven cells. */
function toolLabel(entry: ToolEntry): string {
  const name = entry.displayName ?? SHORT_NAMES[entry.toolName] ?? entry.toolName;
  if (name.length <= LABEL_WIDTH) return name;
  // An MCP tool is `mcp__server__tool`: its own name says the most.
  return name.split('__').at(-1)!;
}

type ToolState = 'running' | 'done' | 'failed';

function toolState(entry: ToolEntry): ToolState {
  if (entry.toolError !== undefined) return 'failed';
  if (entry.toolResult === undefined) return 'running';
  const exitCode = (entry.toolResult as { exit_code?: unknown } | null)?.exit_code;
  return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'done';
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 60_000
    ? `${(milliseconds / 1000).toFixed(1)}s`
    : formatElapsed(milliseconds);
}

/** A formatter summary is `argument (facts)`: split them for the two columns of a row. */
export function splitSummary(summary: string): { argument: string; facts: string[] } {
  const match = /^(.*\S)\s+\(([^()]*)\)$/s.exec(summary);
  if (!match) return { argument: summary, facts: [] };
  return { argument: match[1]!, facts: match[2]!.split(', ').filter((fact) => fact !== '') };
}

function editCounts(entry: ToolEntry): { added: number; removed: number } | null {
  const args = entry.toolArgs as { old_string?: string; new_string?: string } | undefined;
  if (!args || (args.old_string === undefined && args.new_string === undefined)) return null;
  const diff = lineDiff(splitLines(args.old_string ?? ''), splitLines(args.new_string ?? ''));
  return {
    added: diff.filter((row) => row.kind === 'add').length,
    removed: diff.filter((row) => row.kind === 'del').length,
  };
}

function splitLines(text: string): string[] {
  const stripped = text.replace(/\n+$/, '');
  return stripped === '' ? [] : stripped.split('\n');
}

/** `label  argument  facts`, then what the call put out. */
export function renderTool(entry: ToolEntry, context: RowContext): string[] {
  const { style, width } = context;
  const state = toolState(entry);
  const name = toolLabel(entry);
  const labelText =
    state === 'running' ? `${context.spinner} ${name}` : state === 'failed' ? `✗ ${name}` : name;
  const labelTone: ColorToken =
    state === 'running' ? 'warning' : state === 'failed' ? 'error' : 'muted';
  const { argument, facts } = splitSummary(entry.text);
  let factText: string;
  let factPaint: (text: string) => string = (text) =>
    style.fg(state === 'failed' ? 'error' : 'dim', text);
  const edit = entry.toolName === 'edit' && state !== 'failed' ? editCounts(entry) : null;
  if (edit && state === 'done') {
    factText = `+${edit.added} −${edit.removed}`;
    factPaint = () =>
      `${style.fg('diffAdd', `+${edit.added}`)} ${style.fg('diffRemove', `−${edit.removed}`)}`;
  } else {
    const shown = facts.filter((fact) => !(entry.toolName === 'bash' && fact === 'exit 0'));
    if (entry.durationMs !== undefined && (entry.toolName === 'bash' || entry.durationMs >= 1000)) {
      shown.push(formatDuration(entry.durationMs));
    }
    if (state === 'running' && entry.toolName === 'write') shown.push('writing…');
    if (entry.skillName) shown.push(`skill ${entry.skillName}`);
    if (entry.reviewerApproved) shown.push('approved by reviewer');
    else if (entry.systemOneApproved) shown.push('approved by System One');
    factText = shown.join(' · ');
  }
  const badge = context.sandboxActive ? `[${entry.toolTarget}] ` : '';
  const room = bodyWidth(width) - (factText === '' ? 0 : displayWidth(factText) + 2);
  const argumentText = clipToWidth(`${badge}${argument}`, Math.max(8, room));
  const header =
    `${label(labelText, labelTone, style)}${badge ? style.fg('muted', badge) : ''}${argumentText.slice(badge.length)}` +
    (factText === '' ? '' : `  ${factPaint(factText)}`);
  const rows = [header];
  const bodyRows = toolBody(entry, context);
  const expanded = context.isExpanded(entry.id);
  const limit =
    entry.toolName === 'edit' || entry.toolName === 'apply_patch'
      ? COLLAPSED_DIFF_ROWS
      : COLLAPSED_OUTPUT_ROWS;
  rows.push(...collapse(bodyRows, expanded ? Number.POSITIVE_INFINITY : limit, style));
  if (entry.detail)
    rows.push(
      ...wrapText(entry.detail, bodyWidth(width), (text) => style.fg('dim', text)).map(
        (line) => `${BODY_INDENT}${line}`,
      ),
    );
  if (entry.toolError) {
    rows.push(
      ...wrapText(entry.toolError, bodyWidth(width), (text) => style.fg('error', text)).map(
        (line) => `${BODY_INDENT}${line}`,
      ),
    );
  }
  const children = context.children.get(entry.id) ?? [];
  if (children.length > 0) {
    const shown = expanded ? children : children.slice(-COLLAPSED_OUTPUT_ROWS);
    if (shown.length < children.length) {
      rows.push(
        `${BODY_INDENT}${style.fg('dim', `… ${children.length - shown.length} earlier · ctrl+o`)}`,
      );
    }
    shown.forEach((child, index) => {
      const connector = index === shown.length - 1 ? '└ ' : '├ ';
      const text = clipToWidth(child.text, bodyWidth(width) - 2);
      rows.push(`${BODY_INDENT}${style.fg('dim', connector)}${style.fg('muted', text)}`);
    });
  }
  return rows;
}

function collapse(rows: string[], limit: number, style: Style): string[] {
  if (rows.length <= limit) return rows;
  return [
    ...rows.slice(0, limit),
    `${BODY_INDENT}${style.fg('dim', `… ${rows.length - limit} more · ctrl+o`)}`,
  ];
}

/** What a call put out, as rows in the body column, before collapsing. */
function toolBody(entry: ToolEntry, context: RowContext): string[] {
  if (entry.toolError !== undefined) return [];
  const { style, width } = context;
  const room = bodyWidth(width);
  const row = (text: string, tone: ColorToken) =>
    `${BODY_INDENT}${style.fg(tone, clipToWidth(text.replace(/\t/g, '  '), room))}`;
  switch (entry.toolName) {
    case 'bash': {
      const result = entry.toolResult as { stdout?: string; stderr?: string } | undefined;
      if (!result) return [];
      return [
        ...splitLines(result.stdout ?? '').map((line) => row(line, 'muted')),
        ...splitLines(result.stderr ?? '').map((line) => row(line, 'error')),
      ];
    }
    case 'edit':
      return editRows(entry, context);
    case 'apply_patch': {
      const input = (entry.toolArgs as { input?: string } | undefined)?.input;
      if (typeof input !== 'string') return [];
      return splitLines(input)
        .filter(
          (line) => !['*** Begin Patch', '*** End Patch', '*** End of File'].includes(line.trim()),
        )
        .map((line) => {
          if (line.startsWith('*** '))
            return `${BODY_INDENT}${style.bold(clipToWidth(line.slice(4), room))}`;
          if (line.startsWith('+')) return diffRow('add', `+ ${line.slice(1)}`, context);
          if (line.startsWith('-')) return diffRow('remove', `- ${line.slice(1)}`, context);
          return row(`  ${line.replace(/^ /, '')}`, 'muted');
        });
    }
    case 'write': {
      const content = (entry.toolArgs as { content?: string } | undefined)?.content;
      if (typeof content !== 'string' || entry.toolResult === undefined) return [];
      const lines = splitLines(content);
      const gutter = String(lines.length).length;
      return lines.map(
        (line, index) =>
          `${BODY_INDENT}${style.fg('dim', String(index + 1).padStart(gutter))} ${style.fg('muted', clipToWidth(line, room - gutter - 1))}`,
      );
    }
    default:
      return [];
  }
}

type HunkRow = { kind: 'same' | 'del' | 'add'; lineNumber: number; content: string };

function editRows(entry: ToolEntry, context: RowContext): string[] {
  const args = entry.toolArgs as { old_string?: string; new_string?: string } | undefined;
  const result = entry.toolResult as
    | { startLine?: number; contextBefore?: string[]; contextAfter?: string[] }
    | undefined;
  if (!args || !result) return [];
  const oldLines = splitLines(args.old_string ?? '');
  const newLines = splitLines(args.new_string ?? '');
  const startLine = typeof result.startLine === 'number' ? result.startLine : 1;
  const before = result.contextBefore ?? [];
  const rows: HunkRow[] = before.map((content, index) => ({
    kind: 'same',
    lineNumber: startLine - before.length + index,
    content,
  }));
  let oldOffset = 0;
  let newOffset = 0;
  for (const change of lineDiff(oldLines, newLines)) {
    if (change.kind === 'same') {
      rows.push({ kind: 'same', lineNumber: startLine + newOffset, content: change.line });
      oldOffset += 1;
      newOffset += 1;
    } else if (change.kind === 'del') {
      rows.push({ kind: 'del', lineNumber: startLine + oldOffset, content: change.line });
      oldOffset += 1;
    } else {
      rows.push({ kind: 'add', lineNumber: startLine + newOffset, content: change.line });
      newOffset += 1;
    }
  }
  (result.contextAfter ?? []).forEach((content, index) => {
    rows.push({ kind: 'same', lineNumber: startLine + newOffset + index, content });
  });
  const gutter = Math.max(4, String(Math.max(...rows.map((hunk) => hunk.lineNumber), 0)).length);
  return rows.map((hunk) => {
    const number = String(hunk.lineNumber).padStart(gutter);
    // Leading indentation of the hunk is kept relative to the first row.
    const text = `${hunk.kind === 'same' ? ' ' : hunk.kind === 'add' ? '+' : '-'} ${hunk.content.replace(/^ {2}/, '')}`;
    if (hunk.kind === 'same') {
      return `${BODY_INDENT}${context.style.fg('dim', number)} ${context.style.fg('muted', clipToWidth(text, bodyWidth(context.width) - gutter - 1))}`;
    }
    return diffRow(hunk.kind === 'add' ? 'add' : 'remove', text, context, number);
  });
}

/** An added or removed row: coloured, and tinted across the row when the theme has tints. */
function diffRow(
  kind: 'add' | 'remove',
  text: string,
  context: RowContext,
  number?: string,
): string {
  const { style, width } = context;
  const prefix = number === undefined ? '' : `${number} `;
  const room = bodyWidth(width) - displayWidth(prefix);
  const content = style.fg(kind === 'add' ? 'diffAdd' : 'diffRemove', clipToWidth(text, room));
  const painted = `${BODY_INDENT}${prefix ? `${style.fg('dim', number!)} ` : ''}${content}`;
  return style.hasDiffTints ? style.diffBg(kind, padToWidth(painted, width)) : painted;
}

/** `tasks  2/4 ✓ ✓ ▸ active task ○`: the task list in one row above the prompt box. */
export function renderTaskRow(
  tasks: readonly { content: string; status: string }[],
  width: number,
  style: Style,
): string {
  const done = tasks.filter((task) => task.status === 'completed').length;
  const marks = tasks.map((task) => {
    if (task.status === 'completed') return style.fg('success', '✓');
    if (task.status === 'in_progress') return style.fg('accent', `▸ ${task.content}`);
    return style.fg('dim', '○');
  });
  return clipToWidth(
    `${label('tasks', 'dim', style)}${style.fg('muted', `${done}/${tasks.length}`)} ${marks.join(' ')}`,
    width,
  );
}

export interface BannerFacts {
  version: string;
  modelRef: string;
  cwd: string;
  skillCount: number;
  commandCount: number;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** The start of a session: two dim rows, what runs and what was loaded. */
export function renderBanner(facts: BannerFacts, width: number, style: Style): string[] {
  const loaded = [
    ...(facts.skillCount > 0 ? [count(facts.skillCount, 'skill')] : []),
    ...(facts.commandCount > 0 ? [count(facts.commandCount, 'command')] : []),
  ];
  const first = `${label('chimera', 'dim', style)}${style.fg('dim', `${facts.version} · ${facts.modelRef} · ${displayPath(facts.cwd, 60)}`)}`;
  const rows = [
    first,
    ...(loaded.length > 0 ? [`${BODY_INDENT}${style.fg('dim', loaded.join(' · '))}`] : []),
  ];
  return rows.map((row) => clipToWidth(row, width));
}
