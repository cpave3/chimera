import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createFilteredStdin, translateModifiedKeys } from '../src/input/stdin-filter';

describe('translateModifiedKeys', () => {
  it('rewrites Shift+Enter (CSI 27;2;13~) to a linefeed', () => {
    expect(translateModifiedKeys('hi\x1b[27;2;13~there')).toBe('hi\nthere');
  });

  it('rewrites Alt+Enter (CSI 27;3;13~) to a linefeed', () => {
    expect(translateModifiedKeys('\x1b[27;3;13~')).toBe('\n');
  });

  it('rewrites Ctrl+Shift+Enter (CSI 27;6;13~) to a linefeed', () => {
    expect(translateModifiedKeys('\x1b[27;6;13~')).toBe('\n');
  });

  it('rewrites legacy Alt+Enter (\\x1b\\r) to a linefeed', () => {
    expect(translateModifiedKeys('foo\x1b\rbar')).toBe('foo\nbar');
  });

  it('leaves unrelated input alone', () => {
    expect(translateModifiedKeys('hello\rworld')).toBe('hello\rworld');
    expect(translateModifiedKeys('\x1b[A')).toBe('\x1b[A');
    expect(translateModifiedKeys('')).toBe('');
  });

  it('does not rewrite mod=1 (which is unmodified Enter)', () => {
    expect(translateModifiedKeys('\x1b[27;1;13~')).toBe('\x1b[27;1;13~');
  });
});

describe('createFilteredStdin', () => {
  it('serves translated chunks via readable + read() (Ink pull pattern)', () => {
    const queue: (string | null)[] = ['a\x1b[27;2;13~b', 'plain', null];
    const upstream = new EventEmitter() as unknown as NodeJS.ReadStream;
    Object.assign(upstream, {
      isTTY: true,
      pause() {},
      resume() {},
      setRawMode() {},
      setEncoding() {},
      read() {
        return queue.shift() ?? null;
      },
      ref() {},
      unref() {},
    });
    const filtered = createFilteredStdin(upstream);
    const reads: string[] = [];
    filtered.on('readable', () => {
      let chunk: unknown;
      while ((chunk = filtered.read()) !== null) {
        reads.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      }
    });
    (upstream as unknown as EventEmitter).emit('readable');
    expect(reads).toEqual(['a\nb', 'plain']);
  });

  it('exposes the TTY surface that Ink expects', () => {
    const calls: string[] = [];
    const upstream = new EventEmitter() as unknown as NodeJS.ReadStream;
    Object.assign(upstream, {
      isTTY: true,
      pause() {
        calls.push('pause');
      },
      resume() {
        calls.push('resume');
      },
      setRawMode(mode: boolean) {
        calls.push(`setRawMode:${mode}`);
      },
      setEncoding(encoding: string) {
        calls.push(`setEncoding:${encoding}`);
      },
      read() {
        return null;
      },
      ref() {
        calls.push('ref');
      },
      unref() {
        calls.push('unref');
      },
    });
    const filtered = createFilteredStdin(upstream);
    expect(filtered.isTTY).toBe(true);
    filtered.setRawMode(true);
    filtered.setEncoding('utf8');
    filtered.pause();
    filtered.resume();
    filtered.ref?.();
    filtered.unref?.();
    expect(calls).toEqual([
      'setRawMode:true',
      'setEncoding:utf8',
      'pause',
      'resume',
      'ref',
      'unref',
    ]);
  });
});
