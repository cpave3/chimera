import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openInEditor, resolveEditorCommand } from '../src/input/external-editor';

const fakeStdin = (): NodeJS.ReadStream =>
  ({
    isTTY: false,
    pause() {},
    resume() {},
    read() {
      return null;
    },
    setRawMode() {},
  }) as unknown as NodeJS.ReadStream;

const fakeStdout = (): NodeJS.WriteStream =>
  ({
    write() {
      return true;
    },
  }) as unknown as NodeJS.WriteStream;

describe('resolveEditorCommand', () => {
  it('prefers VISUAL over EDITOR', () => {
    expect(resolveEditorCommand({ VISUAL: 'code -w', EDITOR: 'vim' })).toEqual({
      command: 'code',
      args: ['-w'],
    });
  });

  it('falls back to EDITOR when VISUAL is empty', () => {
    expect(resolveEditorCommand({ VISUAL: '', EDITOR: 'nvim' })).toEqual({
      command: 'nvim',
      args: [],
    });
  });

  it('falls back to vi when neither is set', () => {
    expect(resolveEditorCommand({})).toEqual({ command: 'vi', args: [] });
  });

  it('splits the command on whitespace', () => {
    expect(resolveEditorCommand({ EDITOR: 'vim -p -X' })).toEqual({
      command: 'vim',
      args: ['-p', '-X'],
    });
  });
});

describe('openInEditor', () => {
  const savedEnv: { VISUAL?: string; EDITOR?: string } = {};

  beforeEach(() => {
    savedEnv.VISUAL = process.env.VISUAL;
    savedEnv.EDITOR = process.env.EDITOR;
    process.env.VISUAL = '';
  });

  afterEach(() => {
    if (savedEnv.VISUAL === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = savedEnv.VISUAL;
    if (savedEnv.EDITOR === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = savedEnv.EDITOR;
  });

  async function writeStub(body: string): Promise<string> {
    const path = join(
      tmpdir(),
      `chimera-stub-editor-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`,
    );
    await writeFile(path, body, 'utf8');
    return path;
  }

  it('returns the new contents on a successful save', async () => {
    const stub = await writeStub(
      `const fs = require('node:fs');\n` +
        `const target = process.argv[process.argv.length - 1];\n` +
        `fs.writeFileSync(target, 'after\\n', 'utf8');\n` +
        `process.exit(0);\n`,
    );
    process.env.EDITOR = `${process.execPath} ${stub}`;
    const result = await openInEditor({
      initialText: 'before',
      mouseActive: false,
      stdout: fakeStdout(),
      stdin: fakeStdin(),
    });
    expect(result).toEqual({ ok: true, text: 'after' });
  });

  it('returns ok:false on non-zero exit', async () => {
    const stub = await writeStub(`process.exit(7);\n`);
    process.env.EDITOR = `${process.execPath} ${stub}`;
    const result = await openInEditor({
      initialText: 'untouched',
      mouseActive: false,
      stdout: fakeStdout(),
      stdin: fakeStdin(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('status 7');
  });
});
