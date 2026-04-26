import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from '../src/build';
import { LocalExecutor } from '../src/local-executor';

describe('buildTools formatters', () => {
  let root: string;
  let executor: LocalExecutor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-fmt-'));
    executor = new LocalExecutor({ cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fmts() {
    return buildTools({
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
    }).formatters;
  }

  describe('write', () => {
    it('summarizes by relative path', () => {
      const f = fmts().write!;
      expect(f({ path: join(root, 'next.config.ts'), content: '...' })).toEqual({
        summary: 'next.config.ts',
      });
    });

    it('appends "(created, N bytes)" when the result reports created=true', () => {
      const f = fmts().write!;
      expect(
        f({ path: join(root, 'new.txt'), content: 'hello' }, { bytes_written: 5, created: true })
          .summary,
      ).toBe('new.txt (created, 5 bytes)');
    });

    it('appends "(N bytes)" without "created" when overwriting', () => {
      const f = fmts().write!;
      expect(
        f(
          { path: join(root, 'existing.txt'), content: 'hello' },
          { bytes_written: 5, created: false },
        ).summary,
      ).toBe('existing.txt (5 bytes)');
    });
  });

  describe('edit', () => {
    it('summarizes by relative path', () => {
      const f = fmts().edit!;
      expect(f({ path: join(root, 'src/foo.ts'), old_string: 'a', new_string: 'b' })).toEqual({
        summary: 'src/foo.ts',
      });
    });

    it('appends "(N replacements)" when result is known', () => {
      const f = fmts().edit!;
      expect(
        f({ path: join(root, 'src/foo.ts'), old_string: 'a', new_string: 'b' }, { replacements: 3 })
          .summary,
      ).toBe('src/foo.ts (3 replacements)');
    });

    it('uses the singular form for a single replacement', () => {
      const f = fmts().edit!;
      expect(
        f({ path: join(root, 'src/foo.ts'), old_string: 'a', new_string: 'b' }, { replacements: 1 })
          .summary,
      ).toBe('src/foo.ts (1 replacement)');
    });
  });

  describe('bash', () => {
    it('summarizes by the command itself, stripping leading cd', () => {
      const f = fmts().bash!;
      expect(f({ command: 'cd /work && pnpm build' })).toEqual({
        summary: 'pnpm build',
      });
    });

    it('clips long commands with an ellipsis', () => {
      const f = fmts().bash!;
      const long = 'echo ' + 'x'.repeat(200);
      expect(f({ command: long }).summary.length).toBeLessThanOrEqual(61);
      expect(f({ command: long }).summary.endsWith('…')).toBe(true);
    });

    it('appends "(exit N, Ms)" when the result is known', () => {
      const f = fmts().bash!;
      expect(
        f({ command: 'pnpm build' }, { stdout: '', stderr: '', exit_code: 0, timed_out: false })
          .summary,
      ).toBe('pnpm build (exit 0)');
    });

    it('flags non-zero exit codes', () => {
      const f = fmts().bash!;
      expect(
        f({ command: 'pnpm build' }, { stdout: '', stderr: '', exit_code: 2, timed_out: false })
          .summary,
      ).toBe('pnpm build (exit 2)');
    });

    it('flags timeouts', () => {
      const f = fmts().bash!;
      expect(
        f({ command: 'sleep 999' }, { stdout: '', stderr: '', exit_code: -1, timed_out: true })
          .summary,
      ).toBe('sleep 999 (timed out)');
    });
  });

  describe('read', () => {
    it('summarizes a path inside cwd as a relative path', () => {
      const f = fmts().read!;
      expect(f({ path: join(root, 'src/foo.ts') })).toEqual({
        summary: 'src/foo.ts',
      });
    });

    it('appends a line range when start_line is given', () => {
      const f = fmts().read!;
      expect(f({ path: join(root, 'src/foo.ts'), start_line: 12, end_line: 40 })).toEqual({
        summary: 'src/foo.ts:12-40',
      });
    });

    it('appends "(N lines)" once the result is known', () => {
      const f = fmts().read!;
      const out = f(
        { path: join(root, 'src/foo.ts') },
        { content: '...', total_lines: 87, truncated: false },
      );
      expect(out.summary).toBe('src/foo.ts (87 lines)');
    });

    it('marks truncated reads', () => {
      const f = fmts().read!;
      const out = f(
        { path: join(root, 'huge.txt') },
        { content: '...', total_lines: 5000, truncated: true },
      );
      expect(out.summary).toBe('huge.txt (5000 lines, truncated)');
    });
  });
});
