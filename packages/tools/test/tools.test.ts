import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from '../src/build';
import { LocalExecutor } from '../src/local-executor';

/** Minimal valid 1x1 PNG (67 bytes). */
const MINI_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc00000000300010005f8d24f0000000049454e44ae426082',
  'hex',
);

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };

describe('buildTools', () => {
  let root: string;
  let executor: LocalExecutor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-tools-'));
    executor = new LocalExecutor({ cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function tools() {
    return buildTools({
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
    }).tools as unknown as Record<string, AnyTool>;
  }

  it('returns the full default tool set', () => {
    const toolset = tools();
    expect(Object.keys(toolset).sort()).toEqual([
      'bash',
      'edit',
      'fetch',
      'glob',
      'grep',
      'read',
      'write',
    ]);
  });

  it('bash runs the command and returns stdout', async () => {
    const toolset = tools();
    const result = await toolset.bash!.execute({ command: 'echo hi' }, {});
    expect(result.stdout).toContain('hi');
    expect(result.exit_code).toBe(0);
  });

  it('bash refuses destructive patterns without running them', async () => {
    const toolset = tools();
    const result = await toolset.bash!.execute({ command: 'rm -rf /' }, {});
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toMatch(/destructive/i);
  });

  it('read returns line-number-prefixed content and total_lines', async () => {
    await writeFile(join(root, 'f.txt'), 'alpha\nbeta\ngamma\n');
    const toolset = tools();
    const result = await toolset.read!.execute({ path: 'f.txt' }, {});
    expect(result.kind).toBe('file');
    expect(result.total_lines).toBe(3);
    expect(result.content.split('\n')).toEqual(['1\talpha', '2\tbeta', '3\tgamma']);
    expect(result.truncated).toBe(false);
  });

  it('read on a directory returns sorted entries instead of erroring', async () => {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'a.txt'), 'x');
    await writeFile(join(root, 'b.txt'), 'x');
    const toolset = tools();
    const result = await toolset.read!.execute({ path: '.' }, {});
    expect(result.kind).toBe('directory');
    expect(result.entries).toEqual([
      { name: 'a.txt', isDir: false },
      { name: 'b.txt', isDir: false },
      { name: 'sub', isDir: true },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('read honors start_line and end_line', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(join(root, 'big.txt'), lines);
    const toolset = tools();
    const result = await toolset.read!.execute({ path: 'big.txt', start_line: 5, end_line: 7 }, {});
    expect(result.content.split('\n')).toEqual(['5\tline5', '6\tline6', '7\tline7']);
  });

  it('read truncates past 2000 lines', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n');
    await writeFile(join(root, 'huge.txt'), lines);
    const toolset = tools();
    const result = await toolset.read!.execute({ path: 'huge.txt' }, {});
    expect(result.total_lines).toBe(2500);
    expect(result.truncated).toBe(true);
  });

  it('read returns a base64 data URI for PNG files', async () => {
    await writeFile(join(root, 'test.png'), MINI_PNG);
    const toolset = tools();
    const result = await toolset.read!.execute({ path: 'test.png' }, {});
    expect(result.kind).toBe('image');
    expect(result.mime).toBe('image/png');
    expect(result.data).toMatch(/^data:image\/png;base64,/);
  });

  it('read returns a base64 data URI for JPEG files', async () => {
    await writeFile(join(root, 'test.jpg'), MINI_PNG);
    const toolset = tools();
    const result = await toolset.read!.execute({ path: 'test.jpg' }, {});
    expect(result.kind).toBe('image');
    expect(result.mime).toBe('image/jpeg');
    expect(result.data).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('read returns file content for non-image files even with image-like names', async () => {
    await writeFile(join(root, 'fake.png'), 'not an image');
    const toolset = tools();
    const result = await toolset.read!.execute({ path: 'fake.png' }, {});
    expect(result.kind).toBe('image');
    expect(result.mime).toBe('image/png');
    expect(result.data).toMatch(/^data:image\/png;base64,/);
  });

  it('write creates files and reports bytes', async () => {
    const toolset = tools();
    const result = await toolset.write!.execute({ path: 'new.txt', content: 'hello' }, {});
    expect(result.created).toBe(true);
    expect(result.bytes_written).toBe(5);
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('hello');
  });

  it('write reports created=false when overwriting', async () => {
    await writeFile(join(root, 'e.txt'), 'old');
    const toolset = tools();
    const result = await toolset.write!.execute({ path: 'e.txt', content: 'new' }, {});
    expect(result.created).toBe(false);
  });

  it('edit succeeds on a unique match', async () => {
    await writeFile(join(root, 'f.txt'), 'hello world');
    const toolset = tools();
    const result = await toolset.edit!.execute(
      { path: 'f.txt', old_string: 'world', new_string: 'chimera' },
      {},
    );
    expect(result.replacements).toBe(1);
    expect(result.startLine).toBe(1);
    expect(result.contextBefore).toEqual([]);
    expect(result.contextAfter).toEqual([]);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('hello chimera');
  });

  it('edit throws on not-found', async () => {
    await writeFile(join(root, 'f.txt'), 'abc');
    const toolset = tools();
    await expect(
      toolset.edit!.execute({ path: 'f.txt', old_string: 'xyz', new_string: 'foo' }, {}),
    ).rejects.toThrow(/not found/);
  });

  it('edit throws on ambiguous match unless replace_all', async () => {
    await writeFile(join(root, 'f.txt'), 'a\na\na');
    const toolset = tools();
    await expect(
      toolset.edit!.execute({ path: 'f.txt', old_string: 'a', new_string: 'b' }, {}),
    ).rejects.toThrow(/3 occurrences/);
    const result = await toolset.edit!.execute(
      { path: 'f.txt', old_string: 'a', new_string: 'b', replace_all: true },
      {},
    );
    expect(result.replacements).toBe(3);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('b\nb\nb');
  });

  it('edit captures three context lines on each side of a middle-of-file match', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    await writeFile(join(root, 'big.txt'), lines.join('\n'));
    const toolset = tools();
    const result = await toolset.edit!.execute(
      { path: 'big.txt', old_string: 'line10', new_string: 'line10-edited' },
      {},
    );
    expect(result.replacements).toBe(1);
    expect(result.startLine).toBe(10);
    expect(result.contextBefore).toEqual(['line7', 'line8', 'line9']);
    expect(result.contextAfter).toEqual(['line11', 'line12', 'line13']);
  });

  it('edit returns empty contextBefore for a match on line 1', async () => {
    await writeFile(join(root, 'top.txt'), 'first\nsecond\nthird\nfourth\nfifth');
    const toolset = tools();
    const result = await toolset.edit!.execute(
      { path: 'top.txt', old_string: 'first', new_string: 'FIRST' },
      {},
    );
    expect(result.startLine).toBe(1);
    expect(result.contextBefore).toEqual([]);
    expect(result.contextAfter).toEqual(['second', 'third', 'fourth']);
  });

  it('edit returns empty contextAfter for a match ending on the final line', async () => {
    await writeFile(join(root, 'bot.txt'), 'first\nsecond\nthird\nfourth\nfifth');
    const toolset = tools();
    const result = await toolset.edit!.execute(
      { path: 'bot.txt', old_string: 'fifth', new_string: 'FIFTH' },
      {},
    );
    expect(result.startLine).toBe(5);
    expect(result.contextBefore).toEqual(['second', 'third', 'fourth']);
    expect(result.contextAfter).toEqual([]);
  });

  it('edit captures contextAfter when new_string ends with a newline', async () => {
    await writeFile(join(root, 'nl.txt'), 'a\nb\nc\nd\ne\n');
    const toolset = tools();
    const result = await toolset.edit!.execute(
      { path: 'nl.txt', old_string: 'b\n', new_string: 'B\n' },
      {},
    );
    expect(result.contextAfter).toEqual(['c', 'd', 'e']);
  });

  it('edit treats $-sequences in new_string literally (regression: shell regex anchors)', async () => {
    // Regression for a doubling bug where String.prototype.replace expanded $'
    // (and $&, $`, $$) in the replacement, even with a string search argument.
    // A new_string containing a shell regex pattern like '^name$' has the
    // literal characters $' and would silently inline "everything after the
    // matched span" into the file.
    const head = 'HEAD\n';
    const matched = 'PATTERN: ^name$\n';
    const tail = 'TAIL_LINE_1\nTAIL_LINE_2\n';
    await writeFile(join(root, 'regex.txt'), head + matched + tail);
    const toolset = tools();
    const replacement = "PATTERN: '^name$'\nNEW_LINE\n";
    const result = await toolset.edit!.execute(
      { path: 'regex.txt', old_string: matched, new_string: replacement },
      {},
    );
    expect(result.replacements).toBe(1);
    expect(await readFile(join(root, 'regex.txt'), 'utf8')).toBe(head + replacement + tail);
  });

  it("edit preserves $&, $`, $', $$ in new_string verbatim", async () => {
    await writeFile(join(root, 'sigils.txt'), 'A\nMATCH\nB\n');
    const toolset = tools();
    const replacement = "lit-$&-and-$`-and-$'-and-$$";
    const result = await toolset.edit!.execute(
      { path: 'sigils.txt', old_string: 'MATCH', new_string: replacement },
      {},
    );
    expect(result.replacements).toBe(1);
    expect(await readFile(join(root, 'sigils.txt'), 'utf8')).toBe(`A\n${replacement}\nB\n`);
  });

  it('edit with replace_all reports the line of the first match', async () => {
    await writeFile(
      join(root, 'multi.txt'),
      'one\ntwo\nthree\nNEEDLE\nfive\nsix\nNEEDLE\neight\nnine\nNEEDLE\n',
    );
    const toolset = tools();
    const result = await toolset.edit!.execute(
      { path: 'multi.txt', old_string: 'NEEDLE', new_string: 'X', replace_all: true },
      {},
    );
    expect(result.replacements).toBe(3);
    expect(result.startLine).toBe(4);
    expect(result.contextBefore).toEqual(['one', 'two', 'three']);
    expect(result.contextAfter).toEqual(['five', 'six', 'X']);
  });
});
