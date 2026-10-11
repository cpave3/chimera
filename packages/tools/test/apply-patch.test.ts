import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from '../src/build';
import { LocalExecutor } from '../src/local-executor';

type PatchTool = { execute: (args: { input: string }, opts?: unknown) => Promise<any> };

describe('apply_patch', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-apply-patch-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function patchTools() {
    const executor = new LocalExecutor({ cwd: root });
    return buildTools({
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
      editFormat: 'patch',
    });
  }

  function applyPatch(lines: string[]) {
    const tool = patchTools().tools.apply_patch as unknown as PatchTool;
    return tool.execute({ input: lines.join('\n') }, {});
  }

  const exists = (path: string) =>
    stat(join(root, path)).then(
      () => true,
      () => false,
    );

  it('replaces edit when the edit format is patch', () => {
    const names = Object.keys(patchTools().tools);
    expect(names).toContain('apply_patch');
    expect(names).not.toContain('edit');
    expect(names).toContain('write');
  });

  it('updates a file from one hunk', async () => {
    await writeFile(join(root, 'greet.ts'), 'export function greet() {\n  return "hi";\n}\n');

    const result = await applyPatch([
      '*** Begin Patch',
      '*** Update File: greet.ts',
      '@@',
      ' export function greet() {',
      '-  return "hi";',
      '+  return "hello";',
      ' }',
      '*** End Patch',
    ]);

    expect(await readFile(join(root, 'greet.ts'), 'utf8')).toBe(
      'export function greet() {\n  return "hello";\n}\n',
    );
    expect(result.files).toEqual([
      { path: 'greet.ts', operation: 'updated', additions: 1, deletions: 1 },
    ]);
  });

  it('adds, deletes and moves files in one patch', async () => {
    await writeFile(join(root, 'old.txt'), 'remove me\n');
    await writeFile(join(root, 'name.ts'), 'export const name = "a";\n');

    const result = await applyPatch([
      '*** Begin Patch',
      '*** Add File: docs/new.md',
      '+# Title',
      '+',
      '+Body.',
      '*** Delete File: old.txt',
      '*** Update File: name.ts',
      '*** Move to: src/name.ts',
      '@@',
      '-export const name = "a";',
      '+export const name = "b";',
      '*** End Patch',
    ]);

    expect(await readFile(join(root, 'docs/new.md'), 'utf8')).toBe('# Title\n\nBody.\n');
    expect(await exists('old.txt')).toBe(false);
    expect(await exists('name.ts')).toBe(false);
    expect(await readFile(join(root, 'src/name.ts'), 'utf8')).toBe('export const name = "b";\n');
    expect(result.files.map((file: { operation: string }) => file.operation)).toEqual([
      'added',
      'deleted',
      'moved',
    ]);
  });

  it('changes nothing when a later hunk does not match', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await writeFile(join(root, 'b.ts'), 'const b = 2;\n');

    await expect(
      applyPatch([
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@',
        '-const a = 1;',
        '+const a = 10;',
        '*** Update File: b.ts',
        '@@',
        '-const b = 999;',
        '+const b = 20;',
        '*** End Patch',
      ]),
    ).rejects.toThrow(/b\.ts: these lines were not found[\s\S]*const b = 999;/);

    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1;\n');
  });

  it('refuses a patch that targets a path outside the working directory', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');

    await expect(
      applyPatch([
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@',
        '-const a = 1;',
        '+const a = 10;',
        '*** Add File: ../escaped.txt',
        '+nope',
        '*** End Patch',
      ]),
    ).rejects.toThrow();

    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1;\n');
  });

  it('restores earlier files when a later write is refused', async () => {
    const readOnly = await mkdtemp(join(tmpdir(), 'chimera-apply-patch-ro-'));
    try {
      await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
      const executor = new LocalExecutor({ cwd: root, readAllowDirs: [readOnly] });
      const tool = buildTools({
        sandboxExecutor: executor,
        hostExecutor: executor,
        sandboxMode: 'off',
        editFormat: 'patch',
      }).tools.apply_patch as unknown as PatchTool;

      await expect(
        tool.execute(
          {
            input: [
              '*** Begin Patch',
              '*** Update File: a.ts',
              '@@',
              '-const a = 1;',
              '+const a = 10;',
              `*** Add File: ${join(readOnly, 'new.txt')}`,
              '+nope',
              '*** End Patch',
            ].join('\n'),
          },
          {},
        ),
      ).rejects.toThrow(/No file was changed/);

      expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1;\n');
    } finally {
      await rm(readOnly, { recursive: true, force: true });
    }
  });

  it('matches context that differs only in whitespace and says so', async () => {
    await writeFile(join(root, 'indent.py'), 'def run():\n\tvalue = 1   \n\treturn value\n');

    const result = await applyPatch([
      '*** Begin Patch',
      '*** Update File: indent.py',
      '@@',
      ' def run():',
      '-    value = 1',
      '+    value = 2',
      '     return value',
      '*** End Patch',
    ]);

    // The untouched context line keeps the file's own indentation.
    expect(await readFile(join(root, 'indent.py'), 'utf8')).toBe(
      'def run():\n    value = 2\n\treturn value\n',
    );
    expect(result.files[0].matched).toBe('any-whitespace');
  });

  describe('repeated context', () => {
    const source = [
      'function first() {',
      '  return compute();',
      '}',
      '',
      'function second() {',
      '  return compute();',
      '}',
      '',
    ].join('\n');

    it('refuses a hunk that could apply in more than one place', async () => {
      await writeFile(join(root, 'twice.ts'), source);

      await expect(
        applyPatch([
          '*** Begin Patch',
          '*** Update File: twice.ts',
          '@@',
          '-  return compute();',
          '+  return compute(1);',
          '*** End Patch',
        ]),
      ).rejects.toThrow(/match 2 places \(lines 2, 6\)/);

      expect(await readFile(join(root, 'twice.ts'), 'utf8')).toBe(source);
    });

    it('uses the line after @@ to pick the place', async () => {
      await writeFile(join(root, 'twice.ts'), source);

      await applyPatch([
        '*** Begin Patch',
        '*** Update File: twice.ts',
        '@@ function second() {',
        '-  return compute();',
        '+  return compute(2);',
        '*** End Patch',
      ]);

      expect(await readFile(join(root, 'twice.ts'), 'utf8')).toBe(
        source.replace('second() {\n  return compute();', 'second() {\n  return compute(2);'),
      );
    });
  });

  it('refuses a patch that was cut off before its end marker', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');

    await expect(
      applyPatch(['*** Begin Patch', '*** Update File: a.ts', '@@', '-const a = 1;', '+const a ']),
    ).rejects.toThrow(/cut off/);

    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1;\n');
  });

  it('accepts a patch wrapped in a markdown fence', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');

    await applyPatch([
      '```',
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-const a = 1;',
      '+const a = 2;',
      '*** End Patch',
      '```',
    ]);

    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 2;\n');
  });

  it('appends at the end of the file for a hunk that only adds lines', async () => {
    await writeFile(join(root, 'list.txt'), 'one\ntwo\n');

    await applyPatch([
      '*** Begin Patch',
      '*** Update File: list.txt',
      '@@',
      '+three',
      '*** End Patch',
    ]);

    expect(await readFile(join(root, 'list.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('summarizes the change for the scrollback', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    const built = patchTools();
    const input = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-const a = 1;',
      '+const a = 2;',
      '+const b = 3;',
      '*** End Patch',
    ].join('\n');

    const result = await (built.tools.apply_patch as unknown as PatchTool).execute({ input }, {});

    expect(built.formatters.apply_patch?.({ input })).toEqual({ summary: 'a.ts' });
    expect(built.formatters.apply_patch?.({ input }, result)).toEqual({ summary: 'a.ts (+2 −1)' });
  });
});
