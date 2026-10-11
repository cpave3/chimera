import { Box } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { ExploreEntry, ToolEntry } from '../src/scrollback';
import { defaultTheme } from '../src/theme/tokens';
import { renderEntryLines } from '../src/transcript';

function member(toolName: string, text: string): ToolEntry {
  return { id: `m-${text}`, kind: 'tool', toolName, toolTarget: 'host', text, toolResult: {} };
}

function frame(entry: ExploreEntry, columns = 80): string {
  const { lastFrame, unmount } = render(
    <Box flexDirection="column">{renderEntryLines(entry, columns, defaultTheme)}</Box>,
  );
  const out = lastFrame() ?? '';
  unmount();
  return out;
}

describe('exploration group line', () => {
  it('states what was explored and lists the targets', () => {
    const group: ExploreEntry = {
      id: 'g1',
      kind: 'explore',
      text: 'read 2 files · 1 search',
      members: [member('read', 'src/a.ts'), member('read', 'src/b.ts'), member('grep', 'TODO')],
    };
    const out = frame(group);

    expect(out).toContain('○ read 2 files · 1 search');
    expect(frame({ ...group, closed: true })).toContain('● read 2 files · 1 search');
    expect(out).toContain('src/a.ts, src/b.ts, TODO');
  });

  it('cuts a long target list to the terminal width', () => {
    const members = Array.from({ length: 30 }, (_, i) => member('read', `src/module-${i}.ts`));
    const out = frame({ id: 'g1', kind: 'explore', text: 'read 30 files', members }, 60);

    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    expect(out).toContain('…');
  });

  it('shows a group of one as the plain tool line', () => {
    const out = frame({
      id: 'g1',
      kind: 'explore',
      text: 'read 1 file',
      members: [member('read', 'src/a.ts (87 lines)')],
    });

    expect(out).toContain('● read src/a.ts (87 lines)');
    expect(out).not.toContain('explored');
  });
});
