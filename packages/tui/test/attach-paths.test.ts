import { mkdtempSync, writeFileSync, rmdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAttachTokens, readForAttach } from '../src/attach-paths';

describe('parseAttachTokens', () => {
  it('returns empty array for empty input', () => {
    expect(parseAttachTokens('', '/tmp')).toEqual([]);
  });

  it('detects a single @token (read)', () => {
    expect(parseAttachTokens('look at @file.txt', '/home/user')).toEqual([
      { kind: 'read', raw: 'file.txt', absolute: '/home/user/file.txt' },
    ]);
  });

  it('detects a single #token (write)', () => {
    expect(parseAttachTokens('edit #file.txt now', '/home/user')).toEqual([
      { kind: 'write', raw: 'file.txt', absolute: '/home/user/file.txt' },
    ]);
  });

  it('detects mixed @ and # tokens in order', () => {
    expect(parseAttachTokens('see @a.txt and write #b.txt', '/tmp')).toEqual([
      { kind: 'read', raw: 'a.txt', absolute: '/tmp/a.txt' },
      { kind: 'write', raw: 'b.txt', absolute: '/tmp/b.txt' },
    ]);
  });

  it('does not match mid-word (e.g. a@b)', () => {
    expect(parseAttachTokens('email a@b.com', '/tmp')).toEqual([]);
  });

  it('requires whitespace before token', () => {
    expect(parseAttachTokens('foo@bar #baz', '/tmp')).toEqual([
      { kind: 'write', raw: 'baz', absolute: '/tmp/baz' },
    ]);
  });

  it('matches token at start of string', () => {
    expect(parseAttachTokens('@start.txt here', '/tmp')).toEqual([
      { kind: 'read', raw: 'start.txt', absolute: '/tmp/start.txt' },
    ]);
  });

  it('preserves interior and trailing tokens', () => {
    expect(parseAttachTokens('read @a write #b check @c', '/tmp')).toEqual([
      { kind: 'read', raw: 'a', absolute: '/tmp/a' },
      { kind: 'write', raw: 'b', absolute: '/tmp/b' },
      { kind: 'read', raw: 'c', absolute: '/tmp/c' },
    ]);
  });

  it('expands @~/ to homedir', () => {
    expect(parseAttachTokens('show @~/notes.txt', '/tmp')).toEqual([
      {
        kind: 'read',
        raw: '~/notes.txt',
        absolute: expect.stringMatching(/\/notes\.txt$/),
      },
    ]);
  });

  it('passes through absolute paths with @ prefix', () => {
    expect(parseAttachTokens('check @/etc/hosts', '/tmp')).toEqual([
      { kind: 'read', raw: '/etc/hosts', absolute: '/etc/hosts' },
    ]);
  });
});

describe('readForAttach', () => {
  let tmpDir: string;

  it('returns line-numbered content for a small file', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chimera-attach-test-'));
    const filePath = join(tmpDir, 'hello.txt');
    writeFileSync(filePath, 'first line\nsecond line\n', 'utf-8');
    const result = await readForAttach(filePath);
    expect(result.kind).toBe('file');
    expect(result.body).toContain('1\tfirst line');
    expect(result.body).toContain('2\tsecond line');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('caps large files', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chimera-attach-test-'));
    const filePath = join(tmpDir, 'big.txt');
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    const result = await readForAttach(filePath);
    expect(result.kind).toBe('file');
    const numberedLines = result.body.split('\n');
    expect(numberedLines.length).toBeLessThanOrEqual(2000);
    expect(numberedLines[0]).toContain('1\tline 1');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns dir listing for a directory', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chimera-attach-test-'));
    writeFileSync(join(tmpDir, 'file.txt'), 'hello', 'utf-8');
    mkdirSync(join(tmpDir, 'subdir'));
    const result = await readForAttach(tmpDir);
    expect(result.kind).toBe('dir');
    const entries = result.body.split('\n');
    expect(entries).toContain('file.txt');
    expect(entries).toContain('subdir/');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('caps directories at 200 entries', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chimera-attach-test-'));
    for (let i = 0; i < 250; i++) {
      writeFileSync(join(tmpDir, `file-${i}.txt`), '', 'utf-8');
    }
    const result = await readForAttach(tmpDir);
    expect(result.kind).toBe('dir');
    const entries = result.body.split('\n');
    expect(entries.length).toBeLessThanOrEqual(200);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns missing for a nonexistent path', async () => {
    const result = await readForAttach('/does/not/exist/abc.xyz');
    expect(result.kind).toBe('missing');
    expect(result.body).toContain('missing');
  });
});
