import { describe, expect, it } from 'vitest';
import type { ScrollbackEntry, ToolEntry } from '../src/scrollback';
import { formatTranscript } from '../src/transcript-text';

function tool(toolName: string, text: string, extra: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: `t-${text}`,
    kind: 'tool',
    toolName,
    toolTarget: 'host',
    text,
    toolResult: {},
    ...extra,
  };
}

const plain = (entries: ScrollbackEntry[]) => formatTranscript(entries, { color: false });

describe('formatTranscript', () => {
  it('lists every call of an exploration group on its own line', () => {
    const text = plain([
      {
        id: 'g1',
        kind: 'explore',
        text: 'read 2 files · 1 search',
        members: [tool('read', 'src/a.ts'), tool('read', 'src/b.ts'), tool('grep', 'TODO')],
      },
    ]);

    expect(text).toContain('• read: src/a.ts');
    expect(text).toContain('• read: src/b.ts');
    expect(text).toContain('• grep: TODO');
    expect(text).not.toContain('explored');
  });

  it('prints the whole output of a command, not a preview', () => {
    const stdout = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
    const text = plain([
      tool('bash', 'pnpm test (exit 1)', {
        toolResult: { stdout, stderr: 'one test failed', exit_code: 1, timed_out: false },
      }),
    ]);

    expect(text).toContain('• bash: pnpm test (exit 1)');
    expect(text).toContain('    line 1\n');
    expect(text).toContain('    line 300');
    expect(text).toContain('    one test failed');
  });

  it('shows what an edit removed and added', () => {
    const text = plain([
      tool('edit', 'src/a.ts (1 replacement)', {
        toolArgs: { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
        toolResult: { replacements: 1 },
      }),
    ]);

    expect(text).toContain('    - const a = 1;');
    expect(text).toContain('    + const a = 2;');
  });

  it('prints the file a read returned and the matches a search found', () => {
    const text = plain([
      tool('read', 'notes.md', { toolResult: { kind: 'file', content: '1: # Notes\n2: body' } }),
      tool('grep', 'TODO', {
        toolResult: { mode: 'content', matches: [{ file: 'a.ts', line: 3, text: '// TODO fix' }] },
      }),
    ]);

    expect(text).toContain('    1: # Notes');
    expect(text).toContain('    a.ts:3: // TODO fix');
  });

  it('keeps the conversation in order with the markers of the live transcript', () => {
    const text = plain([
      { id: 'u1', kind: 'user', text: 'fix the test' },
      { id: 'a1', kind: 'assistant', text: 'I will run it first.' },
      tool('bash', 'pnpm test (exit 0)', {
        toolResult: { stdout: 'ok', stderr: '', exit_code: 0 },
      }),
      { id: 'i1', kind: 'info', text: 'compaction done' },
      tool('read', 'missing.ts', { toolResult: undefined, toolError: 'ENOENT' }),
    ]);

    const order = [
      '› fix the test',
      'I will run it first.',
      '• bash: pnpm test',
      'compaction done',
      'error: ENOENT',
    ];
    const positions = order.map((needle) => text.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('adds colour codes only when asked', () => {
    const entries: ScrollbackEntry[] = [{ id: 'u1', kind: 'user', text: 'hi' }];
    expect(plain(entries)).not.toContain('\x1b[');
    expect(formatTranscript(entries, { color: true })).toContain('\x1b[1m');
  });
});
