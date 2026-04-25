import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { HandshakeError, readHandshakeLine } from '../src/handshake';

describe('readHandshakeLine', () => {
  it('parses a single newline-terminated JSON line', async () => {
    const stream = new Readable({ read() {} });
    const promise = readHandshakeLine(stream, 1000);
    const payload = JSON.stringify({
      ready: true,
      url: 'http://127.0.0.1:34567',
      sessionId: 'sess-1',
      pid: 4242,
    });
    stream.push(`${payload}\n`);
    const msg = await promise;
    expect(msg).toEqual({
      ready: true,
      url: 'http://127.0.0.1:34567',
      sessionId: 'sess-1',
      pid: 4242,
    });
  });

  it('parses across multiple chunks', async () => {
    const stream = new Readable({ read() {} });
    const promise = readHandshakeLine(stream, 1000);
    stream.push('{"ready":true,"url":"http://127.0.0.1:80",');
    stream.push('"sessionId":"s1","pid":1}\n');
    const msg = await promise;
    expect(msg.sessionId).toBe('s1');
  });

  it('rejects on invalid JSON', async () => {
    const stream = new Readable({ read() {} });
    const promise = readHandshakeLine(stream, 1000);
    stream.push('not-json\n');
    await expect(promise).rejects.toBeInstanceOf(HandshakeError);
  });

  it('rejects on missing required fields', async () => {
    const stream = new Readable({ read() {} });
    const promise = readHandshakeLine(stream, 1000);
    stream.push(`${JSON.stringify({ ready: true })}\n`);
    await expect(promise).rejects.toThrow(/missing required fields/);
  });

  it('rejects on stream end before newline', async () => {
    const stream = new Readable({ read() {} });
    const promise = readHandshakeLine(stream, 1000);
    stream.push('partial');
    stream.push(null);
    await expect(promise).rejects.toThrow(/closed before/);
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    try {
      const stream = new Readable({ read() {} });
      const promise = readHandshakeLine(stream, 50);
      vi.advanceTimersByTime(60);
      await expect(promise).rejects.toThrow(/timed out after 50ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});
