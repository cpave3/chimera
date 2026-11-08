import type { Checkpoint, SessionId, SessionInfo } from '@chimera/core';
import type { InputEvent } from '../terminal/keys';
import { clipToWidth, displayWidth, padToWidth } from '../terminal/width';
import type { Style } from '../theme/style';
import { type Card, cardInnerWidth, renderCard } from './card';

/** The sudo password prompt. The password lives in bytes and is wiped as it goes. */
export class SudoCard implements Card {
  private password: Uint8Array = new Uint8Array();

  constructor(
    private readonly state: () => {
      status: 'checking' | 'password' | 'validating';
      error?: string;
    },
    private readonly onSubmit: (password: Uint8Array) => void,
    private readonly onCancel: () => void,
  ) {}

  private replace(next: Uint8Array): void {
    this.password.fill(0);
    this.password = next;
  }

  handleKey(event: InputEvent): void {
    if (this.state().status !== 'password') return;
    if (event.type === 'paste') {
      this.append(event.text);
      return;
    }
    if (event.type !== 'key') return;
    if (event.name === 'escape') {
      this.replace(new Uint8Array());
      this.onCancel();
    } else if (event.name === 'enter') {
      if (this.password.length === 0) return;
      const submitted = this.password;
      this.password = new Uint8Array();
      this.onSubmit(submitted);
    } else if (event.name === 'backspace') {
      this.replace(this.password.slice(0, -1));
    } else if (event.text !== undefined) {
      this.append(event.text);
    }
  }

  private append(text: string): void {
    const encoded = new TextEncoder().encode(text);
    const next = new Uint8Array(this.password.length + encoded.length);
    next.set(this.password);
    next.set(encoded, this.password.length);
    encoded.fill(0);
    this.replace(next);
  }

  dispose(): void {
    this.replace(new Uint8Array());
  }

  render(width: number, maxRows: number, style: Style): string[] {
    const { status, error } = this.state();
    const body: string[] = [];
    if (error) body.push(style.fg('error', error));
    if (status === 'checking') body.push('checking cached sudo credentials…');
    else if (status === 'validating') body.push('validating sudo credentials…');
    else
      body.push(
        `${style.fg('muted', 'password')} ${style.fg('accent', '›')} ${'•'.repeat(this.password.length)}${style.inverse(' ')}`,
      );
    body.push(style.fg('dim', 'The password stays in this local process.'));
    return renderCard(
      {
        title: 'sudo password',
        tone: 'error',
        keys: status === 'password' ? 'enter submit · esc cancel' : undefined,
        body,
      },
      width,
      maxRows,
      style,
    );
  }
}

/** The key bindings of the TUI, as the help card lists them. */
export function helpBindings(fullscreen: boolean): Array<[keys: string, action: string]> {
  return [
    ['Enter', 'send; during a run, steer the agent'],
    ['Tab', 'during a run, hold the message for the next turn'],
    ['Shift+Enter', 'new line (also Alt+Enter, or \\ then Enter)'],
    ['Up / Down', 'prompt history'],
    ['Shift+Tab', 'cycle mode'],
    ['/', 'commands; Tab completes'],
    ['@path  #path', 'attach a file to read / to write'],
    ['!command', 'run a shell command'],
    ['Esc', 'interrupt the run'],
    ['Ctrl+C', 'interrupt; press twice to exit'],
    ['Ctrl+O', 'expand or collapse tool output and thinking'],
    ['Ctrl+G', 'edit the prompt in $EDITOR'],
    ['Ctrl+V', 'paste an image'],
    ['Ctrl+T', 'open the full transcript in a pager'],
    ['Ctrl+Z', 'suspend'],
    ...(fullscreen
      ? ([
          ['PgUp / PgDn', 'scroll the transcript (also the mouse wheel)'],
          ['Ctrl+Home / End', 'jump to the top / back to the newest output'],
          ['Ctrl+F', 'search the transcript'],
          ['Click', 'expand or collapse one tool call or thought'],
          ['Drag', 'select text; it is copied when you release'],
        ] as Array<[string, string]>)
      : []),
  ];
}

/** `?` at an empty prompt: the key list. Any key closes it. */
export class HelpCard implements Card {
  constructor(
    private readonly fullscreen: boolean,
    private readonly onClose: () => void,
  ) {}

  handleKey(): void {
    this.onClose();
  }

  render(width: number, maxRows: number, style: Style): string[] {
    const bindings = helpBindings(this.fullscreen);
    const keyWidth = Math.max(...bindings.map(([keys]) => displayWidth(keys))) + 2;
    const body = bindings.map(
      ([keys, action]) =>
        `${style.fg('accent', keys.padEnd(keyWidth))}${style.fg('muted', action)}`,
    );
    return renderCard(
      { title: 'keys', tone: 'accent', keys: 'any key closes', body },
      width,
      maxRows,
      style,
    );
  }
}

export interface MenuItem {
  label: string;
  detail?: string;
}

/** The rows a menu card shows at most; the highlight stays in view. */
export const MENU_MAX_ROWS = 8;

/**
 * A list that filters from the prompt text: the slash menu and the file
 * menu. The prompt keeps the keyboard; the caller owns the highlight.
 */
export function renderMenuCard(
  title: string,
  items: MenuItem[],
  highlight: number,
  width: number,
  maxRows: number,
  style: Style,
  keys = '↑↓ · tab · esc',
): string[] {
  const inner = cardInnerWidth(width);
  const shown = Math.max(1, Math.min(MENU_MAX_ROWS, maxRows - 2));
  const start = Math.max(0, Math.min(items.length - shown, highlight - Math.floor(shown / 2)));
  const labelWidth = Math.min(
    Math.floor(inner / 2),
    Math.max(...items.map((item) => displayWidth(item.label))) + 2,
  );
  const body = items.slice(start, start + shown).map((item, offset) => {
    const highlighted = start + offset === highlight;
    const marker = highlighted ? style.fg('accent', '› ') : '  ';
    const label = padToWidth(clipToWidth(item.label, labelWidth - 1), labelWidth);
    return `${marker}${highlighted ? style.bold(label) : label}${item.detail ? style.fg('dim', item.detail) : ''}`;
  });
  return renderCard({ title, tone: 'accent', keys, body }, width, maxRows, style);
}

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index >= 0 ? path.slice(index + 1) : path;
}

/** A vertical list picked with ↑↓ (or j/k) and Enter. */
abstract class ListCard<Item> implements Card {
  protected highlight = 0;

  constructor(protected readonly items: Item[]) {}

  protected abstract onPick(item: Item, event: InputEvent & { type: 'key' }): void;
  protected abstract onCancel(): void;

  handleKey(event: InputEvent): void {
    if (event.type !== 'key') return;
    if (event.name === 'escape' || (event.ctrl && event.name === 'c')) this.onCancel();
    else if (event.name === 'enter') {
      const item = this.items[this.highlight];
      if (item) this.onPick(item, event);
    } else if (event.name === 'up' || event.text === 'k')
      this.highlight = Math.max(0, this.highlight - 1);
    else if (event.name === 'down' || event.text === 'j') {
      this.highlight = Math.min(this.items.length - 1, this.highlight + 1);
    } else this.other(event);
  }

  protected other(_event: InputEvent & { type: 'key' }): void {}

  abstract render(width: number, maxRows: number, style: Style): string[];

  protected window(maxRows: number, fixed: number): { start: number; count: number } {
    const count = Math.max(1, Math.min(this.items.length, maxRows - 2 - fixed));
    const start = Math.max(
      0,
      Math.min(this.items.length - count, this.highlight - Math.floor(count / 2)),
    );
    return { start, count };
  }
}

export interface SessionRow {
  info: SessionInfo;
  prefix: string;
}

/** `/sessions`: the session tree, picked to switch to. */
export class SessionPickerCard extends ListCard<SessionRow> {
  constructor(
    rows: SessionRow[],
    private readonly currentId: SessionId,
    private readonly onSelect: (id: SessionId) => void,
    private readonly cancel: () => void,
    private readonly now: () => number = Date.now,
    private readonly relative: (now: number, then: number) => string = () => '',
  ) {
    super(rows);
    this.highlight = Math.max(
      0,
      rows.findIndex((row) => row.info.id === currentId),
    );
  }

  protected onPick(row: SessionRow): void {
    this.onSelect(row.info.id);
  }

  protected onCancel(): void {
    this.cancel();
  }

  render(width: number, maxRows: number, style: Style): string[] {
    if (this.items.length === 0) {
      return renderCard(
        { title: 'sessions', tone: 'accent', keys: 'esc close', body: ['no saved sessions'] },
        width,
        maxRows,
        style,
      );
    }
    const inner = cardInnerWidth(width);
    const { start, count } = this.window(maxRows, 0);
    const now = this.now();
    const body = this.items.slice(start, start + count).map((row, offset) => {
      const highlighted = start + offset === this.highlight;
      const current = row.info.id === this.currentId;
      const name = row.info.name ?? (basename(row.info.cwd) || row.info.cwd);
      const left = `${highlighted ? style.fg('accent', '› ') : '  '}${style.fg('dim', `${row.prefix}${row.info.id.slice(-8)}`)}  ${highlighted ? style.bold(name) : name}${current ? style.fg('accent', ' ←') : ''}`;
      const right = style.fg(
        'dim',
        `${this.relative(now, row.info.createdAt)} · ${row.info.messageCount} msgs`,
      );
      const gap = Math.max(1, inner - displayWidth(left) - displayWidth(right));
      return `${left}${' '.repeat(gap)}${right}`;
    });
    return renderCard(
      {
        title: `sessions · ${this.items.length}`,
        tone: 'accent',
        keys: '↑↓ enter switch · esc',
        body,
      },
      width,
      maxRows,
      style,
    );
  }
}

/** `/rewind`: Enter rewinds to a checkpoint, Shift+Enter forks from it. */
export class RewindPickerCard extends ListCard<Checkpoint> {
  constructor(
    checkpoints: Checkpoint[],
    private readonly onRewind: (checkpoint: Checkpoint) => void,
    private readonly onFork: (checkpoint: Checkpoint) => void,
    private readonly cancel: () => void,
  ) {
    super(checkpoints);
  }

  protected onPick(checkpoint: Checkpoint, event: InputEvent & { type: 'key' }): void {
    if (event.shift) this.onFork(checkpoint);
    else this.onRewind(checkpoint);
  }

  protected onCancel(): void {
    this.cancel();
  }

  render(width: number, maxRows: number, style: Style): string[] {
    if (this.items.length === 0) {
      return renderCard(
        { title: 'rewind', tone: 'accent', keys: 'esc close', body: ['no checkpoints'] },
        width,
        maxRows,
        style,
      );
    }
    const { start, count } = this.window(maxRows, 0);
    const body = this.items.slice(start, start + count).map((checkpoint, offset) => {
      const highlighted = start + offset === this.highlight;
      const summary = checkpoint.toolCallSummary
        ? style.fg('dim', ` · ${checkpoint.toolCallSummary}`)
        : '';
      const message = checkpoint.userMessage.replace(/\s+/g, ' ');
      return `${highlighted ? style.fg('accent', '› ') : '  '}${style.fg('dim', `${checkpoint.index}`.padStart(3))}  ${highlighted ? style.bold(message) : message}${summary}`;
    });
    return renderCard(
      { title: 'rewind', tone: 'accent', keys: 'enter rewind · shift+enter fork · esc', body },
      width,
      maxRows,
      style,
    );
  }
}

export interface OverlayChange {
  kind: 'modified' | 'added' | 'deleted';
  path: string;
}

/** The overlay's changes, each ticked to apply or not. */
export class OverlayPickerCard extends ListCard<OverlayChange> {
  private readonly chosen: Set<number>;

  constructor(
    changes: OverlayChange[],
    private readonly onResolve: (selection: { paths: string[] } | null) => void,
  ) {
    super(changes);
    this.chosen = new Set(changes.map((_, index) => index));
  }

  protected onPick(): void {
    this.onResolve({
      paths: this.items.filter((_, index) => this.chosen.has(index)).map((change) => change.path),
    });
  }

  override handleKey(event: InputEvent): void {
    if (event.type === 'key' && event.name === 'enter' && this.items.length === 0) {
      this.onResolve({ paths: [] });
      return;
    }
    super.handleKey(event);
  }

  protected onCancel(): void {
    this.onResolve(null);
  }

  protected override other(event: InputEvent & { type: 'key' }): void {
    if (event.text === ' ') {
      if (this.chosen.has(this.highlight)) this.chosen.delete(this.highlight);
      else this.chosen.add(this.highlight);
    } else if (event.text === 'a') {
      for (let index = 0; index < this.items.length; index += 1) this.chosen.add(index);
    } else if (event.text === 'n') {
      this.chosen.clear();
    }
  }

  render(width: number, maxRows: number, style: Style): string[] {
    const { start, count } = this.window(maxRows, 0);
    const body =
      this.items.length === 0
        ? [style.fg('dim', 'no changes')]
        : this.items.slice(start, start + count).map((change, offset) => {
            const index = start + offset;
            const highlighted = index === this.highlight;
            const tag = change.kind === 'added' ? '+' : change.kind === 'deleted' ? '−' : '~';
            const tone =
              change.kind === 'added'
                ? 'diffAdd'
                : change.kind === 'deleted'
                  ? 'diffRemove'
                  : 'warning';
            return `${highlighted ? style.fg('accent', '› ') : '  '}${this.chosen.has(index) ? '[x]' : '[ ]'} ${style.fg(tone, tag)} ${highlighted ? style.bold(change.path) : change.path}`;
          });
    return renderCard(
      {
        title: 'apply overlay changes',
        tone: 'accent',
        keys: 'space toggle · a all · n none · enter apply · esc',
        body,
      },
      width,
      maxRows,
      style,
    );
  }
}
