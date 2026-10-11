import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from '../src/build';
import { LocalExecutor } from '../src/local-executor';

type EditArgs = { path: string; old_string: string; new_string: string; replace_all?: boolean };
type EditTool = { execute: (args: EditArgs, opts?: unknown) => Promise<any> };

describe('edit with imperfect old_string', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-edit-tolerant-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function edit(args: EditArgs) {
    const executor = new LocalExecutor({ cwd: root });
    const tools = buildTools({
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
    });
    return (tools.tools.edit as unknown as EditTool).execute(args, {});
  }

  const fileText = (name: string) => readFile(join(root, name), 'utf8');

  it('matches a block that differs only in trailing whitespace', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;   \nconst b = 2;\t\nconst c = 3;\n');

    const result = await edit({
      path: 'a.ts',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 10;\nconst b = 20;',
    });

    expect(await fileText('a.ts')).toBe('const a = 10;\nconst b = 20;\nconst c = 3;\n');
    expect(result).toMatchObject({ replacements: 1, matched: 'trailing-whitespace', startLine: 1 });
  });

  it('matches a block with the wrong indentation and re-indents the replacement', async () => {
    await writeFile(
      join(root, 'nest.py'),
      'class A:\n    def run(self):\n        value = 1\n        return value\n',
    );

    const result = await edit({
      path: 'nest.py',
      old_string: '  value = 1\n  return value',
      new_string: '  value = 2\n  if value:\n    return value',
    });

    expect(await fileText('nest.py')).toBe(
      'class A:\n    def run(self):\n        value = 2\n        if value:\n          return value\n',
    );
    expect(result).toMatchObject({ replacements: 1, matched: 'any-whitespace', startLine: 3 });
  });

  it('keeps tabs when the file is indented with tabs', async () => {
    await writeFile(join(root, 'tabs.go'), 'func run() {\n\tvalue := 1\n\treturn\n}\n');

    await edit({
      path: 'tabs.go',
      old_string: '    value := 1',
      new_string: '    value := 2',
    });

    expect(await fileText('tabs.go')).toBe('func run() {\n\tvalue := 2\n\treturn\n}\n');
  });

  it('removes whole lines when the replacement is empty', async () => {
    await writeFile(join(root, 'list.txt'), 'one\n  two  \nthree\n');

    await edit({ path: 'list.txt', old_string: '\ttwo', new_string: '' });

    expect(await fileText('list.txt')).toBe('one\nthree\n');
  });

  it('prefers the exact match and reports no level for it', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');

    const result = await edit({ path: 'a.ts', old_string: 'a = 1', new_string: 'a = 2' });

    expect(await fileText('a.ts')).toBe('const a = 2;\n');
    expect(result.matched).toBeUndefined();
  });

  it('refuses a tolerant match that fits more than one place', async () => {
    const source = 'if (a) {\n  done();\n}\nif (b) {\n    done();\n}\n';
    await writeFile(join(root, 'twice.ts'), source);

    await expect(
      edit({ path: 'twice.ts', old_string: 'done();  ', new_string: 'finish();' }),
    ).rejects.toThrow(/matches 2 places once whitespace is ignored \(lines 2, 5\)/);

    expect(await fileText('twice.ts')).toBe(source);
  });

  it('shows the closest block when nothing matches', async () => {
    await writeFile(
      join(root, 'calc.ts'),
      'export function total(items: number[]) {\n  return items.reduce((sum, item) => sum + item, 0);\n}\n',
    );

    await expect(
      edit({
        path: 'calc.ts',
        old_string: '  return items.reduce((acc, item) => acc + item, 0);',
        new_string: '  return 0;',
      }),
    ).rejects.toThrow(
      /closest text in the file is at lines 2-2:\n2: {3}return items\.reduce\(\(sum, item\) => sum \+ item, 0\);/,
    );
  });

  it('says so when nothing in the file resembles old_string', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');

    await expect(
      edit({ path: 'a.ts', old_string: 'SELECT * FROM users WHERE id = ?', new_string: 'x' }),
    ).rejects.toThrow(/Nothing in the file resembles it/);
  });

  it('does not apply tolerant matching to replace_all', async () => {
    await writeFile(join(root, 'a.ts'), '  const a = 1;\n');

    await expect(
      edit({ path: 'a.ts', old_string: 'const a = 1;  ', new_string: 'x', replace_all: true }),
    ).rejects.toThrow(/old_string not found/);
  });
});
