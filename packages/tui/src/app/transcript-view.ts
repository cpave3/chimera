import { type EntrySpan, type RowContext, renderEntry } from '../ledger/rows';
import type { ScrollbackEntry, SubagentEntry, ToolEntry } from '../scrollback';
import type { Style } from '../theme/style';

/** What an entry's lines depend on besides its id: when one of these moves, it draws again. */
function dependencies(entry: ScrollbackEntry, context: RowContext): unknown[] {
  const expanded = context.isExpanded(entry.id);
  switch (entry.kind) {
    case 'tool': {
      const children = context.children.get(entry.id) ?? [];
      return [
        ...toolDependencies(entry, context),
        expanded,
        children.length,
        children.at(-1)?.text,
      ];
    }
    case 'explore':
      return [
        entry.members.length,
        ...entry.members.flatMap((member) => [
          ...toolDependencies(member, context),
          context.isExpanded(member.id),
        ]),
      ];
    case 'thinking':
      return [entry.text, expanded];
    case 'user':
      return [entry.text, entry.imageCount];
    default:
      return [entry.text];
  }
}

function toolDependencies(entry: ToolEntry, context: RowContext): unknown[] {
  const running = entry.toolResult === undefined && entry.toolError === undefined;
  return [
    entry.text,
    entry.toolResult,
    entry.toolError,
    entry.durationMs,
    entry.detail,
    entry.displayName,
    entry.skillName,
    entry.reviewerApproved,
    entry.systemOneApproved,
    running ? context.spinner : '',
  ];
}

function same(left: unknown[], right: unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

/**
 * The transcript as screen lines, kept between frames. Each entry is drawn
 * once and drawn again only when what it depends on moves, and the lines
 * are rebuilt only from the first entry that changed, so a long session
 * costs no more per frame than a short one.
 */
export class TranscriptView {
  lines: string[] = [];
  /** Where each entry's lines are, counted after the header. */
  spans: EntrySpan[] = [];
  headerRows = 0;
  private cache = new Map<string, { deps: unknown[]; lines: string[] }>();
  private order: string[] = [];
  private width = 0;
  private style: Style | null = null;
  private header: string[] = [];

  /** Forget everything: the next update draws every entry. */
  reset(): void {
    this.cache.clear();
    this.order = [];
    this.lines = [];
    this.spans = [];
    this.header = [];
    this.headerRows = 0;
  }

  update(header: string[], entries: readonly ScrollbackEntry[], context: RowContext): void {
    if (context.width !== this.width || context.style !== this.style) {
      this.reset();
      this.width = context.width;
      this.style = context.style;
    }
    if (
      header.length !== this.header.length ||
      header.some((line, index) => line !== this.header[index])
    ) {
      this.order = [];
      this.header = header;
      this.headerRows = header.length;
      this.lines = [...header];
      this.spans = [];
    }
    const visible = entries.filter((entry) => !(entry.kind === 'subagent' && entry.parentEntryId));
    const drawn = visible.map((entry) => {
      const deps = dependencies(entry, context);
      const cached = this.cache.get(entry.id);
      const fresh = cached !== undefined && same(cached.deps, deps);
      return { entry, deps, fresh, cached };
    });
    let first = 0;
    while (
      first < drawn.length &&
      first < this.order.length &&
      drawn[first]!.entry.id === this.order[first] &&
      drawn[first]!.fresh
    ) {
      first += 1;
    }
    if (first === drawn.length && drawn.length === this.order.length) return;
    if (this.order.length === 0) {
      this.lines = [...this.header];
      this.spans = [];
    } else {
      const kept =
        first < this.spans.length ? this.spans[first]!.start : (this.spans.at(-1)?.end ?? 0);
      this.lines.length = this.headerRows + kept;
      this.spans.length = first;
    }
    for (let index = first; index < drawn.length; index += 1) {
      const { entry, deps, fresh, cached } = drawn[index]!;
      let lines: string[];
      if (fresh && cached) lines = cached.lines;
      else {
        lines = renderEntry(entry, context);
        this.cache.set(entry.id, { deps, lines });
      }
      const start = this.lines.length - this.headerRows;
      for (const line of lines) this.lines.push(line);
      this.spans.push({ id: entry.id, start, end: start + lines.length });
    }
    this.order = drawn.map(({ entry }) => entry.id);
    if (this.cache.size > drawn.length * 2) {
      const live = new Set(this.order);
      for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
    }
  }

  /** The entry drawn at a line of `lines`, if any. */
  entryAt(line: number): string | null {
    const target = line - this.headerRows;
    return this.spans.find((span) => target >= span.start && target < span.end)?.id ?? null;
  }
}

export type { SubagentEntry };
