import type {
  Checkpoint,
  PermissionDecisionAction,
  QuestionResolution,
  SessionInfo,
} from '@chimera/core';
import { describe, expect, it, vi } from 'vitest';
import type { Card } from '../src/cards/card';
import { completeSlashPrefix, slashMenuItems } from '../src/cards/menus';
import { PermissionCard } from '../src/cards/permission-card';
import { QuestionCard } from '../src/cards/question-card';
import {
  HelpCard,
  helpBindings,
  OverlayPickerCard,
  RewindPickerCard,
  renderMenuCard,
  SessionPickerCard,
  SudoCard,
} from '../src/cards/simple-cards';
import type { PendingPermission } from '../src/permission-queue';
import { KeyParser } from '../src/terminal/keys';
import { displayWidth, stripAnsi } from '../src/terminal/width';
import { BUILTIN_THEMES } from '../src/theme/palette';
import { createStyle } from '../src/theme/style';

const style = createStyle(BUILTIN_THEMES.default, 'ansi16');

/** Feed one burst of bytes, as one read, to a card. */
function burst(card: Card, bytes: string): void {
  const parser = new KeyParser();
  for (const event of [...parser.feed(bytes), ...parser.flush()]) card.handleKey(event);
}

function draw(card: Card, width: number, maxRows = 40): string[] {
  const lines = card.render(width, maxRows, style);
  for (const line of lines) expect(displayWidth(line)).toBe(width);
  expect(lines.length).toBeLessThanOrEqual(maxRows);
  return lines.map((line) => stripAnsi(line));
}

const request: PendingPermission = {
  requestId: 'r1',
  command: 'git push origin main',
  reason: 'network access: pushes to github.com',
  systemOneNote: 'needs review (writes outside the project)',
};

describe('PermissionCard', () => {
  it.each([100, 60])('draws the request and the choices vertically at %i columns', (width) => {
    const lines = draw(new PermissionCard(request, vi.fn()), width);
    expect(lines[0]).toMatch(/^┌─ approval needed ─+ key or ↑↓ enter · esc deny ─┐$/);
    expect(lines[1]).toMatch(/^│ bash {3}git push origin main +│$/);
    expect(lines[2]).toMatch(/^│ why {4}network access/);
    expect(lines.find((line) => line.includes('check'))).toMatch(
      /check {2}System One needs review/,
    );
    const choices = lines.filter((line) => /^│ (› | {2})[aAgdf] /.test(line));
    expect(choices.map((line) => line.slice(2, 30).trimEnd())).toEqual([
      '› a  Allow once',
      '  A  Allow & remember…',
      '  g  Allow pattern…',
      '  d  Deny once',
      '  f  Deny with feedback…',
    ]);
    expect(lines.at(-1)).toMatch(/^└─+┘$/);
  });

  it('denies with the whole feedback typed in one burst', () => {
    const onResolve = vi.fn<(action: PermissionDecisionAction) => void>();
    const card = new PermissionCard(request, onResolve);
    burst(card, 'ftoo risky, use a PR\r');
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({
      decision: 'deny',
      feedback: 'too risky, use a PR',
    });
  });

  it('picks the fourth choice for Down three times and Enter in one burst', () => {
    const onResolve = vi.fn();
    burst(new PermissionCard(request, onResolve), '\x1b[B\x1b[B\x1b[B\r');
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({ decision: 'deny' });
  });

  it('edits a pattern and picks its scope in one burst', () => {
    const onResolve = vi.fn();
    burst(new PermissionCard(request, onResolve), 'g\x7f\x7f\x7f\x7f*\rp');
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({
      decision: 'allow',
      remember: { scope: 'project', pattern: 'git push origin *', patternKind: 'glob' },
    });
  });

  it('types feedback inside the card', () => {
    const card = new PermissionCard(request, vi.fn());
    burst(card, 'fnot now');
    expect(draw(card, 80).some((line) => line.includes('feedback › not now'))).toBe(true);
  });

  it('scrolls a tall request inside the card, keeping the choices in view', () => {
    const tall: PendingPermission = { ...request, reason: 'why '.repeat(200) };
    const card = new PermissionCard(tall, vi.fn());
    const lines = draw(card, 60, 14);
    expect(lines).toHaveLength(14);
    expect(lines.some((line) => /lines 1–\d+ of \d+/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes('Deny with feedback'))).toBe(true);
    expect(card.scroll!(3)).toBe(true);
    expect(draw(card, 60, 14).some((line) => /lines 4–/.test(line))).toBe(true);
  });
});

describe('QuestionCard', () => {
  const question = {
    requestId: 'q1',
    questions: [
      {
        question: 'The table snapshot changed because the branch name now has a prefix. Update it?',
        header: 'Snapshot',
        options: [
          { label: 'Update the snapshot' },
          { label: 'Keep the old name', description: 'revert the prefix' },
        ],
      },
    ],
  };

  it.each([100, 60])('wraps the question and numbers the options at %i columns', (width) => {
    const lines = draw(new QuestionCard(question, vi.fn()), width);
    expect(lines[0]).toMatch(
      /^┌─ question · Snapshot ─+ 1-3 or ↑↓ enter · type to answer · esc skip ─┐$|^┌─ question · Snapshot ─+ /,
    );
    expect(lines.some((line) => line.includes('› 1. Update the snapshot'))).toBe(true);
    expect(lines.some((line) => line.includes('2. Keep the old name  revert the prefix'))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('3. Type an answer…'))).toBe(true);
  });

  it('is answered by number', () => {
    const onResolve = vi.fn<(resolution: QuestionResolution) => void>();
    burst(new QuestionCard(question, onResolve), '2');
    expect(onResolve.mock.calls[0]![0]).toMatchObject({
      status: 'answered',
      answers: [{ answer: 'Keep the old name', custom: false }],
    });
  });

  it('is answered by typing', () => {
    const onResolve = vi.fn<(resolution: QuestionResolution) => void>();
    burst(new QuestionCard(question, onResolve), 'neither, rename it\r');
    expect(onResolve.mock.calls[0]![0]).toMatchObject({
      answers: [{ answer: 'neither, rename it', custom: true }],
    });
  });

  it('picks the option the keys moved to when Down and Enter come in one burst', () => {
    const onResolve = vi.fn<(resolution: QuestionResolution) => void>();
    burst(new QuestionCard(question, onResolve), '\x1b[B\r');
    expect(onResolve.mock.calls[0]![0]).toMatchObject({
      answers: [{ answer: 'Keep the old name' }],
    });
  });

  it('asks a set one at a time, showing where it is', () => {
    const set = {
      requestId: 'q2',
      questions: [question.questions[0]!, { ...question.questions[0]!, header: 'Second' }],
    };
    const onResolve = vi.fn<(resolution: QuestionResolution) => void>();
    const card = new QuestionCard(set, onResolve);
    expect(draw(card, 100)[0]).toContain('question · Snapshot · 1 of 2');
    burst(card, '1');
    expect(draw(card, 100)[0]).toContain('question · Second · 2 of 2');
    burst(card, '2');
    expect(onResolve.mock.calls[0]![0]).toMatchObject({
      answers: [{ answer: 'Update the snapshot' }, { answer: 'Keep the old name' }],
    });
  });
});

describe('SudoCard', () => {
  it.each([100, 60])('masks the password at %i columns, and hands it over as bytes', (width) => {
    const onSubmit = vi.fn<(password: Uint8Array) => void>();
    const card = new SudoCard(() => ({ status: 'password' }), onSubmit, vi.fn());
    burst(card, 'hunter2');
    expect(draw(card, width).some((line) => line.includes('password › •••••••'))).toBe(true);
    burst(card, '\r');
    expect(new TextDecoder().decode(onSubmit.mock.calls[0]![0])).toBe('hunter2');
  });
});

describe('HelpCard', () => {
  it.each([100, 60])('lists the keys of the new TUI at %i columns', (width) => {
    const lines = draw(new HelpCard(true, vi.fn()), width);
    expect(lines[0]).toContain('keys');
    expect(lines.some((line) => line.includes('Ctrl+O'))).toBe(true);
    expect(lines.some((line) => line.includes('Ctrl+F'))).toBe(true);
    expect(lines.some((line) => line.includes('Ctrl+B'))).toBe(false);
  });

  it('leaves out the fullscreen-only keys in the inline layout', () => {
    expect(helpBindings(false).map(([keys]) => keys)).not.toContain('Ctrl+F');
  });
});

describe('menu cards', () => {
  it.each([100, 60])('draws the slash menu with the highlight at %i columns', (width) => {
    const items = slashMenuItems('/re', { overlay: false }).map((item) => ({
      label: `/${item.name}`,
      detail: item.description,
    }));
    const lines = renderMenuCard('commands', items, 1, width, 20, style).map(stripAnsi);
    for (const line of lines) expect(displayWidth(line)).toBe(width);
    expect(lines[0]).toMatch(/^┌─ commands /);
    expect(lines[2]!.startsWith(`│ › ${items[1]!.label}`)).toBe(true);
    expect(lines[1]!.startsWith(`│   ${items[0]!.label}`)).toBe(true);
  });

  it('filters from the prompt text as today, with commands and skills after the built-ins', () => {
    const sources = {
      overlay: false,
      commands: { list: () => [{ name: 'review', description: 'review the branch' }] },
      skills: {
        all: () => [
          { name: 'research', description: 'look things up' },
          { name: 'review', description: 'shadowed' },
        ],
      },
    } as unknown as Parameters<typeof slashMenuItems>[1];
    const items = slashMenuItems('/re', sources);
    expect(
      items.filter((item) => item.kind !== 'builtin').map((item) => `${item.kind}:${item.name}`),
    ).toEqual(['user:review', 'skill:research']);
    expect(items[0]!.kind).toBe('builtin');
    expect(slashMenuItems('/re view', sources)).toEqual([]);
    expect(completeSlashPrefix('/rev', sources)).toBe('/review');
  });
});

describe('picker cards', () => {
  const session = (id: string, createdAt: number): SessionInfo =>
    ({
      id,
      parentId: null,
      children: [],
      cwd: `/work/${id}`,
      createdAt,
      messageCount: 3,
    }) as unknown as SessionInfo;

  it.each([100, 60])('switches session with j and Enter at %i columns', (width) => {
    const onSelect = vi.fn();
    const card = new SessionPickerCard(
      [
        { info: session('session-aaaaaaaa', 2), prefix: '' },
        { info: session('session-bbbbbbbb', 1), prefix: '' },
      ],
      'session-aaaaaaaa',
      onSelect,
      vi.fn(),
    );
    const lines = draw(card, width);
    expect(lines[1]).toContain('› aaaaaaaa');
    burst(card, 'j\r');
    expect(onSelect).toHaveBeenCalledWith('session-bbbbbbbb');
  });

  it.each([100, 60])('rewinds with Enter and forks with Shift+Enter at %i columns', (width) => {
    const checkpoints = [
      { index: 0, userMessage: 'first message' },
      { index: 1, userMessage: 'second message', toolCallSummary: '2 edits' },
    ] as Checkpoint[];
    const onRewind = vi.fn();
    const onFork = vi.fn();
    const card = new RewindPickerCard(checkpoints, onRewind, onFork, vi.fn());
    expect(draw(card, width).some((line) => line.includes('second message · 2 edits'))).toBe(true);
    burst(card, '\x1b[B\x1b[13;2u');
    expect(onFork).toHaveBeenCalledWith(checkpoints[1]);
    burst(card, '\r');
    expect(onRewind).toHaveBeenCalledWith(checkpoints[1]);
  });

  it.each([100, 60])('applies the ticked overlay changes at %i columns', (width) => {
    const onResolve = vi.fn();
    const card = new OverlayPickerCard(
      [
        { kind: 'modified', path: 'a.ts' },
        { kind: 'added', path: 'b.ts' },
      ],
      onResolve,
    );
    expect(draw(card, width).filter((line) => line.includes('[x]'))).toHaveLength(2);
    burst(card, ' \r');
    expect(onResolve).toHaveBeenCalledWith({ paths: ['b.ts'] });
  });
});

describe('a multi-line command in the permission card', () => {
  const multiLine: PendingPermission = {
    requestId: 'r2',
    command: Array.from({ length: 20 }, (_, i) => `echo step ${i + 1} of 20;`).join('\n'),
  };

  it('keeps the pattern row on one line, with the end of the pattern in view', () => {
    const card = new PermissionCard(multiLine, vi.fn());
    burst(card, 'g!');
    const lines = draw(card, 60);
    expect(lines.at(-1)).toMatch(/^└─+┘$/);
    const row = lines.find((line) => line.includes('pattern ›'))!;
    expect(row).toContain('echo step 20 of 20;!');
    expect(row).toContain('↵');
  });

  it('keeps the remember row on one line', () => {
    const card = new PermissionCard(multiLine, vi.fn());
    burst(card, 'A');
    const lines = draw(card, 60);
    expect(lines.at(-1)).toMatch(/^└─+┘$/);
    expect(lines.filter((line) => line.includes('echo step 2 of 20')).length).toBeLessThanOrEqual(
      2,
    );
  });
});
